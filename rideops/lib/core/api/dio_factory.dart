import 'package:dio/dio.dart';

import 'interceptors.dart';
import 'token_refresher.dart';

/// Dos clientes HTTP, dos mundos (M0-5):
///
///  - [buildAuthedDio]: rutas autenticadas de staff. Lleva el stack completo:
///    bearer con refresco proactivo, `x-view-location`, mapeo de errores y
///    backoff de 429.
///  - [buildPublicDio]: rutas públicas de token (/api/mobile-inspection/:t/*,
///    firma de términos). SIN bearer de staff, SIN header de ubicación — el
///    token de handoff ES la auth. El drenador de la bandeja usa este para
///    subir fotos y el autenticado solo para re-emitir el token.
class DioFactory {
  DioFactory({required this.baseUrl});

  final String baseUrl;

  Dio buildAuthedDio({
    required TokenRefresher refresher,
    required String? Function() readViewLocation,
    required void Function() onSessionExpired,
    void Function()? onPasswordChangeRequired,
    void Function()? onViewLocationDenied,
  }) {
    final dio = Dio(_baseOptions());
    dio.interceptors.addAll([
      AuthInterceptor(
        refresher: refresher,
        readViewLocation: readViewLocation,
        onSessionExpired: onSessionExpired,
        onPasswordChangeRequired: onPasswordChangeRequired,
        onViewLocationDenied: onViewLocationDenied,
      ),
      RateLimitRetryInterceptor(dio),
    ]);
    return dio;
  }

  Dio buildPublicDio() => Dio(_baseOptions());

  BaseOptions _baseOptions() => BaseOptions(
        baseUrl: baseUrl,
        // Patio con Wi-Fi malo: timeouts honestos. Una foto de ~1 MB a
        // 2 Mbps son ~5 s; el send de 60 s cubre la peor foto sin colgar la
        // UI para siempre.
        connectTimeout: const Duration(seconds: 10),
        receiveTimeout: const Duration(seconds: 30),
        sendTimeout: const Duration(seconds: 60),
        headers: {'Accept': 'application/json'},
      );
}
