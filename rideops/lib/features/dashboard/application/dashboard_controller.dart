import 'dart:async';
import 'dart:math';

import 'package:clock/clock.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/api/api_error.dart';
import '../../../core/api/api_providers.dart';
import '../../../core/api/dashboard_api.dart';
import '../../../core/api/dto/dashboard.dart';
import '../../../core/lifecycle/app_visibility.dart';
import '../../../core/session/active_location.dart';
import '../../../core/session/session_controller.dart';
import '../../../core/session/view_location_denied.dart';
import '../../../core/telemetry/event_logger.dart';

/// Estado del dashboard. El cache EN MEMORIA es deliberado y alcanza para
/// M1: en un fallo el dato viejo SE QUEDA en pantalla con su edad visible
/// (mockup 5E — "se muestra, no se borra"). El cache PERSISTENTE (Drift,
/// sobrevivir reinicios de proceso — la nota 8 del mockup lo menciona) queda
/// para M2, registrado en PROJECT_PLAN §M1/criterios H4.
@immutable
class DashboardState {
  const DashboardState({
    this.data,
    this.fetchedAt,
    this.fetching = false,
    this.error,
    this.viewLocationDenied = false,
    this.pending = false,
  });

  /// Esperando el gate de arranque (sede activa sin hidratar o sesión
  /// ausente): NO hubo fetch todavía — la home muestra skeleton, no error.
  const DashboardState.pending() : this(pending: true);

  final DashboardPayload? data;

  /// Momento del último fetch EXITOSO — alimenta "Actualizado hace X min" y
  /// la edad del banner offline.
  final DateTime? fetchedAt;

  /// Request en vuelo (primer load o refresco silencioso).
  final bool fetching;

  /// Último error de fetch; null tras un éxito. Con [data] presente la UI
  /// banneriza sin borrar; sin data, pantalla de error completa.
  final ApiError? error;

  /// El error es LA negativa de ubicación (firma completa de
  /// [ApiError.isViewLocationDenied]) — monta la 4D y pinta el chip danger.
  final bool viewLocationDenied;

  final bool pending;

  bool get hasData => data != null;

  /// Primer load real: sin datos, sin error — skeleton 5C.
  bool get firstLoad => pending || (data == null && error == null);
}

/// Ritmo del poller — inyectable para que los tests con fakeAsync controlen
/// jitter, backoff y sampling con un Random sembrado.
class DashboardPollConfig {
  DashboardPollConfig({
    this.baseInterval = const Duration(seconds: 52),
    this.jitterRatio = 0.1,
    this.backoffCap = const Duration(minutes: 5),
    this.pollTickSampleRate = 0.01,
    Random? random,
  }) : random = random ?? Random();

  /// Base 52 s con jitter ±10% ⇒ ticks en [46.8, 57.2] s — dentro de los
  /// 45–60 s del mockup (nota 1) y des-sincronizado entre teléfonos para no
  /// martillar el backend en coro.
  final Duration baseInterval;
  final double jitterRatio;

  /// Tope del backoff decorrelacionado cuando el poller recibe 429/503.
  final Duration backoffCap;

  /// `dashboard.poll_tick` es solo métrica de frecuencia — sample 1%
  /// (03-observability.md §Salud).
  final double pollTickSampleRate;
  final Random random;
}

final Provider<DashboardPollConfig> dashboardPollConfigProvider =
    Provider<DashboardPollConfig>((ref) => DashboardPollConfig());

/// Controller del dashboard (H4). Reglas:
///  - Espera `ActiveLocation.hydrated` ANTES del primer fetch (criterio
///    registrado H2/H3): jamás un fetch con el override a medio hidratar —
///    saldría sin header y mostraría colas de TODAS las sedes un instante.
///  - `ref.watch(activeLocationProvider)`: cambiar de sede reconstruye el
///    estado (el cache de la sede anterior NO se muestra como si fuera de la
///    nueva) y re-consulta con el header nuevo.
///  - Polling 45–60 s con jitter; skip si hay request en vuelo; pausa TOTAL
///    con la app en background (appVisibilityProvider) y refresh inmediato al
///    volver; backoff decorrelacionado con tope 5 min cuando el POLLER recibe
///    429/503 (el interceptor ya respeta Retry-After por request — esto es el
///    timer, que no debe seguir programando ticks al ritmo normal contra un
///    backend saturado).
///  - `refresh()` es el gancho público: pull-to-refresh, resume y "tras
///    mutación propia" (cuando H5+ tenga mutaciones que ensucien las colas).
class DashboardController extends Notifier<DashboardState> {
  /// Invalida fetches/timers en vuelo cuando build se rehace (cambio de sede,
  /// login/logout) — mismo patrón que ActiveLocationController.
  int _generation = 0;
  Timer? _timer;
  Duration? _backoff;
  bool _inFlight = false;

  @override
  DashboardState build() {
    _generation++;
    final gen = _generation;
    _timer?.cancel();
    _backoff = null;
    _inFlight = false;
    ref.onDispose(() => _timer?.cancel());

    // select(isAuthenticated): el refresh proactivo muta el token cada ciclo
    // pero la sesión sigue viva — sin el select, cada refresh tiraría el
    // cache y re-fetchearía. Logout/login SÍ reconstruyen: los datos de una
    // cuenta jamás se muestran a la siguiente (ADR-7).
    final authed =
        ref.watch(sessionControllerProvider.select((s) => s.isAuthenticated));
    final location = ref.watch(activeLocationProvider);

    // Pausa total en background; al volver a primer plano, refresh inmediato
    // (nota 1 del mockup). listen y no watch: la visibilidad no debe tirar el
    // cache reconstruyendo el estado.
    ref.listen<bool>(appVisibilityProvider, (prev, visible) {
      if (!visible) {
        _timer?.cancel();
      } else if (prev == false) {
        unawaited(refresh());
      }
    });

    if (!authed || !location.hydrated) {
      // El chip danger no puede quedarse pegado de una sesión/sede anterior.
      _signalDenied(gen, false);
      return const DashboardState.pending();
    }

    Future.microtask(() => _fetch(gen));
    return const DashboardState(fetching: true);
  }

  DashboardApi get _api => ref.read(dashboardApiProvider);
  DashboardPollConfig get _cfg => ref.read(dashboardPollConfigProvider);
  EventLogger get _logger => ref.read(eventLoggerProvider);

  /// Fetch manual (pull-to-refresh, resume, tras mutación propia). Si ya hay
  /// request en vuelo no encima otra — el indicador cierra con la que va.
  Future<void> refresh() => _fetch(_generation);

  Future<void> _fetch(int gen) async {
    if (gen != _generation || !ref.mounted) return;
    // MC-2 review H4: refresh() (resume, pull-to-refresh) NO bypasea el gate
    // de arranque. Sin sesión no hay a quién consultar — un resume sobre el
    // login tras un logout armaría polling zombie con onSessionExpired por
    // tick; y con la sede a medio hidratar el fetch saldría SIN header
    // (criterio registrado H4). El build re-dispara solo cuando ambos gates
    // abren, así que aquí no se pierde nada con retornar.
    if (!ref.read(sessionControllerProvider).isAuthenticated ||
        !ref.read(activeLocationProvider).hydrated) {
      return;
    }
    if (_inFlight) return;
    _inFlight = true;
    state = DashboardState(
      data: state.data,
      fetchedAt: state.fetchedAt,
      fetching: true,
      error: state.error,
      viewLocationDenied: state.viewLocationDenied,
    );
    // Capturado AL DESPACHAR: la firma del 403 de ubicación exige saber si
    // ESTA request llevó el header (una sede pinneada ⇒ el interceptor lo
    // puso). Leerlo después clasificaría contra una selección ya cambiada.
    final hadHeader = ref.read(activeLocationProvider).isPinned;
    try {
      // skipRateLimitRetry: el backoff del POLLER (abajo) es la respuesta a
      // un 429 — el retry por-request del interceptor solo lo amplificaría.
      final payload = await _api.fetch(skipRateLimitRetry: true);
      if (gen != _generation || !ref.mounted) return;
      _backoff = null;
      state = DashboardState(data: payload, fetchedAt: clock.now());
      _signalDenied(gen, false);
    } on ApiError catch (e) {
      if (gen != _generation || !ref.mounted) return;
      final denied = e.isViewLocationDenied(requestHadHeader: hadHeader);
      if (e.kind == ApiErrorKind.rateLimited || e.status == 503) {
        _enterBackoff();
      }
      state = DashboardState(
        data: state.data,
        fetchedAt: state.fetchedAt,
        error: e,
        viewLocationDenied: denied,
      );
      _signalDenied(gen, denied);
    } finally {
      if (gen == _generation) _inFlight = false;
    }
    _scheduleNext(gen);
  }

  void _scheduleNext(int gen) {
    if (gen != _generation || !ref.mounted) return;
    if (!ref.read(appVisibilityProvider)) return; // pausa total en background
    // MC-2: sin sesión no se programan ticks — el 401 de un tick zombie
    // dispararía onSessionExpired cada 52 s contra la pantalla de login.
    if (!ref.read(sessionControllerProvider).isAuthenticated) return;
    _timer?.cancel();
    _timer = Timer(_nextInterval(), () {
      // Métrica de frecuencia sampleada — jamás log por tick completo.
      if (_cfg.random.nextDouble() < _cfg.pollTickSampleRate) {
        _logger.log(DashboardEvents.pollTick);
      }
      if (_inFlight) {
        // Request en vuelo (un refresh manual largo): saltar el tick, no
        // encimar — pero el reloj sigue.
        _scheduleNext(gen);
        return;
      }
      unawaited(_fetch(gen));
    });
  }

  Duration _nextInterval() {
    if (_backoff != null) return _backoff!;
    final baseMs = _cfg.baseInterval.inMilliseconds;
    final jitterMs = (baseMs * _cfg.jitterRatio).round();
    return Duration(
      milliseconds: baseMs - jitterMs + _cfg.random.nextInt(2 * jitterMs + 1),
    );
  }

  /// Backoff DECORRELACIONADO (AWS-style): siguiente espera uniforme entre la
  /// base y 3× la espera anterior, con tope [DashboardPollConfig.backoffCap].
  /// Mejor que el exponencial puro contra un 429 de tenant: N teléfonos que
  /// entraron al throttle juntos se dispersan en vez de volver en oleadas.
  void _enterBackoff() {
    final baseMs = _cfg.baseInterval.inMilliseconds;
    final prevMs = (_backoff ?? _cfg.baseInterval).inMilliseconds;
    final upperMs = min(prevMs * 3, _cfg.backoffCap.inMilliseconds);
    final span = max(0, upperMs - baseMs);
    _backoff = Duration(
      milliseconds: baseMs + (span == 0 ? 0 : _cfg.random.nextInt(span + 1)),
    );
    _logger.log(
      NetEvents.request429Backoff,
      data: {'route': DashboardApi.route},
    );
  }

  /// Señal pantalla→shell del chip danger. Post-frame/microtask siempre (no
  /// mutar otro provider dentro de un build) y con guard de generación.
  void _signalDenied(int gen, bool denied) {
    Future.microtask(() {
      if (gen != _generation || !ref.mounted) return;
      ref.read(viewLocationDeniedSignalProvider.notifier).set(denied);
    });
  }
}

final NotifierProvider<DashboardController, DashboardState>
    dashboardControllerProvider =
    NotifierProvider<DashboardController, DashboardState>(
  DashboardController.new,
);
