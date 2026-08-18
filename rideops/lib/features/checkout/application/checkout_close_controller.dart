import 'package:clock/clock.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/api/enums.dart';
import '../../../core/telemetry/event_logger.dart';
import '../domain/checkout_step_catalog.dart';
import 'checkout_wizard_controller.dart';
import 'checkout_wizard_state.dart';

/// Los TRES tramos del cierre (mockup 18C).
///
/// Se enumeran porque el cierre **no es una cascada del servidor**: son tres
/// llamadas del cliente —`POST /:id/customer-signature`, `transition
/// CUSTOMER_SIGN_PENDING → FINALIZING`, `transition FINALIZING → CLOSED`— y
/// dibujarlas como un solo spinner escondería exactamente dónde se rompe
/// cuando se rompe. Verificado: `saveCustomerSignature` solo sella
/// (checkout-session.service.js:664-694) y no dispara ninguna transición.
enum CloseLeg { signature, finalizing, closing }

/// Estado de un tramo. [unknown] existe y no es un lujo: distingue "no pasó"
/// de "no sé" (nota 9 del 19C). Un tramo que murió sin respuesta no se pinta
/// como fallido — se pinta como desconocido, porque puede haber entrado.
enum CloseLegState { pending, running, done, failed, unknown }

/// Por qué se cortó el cierre. Decide QUÉ pantalla se dibuja y qué botón se
/// ofrece — y sobre todo, cuál NO.
enum CloseFailureKind {
  /// El servidor dijo que no y la sesión sigue viva: se puede volver a
  /// intentar el tramo.
  retryable,

  /// 19B — el servidor rechazó la entrega **con la sesión ya terminal**.
  /// Verificado: `transition()` commitea `CLOSED` en :417 y la cascada corre
  /// después; un 409 `VEHICLE_CONFLICT` / 422 `NO_VEHICLE_ASSIGNED` /
  /// `ensureCheckoutGates` escapa DESPUÉS de que la fila ya quedó cerrada.
  /// Desde un estado terminal `canTransition` es false (state-machine.js:94),
  /// así que un botón "Reintentar cierre" daría 409 `ILLEGAL_TRANSITION`
  /// para siempre: puerta falsa prohibida.
  rejectedTerminal,

  /// 19C — el POST murió sin respuesta. No se reintenta a ciegas (misma regla
  /// del dinero, ADR-5, aplicada al cierre): se CONSULTA.
  unknownNetwork,
}

/// Qué dice `Reservation.status` sobre la entrega, DESPUÉS del cierre.
///
/// Existe porque la sesión terminal **no prueba** que la entrega quedó
/// registrada: la cascada del finalize corre después del `CLOSED` y se traga
/// varios de sus errores (checkout-session.service.js:526, :533, :557, :571),
/// así que un 200 puede convivir con una reserva que sigue en `CONFIRMED`.
enum HandoverVerdict {
  /// Todavía no se preguntó y NADIE está preguntando: esta pantalla no
  /// participó de ningún cierre (11E).
  unchecked,

  /// La consulta está EN VUELO (19A-bis). Existe porque la regla del progreso
  /// de cierre aplica también aquí: **ningún renglón afirma un resultado antes
  /// de que vuelva la llamada que lo produce**. Antes, el veredicto quedaba en
  /// "no confirmado" durante todo el viaje y saltaba a verde al aterrizar: una
  /// falsa alarma en el camino feliz, que es lo que entrena al agente a
  /// ignorar la alarma de verdad.
  verifying,

  /// La reserva avanzó (CHECKED_OUT / CHECKED_IN / CHECKED_IN_UNPAID).
  recorded,

  /// La reserva RESPONDIÓ y NO avanzó: no es duda, es la entrega no
  /// registrada con un 200 en la mano — se pinta como 19B, jamás como el
  /// ámbar de "no sé" (nota 13 del 19A-bis).
  notRecorded,

  /// display-data no respondió, o mandó un estado que esta versión no conoce.
  /// **No es "no quedó registrada"**: es "no lo sé", y así se dice — en ámbar,
  /// con la escalada de cuatro señales del 19A-bis.
  unverified,
}

@immutable
class CheckoutCloseState {
  const CheckoutCloseState({
    this.kioskOpen = false,
    this.capturedSignature,
    this.signature = CloseLegState.pending,
    this.finalizing = CloseLegState.pending,
    this.closing = CloseLegState.pending,
    this.signatureAt,
    this.running = false,
    this.failureKind,
    this.failedLeg,
    this.failureMessage,
    this.failureCode,
    this.failedAt,
    this.handover = HandoverVerdict.unchecked,
    this.showDetail = false,
    this.checking = false,
  });

  /// El teléfono está en manos del cliente (18B). Mientras esto es true el
  /// shell del wizard se dibuja SIN cromo de staff.
  final bool kioskOpen;

  /// El trazo que el cliente ya dejó y que todavía no aceptó el servidor.
  ///
  /// Se retiene a propósito: si la pata 1 falla por red, volver a pedirle la
  /// firma al cliente sería cobrarle el error de la app. Vive solo en memoria
  /// y solo hasta el 200 — **jamás toca la bandeja de salida**.
  final String? capturedSignature;

  final CloseLegState signature;
  final CloseLegState finalizing;
  final CloseLegState closing;

  /// Hora del SERVIDOR en la que quedó la firma (`customerSignedAt`).
  final DateTime? signatureAt;

  final bool running;

  /// Hay un `GET /:id` de "Consultar el estado" en vuelo (19C).
  final bool checking;

  final CloseFailureKind? failureKind;
  final CloseLeg? failedLeg;

  /// Cuerpo del servidor tal cual (DoD #5). La app pone el marco ("Motivo ·
  /// Respuesta del servidor"); traducirlo sería inventar reglas de negocio.
  final String? failureMessage;
  final String? failureCode;
  final DateTime? failedAt;

  final HandoverVerdict handover;

  /// El agente pidió "Ver el detalle de la sesión" (19A → el log de 11E).
  final bool showDetail;

  /// ¿Hay algo que 19A/19B tengan que contar sobre esta sesión terminal?
  ///
  /// `handover != unchecked` sustituye al viejo booleano `closedByUs`
  /// (19A-bis): el veredicto solo sale de [unchecked] cuando ESTA pantalla
  /// cerró (o descubrió el cierre) y disparó la comprobación — que es
  /// exactamente lo que "participé del cierre" significaba. Una sesión que ya
  /// estaba cerrada al entrar nunca corre `close()` y sigue siendo 11E.
  bool get hasOutcome =>
      handover != HandoverVerdict.unchecked ||
      failureKind == CloseFailureKind.rejectedTerminal;

  /// 19C: se perdió la respuesta a media secuencia.
  bool get isUnknown => failureKind == CloseFailureKind.unknownNetwork;

  CheckoutCloseState copyWith({
    bool? kioskOpen,
    String? capturedSignature,
    bool clearSignature = false,
    CloseLegState? signature,
    CloseLegState? finalizing,
    CloseLegState? closing,
    DateTime? signatureAt,
    bool? running,
    bool? checking,
    CloseFailureKind? failureKind,
    CloseLeg? failedLeg,
    String? failureMessage,
    String? failureCode,
    DateTime? failedAt,
    bool clearFailure = false,
    HandoverVerdict? handover,
    bool? showDetail,
  }) {
    return CheckoutCloseState(
      kioskOpen: kioskOpen ?? this.kioskOpen,
      capturedSignature:
          clearSignature ? null : (capturedSignature ?? this.capturedSignature),
      signature: signature ?? this.signature,
      finalizing: finalizing ?? this.finalizing,
      closing: closing ?? this.closing,
      signatureAt: signatureAt ?? this.signatureAt,
      running: running ?? this.running,
      checking: checking ?? this.checking,
      failureKind: clearFailure ? null : (failureKind ?? this.failureKind),
      failedLeg: clearFailure ? null : (failedLeg ?? this.failedLeg),
      failureMessage:
          clearFailure ? null : (failureMessage ?? this.failureMessage),
      failureCode: clearFailure ? null : (failureCode ?? this.failureCode),
      failedAt: clearFailure ? null : (failedAt ?? this.failedAt),
      handover: handover ?? this.handover,
      showDetail: showDetail ?? this.showDetail,
    );
  }
}

/// Controller del paso 8 y del cierre (M2-H5, mockup 18 y 19).
///
/// Lo que este controller NO hace, y es deliberado:
///  - **no encola nada**: ni la firma ni las transiciones entran a la bandeja
///    de salida. La firma es una escritura al contrato que solo el servidor
///    confirma; un cierre "para después" sería una entrega que el cliente cree
///    hecha y el sistema no tiene (ADR-5 aplicado al cierre).
///  - **no reintenta solo**: en timeout se consulta, jamás se reproduce la
///    operación.
///  - **no ofrece reintento sobre una sesión terminal**: `canTransition` es
///    false desde terminal, así que ese botón sería un 409 eterno.
class CheckoutCloseController extends Notifier<CheckoutCloseState> {
  CheckoutCloseController(this.reservationId);

  final String reservationId;

  @override
  CheckoutCloseState build() => const CheckoutCloseState();

  CheckoutWizardController get _wizard =>
      ref.read(checkoutWizardProvider(reservationId).notifier);

  CheckoutWizardState get _wizardState =>
      ref.read(checkoutWizardProvider(reservationId));

  EventLogger get _logger => ref.read(eventLoggerProvider);

  // ── kiosco (18A → 18B) ───────────────────────────────────────────────────

  /// "Entregar al cliente". Sin red NO se abre: la firma se escribe en el
  /// contrato en el momento, y pedirle el trazo al cliente para después
  /// decirle que no se guardó es el peor final posible de este paso.
  bool openKiosk() {
    if (_wizardState.offline || _wizardState.session == null) return false;
    state = state.copyWith(kioskOpen: true, clearFailure: true);
    return true;
  }

  /// Salida deliberada del kiosco (PIN correcto, o intentos agotados). NO
  /// toca la sesión: el paso queda exactamente igual, que es lo que 18A
  /// promete antes de soltar el teléfono.
  void exitKiosk() => state = state.copyWith(kioskOpen: false);

  /// El cliente confirmó su firma: se cierra el kiosco y arranca el cierre.
  /// El trazo se retiene en memoria por si la pata 1 falla.
  Future<void> confirmSignature(String signatureDataUrl) async {
    state = state.copyWith(
      kioskOpen: false,
      capturedSignature: signatureDataUrl,
    );
    await close();
  }

  // ── cierre (18C → 19A/19B/19C) ───────────────────────────────────────────

  /// Corre los tramos que falten. Es idempotente respecto del SERVIDOR: cada
  /// tramo se salta si el sello/paso que produce ya existe, así que reanudar
  /// tras un fallo no vuelve a pedir nada que ya esté hecho.
  Future<void> close() async {
    if (state.running) return;
    final session = _wizardState.session;
    if (session == null || _wizardState.offline) return;

    // Un trazo FRESCO siempre se manda, haya o no sello previo: es justo el
    // caso de "Volver a pedir la firma" (18D), donde el sello existe y lo que
    // el agente pidió explícitamente fue SUSTITUIRLO. Decidirlo solo por el
    // sello dejaba la firma nueva muerta en memoria y cerraba con la vieja.
    final runSignature = state.capturedSignature != null;
    if (!runSignature && session.customerSignedAt == null) {
      // Sin firma sellada y sin trazo en mano no hay cierre que correr: la
      // pantalla ofrece 18A, no un botón que no puede cumplir.
      return;
    }

    _logger.log(
      CheckoutEvents.closeStarted,
      data: {'legs': runSignature ? 3 : 2},
    );
    state = state.copyWith(
      running: true,
      clearFailure: true,
      signature: runSignature ? CloseLegState.pending : CloseLegState.done,
      signatureAt: session.customerSignedAt,
      finalizing: CloseLegState.pending,
      closing: CloseLegState.pending,
    );

    try {
      if (runSignature && !await _runSignature()) return;
      if (!await _runTransition(
        CloseLeg.finalizing,
        CheckoutStep.finalizing,
      )) {
        return;
      }
      if (!await _runTransition(CloseLeg.closing, CheckoutStep.closed)) return;

      // Llegó a CLOSED. Antes de decir nada en 19A se le PREGUNTA al servidor
      // si la entrega quedó registrada: el 200 no lo prueba. Mientras la
      // consulta viaja, el veredicto es [verifying] — jamás una afirmación
      // que la llamada todavía no produjo (regla del 19A-bis).
      state = state.copyWith(
        closing: CloseLegState.done,
        handover: HandoverVerdict.verifying,
      );
      await _verify(logOutcome: true);
    } finally {
      if (ref.mounted) state = state.copyWith(running: false);
    }
  }

  /// Pata 1 — la firma. Devuelve false si el cierre no puede continuar.
  Future<bool> _runSignature() async {
    state = state.copyWith(signature: CloseLegState.running);
    final attempt = await _wizard.saveCustomerSignature(
      signatureDataUrl: state.capturedSignature!,
      // El firmante se sella desde display-data: el endpoint acepta la firma
      // sin nombre y la dejaría ANÓNIMA en el contrato.
      signerName: _wizardState.context?.customerName,
    );
    if (!ref.mounted) return false;
    if (attempt.outcome == CheckoutTransitionOutcome.ok) {
      state = state.copyWith(
        signature: CloseLegState.done,
        signatureAt: _wizardState.session?.customerSignedAt,
        // El trazo ya vive en el contrato: se suelta de memoria.
        clearSignature: true,
      );
      return true;
    }
    await _noteFailure(CloseLeg.signature, attempt);
    return false;
  }

  /// Patas 2 y 3 — las transiciones. Se SALTAN si el servidor ya está en (o
  /// pasado) el destino: reanudar no puede producir un 409 evitable.
  Future<bool> _runTransition(CloseLeg leg, CheckoutStep toStep) async {
    final done = leg == CloseLeg.finalizing
        ? (CloseLegState s) => state.copyWith(finalizing: s)
        : (CloseLegState s) => state.copyWith(closing: s);

    if (isAtOrPast(current: _wizardState.session?.step, target: toStep)) {
      state = done(CloseLegState.done);
      return true;
    }
    state = done(CloseLegState.running);
    final attempt = await _wizard.attemptTransition(toStep);
    if (!ref.mounted) return false;
    switch (attempt.outcome) {
      case CheckoutTransitionOutcome.ok:
      case CheckoutTransitionOutcome.alreadyDone:
        state = done(CloseLegState.done);
        return true;
      case CheckoutTransitionOutcome.blocked:
      case CheckoutTransitionOutcome.reconciled:
      case CheckoutTransitionOutcome.conflict:
      case CheckoutTransitionOutcome.failed:
        await _noteFailure(leg, attempt);
        return false;
    }
  }

  /// Clasifica la negativa y deja la pantalla que corresponde.
  Future<void> _noteFailure(
    CloseLeg leg,
    CheckoutTransitionAttempt attempt,
  ) async {
    final legState =
        attempt.network ? CloseLegState.unknown : CloseLegState.failed;
    // Terminal ⇒ 19B. La sesión se cerró y la entrega NO se registró: no hay
    // reintento posible y la app no finge que lo hay.
    final terminal = _wizardState.isTerminal;
    final kind = attempt.network
        ? CloseFailureKind.unknownNetwork
        : (terminal
            ? CloseFailureKind.rejectedTerminal
            : CloseFailureKind.retryable);

    // Sin respuesta, los tramos POSTERIORES también quedan desconocidos: no
    // corrieron, cierto — pero decir "falta el paso 10 de 10" afirmaría una
    // posición que ya no sabemos (¿quedó en 8 o en 9?). "No sé" se propaga.
    CloseLegState after(CloseLeg other, CloseLegState current) {
      if (other == leg) return legState;
      if (attempt.network && other.index > leg.index) {
        return CloseLegState.unknown;
      }
      return current;
    }

    state = state.copyWith(
      signature: after(CloseLeg.signature, state.signature),
      finalizing: after(CloseLeg.finalizing, state.finalizing),
      closing: after(CloseLeg.closing, state.closing),
      failureKind: kind,
      failedLeg: leg,
      failureMessage: attempt.message,
      failureCode: attempt.code,
      failedAt: clock.now(),
    );

    if (attempt.network) {
      _logger.log(CheckoutEvents.closeUnknown, data: {'leg': leg.name});
      return;
    }
    _logger.log(CheckoutEvents.closeFailed, data: {
      'leg': leg.name,
      'code': attempt.code ?? 'none',
      'terminal': terminal,
    });
    // 19B tiene que resolverse EN EL MOMENTO (el 409 no queda en `events[]`:
    // pedido P10 al backend), así que lo poco que se puede verificar se
    // verifica ahora mismo y no cuando el agente vuelva. El `close_failed`
    // de arriba ya contó este desenlace: la verificación no loguea otro.
    if (kind == CloseFailureKind.rejectedTerminal) {
      state = state.copyWith(handover: HandoverVerdict.verifying);
      await _verify(logOutcome: false);
    }
  }

  /// Le pregunta a `Reservation.status` si la entrega quedó registrada.
  ///
  /// [logOutcome] separa el `close_ok` del camino que CERRÓ (una vez por
  /// cierre) de las verificaciones que no son un cierre: la de 19B (el
  /// `close_failed` ya contó ese desenlace) y el re-chequeo manual, que tiene
  /// su propio evento.
  Future<HandoverVerdict> _verify({required bool logOutcome}) async {
    final recorded = await _wizard.verifyHandover();
    final verdict = switch (recorded) {
      true => HandoverVerdict.recorded,
      false => HandoverVerdict.notRecorded,
      null => HandoverVerdict.unverified,
    };
    if (!ref.mounted) return verdict;
    state = state.copyWith(handover: verdict);
    if (logOutcome) {
      _logger.log(CheckoutEvents.closeOk, data: {
        'handover': _handoverTag(verdict),
      });
    }
    return verdict;
  }

  static String _handoverTag(HandoverVerdict verdict) => switch (verdict) {
        HandoverVerdict.recorded => 'recorded',
        HandoverVerdict.notRecorded => 'not_recorded',
        _ => 'unverified',
      };

  // ── recuperación ─────────────────────────────────────────────────────────

  /// "Consultar el estado" (19C): un `GET /:id` y a reconciliar. **Nunca** un
  /// reintento a ciegas — el riesgo aquí no es cobrar dos veces, es dejar una
  /// reserva a medio entregar creyendo que se arregló.
  Future<void> checkStatus() async {
    if (state.checking) return;
    state = state.copyWith(checking: true);
    try {
      await _wizard.refresh();
      if (!ref.mounted) return;
      final session = _wizardState.session;
      if (session == null) return;
      // El servidor manda: los tramos se re-derivan de lo que reporta, no de
      // lo que la app creía.
      final signed = session.customerSignedAt != null;
      final closed = session.isTerminal;
      final finalized =
          isAtOrPast(current: session.step, target: CheckoutStep.finalizing);
      state = state.copyWith(
        signature: signed ? CloseLegState.done : CloseLegState.pending,
        signatureAt: session.customerSignedAt,
        finalizing: finalized ? CloseLegState.done : CloseLegState.pending,
        closing: closed ? CloseLegState.done : CloseLegState.pending,
        clearSignature: signed,
        // Con una lectura fresca en la mano, la incertidumbre se acabó: o el
        // paso avanzó o no. Si sigue sin avanzar, el agente vuelve a tener el
        // CTA del paso, que es una salida real.
        clearFailure: true,
      );
      if (closed) {
        // Cerró de verdad, aunque no lo hayamos visto: se dice como 19A —
        // pero primero se COMPRUEBA, y mientras tanto se dice que se está
        // comprobando.
        state = state.copyWith(handover: HandoverVerdict.verifying);
        await _verify(logOutcome: true);
      }
    } finally {
      if (ref.mounted) state = state.copyWith(checking: false);
    }
  }

  /// Vuelve a intentar el tramo que falló, cuando de verdad se puede.
  Future<void> retry() async {
    if (state.failureKind != CloseFailureKind.retryable) return;
    await close();
  }

  /// "Volver a comprobar" (19A-bis, solo en `unverified`). Es una CONSULTA a
  /// display-data —la misma llamada que la app ya hace sola al cerrar— jamás
  /// un reintento del cierre: desde terminal `canTransition` es false
  /// (state-machine.js:94) y ese botón daría 409 para siempre. Un negativo
  /// definitivo que descubra esta consulta enruta a 19B por `notRecorded`,
  /// nunca se suaviza en ámbar (nota 13 del 19A-bis).
  Future<void> recheck() async {
    if (state.handover != HandoverVerdict.unverified) return;
    state = state.copyWith(handover: HandoverVerdict.verifying);
    final verdict = await _verify(logOutcome: false);
    // El provider es autoDispose y ESTA pantalla invita a irse mientras la
    // consulta viaja: durante `verifying` el secundario dice "Volver al
    // inicio" y el pie promete que nada bloquea. Si el agente lo toma, el
    // controller ya murió cuando vuelve el await y `ref.read` lanza
    // UnmountedRefException. La telemetría no vale una excepción.
    if (!ref.mounted) return;
    _logger.log(
      CheckoutEvents.handoverRecheck,
      data: {'result': _handoverTag(verdict)},
    );
  }

  void showSessionDetail() => state = state.copyWith(showDetail: true);

  void hideSessionDetail() => state = state.copyWith(showDetail: false);
}

/// autoDispose y familia por **reservationId** — la misma llave del wizard,
/// para que el paso 8 y el shell hablen de la misma entrega. Al salir del
/// checkout el trazo retenido en memoria se va con el controller.
final checkoutCloseProvider = NotifierProvider.autoDispose
    .family<CheckoutCloseController, CheckoutCloseState, String>(
  CheckoutCloseController.new,
);
