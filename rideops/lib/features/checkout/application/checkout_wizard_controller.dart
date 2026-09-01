import 'dart:async';
import 'dart:math';

import 'package:clock/clock.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/api/api_error.dart';
import '../../../core/api/api_providers.dart';
import '../../../core/api/checkout_api.dart';
import '../../../core/api/dto/checkout_session.dart';
import '../../../core/api/dto/reservation_display.dart';
import '../../../core/api/enums.dart';
import '../../../core/lifecycle/app_visibility.dart';
import '../../../core/outbox/network_status.dart';
import '../../../core/session/active_location.dart';
import '../../../core/session/session_controller.dart';
import '../../../core/telemetry/event_logger.dart';
import '../domain/checkout_attribution.dart';
import '../domain/checkout_changes.dart';
import '../domain/checkout_confirm.dart';
import '../domain/checkout_entry.dart';
import '../domain/checkout_event_log.dart';
import '../domain/checkout_step_catalog.dart';
import 'checkout_wizard_state.dart';

/// Ritmo del poll del wizard — inyectable para que fakeAsync mueva el reloj.
class CheckoutPollConfig {
  CheckoutPollConfig({
    this.baseInterval = const Duration(seconds: 5),
    this.slowInterval = const Duration(seconds: 15),
    this.unchangedCyclesBeforeSlowLane = 3,
    this.preTransitionMaxAge = const Duration(seconds: 3),
    this.backoffCap = const Duration(minutes: 5),
    Random? random,
  }) : random = random ?? Random();

  /// 5 s con el wizard abierto: es la ventana en la que el kiosco puede
  /// firmar T&C mientras el agente mira la pantalla.
  final Duration baseInterval;

  /// Carril lento tras [unchangedCyclesBeforeSlowLane] ciclos sin cambio: la
  /// sesión que no se mueve no merece 12 requests por minuto por teléfono.
  final Duration slowInterval;
  final int unchangedCyclesBeforeSlowLane;

  /// Nota 7 del mockup: antes de transicionar, si la última lectura tiene más
  /// de esto, se re-consulta. Achica la ventana read-then-write que
  /// `stampSideEffect` deja abierta (checkout-session.service.js:621-645).
  final Duration preTransitionMaxAge;

  /// Tope del backoff DECORRELACIONADO ante 429/503 — mismo mecanismo que el
  /// poller del dashboard (SC-7 del review): un carril lento fijo devuelve a
  /// N teléfonos en coro cada 15 s contra un backend que ya está pidiendo
  /// aire; el decorrelacionado los dispersa.
  final Duration backoffCap;
  final Random random;
}

final Provider<CheckoutPollConfig> checkoutPollConfigProvider =
    Provider<CheckoutPollConfig>((ref) => CheckoutPollConfig());

/// Controller del shell del wizard (M2-H1, mockup 8A-8F).
///
/// ADR-4 hasta las últimas consecuencias:
///  - `GET /by-reservation/:rid` es la fuente de verdad al entrar; después el
///    poll lee `GET /:id`.
///  - Aquí NO vive ninguna copia de la máquina de estados: nadie calcula el
///    paso siguiente, nadie "corrige" al servidor y un `currentStep`
///    desconocido se propaga tal cual a la UI (que lo dibuja genérico).
///  - Todo 409 se resuelve re-consultando y reconciliando; jamás reintentando.
///
/// ADR-5 recordado donde importa: **ningún paso del checkout entra a la
/// bandeja de salida**. La bandeja existe para evidencia de inspección
/// (fotos/complete). Aquí, sin red, se ESPERA — y se dice por qué.
class CheckoutWizardController extends Notifier<CheckoutWizardState> {
  CheckoutWizardController(this.reservationId);

  final String reservationId;

  /// Invalida timers/fetches en vuelo cuando build se rehace (cambio de sede,
  /// login/logout) — mismo patrón que el dashboard.
  int _generation = 0;
  Timer? _timer;
  StreamSubscription<void>? _reconnect;
  bool _inFlight = false;
  int _unchangedCycles = 0;
  bool _slowLane = false;
  Duration? _backoff;

  /// FENCING de respuestas (INN MC-2). El problema real: un tick del poll sale
  /// volando, el agente transiciona, el POST responde primero y DESPUÉS
  /// aterriza el GET viejo. Sin fence, esa lectura obsoleta publica un estado
  /// ANTERIOR, el stepper retrocede, y se emite `checkout.reconciled` con
  /// `steps_jumped` negativo — corrompiendo justo la métrica con la que el
  /// épico mide su SHIP.
  ///
  /// Dos cinturones, en este orden:
  ///  1. [stateVersion] del servidor (P2) cuando existe: una lectura con
  ///     versión MENOR que la aplicada es un fantasma del pasado.
  ///  2. [_writeEpoch] local: sube en cada aplicación de una ESCRITURA
  ///     (transition/abandon). Toda lectura captura el epoch al despachar y
  ///     se descarta si cambió mientras viajaba. Funciona con backend viejo,
  ///     donde `stateVersion` llega null.
  int _writeEpoch = 0;

  /// Última `stateVersion` efectivamente aplicada (null mientras el backend
  /// no emita la columna).
  int? _appliedVersion;

  /// Último paso REPORTADO que ya se logueó como renderizado — evita que
  /// `checkout.step_rendered` se emita por tick del poll.
  String? _renderedStep;

  /// Último movimiento ya contado como `checkout.reconciled` (`FROM>TO`).
  ///
  /// Sin esto, UN SOLO 409 emitía el evento DOS veces: `_refetchQuiet` aplica
  /// la lectura fresca (y `_apply` ya loguea porque el paso se movió) y
  /// después `_resolveConflict` volvía a loguear el MISMO movimiento. El
  /// resultado era ×2 en la frecuencia de `via:conflict` y en `steps_jumped`
  /// — o sea, la métrica con la que el épico mide cuánto se pisan las
  /// superficies, y sobre la que se apoya la prueba de concurrencia en
  /// staging, contando el doble. Un movimiento = un evento.
  String? _reconciledMovement;

  @override
  CheckoutWizardState build() {
    _generation++;
    final gen = _generation;
    _timer?.cancel();
    _reconnect?.cancel();
    _inFlight = false;
    _unchangedCycles = 0;
    _slowLane = false;
    _backoff = null;
    _writeEpoch = 0;
    _appliedVersion = null;
    _renderedStep = null;
    _reconciledMovement = null;
    ref.onDispose(() {
      _timer?.cancel();
      _reconnect?.cancel();
    });

    final authed =
        ref.watch(sessionControllerProvider.select((s) => s.isAuthenticated));
    final location = ref.watch(activeLocationProvider);

    // Pausa TOTAL en background (el poll de 5 s en el bolsillo sería una
    // sangría de batería y de rate-limit); refresh inmediato al volver, que
    // es justo cuando el dato viejo más miente.
    ref.listen<bool>(appVisibilityProvider, (prev, visible) {
      if (!visible) {
        _timer?.cancel();
      } else if (prev == false) {
        unawaited(refresh());
      }
    });

    if (!authed || !location.hydrated) {
      return const CheckoutWizardState.pending();
    }

    _watchNetwork(gen);
    Future.microtask(() => _load(gen));
    return const CheckoutWizardState(fetching: true);
  }

  CheckoutApi get _api => ref.read(checkoutApiProvider);
  CheckoutPollConfig get _cfg => ref.read(checkoutPollConfigProvider);
  EventLogger get _logger => ref.read(eventLoggerProvider);
  String? get _myUserId => ref.read(sessionControllerProvider).user?.id;

  // ── red ──────────────────────────────────────────────────────────────────

  void _watchNetwork(int gen) {
    final net = ref.read(networkStatusProvider);
    unawaited(() async {
      try {
        final has = await net.hasNetwork();
        if (gen != _generation || !ref.mounted) return;
        state = state.copyWith(networkAvailable: has);
      } catch (_) {
        // Sin plugin de conectividad se opera como si hubiera red: el
        // veredicto real lo da la request (y su ApiError de red).
      }
    }());
    _reconnect = net.onReconnected.listen((_) {
      if (gen != _generation || !ref.mounted) return;
      state = state.copyWith(networkAvailable: true);
      unawaited(refresh());
    });
  }

  // ── lectura ──────────────────────────────────────────────────────────────

  /// Fetch manual: reintento del agente, resume de la app, "Reintentar ahora"
  /// del banner offline.
  Future<void> refresh() async {
    final id = state.session?.id;
    if (id == null) return _load(_generation, byUser: true);
    return _poll(_generation, byUser: true);
  }

  /// Primera lectura: `by-reservation` es la fuente de verdad al entrar.
  ///
  /// [byUser] false = arranque automático ⇒ sin retry por-request del
  /// interceptor (el timer ya trae su propio backoff). El reintento del
  /// AGENTE sí lo conserva: ahí hay un humano esperando UNA respuesta.
  Future<void> _load(int gen, {bool byUser = false}) async {
    if (gen != _generation || !ref.mounted) return;
    // Gate propio (no basta el de `_scheduleNext`): el listener de visibilidad
    // se registra ANTES del gate de arranque, así que un background→foreground
    // sin sesión o con la sede a medio hidratar entraba aquí y disparaba un
    // GET real — sin bearer útil, o sin el header `x-view-location`.
    if (!ref.read(sessionControllerProvider).isAuthenticated ||
        !ref.read(activeLocationProvider).hydrated) {
      return;
    }
    if (_inFlight) return;
    _inFlight = true;
    state = state.copyWith(fetching: true, clearError: true);
    final hadHeader = ref.read(activeLocationProvider).isPinned;
    final epoch = _writeEpoch;
    try {
      final session = await _api.getByReservation(
        reservationId,
        skipRateLimitRetry: !byUser,
      );
      if (gen != _generation || !ref.mounted) return;
      if (session == null) {
        // 404: la reserva no tiene sesión. NO es error — crearla es H7, con
        // su matriz de guards (422 PRECHECKIN_REQUIRED / AGE_RULES_*, 409
        // VEHICLE_CONFLICT / SESSION_TERMINAL).
        state = state.copyWith(fetching: false, notFound: true);
        return;
      }
      if (!_isStaleRead(session, epoch)) {
        _apply(session, detectForeign: false);
        unawaited(_loadContext(gen, via: 'open'));
      }
    } on ApiError catch (e) {
      if (gen != _generation || !ref.mounted) return;
      _onReadError(e, hadHeader: hadHeader);
    } finally {
      if (gen == _generation) _inFlight = false;
    }
    _scheduleNext(gen);
  }

  /// Tick del poll (o refresh manual con sesión ya cargada).
  Future<void> _poll(int gen, {bool byUser = false}) async {
    if (gen != _generation || !ref.mounted) return;
    final id = state.session?.id;
    if (id == null) return;
    // Skip si hay request en vuelo: no encimar, pero el reloj sigue.
    if (_inFlight) return;
    // Y skip mientras hay una ESCRITURA viva (transición, pausa, o las del
    // paso: seguro declinado / swap): la respuesta del POST es más nueva por
    // definición, y una lectura lanzada en paralelo solo puede aterrizar tarde
    // y vieja (INN MC-2). El refresh manual del agente respeta lo mismo — no
    // hay nada que refrescar cuando la escritura que va a cambiar el estado ya
    // está en vuelo.
    if (state.transitionInFlight || state.pausing || state.isMutating) return;
    _inFlight = true;
    if (byUser) state = state.copyWith(fetching: true);
    final hadHeader = ref.read(activeLocationProvider).isPinned;
    final epoch = _writeEpoch;
    try {
      final fresh = await _api.getSession(id, skipRateLimitRetry: !byUser);
      if (gen != _generation || !ref.mounted) return;
      // Descartar una lectura obsoleta NO puede matar el poll: se salta el
      // cuerpo, pero el reloj se re-arma abajo igual (si esto hiciera
      // `return`, una sola carrera dejaría la pantalla congelada para
      // siempre — lo cazó el test del cinturón de stateVersion).
      if (_isStaleRead(fresh, epoch)) {
        // Descartada, pero CUENTA como ciclo sin cambio: un bucle patológico
        // de réplica atrasada dejaría el poll a 5 s para siempre pidiendo
        // lecturas que nunca se aplican.
        _noteUnchangedCycle();
      } else {
        final changed = _hasMaterialChange(state.session, fresh);
        _apply(fresh, detectForeign: true);
        if (changed) {
          _unchangedCycles = 0;
          _slowLane = false;
          _backoff = null;
        } else {
          _noteUnchangedCycle();
        }
      }
    } on ApiError catch (e) {
      if (gen != _generation || !ref.mounted) return;
      _onReadError(e, hadHeader: hadHeader);
    } finally {
      if (gen == _generation) _inFlight = false;
    }
    _scheduleNext(gen);
  }

  void _noteUnchangedCycle() {
    _unchangedCycles++;
    if (_unchangedCycles >= _cfg.unchangedCyclesBeforeSlowLane) {
      _slowLane = true;
    }
  }

  /// ¿Esta respuesta de LECTURA llegó tarde y trae un estado ya superado?
  ///
  /// Se descarta en silencio (no es un error: es una carrera normal con 4
  /// superficies y un poll de 5 s). Publicarla haría retroceder el stepper y
  /// emitiría un `checkout.reconciled` con `steps_jumped` negativo.
  bool _isStaleRead(CheckoutSessionDto fresh, int dispatchEpoch) {
    // Cinturón 1 — versión del servidor (P2), cuando ambas existen.
    final applied = _appliedVersion;
    final incoming = fresh.stateVersion;
    if (applied != null && incoming != null && incoming < applied) return true;
    // Cinturón 2 — epoch local: hubo una escritura aplicada mientras esta
    // lectura viajaba. Sirve igual con backend viejo (stateVersion null).
    return dispatchEpoch != _writeEpoch;
  }

  /// Cambio MATERIAL: el paso, o cualquiera de los 4 sellos. Un sello puede
  /// moverse sin que el paso cambie (el cliente firmó T&C mientras el agente
  /// mira) y eso abre guards de entrada — vale tanto como un cambio de paso.
  bool _hasMaterialChange(CheckoutSessionDto? prev, CheckoutSessionDto fresh) {
    if (prev == null) return true;
    return prev.currentStep != fresh.currentStep ||
        prev.stamps != fresh.stamps ||
        prev.abandonedAt != fresh.abandonedAt;
  }

  void _onReadError(ApiError e, {required bool hadHeader}) {
    final denied = e.isViewLocationDenied(requestHadHeader: hadHeader);
    if (e.kind == ApiErrorKind.rateLimited || e.status == 503) {
      // 429 absorbido por el TIMER (el interceptor ya respeta Retry-After por
      // request, y el poll le pide que no reintente: amplificar 4× un 429
      // sostenido no ayuda a nadie).
      _enterBackoff();
      _logger.log(NetEvents.request429Backoff, data: {'route': _pollRoute});
    }
    // El dato viejo NO se borra: se queda con su edad visible (8D).
    state = state.copyWith(
      fetching: false,
      error: e,
      viewLocationDenied: denied,
      networkAvailable:
          e.kind == ApiErrorKind.network ? false : state.networkAvailable,
    );
  }

  static const _pollRoute = '/api/checkout-sessions/:id';

  /// Re-lee display-data para VERIFICAR si la entrega quedó registrada (19A/
  /// 19B). No se usa `state.context` cacheado a propósito: la pregunta es qué
  /// dice el servidor AHORA, después del cierre.
  ///
  /// Devuelve `null` cuando no hay veredicto — display-data no respondió, o
  /// mandó un estado que esta versión no conoce. **Null no es "no quedó
  /// registrada"**: es "no lo sé", y la UI lo dice así en vez de acusar a la
  /// cascada de algo que no vio.
  Future<bool?> verifyHandover() async {
    final display = await _loadContext(_generation, via: 'verify_handover');
    return ReservationStatus.tryParse(display?.reservation.status)
        ?.handoverRecorded;
  }

  /// Vuelve a preguntarle a `display-data`, y NADA MÁS.
  ///
  /// Es la salida del paso CONFIRMING cuando la consulta no llegó: una acción
  /// que de verdad puede tener éxito (misma regla de puertas falsas que 19A-bis
  /// — "Volver a comprobar" es una consulta, jamás un reintento del cierre).
  /// Devuelve el veredicto que quedó, para que la pantalla lo cuente.
  Future<ContextVerdict> retryContext() async {
    await _loadContext(_generation, via: 'confirm_retry');
    return state.contextVerdict;
  }

  /// Contexto de la reserva para el header de sesión y las tarjetas de
  /// verificación (9A/9B).
  ///
  /// **Ya NO es "best-effort silencioso".** Lo era —`catch (_) { return
  /// null; }` con el comentario "el header muestra menos, nada más"— y ese
  /// comentario era falso: display-data es la única fuente del nombre, la
  /// licencia y el teléfono que el paso 1 confronta con la licencia física.
  /// Con la consulta caída, el null bajaba a `customerCheck`, se contaba como
  /// datos FALTANTES, bloqueaba "Continuar a T&C" y le decía al agente que "el
  /// servidor sigue sin el nombre, la licencia y el teléfono" — con el
  /// servidor teniendo los tres. El fallo se anota en el estado (veredicto +
  /// negativa cruda) y la pantalla decide qué contar.
  ///
  /// [via] identifica QUIÉN pidió la lectura. No es adorno: esta misma función
  /// la llaman el arranque, el swap, el reintento del paso 1 y la
  /// verificación de la entrega del cierre, y sin el tag el evento de fallo
  /// mezclaría "el paso 1 no puede verificar identidad" con "la comprobación
  /// post-cierre no llegó", que son dos incidentes distintos.
  Future<ReservationDisplayData?> _loadContext(
    int gen, {
    required String via,
  }) async {
    // Solo se declara "consultando" cuando NO hay nada en la mano. Con una
    // respuesta previa guardada manda la regla 8D del wizard: el dato viejo se
    // queda, y parpadear a "Consultando…" en cada re-lectura (la del swap, por
    // ejemplo) vaciaría la tarjeta que el agente está leyendo en voz alta.
    if (gen == _generation && ref.mounted && state.context == null) {
      state = state.copyWith(contextVerdict: ContextVerdict.checking);
    }
    try {
      final display =
          await ref.read(reservationsApiProvider).getDisplayData(reservationId);
      if (gen != _generation || !ref.mounted) return null;
      final reservation = display.reservation;
      state = state.copyWith(
        contextVerdict: ContextVerdict.answered,
        clearContextError: true,
        // El sello de frescura del DATO DEL CLIENTE. Sin él, una consulta
        // caída con el poll sano dejaba la tarjeta en verde sobre un payload
        // de hace diez minutos y nadie podía decir cuánto.
        contextFetchedAt: clock.now(),
        // Llegó respuesta: lo que se pinta ya es post-swap. La única forma de
        // apagar esta bandera es esta — un reintento que TAMPOCO llega deja
        // la unidad vieja en pantalla y la bandera encendida.
        contextStaleAfterSwap: false,
        context: CheckoutReservationContext(
          reservationNumber: reservation.reservationNumber,
          customerName: reservation.customer?.fullName,
          vehicleLabel: reservation.vehicle?.label,
          plate: reservation.vehicle?.plate,
          odometer: reservation.vehicle?.mileage,
          pickupAt: reservation.pickupAt,
          precheckinDone: reservation.customerInfoCompletedAt != null,
          precheckinAt: reservation.customerInfoCompletedAt,
          workflowMode: reservation.workflowMode,
          // Superficie de STAFF: el nombre del tenant sí se muestra aquí.
          tenantName: display.branding.companyName.isEmpty
              ? null
              : display.branding.companyName,
          customer: reservation.customer,
          agreement: reservation.rentalAgreement,
          vehicleId: reservation.vehicle?.id,
          vehicleStatus: reservation.vehicle?.status,
          vehicleTypeId: reservation.vehicleTypeId,
          branding: display.branding,
          returnAt: reservation.returnAt,
          returnLocationName: reservation.returnLocation?.name,
          reservationStatus: reservation.status,
        ),
      );
      return display;
    } catch (e) {
      if (gen != _generation || !ref.mounted) return null;
      final error = e is ApiError ? e : null;
      // **El dato viejo NO se borra** (regla 8D del wizard): si una lectura
      // anterior SÍ respondió, esa respuesta sigue siendo lo que el servidor
      // dijo y la tarjeta la sigue mostrando. Pero tampoco se queda igual —
      // pasa a `stale`, que es lo que le devuelve la EDAD a la pantalla. El
      // shell no puede hacerlo por ella: su vejez cuelga de `offline`, que
      // sale del error de la SESIÓN, y display-data se cae por su cuenta.
      final stale = state.context != null;
      state = state.copyWith(
        contextVerdict:
            stale ? ContextVerdict.stale : ContextVerdict.unreachable,
        // El swap SÍ se aplicó en el servidor (esta lectura viene después de
        // un POST /vehicle con 200) y la re-lectura no llegó: lo que queda en
        // pantalla es la unidad REEMPLAZADA. Eso no es "un dato viejo", es un
        // dato que contradice al servidor, y la tarjeta del vehículo tiene
        // que decirlo. Se conserva encendida si ya lo estaba: un segundo
        // intento fallido no devuelve la unidad nueva a la pantalla.
        contextStaleAfterSwap:
            stale && (via == 'swap' || state.contextStaleAfterSwap),
        // La negativa solo se guarda cuando es lo ÚNICO que hay que contar.
        // Con datos en pantalla, citar un 500 al lado del nombre del cliente
        // le da cuerpo de error a una tarjeta que sigue siendo utilizable.
        contextError: stale ? null : error,
        clearContextError: stale || error == null,
      );
      _logger.log(
        CheckoutEvents.contextUnreachable,
        data: {
          // `status` es el del servidor cuando hubo respuesta; sin respuesta el
          // tag es `network`, que es una causa distinta y se mide aparte.
          'status': error?.status?.toString() ??
              (error?.kind == ApiErrorKind.network ? 'network' : 'none'),
          // Con `stale:true` el agente sigue viendo datos buenos (con su edad)
          // y la entrega no se detiene; con `false` el paso 1 queda sin poder
          // verificar. Son dos incidentes distintos y no se pueden sumar.
          'stale': stale,
          'via': via,
        },
      );
      return null;
    }
  }

  /// Aplica una lectura fresca. [detectForeign] enciende la detección de
  /// avance ajeno (8C): SOLO para lecturas del servidor que no provocamos
  /// nosotros — la respuesta de nuestro propio POST jamás debe banderizarse
  /// como "otra superficie avanzó".
  ///
  /// [isWrite] marca las respuestas de POST (transition/abandon): suben el
  /// epoch de escritura, que invalida toda lectura que venga viajando.
  void _apply(
    CheckoutSessionDto fresh, {
    required bool detectForeign,
    String via = 'poll',
    bool isWrite = false,
  }) {
    final prev = state.session;
    var advance = state.advance;
    if (isWrite) _writeEpoch++;
    // La firma del cliente LLEGÓ mientras mirábamos (10C). Se emite una sola
    // vez, en la lectura que ve el sello caer de null a fechado: es la métrica
    // de "el QR funcionó" y el paso T&C no tiene otra señal de éxito. Requiere
    // [prev] no nulo — encontrar el sello ya puesto al ENTRAR no es un evento,
    // es el estado de la sesión.
    if (prev != null &&
        prev.tcCompletedAt == null &&
        fresh.tcCompletedAt != null) {
      _logger.log(CheckoutEvents.termsSignedSeen);
    }
    if (fresh.stateVersion != null) _appliedVersion = fresh.stateVersion;
    if (detectForeign && prev != null) {
      if (prev.currentStep != fresh.currentStep) {
        final notice = _foreignStepMove(prev, fresh);
        if (notice == null) {
          // Fuimos nosotros (otro teléfono, o nuestro POST que ya se aplicó):
          // el stepper se mueve, pero no hay a quién atribuirle nada.
          advance = null;
        } else {
          advance = notice;
          _logReconciled(
            from: prev.step,
            to: fresh.step,
            fromRaw: prev.currentStep,
            toRaw: fresh.currentStep,
            via: via,
          );
        }
      } else {
        // M2-H6, frame 21C: el paso NO se movió pero cayó un SELLO. Pasa de
        // verdad —el mostrador registra el pago mientras el agente teclea el
        // odómetro en el paso 7— y hasta H6 era invisible: `_hasMaterialChange`
        // ya lo detectaba para el ritmo del poll, pero nadie se lo contaba al
        // agente.
        //
        // NO se emite `checkout.reconciled`: no hubo movimiento que reconciliar
        // y contarlo inflaría la métrica con la que el épico mide cuánto se
        // pisan las superficies (un sello y un salto de paso no son lo mismo).
        final landed = _landedStamp(prev, fresh);
        if (landed != null) advance = landed;
      }
    }
    // La presencia SOBREVIVE a una respuesta que no la trae (INN SC-2): los
    // POST de transition/abandon no pasan por `withPresence()`, así que
    // adoptar su `presence: null` borraría el chip justo en el instante de
    // máxima colisión — cuando el agente acaba de escribir y el compañero del
    // kiosco sigue ahí. Solo una LECTURA que sí trae el campo puede cambiarlo.
    final merged = fresh.presence == null && prev?.presence != null
        ? fresh.copyWith(presence: prev!.presence)
        : fresh;
    state = state.copyWith(
      session: merged,
      fetchedAt: clock.now(),
      fetching: false,
      clearError: true,
      notFound: false,
      viewLocationDenied: false,
      // Una lectura que RESPONDE prueba que hay red, diga lo que diga el
      // plugin de conectividad (que reporta interfaz, no internet).
      networkAvailable: true,
      advance: advance,
      clearAdvance: advance == null,
      // "Desde que entraste" se congela en la PRIMERA lectura y no se vuelve
      // a tocar: si se moviera con cada poll, el diff de 21B diría "no cambió
      // nada" treinta segundos después de que cambiara todo.
      baseline: state.baseline ?? merged,
    );
    _logStepRendered(fresh.currentStep);
    _heartbeat(fresh.id);
  }

  /// Avance ajeno POR MOVIMIENTO DE PASO. Null cuando fuimos nosotros.
  ForeignAdvanceNotice? _foreignStepMove(
    CheckoutSessionDto prev,
    CheckoutSessionDto fresh,
  ) {
    final events = parseCheckoutEvents(fresh.events);
    final event = lastTransitionTo(events, fresh.currentStep);
    final actor = event?.actorKind(_myUserId) ?? CheckoutActorKind.otherSurface;
    if (actor == CheckoutActorKind.you) return null;
    return ForeignAdvanceNotice(
      completedStep: prev.currentStep,
      currentStep: fresh.currentStep,
      actor: actor,
      at: event?.at,
      // Nombre propio cuando la presencia lo resuelve; null ⇒ el banner cae
      // al copy genérico de H1. Único punto de consumo de
      // `presence[].actorUserId` (checkout_attribution.dart).
      actorName: resolveActorName(
        event,
        namesById: presenceNamesById(fresh.presence ?? prev.presence),
        myUserId: _myUserId,
      ),
    );
  }

  /// Sello que cayó SIN que el paso se moviera (21C). Se reporta uno solo —el
  /// primero de la cadena que cambió— porque el banner tiene una línea, no
  /// una lista: la lista completa vive en "Ver qué cambió".
  ForeignAdvanceNotice? _landedStamp(
    CheckoutSessionDto prev,
    CheckoutSessionDto fresh,
  ) {
    final before = prev.stamps;
    final now = fresh.stamps;
    final (kind, field) = switch (null) {
      _ when before.tc == null && now.tc != null => (
          CheckoutStampKind.tc,
          'tcCompletedAt'
        ),
      _ when before.payment == null && now.payment != null => (
          CheckoutStampKind.payment,
          'paymentCompletedAt'
        ),
      _ when before.inspection == null && now.inspection != null => (
          CheckoutStampKind.inspection,
          'inspectionCompletedAt'
        ),
      _ when before.signature == null && now.signature != null => (
          CheckoutStampKind.signature,
          'customerSignedAt'
        ),
      _ => (null, null),
    };
    if (kind == null || field == null) return null;
    // Y NO se avisa del sello que este paso está esperando: en `TC_PENDING` el
    // agente enseña el QR justo para que caiga `tcCompletedAt`, y anunciárselo
    // como noticia ajena sería contarle el resultado de su propio trabajo —
    // el paso ya tiene su estado de éxito. 21C es el sello que llega de un
    // tramo que la sesión ya dejó atrás.
    if (stampIsCurrentStepBusiness(kind: kind, currentStep: fresh.step)) {
      return null;
    }
    // `stampSideEffect` escribe `{kind, field, at}` y NADA más: sin actor y
    // sin marca de kiosco. Se puede fechar el sello; no se puede nombrar a
    // quien lo puso, y no se va a inventar (service:1042-1044).
    final event = lastSideEffectFor(parseCheckoutEvents(fresh.events), field);
    return ForeignAdvanceNotice(
      kind: ForeignAdvanceKind.stampLanded,
      stamp: kind,
      completedStep: prev.currentStep,
      currentStep: fresh.currentStep,
      actor: CheckoutActorKind.otherSurface,
      at: event?.at,
    );
  }

  /// Latido de presencia (M2-H6, §20). **Colgado del poll que ya existe**, no
  /// de un temporizador propio: dos relojes serían doble consumo de batería y,
  /// peor, una presencia que sobrevive al dato que la respalda.
  ///
  /// Se late solo con el wizard EN PRIMER PLANO. El latido afirma "estoy
  /// mirando esto", y un teléfono en el bolsillo no está mirando nada — por
  /// eso no se late desde el drenador de la bandeja ni en background.
  ///
  /// Fire-and-forget total: la presencia es informativa y no bloquea nada, así
  /// que su fallo **no puede** convertirse en un error de pantalla ni matar el
  /// poll del que viaja colgado. No hay `DELETE /presence` al salir y no se
  /// pide: el TTL de 45 s ES el apagado.
  void _heartbeat(String sessionId) {
    if (!ref.read(appVisibilityProvider)) return;
    if (!ref.read(sessionControllerProvider).isAuthenticated) return;
    unawaited(
      _api.heartbeatPresence(id: sessionId).catchError((_) {}),
    );
  }

  void _logStepRendered(String step) {
    if (_renderedStep == step) return;
    _renderedStep = step;
    _logger.log(CheckoutEvents.stepRendered, data: {'step': step});
  }

  /// UN movimiento = UN evento (dedup, igual que [_logStepRendered]).
  ///
  /// [from]/[to] tipados pueden ser null (paso que la app no conoce): el token
  /// cae al string crudo para no colapsar dos movimientos distintos en uno.
  void _logReconciled({
    CheckoutStep? from,
    CheckoutStep? to,
    required String via,
    String? fromRaw,
    String? toRaw,
  }) {
    // Nada se movió: no hay reconciliación que contar (p. ej. el 409 que se
    // resuelve encontrando la sesión donde ya estaba).
    if (from != null && to != null && from == to) return;
    final token = '${from?.wire ?? fromRaw ?? '?'}>${to?.wire ?? toRaw ?? '?'}';
    if (_reconciledMovement == token) return;
    _reconciledMovement = token;
    final jumped = stepsJumped(from: from, to: to);
    _logger.log(CheckoutEvents.reconciled, data: {
      'steps_jumped': ?jumped,
      'via': via,
    });
  }

  // ── poll ─────────────────────────────────────────────────────────────────

  void _scheduleNext(int gen) {
    if (gen != _generation || !ref.mounted) return;
    if (state.session == null) return; // 404 / error de arranque: no se poll-ea
    // Sesión terminal: no hay nada más que ver; el servidor no la va a mover.
    if (state.isTerminal) return;
    if (!ref.read(appVisibilityProvider)) return; // pausa total
    if (!ref.read(sessionControllerProvider).isAuthenticated) return;
    _timer?.cancel();
    _timer = Timer(
      _nextInterval(),
      () {
        if (_inFlight ||
            state.transitionInFlight ||
            state.pausing ||
            state.isMutating) {
          // Request en vuelo (una transición larga): se salta el tick, no se
          // encima — y se re-arma el reloj.
          _scheduleNext(gen);
          return;
        }
        unawaited(_poll(gen));
      },
    );
  }

  Duration _nextInterval() {
    if (_backoff != null) return _backoff!;
    return _slowLane ? _cfg.slowInterval : _cfg.baseInterval;
  }

  /// Backoff DECORRELACIONADO (mismo que el poller del dashboard): siguiente
  /// espera uniforme entre el carril lento y 3× la anterior, con tope
  /// [CheckoutPollConfig.backoffCap]. N teléfonos que entraron al throttle
  /// juntos se dispersan en vez de volver en oleadas cada 15 s.
  void _enterBackoff() {
    _slowLane = true;
    final baseMs = _cfg.slowInterval.inMilliseconds;
    final prevMs = (_backoff ?? _cfg.slowInterval).inMilliseconds;
    final upperMs = min(prevMs * 3, _cfg.backoffCap.inMilliseconds);
    final span = max(0, upperMs - baseMs);
    _backoff = Duration(
      milliseconds: baseMs + (span == 0 ? 0 : _cfg.random.nextInt(span + 1)),
    );
  }

  // ── escritura ────────────────────────────────────────────────────────────

  /// Dispara `POST /:id/transition` hacia [toStep].
  ///
  /// El `toStep` lo decide la PANTALLA del paso (H2–H5), que lo conoce por
  /// diseño de producto — aquí jamás se infiere del catálogo (ADR-4).
  ///
  /// Guards, en orden: doble-tap → terminal → sin red → re-fetch previo si la
  /// lectura tiene >3 s → POST → matriz 409.
  Future<CheckoutTransitionOutcome> transitionTo(CheckoutStep toStep) async =>
      (await attemptTransition(toStep)).outcome;

  /// Igual que [transitionTo] pero devolviendo además el CUERPO del servidor.
  /// Lo usa el cierre (M2-H5): 19B cita la negativa y necesita distinguir
  /// "el servidor dijo que no" de "no hubo respuesta".
  Future<CheckoutTransitionAttempt> attemptTransition(
    CheckoutStep toStep,
  ) async {
    const blocked = CheckoutTransitionAttempt(CheckoutTransitionOutcome.blocked);
    final session = state.session;
    if (session == null) return blocked;
    // Anti-doble-tap: el segundo tap NO manda un segundo POST (el backend
    // responde 409 a propósito, pero cobrar dos veces esa carrera en el patio
    // es exactamente lo que no queremos, service:380-391).
    if (state.transitionInFlight) return blocked;
    if (state.isTerminal) return blocked;
    if (state.offline) return blocked;

    final gen = _generation;
    final renderedStep = session.currentStep;
    state = state.copyWith(transitionInFlight: true, clearConflict: true);
    try {
      final preflight = await _preflight(gen, session, toStep, renderedStep);
      if (preflight != null) return CheckoutTransitionAttempt(preflight);

      final updated = await _api.transition(id: session.id, toStep: toStep.wire);
      if (gen != _generation || !ref.mounted) return blocked;
      // ── M2-H6 · el 200 que NO movimos nosotros ──────────────────────────
      //
      // Desde M2-H8 el backend responde **200** —no 409— cuando otra
      // superficie ya hizo exactamente esta transición: la trata como
      // idempotente y, a propósito, **no escribe evento** para que `events[]`
      // siga nombrando a quien de verdad la movió
      // (checkout-session.service.js:508-518).
      //
      // Sin esta detección H8 nos dejó un agujero silencioso justo en la
      // historia de la reconciliación: el agente toca "Continuar", el kiosco
      // ya lo había hecho, la app dice `transition_ok` como si hubiera sido
      // él, y **el banner de avance ajeno nunca aparece**. Se perdía la
      // atribución y la métrica de concurrencia a la vez.
      //
      // La regla es la de 03-observability.md §checkout.transition_noop, y es
      // la ÚNICA: **es noop cuando el último `TRANSITION` hacia el destino no
      // nos nombra**. No hay atajo por `stateVersion` — el caso que la métrica
      // vigila (v0 en FINALIZING, el kiosco commitea CLOSED → v1) lo
      // sub-reporta.
      final noop = _detectNoop(updated, toStep);
      _apply(updated, detectForeign: false, isWrite: true);
      if (noop != null) {
        state = state.copyWith(advance: noop);
        _logger.log(CheckoutEvents.transitionNoop, data: {'to': toStep.wire});
        _logReconciled(
          from: session.step,
          to: updated.step,
          fromRaw: session.currentStep,
          toRaw: updated.currentStep,
          via: 'noop',
        );
      } else {
        // Nuestro propio avance: el banner previo se retira (el agente ya
        // interactuó con el paso nuevo).
        state = state.copyWith(clearAdvance: true);
      }
      _logger.log(CheckoutEvents.transitionOk, data: {'to': toStep.wire});
      _unchangedCycles = 0;
      _slowLane = false;
      _backoff = null;
      return const CheckoutTransitionAttempt(CheckoutTransitionOutcome.ok);
    } on ApiError catch (e) {
      if (gen != _generation || !ref.mounted) return blocked;
      if (e.kind == ApiErrorKind.conflict) {
        final outcome = await _resolveConflict(gen, e, toStep);
        return CheckoutTransitionAttempt(
          outcome,
          message: e.message.isEmpty ? null : e.message,
          code: e.code,
        );
      }
      // ADR-4 llevado a donde siempre pertenecía (INN MC-1): la regla no es
      // "todo 409 se reconcilia", es **si el servidor nos rechazó, se vuelve a
      // leer**. El 409 era el único status que se había visto rechazar una
      // transición; no es el único que puede.
      //
      // El caso que lo obliga no es teórico: `transition` COMMITEA el paso
      // (checkout-session.service.js:417) y la cascada del finalize corre
      // DESPUÉS, así que `NO_VEHICLE_ASSIGNED` (:464-468) y los gates
      // re-evaluados (:473 → PRECHECKIN_REQUIRED / AGE_RULES_*, lanzados con
      // 422 en :81-98) escapan con la sesión YA cerrada, y la ruta preserva su
      // status (routes:12-16). Sin esta re-lectura el cliente se queda
      // creyendo que sigue en FINALIZING y ofrece un "Reintentar el cierre"
      // que el servidor no puede cumplir nunca (`canTransition` es false desde
      // terminal, state-machine.js:94): una puerta falsa.
      //
      // Se re-lee SOLO en [ApiErrorKind.badRequest] — el 4xx que el SERVICIO
      // produjo después de mirar la fila (400/404/422). No en 401/403/429/410:
      // esos ni siquiera llegaron al servicio, un 401 solo puede responder
      // otro 401, y re-consultar un 429 sería empujar a un backend que ya está
      // pidiendo aire.
      if (e.kind == ApiErrorKind.badRequest) {
        await _refetchQuiet(gen, via: 'rejected');
        if (gen != _generation || !ref.mounted) return blocked;
      }
      // El error se publica DESPUÉS del re-fetch a propósito: `_apply` limpia
      // `error`, y la negativa del servidor es justo lo que la pantalla tiene
      // que seguir mostrando.
      state = state.copyWith(
        error: e,
        networkAvailable:
            e.kind == ApiErrorKind.network ? false : state.networkAvailable,
      );
      return CheckoutTransitionAttempt(
        CheckoutTransitionOutcome.failed,
        message: e.message.isEmpty ? null : e.message,
        code: e.code,
        network: e.kind == ApiErrorKind.network,
      );
    } finally {
      if (gen == _generation && ref.mounted) {
        state = state.copyWith(transitionInFlight: false);
      }
      _scheduleNext(gen);
    }
  }

  /// ¿Este 200 lo movió OTRA superficie? (M2-H8 idempotente.)
  ///
  /// Devuelve el aviso a mostrar, o null cuando el avance es nuestro o cuando
  /// **no se puede afirmar** que no lo sea. Los dos casos de "no se puede
  /// afirmar" son deliberados y van hacia el mismo lado seguro — no acusar:
  ///
  ///  - **sin `myUserId`** (sesión degradada sin `/me`): `actorKind` no puede
  ///    devolver `you` NUNCA, así que sin este guard TODA transición propia se
  ///    marcaría como ajena. Sería el peor de los dos errores: un banner que
  ///    le dice al agente que otro hizo su propio trabajo.
  ///  - **sin evento** (log truncado, corrupto, o fila vieja): no hay prueba
  ///    de que fuera otro. Se calla.
  ForeignAdvanceNotice? _detectNoop(
    CheckoutSessionDto updated,
    CheckoutStep toStep,
  ) {
    final me = _myUserId;
    if (me == null) return null;
    final events = parseCheckoutEvents(updated.events);
    final event = lastTransitionTo(events, toStep.wire);
    if (event == null) return null;
    final actor = event.actorKind(me);
    if (actor == CheckoutActorKind.you) return null;
    return ForeignAdvanceNotice(
      completedStep: toStep.wire,
      currentStep: updated.currentStep,
      actor: actor,
      at: event.at,
      actorName: resolveActorName(
        event,
        namesById: presenceNamesById(updated.presence ?? state.session?.presence),
        myUserId: me,
      ),
    );
  }

  /// Re-fetch previo a la transición (nota 7 del mockup). Devuelve non-null
  /// cuando el POST NO debe salir.
  Future<CheckoutTransitionOutcome?> _preflight(
    int gen,
    CheckoutSessionDto session,
    CheckoutStep toStep,
    String renderedStep,
  ) async {
    final fetchedAt = state.fetchedAt;
    final age = fetchedAt == null
        ? const Duration(days: 1)
        : clock.now().difference(fetchedAt);
    if (age <= _cfg.preTransitionMaxAge) return null;

    // Sin skipRateLimitRetry: hay un humano con el dedo en el botón esperando
    // ESTA respuesta antes de que salga la escritura.
    final fresh = await _api.getSession(session.id);
    if (gen != _generation || !ref.mounted) {
      return CheckoutTransitionOutcome.blocked;
    }
    // `via: preflight` — esta reconciliación NO vino de un 409 (SC-4): mezclar
    // ambas mentiría sobre cuántas colisiones reales produce el patio.
    _apply(fresh, detectForeign: true, via: 'preflight');
    if (fresh.currentStep == renderedStep) return null;

    // El servidor se movió mientras el agente decidía.
    if (isAtOrPast(current: fresh.step, target: toStep)) {
      return CheckoutTransitionOutcome.alreadyDone;
    }
    return CheckoutTransitionOutcome.reconciled;
  }

  /// Matriz 409 completa (ADR-4). SIEMPRE re-fetch → re-render; nunca un
  /// reintento a ciegas.
  Future<CheckoutTransitionOutcome> _resolveConflict(
    int gen,
    ApiError e,
    CheckoutStep toStep,
  ) async {
    _logger.log(CheckoutEvents.transition409, data: {'code': e.code ?? 'none'});
    final before = state.session?.step;
    final beforeRaw = state.session?.currentStep;
    final fresh = await _refetchQuiet(gen);
    if (gen != _generation || !ref.mounted) {
      return CheckoutTransitionOutcome.blocked;
    }

    switch (e.code) {
      case 'ILLEGAL_TRANSITION':
        // El caso normal con 4 superficies: el paso ya lo hizo alguien más.
        // Ya-en-o-pasado el destino ⇒ no-op SILENCIOSO (el banner de avance
        // ajeno que puso el re-fetch es todo lo que el agente necesita ver).
        if (isAtOrPast(current: fresh?.step, target: toStep)) {
          // Normalmente el `_apply` del re-fetch YA contó este movimiento; el
          // dedup de [_logReconciled] evita el doble conteo y esta llamada
          // cubre el caso en que el re-fetch falló y no llegó a aplicar nada.
          _logReconciled(
            from: before,
            to: fresh?.step,
            fromRaw: beforeRaw,
            toRaw: fresh?.currentStep,
            via: 'conflict',
          );
          return CheckoutTransitionOutcome.alreadyDone;
        }
        // M2-H6, frame 22A: el MISMO code, la situación OPUESTA. Tras
        // reconciliar la sesión sigue ANTES del destino ⇒ no es "alguien te
        // ganó", es "pediste un paso que aún no toca" (pantalla vieja, doble
        // toque tras reconciliar). Hasta H6 caía en [generic], que le daba al
        // agente un cartel sin salida.
        _setConflict(
          CheckoutConflictKind.tooEarly,
          e,
          attemptedStep: toStep,
          currentStep: fresh?.step ?? state.session?.step,
        );
        return CheckoutTransitionOutcome.conflict;

      case 'ENTRY_GUARD':
        // Se muestra QUÉ falta — el mismo texto que la lista de pasos ya
        // anticipaba con el candado (8B).
        _setConflict(
          CheckoutConflictKind.entryGuard,
          e,
          guard: infoFor(toStep)?.entryGuard,
          attemptedStep: toStep,
          currentStep: fresh?.step ?? state.session?.step,
        );
        return CheckoutTransitionOutcome.conflict;

      case 'SESSION_TERMINAL':
      case 'CHECKOUT_TERMINAL':
        // `CHECKOUT_TERMINAL` es INALCANZABLE desde RideOps —solo lo lanza el
        // router del kiosco (kiosk-checkout.service.js:731, 831, 913) y esta
        // app consume `/api/checkout-sessions/*`. El mapeo se mantiene como
        // cinturón, sin pantalla propia: dibujar una fingiría un caso que no
        // ocurre.
        _setConflict(CheckoutConflictKind.terminal, e);
        return CheckoutTransitionOutcome.conflict;

      case 'VEHICLE_CONFLICT':
        // La unidad quedó comprometida por otra reserva en la misma ventana.
        //
        // **Aquí vive la regla de las puertas falsas.** El CTA "Elegir otro
        // vehículo" solo se dibuja si el swap TODAVÍA es legal: la sesión
        // tiene que estar antes de `INSPECTION_IN_PROGRESS`
        // (vehicle-swap.service.js:46-51, 409 `SWAP_LOCKED`). Pasado ese
        // punto el botón daría 409 para siempre, y la pantalla nombra el
        // callejón en vez de ofrecer una acción imposible.
        //
        // Se calcula contra el paso RECONCILIADO, no contra el que se tenía:
        // el 409 pudo llegar precisamente porque la sesión ya se movió.
        _setConflict(
          CheckoutConflictKind.vehicleConflict,
          e,
          attemptedStep: toStep,
          currentStep: fresh?.step ?? state.session?.step,
          swapAvailable: _swapStillLegal(fresh?.step ?? state.session?.step),
          // MISMO puente que el guard 11D de H7 (`conflictingReservationNumberOf`),
          // no un segundo parser: el copy del backend es uno solo y el día que
          // cambie tiene que romperse en un único sitio. Null ⇒ el CTA "Buscar
          // R-…" no se dibuja.
          conflictReservationRef:
              conflictingReservationNumberOf(e.message),
        );
        return CheckoutTransitionOutcome.conflict;

      default:
        // 409 sin code o con code nuevo: mensaje del servidor, sin inventar.
        _setConflict(CheckoutConflictKind.generic, e);
        return CheckoutTransitionOutcome.conflict;
    }
  }

  void _setConflict(
    CheckoutConflictKind kind,
    ApiError e, {
    CheckoutEntryGuard? guard,
    CheckoutStep? attemptedStep,
    CheckoutStep? currentStep,
    bool swapAvailable = false,
    String? conflictReservationRef,
  }) {
    state = state.copyWith(
      conflict: CheckoutConflict(
        kind: kind,
        message: e.message,
        code: e.code,
        guard: guard,
        attemptedStep: attemptedStep,
        currentStep: currentStep,
        swapAvailable: swapAvailable,
        conflictReservationRef: conflictReservationRef,
      ),
    );
  }

  /// ¿El swap de unidad sigue siendo legal en [step]?
  ///
  /// `vehicle-swap.service.js:46-51` lo cierra a partir de
  /// `INSPECTION_IN_PROGRESS`. Con el paso FUERA del catálogo (paso nuevo del
  /// backend) devuelve **false**: sin certeza no se dibuja una acción — el
  /// error caro de esta historia es el botón que no puede triunfar, no el
  /// botón de menos.
  bool _swapStillLegal(CheckoutStep? step) {
    final info = infoFor(step);
    final locked = infoFor(CheckoutStep.inspectionInProgress);
    if (info == null || locked == null) return false;
    return info.position < locked.position;
  }

  /// El agente vio la antesala de enganche (23A) y entra a trabajar.
  void acknowledgeJoin() {
    if (!state.joinAcknowledged) {
      state = state.copyWith(joinAcknowledged: true);
    }
  }

  /// Re-fetch de reconciliación. Su fallo NO puede tapar el rechazo que se
  /// está resolviendo: devuelve null y la UI se queda con lo que ya tenía.
  ///
  /// [via] separa las dos reconciliaciones que llegan aquí: `conflict` (409) y
  /// `rejected` (el 4xx del servicio, p. ej. el 422 post-commit del finalize).
  /// Mezclarlas mentiría sobre cuántas colisiones reales produce el patio, que
  /// es la métrica con la que el épico mide su SHIP.
  Future<CheckoutSessionDto?> _refetchQuiet(
    int gen, {
    String via = 'conflict',
  }) async {
    final id = state.session?.id;
    if (id == null) return null;
    try {
      final fresh = await _api.getSession(id);
      if (gen != _generation || !ref.mounted) return null;
      _apply(fresh, detectForeign: true, via: via);
      return fresh;
    } on ApiError catch (_) {
      return null;
    }
  }

  /// "Guardar y pausar" (8E) — `POST /:id/abandon`. No mueve `currentStep`:
  /// sella `abandonedAt`, por eso el copy promete que nada se pierde.
  Future<bool> pause() async {
    final session = state.session;
    if (session == null || state.pausing) return false;
    state = state.copyWith(pausing: true, clearConflict: true);
    final gen = _generation;
    try {
      final updated = await _api.abandon(id: session.id, reason: 'agent_paused');
      if (gen != _generation || !ref.mounted) return false;
      _apply(updated, detectForeign: false, isWrite: true);
      return true;
    } on ApiError catch (e) {
      if (gen != _generation || !ref.mounted) return false;
      // Incluye el 409 SIN code de "sesión ya terminal" (service:853-855).
      state = state.copyWith(
        error: e,
        networkAvailable:
            e.kind == ApiErrorKind.network ? false : state.networkAvailable,
      );
      return false;
    } finally {
      if (gen == _generation && ref.mounted) {
        state = state.copyWith(pausing: false);
      }
    }
  }

  // ── escrituras del paso CONFIRMING (M2-H2) ───────────────────────────────

  /// Switch "el cliente declina el seguro" (9C) — `POST
  /// /:id/declined-insurance`.
  ///
  /// No hay estado local del switch: se manda el valor DESEADO y la pantalla
  /// se re-dibuja desde la sesión que responde el servidor (su `events[]` trae
  /// el `DECLINED_INSURANCE` recién escrito). Si el POST falla, el switch se
  /// queda donde estaba porque nunca se movió solo — que es exactamente lo que
  /// debe pasar con una bandera que decide un anexo legal.
  ///
  /// Offline: se bloquea ANTES de salir. La bandera no entra a la bandeja
  /// (ADR-5 se escribió para el dinero, pero la regla del wizard es más
  /// simple: ningún paso del checkout se encola).
  Future<bool> setDeclinedInsurance(bool declined) async {
    final session = state.session;
    if (session == null || state.isMutating || state.transitionInFlight) {
      return false;
    }
    if (state.isTerminal || state.offline) return false;
    final gen = _generation;
    state = state.copyWith(
      mutating: CheckoutMutation.declinedInsurance,
      clearConflict: true,
    );
    try {
      final updated = await _api.setDeclinedInsurance(
        id: session.id,
        declined: declined,
      );
      if (gen != _generation || !ref.mounted) return false;
      _apply(updated, detectForeign: false, isWrite: true);
      _logger.log(
        CheckoutEvents.declinedInsuranceSet,
        data: {'declined': declined},
      );
      return true;
    } on ApiError catch (e) {
      if (gen != _generation || !ref.mounted) return false;
      if (e.kind == ApiErrorKind.conflict) {
        // Único 409 del endpoint: "no hay contrato ligado" (service:829-831).
        // Viene SIN code, así que se muestra el mensaje del servidor tal cual.
        await _refetchQuiet(gen);
        _setConflict(CheckoutConflictKind.generic, e);
      } else {
        state = state.copyWith(
          error: e,
          networkAvailable:
              e.kind == ApiErrorKind.network ? false : state.networkAvailable,
        );
      }
      return false;
    } finally {
      if (gen == _generation && ref.mounted) {
        state = state.copyWith(clearMutating: true);
      }
      _scheduleNext(gen);
    }
  }

  /// Swap de unidad (9E) — `POST /:id/vehicle`.
  ///
  /// El servidor cambia reserva y contrato en una transacción y devuelve la
  /// sesión actualizada; aquí se aplica como ESCRITURA (sube el epoch de
  /// fencing) y se re-lee display-data, porque lo que cambió no vive en la
  /// sesión sino en la reserva: el header y la tarjeta seguirían mostrando la
  /// unidad vieja.
  ///
  /// El paso NO se mueve — cambian los datos (nota 9 del mockup).
  Future<CheckoutSwapAttempt> swapVehicle(String newVehicleId) async {
    const blocked = CheckoutSwapAttempt(CheckoutSwapOutcome.blocked);
    final session = state.session;
    if (session == null || state.isMutating || state.transitionInFlight) {
      return blocked;
    }
    if (state.isTerminal || state.offline) return blocked;
    final gen = _generation;
    state = state.copyWith(
      mutating: CheckoutMutation.vehicleSwap,
      clearConflict: true,
    );
    try {
      final result = await _api.swapVehicle(
        id: session.id,
        newVehicleId: newVehicleId,
      );
      if (gen != _generation || !ref.mounted) return blocked;
      _apply(result.session, detectForeign: false, isWrite: true);
      _logger.log(CheckoutEvents.vehicleSwapped);
      // Cambió la unidad de la reserva: el header y la tarjeta de
      // vehículo tienen que dejar de mostrar la vieja.
      await _loadContext(_generation, via: 'swap');
      return const CheckoutSwapAttempt(CheckoutSwapOutcome.ok);
    } on ApiError catch (e) {
      if (gen != _generation || !ref.mounted) return blocked;
      if (e.kind != ApiErrorKind.conflict) {
        state = state.copyWith(
          error: e,
          networkAvailable:
              e.kind == ApiErrorKind.network ? false : state.networkAvailable,
        );
        return CheckoutSwapAttempt(
          CheckoutSwapOutcome.failed,
          message: e.message,
          code: e.code,
        );
      }
      _logger.log(CheckoutEvents.transition409, data: {'code': e.code ?? 'none'});
      // Todo 409 se reconcilia (ADR-4): la lista del sheet y el candado del
      // swap se dibujan desde el estado fresco, no desde el que había.
      await _refetchQuiet(gen);
      if (gen != _generation || !ref.mounted) return blocked;
      if (e.code == 'SWAP_LOCKED') {
        // Ya no es cosa de ESTA unidad: la sesión pasó de inspección y el
        // swap dejó de existir. El banner sobrevive al cierre del sheet, y
        // lleva kind propio para poder traducir la causa encima del cuerpo
        // del servidor (que aquí filtra `currentStep=` crudo).
        _setConflict(CheckoutConflictKind.swapLocked, e);
        return CheckoutSwapAttempt(
          CheckoutSwapOutcome.lockedStep,
          message: e.message,
          code: e.code,
        );
      }
      // VEHICLE_DOUBLE_BOOKED / VEHICLE_TERMINAL: la negativa es de la unidad
      // elegida y se muestra DENTRO del sheet, junto a las otras opciones —
      // sacar al agente de la lista para leer un banner y volver a entrar es
      // exactamente la fricción que 9E existe para evitar.
      return CheckoutSwapAttempt(
        CheckoutSwapOutcome.vehicleRejected,
        message: e.message,
        code: e.code,
      );
    } finally {
      if (gen == _generation && ref.mounted) {
        state = state.copyWith(clearMutating: true);
      }
      _scheduleNext(gen);
    }
  }

  // ── escritura del paso CUSTOMER_SIGN_PENDING (M2-H5) ─────────────────────

  /// Guarda la firma que el cliente acaba de dejar en el lienzo del kiosco
  /// (18B) — `POST /:id/customer-signature`.
  ///
  /// NO mueve el paso: estampa `customerSignedAt` y escribe la firma en el
  /// contrato. Por eso viaja como [CheckoutMutation.customerSignature] y no
  /// como transición.
  ///
  /// **Nunca se encola** (ADR-5 aplicado al cierre): la firma es una escritura
  /// al contrato que solo el servidor puede confirmar, y una firma guardada
  /// "para después" es una firma que el cliente creyó dar y el contrato no
  /// tiene. Sin red se bloquea aquí — y la pantalla lo bloquea antes todavía,
  /// para no pedirle el trazo al cliente en balde (18A).
  ///
  /// [signerName] se sella desde display-data, igual que el complete de la
  /// inspección: el endpoint acepta la firma sin nombre y la dejaría anónima
  /// en el contrato.
  Future<CheckoutTransitionAttempt> saveCustomerSignature({
    required String signatureDataUrl,
    String? signerName,
  }) async {
    const blocked = CheckoutTransitionAttempt(CheckoutTransitionOutcome.blocked);
    final session = state.session;
    if (session == null || state.isMutating || state.transitionInFlight) {
      return blocked;
    }
    if (state.isTerminal || state.offline) return blocked;
    final gen = _generation;
    // `replaced` ANTES del POST: lo que se mide es la decisión del agente de
    // pisar una firma existente, no si el servidor la aceptó.
    final replacing = session.customerSignedAt != null;
    state = state.copyWith(
      mutating: CheckoutMutation.customerSignature,
      clearConflict: true,
    );
    try {
      final updated = await _api.saveCustomerSignature(
        id: session.id,
        signatureDataUrl: signatureDataUrl,
        signerName: signerName,
      );
      if (gen != _generation || !ref.mounted) return blocked;
      _apply(updated, detectForeign: false, isWrite: true);
      _logger.log(
        CheckoutEvents.signatureSaved,
        data: {'replaced': replacing},
      );
      return const CheckoutTransitionAttempt(CheckoutTransitionOutcome.ok);
    } on ApiError catch (e) {
      if (gen != _generation || !ref.mounted) return blocked;
      state = state.copyWith(
        error: e,
        networkAvailable:
            e.kind == ApiErrorKind.network ? false : state.networkAvailable,
      );
      return CheckoutTransitionAttempt(
        CheckoutTransitionOutcome.failed,
        message: e.message.isEmpty ? null : e.message,
        code: e.code,
        network: e.kind == ApiErrorKind.network,
      );
    } finally {
      if (gen == _generation && ref.mounted) {
        state = state.copyWith(clearMutating: true);
      }
      _scheduleNext(gen);
    }
  }

  /// El agente ya vio el aviso de avance ajeno (abrió la lista o siguió
  /// trabajando): el banner se retira.
  void dismissAdvance() {
    if (state.advance != null) state = state.copyWith(clearAdvance: true);
  }

  void dismissConflict() {
    if (state.conflict != null) state = state.copyWith(clearConflict: true);
  }
}

/// **autoDispose OBLIGATORIO** (INN MC-1): en Riverpod 3 los providers ya no
/// se sueltan solos. Sin esto, el Notifier de cada reserva visitada sobrevive
/// a la salida del wizard y `_scheduleNext` sigue re-armando el timer para
/// siempre: tres checkouts abiertos en un turno = ~12 req/min permanentes por
/// teléfono contra `GET /api/checkout-sessions/:id`, y batería quemándose en
/// el bolsillo. El `ref.onDispose` del build ya cancela timer y suscripción;
/// lo único que faltaba era que el dispose LLEGARA a ocurrir.
final checkoutWizardProvider = NotifierProvider.autoDispose
    .family<CheckoutWizardController, CheckoutWizardState, String>(
  CheckoutWizardController.new,
);
