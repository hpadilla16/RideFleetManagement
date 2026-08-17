import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:rideops/core/api/api_error.dart';
import 'package:rideops/core/api/api_providers.dart';
import 'package:rideops/core/api/dto/reservation_card.dart';
import 'package:rideops/core/api/enums.dart';
import 'package:rideops/core/l10n/app_localizations.dart';
import 'package:rideops/core/outbox/network_status.dart';
import 'package:rideops/core/router/app_router.dart';
import 'package:rideops/core/session/active_location.dart';
import 'package:rideops/core/session/session_controller.dart';
import 'package:rideops/core/session/session_state.dart';
import 'package:rideops/core/telemetry/event_logger.dart';
import 'package:rideops/core/widgets/ride_buttons.dart';
import 'package:rideops/features/checkout/application/checkout_entry_controller.dart';
import 'package:rideops/features/checkout/domain/checkout_entry.dart';
import 'package:rideops/features/checkout/presentation/widgets/entry_guard_sheet.dart';
import 'package:rideops/features/dashboard/domain/dashboard_queues.dart';
import 'package:rideops/features/dashboard/presentation/widgets/queue_cards.dart';
import 'package:rideops/features/search/presentation/search_screen.dart';

import 'helpers/auth_test_helpers.dart';
import 'helpers/checkout_test_helpers.dart';
import 'helpers/outbox_test_helpers.dart';
import 'helpers/shell_test_helpers.dart';

/// M2-H7 — entrada al checkout desde la card de la cola de salidas y los 4
/// guards de CREACIÓN (mockup 11A–11E). Harness en locale `en` (convención de
/// la suite): se asierta contra app_en.arb.
void main() {
  final liveToken = fakeJwt(
    exp: DateTime.now().add(const Duration(hours: 8)),
    sub: kMyUserId,
  );

  ApiError err(
    ApiErrorKind kind, {
    String? code,
    String message = 'server said so',
    int? status,
  }) =>
      ApiError(kind: kind, message: message, code: code, status: status);

  // ── dominio: la tabla de guards en el ORDEN REAL del servicio ─────────────

  group('classifyEntryError — los 4 guards de createForReservation', () {
    // El orden de esta lista ES el de checkout-session.service.js:109-181.
    final table = <(String, ApiError, CheckoutEntryBlockKind)>[
      (
        '422 NO_VEHICLE_ASSIGNED (service:128) → frame 11C',
        err(ApiErrorKind.badRequest,
            code: 'NO_VEHICLE_ASSIGNED', status: 422),
        CheckoutEntryBlockKind.noVehicle,
      ),
      (
        '409 VEHICLE_CONFLICT (service:136) → frame 11D',
        err(ApiErrorKind.conflict, code: 'VEHICLE_CONFLICT', status: 409),
        CheckoutEntryBlockKind.vehicleConflict,
      ),
      (
        '422 PRECHECKIN_REQUIRED (service:80) → frame 11B',
        err(ApiErrorKind.badRequest,
            code: 'PRECHECKIN_REQUIRED', status: 422),
        CheckoutEntryBlockKind.precheckin,
      ),
      (
        '422 AGE_RULES_UNDER_MIN (service:97) → frame 11B variante edad',
        err(ApiErrorKind.badRequest,
            code: 'AGE_RULES_UNDER_MIN', status: 422),
        CheckoutEntryBlockKind.ageRules,
      ),
      (
        '409 SESSION_TERMINAL (service:156) → frame 11E',
        err(ApiErrorKind.conflict, code: 'SESSION_TERMINAL', status: 409),
        CheckoutEntryBlockKind.terminal,
      ),
    ];

    for (final (name, error, expected) in table) {
      test(name, () {
        final block = classifyEntryError(error, requestHadHeader: true);
        expect(block.kind, expected);
        // El mensaje del servidor SIEMPRE se conserva (DoD #5).
        expect(block.message, error.message);
      });
    }

    test('un AGE_RULES_* nuevo cae en su pantalla, no en el genérico', () {
      final block = classifyEntryError(
        err(ApiErrorKind.badRequest, code: 'AGE_RULES_SOMETHING_NEW'),
        requestHadHeader: false,
      );
      expect(block.kind, CheckoutEntryBlockKind.ageRules);
    });

    test('403 del selector de sede vs 403 de módulo: pantallas distintas', () {
      final locationDenied = classifyEntryError(
        err(
          ApiErrorKind.forbidden,
          message: ApiError.viewLocationDeniedMessage,
        ),
        requestHadHeader: true,
      );
      expect(locationDenied.kind, CheckoutEntryBlockKind.locationDenied);

      // Mismo status, otro mensaje y sin header: es RBAC/módulo.
      final moduleDenied = classifyEntryError(
        err(ApiErrorKind.forbidden, message: 'Module reservations is off'),
        requestHadHeader: true,
      );
      expect(moduleDenied.kind, CheckoutEntryBlockKind.forbidden);
    });

    test('sin red y 429 se separan del "algo salió mal"', () {
      expect(
        classifyEntryError(err(ApiErrorKind.network), requestHadHeader: false)
            .kind,
        CheckoutEntryBlockKind.offline,
      );
      expect(
        classifyEntryError(err(ApiErrorKind.rateLimited),
                requestHadHeader: false)
            .kind,
        CheckoutEntryBlockKind.rateLimited,
      );
      expect(
        classifyEntryError(err(ApiErrorKind.server), requestHadHeader: false)
            .kind,
        CheckoutEntryBlockKind.unknown,
      );
    });

    test('terminal NO ofrece reintentar; los demás guards sí', () {
      expect(
        classifyEntryError(err(ApiErrorKind.conflict, code: 'SESSION_TERMINAL'),
                requestHadHeader: false)
            .retriable,
        isFalse,
      );
      expect(
        classifyEntryError(
                err(ApiErrorKind.badRequest, code: 'PRECHECKIN_REQUIRED'),
                requestHadHeader: false)
            .retriable,
        isTrue,
      );
    });
  });

  group('conflictingReservationNumberOf — puente sobre el texto del backend', () {
    test('las dos formas reales de ensureNoVehicleConflict', () {
      expect(
        conflictingReservationNumberOf(
          'Vehicle is still out on open rental RES-1001 — complete its '
          'check-in (or swap vehicles) first',
        ),
        'RES-1001',
      );
      expect(
        conflictingReservationNumberOf('Vehicle conflict with reservation TL-42'),
        'TL-42',
      );
    });

    test('si el copy del servidor cambia, degrada a null (no a un botón que '
        'busca basura)', () {
      expect(conflictingReservationNumberOf('Vehicle is busy right now'), isNull);
      expect(
        conflictingReservationNumberOf('Vehicle conflict with reservation ?'),
        isNull,
      );
    });
  });

  // ── controller ────────────────────────────────────────────────────────────

  ({ProviderContainer container, FakeCheckoutApi api, CapturingEventLogger log})
      harness({
    ActiveLocation location = const ActiveLocation.pinned(
      locationId: 'loc-1',
      locationName: 'Patio Centro',
    ),
    bool online = true,
    FakePrecheckinReservationsApi? reservations,
  }) {
    final api = FakeCheckoutApi();
    final log = CapturingEventLogger();
    final container = ProviderContainer(
      overrides: [
        checkoutApiProvider.overrideWithValue(api),
        reservationsApiProvider
            .overrideWithValue(reservations ?? FakePrecheckinReservationsApi()),
        eventLoggerProvider.overrideWithValue(log),
        networkStatusProvider.overrideWithValue(FakeNetworkStatus(online: online)),
        activeLocationProvider.overrideWith(() => StubActiveLocation(location)),
        sessionControllerProvider.overrideWith(
          () => MutableSessionController(
            SessionState.authenticated(
              token: liveToken,
              user: sessionUserFixture(),
            ),
          ),
        ),
      ],
    );
    addTearDown(container.dispose);
    // El provider es autoDispose: sin un oyente vivo, cada `read` construiría
    // (y tiraría) un controller distinto y el POST quedaría huérfano. En la
    // app ese oyente es la card; aquí, esta suscripción.
    final sub = container.listen(
      checkoutEntryProvider(kReservationId),
      (_, _) {},
    );
    addTearDown(sub.close);
    return (container: container, api: api, log: log);
  }

  StubActiveLocation locationOf(ProviderContainer c) =>
      c.read(activeLocationProvider.notifier) as StubActiveLocation;

  CheckoutEntryController controllerOf(ProviderContainer c) =>
      c.read(checkoutEntryProvider(kReservationId).notifier);

  test('idempotencia: con sesión viva el POST la REANUDA — una sola llamada y '
      'sin GET extra', () async {
    final h = harness();
    // El servidor devuelve la sesión existente a media máquina (routes:42
    // responde 201 igual al crear que al reanudar).
    h.api.onCreate = (_) async => sessionAt(CheckoutStep.paid);

    final outcome = await controllerOf(h.container).start();

    expect(outcome, CheckoutEntryOutcome.opened);
    expect(h.api.created, [kReservationId]);
    expect(h.api.createCalls, 1);
    expect(h.api.byReservationCalls, 0, reason: 'la lectura la hace el wizard');
    expect(h.log.has(CheckoutEvents.entryOpen), isTrue);
  });

  test('anti-doble-tap: el segundo toque con el POST en vuelo no manda otro',
      () async {
    final h = harness();
    final gate = Completer<void>();
    h.api.onCreate = (_) async {
      await gate.future;
      return sessionAt(CheckoutStep.confirming);
    };

    final first = controllerOf(h.container).start();
    await Future<void>.delayed(Duration.zero);
    final second = await controllerOf(h.container).start();

    expect(second, CheckoutEntryOutcome.busy);
    expect(h.api.createCalls, 1);
    gate.complete();
    expect(await first, CheckoutEntryOutcome.opened);
  });

  test('cambio de sede con el POST en vuelo: NO se traga como doble tap — se '
      'aborta y se dice que la sesión pudo crearse', () async {
    final h = harness();
    final gate = Completer<void>();
    h.api.onCreate = (_) async {
      await gate.future;
      return sessionAt(CheckoutStep.confirming);
    };

    final pending = controllerOf(h.container).start();
    await Future<void>.delayed(Duration.zero);
    // El agente cambia de sede mientras el POST viaja: el controller se
    // reconstruye y la respuesta ya no pertenece a lo que ve.
    locationOf(h.container).emit(
      const ActiveLocation.pinned(locationId: 'loc-2', locationName: 'Norte'),
    );
    // Riverpod invalida perezosamente: esta lectura fuerza el rebuild ANTES de
    // que aterrice la respuesta (en la app lo fuerza el repintado de la card).
    h.container.read(checkoutEntryProvider(kReservationId));
    gate.complete();

    expect(await pending, CheckoutEntryOutcome.aborted);
    // Ni "abierto" (no se navega a un alcance que ya no es) ni "busy" (que se
    // tragaría en silencio un POST que pudo crear la sesión).
    expect(h.log.has(CheckoutEvents.entryOpen), isFalse);
    expect(
      h.log.events.where((e) => e.$1 == CheckoutEvents.entryBlocked).single.$2,
      {'code': 'scopeChanged'},
    );
  });

  test('gate de hidratación: sin sede hidratada NO sale el POST', () async {
    final h = harness(location: const ActiveLocation.hydrating());
    // El POST espera acotado a que hidrate; se comprueba que a los 200 ms
    // todavía no salió nada (y el estado sigue "abriendo" en la card).
    final pending = controllerOf(h.container).start();
    await Future<void>.delayed(const Duration(milliseconds: 200));

    expect(h.api.createCalls, 0);
    expect(h.container.read(checkoutEntryProvider(kReservationId)).starting,
        isTrue);

    final outcome = await pending;
    expect(outcome, CheckoutEntryOutcome.blocked);
    expect(
      h.container.read(checkoutEntryProvider(kReservationId)).block!.kind,
      CheckoutEntryBlockKind.locationNotReady,
    );
    expect(h.api.createCalls, 0);
  }, timeout: const Timeout(Duration(seconds: 30)));

  test('sin red: no se encola (ADR-5), no se manda el POST y se dice por qué',
      () async {
    final h = harness(online: false);

    final outcome = await controllerOf(h.container).start();

    expect(outcome, CheckoutEntryOutcome.blocked);
    expect(h.api.createCalls, 0);
    final block = h.container.read(checkoutEntryProvider(kReservationId)).block!;
    expect(block.kind, CheckoutEntryBlockKind.offline);
    expect(
      h.log.events.where((e) => e.$1 == CheckoutEvents.entryBlocked).single.$2,
      {'code': 'offline'},
    );
  });

  test('409 SESSION_TERMINAL: se cuenta como bloqueo Y se navega (el wizard '
      'tiene la fila real)', () async {
    final h = harness();
    h.api.onCreate = (_) async => throw ApiError(
          kind: ApiErrorKind.conflict,
          message: 'Reservation already has a closed checkout session',
          code: 'SESSION_TERMINAL',
          status: 409,
        );

    final outcome = await controllerOf(h.container).start();

    expect(outcome, CheckoutEntryOutcome.terminal);
    expect(
      h.log.events.where((e) => e.$1 == CheckoutEvents.entryBlocked).single.$2,
      {'code': 'SESSION_TERMINAL'},
    );
  });

  test('telemetría del guard: el tag code lleva el del SERVIDOR', () async {
    final h = harness();
    h.api.onCreate = (_) async => throw ApiError(
          kind: ApiErrorKind.badRequest,
          message: 'Pre-check-in must be completed…',
          code: 'PRECHECKIN_REQUIRED',
          status: 422,
        );

    await controllerOf(h.container).start();

    expect(
      h.log.events.where((e) => e.$1 == CheckoutEvents.entryBlocked).single.$2,
      {'code': 'PRECHECKIN_REQUIRED'},
    );
  });

  test('link de pre-checkin: el 200 con emailSent:false NO es un éxito',
      () async {
    final reservations = FakePrecheckinReservationsApi()
      ..onSendLink = () async => (sent: false, warning: 'SMTP down');
    final h = harness(reservations: reservations);

    await controllerOf(h.container).sendPrecheckinLink();

    final state = h.container.read(checkoutEntryProvider(kReservationId));
    expect(state.linkSent, isFalse);
    expect(state.linkError!.message, 'SMTP down');
    expect(h.log.has(CheckoutEvents.entryPrecheckinLinkSent), isFalse);
  });

  test('link de pre-checkin enviado: confirmación + telemetría', () async {
    final h = harness();

    await controllerOf(h.container).sendPrecheckinLink();

    expect(h.container.read(checkoutEntryProvider(kReservationId)).linkSent,
        isTrue);
    expect(h.log.has(CheckoutEvents.entryPrecheckinLinkSent), isTrue);
  });

  // ── card + sheets ─────────────────────────────────────────────────────────

  ReservationCard checkoutCard() =>
      ReservationCard.fromJson(readJsonFixture('reservation_card.json'));

  Future<
      ({
        FakeCheckoutApi api,
        FakePrecheckinReservationsApi reservations,
        GoRouter router,
      })> pumpCard(
    WidgetTester tester, {
    bool online = true,
    Future<void> Function(String)? onCreate,
    FakePrecheckinReservationsApi? reservations,

    /// Escala de texto del sistema: en el patio, 1.5–2.0 es normal.
    double textScale = 1,
  }) async {
    final api = FakeCheckoutApi();
    if (onCreate != null) {
      api.onCreate = (id) async {
        await onCreate(id);
        return sessionAt(CheckoutStep.confirming);
      };
    }
    final resApi = reservations ?? FakePrecheckinReservationsApi();
    final router = GoRouter(
      initialLocation: AppRoutes.home,
      routes: [
        GoRoute(
          path: AppRoutes.home,
          builder: (_, _) => Scaffold(
            body: ListView(
              children: [
                ReservationQueueCard(
                  item: checkoutCard(),
                  queue: DashboardQueue.checkout,
                  now: DateTime.parse('2026-08-16T12:00:00Z'),
                ),
              ],
            ),
          ),
        ),
        GoRoute(
          path: AppRoutes.checkoutPattern,
          builder: (_, _) => const Scaffold(body: Text('wizard')),
        ),
        GoRoute(
          path: AppRoutes.search,
          // Scaffold: en la app real lo pone el AppShell.
          builder: (_, state) => Scaffold(
            body: SearchScreen(initialQuery: state.uri.queryParameters['q']),
          ),
        ),
      ],
    );
    addTearDown(router.dispose);

    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          checkoutApiProvider.overrideWithValue(api),
          reservationsApiProvider.overrideWithValue(resApi),
          // La búsqueda es el destino real del 11D: sin este fake, su fetch
          // saldría por un Dio de verdad.
          dashboardApiProvider.overrideWithValue(FakeDashboardApi()),
          eventLoggerProvider.overrideWithValue(CapturingEventLogger()),
          networkStatusProvider
              .overrideWithValue(FakeNetworkStatus(online: online)),
          activeLocationProvider.overrideWith(
            () => StubActiveLocation(
              const ActiveLocation.pinned(
                locationId: 'loc-1',
                locationName: 'Patio Centro',
              ),
            ),
          ),
          sessionControllerProvider.overrideWith(
            () => MutableSessionController(
              SessionState.authenticated(
                token: liveToken,
                user: sessionUserFixture(),
              ),
            ),
          ),
        ],
        child: MaterialApp.router(
          routerConfig: router,
          localizationsDelegates: const [
            AppLocalizations.delegate,
            GlobalMaterialLocalizations.delegate,
            GlobalWidgetsLocalizations.delegate,
            GlobalCupertinoLocalizations.delegate,
          ],
          supportedLocales: const [Locale('es'), Locale('en')],
          builder: (context, child) => MediaQuery(
            data: MediaQuery.of(context).copyWith(
              textScaler: TextScaler.linear(textScale),
            ),
            child: child!,
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    return (api: api, reservations: resApi, router: router);
  }

  testWidgets('11A — el arranque se siente EN la card: tinte, spinner y '
      '"Opening…", nunca un overlay', (tester) async {
    final gate = Completer<void>();
    final f = await pumpCard(tester, onCreate: (_) => gate.future);

    await tester.tap(find.byType(ReservationQueueCard));
    await tester.pump();

    // La card sigue en su cola (no hubo navegación) y declara su estado.
    expect(find.text('Opening…'), findsOneWidget);
    expect(find.textContaining('opening checkout…'), findsOneWidget);
    expect(find.byType(CircularProgressIndicator), findsOneWidget);
    expect(find.text('wizard'), findsNothing);

    // Segundo toque con el POST en vuelo: no manda otro.
    await tester.tap(find.byType(ReservationQueueCard));
    await tester.pump();
    expect(f.api.createCalls, 1);

    gate.complete();
    await tester.pumpAndSettle();
    expect(find.text('wizard'), findsOneWidget);
  });

  /// Cada code → su pantalla y sus salidas (11B–11D). El 11E no vive en un
  /// sheet: navega al wizard, y su contrato visual se prueba aparte.
  final sheetTable = <({
    String name,
    String code,
    ApiErrorKind kind,
    String message,
    String title,
    List<String> buttons,
    String foot,
  })>[
    (
      name: '11C · 422 NO_VEHICLE_ASSIGNED',
      code: 'NO_VEHICLE_ASSIGNED',
      kind: ApiErrorKind.badRequest,
      message: 'Assign a vehicle to this reservation before starting checkout.',
      title: 'This reservation has no vehicle assigned',
      buttons: ['Retry', 'Cancel'],
      foot: 'No checkout session was created.',
    ),
    (
      name: '11D · 409 VEHICLE_CONFLICT (la sesión NO existe todavía)',
      code: 'VEHICLE_CONFLICT',
      kind: ApiErrorKind.conflict,
      message: 'Vehicle is still out on open rental RES-1001 — complete its '
          'check-in (or swap vehicles) first',
      title: 'That unit is already on another rental',
      buttons: ['Search RES-1001', 'Retry', 'Cancel'],
      foot: 'No checkout session was created.',
    ),
    (
      name: '11B · 422 PRECHECKIN_REQUIRED',
      code: 'PRECHECKIN_REQUIRED',
      kind: ApiErrorKind.badRequest,
      message: 'Pre-check-in must be completed before check-out can start.',
      title: 'The customer pre-check-in is missing',
      buttons: ['Send pre-check-in to the customer', 'Retry', 'Cancel'],
      foot: 'The reservation was not touched. As soon as the pre-check-in is '
          'done, the card unblocks by itself.',
    ),
    (
      name: '11B · 422 AGE_RULES_UNDER_MIN',
      code: 'AGE_RULES_UNDER_MIN',
      kind: ApiErrorKind.badRequest,
      message: 'Customer must be at least 25 years old at pickup.',
      title: 'Age rules do not allow this hand-over',
      buttons: ['Retry', 'Cancel'],
      foot: 'No checkout session was created.',
    ),
  ];

  for (final row in sheetTable) {
    testWidgets('${row.name}: pantalla propia con salidas reales',
        (tester) async {
      final f = await pumpCard(tester);
      f.api.onCreate = (_) async => throw ApiError(
            kind: row.kind,
            message: row.message,
            code: row.code,
          );

      await tester.tap(find.byType(ReservationQueueCard));
      await tester.pumpAndSettle();

      expect(find.byType(CheckoutEntryGuardSheet), findsOneWidget);
      expect(find.text(row.title), findsOneWidget);
      for (final label in row.buttons) {
        expect(find.text(label), findsOneWidget, reason: label);
      }
      expect(find.text(row.foot), findsOneWidget);
      // Jamás se navegó al wizard: la sesión no existe.
      expect(find.text('wizard'), findsNothing);
      // El texto del servidor viaja con el copy localizado en los guards que
      // llevan el dato concreto.
      if (row.code == 'AGE_RULES_UNDER_MIN') {
        expect(find.textContaining(row.message), findsOneWidget);
      }
    });
  }

  testWidgets('11D — "Buscar la otra reserva" es una salida REAL: siembra la '
      'búsqueda con el número del mensaje', (tester) async {
    final f = await pumpCard(tester);
    f.api.onCreate = (_) async => throw ApiError(
          kind: ApiErrorKind.conflict,
          message: 'Vehicle conflict with reservation RES-1001',
          code: 'VEHICLE_CONFLICT',
        );

    await tester.tap(find.byType(ReservationQueueCard));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Search RES-1001'));
    await tester.pumpAndSettle();

    expect(find.byType(SearchScreen), findsOneWidget);
    expect(find.text('RES-1001'), findsWidgets);
  });

  testWidgets('11B — enviar el link: comprobante DENTRO del sheet y el primario '
      'pasa a "Cerrar" (no un botón muerto al 55 %)', (tester) async {
    final reservations = FakePrecheckinReservationsApi();
    final f = await pumpCard(tester, reservations: reservations);
    f.api.onCreate = (_) async => throw ApiError(
          kind: ApiErrorKind.badRequest,
          message: 'Pre-check-in must be completed…',
          code: 'PRECHECKIN_REQUIRED',
        );

    await tester.tap(find.byType(ReservationQueueCard));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Send pre-check-in to the customer'));
    await tester.pumpAndSettle();

    expect(reservations.linkCalls, 1);
    expect(find.byType(CheckoutEntryGuardSheet), findsOneWidget,
        reason: 'el sheet se queda abierto con el comprobante');
    expect(
      find.textContaining("the pre-check-in link went to the customer's email"),
      findsOneWidget,
    );

    // El botón de enviar YA NO ESTÁ: se convirtió en la salida. Así no se
    // spamea al cliente ni se quema el cooldown del backend, y no queda un
    // primario apagado sin explicación.
    expect(find.text('Send pre-check-in to the customer'), findsNothing);
    await tester.tap(find.text('Close'));
    await tester.pumpAndSettle();
    expect(reservations.linkCalls, 1);
    expect(find.byType(CheckoutEntryGuardSheet), findsNothing);
  });

  testWidgets('sin red desde la card: pantalla honesta con reintento manual y '
      'CERO POST', (tester) async {
    final f = await pumpCard(tester, online: false);

    await tester.tap(find.byType(ReservationQueueCard));
    await tester.pumpAndSettle();

    expect(find.text('No connection to open the checkout'), findsOneWidget);
    expect(
      find.textContaining('It is not queued in the Outbox'),
      findsOneWidget,
      reason: 'ADR-5 aplica a TODO el checkout, no solo al dinero',
    );
    expect(f.api.createCalls, 0);
    expect(find.text('Retry'), findsOneWidget);
  });

  testWidgets('el "Reintentar" del sheet vuelve a intentar de verdad',
      (tester) async {
    final f = await pumpCard(tester);
    var calls = 0;
    f.api.onCreate = (_) async {
      calls++;
      if (calls == 1) {
        throw ApiError(
          kind: ApiErrorKind.badRequest,
          message: 'Pre-check-in must be completed…',
          code: 'PRECHECKIN_REQUIRED',
        );
      }
      // El compañero completó el pre-checkin mientras el sheet estaba arriba.
      return sessionAt(CheckoutStep.confirming);
    };

    await tester.tap(find.byType(ReservationQueueCard));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Retry'));
    await tester.pumpAndSettle();

    expect(calls, 2);
    expect(find.text('wizard'), findsOneWidget);
  });

  testWidgets('403 de ubicación al crear: negativa visible con salida al '
      'selector (4D), no un error genérico', (tester) async {
    final f = await pumpCard(tester);
    f.api.onCreate = (_) async => throw ApiError(
          kind: ApiErrorKind.forbidden,
          message: ApiError.viewLocationDeniedMessage,
          status: 403,
        );

    await tester.tap(find.byType(ReservationQueueCard));
    await tester.pumpAndSettle();

    expect(find.text('No access to this location'), findsOneWidget);
    expect(find.text('Change location'), findsOneWidget);
    // Negativa dura: no se ofrece reintentar contra una sede que no es tuya.
    expect(find.text('Retry'), findsNothing);
  });

  testWidgets('el sheet NO inventa botones para lo que la app no puede hacer, '
      'pero SÍ dice dónde se hace', (tester) async {
    final f = await pumpCard(tester);
    f.api.onCreate = (_) async => throw ApiError(
          kind: ApiErrorKind.badRequest,
          message: 'Assign a vehicle to this reservation before starting '
              'checkout.',
          code: 'NO_VEHICLE_ASSIGNED',
        );

    await tester.tap(find.byType(ReservationQueueCard));
    await tester.pumpAndSettle();

    // Asignar el vehículo todavía se hace desde el escritorio: NO hay botón
    // muerto. Las salidas son reintentar (el patio pudo asignarlo) y cancelar.
    final buttons = tester
        .widgetList<RidePrimaryButton>(find.byType(RidePrimaryButton))
        .map((b) => b.label)
        .toList();
    expect(buttons, ['Retry']);
    // …y la mitigación está EN PANTALLA, no solo en el razonamiento: sin esta
    // línea el agente busca en la app un botón que no existe.
    expect(
      find.textContaining('is still done from the desk'),
      findsOneWidget,
    );
  });

  testWidgets('11B — la nota que sostiene la ausencia de "Capturar aquí" se '
      'RENDERIZA', (tester) async {
    final f = await pumpCard(tester);
    f.api.onCreate = (_) async => throw ApiError(
          kind: ApiErrorKind.badRequest,
          message: 'Pre-check-in must be completed…',
          code: 'PRECHECKIN_REQUIRED',
        );

    await tester.tap(find.byType(ReservationQueueCard));
    await tester.pumpAndSettle();

    expect(
      find.text(
        'Capturing the details at the counter is still done from the desk: '
        'this app does not have that form yet.',
      ),
      findsOneWidget,
    );
  });

  testWidgets('11D — el mensaje del servidor viaja: "sigue en otra renta" y '
      '"choque de reservas" no pueden verse igual', (tester) async {
    final f = await pumpCard(tester);
    const message = 'Vehicle is still out on open rental RES-1001 — complete '
        'its check-in (or swap vehicles) first';
    f.api.onCreate = (_) async => throw ApiError(
          kind: ApiErrorKind.conflict,
          message: message,
          code: 'VEHICLE_CONFLICT',
        );

    await tester.tap(find.byType(ReservationQueueCard));
    await tester.pumpAndSettle();

    expect(find.textContaining(message), findsOneWidget);
  });

  group('fallos del envío del link (11B) con su hecho accionable', () {
    Future<void> pumpWithLinkError(WidgetTester tester, ApiError error) async {
      final reservations = FakePrecheckinReservationsApi()
        ..onSendLink = () async => throw error;
      final f = await pumpCard(tester, reservations: reservations);
      f.api.onCreate = (_) async => throw ApiError(
            kind: ApiErrorKind.badRequest,
            message: 'Pre-check-in must be completed…',
            code: 'PRECHECKIN_REQUIRED',
          );
      await tester.tap(find.byType(ReservationQueueCard));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Send pre-check-in to the customer'));
      await tester.pumpAndSettle();
    }

    testWidgets('429 es COOLDOWN por reserva ("ya salió"), no saturación',
        (tester) async {
      await pumpWithLinkError(
        tester,
        ApiError(
          kind: ApiErrorKind.rateLimited,
          message: 'A customer info email was just sent for this reservation.',
          status: 429,
        ),
      );

      expect(find.textContaining('That link was just sent'), findsOneWidget);
      // El copy de saturación invitaría a martillar el botón.
      expect(find.textContaining('Too many requests'), findsNothing);
    });

    testWidgets('400 sin destinatario: el dato que falta, en español del patio',
        (tester) async {
      await pumpWithLinkError(
        tester,
        ApiError(
          kind: ApiErrorKind.badRequest,
          message: 'No recipient email found',
          status: 400,
        ),
      );

      expect(
        find.textContaining('The reservation has no customer email'),
        findsOneWidget,
      );
      // El mensaje crudo en inglés no se cuela dentro del copy.
      expect(find.textContaining('No recipient email found'), findsNothing);
    });
  });

  testWidgets('cerrar el sheet por el scrim limpia su estado: la próxima vez '
      'no aparece el aviso viejo', (tester) async {
    final reservations = FakePrecheckinReservationsApi();
    final f = await pumpCard(tester, reservations: reservations);
    f.api.onCreate = (_) async => throw ApiError(
          kind: ApiErrorKind.badRequest,
          message: 'Pre-check-in must be completed…',
          code: 'PRECHECKIN_REQUIRED',
        );

    await tester.tap(find.byType(ReservationQueueCard));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Send pre-check-in to the customer'));
    await tester.pumpAndSettle();
    expect(find.byType(CheckoutEntryGuardSheet), findsOneWidget);

    // Toque en el SCRIM (ni "Cancelar" ni "Cerrar"): el camino que dejaba el
    // estado colgado porque no pasaba por ningún callback del sheet.
    await tester.tapAt(const Offset(10, 10));
    await tester.pumpAndSettle();
    expect(find.byType(CheckoutEntryGuardSheet), findsNothing);

    await tester.tap(find.byType(ReservationQueueCard));
    await tester.pumpAndSettle();

    // Sheet nuevo, estado nuevo: el primario vuelve a ser "enviar" y no hay
    // aviso verde de un envío anterior.
    expect(find.text('Send pre-check-in to the customer'), findsOneWidget);
    expect(
      find.textContaining("the pre-check-in link went to the customer's email"),
      findsNothing,
    );
  });

  testWidgets('sheet desconocido (404 de reserva): mensaje del servidor con '
      'sus salidas, nunca "algo salió mal"', (tester) async {
    final f = await pumpCard(tester);
    f.api.onCreate = (_) async => throw ApiError(
          kind: ApiErrorKind.badRequest,
          message: 'Reservation not found',
          status: 404,
        );

    await tester.tap(find.byType(ReservationQueueCard));
    await tester.pumpAndSettle();

    expect(find.text('Could not open the checkout'), findsOneWidget);
    expect(find.text('Reservation not found'), findsOneWidget);
    expect(find.text('Retry'), findsOneWidget);
    expect(find.text('Cancel'), findsOneWidget);
  });

  testWidgets('a escala de texto 2.0 el sheet scrollea en vez de desbordar',
      (tester) async {
    final f = await pumpCard(tester, textScale: 2);
    f.api.onCreate = (_) async => throw ApiError(
          kind: ApiErrorKind.badRequest,
          message: 'Customer must be at least 25 years old at pickup and the '
              'branch requires a valid license issued more than 12 months ago.',
          code: 'AGE_RULES_UNDER_MIN',
        );

    await tester.tap(find.byType(ReservationQueueCard));
    await tester.pumpAndSettle();

    expect(find.byType(CheckoutEntryGuardSheet), findsOneWidget);
    // Sin el Flexible + ListView, aquí saltaba el overflow amarillo justo en
    // la pantalla que explica un bloqueo.
    expect(tester.takeException(), isNull);

    // Y la salida sigue ALCANZABLE: el contenido scrollea (a esta escala el
    // último botón nace fuera del viewport, que es exactamente el caso).
    expect(find.text('Cancel'), findsNothing);
    await tester.drag(find.byType(CheckoutEntryGuardSheet), const Offset(0, -400));
    await tester.pumpAndSettle();
    expect(find.text('Cancel'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });
}
