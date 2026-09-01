import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/db/outbox_db.dart';
import '../../../core/db/outbox_providers.dart';
import '../../../core/outbox/outbox_service.dart';

/// Estado de UNA fila de inspección dentro de la bandeja.
///
/// Ojo con lo que NO existe aquí: "enviada". Una fila enviada **no está** en
/// la bandeja — el drenado la borra (`markDrained`, outbox_db.dart) y eso solo
/// pasa con `DrainOk`, o sea con 2xx del servidor. Por eso "el servidor la
/// tiene" se deduce de la AUSENCIA de fila, nunca de un estado guardado.
enum OutboxDelivery {
  /// pending | inflight: sigue en el teléfono.
  queued,

  /// dead-letter: el servidor la rechazó de forma permanente, o se agotaron
  /// los reintentos. Visible al usuario, jamás un descarte silencioso.
  dead,
}

/// Lo que la BANDEJA sabe de una inspección concreta (agrupada por
/// `groupKey` = checkoutSessionId).
///
/// Es la mitad local de la verdad del paso 4: la otra mitad —los sellos— vive
/// en la sesión del servidor. La pantalla nunca mezcla las dos en una sola
/// frase (frame 17D: "completa en este teléfono" ≠ completa).
@immutable
class InspectionOutboxView {
  const InspectionOutboxView({
    this.photos = const {},
    this.completeDelivery,
    this.deadReasons = const {},
    this.deadRowIds = const [],
    this.queuedRows = 0,
    this.deadRows = 0,
    this.loaded = false,
  });

  /// angleKey → cómo está su fila. Un ángulo AUSENTE del mapa no tiene fila:
  /// o nunca se encoló, o ya drenó contra el servidor.
  final Map<String, OutboxDelivery> photos;

  /// El `inspection_complete` de esta sesión, si sigue en la bandeja.
  final OutboxDelivery? completeDelivery;

  /// angleKey → motivo con el que MURIÓ su fila, tal como lo mandó el backend
  /// (`lastError`). Se muestra crudo (DoD #5): la app no reescribe la negativa
  /// del servidor, solo la enmarca.
  final Map<String, String> deadReasons;

  /// ids de las filas muertas de ESTA sesión — el reintento del 17E las
  /// resucita todas de una (nota 13: dos operaciones, un botón).
  final List<String> deadRowIds;

  /// Filas esperando red (pending + inflight) y filas muertas.
  final int queuedRows;
  final int deadRows;

  /// El stream de la bandeja ya emitió al menos una vez. Mientras es false no
  /// se afirma NADA sobre envíos: sin lectura, "no hay fila" no significa
  /// "llegó al servidor".
  final bool loaded;

  int get totalRows => queuedRows + deadRows;

  /// Fotos que siguen en el teléfono (las que el 17D cuenta como "faltan por
  /// enviar"). Las muertas no cuentan: esas no van a salir solas.
  int get queuedPhotos =>
      photos.values.where((d) => d == OutboxDelivery.queued).length;

  bool get completeQueued => completeDelivery == OutboxDelivery.queued;
  bool get completeDead => completeDelivery == OutboxDelivery.dead;

  /// ¿La fila de este ángulo murió en la bandeja?
  bool isDeadAngle(String angleKey) =>
      photos[angleKey] == OutboxDelivery.dead;
}

/// Deriva la vista desde las filas crudas. Función pura y aparte del provider
/// a propósito: se prueba contra filas REALES de la DB (no contra un objeto
/// que el propio test rellenó a mano).
InspectionOutboxView inspectionOutboxViewOf(
  List<OutboxEntry> rows, {
  required String checkoutSessionId,
}) {
  final photos = <String, OutboxDelivery>{};
  final reasons = <String, String>{};
  final deadIds = <String>[];
  OutboxDelivery? complete;
  var queued = 0;
  var dead = 0;

  for (final row in rows) {
    // groupKey ES el checkoutSessionId (outbox_db.dart). Filtrar por él y no
    // por el payload evita parsear JSON de filas de otras sesiones.
    if (row.groupKey != checkoutSessionId) continue;
    final isDead = row.status == 'dead';
    final delivery = isDead ? OutboxDelivery.dead : OutboxDelivery.queued;
    if (isDead) {
      dead++;
      deadIds.add(row.id);
    } else {
      queued++;
    }
    switch (row.kind) {
      case OutboxKinds.inspectionPhoto:
        final angleKey = _angleKeyOf(row);
        if (angleKey != null) {
          photos[angleKey] = delivery;
          final reason = row.lastError;
          if (isDead && reason != null && reason.isNotEmpty) {
            reasons[angleKey] = reason;
          }
        }
      case OutboxKinds.inspectionComplete:
        complete = delivery;
    }
  }

  return InspectionOutboxView(
    photos: photos,
    completeDelivery: complete,
    deadReasons: reasons,
    deadRowIds: deadIds,
    queuedRows: queued,
    deadRows: dead,
    loaded: true,
  );
}

String? _angleKeyOf(OutboxEntry row) {
  try {
    return (json.decode(row.payload) as Map<String, dynamic>)['angleKey']
        as String?;
  } catch (_) {
    // Payload ilegible: la fila cuenta para los totales, pero no se le
    // atribuye un ángulo (mejor un contador honesto que un tile mal pintado).
    return null;
  }
}

/// Vista viva de la bandeja para UNA sesión de checkout.
///
/// Se cuelga del stream que ya existe (`outboxRowsProvider`, filtrado por
/// dueño): el paso 4 no abre una consulta propia ni un timer — se repinta con
/// cada escritura del drenado, que es justo lo que hace visible el paso de
/// "en bandeja" a "el servidor la tiene".
final inspectionOutboxProvider =
    Provider.family<InspectionOutboxView, String>((ref, checkoutSessionId) {
  final rows = ref.watch(outboxRowsProvider).value;
  if (rows == null) return const InspectionOutboxView();
  return inspectionOutboxViewOf(rows, checkoutSessionId: checkoutSessionId);
});
