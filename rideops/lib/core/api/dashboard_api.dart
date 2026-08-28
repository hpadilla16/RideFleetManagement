import 'package:dio/dio.dart';

import 'api_error.dart';
import 'dto/dashboard.dart';
import 'interceptors.dart';

/// Retrofit a mano (ADR-2) para el dashboard de employee-app.
///
/// `GET /api/employee-app/dashboard[?q=]` (employee-app.routes.js:9-17,
/// requireAuth + requireModuleAccess('employeeApp') + requireRole
/// ADMIN/OPS/AGENT). Va por el Dio AUTENTICADO con el stack completo y SÍ
/// lleva `x-view-location`: las 9 colas y las 11 métricas son datos scoped
/// por sede — exactamente lo que el selector debe encoger (REGROUND §1).
class DashboardApi {
  DashboardApi({required Dio authedDio}) : _authed = authedDio;

  final Dio _authed;

  /// Ruta para telemetría (tag `route` de net.request_429_backoff) — sin
  /// query: la taxonomía no debe fragmentar la métrica por término buscado.
  static const route = '/api/employee-app/dashboard';

  /// [query] no vacío activa searchResults (take 12 en el server); las colas
  /// y métricas llegan igual en ambos casos.
  ///
  /// [skipRateLimitRetry]: el POLLER lo pone en true (SC-1 review H4) — su
  /// timer ya trae backoff decorrelacionado y el retry del interceptor solo
  /// amplificaría un 429 sostenido. La búsqueda interactiva lo deja en false.
  Future<DashboardPayload> fetch({
    String query = '',
    bool skipRateLimitRetry = false,
  }) async {
    try {
      final res = await _authed.get<Map<String, dynamic>>(
        route,
        queryParameters: query.isEmpty ? null : {'q': query},
        options: skipRateLimitRetry
            ? Options(extra: {RateLimitRetryInterceptor.skipRetry: true})
            : null,
      );
      return DashboardPayload.fromJson(res.data ?? const {});
    } on DioException catch (e) {
      throw e.error is ApiError ? e.error! as ApiError : ApiError.fromDio(e);
    }
  }
}
