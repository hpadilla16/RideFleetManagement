import 'package:flutter/foundation.dart';

import '../api/dto/session_user.dart';

/// Fase de la sesión — gobierna el redirect top-level del router.
enum SessionStatus {
  /// Arranque: leyendo el token del Keystore y rehidratando /me. El router
  /// mantiene al usuario en /splash mientras dura.
  restoring,

  /// Sin token utilizable — solo /login es alcanzable.
  unauthenticated,

  /// Token vigente en el Keystore. [SessionState.user] puede ser null
  /// (rehidratación de /me en vuelo o fallida por red); el gate de
  /// contraseña NO depende del user: cualquier 403 PASSWORD_CHANGE_REQUIRED
  /// observado en el Dio autenticado levanta [SessionState.passwordChangeRequired]
  /// a nivel de estado, exista o no el user.
  authenticated,
}

@immutable
class SessionState {
  const SessionState._({
    required this.status,
    this.token,
    this.user,
    this.passwordChangeRequired = false,
  });

  const SessionState.restoring() : this._(status: SessionStatus.restoring);

  const SessionState.unauthenticated()
      : this._(status: SessionStatus.unauthenticated);

  const SessionState.authenticated({required String token, SessionUser? user})
      : this._(status: SessionStatus.authenticated, token: token, user: user);

  final SessionStatus status;
  final String? token;
  final SessionUser? user;

  /// Flag PROPIO del estado (no del user) para el gate de contraseña:
  /// se levanta al observar un 403 PASSWORD_CHANGE_REQUIRED en cualquier
  /// ruta autenticada, incluso con [user] null (restore sin red → vuelve la
  /// señal → 403). Fix del review de Innovation H1: si dependiera del user,
  /// ese escenario dejaba al usuario atrapado viendo errores sueltos.
  final bool passwordChangeRequired;

  bool get isAuthenticated => status == SessionStatus.authenticated;

  /// El gate de contraseña (REGROUND §3): flag observado O el claim del
  /// user. `user == null` sin flag ⇒ false — no bloqueamos por especulación.
  bool get mustChangePassword =>
      passwordChangeRequired || (user?.mustChangePassword ?? false);

  SessionState withUser(SessionUser user) => SessionState._(
        status: status,
        token: token,
        user: user,
        passwordChangeRequired: passwordChangeRequired,
      );

  SessionState withToken(String token) => SessionState._(
        status: status,
        token: token,
        user: user,
        passwordChangeRequired: passwordChangeRequired,
      );

  SessionState withPasswordChangeRequired() => SessionState._(
        status: status,
        token: token,
        user: user,
        passwordChangeRequired: true,
      );
}
