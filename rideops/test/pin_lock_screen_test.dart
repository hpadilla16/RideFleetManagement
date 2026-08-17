// hide LockState: material.dart exporta uno (Shortcuts) que choca con el
// nuestro.
import 'package:flutter/material.dart' hide LockState;
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:rideops/app.dart';
import 'package:rideops/core/api/api_error.dart';
import 'package:rideops/core/api/api_providers.dart';
import 'package:rideops/core/session/biometric_auth.dart';
import 'package:rideops/core/session/lock_state.dart';
import 'package:rideops/core/session/pin_store.dart';
import 'package:rideops/core/session/token_store.dart';
import 'package:rideops/core/telemetry/event_logger.dart';
import 'package:rideops/features/auth/presentation/login_screen.dart';
import 'package:rideops/features/auth/presentation/pin_lock_screen.dart';
import 'package:rideops/features/dashboard/presentation/home_placeholder_screen.dart';

import 'helpers/auth_test_helpers.dart';

/// Widget tests del unlock (mockup 3B) montando la app completa: cold start
/// con PIN ⇒ el redirect bloquea en /lock. Locale del harness = en.
void main() {
  late InMemoryTokenStore tokenStore;
  late InMemoryPinStore pinStore;
  late FakeAuthApi api;
  late CapturingEventLogger logger;
  late FakeBiometricAuth bio;

  setUp(() {
    tokenStore = InMemoryTokenStore();
    tokenStore.value = fakeJwt(
      exp: DateTime.now().add(const Duration(hours: 8)),
      sub: kFixtureUserId,
    );
    pinStore = InMemoryPinStore.configured(userId: kFixtureUserId);
    api = FakeAuthApi();
    api.onMe = () async => authResponseFromFixture().user;
    logger = CapturingEventLogger();
    bio = FakeBiometricAuth();
  });

  Widget app() => ProviderScope(
        overrides: [
          tokenStoreProvider.overrideWithValue(tokenStore),
          pinStoreProvider.overrideWithValue(pinStore),
          authApiProvider.overrideWithValue(api),
          eventLoggerProvider.overrideWithValue(logger),
          biometricAuthProvider.overrideWithValue(bio),
        ],
        child: const RideOpsApp(),
      );

  Future<void> pumpToLock(WidgetTester tester) async {
    await tester.pumpWidget(app());
    await tester.pumpAndSettle();
    expect(find.byType(PinLockScreen), findsOneWidget,
        reason: 'cold start con PIN llega bloqueado');
  }

  Future<void> tapPin(WidgetTester tester, String pin) async {
    for (final d in pin.split('')) {
      await tester.tap(find.text(d));
      await tester.pump();
    }
    await tester.pumpAndSettle();
  }

  testWidgets('saludo con el primer nombre y PIN correcto → destino',
      (tester) async {
    await pumpToLock(tester);
    // fullName del fixture: "Agente Patio Uno".
    expect(find.text('Hi, Agente'), findsOneWidget);

    await tapPin(tester, '1234');
    expect(find.byType(HomePlaceholderScreen), findsOneWidget);
    final unlock =
        logger.events.singleWhere((e) => e.$1 == SessionEvents.pinUnlock);
    expect(unlock.$2['method'], 'pin');
  });

  testWidgets('PIN incorrecto: contador visible "te quedan N"',
      (tester) async {
    await pumpToLock(tester);
    await tapPin(tester, '9999');
    expect(find.byType(PinLockScreen), findsOneWidget);
    expect(find.text('Wrong PIN — 4 attempts left'), findsOneWidget);

    // Otro fallo: el contador baja — nunca lockout silencioso.
    await tapPin(tester, '8888');
    expect(find.text('Wrong PIN — 3 attempts left'), findsOneWidget);
  });

  testWidgets('agotar intentos → logout limpio a /login y PIN purgado',
      (tester) async {
    await pumpToLock(tester);
    for (var i = 0; i < LockState.maxAttempts; i++) {
      await tapPin(tester, '9999');
    }
    expect(find.byType(LoginScreen), findsOneWidget);
    expect(tokenStore.value, isNull);
    expect(pinStore.value, isNull, reason: 're-login crea PIN nuevo');
  });

  testWidgets('huella como tecla del keypad: desbloquea con el prompt ok',
      (tester) async {
    pinStore = InMemoryPinStore.configured(
        userId: kFixtureUserId, biometricEnabled: true);
    bio
      ..available = true
      ..authenticateResult = true;
    await pumpToLock(tester);

    await tester.tap(find.byIcon(Icons.fingerprint));
    await tester.pumpAndSettle();
    expect(find.byType(HomePlaceholderScreen), findsOneWidget);
    final unlock =
        logger.events.singleWhere((e) => e.$1 == SessionEvents.pinUnlock);
    expect(unlock.$2['method'], 'biometric');
    expect(bio.authenticateCalls, 1);
  });

  testWidgets('sin hardware biométrico la tecla no aparece (solo-PIN)',
      (tester) async {
    pinStore = InMemoryPinStore.configured(
        userId: kFixtureUserId, biometricEnabled: true);
    bio.available = false;
    await pumpToLock(tester);
    expect(find.byIcon(Icons.fingerprint), findsNothing);
  });

  testWidgets('escape honesto: "¿Olvidaste tu PIN?" cierra sesión y purga',
      (tester) async {
    await pumpToLock(tester);
    await tester.tap(find.text('Forgot your PIN? Sign out'));
    await tester.pumpAndSettle();
    expect(find.byType(LoginScreen), findsOneWidget);
    expect(pinStore.value, isNull);
  });

  testWidgets('sesión degradada (user null): renderiza con título genérico',
      (tester) async {
    api.onMe = () async => throw apiError(ApiErrorKind.network);
    await pumpToLock(tester);
    expect(find.text('Unlock RideOps'), findsOneWidget,
        reason: 'sin user no hay saludo ni avatar, pero el candado funciona');

    await tapPin(tester, '1234');
    expect(find.byType(HomePlaceholderScreen), findsOneWidget);
  });
}
