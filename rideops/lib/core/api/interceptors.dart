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
  });

  final TokenRefresher refresher;

  /// La ubicación activa del selector (estado de sesión). `null` = sin
  /// override: el usuario ve su set completo.
  final String? Function() readViewLocation;

  /// 401 o token vencido → la sesión murió: limpiar y mandar a re-login.
  final void Function() onSessionExpired;

  static const viewLocationHeader = 'x-view-location';

  @override
  Future<void> onRequest(
    RequestOptions options,
    RequestInterceptorHandler handler,
  ) async {
    final token = await refresher.freshToken();
    if (token == null) {
      onSessionExpired();
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
    final loc = readViewLocation();
    if (loc != null && loc.isNotEmpty) {
      options.headers[viewLocationHeader] = loc;
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
    }
    handler.next(
      err.copyWith(error: apiError),
    );
  }
}

/// Backoff para 429 (DoD #5): reintenta la request idempotente con espera
/// exponencial + jitter. Solo métodos seguros/idempotentes — un POST de
/// dinero NUNCA se reintenta desde aquí (ADR-5: eso vive en el flujo de
/// intento en vivo con su llave de idempotencia).
class RateLimitRetryInterceptor extends Interceptor {
  RateLimitRetryInterceptor(this._dio, {this.maxRetries = 3});

  final Dio _dio;
  final int maxRetries;

  static const _attemptKey = 'rateLimitAttempt';
  static const _retriableMethods = {'GET', 'HEAD'};

  @override
  Future<void> onError(
    DioException err,
    ErrorInterceptorHandler handler,
  ) async {
    final status = err.response?.statusCode;
    final method = err.requestOptions.method.toUpperCase();
    final attempt = (err.requestOptions.extra[_attemptKey] as int?) ?? 0;

    if (status != 429 ||
        !_retriableMethods.contains(method) ||
        attempt >= maxRetries) {
      return handler.next(err);
    }

    final delayMs = (500 * (1 << attempt)) +
        (DateTime.now().microsecondsSinceEpoch % 250);
    await Future<void>.delayed(Duration(milliseconds: delayMs));

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
