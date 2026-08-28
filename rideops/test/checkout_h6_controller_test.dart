import 'dart:async';
import 'dart:convert';

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
import 'package:rideops/features/checkout/domain/checkout_changes.dart';
import 'package:rideops/features/checkout/domain/checkout_event_log.dart';

import 'helpers/auth_test_helpers.dart';
import 'helpers/checkout_test_helpers.dart';
import 'helpers/outbox_test_helpers.dart';
import 'helpers/shell_test_helpers.dart';

/// M2-H6 en el controller: el LATIDO, el 200 que no movimos nosotros (H8), el
/// sello que cae sin mover el paso, y las dos caras del mismo 409.
///
/// ADR-4 sigue mandando en todo el archivo: la app no decide pasos, no
/// reintenta a ciegas y no reproduce nada sellado. Lo que H6 agrega es
/// **contarlo**.

void main() {
  final liveToken = fakeJwt(
    exp: DateTime.now().add(const Duration(hours: 8)),
    sub: kMyUserId,
  );

  ({
    ProviderContainer container,
    FakeCheckoutApi api,
    CapturingEventLogger logger,
    MutableSessionController session,
  }) harness({bool authenticated = true, String? myUserId = kMyUserId}) {
    final api = FakeCheckoutApi();
    final logger = CapturingEventLogger();
    final session = MutableSessionController(
      authenticated
          ? SessionState.authenticated(
              token: liveToken,
              // `user: null` es la sesión degradada sin /me — con ella la app
              // NUNCA puede afirmar "esto lo hiciste tú".
              user: myUserId == null ? null : sessionUserFixture(),
            )
          : const SessionState.unauthenticated(),
    );
    final container = ProviderContainer(
      overrides: [
        checkoutApiProvider.overrideWithValue(api),
        reservationsApiProvider.overrideWithValue(FakeReservationsApi()),
        eventLoggerProvider.overrideWithValue(logger),
        networkStatusProvider.overrideWithValue(FakeNetworkStatus()),
        activeLocationProvider.overrideWith(
          () => StubActiveLocation(const ActiveLocation.all()),
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
      session: session,
    );
  }

  CheckoutWizardState read(ProviderContainer c) =>
      c.read(checkoutWizardProvider(kReservationId));

  CheckoutWizardController notifier(ProviderContainer c) =>
      c.read(checkoutWizardProvider(kReservationId).notifier);

  /// Sesión cuyo ÚLTIMO `TRANSITION` hacia [to] lo firma otra superficie —
  /// exactamente la forma de la respuesta idempotente de M2-H8, que a
  /// propósito NO añade evento propio.
  CheckoutSessionDto movedByOther(
    CheckoutStep to, {
    bool kiosk = false,
    String? actorUserId,
  }) {
    final raw = rawCheckoutSession();
    raw['currentStep'] = to.wire;
    raw['events'] = json.encode([
      {
        'kind': 'TRANSITION',
        'from': 'CONFIRMING',
        'to': to.wire,
        'actorUserId': actorUserId,
        'metadata': kiosk ? {'kiosk': true} : null,
        'at': '2026-08-28T10:27:00.000Z',
      },
    ]);
    return sessionFromRaw(raw);
  }

  group('§20 · el latido: RideOps deja de ser solo observador', () {
    test('viaja colgado del poll que YA existe — sin temporizador propio — y '
        'manda RIDEOPS sin label', () {
      fakeAsync((async) {
        final h = harness();
        async.flushMicrotasks();
        expect(h.api.presenceCalls, 1, reason: 'late con la primera lectura');
        expect(h.api.presenceSurfaces, ['RIDEOPS']);

        async.elapse(const Duration(seconds: 5));
        async.flushMicrotasks();
        // Un latido por lectura: si hubiera un reloj propio de 20 s, este
        // número no seguiría al de los GET.
        expect(h.api.presenceCalls, h.api.byReservationCalls + h.api.getCalls);
      });
    });

    test('NO late en background: el latido afirma "estoy mirando esto", y un '
        'teléfono en el bolsillo no está mirando nada', () {
      fakeAsync((async) {
        final h = harness();
        async.flushMicrotasks();
        final before = h.api.presenceCalls;

        h.container.read(appVisibilityProvider.notifier).state = false;
        async.elapse(const Duration(minutes: 2));
        async.flushMicrotasks();

        expect(h.api.presenceCalls, before,
            reason: 'el poll se pausa y el latido con él');
      });
    });

    test('el guard de visibilidad es SUYO, no un efecto de la pausa del poll: '
        'una ESCRITURA que aterriza con el teléfono ya en el bolsillo tampoco '
        'late', () {
      fakeAsync((async) {
        final h = harness();
        async.flushMicrotasks();

        // El agente toca "continuar" y guarda el teléfono antes de que el POST
        // responda. `_apply` de la respuesta corre igual — y ahí el guard del
        // latido es lo ÚNICO que impide anunciar "estoy mirando esto" desde un
        // bolsillo. (Sin este caso, el test de arriba pasaría aunque el guard
        // no existiera: la pausa del poll ya lo enmascara.)
        final gate = Completer<void>();
        h.api.onTransition = (_) async {
          await gate.future;
          return sessionAt(CheckoutStep.tcPending);
        };
        unawaited(notifier(h.container).transitionTo(CheckoutStep.tcPending));
        async.flushMicrotasks();

        final before = h.api.presenceCalls;
        h.container.read(appVisibilityProvider.notifier).state = false;
        gate.complete();
        async.flushMicrotasks();

        expect(read(h.container).session!.currentStep, 'TC_PENDING',
            reason: 'la escritura SÍ se aplicó: es lo que hace real el caso');
        expect(h.api.presenceCalls, before);
      });
    });

    test('su fallo no puede tocar la pantalla: la presencia es informativa y '
        'no bloquea nada (regla dura del módulo)', () {
      fakeAsync((async) {
        final h = harness();
        h.api.presenceFails = true;
        h.container.invalidate(checkoutWizardProvider(kReservationId));
        h.container.listen(checkoutWizardProvider(kReservationId), (_, _) {});
        async.flushMicrotasks();
        async.elapse(const Duration(seconds: 10));
        async.flushMicrotasks();

        final state = read(h.container);
        expect(state.error, isNull);
        expect(state.session, isNotNull);
        expect(h.api.presenceCalls, greaterThan(1),
            reason: 'y el poll siguió vivo detrás');
      });
    });
  });

  group('§21 · el 200 que NO movimos nosotros (M2-H8 idempotente)', () {
    test('otra superficie ya lo había hecho ⇒ banner de avance ajeno + '
        'transition_noop, no un "lo hiciste tú" silencioso', () {
      fakeAsync((async) {
        final h = harness();
        async.flushMicrotasks();
        // El backend responde 200 con el paso ya movido y el evento firmado
        // por el kiosco (H8 no añade evento propio, a propósito).
        h.api.onTransition = (_) async => movedByOther(
              CheckoutStep.tcPending,
              kiosk: true,
            );
        unawaited(notifier(h.container).transitionTo(CheckoutStep.tcPending));
        async.flushMicrotasks();

        final advance = read(h.container).advance;
        expect(advance, isNotNull,
            reason: 'sin esto H8 dejó un agujero silencioso en la atribución');
        expect(advance!.actor, CheckoutActorKind.kiosk);
        expect(advance.kind, ForeignAdvanceKind.stepMoved);
        expect(
          h.logger.events.where((e) => e.$1 == CheckoutEvents.transitionNoop),
          hasLength(1),
        );
        // Y la señal de concurrencia se conserva, con su propio `via`.
        expect(
          h.logger.events
              .where((e) => e.$1 == CheckoutEvents.reconciled)
              .map((e) => e.$2['via']),
          contains('noop'),
        );
      });
    });

    test('nuestro propio avance NO se marca como ajeno ni emite noop', () {
      fakeAsync((async) {
        final h = harness();
        async.flushMicrotasks();
        h.api.onTransition = (_) async =>
            movedByOther(CheckoutStep.tcPending, actorUserId: kMyUserId);
        unawaited(notifier(h.container).transitionTo(CheckoutStep.tcPending));
        async.flushMicrotasks();

        expect(read(h.container).advance, isNull);
        expect(
          h.logger.events.where((e) => e.$1 == CheckoutEvents.transitionNoop),
          isEmpty,
        );
      });
    });

    test('SIN myUserId (sesión degradada) se calla: marcar todo como ajeno '
        'sería decirle al agente que otro hizo su propio trabajo', () {
      fakeAsync((async) {
        final h = harness(myUserId: null);
        async.flushMicrotasks();
        h.api.onTransition = (_) async =>
            movedByOther(CheckoutStep.tcPending, actorUserId: 'u-99');
        unawaited(notifier(h.container).transitionTo(CheckoutStep.tcPending));
        async.flushMicrotasks();

        expect(
          h.logger.events.where((e) => e.$1 == CheckoutEvents.transitionNoop),
          isEmpty,
        );
      });
    });

    test('sin evento en el log no hay prueba de que fuera otro ⇒ se calla', () {
      fakeAsync((async) {
        final h = harness();
        async.flushMicrotasks();
        final raw = rawCheckoutSession();
        raw['currentStep'] = 'TC_PENDING';
        raw['events'] = null;
        h.api.onTransition = (_) async => sessionFromRaw(raw);
        unawaited(notifier(h.container).transitionTo(CheckoutStep.tcPending));
        async.flushMicrotasks();

        expect(
          h.logger.events.where((e) => e.$1 == CheckoutEvents.transitionNoop),
          isEmpty,
        );
      });
    });
  });

  group('§21C · el sello que cae SIN que el paso se mueva', () {
    test('el mostrador registra el pago mientras el agente captura el paso 7 '
        '⇒ aviso "este paso no cambió"', () {
      fakeAsync((async) {
        final h = harness();
        h.api.current = sessionAt(CheckoutStep.inspectionInProgress);
        h.container.invalidate(checkoutWizardProvider(kReservationId));
        h.container.listen(checkoutWizardProvider(kReservationId), (_, _) {});
        async.flushMicrotasks();
        expect(read(h.container).advance, isNull);

        h.api.current = sessionAt(
          CheckoutStep.inspectionInProgress,
          payment: DateTime.now(),
        );
        async.elapse(const Duration(seconds: 5));
        async.flushMicrotasks();

        final advance = read(h.container).advance!;
        expect(advance.kind, ForeignAdvanceKind.stampLanded);
        expect(advance.stamp, CheckoutStampKind.payment);
        expect(advance.currentStep, 'INSPECTION_IN_PROGRESS');
        expect(advance.completedStep, 'INSPECTION_IN_PROGRESS',
            reason: 'el paso NO se movió');
        // No es una reconciliación: nada saltó, y contarlo inflaría la métrica
        // con la que el épico mide cuánto se pisan las superficies.
        expect(
          h.logger.events.where((e) => e.$1 == CheckoutEvents.reconciled),
          isEmpty,
        );
      });
    });

    test('el sello que ESTE paso está esperando no genera aviso: en TC_PENDING '
        'el agente enseña el QR justo para que caiga', () {
      fakeAsync((async) {
        final h = harness();
        h.api.current = sessionAt(CheckoutStep.tcPending);
        h.container.invalidate(checkoutWizardProvider(kReservationId));
        h.container.listen(checkoutWizardProvider(kReservationId), (_, _) {});
        async.flushMicrotasks();

        h.api.current = sessionAt(CheckoutStep.tcPending, tc: DateTime.now());
        async.elapse(const Duration(seconds: 5));
        async.flushMicrotasks();

        expect(read(h.container).advance, isNull);
        // El paso sí tiene su propia señal de éxito, que no se toca.
        expect(
          h.logger.events.where((e) => e.$1 == CheckoutEvents.termsSignedSeen),
          hasLength(1),
        );
      });
    });
  });

  group('§22 · la matriz 409 sin puertas falsas', () {
    ApiError conflict(String? code, {String message = 'no'}) => ApiError(
          kind: ApiErrorKind.conflict,
          message: message,
          code: code,
          status: 409,
        );

    test('VEHICLE_CONFLICT antes de la inspección ⇒ el swap SIGUE siendo legal',
        () {
      fakeAsync((async) {
        final h = harness();
        async.flushMicrotasks();
        h.api.onTransition = (_) async => throw conflict(
              'VEHICLE_CONFLICT',
              message: 'Vehicle conflict with reservation RES-2465',
            );
        h.api.current = sessionAt(CheckoutStep.confirming);
        unawaited(notifier(h.container).transitionTo(CheckoutStep.tcPending));
        async.flushMicrotasks();

        final c = read(h.container).conflict!;
        expect(c.kind, CheckoutConflictKind.vehicleConflict);
        expect(c.swapAvailable, isTrue);
        // Y el número de la otra reserva se lee del texto: con él el CTA de
        // búsqueda puede tener éxito (ruta local `/search?q=`).
        expect(c.conflictReservationRef, 'RES-2465');
      });
    });

    test('PASADA la inspección el swap ya NO se ofrece: daría 409 SWAP_LOCKED '
        'para siempre (vehicle-swap.service.js:46-51)', () {
      fakeAsync((async) {
        final h = harness();
        h.api.current = sessionAt(CheckoutStep.inspectionInProgress);
        h.container.invalidate(checkoutWizardProvider(kReservationId));
        h.container.listen(checkoutWizardProvider(kReservationId), (_, _) {});
        async.flushMicrotasks();
        h.api.onTransition = (_) async => throw conflict(
              'VEHICLE_CONFLICT',
              message: 'Vehicle conflict with reservation RES-2465',
            );
        unawaited(notifier(h.container)
            .transitionTo(CheckoutStep.customerSignPending));
        async.flushMicrotasks();

        expect(read(h.container).conflict!.swapAvailable, isFalse);
      });
    });

    test('si el copy del servidor cambia, el CTA de búsqueda DESAPARECE en vez '
        'de navegar a una reserva inventada', () {
      fakeAsync((async) {
        final h = harness();
        async.flushMicrotasks();
        h.api.onTransition = (_) async => throw conflict(
              'VEHICLE_CONFLICT',
              message: 'La unidad no está disponible en esa ventana.',
            );
        unawaited(notifier(h.container).transitionTo(CheckoutStep.tcPending));
        async.flushMicrotasks();

        expect(read(h.container).conflict!.conflictReservationRef, isNull);
        // Pero el mensaje del servidor se sigue mostrando entero (DoD #5).
        expect(read(h.container).conflict!.message,
            'La unidad no está disponible en esa ventana.');
      });
    });

    test('ENTRY_GUARD conserva los dos pasos para poder nombrar el callejón',
        () {
      fakeAsync((async) {
        final h = harness();
        h.api.current = sessionAt(CheckoutStep.tcPending);
        h.container.invalidate(checkoutWizardProvider(kReservationId));
        h.container.listen(checkoutWizardProvider(kReservationId), (_, _) {});
        async.flushMicrotasks();
        h.api.onTransition = (_) async => throw conflict(
              'ENTRY_GUARD',
              message: 'Cannot enter TC_SIGNED: tcCompletedAt is not stamped yet',
            );
        unawaited(notifier(h.container).transitionTo(CheckoutStep.tcSigned));
        async.flushMicrotasks();

        final c = read(h.container).conflict!;
        expect(c.kind, CheckoutConflictKind.entryGuard);
        expect(c.attemptedStep, CheckoutStep.tcSigned);
        expect(c.currentStep, CheckoutStep.tcPending);
      });
    });
  });

  group('§23 · la antesala se decide AL LLEGAR, no en cada poll', () {
    test('entrar a media sesión la abre, y un toque la cierra para la visita',
        () {
      fakeAsync((async) {
        final h = harness();
        h.api.current = sessionAt(CheckoutStep.paymentPending);
        h.container.invalidate(checkoutWizardProvider(kReservationId));
        h.container.listen(checkoutWizardProvider(kReservationId), (_, _) {});
        async.flushMicrotasks();
        expect(read(h.container).showJoinGate(kMyUserId), isTrue);

        notifier(h.container).acknowledgeJoin();
        expect(read(h.container).showJoinGate(kMyUserId), isFalse);
      });
    });

    test('un avance ajeno mientras el agente trabaja NO abre la antesala: es '
        'una puerta que se cerraría en la cara a mitad de un formulario', () {
      fakeAsync((async) {
        // Se ENTRA en el paso 1, así que la antesala nunca llegó a aparecer y
        // `joinAcknowledged` sigue en false — que es lo que hace que este test
        // mida de verdad sobre QUÉ se decide la antesala.
        final h = harness();
        async.flushMicrotasks();
        expect(read(h.container).showJoinGate(kMyUserId), isFalse);
        expect(read(h.container).joinAcknowledged, isFalse);

        // El kiosco firma T&C y el poll mueve el paso a la posición 2.
        h.api.current = sessionAt(CheckoutStep.tcPending, actorUserId: null,
            kiosk: true);
        async.elapse(const Duration(seconds: 5));
        async.flushMicrotasks();

        expect(read(h.container).position, 2);
        expect(read(h.container).advance, isNotNull,
            reason: 'eso SÍ es avance ajeno y se cuenta con un banner');
        expect(
          read(h.container).showJoinGate(kMyUserId),
          isFalse,
          reason: 'la antesala responde "¿con qué me encontré al llegar?"; '
              'decidirla sobre la lectura viva la reabriría aquí',
        );
      });
    });

    test('una sesión recién abierta por uno mismo entra directo al paso 1 — '
        'sin un toque de más por cada salida del día', () {
      fakeAsync((async) {
        final h = harness();
        async.flushMicrotasks();
        expect(read(h.container).session!.currentStep, 'CONFIRMING');
        expect(read(h.container).showJoinGate(kMyUserId), isFalse);
      });
    });

    test('en el paso 1 pero abierta por OTRO, sí se cuenta', () {
      fakeAsync((async) {
        final h = harness();
        final raw = rawCheckoutSession();
        raw['currentStep'] = 'CONFIRMING';
        raw['startedByUserId'] = 'otro-agente-id';
        h.api.current = sessionFromRaw(raw);
        h.container.invalidate(checkoutWizardProvider(kReservationId));
        h.container.listen(checkoutWizardProvider(kReservationId), (_, _) {});
        async.flushMicrotasks();

        expect(read(h.container).showJoinGate(kMyUserId), isTrue);
        // Sin /me no se AFIRMA que la abrió otro: solo decide la posición.
        expect(read(h.container).showJoinGate(null), isFalse);
      });
    });

    test('una sesión terminal no tiene antesala: no hay nada que continuar', () {
      fakeAsync((async) {
        final h = harness();
        h.api.current = sessionAt(CheckoutStep.closed);
        h.container.invalidate(checkoutWizardProvider(kReservationId));
        h.container.listen(checkoutWizardProvider(kReservationId), (_, _) {});
        async.flushMicrotasks();
        expect(read(h.container).showJoinGate(kMyUserId), isFalse);
      });
    });
  });

  group('el baseline del diff se congela al entrar', () {
    test('"desde que entraste" sigue significando lo mismo diez minutos '
        'después', () {
      fakeAsync((async) {
        final h = harness();
        h.api.current = sessionAt(CheckoutStep.tcPending);
        h.container.invalidate(checkoutWizardProvider(kReservationId));
        h.container.listen(checkoutWizardProvider(kReservationId), (_, _) {});
        async.flushMicrotasks();
        expect(read(h.container).baseline!.currentStep, 'TC_PENDING');

        h.api.current = sessionAt(CheckoutStep.paymentPending,
            actorUserId: null, kiosk: true, tc: DateTime.now());
        async.elapse(const Duration(seconds: 5));
        async.flushMicrotasks();

        // El baseline NO sigue al poll: si lo hiciera, la hoja 21B diría "no
        // cambió nada" justo después de que cambiara todo.
        expect(read(h.container).baseline!.currentStep, 'TC_PENDING');
        expect(read(h.container).session!.currentStep, 'PAYMENT_PENDING');
        final set = buildChangeSet(
          baseline: read(h.container).baseline,
          current: read(h.container).session!,
          observedAt: DateTime.now(),
          myUserId: kMyUserId,
        );
        expect(set.stepMoved, isTrue);
        expect(
          set.stamps
              .firstWhere((s) => s.kind == CheckoutStampKind.tc)
              .status,
          CheckoutStampStatus.landed,
        );
      });
    });
  });
}
