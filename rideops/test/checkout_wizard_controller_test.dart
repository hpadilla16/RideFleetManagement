import 'dart:async';
import 'dart:math';

import 'package:fake_async/fake_async.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:rideops/core/api/api_error.dart';
import 'package:rideops/core/api/api_providers.dart';
import 'package:rideops/core/api/dto/checkout_session.dart';
import 'package:rideops/core/api/enums.dart';
import 'package:rideops/core/lifecycle/app_visibility.dart';
import 'package:rideops/core/outbox/network_status.dart';
import 'package:rideops/core/session/active_location.dart';
import 'package:rideops/core/session/session_controller.dart';
import 'package:rideops/core/session/session_state.dart';
import 'package:rideops/core/telemetry/event_logger.dart';
import 'package:rideops/features/checkout/application/checkout_wizard_controller.dart';
import 'package:rideops/features/checkout/application/checkout_wizard_state.dart';
import 'package:rideops/features/checkout/domain/checkout_confirm.dart';
import 'package:rideops/features/checkout/domain/checkout_event_log.dart';
import 'package:rideops/features/checkout/domain/checkout_step_catalog.dart';

import 'helpers/auth_test_helpers.dart';
import 'helpers/checkout_test_helpers.dart';
import 'helpers/outbox_test_helpers.dart';
import 'helpers/shell_test_helpers.dart';

/// Unit tests del controller del wizard (M2-H1) con fakeAsync:
/// tabla del poll (intervalo, carril lento, pausa en background, skip en
/// vuelo, detección de avance ajeno), matriz 409 completa, re-fetch previo a
/// la transición y guard anti-doble-tap.
///
/// Regla que estos tests protegen por encima de todo (ADR-4): la app NO
/// decide pasos. Todo lo que se afirma en pantalla sale de una respuesta del
/// servidor.

/// Random guionizado (mismo patrón que dashboard_controller_test): nextInt
/// devuelve [intValue] capado — determinismo total para el backoff.
class ScriptedRandom implements Random {
  ScriptedRandom({this.intValue = 0, this.doubleValue = 1.0});

  int intValue;
  double doubleValue;

  @override
  int nextInt(int max) => intValue.clamp(0, max - 1);

  @override
  double nextDouble() => doubleValue;

  @override
  bool nextBool() => false;
}

void main() {
  final liveToken = fakeJwt(
    exp: DateTime.now().add(const Duration(hours: 8)),
    sub: kMyUserId,
  );

  ({
    ProviderContainer container,
    FakeCheckoutApi api,
    CapturingEventLogger logger,
    FakeNetworkStatus network,
    MutableSessionController session,
    FakeReservationsApi reservations,
  }) harness({
    ActiveLocation initialLocation = const ActiveLocation.all(),
    bool authenticated = true,
    bool online = true,
    Random? random,
    FakeReservationsApi? reservations,
  }) {
    final api = FakeCheckoutApi();
    final reservationsApi = reservations ?? FakeReservationsApi();
    final logger = CapturingEventLogger();
    final network = FakeNetworkStatus(online: online);
    final session = MutableSessionController(
      authenticated
          ? SessionState.authenticated(
              token: liveToken,
              user: sessionUserFixture(),
            )
          : const SessionState.unauthenticated(),
    );
    final container = ProviderContainer(
      overrides: [
        checkoutApiProvider.overrideWithValue(api),
        reservationsApiProvider.overrideWithValue(reservationsApi),
        eventLoggerProvider.overrideWithValue(logger),
        networkStatusProvider.overrideWithValue(network),
        activeLocationProvider.overrideWith(
          () => StubActiveLocation(initialLocation),
        ),
        sessionControllerProvider.overrideWith(() => session),
        // Random guionizado: el backoff decorrelacionado ante 429 tiene que
        // ser determinista en los tests (nextInt=0 ⇒ el piso del carril).
        checkoutPollConfigProvider.overrideWithValue(
          CheckoutPollConfig(random: random ?? ScriptedRandom()),
        ),
      ],
    );
    addTearDown(container.dispose);
    container.listen(checkoutWizardProvider(kReservationId), (_, _) {});
    return (
      container: container,
      api: api,
      logger: logger,
      network: network,
      session: session,
      reservations: reservationsApi,
    );
  }

  CheckoutWizardState read(ProviderContainer c) =>
      c.read(checkoutWizardProvider(kReservationId));

  CheckoutWizardController notifier(ProviderContainer c) =>
      c.read(checkoutWizardProvider(kReservationId).notifier);

  ApiError conflict(String? code, {String message = 'no'}) => ApiError(
        kind: ApiErrorKind.conflict,
        message: message,
        code: code,
        status: 409,
      );

  group('arranque', () {
    test('by-reservation es la fuente de verdad al entrar y se renderiza el '
        'paso que el servidor reporta', () {
      fakeAsync((async) {
        final h = harness();
        async.flushMicrotasks();
        expect(h.api.byReservationCalls, 1);
        expect(read(h.container).session!.currentStep, 'CONFIRMING');
        expect(read(h.container).position, 1);
        expect(
          h.logger.events
              .where((e) => e.$1 == CheckoutEvents.stepRendered)
              .map((e) => e.$2['step']),
          ['CONFIRMING'],
        );
      });
    });

    test('404 → estado "aún no hay sesión" (crearla es H7) y CERO polling',
        () {
      fakeAsync((async) {
        final h = harness();
        h.api.onByReservation = () async => null;
        h.container.invalidate(checkoutWizardProvider(kReservationId));
        h.container.listen(checkoutWizardProvider(kReservationId), (_, _) {});
        async.flushMicrotasks();
        expect(read(h.container).notFound, isTrue);
        async.elapse(const Duration(minutes: 5));
        expect(h.api.getCalls, 0);
      });
    });

    test('un currentStep DESCONOCIDO se renderiza sin posición y sin crashear',
        () {
      fakeAsync((async) {
        final h = harness();
        h.api.current = sessionAt(
          CheckoutStep.confirming,
          rawStep: 'PASO_DEL_FUTURO',
        );
        h.container.invalidate(checkoutWizardProvider(kReservationId));
        h.container.listen(checkoutWizardProvider(kReservationId), (_, _) {});
        async.flushMicrotasks();
        final state = read(h.container);
        expect(state.session!.currentStep, 'PASO_DEL_FUTURO');
        expect(state.step, isNull);
        expect(state.position, isNull, reason: 'no se inventa un "Paso N"');
        expect(state.isTerminal, isFalse);
        expect(
          h.logger.events.any((e) =>
              e.$1 == CheckoutEvents.stepRendered &&
              e.$2['step'] == 'PASO_DEL_FUTURO'),
          isTrue,
        );
      });
    });

    test('sin sesión de usuario no se consulta nada', () {
      fakeAsync((async) {
        final h = harness(authenticated: false);
        async.flushMicrotasks();
        async.elapse(const Duration(minutes: 5));
        expect(h.api.byReservationCalls, 0);
        expect(h.api.getCalls, 0);
      });
    });

    test('MINOR-3: un background→foreground SIN sesión no dispara un GET real '
        '(el listener de visibilidad se registra antes del gate)', () {
      fakeAsync((async) {
        final h = harness(authenticated: false);
        async.flushMicrotasks();
        h.container.read(appVisibilityProvider.notifier).setVisible(false);
        async.flushMicrotasks();
        h.container.read(appVisibilityProvider.notifier).setVisible(true);
        async.flushMicrotasks();
        expect(h.api.byReservationCalls, 0);
      });
    });

    test('MINOR-3: tampoco con la sede a MEDIO hidratar (saldría sin el '
        'header x-view-location)', () {
      fakeAsync((async) {
        final h = harness(initialLocation: const ActiveLocation.hydrating());
        async.flushMicrotasks();
        h.container.read(appVisibilityProvider.notifier).setVisible(false);
        async.flushMicrotasks();
        h.container.read(appVisibilityProvider.notifier).setVisible(true);
        async.flushMicrotasks();
        expect(h.api.byReservationCalls, 0);
      });
    });
  });

  group('poll', () {
    test('cada 5 s; tras 3 ciclos SIN cambio pasa a 15 s', () {
      fakeAsync((async) {
        final h = harness();
        async.flushMicrotasks();
        expect(h.api.getCalls, 0);

        for (var i = 1; i <= 3; i++) {
          async.elapse(const Duration(seconds: 5));
          async.flushMicrotasks();
          expect(h.api.getCalls, i, reason: 'ciclo $i a 5 s');
        }

        // 3 ciclos sin cambio ⇒ carril lento: a los 5 s NO hay tick…
        async.elapse(const Duration(seconds: 5));
        async.flushMicrotasks();
        expect(h.api.getCalls, 3);
        // …y a los 15 s sí.
        async.elapse(const Duration(seconds: 10));
        async.flushMicrotasks();
        expect(h.api.getCalls, 4);
      });
    });

    test('un cambio del servidor devuelve el poll al carril de 5 s', () {
      fakeAsync((async) {
        final h = harness();
        async.flushMicrotasks();
        for (var i = 0; i < 3; i++) {
          async.elapse(const Duration(seconds: 5));
          async.flushMicrotasks();
        }
        // Carril lento activo; llega un cambio de sello (no de paso).
        h.api.current = sessionAt(
          CheckoutStep.confirming,
          tc: DateTime.utc(2026, 8, 16, 14, 20),
        );
        async.elapse(const Duration(seconds: 15));
        async.flushMicrotasks();
        expect(h.api.getCalls, 4);
        expect(read(h.container).session!.tcCompletedAt, isNotNull);

        // De vuelta a 5 s.
        async.elapse(const Duration(seconds: 5));
        async.flushMicrotasks();
        expect(h.api.getCalls, 5);
      });
    });

    test('pausa TOTAL en background y refresh inmediato al volver', () {
      fakeAsync((async) {
        final h = harness();
        async.flushMicrotasks();

        h.container.read(appVisibilityProvider.notifier).setVisible(false);
        async.flushMicrotasks();
        async.elapse(const Duration(minutes: 3));
        async.flushMicrotasks();
        expect(h.api.getCalls, 0, reason: 'cero ticks en background');

        h.container.read(appVisibilityProvider.notifier).setVisible(true);
        async.flushMicrotasks();
        expect(h.api.getCalls, 1, reason: 'al volver, lectura inmediata');
      });
    });

    test('con request en vuelo el tick se SALTA (no se encima) y el reloj '
        'sigue', () {
      fakeAsync((async) {
        final h = harness();
        async.flushMicrotasks();

        final gate = Completer<void>();
        h.api.gate = gate;
        async.elapse(const Duration(seconds: 5));
        async.flushMicrotasks();
        expect(h.api.getCalls, 1, reason: 'este quedó colgado');

        // Dos ticks más mientras el primero sigue en vuelo: ninguno despacha.
        async.elapse(const Duration(seconds: 10));
        async.flushMicrotasks();
        expect(h.api.getCalls, 1);

        h.api.gate = null;
        gate.complete();
        async.flushMicrotasks();
        async.elapse(const Duration(seconds: 5));
        async.flushMicrotasks();
        expect(h.api.getCalls, 2);
      });
    });

    test('429 en el poll: backoff decorrelacionado + telemetría', () {
      fakeAsync((async) {
        // nextInt = 0 ⇒ el backoff cae en su piso (el carril lento de 15 s):
        // determinismo para poder asertar el reloj.
        final h = harness(random: ScriptedRandom());
        async.flushMicrotasks();
        h.api.onGet = () async => throw ApiError(
              kind: ApiErrorKind.rateLimited,
              message: 'slow down',
              status: 429,
            );
        async.elapse(const Duration(seconds: 5));
        async.flushMicrotasks();
        expect(h.api.getCalls, 1);
        expect(h.logger.has(NetEvents.request429Backoff), isTrue);
        // Ya en backoff: a los 5 s no hay tick, a los 15 s sí.
        h.api.onGet = null;
        async.elapse(const Duration(seconds: 5));
        async.flushMicrotasks();
        expect(h.api.getCalls, 1);
        async.elapse(const Duration(seconds: 10));
        async.flushMicrotasks();
        expect(h.api.getCalls, 2);
      });
    });

    test('el backoff CRECE con 429 sostenidos, con tope (SC-7)', () {
      fakeAsync((async) {
        // nextInt = máximo ⇒ el backoff toma el techo de cada ventana.
        final h = harness(random: ScriptedRandom(intValue: 1 << 30));
        async.flushMicrotasks();
        h.api.onGet = () async => throw ApiError(
              kind: ApiErrorKind.rateLimited,
              message: 'slow down',
              status: 429,
            );
        // 1º 429 (tras el tick base de 5 s): ventana [15 s, 45 s] ⇒ 45 s.
        async.elapse(const Duration(seconds: 5));
        async.flushMicrotasks();
        expect(h.api.getCalls, 1);
        async.elapse(const Duration(seconds: 44));
        async.flushMicrotasks();
        expect(h.api.getCalls, 1, reason: 'el tick es a los 45 s, no antes');
        async.elapse(const Duration(seconds: 1));
        async.flushMicrotasks();
        expect(h.api.getCalls, 2);

        // 2º 429: ventana [15 s, min(135 s, tope 5 min)] ⇒ 135 s.
        async.elapse(const Duration(seconds: 134));
        async.flushMicrotasks();
        expect(h.api.getCalls, 2);
        async.elapse(const Duration(seconds: 1));
        async.flushMicrotasks();
        expect(h.api.getCalls, 3);

        // Y al recuperarse, el poll vuelve al carril de 5 s.
        h.api.onGet = null;
        h.api.current = sessionAt(
          CheckoutStep.tcPending,
          actorUserId: null,
          kiosk: true,
        );
        async.elapse(const Duration(minutes: 5));
        async.flushMicrotasks();
        final calls = h.api.getCalls;
        async.elapse(const Duration(seconds: 5));
        async.flushMicrotasks();
        expect(h.api.getCalls, calls + 1);
      });
    });

    test('MC-3: el POLL pide NO reintentar (el retry por-request amplifica un '
        '429); el re-fetch del AGENTE sí conserva el retry', () {
      fakeAsync((async) {
        final h = harness();
        async.flushMicrotasks();
        expect(h.api.skipRetryFlags, [true], reason: 'arranque automático');

        async.elapse(const Duration(seconds: 5));
        async.flushMicrotasks();
        expect(h.api.skipRetryFlags, [true, true], reason: 'tick del poll');

        unawaited(notifier(h.container).refresh());
        async.flushMicrotasks();
        expect(h.api.skipRetryFlags.last, isFalse,
            reason: 'aquí hay un humano esperando UNA respuesta');
      });
    });

    test('sesión terminal: el poll se detiene (no hay nada que esperar)', () {
      fakeAsync((async) {
        final h = harness();
        h.api.current = sessionAt(CheckoutStep.closed);
        h.container.invalidate(checkoutWizardProvider(kReservationId));
        h.container.listen(checkoutWizardProvider(kReservationId), (_, _) {});
        async.flushMicrotasks();
        expect(read(h.container).isTerminal, isTrue);
        async.elapse(const Duration(minutes: 5));
        expect(h.api.getCalls, 0);
      });
    });
  });

  group('ciclo de vida', () {
    test('MC-1: al soltar el último listener el poller MUERE (autoDispose) — '
        'si no, cada reserva visitada dejaría un poll eterno', () {
      fakeAsync((async) {
        final api = FakeCheckoutApi();
        final container = ProviderContainer(
          overrides: [
            checkoutApiProvider.overrideWithValue(api),
            reservationsApiProvider.overrideWithValue(FakeReservationsApi()),
            eventLoggerProvider.overrideWithValue(CapturingEventLogger()),
            networkStatusProvider
                .overrideWithValue(FakeNetworkStatus(online: true)),
            activeLocationProvider.overrideWith(
              () => StubActiveLocation(const ActiveLocation.all()),
            ),
            sessionControllerProvider.overrideWith(
              () => MutableSessionController(
                SessionState.authenticated(
                  token: liveToken,
                  user: sessionUserFixture(),
                ),
              ),
            ),
            checkoutPollConfigProvider
                .overrideWithValue(CheckoutPollConfig(random: ScriptedRandom())),
          ],
        );
        addTearDown(container.dispose);

        // La pantalla "abre" el wizard…
        final sub = container.listen(
          checkoutWizardProvider(kReservationId),
          (_, _) {},
        );
        async.flushMicrotasks();
        async.elapse(const Duration(seconds: 5));
        async.flushMicrotasks();
        expect(api.getCalls, 1);

        // …y el agente sale del wizard.
        sub.close();
        async.flushMicrotasks();
        final frozen = api.getCalls;
        async.elapse(const Duration(minutes: 5));
        async.flushMicrotasks();
        expect(api.getCalls, frozen,
            reason: 'un Notifier sin autoDispose seguiría re-armando el timer '
                'para siempre: 3 checkouts = ~12 req/min permanentes');
      });
    });
  });

  group('fencing de respuestas (MC-2)', () {
    test('una lectura que aterriza DESPUÉS de la escritura se descarta: el '
        'stepper no retrocede ni se emite steps_jumped negativo', () {
      fakeAsync((async) {
        final h = harness();
        async.flushMicrotasks();

        // Lectura en vuelo, colgada, con el estado VIEJO (CONFIRMING). Se
        // lanza a los 2 s para que la transición de abajo NO dispare el
        // re-fetch previo (<3 s) y el POST salga con la lectura aún viajando:
        // ese es exactamente el solape que el fence tiene que cubrir.
        final gate = Completer<void>();
        h.api.onGet = () async {
          await gate.future;
          return sessionAt(CheckoutStep.confirming);
        };
        async.elapse(const Duration(seconds: 2));
        unawaited(notifier(h.container).refresh());
        async.flushMicrotasks();
        expect(h.api.getCalls, 1);

        // El agente transiciona y el POST responde PRIMERO.
        h.api.onTransition = (_) async => sessionAt(CheckoutStep.tcPending);
        unawaited(notifier(h.container).transitionTo(CheckoutStep.tcPending));
        async.flushMicrotasks();
        expect(read(h.container).session!.currentStep, 'TC_PENDING');

        // Ahora aterriza el GET viejo.
        gate.complete();
        async.flushMicrotasks();

        expect(read(h.container).session!.currentStep, 'TC_PENDING',
            reason: 'la lectura obsoleta NO puede publicar el pasado');
        expect(read(h.container).advance, isNull,
            reason: 'nada de "otra superficie movió el paso" hacia atrás');
        final jumps = h.logger.events
            .where((e) => e.$1 == CheckoutEvents.reconciled)
            .map((e) => e.$2['steps_jumped']);
        expect(jumps.where((j) => j is int && j < 0), isEmpty,
            reason: 'steps_jumped negativo corrompe la métrica del SHIP');
      });
    });

    test('cinturón de stateVersion (P2): una lectura con versión MENOR que la '
        'aplicada se descarta aunque el epoch local coincida', () {
      fakeAsync((async) {
        final h = harness();
        h.api.current = sessionAt(CheckoutStep.tcPending, stateVersion: 7);
        h.container.invalidate(checkoutWizardProvider(kReservationId));
        h.container.listen(checkoutWizardProvider(kReservationId), (_, _) {});
        async.flushMicrotasks();
        expect(read(h.container).session!.currentStep, 'TC_PENDING');

        // Réplica atrasada / respuesta cacheada: versión anterior.
        h.api.current = sessionAt(
          CheckoutStep.confirming,
          stateVersion: 6,
          actorUserId: null,
          kiosk: true,
        );
        async.elapse(const Duration(seconds: 5));
        async.flushMicrotasks();
        expect(read(h.container).session!.currentStep, 'TC_PENDING');
        expect(read(h.container).advance, isNull);

        // Una versión MAYOR sí entra (el fence no congela la sesión).
        h.api.current = sessionAt(
          CheckoutStep.tcSigned,
          stateVersion: 8,
          actorUserId: null,
          kiosk: true,
        );
        async.elapse(const Duration(seconds: 5));
        async.flushMicrotasks();
        expect(read(h.container).session!.currentStep, 'TC_SIGNED');
      });
    });

    test('con backend VIEJO (stateVersion null) el fence local sigue '
        'protegiendo', () {
      fakeAsync((async) {
        final h = harness();
        async.flushMicrotasks();
        expect(read(h.container).session!.stateVersion, isNull);

        final gate = Completer<void>();
        h.api.onGet = () async {
          await gate.future;
          return sessionAt(CheckoutStep.confirming);
        };
        async.elapse(const Duration(seconds: 2));
        unawaited(notifier(h.container).refresh());
        async.flushMicrotasks();

        h.api.onTransition = (_) async => sessionAt(CheckoutStep.tcPending);
        unawaited(notifier(h.container).transitionTo(CheckoutStep.tcPending));
        async.flushMicrotasks();
        gate.complete();
        async.flushMicrotasks();
        expect(read(h.container).session!.currentStep, 'TC_PENDING');
      });
    });

    test('mientras hay una escritura en vuelo, el tick del poll NO despacha',
        () {
      fakeAsync((async) {
        final h = harness();
        async.flushMicrotasks();
        final gate = Completer<void>();
        h.api.onTransition = (_) async {
          await gate.future;
          return sessionAt(CheckoutStep.tcPending);
        };
        unawaited(notifier(h.container).transitionTo(CheckoutStep.tcPending));
        async.flushMicrotasks();
        final before = h.api.getCalls;

        async.elapse(const Duration(seconds: 30));
        async.flushMicrotasks();
        expect(h.api.getCalls, before,
            reason: 'la respuesta del POST es más nueva por definición');

        gate.complete();
        async.flushMicrotasks();
      });
    });

    test('NIT: una lectura DESCARTADA también cuenta como ciclo sin cambio — '
        'si no, un bucle de réplica atrasada se queda a 5 s para siempre', () {
      fakeAsync((async) {
        final h = harness();
        h.api.current = sessionAt(CheckoutStep.tcPending, stateVersion: 9);
        h.container.invalidate(checkoutWizardProvider(kReservationId));
        h.container.listen(checkoutWizardProvider(kReservationId), (_, _) {});
        async.flushMicrotasks();

        // Réplica atrasada permanente: todas las lecturas se descartan.
        h.api.current = sessionAt(CheckoutStep.confirming, stateVersion: 4);
        for (var i = 1; i <= 3; i++) {
          async.elapse(const Duration(seconds: 5));
          async.flushMicrotasks();
          expect(h.api.getCalls, i);
        }
        // Carril lento: a los 5 s ya no hay tick.
        async.elapse(const Duration(seconds: 5));
        async.flushMicrotasks();
        expect(h.api.getCalls, 3);
        async.elapse(const Duration(seconds: 10));
        async.flushMicrotasks();
        expect(h.api.getCalls, 4);
        // Y el estado nunca retrocedió.
        expect(read(h.container).session!.currentStep, 'TC_PENDING');
      });
    });

    test('SC-2: la presencia SOBREVIVE a una respuesta de escritura que no la '
        'trae (los POST no pasan por withPresence)', () {
      fakeAsync((async) {
        final h = harness();
        h.api.current = sessionAt(
          CheckoutStep.confirming,
          presence: [
            CheckoutPresenceDto(
              surface: 'KIOSK',
              displayName: 'María G.',
              lastSeenAt: DateTime.now(),
            ),
          ],
        );
        h.container.invalidate(checkoutWizardProvider(kReservationId));
        h.container.listen(checkoutWizardProvider(kReservationId), (_, _) {});
        async.flushMicrotasks();
        expect(read(h.container).session!.presence, hasLength(1));

        // La respuesta del POST viene SIN el campo.
        h.api.onTransition = (_) async => sessionAt(CheckoutStep.tcPending);
        unawaited(notifier(h.container).transitionTo(CheckoutStep.tcPending));
        async.flushMicrotasks();

        expect(read(h.container).session!.presence, hasLength(1),
            reason: 'borrar el chip justo al escribir es perderlo en el '
                'instante de máxima colisión');
      });
    });
  });

  group('avance ajeno (8C)', () {
    test('el kiosco avanzó: banner con atribución + checkout.reconciled '
        '(via poll)', () {
      fakeAsync((async) {
        final h = harness();
        async.flushMicrotasks();

        h.api.current = sessionAt(
          CheckoutStep.tcPending,
          actorUserId: null,
          kiosk: true,
        );
        async.elapse(const Duration(seconds: 5));
        async.flushMicrotasks();

        final advance = read(h.container).advance!;
        expect(advance.completedStep, 'CONFIRMING');
        expect(advance.currentStep, 'TC_PENDING');
        expect(advance.actor, CheckoutActorKind.kiosk);

        final reconciled = h.logger.events
            .where((e) => e.$1 == CheckoutEvents.reconciled)
            .toList();
        expect(reconciled, hasLength(1), reason: 'un movimiento, un evento');
        expect(reconciled.single.$2['via'], 'poll');
        expect(reconciled.single.$2['steps_jumped'], 1);
      });
    });

    test('otro AGENTE avanzó: se atribuye a persona, no al kiosco', () {
      fakeAsync((async) {
        final h = harness();
        async.flushMicrotasks();
        h.api.current =
            sessionAt(CheckoutStep.tcPending, actorUserId: 'otro-usuario');
        async.elapse(const Duration(seconds: 5));
        async.flushMicrotasks();
        expect(
          read(h.container).advance!.actor,
          CheckoutActorKind.otherAgent,
        );
      });
    });

    test('si el avance fue MÍO no hay banner (el stepper se mueve y ya)', () {
      fakeAsync((async) {
        final h = harness();
        async.flushMicrotasks();
        h.api.current = sessionAt(CheckoutStep.tcPending); // actor = yo
        async.elapse(const Duration(seconds: 5));
        async.flushMicrotasks();
        expect(read(h.container).session!.currentStep, 'TC_PENDING');
        expect(read(h.container).advance, isNull);
        expect(h.logger.has(CheckoutEvents.reconciled), isFalse);
      });
    });
  });

  group('transición', () {
    test('éxito: POST + re-render + checkout.transition_ok', () {
      fakeAsync((async) {
        final h = harness();
        async.flushMicrotasks();
        h.api.onTransition = (_) async => sessionAt(CheckoutStep.tcPending);

        CheckoutTransitionOutcome? outcome;
        unawaited(notifier(h.container)
            .transitionTo(CheckoutStep.tcPending)
            .then((o) => outcome = o));
        async.flushMicrotasks();

        expect(outcome, CheckoutTransitionOutcome.ok);
        expect(h.api.transitions, ['TC_PENDING']);
        expect(read(h.container).session!.currentStep, 'TC_PENDING');
        expect(h.logger.has(CheckoutEvents.transitionOk), isTrue);
        expect(read(h.container).transitionInFlight, isFalse);
      });
    });

    test('ANTI-DOBLE-TAP: el segundo tap con uno en vuelo no manda otro POST',
        () {
      fakeAsync((async) {
        final h = harness();
        async.flushMicrotasks();
        final gate = Completer<void>();
        h.api.gate = gate;
        h.api.onTransition = (_) async {
          await gate.future;
          return sessionAt(CheckoutStep.tcPending);
        };

        final first =
            notifier(h.container).transitionTo(CheckoutStep.tcPending);
        async.flushMicrotasks();
        expect(read(h.container).transitionInFlight, isTrue);

        CheckoutTransitionOutcome? second;
        unawaited(notifier(h.container)
            .transitionTo(CheckoutStep.tcPending)
            .then((o) => second = o));
        async.flushMicrotasks();
        expect(second, CheckoutTransitionOutcome.blocked);
        expect(h.api.transitionCalls, 1);

        gate.complete();
        unawaited(first);
        async.flushMicrotasks();
        expect(h.api.transitionCalls, 1);
      });
    });

    test('re-fetch previo cuando la lectura tiene >3 s (nota 7)', () {
      fakeAsync((async) {
        final h = harness();
        async.flushMicrotasks();
        h.api.onTransition = (_) async => sessionAt(CheckoutStep.tcPending);

        async.elapse(const Duration(seconds: 4)); // lectura envejecida
        unawaited(notifier(h.container).transitionTo(CheckoutStep.tcPending));
        async.flushMicrotasks();

        expect(h.api.getCalls, greaterThanOrEqualTo(1),
            reason: 'se re-consultó ANTES de escribir');
        expect(h.api.transitionCalls, 1);
      });
    });

    test('lectura fresca (<3 s): NO se re-consulta antes del POST', () {
      fakeAsync((async) {
        final h = harness();
        async.flushMicrotasks();
        h.api.onTransition = (_) async => sessionAt(CheckoutStep.tcPending);

        async.elapse(const Duration(seconds: 1));
        unawaited(notifier(h.container).transitionTo(CheckoutStep.tcPending));
        async.flushMicrotasks();
        expect(h.api.getCalls, 0);
        expect(h.api.transitionCalls, 1);
      });
    });

    test('el re-fetch previo ve que el servidor ya se movió: se ABORTA el '
        'POST y se reconcilia', () {
      fakeAsync((async) {
        final h = harness();
        async.flushMicrotasks();
        // Mientras el agente decidía, el kiosco firmó T&C y pasó a TC_PENDING.
        h.api.current = sessionAt(
          CheckoutStep.tcPending,
          actorUserId: null,
          kiosk: true,
        );

        async.elapse(const Duration(seconds: 4));
        CheckoutTransitionOutcome? outcome;
        unawaited(notifier(h.container)
            .transitionTo(CheckoutStep.tcPending)
            .then((o) => outcome = o));
        async.flushMicrotasks();

        expect(h.api.transitionCalls, 0, reason: 'no se escribe sobre humo');
        expect(outcome, CheckoutTransitionOutcome.alreadyDone);
        expect(read(h.container).session!.currentStep, 'TC_PENDING');
        expect(read(h.container).advance, isNotNull);
        // SC-4: esta reconciliación NO vino de un 409 y no debe contarse como
        // tal — mezclarlas mentiría sobre cuántas colisiones reales hay.
        expect(
          h.logger.events
              .where((e) => e.$1 == CheckoutEvents.reconciled)
              .map((e) => e.$2['via']),
          ['preflight'],
        );
        expect(h.logger.has(CheckoutEvents.transition409), isFalse);
      });
    });

    test('sin red la transición se BLOQUEA antes de salir (ADR-5: no se '
        'encola)', () {
      fakeAsync((async) {
        // Se entra con red (la sesión carga) y la red se cae después: es el
        // escenario del patio, y además el único honesto — una lectura que
        // RESPONDE prueba que hay red, diga lo que diga el plugin.
        final h = harness();
        async.flushMicrotasks();
        h.api.onGet = () async =>
            throw ApiError(kind: ApiErrorKind.network, message: 'sin red');
        async.elapse(const Duration(seconds: 5));
        async.flushMicrotasks();

        expect(read(h.container).offline, isTrue);
        expect(read(h.container).canTransition, isFalse);

        CheckoutTransitionOutcome? outcome;
        unawaited(notifier(h.container)
            .transitionTo(CheckoutStep.tcPending)
            .then((o) => outcome = o));
        async.flushMicrotasks();
        expect(outcome, CheckoutTransitionOutcome.blocked);
        expect(h.api.transitionCalls, 0);
      });
    });
  });

  group('matriz 409', () {
    /// Escenario común: el POST truena con [error] y el re-fetch devuelve
    /// [after].
    ({
      ProviderContainer container,
      FakeCheckoutApi api,
      CapturingEventLogger logger,
    }) conflictHarness(
      FakeAsync async,
      ApiError error, {
      required CheckoutSessionDto after,
    }) {
      final h = harness();
      async.flushMicrotasks();
      h.api.onTransition = (_) async => throw error;
      h.api.current = after;
      return (container: h.container, api: h.api, logger: h.logger);
    }

    test('ILLEGAL_TRANSITION con el destino YA hecho ⇒ no-op silencioso', () {
      fakeAsync((async) {
        final h = conflictHarness(
          async,
          conflict('ILLEGAL_TRANSITION'),
          after: sessionAt(
            CheckoutStep.paymentPending,
            actorUserId: null,
            kiosk: true,
          ),
        );
        CheckoutTransitionOutcome? outcome;
        unawaited(notifier(h.container)
            .transitionTo(CheckoutStep.tcPending)
            .then((o) => outcome = o));
        async.flushMicrotasks();

        expect(outcome, CheckoutTransitionOutcome.alreadyDone);
        expect(read(h.container).conflict, isNull,
            reason: 'no se le muestra un error que no puede resolver');
        expect(read(h.container).session!.currentStep, 'PAYMENT_PENDING');
        expect(
          h.logger.events.any((e) =>
              e.$1 == CheckoutEvents.transition409 &&
              e.$2['code'] == 'ILLEGAL_TRANSITION'),
          isTrue,
        );
        // MAJOR-1: se asierta el CONTEO, no `.any(...)`. Un 409 movió la
        // sesión UNA vez; emitirlo dos veces (lo hacía: `_refetchQuiet` y
        // luego `_resolveConflict`) duplica la frecuencia de `via:conflict` y
        // `steps_jumped`, que es justo la métrica con la que el épico mide
        // cuánto se pisan las superficies.
        final reconciled = h.logger.events
            .where((e) => e.$1 == CheckoutEvents.reconciled)
            .toList();
        expect(reconciled, hasLength(1));
        expect(reconciled.single.$2['via'], 'conflict');
        expect(reconciled.single.$2['steps_jumped'], 3);
      });
    });

    test(
        'M2-H6 · ILLEGAL_TRANSITION sin haber llegado al destino ⇒ '
        '`tooEarly` con los dos pasos, no el cartel genérico', () {
      fakeAsync((async) {
        final h = conflictHarness(
          async,
          conflict('ILLEGAL_TRANSITION', message: 'Illegal transition'),
          after: sessionAt(CheckoutStep.confirming),
        );
        CheckoutTransitionOutcome? outcome;
        unawaited(notifier(h.container)
            .transitionTo(CheckoutStep.paid)
            .then((o) => outcome = o));
        async.flushMicrotasks();
        expect(outcome, CheckoutTransitionOutcome.conflict);
        final c = read(h.container).conflict!;
        // El MISMO code que "ya lo hicieron", la situación opuesta: tras
        // reconciliar la sesión sigue ANTES del destino. Hasta H6 esto caía en
        // `generic`, que dejaba al agente con un cartel sin salida.
        expect(c.kind, CheckoutConflictKind.tooEarly);
        // Y con los dos pasos, que es lo que permite nombrar el callejón
        // ("estás en el 1, el cobro es el 5") y ofrecer NAVEGACIÓN — la única
        // acción que aquí puede tener éxito.
        expect(c.attemptedStep, CheckoutStep.paid);
        expect(c.currentStep, CheckoutStep.confirming);
        // El mensaje del servidor se enmarca, no se sustituye (DoD #5).
        expect(c.message, 'Illegal transition');
      });
    });

    test('ENTRY_GUARD ⇒ se nombra QUÉ falta', () {
      fakeAsync((async) {
        final h = conflictHarness(
          async,
          conflict('ENTRY_GUARD',
              message: 'Cannot enter TC_SIGNED: tcCompletedAt is not stamped yet'),
          after: sessionAt(CheckoutStep.tcPending),
        );
        unawaited(notifier(h.container).transitionTo(CheckoutStep.tcSigned));
        async.flushMicrotasks();
        final c = read(h.container).conflict!;
        expect(c.kind, CheckoutConflictKind.entryGuard);
        expect(c.guard, CheckoutEntryGuard.tcCompleted);
        expect(c.message, contains('tcCompletedAt'));
      });
    });

    test('SESSION_TERMINAL y CHECKOUT_TERMINAL ⇒ estado terminal', () {
      for (final code in ['SESSION_TERMINAL', 'CHECKOUT_TERMINAL']) {
        fakeAsync((async) {
          final h = conflictHarness(
            async,
            conflict(code, message: 'Checkout is already closed'),
            after: sessionAt(CheckoutStep.closed),
          );
          unawaited(notifier(h.container).transitionTo(CheckoutStep.tcPending));
          async.flushMicrotasks();
          expect(read(h.container).conflict!.kind,
              CheckoutConflictKind.terminal,
              reason: code);
          expect(read(h.container).isTerminal, isTrue, reason: code);
        });
      }
    });

    test('VEHICLE_CONFLICT ⇒ gancho con el mensaje del servidor (el swap es '
        'H2)', () {
      fakeAsync((async) {
        final h = conflictHarness(
          async,
          conflict('VEHICLE_CONFLICT', message: 'Vehicle is on another rental'),
          after: sessionAt(CheckoutStep.confirming),
        );
        unawaited(notifier(h.container).transitionTo(CheckoutStep.tcPending));
        async.flushMicrotasks();
        final c = read(h.container).conflict!;
        expect(c.kind, CheckoutConflictKind.vehicleConflict);
        expect(c.message, 'Vehicle is on another rental');
      });
    });

    test('409 SIN code (el del abandon terminal) ⇒ genérico con el copy del '
        'servidor, jamás inventado', () {
      fakeAsync((async) {
        final h = conflictHarness(
          async,
          conflict(null, message: 'Session is already terminal'),
          after: sessionAt(CheckoutStep.confirming),
        );
        unawaited(notifier(h.container).transitionTo(CheckoutStep.tcPending));
        async.flushMicrotasks();
        expect(read(h.container).conflict!.kind, CheckoutConflictKind.generic);
        expect(
          h.logger.events.any((e) =>
              e.$1 == CheckoutEvents.transition409 && e.$2['code'] == 'none'),
          isTrue,
        );
      });
    });

    test('el re-fetch de reconciliación que falla NO tapa el 409', () {
      fakeAsync((async) {
        final h = harness();
        async.flushMicrotasks();
        h.api.onTransition = (_) async => throw conflict('ENTRY_GUARD');
        h.api.onGet = () async =>
            throw ApiError(kind: ApiErrorKind.network, message: 'sin red');
        unawaited(notifier(h.container).transitionTo(CheckoutStep.tcSigned));
        async.flushMicrotasks();
        expect(read(h.container).conflict!.kind, CheckoutConflictKind.entryGuard);
      });
    });
  });

  group('higiene de la instrumentación (MAJOR-1)', () {
    test('un poll que ve el MISMO movimiento dos veces no lo cuenta dos veces',
        () {
      fakeAsync((async) {
        final h = harness();
        async.flushMicrotasks();
        // El kiosco avanza…
        h.api.current = sessionAt(
          CheckoutStep.tcPending,
          actorUserId: null,
          kiosk: true,
        );
        async.elapse(const Duration(seconds: 5));
        async.flushMicrotasks();
        // …y el agente fuerza un refresh que devuelve lo MISMO.
        unawaited(notifier(h.container).refresh());
        async.flushMicrotasks();
        expect(
          h.logger.events.where((e) => e.$1 == CheckoutEvents.reconciled),
          hasLength(1),
        );
      });
    });

    test('dos movimientos DISTINTOS sí son dos eventos (el dedup no se come '
        'el segundo)', () {
      fakeAsync((async) {
        final h = harness();
        async.flushMicrotasks();
        h.api.current = sessionAt(
          CheckoutStep.tcPending,
          actorUserId: null,
          kiosk: true,
        );
        async.elapse(const Duration(seconds: 5));
        async.flushMicrotasks();
        h.api.current = sessionAt(
          CheckoutStep.tcSigned,
          actorUserId: null,
          kiosk: true,
        );
        async.elapse(const Duration(seconds: 5));
        async.flushMicrotasks();
        final reconciled = h.logger.events
            .where((e) => e.$1 == CheckoutEvents.reconciled)
            .toList();
        expect(reconciled, hasLength(2));
        expect(reconciled.map((e) => e.$2['steps_jumped']), [1, 1]);
      });
    });

    test('un 409 que encuentra la sesión donde YA estaba no inventa una '
        'reconciliación', () {
      fakeAsync((async) {
        final h = harness();
        async.flushMicrotasks();
        h.api.onTransition = (_) async => throw conflict('ILLEGAL_TRANSITION');
        // El servidor sigue en CONFIRMING: nada se movió.
        unawaited(notifier(h.container).transitionTo(CheckoutStep.confirming));
        async.flushMicrotasks();
        expect(h.logger.has(CheckoutEvents.reconciled), isFalse);
      });
    });
  });

  group('pausar (abandon)', () {
    test('éxito: se sella abandonedAt y el paso NO cambia', () {
      fakeAsync((async) {
        final h = harness();
        async.flushMicrotasks();
        final paused = sessionAt(CheckoutStep.confirming);
        h.api.onAbandon = () async => CheckoutSessionDto.fromJson({
              ...rawCheckoutSession(),
              'currentStep': 'CONFIRMING',
              'abandonedAt': '2026-08-16T14:30:00.000Z',
              'abandonedReason': 'agent_paused',
              'events': paused.events,
            });

        bool? ok;
        unawaited(notifier(h.container).pause().then((v) => ok = v));
        async.flushMicrotasks();
        expect(ok, isTrue);
        expect(h.api.abandonCalls, 1);
        expect(read(h.container).session!.abandonedAt, isNotNull);
        expect(read(h.container).session!.currentStep, 'CONFIRMING');
      });
    });

    test('fallo (409 terminal / sin red): se reporta, no se simula pausa', () {
      fakeAsync((async) {
        final h = harness();
        async.flushMicrotasks();
        h.api.onAbandon = () async => throw conflict(
              null,
              message: 'Session is already terminal',
            );
        bool? ok;
        unawaited(notifier(h.container).pause().then((v) => ok = v));
        async.flushMicrotasks();
        expect(ok, isFalse);
        expect(read(h.container).error!.message, 'Session is already terminal');
        expect(read(h.container).pausing, isFalse);
      });
    });
  });

  group('negativas del servidor', () {
    test('403 de view-location: se clasifica como NEGATIVA de sede, no como '
        '"no hay datos"', () {
      fakeAsync((async) {
        final h = harness(
          initialLocation: const ActiveLocation.pinned(
            locationId: 'loc-1',
            locationName: 'Patio Centro',
          ),
        );
        h.api.onByReservation = () async => throw ApiError(
              kind: ApiErrorKind.forbidden,
              message: ApiError.viewLocationDeniedMessage,
              status: 403,
            );
        h.container.invalidate(checkoutWizardProvider(kReservationId));
        h.container.listen(checkoutWizardProvider(kReservationId), (_, _) {});
        async.flushMicrotasks();
        expect(read(h.container).viewLocationDenied, isTrue);
      });
    });

    test('403 de RBAC/módulo: NO monta la pantalla de sede — cae al error con '
        'el copy del servidor (RBAC real es del backend, DoD-4)', () {
      fakeAsync((async) {
        final h = harness(
          initialLocation: const ActiveLocation.pinned(
            locationId: 'loc-1',
            locationName: 'Patio Centro',
          ),
        );
        h.api.onByReservation = () async => throw ApiError(
              kind: ApiErrorKind.forbidden,
              message: 'Module reservations is not enabled for this account.',
              status: 403,
            );
        h.container.invalidate(checkoutWizardProvider(kReservationId));
        h.container.listen(checkoutWizardProvider(kReservationId), (_, _) {});
        async.flushMicrotasks();
        expect(read(h.container).viewLocationDenied, isFalse);
        expect(
          read(h.container).error!.message,
          'Module reservations is not enabled for this account.',
        );
      });
    });
  });

  group('offline honesto (8D)', () {
    test('un error de red NO borra el dato: se queda con su edad', () {
      fakeAsync((async) {
        final h = harness();
        async.flushMicrotasks();
        h.api.onGet = () async =>
            throw ApiError(kind: ApiErrorKind.network, message: 'sin red');
        async.elapse(const Duration(seconds: 5));
        async.flushMicrotasks();

        final state = read(h.container);
        expect(state.session, isNotNull, reason: 'se muestra, no se borra');
        expect(state.offline, isTrue);
        expect(state.fetchedAt, isNotNull);
        expect(state.canTransition, isFalse);
      });
    });

    test('al reconectar se re-consulta solo', () {
      fakeAsync((async) {
        final h = harness(online: false);
        async.flushMicrotasks();
        final before = h.api.getCalls;
        h.network.online = true;
        h.network.reconnects.add(null);
        async.flushMicrotasks();
        expect(h.api.getCalls, before + 1);
        expect(read(h.container).offline, isFalse);
      });
    });
  });

  // ── veredicto de display-data (hallazgo e2e, MAJOR) ────────────────────
  //
  // `_loadContext` se tragaba TODO fallo con `catch (_) { return null; }` y el
  // comentario "el header muestra menos, nada más". No era verdad: ese null
  // bajaba al paso 1 como "faltan el nombre, la licencia y el teléfono" y
  // bloqueaba la entrega acusando al servidor de algo que nadie comprobó.
  group('veredicto del contexto', () {
    test('display-data que responde ⇒ answered, con SELLO de frescura y sin '
        'negativa que citar', () {
      fakeAsync((async) {
        final h = harness();
        async.flushMicrotasks();
        expect(read(h.container).contextVerdict, ContextVerdict.answered);
        expect(read(h.container).contextError, isNull);
        // El sello es propio del DATO DEL CLIENTE: `fetchedAt` mide la sesión
        // y las dos consultas se caen por separado.
        expect(read(h.container).contextFetchedAt, isNotNull);
        expect(h.logger.has(CheckoutEvents.contextUnreachable), isFalse);
      });
    });

    test('404 sin respuesta previa ⇒ unreachable + negativa CRUDA guardada, y '
        'el evento la cuenta como NO stale (el paso 1 se quedó sin verificar)',
        () {
      fakeAsync((async) {
        final reservations = FakeReservationsApi()
          ..failWith = displayDataDenial();
        final h = harness(reservations: reservations);
        async.flushMicrotasks();

        final state = read(h.container);
        expect(state.contextVerdict, ContextVerdict.unreachable);
        expect(state.context, isNull);
        expect(state.contextError!.status, 404);
        expect(state.contextError!.message, 'Reservation not found');
        // Y la sesión SIGUE viva: el wizard no se cae por esto — lo que cambia
        // es lo que el paso 1 puede afirmar.
        expect(state.session, isNotNull);
        expect(read(h.container).contextFetchedAt, isNull,
            reason: 'no hubo lectura buena que sellar');
        expect(
          h.logger.events
              .where((e) => e.$1 == CheckoutEvents.contextUnreachable)
              .map((e) => (e.$2['status'], e.$2['stale'], e.$2['via'])),
          [('404', false, 'open')],
        );
      });
    });

    test('un fallo DESPUÉS de una lectura buena NO borra el dato, pero deja de '
        'llamarlo fresco: cae a STALE con su sello viejo intacto (regla 8D)',
        () {
      fakeAsync((async) {
        final reservations = FakeReservationsApi();
        final h = harness(reservations: reservations);
        async.flushMicrotasks();
        expect(read(h.container).context?.customerName, isNotNull);
        final sealed = read(h.container).contextFetchedAt;

        // El servidor se cae entre la primera lectura y la siguiente.
        reservations.failWith = displayDataDenial(status: 500);
        unawaited(notifier(h.container).retryContext());
        async.flushMicrotasks();

        final state = read(h.container);
        expect(
          state.contextVerdict,
          ContextVerdict.stale,
          reason: 'answered afirmaría que esto se acaba de comprobar',
        );
        expect(state.context?.customerName, isNotNull,
            reason: 'el dato viejo NO se borra');
        expect(
          state.contextFetchedAt,
          sealed,
          reason: 'la edad se cuenta desde la última consulta que SÍ llegó',
        );
        expect(
          state.contextError,
          isNull,
          reason: 'con datos utilizables en pantalla no se cita un 500 al '
              'lado del nombre del cliente',
        );
        // Pero el incidente SÍ se cuenta, marcado como stale: es de otra
        // gravedad, no de otra existencia.
        expect(
          h.logger.events
              .where((e) => e.$1 == CheckoutEvents.contextUnreachable)
              .map((e) => (e.$2['stale'], e.$2['via'])),
          [(true, 'confirm_retry')],
        );
      });
    });

    test('la verificación del CIERRE que no llega se cuenta con SU origen: '
        'no es el paso 1 quedándose sin poder confirmar identidad', () {
      fakeAsync((async) {
        final reservations = FakeReservationsApi();
        final h = harness(reservations: reservations);
        async.flushMicrotasks();

        reservations.failWith = displayDataDenial(status: 503);
        unawaited(notifier(h.container).verifyHandover());
        async.flushMicrotasks();

        expect(
          h.logger.events
              .where((e) => e.$1 == CheckoutEvents.contextUnreachable)
              .map((e) => e.$2['via']),
          ['verify_handover'],
          reason: 'sin el tag, el evento mezcla dos incidentes distintos',
        );
      });
    });

    test('retryContext devuelve el veredicto que quedó — es lo que la pantalla '
        'necesita para contar el resultado sin releer el estado a ciegas', () {
      fakeAsync((async) {
        final reservations = FakeReservationsApi()
          ..failWith = displayDataDenial();
        final h = harness(reservations: reservations);
        async.flushMicrotasks();
        expect(read(h.container).contextVerdict, ContextVerdict.unreachable);

        ContextVerdict? out;
        reservations.failWith = null;
        unawaited(notifier(h.container).retryContext().then((v) => out = v));
        async.flushMicrotasks();

        expect(out, ContextVerdict.answered);
        expect(read(h.container).contextError, isNull);
        expect(read(h.container).context?.customerName, isNotNull);
      });
    });
  });
}
