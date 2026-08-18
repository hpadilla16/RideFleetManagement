import 'package:sentry_flutter/sentry_flutter.dart';

import '../config/app_config.dart';

/// Cableado de Sentry (M0-4 · docs/03-observability.md).
///
/// QA de milestone M1 (2026-08-17) encontró que el paquete estaba en el
/// pubspec pero NADIE llamaba a `SentryFlutter.init`: entregar el DSN no
/// habría hecho nada y la compuerta de release "sesiones sin crash" era
/// inalcanzable. Decisión del PM: cablearlo, no diferirlo.
///
/// El init está condicionado a que haya DSN ([AppConfig.sentryEnabled]): sin
/// DSN la app arranca exactamente como antes (cero costo, cero red), con DSN
/// reporta. Así el mismo binario sirve para dev sin telemetría y para las
/// builds de CI que sí la llevan.
///
/// PII (regla del doc, no negociable): `sendDefaultPii = false` y el
/// [scrubSentryEvent] de abajo redacta las cabeceras que podrían cargar la
/// sesión de un empleado. La identidad que sí viaja es el userId del EMPLEADO
/// y el tenant como tag — nunca datos del cliente final.
void configureSentryOptions(SentryFlutterOptions options, AppConfig config) {
  options.dsn = config.sentryDsn;
  options.environment = config.env;
  // La compuerta de crash-free rate corta por build: version+flavor.
  options.release = 'rideops@${AppConfig.appVersion}+${config.env}';
  options.sendDefaultPii = false;
  options.beforeSend = (event, hint) => scrubSentryEvent(event);
}

/// Cabeceras que jamás pueden salir del teléfono en un reporte de crash.
/// `authorization` es el JWT de staff; `cookie` no la usamos hoy pero el
/// costo de listarla es cero y el de olvidarla es una fuga.
const _sensitiveHeaders = {'authorization', 'cookie', 'set-cookie'};

/// Redacta cabeceras sensibles antes de que el evento salga del aparato.
///
/// Devuelve el MISMO evento (mutado): en sentry 9.x `copyWith` está deprecado
/// y el patrón soportado es asignar sobre la instancia — el getter de
/// `headers` entrega una copia inmutable, así que el reemplazo va por el
/// setter.
SentryEvent? scrubSentryEvent(SentryEvent event) {
  final request = event.request;
  if (request == null) return event;

  final headers = request.headers;
  if (headers.isEmpty) return event;

  var changed = false;
  final scrubbed = <String, String>{};
  headers.forEach((key, value) {
    if (_sensitiveHeaders.contains(key.toLowerCase())) {
      scrubbed[key] = '[redacted]';
      changed = true;
    } else {
      scrubbed[key] = value;
    }
  });
  if (!changed) return event;

  request.headers = scrubbed;
  return event;
}
