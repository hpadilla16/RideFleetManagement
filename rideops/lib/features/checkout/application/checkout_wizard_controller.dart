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
        unawaited(_loadContext(gen));
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

  /// Re-lee display-data. Lo llama el swap: cambió la unidad de la reserva, y
  /// el header + la tarjeta de vehículo tienen que dejar de mostrar la vieja.
  Future<void> reloadContext() async => _loadContext(_generation);

  /// Re-lee display-data para VERIFICAR si la entrega quedó registrada (19A/
  /// 19B). No se usa `state.context` cacheado a propósito: la pregunta es qué
  /// dice el servidor AHORA, después del cierre.
  ///
  /// Devuelve `null` cuando no hay veredicto — display-data no respondió, o
  /// mandó un estado que esta versión no conoce. **Null no es "no quedó
  /// registrada"**: es "no lo sé", y la UI lo dice así en vez de acusar a la
  /// cascada de algo que no vio.
  Future<bool?> verifyHandover() async {
    final display = await _loadContext(_generation);
    return ReservationStatus.tryParse(display?.reservation.status)
        ?.handoverRecorded;
  }

  /// Contexto de la reserva para el header de sesión y las tarjetas de
  /// verificación (9A/9B) — best-effort, no bloquea el wizard.
  Future<ReservationDisplayData?> _loadContext(int gen) async {
    try {
      final display =
          await ref.read(reservationsApiProvider).getDisplayData(reservationId);
      if (gen != _generation || !ref.mounted) return null;
      final reservation = display.reservation;
      state = state.copyWith(
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
    } catch (_) {
      // Sin display-data el wizard sigue: el header muestra menos, nada más.
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
    if (detectForeign &&
        prev != null &&
        prev.currentStep != fresh.currentStep) {
      final events = parseCheckoutEvents(fresh.events);
      final event = lastTransitionTo(events, fresh.currentStep);
      final actor = event?.actorKind(_myUserId) ?? CheckoutActorKind.otherSurface;
      if (actor == CheckoutActorKind.you) {
        // Fuimos nosotros (otro teléfono, o nuestro POST que ya se aplicó):
        // el stepper se mueve, pero no hay a quién atribuirle nada.
        advance = null;
      } else {
        advance = ForeignAdvanceNotice(
          completedStep: prev.currentStep,
          currentStep: fresh.currentStep,
          actor: actor,
          at: event?.at,
        );
        _logReconciled(
          from: prev.step,
          to: fresh.step,
          fromRaw: prev.currentStep,
          toRaw: fresh.currentStep,
          via: via,
        );
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
    );
    _logStepRendered(fresh.currentStep);
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
      // Nuestro propio avance: se aplica sin detección de avance ajeno y el
      // banner previo se retira (el agente ya interactuó con el paso nuevo).
      _apply(updated, detectForeign: false, isWrite: true);
      state = state.copyWith(clearAdvance: true);
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
        _setConflict(CheckoutConflictKind.generic, e);
        return CheckoutTransitionOutcome.conflict;

      case 'ENTRY_GUARD':
        // Se muestra QUÉ falta — el mismo texto que la lista de pasos ya
        // anticipaba con el candado (8B).
        _setConflict(
          CheckoutConflictKind.entryGuard,
          e,
          guard: infoFor(toStep)?.entryGuard,
        );
        return CheckoutTransitionOutcome.conflict;

      case 'SESSION_TERMINAL':
      case 'CHECKOUT_TERMINAL':
        _setConflict(CheckoutConflictKind.terminal, e);
        return CheckoutTransitionOutcome.conflict;

      case 'VEHICLE_CONFLICT':
        // Gancho de H1: se muestra la negativa del servidor. El swap de
        // vehículo (mockup 9D/9E) es M2-H2.
        _setConflict(CheckoutConflictKind.vehicleConflict, e);
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
  }) {
    state = state.copyWith(
      conflict: CheckoutConflict(
        kind: kind,
        message: e.message,
        code: e.code,
        guard: guard,
      ),
    );
  }

  /// Re-fetch de reconciliación. Su fallo NO puede tapar el 409 que se está
  /// resolviendo: devuelve null y la UI se queda con lo que ya tenía.
  Future<CheckoutSessionDto?> _refetchQuiet(int gen) async {
    final id = state.session?.id;
    if (id == null) return null;
    try {
      final fresh = await _api.getSession(id);
      if (gen != _generation || !ref.mounted) return null;
      _apply(fresh, detectForeign: true, via: 'conflict');
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
      await reloadContext();
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
