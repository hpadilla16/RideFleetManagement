import 'package:dio/dio.dart';

import 'api_error.dart';
import 'dto/session_user.dart';
import 'interceptors.dart';

/// Retrofit a mano (ADR-2) para /api/auth/*.
///
/// Tres clientes, tres razones (regla de los dos Dio, M0-5):
///  - [login] va por el Dio LIMPIO: todavía no hay token y el stack
///    autenticado rechazaría la request en el interceptor.
///  - [me] y [changePassword] van por el Dio AUTENTICADO: ambos están en la
///    allowlist del gate de contraseña (middleware/auth.js:15-19), así que
///    funcionan incluso con mustChangePassword activo.
///  - [refreshWithToken] usa un Dio pelón con el bearer puesto A MANO: el
///    refresh no puede pasar por el stack autenticado porque su interceptor
///    llama a TokenRefresher.freshToken() — refresh-dentro-del-refresh sería
///    recursión. El token viene como argumento, decidido por el refresher.
class AuthApi {
  AuthApi({
    required Dio authedDio,
    required Dio publicDio,
    required Dio bareDio,
  })  : _authed = authedDio,
        _public = publicDio,
        _bare = bareDio;

  final Dio _authed;
  final Dio _public;
  final Dio _bare;

  /// POST /api/auth/login → `{ token, user }`. 401 = credenciales inválidas
  /// (mensaje genérico deliberado del backend — no revela si el correo
  /// existe). Rate limit: 5/min (auth.routes.js:10-13) → 429 posible.
  Future<AuthResponse> login({
    required String email,
    required String password,
  }) async {
    final res = await _run(() => _public.post<Map<String, dynamic>>(
          '/api/auth/login',
          data: {'email': email, 'password': password},
        ));
    return AuthResponse.fromJson(res.data!);
  }

  /// GET /api/auth/me → `{ user }` (buildSessionUser). Fuente de la
  /// rehidratación al arrancar.
  ///
  /// SALTA `x-view-location` (WHY completo en
  /// [AuthInterceptor.skipViewLocation]): /me responde `req.user` YA reducido
  /// por el header (auth.routes.js:95-97) — con override activo la app
  /// recibiría locationIds de UNA sede y confundiría el set real del usuario;
  /// y si un admin quitó la sede persistida, la rehidratación entera moriría
  /// con el 403 duro del selector. La identidad no es dato scoped.
  Future<SessionUser> me() async {
    final res = await _run(
      () => _authed.get<Map<String, dynamic>>(
        '/api/auth/me',
        options: Options(extra: {AuthInterceptor.skipViewLocation: true}),
      ),
    );
    return SessionUser.fromJson(res.data!['user'] as Map<String, dynamic>);
  }

  /// POST /api/auth/change-password → `{ token, user }` FRESCO — el único
  /// camino que limpia mustChangePassword (auth.service.js:264-292). El
  /// caller intercambia el JWT y el gate se levanta sin re-login. Los errores
  /// de política y de contraseña actual llegan como 400 con mensaje.
  Future<AuthResponse> changePassword({
    required String currentPassword,
    required String newPassword,
  }) async {
    final res = await _run(() => _authed.post<Map<String, dynamic>>(
          '/api/auth/change-password',
          data: {
            'currentPassword': currentPassword,
            'newPassword': newPassword,
          },
        ));
    return AuthResponse.fromJson(res.data!);
  }

  /// POST /api/auth/refresh → `{ token, user }`. Solo lo llama el
  /// TokenRefresher (refresco proactivo, ADR-3a) — nunca la UI.
  Future<AuthResponse> refreshWithToken(String currentToken) async {
    final res = await _run(() => _bare.post<Map<String, dynamic>>(
          '/api/auth/refresh',
          options: Options(headers: {'Authorization': 'Bearer $currentToken'}),
        ));
    return AuthResponse.fromJson(res.data!);
  }

  /// Normaliza: TODO error de esta API sale como [ApiError]. El Dio limpio no
  /// trae interceptor de mapeo (a propósito), así que mapeamos aquí.
  Future<Response<T>> _run<T>(Future<Response<T>> Function() call) async {
    try {
      return await call();
    } on DioException catch (e) {
      throw e.error is ApiError ? e.error! as ApiError : ApiError.fromDio(e);
    }
  }
}
