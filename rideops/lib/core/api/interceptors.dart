import 'dart:math';

import 'package:dio/dio.dart';

import 'api_error.dart';
import 'token_refresher.dart';

/// Stack de interceptores del Dio AUTENTICADO (M0-5).
///
/// Regla del plan: este stack va SOLO en las rutas autenticadas de staff. Las
/// rutas públicas de token (/api/mobile-inspection/:token/*, /api/sign/*) van
/// por un Dio limpio sin bearer — un token de handoff jamás debe viajar junto
/// a un JWT de staff, y un JWT de staff jamás debe filtrarse a una superficie
/// pública.
class AuthInterceptor extends Interceptor {
  AuthInterceptor({
    required this.refresher,
    required this.readViewLocation,
    required this.onSessionExpired,
    this.onPasswordChangeRequired,
    this.onViewLocationDenied,
  });

  final TokenRefresher refresher;

  /// La ubicación activa del selector (estado de sesión). `null` = sin
  /// override: el usuario ve su set completo.
  final String? Function() readViewLocation;

  /// 401 o token vencido → la sesión murió: limpiar y mandar a re-login.
  final void Function() onSessionExpired;

  /// 403 con code PASSWORD_CHANGE_REQUIRED observado en CUALQUIER ruta
  /// autenticada (REGROUND §3: el gate del backend responde así fuera de su
  /// allowlist). La sesión marca mustChangePassword y el router bloquea en
  /// /change-password — sin esto, un reset de contraseña hecho por el admin
  /// con la app abierta dejaría al usuario viendo errores sueltos.
  final void Function()? onPasswordChangeRequired;

  /// La negativa de ubicación de REGROUND §1 observada en una request que SÍ
  /// llevaba [viewLocationHeader]. Hoy solo telemetría
  /// (`session.view_location_denied`) — la UI la maneja cada pantalla con su
  /// propio ApiError (DoD-4), este callback no navega ni muta sesión.
  ///
  /// La FIRMA vive en UN solo lugar: [ApiError.isViewLocationDenied] (MC-1
  /// review H4) — acepta tanto el 403 sin code de hoy (mensaje exacto de
  /// view-location.js) como el `code: VIEW_LOCATION_DENIED` que el PR de
  /// backend del gap #3 va a desplegar; sin eso, la métrica moriría en
  /// silencio el día del deploy.
  final void Function()? onViewLocationDenied;

  static const viewLocationHeader = 'x-view-location';

  /// `options.extra[skipViewLocation] = true` ⇒ esta request NO lleva el
  /// header aunque haya ubicación activa. Existe para DOS rutas concretas:
  ///  - `GET /api/auth/me`: devuelve `req.user` YA reducido por el header
  ///    (auth.routes.js:95-97) — con override activo llegaría locationIds de
  ///    UNA sede y la app confundiría el set real del usuario; y si un admin
  ///    quitó la sede persistida, /me daría 403 duro y la rehidratación de la
  ///    sesión moriría. Identidad ≠ datos scoped.
  ///  - `GET /api/locations/selectable`: alimenta el SELECTOR — con el header,
  ///    requireAuth encoge req.user.locationIds a la sede activa y la lista
  ///    devolvería solo esa (locations-selectable.routes.js:37-41): imposible
  ///    salirse de una ubicación denegada.
  static const skipViewLocation = 'rideops.skip_view_location';

  @override
  Future<void> onRequest(
    RequestOptions options,
    RequestInterceptorHandler handler,
  ) async {
    final token = await refresher.freshToken();
    if (token == null) {
      // OJO: aquí NO se llama onSessionExpired — este reject fluye por el
      // onError de este mismo interceptor, que ya dispara el callback al ver
      // kind unauthorized. Llamarlo en ambos lados lo duplicaba (lo atrapó
      // el test del review S-1).
      return handler.reject(
        DioException(
          requestOptions: options,
          type: DioExceptionType.cancel,
          error: ApiError(
            kind: ApiErrorKind.unauthorized,
            message: 'session expired',
          ),
        ),
      );
    }
    options.headers['Authorization'] = 'Bearer $token';

    // Selector de ubicación (REGROUND §1): requireAuth reduce
    // req.user.locationIds a esta sede antes de correr cualquier ruta. Solo
    // encoge el alcance — fail-closed en el servidor.
    if (options.extra[skipViewLocation] != true) {
      final loc = readViewLocation();
      if (loc != null && loc.isNotEmpty) {
        options.headers[viewLocationHeader] = loc;
      }
    }
    handler.next(options);
  }

  @override
  void onError(DioException err, ErrorInterceptorHandler handler) {
    final apiError = err.error is ApiError
        ? err.error! as ApiError
        : ApiError.fromDio(err);
    if (apiError.kind == ApiErrorKind.unauthorized) {
      // ADR-3a: NO refrescar aquí — un 401 significa que el JWT ya no sirve y
      // el refresh (detrás de requireAuth) daría 401 igual. Re-login.
      onSessionExpired();
    } else if (apiError.kind == ApiErrorKind.passwordChangeRequired) {
      onPasswordChangeRequired?.call();
    } else if (apiError.isViewLocationDenied(
      // Solo cuenta como negativa de ubicación si ESTA request llevó el
      // header: un 403 de módulo/RBAC no debe contaminar la métrica
      // session.view_location_denied (misma firma que usa la UI — MC-1 H4).
      requestHadHeader:
          err.requestOptions.headers.containsKey(viewLocationHeader),
    )) {
      onViewLocationDenied?.call();
    }
    handler.next(
      err.copyWith(error: apiError),
    );
  }
}

/// Backoff para throttling (DoD #5): reintenta la request idempotente con
/// espera exponencial + jitter. Solo métodos seguros/idempotentes — un POST
/// de dinero NUNCA se reintenta desde aquí (ADR-5: eso vive en el flujo de
/// intento en vivo con su llave de idempotencia).
///
/// Qué cuenta como throttle:
///  - 429, siempre.
///  - 503 SOLO si trae `Retry-After` — así señala el backend la saturación
///    real (backend/src/lib/errors.js: pool P2024 y ServiceUnavailableError
///    responden 503 + Retry-After en segundos). Un 503 pelón es un outage
///    genérico: reintentarlo a ciegas solo alimenta la estampida.
///
/// `Retry-After` (segundos) actúa como PISO de la espera: si el servidor
/// pide 5 s, no se le pega antes de 5 s por mucho que el backoff local diga
/// 500 ms.
class RateLimitRetryInterceptor extends Interceptor {
  RateLimitRetryInterceptor(
    this._dio, {
    this.maxRetries = 3,
    this.baseDelayMs = 500,
    Random? random,
  }) : _random = random ?? Random();

  final Dio _dio;
  final int maxRetries;

  /// Base del backoff exponencial. Inyectable solo para que los tests no
  /// esperen medio segundo real.
  final int baseDelayMs;

  /// Jitter real (no `microsecondsSinceEpoch % 250`, que en ráfagas
  /// sincronizadas produce valores casi idénticos y no des-sincroniza nada).
  final Random _random;

  /// `options.extra[skipRetry] = true` ⇒ esta request NO se reintenta aquí
  /// aunque sea throttle. Para el POLLER del dashboard (Innovation SC-1,
  /// review H4): bajo un 429 sostenido, el retry por-request amplifica hasta
  /// 4× el tráfico sin beneficio — el timer del poller ya trae su propio
  /// backoff decorrelacionado y el próximo tick reintenta igual. Los GETs
  /// interactivos (búsqueda, selector de sedes) conservan el retry: ahí hay
  /// un humano esperando UNA respuesta.
  static const skipRetry = 'rideops.skip_rate_limit_retry';

  static const _attemptKey = 'rateLimitAttempt';
  static const _retriableMethods = {'GET', 'HEAD'};
  static const _jitterMs = 250;

  /// Espera antes del reintento [attempt] (base 0): backoff exponencial con
  /// jitter, con `Retry-After` del servidor como piso. Público para tests.
  Duration delayFor(int attempt, {int? retryAfterSeconds}) {
    final backoffMs = baseDelayMs * (1 << attempt);
    final floorMs = (retryAfterSeconds ?? 0) * 1000;
    final waitMs = backoffMs > floorMs ? backoffMs : floorMs;
    return Duration(milliseconds: waitMs + _random.nextInt(_jitterMs));
  }

  bool _isThrottle(Response<dynamic>? response) {
    final status = response?.statusCode;
    if (status == 429) return true;
    return status == 503 && _retryAfterSeconds(response) != null;
  }

  /// El backend manda `Retry-After` en segundos enteros (nunca fecha HTTP);
  /// cualquier otra forma se ignora y decide el backoff local.
  int? _retryAfterSeconds(Response<dynamic>? response) {
    final raw = response?.headers.value('retry-after');
    if (raw == null) return null;
    return int.tryParse(raw.trim());
  }

  @override
  Future<void> onError(
    DioException err,
    ErrorInterceptorHandler handler,
  ) async {
    final method = err.requestOptions.method.toUpperCase();
    final attempt = (err.requestOptions.extra[_attemptKey] as int?) ?? 0;

    if (err.requestOptions.extra[skipRetry] == true ||
        !_isThrottle(err.response) ||
        !_retriableMethods.contains(method) ||
        attempt >= maxRetries) {
      return handler.next(err);
    }

    await Future<void>.delayed(
      delayFor(attempt, retryAfterSeconds: _retryAfterSeconds(err.response)),
    );

    try {
      final opts = err.requestOptions;
      opts.extra[_attemptKey] = attempt + 1;
      final response = await _dio.fetch<dynamic>(opts);
      handler.resolve(response);
    } on DioException catch (e) {
      handler.next(e);
    }
  }
}
