import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:rideops/app.dart';
import 'package:rideops/core/api/api_error.dart';
import 'package:rideops/core/api/api_providers.dart';
import 'package:rideops/core/session/token_store.dart';
import 'package:rideops/core/telemetry/event_logger.dart';
import 'package:rideops/features/auth/presentation/change_password_screen.dart';
import 'package:rideops/features/dashboard/presentation/home_placeholder_screen.dart';

import 'helpers/auth_test_helpers.dart';

/// Widget tests del gate de cambio forzado (mockup 2A-2C): el router bloquea
/// ahí al hidratar un user con mustChangePassword, el checklist vive contra
/// la política REAL (12+, clases, distinta), y el éxito intercambia el token
/// sin re-login. Harness en locale en → app_en.arb.
void main() {
  late InMemoryTokenStore store;
  late FakeAuthApi api;
  late CapturingEventLogger logger;

  setUp(() {
    store = InMemoryTokenStore();
    api = FakeAuthApi();
    logger = CapturingEventLogger();
    store.value = fakeJwt(exp: DateTime.now().add(const Duration(hours: 8)));
    api.onMe =
        () async => authResponseFromFixture(mustChangePassword: true).user;
  });

  Widget app() => ProviderScope(
        overrides: [
          tokenStoreProvider.overrideWithValue(store),
          authApiProvider.overrideWithValue(api),
          eventLoggerProvider.overrideWithValue(logger),
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

    // Mockup 2C: éxito, sesión viva, token fresco guardado.
    expect(find.text('Password updated'), findsOneWidget);
    expect(store.value, freshToken);
    expect(store.value, isNot(oldToken));
    expect(logger.has(AuthEvents.passwordChanged), isTrue);

    await tester.tap(find.text('Continue'));
    await tester.pumpAndSettle();
    expect(find.byType(HomePlaceholderScreen), findsOneWidget,
        reason: 'el gate quedó abajo sin pasar por /login');
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
