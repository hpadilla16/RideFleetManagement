import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:sentry_flutter/sentry_flutter.dart';

import '../config/app_config.dart';

/// Telemetría (M0-4 / docs/03-observability.md).
///
/// Con DSN configurado los eventos viajan como breadcrumbs de Sentry (el
/// contexto que acompaña a un crash: qué hizo el empleado antes de que
/// tronara); sin DSN la app no reporta a nadie. La decisión es una sola
/// función pura, [pickEventLogger] — el resto de la app solo ve la interfaz.
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

/// Eventos de sesión fuera de auth (03-observability.md §Sesión): el candado
/// por PIN/biometría (H2, `method` en el unlock: pin | biometric) y el
/// selector de ubicación activa (H3).
abstract final class SessionEvents {
  static const pinLock = 'session.pin_lock';
  static const pinUnlock = 'session.pin_unlock';
  static const viewLocationSet = 'session.view_location_set';
  static const viewLocationDenied = 'session.view_location_denied';
}

/// Eventos del dashboard (03-observability.md §Salud). `poll_tick` es SOLO
/// métrica de frecuencia — el callsite lo samplea al 1% antes de loguear.
abstract final class DashboardEvents {
  static const pollTick = 'dashboard.poll_tick';
}

/// Salud de red (03-observability.md §Salud): el poller del dashboard entró
/// en backoff por 429/503 (tag `route`).
abstract final class NetEvents {
  static const request429Backoff = 'net.request_429_backoff';
}

/// Eventos de inspección (03-observability.md §Inspección y bandeja) y de
/// salud de cámara (§Salud) — historia H5.
abstract final class InspectionEvents {
  static const photoCaptured = 'inspection.photo_captured';
  static const completedLocal = 'inspection.completed_local';
}

/// Eventos del checkout (03-observability.md §Checkout (M2)) — historia H1
/// del épico. Los de dinero (`checkout.money_*`, `checkout.preview_divergence`)
/// llegan con M2-H3: se declaran cuando existe el callsite, no antes.
abstract final class CheckoutEvents {
  /// Render desde `currentStep` (tag `step`). Se emite cuando el paso
  /// RENDERIZADO cambia, no por frame ni por tick del poll.
  static const stepRendered = 'checkout.step_rendered';

  static const transitionOk = 'checkout.transition_ok';

  /// Tag `code`: ILLEGAL_TRANSITION | ENTRY_GUARD | SESSION_TERMINAL |
  /// CHECKOUT_TERMINAL | VEHICLE_CONFLICT | none (409 sin code del abandon).
  static const transition409 = 'checkout.transition_409';

  /// UI reconciliada contra el servidor. Tags: `steps_jumped` y `via`
  /// (`conflict` = tras un 409, `poll` = otra superficie avanzó y el poll lo
  /// vio). El tag `via` es dato NUEVO de H1 — documentado en la tabla de
  /// 03-observability.md en el mismo cambio.
  static const reconciled = 'checkout.reconciled';

  // ── M2-H2 (CONFIRMING + T&C) ──────────────────────────────────────────────

  /// `POST /:id/declined-insurance` aceptado. Tag `declined` (bool).
  static const declinedInsuranceSet = 'checkout.declined_insurance_set';

  /// `POST /:id/vehicle` aceptado. Sin tags: el id de la unidad es dato de
  /// operación, no de telemetría, y el volumen ya dice lo que interesa
  /// (cuántas entregas empiezan con la unidad equivocada).
  static const vehicleSwapped = 'checkout.vehicle_swapped';

  /// `POST /:id/terms-token` aceptado. Tag `reused` (bool) — mide cuántas
  /// re-emisiones caen dentro de la ventana de re-uso del backend, que es lo
  /// que decide si la copy dice "sigue siendo el mismo código".
  static const termsTokenMinted = 'checkout.terms_token_minted';

  /// El countdown llegó a cero con el paso abierto. Es la medida directa del
  /// riesgo §5 del plan (TTL de 15 min corto para un cliente que lee).
  static const termsTokenExpired = 'checkout.terms_token_expired';

  /// El poll vio caer `tcCompletedAt` (el cliente firmó en su teléfono, o
  /// firmó otra superficie). Una vez por sesión de pantalla.
  static const termsSignedSeen = 'checkout.terms_signed_seen';

  /// Se abrió el modo presentación (10B), la pantalla volteada al cliente.
  static const presentModeShown = 'checkout.present_mode_shown';

  /// El modo presentación no pudo ajustar (o restaurar) brillo o wakelock.
  /// Tags: `what` (brightness | wakelock) y `phase` (enter | exit).
  ///
  /// `phase:exit` es el que importa vigilar: es la señal de que el teléfono
  /// pudo quedarse con el brillo forzado después de salir (riesgo real solo en
  /// iOS — en Android el override es de la VENTANA y muere con ella).
  static const presentModeScreenDegraded =
      'checkout.present_mode_screen_degraded';
}

/// Eventos de la bandeja de salida (03-observability.md §Inspección y
/// bandeja). `entry_dead` con un `code` desconocido es compuerta de release
/// (bug de manejo de errores, no ruido).
abstract final class OutboxEvents {
  static const enqueued = 'outbox.enqueued';
  static const drainedOk = 'outbox.drained_ok';
  static const remintToken = 'outbox.remint_token';
  static const entryDead = 'outbox.entry_dead';
  static const purgedAccountSwitch = 'outbox.purged_account_switch';
}

/// Salud de cámara (03-observability.md §Salud): presión de memoria durante
/// la captura — el guard del OOM de gama media (DoD #8).
abstract final class CameraEvents {
  static const oomGuard = 'camera.oom_guard';
}

/// Con DSN: cada evento de la taxonomía entra como breadcrumb, de modo que un
/// crash llegue con el rastro de lo que el empleado venía haciendo.
///
/// [data] ya viene saneado por contrato (la taxonomía prohíbe tokens, fotos y
/// nombres de clientes); esto NO vuelve a filtrarlo — el filtro real vive en
/// los callsites y en el `beforeSend` de sentry_setup.dart.
class SentryEventLogger implements EventLogger {
  const SentryEventLogger();

  @override
  void log(String event, {Map<String, Object?> data = const {}}) {
    Sentry.addBreadcrumb(
      Breadcrumb(
        message: event,
        category: 'rideops',
        data: data.isEmpty ? null : Map<String, Object?>.from(data),
      ),
    );
  }
}

/// Qué logger corresponde. Pura y sin Riverpod para poder probar la matriz
/// completa (con/sin DSN × debug/release) sin levantar la app.
EventLogger pickEventLogger({
  required bool sentryEnabled,
  required bool debugMode,
}) {
  if (sentryEnabled) return const SentryEventLogger();
  return debugMode ? const DebugEventLogger() : const NoopEventLogger();
}

final eventLoggerProvider = Provider<EventLogger>((ref) {
  return pickEventLogger(
    sentryEnabled: AppConfig.current.sentryEnabled,
    debugMode: kDebugMode,
  );
});
