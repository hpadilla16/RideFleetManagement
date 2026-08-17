/// Frescura del chip de presencia (mockup 8A, nota 3).
///
/// Regla dura: **el punto verde no puede afirmar más de lo que el TTL
/// respalda**. El heartbeat de P1 vive 45 s lógicos
/// (`PRESENCE_TTL_MS`, checkout-presence.service.js) y el servidor ya filtra
/// por eso; lo que la app decide aquí es solo cuánta confianza dibuja:
///
///  - `< 20 s` → punto vivo: el compañero está ahí AHORA.
///  - `20–45 s` → punto apagado: probablemente sigue, pero el dato ya respira
///    viejo (dos ciclos de poll perdidos).
///  - `> 45 s` (o sin `lastSeenAt`) → **no se muestra**: el servidor no
///    debería mandarlo, y si un reloj desfasado lo cuela, la app no va a
///    afirmar una presencia que el TTL ya no sostiene.
library;

import '../../../core/api/dto/checkout_session.dart';

/// TTL lógico del backend — espejo del `PRESENCE_TTL_MS` de P1.
const Duration kPresenceTtl = Duration(seconds: 45);

/// Umbral del punto "vivo".
const Duration kPresenceLiveWindow = Duration(seconds: 20);

enum PresenceFreshness { live, fading, expired }

PresenceFreshness presenceFreshness(DateTime? lastSeenAt, DateTime now) {
  if (lastSeenAt == null) return PresenceFreshness.expired;
  final age = now.difference(lastSeenAt);
  // Reloj del teléfono adelantado respecto al servidor: una edad NEGATIVA no
  // es motivo para descartar la presencia (es desfase, no ausencia).
  if (age.isNegative || age < kPresenceLiveWindow) return PresenceFreshness.live;
  if (age <= kPresenceTtl) return PresenceFreshness.fading;
  return PresenceFreshness.expired;
}

/// Presencia a pintar: la más reciente aún válida y cuántas más hay detrás
/// ("+2" del mockup). Null cuando el backend no emite el campo (P1 sin
/// desplegar) o cuando nadie sigue dentro del TTL.
class PresenceChipData {
  const PresenceChipData({
    required this.entry,
    required this.freshness,
    required this.others,
  });

  final CheckoutPresenceDto entry;
  final PresenceFreshness freshness;

  /// Cuántas presencias frescas ADICIONALES hay.
  final int others;
}

PresenceChipData? pickPresenceChip(
  List<CheckoutPresenceDto>? presence,
  DateTime now,
) {
  if (presence == null || presence.isEmpty) return null;
  final fresh = <(CheckoutPresenceDto, PresenceFreshness)>[];
  for (final p in presence) {
    final f = presenceFreshness(p.lastSeenAt, now);
    if (f != PresenceFreshness.expired) fresh.add((p, f));
  }
  if (fresh.isEmpty) return null;
  // El serializer ya ordena por lastSeenAt desc, pero re-ordenar aquí lo hace
  // independiente de ese detalle del backend (y de un orden que cambie).
  fresh.sort((a, b) {
    final at = a.$1.lastSeenAt;
    final bt = b.$1.lastSeenAt;
    if (at == null || bt == null) return 0;
    return bt.compareTo(at);
  });
  return PresenceChipData(
    entry: fresh.first.$1,
    freshness: fresh.first.$2,
    others: fresh.length - 1,
  );
}
