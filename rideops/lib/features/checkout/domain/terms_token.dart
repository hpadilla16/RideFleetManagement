/// Lógica del token de firma de T&C (M2-H2, mockup 10A-10D).
///
/// PURA y con reloj inyectado: el countdown se prueba con `fakeAsync` y con
/// `withClock`, no esperando 15 minutos reales.
library;

import 'package:clock/clock.dart';

/// Piso de re-uso del backend (`mintHandoffToken`,
/// checkout-session.service.js:717-734): si al token vigente le quedan **más
/// de 2 minutos**, `POST /:id/terms-token` devuelve ESE MISMO token con
/// `reused: true`. Por debajo mintea uno nuevo, para que el cliente no reciba
/// un código que vence mientras lo escanea.
///
/// De ahí que el umbral ámbar del countdown NO sea decorativo: marca el
/// instante en que "generar código nuevo" empieza a generar de verdad uno
/// nuevo. La comparación del servidor es ESTRICTA (`expiresAt > now + 2min`),
/// así que a los 2:00 exactos ya mintea fresco.
const Duration kTermsTokenReuseFloor = Duration(minutes: 2);

/// TTL del mint (`HANDOFF_TOKEN_TTL_MIN = 15`, service:27). Solo se usa para
/// el copy "dura otros 15 minutos"; el countdown SIEMPRE sale del `expiresAt`
/// que respondió el servidor, nunca de sumarle 15 al reloj local.
const Duration kTermsTokenTtl = Duration(minutes: 15);

/// Fase del countdown. Los tres estados del pill del mockup (nota 1).
enum TermsCountdownPhase {
  /// > 2 min: neutro. Re-emitir aquí devuelve el MISMO código.
  live,

  /// ≤ 2 min y aún vivo: ámbar. Re-emitir aquí sí cambia el código.
  closing,

  /// Vencido (o sin `expiresAt`): rojo, el QR deja de servir.
  expired,
}

/// Estado del countdown en un instante dado.
class TermsCountdown {
  const TermsCountdown({required this.remaining, required this.phase});

  /// Nunca negativo: se satura en cero para que el pill muestre `00:00` y no
  /// un tiempo al revés.
  final Duration remaining;
  final TermsCountdownPhase phase;

  static TermsCountdown of(DateTime? expiresAt, {DateTime? now}) {
    if (expiresAt == null) {
      return const TermsCountdown(
        remaining: Duration.zero,
        phase: TermsCountdownPhase.expired,
      );
    }
    final at = now ?? clock.now();
    final left = expiresAt.difference(at);
    if (left <= Duration.zero) {
      return const TermsCountdown(
        remaining: Duration.zero,
        phase: TermsCountdownPhase.expired,
      );
    }
    return TermsCountdown(
      remaining: left,
      // > estricto, igual que el `gt` de Prisma en el servidor.
      phase: left > kTermsTokenReuseFloor
          ? TermsCountdownPhase.live
          : TermsCountdownPhase.closing,
    );
  }

  bool get isExpired => phase == TermsCountdownPhase.expired;

  /// ¿Un "Generar código nuevo" AHORA devolvería el mismo token?
  ///
  /// Es la predicción que sostiene la copy honesta de la re-emisión. No
  /// sustituye a la verdad: la respuesta trae `reused` y la UI muestra lo que
  /// el servidor hizo, no lo que la app creyó (relojes desalineados incluidos).
  bool get reMintWouldReuse => phase == TermsCountdownPhase.live;

  /// `mm:ss` con relleno — el ancho lo estabiliza la tipografía tabular, no
  /// el formato. Sobre una hora (imposible con TTL de 15 min, pero el
  /// `expiresAt` lo manda el servidor) se muestra en minutos totales.
  String get mmss {
    final total = remaining.inSeconds;
    final minutes = total ~/ 60;
    final seconds = total % 60;
    return '${minutes.toString().padLeft(2, '0')}:'
        '${seconds.toString().padLeft(2, '0')}';
  }
}
