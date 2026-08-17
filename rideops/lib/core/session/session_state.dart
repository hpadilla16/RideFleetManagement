import 'package:flutter/foundation.dart';

import '../api/dto/session_user.dart';

/// Fase de la sesión — gobierna el redirect top-level del router.
enum SessionStatus {
  /// Arranque: leyendo el token del Keystore y rehidratando /me. El router
  /// mantiene al usuario en /splash mientras dura.
  restoring,

  /// Sin token utilizable — solo /login es alcanzable.
  unauthenticated,

  /// Token vigente en el Keystore. [SessionState.user] puede ser null un
  /// instante (rehidratación de /me en vuelo o fallida por red); el gate de
  /// contraseña se resuelve igual porque cualquier 403
  /// PASSWORD_CHANGE_REQUIRED observado en el Dio autenticado levanta el flag.
  authenticated,
}

@immutable
class SessionState {
  const SessionState._({required this.status, this.token, this.user});

  const SessionState.restoring() : this._(status: SessionStatus.restoring);

  const SessionState.unauthenticated()
      : this._(status: SessionStatus.unauthenticated);

  const SessionState.authenticated({required String token, SessionUser? user})
      : this._(status: SessionStatus.authenticated, token: token, user: user);

  final SessionStatus status;
  final String? token;
  final SessionUser? user;

  bool get isAuthenticated => status == SessionStatus.authenticated;

  /// El gate de contraseña (REGROUND §3). `user == null` ⇒ false: no
  /// bloqueamos por especulación — si el flag es real, la primera llamada
  /// autenticada responde 403 PASSWORD_CHANGE_REQUIRED y el observador del
  /// Dio lo levanta.
  bool get mustChangePassword => user?.mustChangePassword ?? false;

  SessionState withUser(SessionUser user) =>
      SessionState._(status: status, token: token, user: user);

  SessionState withToken(String token) =>
      SessionState._(status: status, token: token, user: user);
}
