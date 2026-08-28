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
import '../../../core/api/enums.dart';

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

/// [myUserId]: el empleado de ESTE teléfono. Su propia presencia jamás se
/// pinta — un chip que dice "María G. está en esta sesión" cuando María G.
/// eres tú no informa de nada y destruye la única señal que el chip aporta.
///
/// El filtro está listo pero HOY es inerte: el serializer de P1 no manda
/// `actorUserId` (ver el WHY en el DTO) y RideOps todavía no late. Cuando H6
/// encienda el heartbeat, este filtro tiene que estar respaldado por el campo
/// del backend — si no llega, la alternativa es que la app no pinte presencias
/// de su propia superficie, que es peor (ocultaría a un compañero en otro
/// teléfono RideOps).
PresenceChipData? pickPresenceChip(
  List<CheckoutPresenceDto>? presence,
  DateTime now, {
  String? myUserId,
}) {
  if (presence == null || presence.isEmpty) return null;
  final fresh = <(CheckoutPresenceDto, PresenceFreshness)>[];
  for (final p in presence) {
    if (myUserId != null && p.actorUserId == myUserId) continue;
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

/// Una fila de la hoja "Quién está en esta sesión" (20B), ya clasificada.
///
/// Existe porque el mockup manda una regla que NO es cosmética (nota 4):
/// **una persona y un aparato no se dibujan igual**. El kiosco del lobby y el
/// teléfono del cliente laten con `actorUserId` null a propósito — el aparato
/// no tiene usuario — y el backend les resuelve el nombre con la etiqueta
/// genérica de la superficie. Aplanar los dos casos le quitaría al agente la
/// única decisión que la hoja habilita: a "Diego Torres · mostrador" le gritas
/// desde la otra punta del patio; al kiosco hay que caminarle al lobby.
class PresenceRosterEntry {
  const PresenceRosterEntry({
    required this.entry,
    required this.freshness,
    required this.surface,
    required this.isDevice,
  });

  final CheckoutPresenceDto entry;
  final PresenceFreshness freshness;

  /// Tipada cuando la app la conoce; null para una superficie nueva del
  /// servidor (que se pinta con la etiqueta genérica y sigue viva).
  final CheckoutSurface? surface;

  /// Aparato (kiosco / teléfono del cliente) en vez de persona con nombre.
  /// Una superficie DESCONOCIDA no se declara aparato: sin saber qué es, no
  /// se le quita el nombre a alguien que podría tenerlo.
  final bool isDevice;

  String get displayName => entry.displayName;
  DateTime? get lastSeenAt => entry.lastSeenAt;
}

/// Lista completa y fresca para la hoja 20B, en el mismo orden que el chip
/// (más reciente primero) y con el MISMO filtro de "no me listes a mí mismo".
///
/// Se separa de [pickPresenceChip] a propósito y no lo reemplaza: el chip solo
/// necesita la cabeza y un contador, y hacerle construir la lista entera por
/// cada frame del header sería trabajo por nada.
///
/// **Lista vacía NO es soledad.** Igual que en el chip: `null` (backend sin
/// P1, o respuesta que no pasó por `withPresence`) y `[]` (nadie dentro del
/// TTL **o** la lectura de presencia falló y degradó a vacío) son
/// indistinguibles por contrato. Quien pinte esto tiene que decir "no hay
/// nadie visible", jamás "estás solo".
List<PresenceRosterEntry> presenceRoster(
  List<CheckoutPresenceDto>? presence,
  DateTime now, {
  String? myUserId,
}) {
  if (presence == null || presence.isEmpty) return const [];
  final out = <PresenceRosterEntry>[];
  for (final p in presence) {
    if (myUserId != null && p.actorUserId == myUserId) continue;
    final f = presenceFreshness(p.lastSeenAt, now);
    if (f == PresenceFreshness.expired) continue;
    final surface = CheckoutSurface.tryParse(p.surface);
    out.add(PresenceRosterEntry(
      entry: p,
      freshness: f,
      surface: surface,
      isDevice: surface?.isDevice ?? false,
    ));
  }
  out.sort((a, b) {
    final at = a.lastSeenAt;
    final bt = b.lastSeenAt;
    if (at == null || bt == null) return 0;
    return bt.compareTo(at);
  });
  return out;
}

/// ¿Hay un APARATO volteado al cliente latiendo ahora mismo? (frame 23B.)
///
/// Es la única lectura de presencia que cambia lo que la pantalla ACONSEJA —
/// nunca lo que permite. Un kiosco vivo en el paso de firma significa que el
/// cliente tiene el dedo en el lienzo del otro lado del lobby; avanzar desde
/// aquí le interrumpe la firma. Pero el CTA sigue existiendo: presencia que
/// bloquea es un lease, y un kiosco al que se le acabó la batería a mitad de
/// firma atascaría la salida hasta que expire el TTL. Eso es exactamente lo
/// que el módulo del backend prohíbe.
///
/// Solo cuenta [PresenceFreshness.live]: "ahora mismo" con un dato de 40 s no
/// es ahora mismo, y el consejo pierde su razón de ser.
bool hasLiveDevicePresence(List<PresenceRosterEntry> roster) =>
    roster.any((r) => r.isDevice && r.freshness == PresenceFreshness.live);
