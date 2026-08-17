import 'dart:async';
import 'dart:convert';

/// Refresco PROACTIVO del token (ADR-3a).
///
/// El backend monta POST /api/auth/refresh DETRÁS de requireAuth y no rota
/// refresh tokens: un JWT vencido no se recupera — la app re-loguea. Por eso
/// aquí NO existe "refrescar al recibir 401". La única estrategia válida es
/// adelantarse: decodificar `exp` y refrescar ~60 s antes.
///
/// El mutex ([_inflight]) garantiza que N requests concurrentes cerca del
/// vencimiento produzcan UN solo refresh; los demás esperan el mismo Future.
class TokenRefresher {
  TokenRefresher({
    required Future<String?> Function() readToken,
    required Future<String> Function(String currentToken) doRefresh,
    required Future<void> Function(String newToken) storeToken,
    this.skew = const Duration(seconds: 60),
  })  : _readToken = readToken,
        _doRefresh = doRefresh,
        _storeToken = storeToken;

  final Future<String?> Function() _readToken;

  /// Llama POST /api/auth/refresh con el token actual y devuelve el nuevo.
  final Future<String> Function(String currentToken) _doRefresh;
  final Future<void> Function(String newToken) _storeToken;

  /// Cuánto antes del `exp` consideramos el token "por vencer".
  final Duration skew;

  Future<String>? _inflight;

  /// Devuelve un token utilizable para la próxima request:
  ///  - vigente y lejos del exp → tal cual;
  ///  - dentro de la ventana de skew → refresca (una sola vez, con mutex);
  ///  - ya vencido → null: el caller manda a re-login. NO intentamos refresh
  ///    porque el propio refresh daría 401 (está detrás de requireAuth).
  Future<String?> freshToken({DateTime Function() now = DateTime.now}) async {
    final token = await _readToken();
    if (token == null || token.isEmpty) return null;

    final exp = expiryOf(token);
    if (exp == null) return token; // sin exp legible: que el servidor decida
    final current = now();
    if (current.isAfter(exp)) return null; // vencido — re-login
    if (current.isBefore(exp.subtract(skew))) return token; // aún fresco

    // Ventana de refresco. Mutex: comparte el refresh en vuelo si ya hay uno.
    final inflight = _inflight ??= _refresh(token).whenComplete(() {
      _inflight = null;
    });
    try {
      return await inflight;
    } catch (_) {
      // Refresh falló (red, 401 de carrera). El token viejo sigue siendo
      // válido durante el skew — devolverlo deja a la request intentar; si el
      // servidor la rechaza, el 401 rutea a re-login por el camino normal.
      return token;
    }
  }

  Future<String> _refresh(String currentToken) async {
    final next = await _doRefresh(currentToken);
    await _storeToken(next);
    return next;
  }

  /// Decodifica el claim `exp` de un JWT sin verificar firma (la firma la
  /// verifica el servidor; aquí solo agendamos el refresco).
  static DateTime? expiryOf(String jwt) {
    final exp = _claimsOf(jwt)?['exp'];
    if (exp is! num) return null;
    return DateTime.fromMillisecondsSinceEpoch((exp * 1000).round(), isUtc: true);
  }

  /// Claim `sub` (userId) del JWT, también sin verificar firma. Lo usa la
  /// ubicación activa (H3) para saber DE QUIÉN es la preferencia persistida
  /// cuando la sesión está degradada (`user == null` porque /me falló por
  /// red): el sub del token es la única identidad disponible offline.
  static String? subjectOf(String jwt) {
    final sub = _claimsOf(jwt)?['sub'];
    return sub is String && sub.isNotEmpty ? sub : null;
  }

  static Map<String, dynamic>? _claimsOf(String jwt) {
    final parts = jwt.split('.');
    if (parts.length != 3) return null;
    try {
      final payload = utf8.decode(
        base64Url.decode(base64Url.normalize(parts[1])),
      );
      return json.decode(payload) as Map<String, dynamic>;
    } catch (_) {
      return null;
    }
  }
}
