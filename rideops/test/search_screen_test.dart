import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:rideops/app.dart';
import 'package:rideops/core/api/api_error.dart';
import 'package:rideops/core/api/api_providers.dart';
import 'package:rideops/core/api/dto/dashboard.dart';
import 'package:rideops/core/session/active_location.dart';
import 'package:rideops/core/session/biometric_auth.dart';
import 'package:rideops/core/session/pin_store.dart';
import 'package:rideops/core/session/token_store.dart';
import 'package:rideops/core/telemetry/event_logger.dart';
import 'package:rideops/features/shell/location_denied_view.dart';

import 'helpers/auth_test_helpers.dart';
import 'helpers/shell_test_helpers.dart';

/// Widget tests de la tab Buscar (H4, alcance mínimo): mismo endpoint con
/// ?q=, debounce, resultados como cards y los estados vacío/error/403.
void main() {
  const uid = 'cmdusr001fixture0000000001';

  late InMemoryTokenStore tokenStore;
  late InMemoryActiveLocationStore locationStore;
  late FakeAuthApi api;
  late FakeDashboardApi dashboardApi;

  setUp(() {
    tokenStore = InMemoryTokenStore()
      ..value = fakeJwt(
        exp: DateTime.now().add(const Duration(hours: 8)),
        sub: uid,
      );
    locationStore = InMemoryActiveLocationStore();
    api = FakeAuthApi();
    api.onMe = () async => sessionUserFixture();
    dashboardApi = FakeDashboardApi();
  });

  Widget app() => ProviderScope(
        overrides: [
          tokenStoreProvider.overrideWithValue(tokenStore),
          activeLocationStoreProvider.overrideWithValue(locationStore),
          pinStoreProvider.overrideWithValue(InMemoryPinStore()),
          biometricAuthProvider.overrideWithValue(FakeBiometricAuth()),
          authApiProvider.overrideWithValue(api),
          dashboardApiProvider.overrideWithValue(dashboardApi),
          eventLoggerProvider.overrideWithValue(CapturingEventLogger()),
        ],
        child: const RideOpsApp(),
      );

  Future<void> pumpToSearch(WidgetTester tester) async {
    await tester.pumpWidget(app());
    await tester.pumpAndSettle();
    await tester.tap(find.text('Search'));
    await tester.pumpAndSettle();
    expect(
      find.text('Search reservations in your active location.'),
      findsOneWidget,
      reason: 'estado vacío: prompt, no una lista muda',
    );
  }

  Future<void> typeQuery(WidgetTester tester, String q) async {
    await tester.enterText(find.byType(TextField), q);
    // Debounce de 350 ms: antes de eso no hay request.
    await tester.pump(const Duration(milliseconds: 200));
    expect(dashboardApi.lastQuery, isNot(q));
    await tester.pump(const Duration(milliseconds: 200));
    await tester.pumpAndSettle();
  }

  testWidgets('busca con ?q= (debounce) y pinta resultados como cards',
      (tester) async {
    dashboardApi.onFetch = (query) async {
      final raw = readJsonFixture('dashboard.json');
      raw['query'] = query;
      raw['searchResults'] = [readJsonFixture('reservation_card.json')];
      return DashboardPayload.fromJson(raw);
    };
    await pumpToSearch(tester);
    await typeQuery(tester, 'maria');

    expect(dashboardApi.lastQuery, 'maria');
    expect(find.text('María González'), findsOneWidget);
    // GD MC-2 (review H4): card NEUTRA — el resultado es una reserva en
    // cualquier estado, jamás disfrazada de "salida" con su juicio.
    expect(find.text('Pre-checkin done'), findsNothing);
    expect(find.text('Pre-checkin missing'), findsNothing);
  });

  testWidgets(
      'GD S-7: Enter busca SIN esperar el debounce y el ✕ limpia el campo',
      (tester) async {
    dashboardApi.onFetch = (query) async {
      final raw = readJsonFixture('dashboard.json');
      raw['searchResults'] =
          query.isEmpty ? <Object>[] : [readJsonFixture('reservation_card.json')];
      return DashboardPayload.fromJson(raw);
    };
    await pumpToSearch(tester);

    await tester.enterText(find.byType(TextField), 'maria');
    await tester.testTextInput.receiveAction(TextInputAction.search);
    await tester.pump(); // cero espera de debounce
    await tester.pumpAndSettle();
    expect(dashboardApi.lastQuery, 'maria');
    expect(find.text('María González'), findsOneWidget);

    await tester.tap(find.byIcon(Icons.close_rounded));
    await tester.pumpAndSettle();
    expect(
      find.text('Search reservations in your active location.'),
      findsOneWidget,
      reason: 'limpiar vuelve al prompt, no deja resultados fantasma',
    );
  });

  testWidgets('sin resultados: mensaje con el término, no pantalla vacía',
      (tester) async {
    await pumpToSearch(tester);
    await typeQuery(tester, 'nadie');
    // El fixture default trae searchResults vacío.
    expect(find.text('No results for “nadie”.'), findsOneWidget);
  });

  testWidgets('error de módulo: mensaje del servidor + Reintentar real',
      (tester) async {
    const msg = 'The Employee app module is not enabled.';
    dashboardApi.onFetch = (_) async => throw ApiError(
          kind: ApiErrorKind.forbidden,
          message: msg,
          status: 403,
        );
    await pumpToSearch(tester);
    await typeQuery(tester, 'x');
    expect(find.text(msg), findsOneWidget);

    dashboardApi.onFetch = null;
    await tester.tap(find.text('Retry'));
    await tester.pumpAndSettle();
    expect(find.text(msg), findsNothing);
  });

  testWidgets('403 de ubicación en búsqueda: LocationDeniedView (DoD-4: cada '
      'pantalla maneja su 403)', (tester) async {
    locationStore.raw = '{"userId":"$uid","locationId":"loc-quitada",'
        '"locationName":"Sede Quitada"}';
    dashboardApi.onFetch = (_) async => throw ApiError(
          kind: ApiErrorKind.forbidden,
          message: ApiError.viewLocationDeniedMessage,
          status: 403,
        );
    await tester.pumpWidget(app());
    await tester.pumpAndSettle();
    await tester.tap(find.text('Search'));
    await tester.pumpAndSettle();
    await tester.enterText(find.byType(TextField), 'algo');
    await tester.pump(const Duration(milliseconds: 400));
    await tester.pumpAndSettle();

    expect(find.byType(LocationDeniedView), findsOneWidget);
  });
}
