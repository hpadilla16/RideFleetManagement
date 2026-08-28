/// Atribución con NOMBRE del avance ajeno (M2-H6, §21 nota 10).
///
/// El problema: `events[]` guarda `actorUserId`, no un nombre. El banner de H1
/// ya dice «lo completó otro agente», que es cierto y casi inútil en un patio
/// con tres agentes. Lo que el mockup pide es «lo completó Diego Torres».
///
/// **Este archivo es el ÚNICO punto de consumo de `presence[].actorUserId`.**
/// El serializer de P1 mapea hoy solo `{surface, displayName, lastSeenAt}`
/// (checkout-presence.service.js:139-145): el id NO viaja todavía. Se está
/// añadiendo en paralelo (`feat/presence-actor-id`, una línea en el map de
/// `activePresence()`), y esta función está escrita CONTRA ese contrato:
///
///  - mientras el campo llegue null ⇒ [resolveActorName] devuelve null y la
///    UI cae al copy genérico de H1 («otro agente»), que es exactamente lo que
///    hay hoy: **degradación a lo ya construido, no a un hueco**;
///  - en cuanto el backend lo emita, los nombres aparecen sin tocar UI.
///
/// **Lo que a propósito NO se hace: adivinar por nombre.** La tentación es
/// comparar `displayName` con el `fullName` propio, o mapear "el único agente
/// presente" al autor del evento. Las dos mienten con dos empleados homónimos
/// o con un compañero que abrió la sesión y ya se fue — y una atribución
/// equivocada en el registro de una entrega es peor que no tener atribución.
/// Sin id, no se afirma un nombre.
library;

import '../../../core/api/dto/checkout_session.dart';
import 'checkout_event_log.dart';

/// Índice `actorUserId → displayName` construido desde la presencia FRESCA de
/// la sesión. Vacío cuando el backend todavía no emite el id.
///
/// Solo se indexan filas con id **y** nombre: una entrada con nombre vacío
/// haría que la UI dibujara «lo completó » con un hueco al final.
Map<String, String> presenceNamesById(List<CheckoutPresenceDto>? presence) {
  if (presence == null || presence.isEmpty) return const {};
  final out = <String, String>{};
  for (final p in presence) {
    final id = p.actorUserId;
    if (id == null || id.isEmpty) continue;
    if (p.displayName.isEmpty) continue;
    out[id] = p.displayName;
  }
  return out;
}

/// Nombre del autor de [event], o null si no se puede AFIRMAR.
///
/// Null tiene tres causas y todas terminan en el mismo copy genérico:
/// el evento no trae actor (kiosco, barrido del scheduler), el actor somos
/// nosotros (eso se dice con «tú», no con el nombre propio), o el actor ya no
/// está presente / el backend aún no manda el id.
///
/// Se resuelve SOLO contra quien está presente ahora. No es una limitación
/// disimulada: un agente que movió el paso hace 40 s y sigue en la sesión es
/// justo el caso que el patio necesita nombrar («ve y dile a Diego»), y uno
/// que se fue hace dos horas no cambia ninguna decisión.
String? resolveActorName(
  CheckoutEvent? event, {
  required Map<String, String> namesById,
  required String? myUserId,
}) {
  if (event == null) return null;
  final actor = event.actorUserId;
  if (actor == null || actor.isEmpty) return null;
  if (myUserId != null && actor == myUserId) return null;
  final name = namesById[actor];
  return (name == null || name.isEmpty) ? null : name;
}
