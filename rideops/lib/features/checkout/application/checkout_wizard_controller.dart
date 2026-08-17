import 'dart:async';

import 'package:clock/clock.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/api/api_error.dart';
import '../../../core/api/api_providers.dart';
import '../../../core/api/checkout_api.dart';
import '../../../core/api/dto/checkout_session.dart';
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
  const CheckoutPollConfig({
    this.baseInterval = const Duration(seconds: 5),
    this.slowInterval = const Duration(seconds: 15),
    this.unchangedCyclesBeforeSlowLane = 3,
    this.preTransitionMaxAge = const Duration(seconds: 3),
  });

  /// 5 s con el wizard abierto: es la ventana en la que el kiosco puede
  /// firmar T&C mientras el agente mira la pantalla.
  final Duration baseInterval;

  /// Carril lento tras [unchangedCyclesBeforeSlowLane] ciclos sin cambio (y
  /// también tras un 429/503): la sesión que no se mueve no merece 12
  /// requests por minuto por teléfono.
  final Duration slowInterval;
  final int unchangedCyclesBeforeSlowLane;

  /// Nota 7 del mockup: antes de transicionar, si la última lectura tiene más
  /// de esto, se re-consulta. Achica la ventana read-then-write que
  /// `stampSideEffect` deja abierta (checkout-session.service.js:621-645).
  final Duration preTransitionMaxAge;
}

final Provider<CheckoutPollConfig> checkoutPollConfigProvider =
    Provider<CheckoutPollConfig>((ref) => const CheckoutPollConfig());

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

  /// Último paso REPORTADO que ya se logueó como renderizado — evita que
  /// `checkout.step_rendered` se emita por tick del poll.
  String? _renderedStep;

  @override
  CheckoutWizardState build() {
    _generation++;
    final gen = _generation;
    _timer?.cancel();
    _reconnect?.cancel();
    _inFlight = false;
    _unchangedCycles = 0;
    _slowLane = false;
    _renderedStep = null;
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
    if (id == null) return _load(_generation);
    return _poll(_generation, byUser: true);
  }

  /// Primera lectura: `by-reservation` es la fuente de verdad al entrar.
  Future<void> _load(int gen) async {
    if (gen != _generation || !ref.mounted) return;
    if (_inFlight) return;
    _inFlight = true;
    state = state.copyWith(fetching: true, clearError: true);
    final hadHeader = ref.read(activeLocationProvider).isPinned;
    try {
      final session = await _api.getByReservation(reservationId);
      if (gen != _generation || !ref.mounted) return;
      if (session == null) {
        // 404: la reserva no tiene sesión. NO es error — crearla es H7, con
        // su matriz de guards (422 PRECHECKIN_REQUIRED / AGE_RULES_*, 409
        // VEHICLE_CONFLICT / SESSION_TERMINAL).
        state = state.copyWith(fetching: false, notFound: true);
        return;
      }
      _apply(session, detectForeign: false);
      unawaited(_loadContext(gen));
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
    _inFlight = true;
    if (byUser) state = state.copyWith(fetching: true);
    final hadHeader = ref.read(activeLocationProvider).isPinned;
    try {
      final fresh = await _api.getSession(id);
      if (gen != _generation || !ref.mounted) return;
      final changed = _hasMaterialChange(state.session, fresh);
      _apply(fresh, detectForeign: true);
      if (changed) {
        _unchangedCycles = 0;
        _slowLane = false;
      } else {
        _unchangedCycles++;
        if (_unchangedCycles >= _cfg.unchangedCyclesBeforeSlowLane) {
          _slowLane = true;
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
      // 429 absorbido por el carril lento del poll (el interceptor ya
      // respeta Retry-After por request; esto es el timer).
      _slowLane = true;
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

  /// Contexto de la reserva para el header de sesión — best-effort, una vez.
  Future<void> _loadContext(int gen) async {
    try {
      final display =
          await ref.read(reservationsApiProvider).getDisplayData(reservationId);
      if (gen != _generation || !ref.mounted) return;
      state = state.copyWith(
        context: CheckoutReservationContext(
          reservationNumber: display.reservation.reservationNumber,
          customerName: display.reservation.customer?.fullName,
          vehicleLabel: display.reservation.vehicle?.label,
          plate: display.reservation.vehicle?.plate,
          odometer: display.reservation.vehicle?.mileage,
          // Superficie de STAFF: el nombre del tenant sí se muestra aquí.
          tenantName: display.branding.companyName.isEmpty
              ? null
              : display.branding.companyName,
        ),
      );
    } catch (_) {
      // Sin display-data el wizard sigue: el header muestra menos, nada más.
    }
  }

  /// Aplica una lectura fresca. [detectForeign] enciende la detección de
  /// avance ajeno (8C): SOLO para lecturas del servidor que no provocamos
  /// nosotros — la respuesta de nuestro propio POST jamás debe banderizarse
  /// como "otra superficie avanzó".
  void _apply(
    CheckoutSessionDto fresh, {
    required bool detectForeign,
    String via = 'poll',
  }) {
    final prev = state.session;
    var advance = state.advance;
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
        _logReconciled(from: prev.step, to: fresh.step, via: via);
      }
    }
    state = state.copyWith(
      session: fresh,
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

  void _logReconciled({
    CheckoutStep? from,
    CheckoutStep? to,
    required String via,
  }) {
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
      _slowLane ? _cfg.slowInterval : _cfg.baseInterval,
      () {
        if (_inFlight) {
          // Request en vuelo (una transición larga): se salta el tick, no se
          // encima — y se re-arma el reloj.
          _scheduleNext(gen);
          return;
        }
        unawaited(_poll(gen));
      },
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
  Future<CheckoutTransitionOutcome> transitionTo(CheckoutStep toStep) async {
    final session = state.session;
    if (session == null) return CheckoutTransitionOutcome.blocked;
    // Anti-doble-tap: el segundo tap NO manda un segundo POST (el backend
    // responde 409 a propósito, pero cobrar dos veces esa carrera en el patio
    // es exactamente lo que no queremos, service:380-391).
    if (state.transitionInFlight) return CheckoutTransitionOutcome.blocked;
    if (state.isTerminal) return CheckoutTransitionOutcome.blocked;
    if (state.offline) return CheckoutTransitionOutcome.blocked;

    final gen = _generation;
    final renderedStep = session.currentStep;
    state = state.copyWith(transitionInFlight: true, clearConflict: true);
    try {
      final preflight = await _preflight(gen, session, toStep, renderedStep);
      if (preflight != null) return preflight;

      final updated = await _api.transition(id: session.id, toStep: toStep.wire);
      if (gen != _generation || !ref.mounted) {
        return CheckoutTransitionOutcome.blocked;
      }
      // Nuestro propio avance: se aplica sin detección de avance ajeno y el
      // banner previo se retira (el agente ya interactuó con el paso nuevo).
      _apply(updated, detectForeign: false);
      state = state.copyWith(clearAdvance: true);
      _logger.log(CheckoutEvents.transitionOk, data: {'to': toStep.wire});
      _unchangedCycles = 0;
      _slowLane = false;
      return CheckoutTransitionOutcome.ok;
    } on ApiError catch (e) {
      if (gen != _generation || !ref.mounted) {
        return CheckoutTransitionOutcome.blocked;
      }
      if (e.kind == ApiErrorKind.conflict) {
        return _resolveConflict(gen, e, toStep);
      }
      state = state.copyWith(
        error: e,
        networkAvailable:
            e.kind == ApiErrorKind.network ? false : state.networkAvailable,
      );
      return CheckoutTransitionOutcome.failed;
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

    final fresh = await _api.getSession(session.id);
    if (gen != _generation || !ref.mounted) {
      return CheckoutTransitionOutcome.blocked;
    }
    _apply(fresh, detectForeign: true, via: 'conflict');
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
          _logReconciled(from: before, to: fresh?.step, via: 'conflict');
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
      _apply(updated, detectForeign: false);
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

  /// El agente ya vio el aviso de avance ajeno (abrió la lista o siguió
  /// trabajando): el banner se retira.
  void dismissAdvance() {
    if (state.advance != null) state = state.copyWith(clearAdvance: true);
  }

  void dismissConflict() {
    if (state.conflict != null) state = state.copyWith(clearConflict: true);
  }
}

final checkoutWizardProvider = NotifierProvider.family<CheckoutWizardController,
    CheckoutWizardState, String>(CheckoutWizardController.new);
