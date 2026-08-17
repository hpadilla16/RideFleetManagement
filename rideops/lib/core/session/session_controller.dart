import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../api/api_error.dart';
import '../api/api_providers.dart';
import '../api/dto/session_user.dart';
import '../api/token_refresher.dart';
import '../telemetry/event_logger.dart';
import 'session_state.dart';
import 'token_store.dart';

/// Estado de sesión (blueprint §3): token + SessionUser en Riverpod, con
/// hidratación al arrancar y logout limpio. El router observa este provider
/// vía refreshListenable y re-evalúa sus gates en cada cambio.
class SessionController extends Notifier<SessionState> {
  @override
  SessionState build() {
    // La restauración es async (Keystore + /me); build debe ser síncrono.
    // El microtask corre apenas alguien observa el provider — en la práctica,
    // el router en el primer frame.
    Future.microtask(restore);
    return const SessionState.restoring();
  }

  EventLogger get _logger => ref.read(eventLoggerProvider);
  TokenStore get _store => ref.read(tokenStoreProvider);

  /// Hidratación al arrancar: token del Keystore → estado → /me.
  ///
  /// Un token VENCIDO se descarta sin red (ADR-3a: el refresh está detrás de
  /// requireAuth, un JWT muerto no se recupera). Si /me falla por RED, la
  /// sesión queda autenticada con user null: mejor dejar entrar a un patio
  /// sin señal que expulsar a re-login — cualquier 401/403 real posterior
  /// corrige el rumbo vía los observadores del Dio autenticado.
  Future<void> restore() async {
    final token = await _store.read();
    if (!ref.mounted) return; // container muerto mientras leíamos el Keystore
    if (token == null || token.isEmpty) {
      state = const SessionState.unauthenticated();
      return;
    }
    final exp = TokenRefresher.expiryOf(token);
    if (exp != null && DateTime.now().toUtc().isAfter(exp)) {
      await _store.clear();
      if (!ref.mounted) return;
      state = const SessionState.unauthenticated();
      return;
    }
    state = SessionState.authenticated(token: token);
    await _hydrateUser();
  }

  /// GET /api/auth/me → user al estado, con los guardas de siempre. Lo
  /// comparten [restore] y [rehydrateUserIfMissing].
  Future<void> _hydrateUser() async {
    try {
      final user = await ref.read(authApiProvider).me();
      if (!ref.mounted) return;
      // onSessionExpired pudo dispararse mientras /me volaba (401): no
      // resucitar una sesión ya limpiada.
      if (state.isAuthenticated) state = state.withUser(user);
    } on ApiError catch (e) {
      // 401 ya limpió la sesión desde el interceptor. Red u otros: user
      // queda null (ver arriba). PASSWORD_CHANGE_REQUIRED no aplica: /me está
      // en la allowlist del gate.
      if (e.kind == ApiErrorKind.unauthorized) return;
    } catch (_) {
      // Respuesta no parseable (p. ej. portal cautivo de Wi-Fi devolviendo
      // HTML con 200 → TypeError en fromJson): degradar a user null igual
      // que un fallo de red — jamás un unhandled async error al arrancar.
    }
  }

  /// Sesión DEGRADADA (token vivo, `user == null` porque /me falló por red al
  /// restaurar): re-intento de /me al REANUDAR la app (lifecycle resume — lo
  /// cablea el AppShell, H3). El shell mientras tanto renderiza con tabs
  /// mínimas y skeleton (mockup 4E); cada /me exitoso restituye role y
  /// moduleAccess sin pedirle nada al usuario. No-op si la sesión ya está
  /// completa o no existe.
  Future<void> rehydrateUserIfMissing() async {
    if (!state.isAuthenticated || state.user != null) return;
    await _hydrateUser();
  }

  /// POST /api/auth/login. Lanza [ApiError] para que la pantalla decida
  /// (401 genérico, sin red, 429). Aquí solo: persistir, publicar, medir.
  Future<void> login({required String email, required String password}) async {
    try {
      final res = await ref
          .read(authApiProvider)
          .login(email: email, password: password);
      await _store.write(res.token);
      state = SessionState.authenticated(token: res.token, user: res.user);
      _logger.log(AuthEvents.loginOk);
    } on ApiError catch (e) {
      _logger.log(
        AuthEvents.loginFail,
        data: {
          'fail_reason': switch (e.kind) {
            ApiErrorKind.unauthorized => 'invalid',
            ApiErrorKind.network => 'network',
            _ => 'other',
          },
        },
      );
      rethrow;
    }
  }

  /// POST /api/auth/change-password — el backend devuelve `{ token, user }`
  /// fresco con mustChangePassword ya en false; intercambiamos el JWT y el
  /// gate se levanta SIN re-login (REGROUND §3). Lanza [ApiError] en fallo
  /// (contraseña actual incorrecta, política, red).
  Future<void> changePassword({
    required String currentPassword,
    required String newPassword,
  }) async {
    final res = await ref.read(authApiProvider).changePassword(
          currentPassword: currentPassword,
          newPassword: newPassword,
        );
    await _store.write(res.token);
    // Estado reconstruido desde cero: passwordChangeRequired vuelve a false
    // (el constructor no lo arrastra) y el user fresco trae el claim limpio.
    state = SessionState.authenticated(token: res.token, user: res.user);
    _logger.log(AuthEvents.passwordChanged);
  }

  /// Logout explícito del usuario. El purge de la bandeja de salida por
  /// cambio de cuenta (ADR-7) se conecta aquí cuando el outbox tenga filas
  /// reales (M1-H5): hoy no hay escrituras encoladas en H1.
  Future<void> logout() async {
    await _store.clear();
    state = const SessionState.unauthenticated();
  }

  /// 401 en cualquier ruta autenticada, o token vencido al despachar: la
  /// sesión murió. Limpieza + re-login (nunca refresh — ADR-3a).
  void onSessionExpired() {
    if (!state.isAuthenticated) return; // 401s en ráfaga: loguear uno solo
    _logger.log(AuthEvents.sessionExpiredRelogin);
    state = const SessionState.unauthenticated();
    unawaited(_store.clear());
  }

  /// 403 PASSWORD_CHANGE_REQUIRED observado fuera del login (p. ej. un admin
  /// reseteó la contraseña con la app abierta, o restore sin red dejó user
  /// null y al volver la señal la primera llamada respondió 403): levantar
  /// el flag DE ESTADO para que el router bloquee en /change-password. No
  /// depende de que exista user — ese era el bug del review H1.
  void notePasswordChangeRequired() {
    if (!state.isAuthenticated || state.mustChangePassword) return;
    state = state.withPasswordChangeRequired();
  }

  /// El refresco proactivo devolvió `{ token, user }`: sincronizar el estado
  /// en memoria (el Keystore lo escribe el TokenRefresher vía storeToken).
  void onRefreshed(AuthResponse fresh) {
    if (!state.isAuthenticated) return;
    state = state.withToken(fresh.token).withUser(fresh.user);
  }
}

final NotifierProvider<SessionController, SessionState>
    sessionControllerProvider =
    NotifierProvider<SessionController, SessionState>(SessionController.new);
