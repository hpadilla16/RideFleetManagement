import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

/// Telemetría (M0-4 / docs/03-observability.md).
///
/// Por ahora la app NO tiene DSN de Sentry (lo da Hector); esta interfaz es el
/// punto de enchufe: cuando llegue, se agrega un `SentryEventLogger` que
/// traduce cada evento a breadcrumb/transaction y se cambia UNA línea en
/// [eventLoggerProvider]. Nada más de la app se entera.
///
/// Reglas de PII del doc: jamás pasar tokens, contraseñas, nombres de
/// clientes ni bodies de request en [data]. Identidad = userId del EMPLEADO y
/// tenant_id como tag — eso se enriquece en el logger, no en cada callsite.
abstract class EventLogger {
  /// [event] sigue la taxonomía `dominio.acción[_resultado]` en snake_case.
  void log(String event, {Map<String, Object?> data = const {}});
}

/// Producción sin DSN: no reporta a nadie (y no acumula nada en memoria).
class NoopEventLogger implements EventLogger {
  const NoopEventLogger();

  @override
  void log(String event, {Map<String, Object?> data = const {}}) {}
}

/// Dev: imprime a consola para verificar la taxonomía mientras no hay Sentry.
class DebugEventLogger implements EventLogger {
  const DebugEventLogger();

  @override
  void log(String event, {Map<String, Object?> data = const {}}) {
    debugPrint('[telemetry] $event ${data.isEmpty ? '' : data}');
  }
}

/// Eventos de sesión de la taxonomía (03-observability.md §Sesión). Constantes
/// para que un typo sea error de compilación y no un evento fantasma.
abstract final class AuthEvents {
  static const loginOk = 'auth.login_ok';
  static const loginFail = 'auth.login_fail';
  static const passwordGateShown = 'auth.password_gate_shown';
  static const passwordChanged = 'auth.password_changed';
  static const tokenRefreshOk = 'auth.token_refresh_ok';
  static const tokenRefreshFail = 'auth.token_refresh_fail';
  static const sessionExpiredRelogin = 'auth.session_expired_relogin';
}

/// Eventos de sesión fuera de auth (03-observability.md §Sesión): selector de
/// ubicación (H3) y, cuando llegue H2, el PIN lock.
abstract final class SessionEvents {
  static const viewLocationSet = 'session.view_location_set';
  static const viewLocationDenied = 'session.view_location_denied';
}

/// Punto de enchufe de Sentry: cuando haya DSN, aquí se decide
/// `SentryEventLogger` en prod y debug en dev. Hoy: debug print en debug,
/// silencio en release.
final eventLoggerProvider = Provider<EventLogger>((ref) {
  return kDebugMode ? const DebugEventLogger() : const NoopEventLogger();
});
