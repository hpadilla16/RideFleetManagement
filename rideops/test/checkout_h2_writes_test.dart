import 'dart:async';
import 'dart:convert';

import 'package:fake_async/fake_async.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:rideops/core/api/api_error.dart';
import 'package:rideops/core/api/api_providers.dart';
import 'package:rideops/core/api/dto/checkout_session.dart';
import 'package:rideops/core/api/enums.dart';
import 'package:rideops/core/outbox/network_status.dart';
import 'package:rideops/core/session/active_location.dart';
import 'package:rideops/core/session/session_controller.dart';
import 'package:rideops/core/session/session_state.dart';
import 'package:rideops/core/telemetry/event_logger.dart';
import 'package:rideops/features/checkout/application/checkout_wizard_controller.dart';
import 'package:rideops/features/checkout/application/checkout_wizard_state.dart';
import 'package:rideops/features/checkout/application/terms_token_controller.dart';
import 'package:rideops/features/checkout/domain/checkout_confirm.dart';

import 'helpers/auth_test_helpers.dart';
import 'helpers/checkout_test_helpers.dart';
import 'helpers/outbox_test_helpers.dart';
import 'helpers/shell_test_helpers.dart';

/// Escrituras del paso CONFIRMING en el controller (M2-H2): seguro declinado y
/// swap. Lo que estos tests protegen: **ninguna de las dos guarda estado local**
/// — se manda el valor deseado y la pantalla se re-dibuja desde la respuesta
/// del servidor (ADR-4) — y ninguna sale sin red (ADR-5: el checkout no se
/// encola).

void main() {
  final liveToken = fakeJwt(
    exp: DateTime.now().add(const Duration(hours: 8)),
    sub: kMyUserId,
  );

  ({
    ProviderContainer container,
    FakeCheckoutApi api,
    FakeReservationsApi reservations,
    CapturingEventLogger logger,
    FakeNetworkStatus network,
  }) harness({bool online = true}) {
    final api = FakeCheckoutApi();
    final reservations = FakeReservationsApi();
    final logger = CapturingEventLogger();
    final network = FakeNetworkStatus(online: online);
    final container = ProviderContainer(
      overrides: [
        checkoutApiProvider.overrideWithValue(api),
        reservationsApiProvider.overrideWithValue(reservations),
        eventLoggerProvider.overrideWithValue(logger),
        networkStatusProvider.overrideWithValue(network),
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
      ],
    );
    addTearDown(container.dispose);
    container.listen(checkoutWizardProvider(kReservationId), (_, _) {});
    return (
      container: container,
      api: api,
      reservations: reservations,
      logger: logger,
      network: network,
    );
  }

  CheckoutWizardState read(ProviderContainer c) =>
      c.read(checkoutWizardProvider(kReservationId));

  CheckoutWizardController notifier(ProviderContainer c) =>
      c.read(checkoutWizardProvider(kReservationId).notifier);

  test('declined-insurance: la UI se re-dibuja desde la sesión que RESPONDE el '
      'servidor, no desde el valor que se mandó', () {
    fakeAsync((async) {
      final h = harness();
      async.flushMicrotasks();
      expect(declinedInsuranceOf(session: read(h.container).session!), isFalse);

      // El servidor acepta y devuelve la sesión con su evento nuevo.
      final raw = rawCheckoutSession();
      raw['currentStep'] = CheckoutStep.confirming.wire;
      raw['tcCompletedAt'] = null;
      raw['events'] = json.encode([
        {'kind': 'DECLINED_INSURANCE', 'declined': true},
      ]);
      h.api.onDeclinedInsurance = (_) async => sessionFromRaw(raw);

      notifier(h.container).setDeclinedInsurance(true);
      async.flushMicrotasks();

      expect(h.api.declinedValues, [true]);
      expect(declinedInsuranceOf(session: read(h.container).session!), isTrue);
      expect(read(h.container).isMutating, isFalse);
    });
  });

  test('declined-insurance sin red: NO sale la request (el checkout jamás se '
      'encola, ADR-5)', () {
    fakeAsync((async) {
      final h = harness();
      async.flushMicrotasks();
      h.api.onGet = () async =>
          throw ApiError(kind: ApiErrorKind.network, message: 'sin red');
      h.network.online = false;
      async.elapse(const Duration(seconds: 5));
      async.flushMicrotasks();
      expect(read(h.container).offline, isTrue);

      notifier(h.container).setDeclinedInsurance(true);
      async.flushMicrotasks();
      expect(h.api.declinedInsuranceCalls, 0);
    });
  });

  test('declined-insurance con 409 SIN code (sesión sin contrato ligado): se '
      're-consulta y se muestra el mensaje del servidor', () {
    fakeAsync((async) {
      final h = harness();
      async.flushMicrotasks();
      final getsBefore = h.api.getCalls;
      h.api.onDeclinedInsurance = (_) async => throw ApiError(
            kind: ApiErrorKind.conflict,
            status: 409,
            message: 'No agreement linked to this session',
          );

      notifier(h.container).setDeclinedInsurance(true);
      async.flushMicrotasks();

      final state = read(h.container);
      expect(state.conflict?.kind, CheckoutConflictKind.generic);
      expect(state.conflict?.message, 'No agreement linked to this session');
      expect(h.api.getCalls, greaterThan(getsBefore),
          reason: 'todo 409 se reconcilia (ADR-4)');
    });
  });

  test('el poll NO se encima a una escritura del paso: mientras hay swap en '
      'vuelo, el tick se salta (y el reloj se re-arma)', () {
    fakeAsync((async) {
      final h = harness();
      async.flushMicrotasks();
      final getsBefore = h.api.getCalls;

      final gate = Completer<void>();
      h.api.onSwapVehicle = (id) async {
        await gate.future;
        return VehicleSwapResultFixture.of(h.api, id);
      };
      notifier(h.container).swapVehicle('veh-nuevo');
      async.flushMicrotasks();
      expect(read(h.container).mutating, CheckoutMutation.vehicleSwap);

      // Dos ciclos completos de poll mientras el POST sigue vivo.
      async.elapse(const Duration(seconds: 12));
      expect(h.api.getCalls, getsBefore,
          reason: 'una lectura lanzada en paralelo solo llega tarde y vieja');

      gate.complete();
      async.flushMicrotasks();
      expect(read(h.container).isMutating, isFalse);
      // Y el poll VUELVE (la escritura no puede matar el reloj).
      async.elapse(const Duration(seconds: 6));
      expect(h.api.getCalls, greaterThan(getsBefore));
    });
  });

  test('swap OK: se aplica la sesión de la respuesta y se re-lee display-data '
      '(la unidad vieja no puede quedarse en pantalla)', () {
    fakeAsync((async) {
      final h = harness();
      async.flushMicrotasks();
      final displayBefore = h.reservations.displayDataCalls;

      final attempt = <CheckoutSwapAttempt>[];
      notifier(h.container).swapVehicle('veh-nuevo').then(attempt.add);
      async.flushMicrotasks();

      expect(h.api.swappedVehicleIds, ['veh-nuevo']);
      expect(attempt.single.outcome, CheckoutSwapOutcome.ok);
      expect(h.reservations.displayDataCalls, greaterThan(displayBefore));
      expect(
        h.logger.events.where((e) => e.$1 == CheckoutEvents.vehicleSwapped),
        hasLength(1),
      );
    });
  });

  test('swap con 409 de la UNIDAD: el mensaje viaja en el intento, NO se '
      'guarda como error del paso (no puede atribuirse a la unidad actual)',
      () {
    fakeAsync((async) {
      final h = harness();
      async.flushMicrotasks();
      h.api.onSwapVehicle = (_) async => throw ApiError(
            kind: ApiErrorKind.conflict,
            status: 409,
            code: 'VEHICLE_DOUBLE_BOOKED',
            message: 'Vehicle already reserved on this window (R-2470)',
          );

      final attempt = <CheckoutSwapAttempt>[];
      notifier(h.container).swapVehicle('veh-ocupado').then(attempt.add);
      async.flushMicrotasks();

      expect(attempt.single.outcome, CheckoutSwapOutcome.vehicleRejected);
      expect(attempt.single.message, contains('R-2470'));
      final state = read(h.container);
      expect(state.conflict, isNull);
      expect(state.vehicleConflictMessage, isNull,
          reason: 'la unidad ACTUAL no hereda la negativa de otra');
    });
  });

  test('swap con 409 SWAP_LOCKED: la negativa SÍ queda en el paso (el swap '
      'dejó de existir para esta sesión)', () {
    fakeAsync((async) {
      final h = harness();
      async.flushMicrotasks();
      h.api.onSwapVehicle = (_) async => throw ApiError(
            kind: ApiErrorKind.conflict,
            status: 409,
            code: 'SWAP_LOCKED',
            message: 'Cannot swap vehicle once inspection has started',
          );

      final attempt = <CheckoutSwapAttempt>[];
      notifier(h.container).swapVehicle('veh-nuevo').then(attempt.add);
      async.flushMicrotasks();

      expect(attempt.single.outcome, CheckoutSwapOutcome.lockedStep);
      expect(
        read(h.container).conflict?.message,
        'Cannot swap vehicle once inspection has started',
      );
      expect(
        h.logger.events
            .where((e) => e.$1 == CheckoutEvents.transition409)
            .map((e) => e.$2['code']),
        contains('SWAP_LOCKED'),
      );
    });
  });

  test('INN-S-1 — un build() con un mint EN VUELO no deja el guard trabado: el '
      'paso no se queda girando con los dos botones mudos', () {
    fakeAsync((async) {
      final h = harness();
      async.flushMicrotasks();
      final gate = Completer<void>();
      h.api.onMintTermsToken = () async {
        await gate.future;
        return termsToken();
      };

      final provider = termsTokenProvider(kSessionId);
      h.container.listen(provider, (_, _) {});
      async.flushMicrotasks();
      expect(h.api.termsTokenCalls, 1, reason: 'mint al entrar al paso');

      // El build se rehace mientras ese POST sigue vivo (cambio de sede,
      // login/logout, o simplemente que el paso se vuelva a montar).
      h.container.invalidate(provider);
      h.container.listen(provider, (_, _) {});
      async.flushMicrotasks();
      expect(h.api.termsTokenCalls, 2,
          reason: 'la generación nueva SÍ puede pedir su código');

      gate.complete();
      async.flushMicrotasks();

      // Y después de que la respuesta vieja aterriza, "Generar código nuevo"
      // sigue vivo. Sin el reset, el `finally` de la generación vieja no
      // limpiaba el guard y esto se quedaba en 2 para siempre.
      h.container.read(provider.notifier).mint();
      async.flushMicrotasks();
      expect(h.api.termsTokenCalls, 3);
    });
  });

  test('dos escrituras a la vez: la segunda se rechaza sin salir a la red', () {
    fakeAsync((async) {
      final h = harness();
      async.flushMicrotasks();
      final gate = Completer<void>();
      h.api.onDeclinedInsurance = (_) async {
        await gate.future;
        return h.api.current!;
      };

      notifier(h.container).setDeclinedInsurance(true);
      async.flushMicrotasks();
      notifier(h.container).swapVehicle('veh-nuevo');
      async.flushMicrotasks();

      expect(h.api.swapCalls, 0);
      gate.complete();
      async.flushMicrotasks();
    });
  });

  test('el sello de T&C que llega por POLL se cuenta UNA vez y solo cuando '
      'CAE (no al entrar con la sesión ya firmada)', () {
    fakeAsync((async) {
      final h = harness();
      h.api.current = sessionAt(CheckoutStep.tcPending);
      h.container.invalidate(checkoutWizardProvider(kReservationId));
      h.container.listen(checkoutWizardProvider(kReservationId), (_, _) {});
      async.flushMicrotasks();
      expect(
        h.logger.events.where((e) => e.$1 == CheckoutEvents.termsSignedSeen),
        isEmpty,
      );

      h.api.current = sessionAt(
        CheckoutStep.tcPending,
        tc: DateTime.now(),
        actorUserId: null,
      );
      async.elapse(const Duration(seconds: 5));
      async.flushMicrotasks();
      // Y varios ciclos más con el sello ya puesto no re-emiten nada.
      async.elapse(const Duration(seconds: 40));
      async.flushMicrotasks();

      expect(
        h.logger.events.where((e) => e.$1 == CheckoutEvents.termsSignedSeen),
        hasLength(1),
      );
    });
  });
}

/// Azúcar local: el swap del fake devuelve la sesión que el fake ya tiene.
abstract final class VehicleSwapResultFixture {
  static VehicleSwapResult of(FakeCheckoutApi api, String newVehicleId) =>
      VehicleSwapResult(
        sessionId: kSessionId,
        fromVehicleId: 'veh-viejo',
        toVehicleId: newVehicleId,
        session: api.current!,
      );
}
