import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:rideops/app.dart';
import 'package:rideops/core/api/api_error.dart';
import 'package:rideops/core/api/api_providers.dart';
import 'package:rideops/core/session/active_location.dart';
import 'package:rideops/core/session/pin_store.dart';
import 'package:rideops/core/session/token_store.dart';
import 'package:rideops/core/telemetry/event_logger.dart';
import 'package:rideops/features/auth/presentation/login_screen.dart';
import 'package:rideops/features/dashboard/presentation/home_screen.dart';

import 'helpers/auth_test_helpers.dart';
import 'helpers/shell_test_helpers.dart';

/// Widget tests del login (mockup 1A-1C) montando la app COMPLETA con router:
/// así se prueba también el redirect (splash → login → home) y no solo la
/// pantalla. Locale del harness = en → se asierta contra app_en.arb.
void main() {
  late InMemoryTokenStore store;
  late FakeAuthApi api;
  late CapturingEventLogger logger;

  setUp(() {
    store = InMemoryTokenStore();
    api = FakeAuthApi();
    logger = CapturingEventLogger();
  });

  Widget app() => ProviderScope(
        overrides: [
          tokenStoreProvider.overrideWithValue(store),
          // PIN ya configurado (H2): estos tests ejercitan el LOGIN — el
          // gate de setup del PIN tiene los suyos en pin_setup_screen_test.
          pinStoreProvider.overrideWithValue(
            InMemoryPinStore.configured(userId: kFixtureUserId),
          ),
          authApiProvider.overrideWithValue(api),
          // H4: la home real fetchea el dashboard — stub con el fixture para
          // que el fetch resuelva y la pantalla asiente (ver FakeDashboardApi).
          dashboardApiProvider.overrideWithValue(FakeDashboardApi()),
          // …y la sede activa hidrata de memoria: el Keystore real hace IO async
          // que jamás resuelve dentro de testWidgets — la home (gate hydrated)
          // quedaría en skeleton hasta disparar el lock de inactividad.
          activeLocationStoreProvider.overrideWithValue(InMemoryActiveLocationStore()),
          eventLoggerProvider.overrideWithValue(logger),
        ],
        child: const RideOpsApp(),
      );

  Future<void> pumpToLogin(WidgetTester tester) async {
    await tester.pumpWidget(app());
    await tester.pumpAndSettle();
    expect(find.byType(LoginScreen), findsOneWidget);
  }

  Future<void> fillAndSubmit(WidgetTester tester) async {
    await tester.enterText(
        find.byType(TextField).at(0), 'agente@ridefleet.example');
    await tester.enterText(find.byType(TextField).at(1), 'Secreta#2026xx');
    await tester.pump();
    await tester.tap(find.text('Sign in'));
    await tester.pumpAndSettle();
  }

  testWidgets('happy path: login → sesión → home (vía redirect)',
      (tester) async {
    final token = fakeJwt(exp: DateTime.now().add(const Duration(hours: 8)));
    api.onLogin = (email, pass) async {
      expect(email, 'agente@ridefleet.example');
      return authResponseFromFixture(token: token);
    };
    await pumpToLogin(tester);
    await fillAndSubmit(tester);

    expect(find.byType(HomeScreen), findsOneWidget);
    expect(store.value, token, reason: 'token persistido en el store seguro');
    expect(logger.has(AuthEvents.loginOk), isTrue);
  });

  testWidgets('401: banner de credenciales genérico y se puede reintentar',
      (tester) async {
    api.onLogin = (_, _) async => throw apiError(ApiErrorKind.unauthorized,
        message: 'Invalid credentials');
    await pumpToLogin(tester);
    await fillAndSubmit(tester);

    expect(find.byType(LoginScreen), findsOneWidget, reason: 'no navegó');
    expect(
      find.text('Wrong email or password. Check and try again.'),
      findsOneWidget,
    );
    expect(store.value, isNull);
  });

  testWidgets('sin red: banner warn, botón deshabilitado, reintento manual',
      (tester) async {
    var calls = 0;
    final token = fakeJwt(exp: DateTime.now().add(const Duration(hours: 8)));
    api.onLogin = (_, _) async {
      calls++;
      if (calls == 1) throw apiError(ApiErrorKind.network);
      return authResponseFromFixture(token: token);
    };
    await pumpToLogin(tester);
    await fillAndSubmit(tester);

    // Estado 1C del mockup: banner + CTA deshabilitado + "Reintentar ahora".
    expect(
      find.textContaining('No internet connection'),
      findsOneWidget,
    );
    expect(find.text('Retry now'), findsOneWidget);
    final fail = logger.events.singleWhere((e) => e.$1 == AuthEvents.loginFail);
    expect(fail.$2['fail_reason'], 'network');

    // El botón primario está deshabilitado: tocarlo no dispara otro intento.
    await tester.tap(find.text('Sign in'), warnIfMissed: false);
    await tester.pumpAndSettle();
    expect(calls, 1);

    // Reintento manual (la señal "volvió"): entra y navega.
    await tester.tap(find.text('Retry now'));
    await tester.pumpAndSettle();
    expect(calls, 2);
    expect(find.byType(HomeScreen), findsOneWidget);
  });
}
