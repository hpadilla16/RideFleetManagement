import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/api/api_error.dart';
import '../../../core/api/api_providers.dart';
import '../../../core/api/checkout_api.dart';
import '../../../core/api/reservations_api.dart';
import '../../../core/outbox/network_status.dart';
import '../../../core/session/active_location.dart';
import '../../../core/telemetry/event_logger.dart';
import '../domain/checkout_entry.dart';

/// Qué pasó al tocar la card de la cola de salidas (M2-H7, frames 11A–11E).
enum CheckoutEntryOutcome {
  /// El servidor devolvió la sesión (creada o REANUDADA — es idempotente por
  /// reserva): se navega al wizard.
  opened,

  /// 409 `SESSION_TERMINAL`: la sesión existe y ya terminó. También se navega
  /// al wizard, que la lee de `by-reservation` y dibuja el frame 11E con su
  /// events log real (el 409 no trae la fila).
  terminal,

  /// Un guard con pantalla propia: la card abre el sheet leyendo
  /// [CheckoutEntryState.block].
  blocked,

  /// Ni POST ni sheet: ya había uno en vuelo (anti-doble-tap). Tragárselo es
  /// lo correcto — el agente ya tiene su respuesta en camino.
  busy,

  /// La escritura salió pero el alcance cambió antes de que volviera (cambio de
  /// sede/cuenta). NO es lo mismo que [busy]: aquí el servidor pudo crear la
  /// sesión y el agente merece saberlo.
  aborted,
}

@immutable
class CheckoutEntryState {
  const CheckoutEntryState({
    this.starting = false,
    this.block,
    this.sendingLink = false,
    this.linkSent = false,
    this.linkError,
  });

  /// POST en vuelo ⇒ la card se tiñe tonal y su CTA dice "Abriendo…" (frame
  /// 11A). El feedback vive EN la card: el agente sigue viendo su cola.
  final bool starting;

  /// Último guard del servidor pendiente de mostrar.
  final CheckoutEntryBlock? block;

  /// POST del link de pre-checkin en vuelo (frame 11B).
  final bool sendingLink;
  final bool linkSent;

  /// Fallo del envío del link — o el 200 con `emailSent:false`, que se
  /// convierte en un ApiError sintético para que la UI no tenga dos caminos.
  final ApiError? linkError;

  CheckoutEntryState copyWith({
    bool? starting,
    CheckoutEntryBlock? block,
    bool clearBlock = false,
    bool? sendingLink,
    bool? linkSent,
    ApiError? linkError,
    bool clearLinkError = false,
  }) {
    return CheckoutEntryState(
      starting: starting ?? this.starting,
      block: clearBlock ? null : (block ?? this.block),
      sendingLink: sendingLink ?? this.sendingLink,
      linkSent: linkSent ?? this.linkSent,
      linkError: clearLinkError ? null : (linkError ?? this.linkError),
    );
  }
}

/// Entrada al checkout desde la card de la cola `checkout` (M2-H7).
///
/// Reglas que este controller sostiene:
///  - **Nunca se navega optimistamente** (nota 1 del mockup): solo cuando el
///    servidor devuelve la sesión. Entrar al wizard para regresar con un error
///    sería peor que esperar 400 ms mirando la propia cola.
///  - **La creación exige red UNA vez y NO se encola**: ADR-5 aplica a todo el
///    checkout, no solo al dinero. Sin señal se dice, y el reintento es del
///    agente.
///  - **Se espera a que la sede hidrate** antes del POST (criterio registrado
///    en H4): mandarlo antes es mandarlo sin `x-view-location`, o sea con un
///    alcance distinto al que el agente cree tener seleccionado.
///  - **La app no juega a ser máquina de estados** (nota 3): el CTA no se
///    deshabilita por lo que dice la card — la cola se refresca cada 45-60 s y
///    el pre-checkin pudo completarse hace 10 s. La card avisa, el servidor
///    decide, el sheet explica.
class CheckoutEntryController extends Notifier<CheckoutEntryState> {
  CheckoutEntryController(this.reservationId);

  final String reservationId;

  /// Invalida respuestas en vuelo si el provider se reconstruye (cambio de
  /// sede o de cuenta) — mismo patrón que el wizard.
  int _generation = 0;

  @override
  CheckoutEntryState build() {
    _generation++;
    // La sede activa es una DEPENDENCIA real: si el agente cambia de sede a
    // media espera, el POST viejo ya no representa lo que ve.
    ref.watch(activeLocationProvider.select((l) => l.locationId));
    return const CheckoutEntryState();
  }

  CheckoutApi get _api => ref.read(checkoutApiProvider);
  ReservationsApi get _reservations => ref.read(reservationsApiProvider);
  EventLogger get _logger => ref.read(eventLoggerProvider);

  /// Toque en la card: crea o REANUDA la sesión.
  ///
  /// **keepAlive mientras el POST vuela** (Innovation #7): el provider es
  /// autoDispose y su único oyente es la card. Si el poll del dashboard saca la
  /// reserva de la cola a mitad del POST, la card se desmonta, el notifier se
  /// dispone… y la respuesta de una escritura que PUDO crear la sesión aterriza
  /// en el vacío. El link mantiene vivo al notifier hasta el `finally`, así que
  /// la respuesta siempre se procesa (y se loguea) aunque nadie la mire.
  Future<CheckoutEntryOutcome> start() async {
    if (state.starting) return CheckoutEntryOutcome.busy;
    final gen = _generation;
    final link = ref.keepAlive();
    state = state.copyWith(starting: true, clearBlock: true);
    try {
      if (!await awaitActiveLocationHydrated(ref)) {
        if (gen != _generation || !ref.mounted) return _aborted();
        return _block(const CheckoutEntryBlock(
          kind: CheckoutEntryBlockKind.locationNotReady,
        ));
      }
      final online = await _hasNetwork();
      // Mismo fence que sus tres hermanas: el plugin de conectividad es un
      // canal de plataforma y el agente puede cambiar de sede durante ese
      // await. Sin esto se publicaría un bloqueo del alcance VIEJO en el
      // nuevo.
      if (gen != _generation || !ref.mounted) return _aborted();
      if (!online) {
        // Corte honesto ANTES de gastar el timeout completo de Dio con la
        // radio apagada. Un Wi-Fi cautivo dice "hay red" y ahí el veredicto lo
        // da la request — por eso esto solo corta el "no" rotundo.
        //
        // Es el único punto donde `offline` es la verdad: nada salió del
        // aparato. Si el POST llega a salir, su fallo de red es
        // `connectionLost` (ver classifyEntryError).
        return _block(const CheckoutEntryBlock(
          kind: CheckoutEntryBlockKind.offline,
        ));
      }

      final hadHeader = ref.read(activeLocationProvider).isPinned;
      try {
        await _api.createForReservation(reservationId);
        if (gen != _generation || !ref.mounted) return _aborted();
        _logger.log(CheckoutEvents.entryOpen);
        return CheckoutEntryOutcome.opened;
      } on ApiError catch (e) {
        if (gen != _generation || !ref.mounted) return _aborted();
        return _block(classifyEntryError(e, requestHadHeader: hadHeader));
      }
    } finally {
      if (gen == _generation && ref.mounted) {
        state = state.copyWith(starting: false);
      }
      link.close();
    }
  }

  /// El alcance cambió con la escritura en vuelo. NO se publica estado (sería
  /// del alcance anterior) pero tampoco se traga: se cuenta y el outcome es
  /// distinto de [CheckoutEntryOutcome.busy] — tragarse un doble tap es
  /// correcto; tragarse un POST abortado que pudo crear la sesión, no.
  CheckoutEntryOutcome _aborted() {
    if (ref.mounted) {
      _logger.log(
        CheckoutEvents.entryBlocked,
        data: {'code': CheckoutEntryBlockKind.scopeChanged.name},
      );
    }
    return CheckoutEntryOutcome.aborted;
  }

  /// Publica el guard, lo cuenta y traduce a outcome. La sesión terminal es el
  /// único bloqueo que además NAVEGA: su pantalla es el wizard.
  CheckoutEntryOutcome _block(CheckoutEntryBlock block) {
    state = state.copyWith(block: block);
    _logger.log(
      CheckoutEvents.entryBlocked,
      // El code del servidor cuando existe; si no, el motivo local con el que
      // se cortó (offline / location_not_ready) — jamás un 'none' que mezcle
      // "no había red" con "el backend no mandó code".
      data: {'code': block.code ?? block.kind.name},
    );
    return block.kind == CheckoutEntryBlockKind.terminal
        ? CheckoutEntryOutcome.terminal
        : CheckoutEntryOutcome.blocked;
  }

  /// Salida real del frame 11B: `POST /:id/send-request-email` con
  /// `kind: customer-info`. El sheet se queda ABIERTO y muestra el resultado
  /// ahí mismo — un toast que se va no sirve de comprobante en el patio.
  Future<void> sendPrecheckinLink() async {
    if (state.sendingLink) return;
    final gen = _generation;
    state = state.copyWith(
      sendingLink: true,
      clearLinkError: true,
      linkSent: false,
    );
    try {
      final result = await _reservations.sendPrecheckinLink(reservationId);
      if (gen != _generation || !ref.mounted) return;
      if (result.sent) {
        state = state.copyWith(linkSent: true);
        _logger.log(CheckoutEvents.entryPrecheckinLinkSent);
      } else {
        // 200 con `emailSent:false`: el token existe pero el correo NO salió.
        // Se reporta como fallo porque para el agente ES un fallo.
        state = state.copyWith(
          linkError: ApiError(
            kind: ApiErrorKind.server,
            message: result.warning ?? '',
          ),
        );
      }
    } on ApiError catch (e) {
      if (gen != _generation || !ref.mounted) return;
      state = state.copyWith(linkError: e);
    } finally {
      if (gen == _generation && ref.mounted) {
        state = state.copyWith(sendingLink: false);
      }
    }
  }

  /// El agente cerró el sheet: el guard deja de estar pendiente (y con él la
  /// confirmación del link, que pertenece a ese sheet y no a la card).
  void dismissBlock() {
    state = const CheckoutEntryState();
  }

  Future<bool> _hasNetwork() async {
    try {
      return await ref.read(networkStatusProvider).hasNetwork();
    } catch (_) {
      // Sin plugin de conectividad se opera como si hubiera red: el veredicto
      // real lo da la request (misma regla que el wizard).
      return true;
    }
  }
}

/// autoDispose + family por reserva: el estado "abriendo" pertenece a UNA
/// card, y al salir de la home no debe quedar ningún Notifier vivo (INN MC-1
/// del wizard). Sin timers dentro, así que el costo por card es una fila de
/// estado inmutable.
final checkoutEntryProvider = NotifierProvider.autoDispose
    .family<CheckoutEntryController, CheckoutEntryState, String>(
  CheckoutEntryController.new,
);
