import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:rideops/app.dart';
import 'package:rideops/core/api/api_error.dart';
import 'package:rideops/core/api/api_providers.dart';
import 'package:rideops/core/api/dto/dashboard.dart';
import 'package:rideops/core/db/outbox_providers.dart';
import 'package:rideops/core/outbox/network_status.dart';
import 'package:rideops/core/session/active_location.dart';
import 'package:rideops/core/session/biometric_auth.dart';
import 'package:rideops/core/session/pin_store.dart';
import 'package:rideops/core/session/token_store.dart';
import 'package:rideops/core/telemetry/event_logger.dart';
import 'package:rideops/features/dashboard/application/dashboard_controller.dart';
import 'package:rideops/features/dashboard/presentation/home_screen.dart';
import 'package:rideops/features/dashboard/presentation/home_skeleton.dart';
import 'package:rideops/features/dashboard/presentation/queue_list_screen.dart';
import 'package:rideops/features/shell/location_denied_view.dart';

import 'helpers/auth_test_helpers.dart';
import 'helpers/outbox_test_helpers.dart';
import 'helpers/shell_test_helpers.dart';

/// Widget tests de la home de operaciones (H4, mockup 5A–5E) montando la app
/// completa: shell + router + sesión — así el chip danger del shell y la
/// navegación a la vista de cola se prueban de verdad. Harness en locale en.
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
          // H5: bandeja silenciada — ver helpers/outbox_test_helpers.dart.
          outboxDbProvider.overrideWith(buildMemoryOutboxDb),
          photoVaultProvider.overrideWith(buildQuietVault),
          networkStatusProvider.overrideWithValue(FakeNetworkStatus()),
          outboxRowsProvider.overrideWith((ref) => Stream.value(const [])),
        ],
        child: const RideOpsApp(),
      );

  Map<String, dynamic> cardJson({
    String? id,
    DateTime? pickupAt,
    DateTime? returnAt,
    bool precheckinDone = true,
  }) {
    final raw = readJsonFixture('reservation_card.json');
    if (id != null) raw['id'] = id;
    raw['pickupAt'] = pickupAt?.toUtc().toIso8601String();
    raw['returnAt'] = returnAt?.toUtc().toIso8601String();
    if (!precheckinDone) raw['customerInfoCompletedAt'] = null;
    return raw;
  }

  /// Payload determinista desde el fixture real, con métricas y colas a
  /// gusto del caso.
  DashboardPayload payload({
    Map<String, Object?> metrics = const {},
    Map<String, List<Map<String, dynamic>>> queues = const {},
  }) {
    final raw = readJsonFixture('dashboard.json');
    final m = raw['metrics'] as Map<String, dynamic>;
    m.updateAll((_, _) => 0);
    metrics.forEach((k, v) => m[k] = v);
    final q = raw['queues'] as Map<String, dynamic>;
    q.updateAll((_, _) => <dynamic>[]);
    queues.forEach((k, v) => q[k] = v);
    return DashboardPayload.fromJson(raw);
  }

  Future<void> pumpHome(WidgetTester tester) async {
    await tester.pumpWidget(app());
    await tester.pumpAndSettle();
    expect(find.byType(HomeScreen), findsOneWidget);
  }

  testWidgets(
      '5A con datos: orden de secciones, contador honesto 8+, bento con '
      'En renta y frescura visible', (tester) async {
    final now = DateTime.now();
    final today = DateTime(now.year, now.month, now.day, 23, 50);
    dashboardApi.onFetch = (_) async => payload(
          metrics: {'activeRentals': 22, 'dueBackToday': 3, 'issueOpen': 1},
          queues: {
            // 8 salidas de HOY: cap del server tocado ⇒ "8+".
            'checkout': List.generate(
              8,
              (i) => cardJson(id: 'chk-$i', pickupAt: today),
            ),
            'returns': [
              cardJson(
                id: 'ret-1',
                returnAt: now.subtract(const Duration(minutes: 90)),
              ),
            ],
            'issueEscalations': [
              ((readJsonFixture('dashboard.json')['queues']
                          as Map<String, dynamic>)['issueEscalations']
                      as List<dynamic>)
                  .first as Map<String, dynamic>,
            ],
          },
        );
    await pumpHome(tester);

    // Frescura honesta, sin banner.
    expect(find.textContaining('Updated moments ago'), findsOneWidget);

    // Hero: 8+ salidas (capped) + 3 retornos + 1 incidente = 12+.
    expect(find.text('For right now'), findsOneWidget);
    expect(find.text('12+'), findsOneWidget);
    expect(find.textContaining('8+ pickups'), findsOneWidget);

    // Contador de la sección de salidas también capado.
    expect(find.text('8+'), findsOneWidget);

    // Bento: En renta con el TOTAL real de la métrica.
    expect(find.text('22'), findsOneWidget);
    expect(find.textContaining('3 due today'), findsOneWidget);

    // Bajo el fold (8 cards de salida empujan el resto): scroll real.
    final scrollable = find.byType(Scrollable).first;
    // Retorno vencido: chip danger de vencido (dato del caso: 90 min).
    await tester.scrollUntilVisible(find.text('Overdue 1 h'), 200,
        scrollable: scrollable);
    expect(find.text('Overdue 1 h'), findsOneWidget);

    // Colas vacías EN programa: colapsan a chips (BOTH ⇒ loaner existe).
    await tester.scrollUntilVisible(find.text('No activity right now'), 200,
        scrollable: scrollable);
    expect(find.text('Loaner follow-up'), findsOneWidget);
    expect(find.text('Pre-checkin'), findsWidgets);
  });

  testWidgets(
      'orden vinculante de secciones: incidentes → salidas → retornos '
      '(nota 3 del mockup)', (tester) async {
    final now = DateTime.now();
    dashboardApi.onFetch = (_) async => payload(
          queues: {
            'checkout': [
              cardJson(
                id: 'chk-1',
                pickupAt: now.add(const Duration(hours: 2)),
              ),
            ],
            'returns': [
              cardJson(
                id: 'ret-1',
                returnAt: now.add(const Duration(hours: 3)),
              ),
            ],
            'issueEscalations': [
              ((readJsonFixture('dashboard.json')['queues']
                          as Map<String, dynamic>)['issueEscalations']
                      as List<dynamic>)
                  .first as Map<String, dynamic>,
            ],
          },
        );
    await pumpHome(tester);

    final incidentsY = tester.getTopLeft(find.text('Incidents')).dy;
    final pickupsY = tester.getTopLeft(find.text('Pickups (72 h)')).dy;
    final returnsY = tester.getTopLeft(find.text('Returns (72 h)')).dy;
    expect(incidentsY, lessThan(pickupsY));
    expect(pickupsY, lessThan(returnsY));
  });

  testWidgets(
      '5B RENTAL_ONLY: las colas loaner NO existen (ni secciones ni chips ni '
      'tile) — el tile satélite es Pre-checkin', (tester) async {
    api.onMe = () async => sessionUserFixture(programScope: 'RENTAL_ONLY');
    dashboardApi.onFetch = (_) async => payload(
          metrics: {'activeRentals': 17, 'precheckinQueue': 1},
          queues: {
            'checkout': [
              cardJson(
                id: 'chk-1',
                pickupAt: DateTime.now().add(const Duration(hours: 2)),
              ),
            ],
          },
        );
    await pumpHome(tester);

    expect(find.text('Loaner follow-up'), findsNothing);
    expect(find.text('Loaners ready'), findsNothing);
    expect(find.text('Loaner billing'), findsNothing);
    expect(find.text('Loaner returns'), findsNothing);
    expect(find.text('Loaner'), findsNothing, reason: 'tile omitido, no en 0');
    expect(find.text('Sent, not completed'), findsOneWidget,
        reason: 'su lugar lo toma el tile de pre-checkin (5B)');
  });

  testWidgets('5D todo vacío: estado feliz con las colas confirmadas en cero',
      (tester) async {
    dashboardApi.onFetch = (_) async => payload();
    await pumpHome(tester);

    expect(find.text('Yard at ease'), findsOneWidget);
    expect(find.text('All 9 queues at zero'), findsOneWidget,
        reason: 'programa BOTH: 8 secciones + En renta');
    // En renta tiene su camino también en este estado (chip tocable).
    expect(find.text('On rent'), findsOneWidget);
  });

  testWidgets(
      '5E offline: banner warn con edad + Reintentar; el cache SE MUESTRA, '
      'no se borra — y Reintentar recupera', (tester) async {
    dashboardApi.onFetch = (_) async => payload(
          metrics: {'activeRentals': 5},
          queues: {
            'checkout': [
              cardJson(
                id: 'chk-1',
                pickupAt: DateTime.now().add(const Duration(hours: 1)),
              ),
            ],
          },
        );
    await pumpHome(tester);
    expect(find.text('María González'), findsOneWidget);

    // Se cae la red: refresh (mismo gancho del pull-to-refresh) falla.
    dashboardApi.onFetch = (_) async => throw apiError(ApiErrorKind.network);
    final container = ProviderScope.containerOf(
      tester.element(find.byType(HomeScreen)),
    );
    await container.read(dashboardControllerProvider.notifier).refresh();
    await tester.pumpAndSettle();

    expect(find.textContaining('No connection — showing data from'),
        findsOneWidget);
    expect(find.text('María González'), findsOneWidget,
        reason: 'el dato viejo sigue en pantalla (5E)');
    expect(find.textContaining('as of '), findsOneWidget,
        reason: 'el hero declara el corte del dato');

    // Vuelve la señal: Reintentar del banner sana.
    dashboardApi.onFetch = null;
    await tester.tap(find.text('Retry'));
    await tester.pumpAndSettle();
    expect(find.textContaining('No connection'), findsNothing);
    expect(find.textContaining('Updated moments ago'), findsOneWidget);
  });

  testWidgets(
      '403 de UBICACIÓN (firma completa): LocationDeniedView + chip del '
      'shell en danger', (tester) async {
    locationStore.raw = '{"userId":"$uid","locationId":"loc-quitada",'
        '"locationName":"Sede Quitada"}';
    dashboardApi.onFetch = (_) async => throw ApiError(
          kind: ApiErrorKind.forbidden,
          message: ApiError.viewLocationDeniedMessage,
          status: 403,
        );
    await pumpHome(tester);

    expect(find.byType(LocationDeniedView), findsOneWidget);
    expect(find.text('No access to this location'), findsOneWidget);
    // Criterio registrado H4: la negativa se ve DONDE se eligió la sede.
    expect(
      find.bySemanticsLabel(
        'Active location: Sede Quitada. Access denied. Tap to change.',
      ),
      findsOneWidget,
    );
  });

  testWidgets(
      '403 de MÓDULO: error genérico con el mensaje del servidor — JAMÁS la '
      '4D ni el chip danger (NIT QA-H3)', (tester) async {
    const moduleMsg = 'The Employee app module is not enabled for your '
        'account. Ask an administrator to turn it on.';
    dashboardApi.onFetch = (_) async => throw ApiError(
          kind: ApiErrorKind.forbidden,
          message: moduleMsg,
          status: 403,
        );
    await pumpHome(tester);

    expect(find.byType(LocationDeniedView), findsNothing);
    expect(find.text('No access'), findsOneWidget);
    expect(find.text(moduleMsg), findsOneWidget,
        reason: 'el mensaje del backend se muestra, no se inventa');
    expect(
      find.bySemanticsLabel(RegExp('Access denied')),
      findsNothing,
      reason: 'el chip solo entra en danger con la negativa de ubicación',
    );
  });

  testWidgets(
      'el tile En renta ES la ruta de la cola active: tap → lista con el '
      'total real y back → home', (tester) async {
    dashboardApi.onFetch = (_) async => payload(
          metrics: {'activeRentals': 22},
          queues: {
            'active': List.generate(
              8,
              (i) => cardJson(
                id: 'act-$i',
                returnAt: DateTime.now().add(Duration(hours: i + 1)),
              ),
            ),
          },
        );
    await pumpHome(tester);

    await tester.tap(find.text('22'));
    await tester.pumpAndSettle();
    expect(find.byType(QueueListScreen), findsOneWidget);
    expect(find.text('On rent · 8+'), findsOneWidget);
    expect(find.text('Showing 8 of 22'), findsOneWidget,
        reason: 'active es la única cola con total real en las métricas');

    await tester.tap(find.byIcon(Icons.arrow_back_rounded));
    await tester.pumpAndSettle();
    expect(find.byType(HomeScreen), findsOneWidget);
  });

  testWidgets(
      'MINOR-1 QA-H4: cambio de sede que FALLA estando dentro de la lista de '
      'cola — error con Reintentar (jamás skeleton eterno) y recuperación',
      (tester) async {
    // Una salida en cola para que la home pinte el bento (sin items en
    // ninguna cola caería en el estado 5D, que no tiene tiles).
    dashboardApi.onFetch = (_) async => payload(
          metrics: {'activeRentals': 2},
          queues: {
            'checkout': [
              cardJson(
                id: 'chk-1',
                pickupAt: DateTime.now().add(const Duration(hours: 1)),
              ),
            ],
          },
        );
    await pumpHome(tester);
    await tester.tap(find.text('2')); // tile En renta → lista de `active`
    await tester.pumpAndSettle();
    expect(find.byType(QueueListScreen), findsOneWidget);

    // El usuario cambia de sede con la red caída: rebuild sin cache + fetch
    // fallido — antes del fix, skeleton para siempre sin salida.
    dashboardApi.onFetch = (_) async => throw apiError(ApiErrorKind.network);
    final container = ProviderScope.containerOf(
      tester.element(find.byType(QueueListScreen)),
    );
    await container
        .read(activeLocationProvider.notifier)
        .set(locationId: 'loc-aero', locationName: 'Sucursal Aeropuerto');
    await tester.pumpAndSettle();

    expect(find.byType(HomeSkeleton), findsNothing);
    expect(find.byType(DashboardErrorView), findsOneWidget);
    expect(find.text('Retry'), findsOneWidget);

    // Vuelve la señal: Reintentar recupera la lista (vacía en la sede nueva).
    dashboardApi.onFetch = null;
    await tester.tap(find.text('Retry'));
    await tester.pumpAndSettle();
    expect(find.text('Nothing in this queue right now.'), findsOneWidget);
  });

  testWidgets('chip de cola vacía es tocable y abre su lista vacía',
      (tester) async {
    dashboardApi.onFetch = (_) async => payload(
          queues: {
            'checkout': [
              cardJson(
                id: 'chk-1',
                pickupAt: DateTime.now().add(const Duration(hours: 1)),
              ),
            ],
          },
        );
    await pumpHome(tester);

    await tester.tap(find.text('Returns (72 h)'));
    await tester.pumpAndSettle();
    expect(find.byType(QueueListScreen), findsOneWidget);
    expect(find.text('Nothing in this queue right now.'), findsOneWidget);
  });
}
