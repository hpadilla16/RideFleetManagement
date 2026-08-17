import 'dart:async';

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
  }) harness({
    ActiveLocation initialLocation = const ActiveLocation.all(),
    bool authenticated = true,
    bool online = true,
  }) {
    final api = FakeCheckoutApi();
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
        reservationsApiProvider.overrideWithValue(FakeReservationsApi()),
        eventLoggerProvider.overrideWithValue(logger),
        networkStatusProvider.overrideWithValue(network),
        activeLocationProvider.overrideWith(
          () => StubActiveLocation(initialLocation),
        ),
        sessionControllerProvider.overrideWith(() => session),
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

    test('429 en el poll: carril lento + telemetría de backoff', () {
      fakeAsync((async) {
        final h = harness();
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
        // Ya en carril lento: a los 5 s no hay tick, a los 15 s sí.
        h.api.onGet = null;
        async.elapse(const Duration(seconds: 5));
        async.flushMicrotasks();
        expect(h.api.getCalls, 1);
        async.elapse(const Duration(seconds: 10));
        async.flushMicrotasks();
        expect(h.api.getCalls, 2);
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
            .firstWhere((e) => e.$1 == CheckoutEvents.reconciled);
        expect(reconciled.$2['via'], 'poll');
        expect(reconciled.$2['steps_jumped'], 1);
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
        expect(
          h.logger.events
              .where((e) => e.$1 == CheckoutEvents.reconciled)
              .any((e) => e.$2['via'] == 'conflict'),
          isTrue,
        );
      });
    });

    test('ILLEGAL_TRANSITION sin haber llegado al destino ⇒ negativa visible',
        () {
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
        expect(read(h.container).conflict!.kind, CheckoutConflictKind.generic);
        expect(read(h.container).conflict!.message, 'Illegal transition');
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
}
