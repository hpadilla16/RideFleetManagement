import 'package:dio/dio.dart';

/// Mapeo de errores del backend a algo que la UI puede decidir (DoD #5).
///
/// El backend responde `{ error: string, code?: string }`. El `code` existe en
/// algunos 403/409/410 (PASSWORD_CHANGE_REQUIRED, ILLEGAL_TRANSITION,
/// TOKEN_EXPIRED…) pero NO en todos: el 403 del selector de ubicación viene
/// sin code (auth.js:75) — por eso [kind] clasifica por status + contexto y
/// nunca depende de que el code exista.
enum ApiErrorKind {
  /// 401 — sesión inválida/vencida. La única salida es re-login (ADR-3a:
  /// jamás intentar refresh al recibirlo; si el JWT venció, refresh también
  /// da 401).
  unauthorized,

  /// 403 con code PASSWORD_CHANGE_REQUIRED — ir a la pantalla de cambio
  /// forzado, no es una negativa de permisos.
  passwordChangeRequired,

  /// 403 — negativa real (RBAC, módulo apagado, o el selector de ubicación
  /// pidiendo una sede fuera del set). Se muestra como negativa, nunca como
  /// "no hay datos".
  forbidden,

  /// 409 — conflicto de estado (ILLEGAL_TRANSITION, ENTRY_GUARD,
  /// SESSION_TERMINAL, VEHICLE_CONFLICT…). Respuesta correcta: re-consultar
  /// GET /:id y reconciliar (ADR-4), no reintentar a ciegas.
  conflict,

  /// 410 — token de handoff inválido/vencido/consumido (TOKEN_INVALID,
  /// TOKEN_EXPIRED, TOKEN_CONSUMED). El drenador re-emite una vez.
  gone,

  /// 429 — backoff exponencial con jitter.
  rateLimited,

  /// Sin red / timeout — candidato a bandeja de salida si la escritura es
  /// no-financiera (ADR-5).
  network,

  /// 4xx restantes — error de la petición, mostrar mensaje del servidor.
  badRequest,

  /// 5xx / inesperado.
  server,
}

class ApiError implements Exception {
  ApiError({
    required this.kind,
    required this.message,
    this.code,
    this.status,
    this.cause,
  });

  final ApiErrorKind kind;

  /// Mensaje del backend (`error`) cuando existe — el backend escribe mensajes
  /// pensados para humanos; la UI los traduce/estiliza pero no los inventa.
  final String message;

  /// `code` de máquina cuando el backend lo mandó (no todos lo traen).
  final String? code;
  final int? status;
  final Object? cause;

  static ApiError fromDio(DioException e) {
    final res = e.response;
    if (res == null) {
      return ApiError(
        kind: ApiErrorKind.network,
        message: e.message ?? 'network error',
        cause: e,
      );
    }
    final data = res.data;
    final map = data is Map<String, dynamic> ? data : const <String, dynamic>{};
    final code = map['code'] as String?;
    final msg = (map['error'] as String?) ?? e.message ?? 'error ${res.statusCode}';

    final status = res.statusCode ?? 0;
    final kind = switch (status) {
      401 => ApiErrorKind.unauthorized,
      403 when code == 'PASSWORD_CHANGE_REQUIRED' =>
        ApiErrorKind.passwordChangeRequired,
      403 => ApiErrorKind.forbidden,
      409 => ApiErrorKind.conflict,
      410 => ApiErrorKind.gone,
      429 => ApiErrorKind.rateLimited,
      >= 400 && < 500 => ApiErrorKind.badRequest,
      _ => ApiErrorKind.server,
    };
    return ApiError(
      kind: kind,
      message: msg,
      code: code,
      status: res.statusCode,
      cause: e,
    );
  }

  /// Mensaje EXACTO del 403 de view-location (backend/src/lib/view-location.js:48).
  /// Puente documentado hasta que el backend agregue `code` (gap #3 del plan):
  /// si el copy del servidor cambia sin agregar el code, este matcheo deja de
  /// reconocer la negativa y cae al error genérico — degradación visible, no
  /// silenciosa (el usuario ve el mensaje del servidor igual).
  static const viewLocationDeniedMessage =
      'You do not have access to that location.';

  /// ¿Este error ES la negativa del selector de ubicación (pantalla 4D)?
  ///
  /// Firma completa (criterio registrado H4 + NIT de QA-H3): 403 + la request
  /// LLEVÓ `x-view-location` + (code `VIEW_LOCATION_DENIED` cuando el backend
  /// lo agregue, o code null con el mensaje exacto de view-location.js). Un
  /// 403 de módulo/RBAC trae mensaje distinto (moduleDeniedMessage) y NUNCA
  /// debe montar la 4D — cae al error genérico con el copy del servidor.
  bool isViewLocationDenied({required bool requestHadHeader}) {
    if (kind != ApiErrorKind.forbidden || !requestHadHeader) return false;
    if (code == 'VIEW_LOCATION_DENIED') return true;
    return code == null && message == viewLocationDeniedMessage;
  }

  @override
  String toString() => 'ApiError($kind, $status, $code, $message)';
}
