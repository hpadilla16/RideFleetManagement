import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:rideops/app.dart';
import 'package:rideops/core/api/api_providers.dart';
import 'package:rideops/core/db/outbox_providers.dart';
import 'package:rideops/core/outbox/network_status.dart';
import 'package:rideops/core/session/biometric_auth.dart';
import 'package:rideops/core/session/active_location.dart';
import 'package:rideops/core/session/kiosk_guard.dart';
import 'package:rideops/core/session/pin_store.dart';
import 'package:rideops/core/session/token_store.dart';
import 'package:rideops/core/telemetry/event_logger.dart';
import 'package:rideops/features/auth/presentation/pin_setup_screen.dart';
import 'package:rideops/features/dashboard/presentation/home_screen.dart';

import 'helpers/auth_test_helpers.dart';
import 'helpers/outbox_test_helpers.dart';
import 'helpers/shell_test_helpers.dart';

/// Widget tests del setup del PIN (mockup 3A): sesión sin PIN ⇒ el redirect
/// fuerza /pin-setup; 2 pasos (crear + confirmar) + oferta de huella si el
/// aparato puede. Locale del harness = en.
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
    pinStore = InMemoryPinStore();
    api = FakeAuthApi();
    api.onMe = () async => authResponseFromFixture().user;
    logger = CapturingEventLogger();
    bio = FakeBiometricAuth();
  });

  Widget app() => ProviderScope(
        overrides: [
          tokenStoreProvider.overrideWithValue(tokenStore),
          pinStoreProvider.overrideWithValue(pinStore),
          kioskGuardStoreProvider.overrideWithValue(InMemoryKioskGuardStore()),
          authApiProvider.overrideWithValue(api),
          // H4: la home real fetchea el dashboard — stub con el fixture para
          // que el fetch resuelva y la pantalla asiente (ver FakeDashboardApi).
          dashboardApiProvider.overrideWithValue(FakeDashboardApi()),
          // …y la sede activa hidrata de memoria: el Keystore real hace IO async
          // que jamás resuelve dentro de testWidgets — la home (gate hydrated)
          // quedaría en skeleton hasta disparar el lock de inactividad.
          activeLocationStoreProvider.overrideWithValue(InMemoryActiveLocationStore()),
          eventLoggerProvider.overrideWithValue(logger),
          biometricAuthProvider.overrideWithValue(bio),
          // H5: bandeja silenciada — ver helpers/outbox_test_helpers.dart.
          outboxDbProvider.overrideWith(buildMemoryOutboxDb),
          photoVaultProvider.overrideWith(buildQuietVault),
          networkStatusProvider.overrideWithValue(FakeNetworkStatus()),
          outboxRowsProvider.overrideWith((ref) => Stream.value(const [])),
        ],
        child: const RideOpsApp(),
      );

  Future<void> pumpToSetup(WidgetTester tester) async {
    await tester.pumpWidget(app());
    await tester.pumpAndSettle();
    expect(find.byType(PinSetupScreen), findsOneWidget,
        reason: 'sin PIN, el redirect fuerza el setup');
  }

  Future<void> tapPin(WidgetTester tester, String pin) async {
    for (final d in pin.split('')) {
      await tester.tap(find.text(d));
      await tester.pump();
    }
    await tester.pumpAndSettle();
  }

  testWidgets('2 pasos: crear + confirmar → PIN guardado hasheado y a la app',
      (tester) async {
    await pumpToSetup(tester);
    expect(find.text('Create your PIN'), findsOneWidget);
    expect(find.text('Step 1 of 2'), findsOneWidget);

    await tapPin(tester, '4321');
    expect(find.text('Confirm your PIN'), findsOneWidget);
    expect(find.text('Step 2 of 2'), findsOneWidget);

    await tapPin(tester, '4321');
    // Sin hardware biométrico: fallback silencioso a solo-PIN, directo a la
    // app sin oferta de huella.
    expect(find.byType(HomeScreen), findsOneWidget);
    final record = pinStore.value!;
    expect(record.userId, kFixtureUserId);
    expect(record.matches('4321'), isTrue);
    expect(record.biometricEnabled, isFalse);
  });

  testWidgets('confirmación que no coincide → error y de vuelta al paso 1',
      (tester) async {
    await pumpToSetup(tester);
    await tapPin(tester, '4321');
    await tapPin(tester, '9999');

    expect(find.text("The PINs don't match. Start over."), findsOneWidget);
    expect(find.text('Create your PIN'), findsOneWidget);
    expect(pinStore.value, isNull, reason: 'nada guardado');

    // Segundo intento completo funciona.
    await tapPin(tester, '2468');
    await tapPin(tester, '2468');
    expect(find.byType(HomeScreen), findsOneWidget);
    expect(pinStore.value!.matches('2468'), isTrue);
  });

  testWidgets('con hardware: oferta de huella y "Enable" la deja activa',
      (tester) async {
    bio
      ..available = true
      ..authenticateResult = true;
    await pumpToSetup(tester);
    await tapPin(tester, '4321');
    await tapPin(tester, '4321');

    expect(find.text('Enable fingerprint?'), findsOneWidget);
    await tester.tap(find.text('Enable fingerprint'));
    await tester.pumpAndSettle();

    expect(find.byType(HomeScreen), findsOneWidget);
    expect(pinStore.value!.biometricEnabled, isTrue);
    expect(bio.authenticateCalls, 1, reason: 'se prueba la huella al activar');
  });

  testWidgets('"Not now" en la oferta guarda el PIN con huella apagada',
      (tester) async {
    bio.available = true;
    await pumpToSetup(tester);
    await tapPin(tester, '4321');
    await tapPin(tester, '4321');

    await tester.tap(find.text('Not now'));
    await tester.pumpAndSettle();
    expect(find.byType(HomeScreen), findsOneWidget);
    expect(pinStore.value!.biometricEnabled, isFalse);
  });

  testWidgets('prompt de huella falla: aviso y se puede seguir con solo-PIN',
      (tester) async {
    bio
      ..available = true
      ..authenticateResult = false;
    await pumpToSetup(tester);
    await tapPin(tester, '4321');
    await tapPin(tester, '4321');

    await tester.tap(find.text('Enable fingerprint'));
    await tester.pumpAndSettle();
    expect(
      find.text("Couldn't enable fingerprint. You can keep using your PIN."),
      findsOneWidget,
    );
    expect(find.byType(PinSetupScreen), findsOneWidget,
        reason: 'el usuario decide: reintentar o seguir sin huella');

    await tester.tap(find.text('Not now'));
    await tester.pumpAndSettle();
    expect(find.byType(HomeScreen), findsOneWidget);
    expect(pinStore.value!.biometricEnabled, isFalse);
  });
}
