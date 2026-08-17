import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:rideops/app.dart';
import 'package:rideops/core/api/api_error.dart';
import 'package:rideops/core/api/api_providers.dart';
import 'package:rideops/core/db/outbox_providers.dart';
import 'package:rideops/core/outbox/network_status.dart';
import 'package:rideops/core/session/pin_store.dart';
import 'package:rideops/core/session/token_store.dart';
import 'package:rideops/core/telemetry/event_logger.dart';
import 'package:rideops/features/auth/presentation/change_password_screen.dart';
import 'package:rideops/features/auth/presentation/pin_setup_screen.dart';
import 'package:rideops/features/dashboard/presentation/home_placeholder_screen.dart';

import 'helpers/auth_test_helpers.dart';
import 'helpers/outbox_test_helpers.dart';

/// Widget tests del gate de cambio forzado (mockup 2A-2C): el router bloquea
/// ahí al hidratar un user con mustChangePassword, el checklist vive contra
/// la política REAL (12+, clases, distinta), y el éxito intercambia el token
/// sin re-login. Harness en locale en → app_en.arb.
void main() {
  late InMemoryTokenStore store;
  late InMemoryPinStore pinStore;
  late FakeAuthApi api;
  late CapturingEventLogger logger;

  setUp(() {
    store = InMemoryTokenStore();
    // Sin PIN todavía: el flujo real del primer login (contraseña temporal ⇒
    // aún no hubo setup). El éxito 2C encadena al setup (H2).
    pinStore = InMemoryPinStore();
    api = FakeAuthApi();
    logger = CapturingEventLogger();
    store.value = fakeJwt(
      exp: DateTime.now().add(const Duration(hours: 8)),
      sub: kFixtureUserId,
    );
    api.onMe =
        () async => authResponseFromFixture(mustChangePassword: true).user;
  });

  Widget app() => ProviderScope(
        overrides: [
          tokenStoreProvider.overrideWithValue(store),
          pinStoreProvider.overrideWithValue(pinStore),
          authApiProvider.overrideWithValue(api),
          eventLoggerProvider.overrideWithValue(logger),
          // H5: bandeja silenciada — ver helpers/outbox_test_helpers.dart.
          outboxDbProvider.overrideWith(buildMemoryOutboxDb),
          photoVaultProvider.overrideWith(buildQuietVault),
          networkStatusProvider.overrideWithValue(FakeNetworkStatus()),
          outboxRowsProvider.overrideWith((ref) => Stream.value(const [])),
        ],
        child: const RideOpsApp(),
      );

  Future<void> pumpToGate(WidgetTester tester) async {
    await tester.pumpWidget(app());
    await tester.pumpAndSettle();
    expect(find.byType(ChangePasswordScreen), findsOneWidget,
        reason: 'mustChangePassword bloquea en el gate');
  }

  testWidgets('checklist vivo: refleja la política real del backend',
      (tester) async {
    await pumpToGate(tester);
    expect(logger.has(AuthEvents.passwordGateShown), isTrue);

    // Regla de 12 (no 8, como decía el mockup antes de confirmar).
    expect(find.text('At least 12 characters'), findsOneWidget);

    await tester.enterText(find.byType(TextField).at(0), 'Temporal#123');
    // Débil: sin símbolo ni longitud.
    await tester.enterText(find.byType(TextField).at(1), 'Patio26');
    await tester.pump();

    // CTA deshabilitado: tocarlo no llama a la API.
    var calls = 0;
    api.onChangePassword = (_, _) async {
      calls++;
      return authResponseFromFixture();
    };
    await tester.tap(find.text('Save and continue'), warnIfMissed: false);
    await tester.pumpAndSettle();
    expect(calls, 0);
    expect(find.byType(ChangePasswordScreen), findsOneWidget);
  });

  testWidgets('éxito: intercambia token, frame de éxito y continúa SIN re-login',
      (tester) async {
    final oldToken = store.value;
    final freshToken =
        fakeJwt(exp: DateTime.now().add(const Duration(hours: 12)), sub: 'u2');
    api.onChangePassword = (current, next) async {
      expect(current, 'Temporal#123');
      expect(next, 'PatioCentro#2026');
      return authResponseFromFixture(token: freshToken);
    };
    await pumpToGate(tester);

    await tester.enterText(find.byType(TextField).at(0), 'Temporal#123');
    await tester.enterText(find.byType(TextField).at(1), 'PatioCentro#2026');
    await tester.pump();
    await tester.tap(find.text('Save and continue'));
    await tester.pumpAndSettle();

    // Mockup 2C: éxito, sesión viva, token fresco guardado, y el hint del
    // siguiente paso (H2) porque este usuario aún no tiene PIN.
    expect(find.text('Password updated'), findsOneWidget);
    expect(store.value, freshToken);
    expect(store.value, isNot(oldToken));
    expect(logger.has(AuthEvents.passwordChanged), isTrue);
    expect(
      find.text('Next: create your PIN to unlock quickly in the yard.'),
      findsOneWidget,
    );

    await tester.tap(find.text('Continue'));
    await tester.pumpAndSettle();
    expect(find.byType(PinSetupScreen), findsOneWidget,
        reason: 'el gate quedó abajo sin /login y encadena al setup del PIN');
  });

  testWidgets('éxito con usuario exento: sin hint de PIN y directo a la app',
      (tester) async {
    api.onMe = () async => authResponseFromFixture(
        mustChangePassword: true, screenLockExempt: true).user;
    api.onChangePassword = (_, _) async =>
        authResponseFromFixture(screenLockExempt: true);
    await pumpToGate(tester);

    await tester.enterText(find.byType(TextField).at(0), 'Temporal#123');
    await tester.enterText(find.byType(TextField).at(1), 'PatioCentro#2026');
    await tester.pump();
    await tester.tap(find.text('Save and continue'));
    await tester.pumpAndSettle();

    expect(find.text('Password updated'), findsOneWidget);
    expect(
      find.textContaining('Next: create your PIN'),
      findsNothing,
      reason: 'screenLockExempt salta todo el gate — no prometer setup',
    );
    await tester.tap(find.text('Continue'));
    await tester.pumpAndSettle();
    expect(find.byType(HomePlaceholderScreen), findsOneWidget);
  });

  testWidgets('contraseña actual incorrecta: banner específico del 400',
      (tester) async {
    api.onChangePassword = (_, _) async => throw apiError(
        ApiErrorKind.badRequest,
        message: 'Current password is incorrect');
    await pumpToGate(tester);

    await tester.enterText(find.byType(TextField).at(0), 'equivocada');
    await tester.enterText(find.byType(TextField).at(1), 'PatioCentro#2026');
    await tester.pump();
    await tester.tap(find.text('Save and continue'));
    await tester.pumpAndSettle();

    expect(find.byType(ChangePasswordScreen), findsOneWidget);
    expect(
      find.textContaining('The temporary password is not correct'),
      findsOneWidget,
    );
  });

  testWidgets('bloqueante: back del sistema no saca del gate', (tester) async {
    await pumpToGate(tester);
    final dynamic widgetsAppState = tester.state(find.byType(WidgetsApp));
    // ignore: avoid_dynamic_calls
    await widgetsAppState.didPopRoute();
    await tester.pumpAndSettle();
    expect(find.byType(ChangePasswordScreen), findsOneWidget);
  });
}
