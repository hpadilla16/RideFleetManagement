import 'dart:convert';
import 'dart:math';

import 'package:drift/drift.dart';

import '../db/outbox_db.dart';
import '../telemetry/event_logger.dart';
import 'photo_vault.dart';

/// Dueño de una fila nueva: se SELLA al encolar (criterio registrado H5) —
/// userId + tenantId de la sesión y locationId de la sede activa del
/// selector en ese momento. El drenado jamás vuelve a mirar el selector.
class OutboxOwner {
  const OutboxOwner({
    required this.userId,
    required this.tenantId,
    this.locationId,
  });

  final String userId;
  final String tenantId;
  final String? locationId;
}

/// Resultado de encolar: [full] = tope alcanzado (mockup 7D) — el caller
/// PAUSA la captura y lo dice; nada se purga solo.
enum EnqueueResult { ok, full }

/// Kinds soportados — el drenador rechaza cualquier otro (ADR-5: el dinero
/// no existe aquí).
abstract final class OutboxKinds {
  static const inspectionPhoto = 'inspection_photo';
  static const inspectionComplete = 'inspection_complete';
}

/// Escritura y mantenimiento de la bandeja (H5). El DRENADO vive en
/// drainer.dart + drain_coordinator.dart; aquí solo entra/sale trabajo:
/// encolar la cadena de inspección, reintentos/descartes de dead-letter,
/// purga por cambio de cuenta y barrido de huérfanos.
class OutboxService {
  OutboxService({
    required this.db,
    required this.vault,
    required this.logger,
    required OutboxOwner? Function() ownerOf,
  }) : _ownerOf = ownerOf;

  final OutboxDb db;
  final PhotoVault vault;
  final EventLogger logger;
  final OutboxOwner? Function() _ownerOf;

  OutboxOwner _requireOwner() {
    final owner = _ownerOf();
    if (owner == null) {
      // Sin sesión hidratada no hay a quién atar la fila (ADR-7). El flujo
      // de inspección exige carga online antes de capturar, así que esto es
      // un bug de orquestación, no un estado esperable.
      throw StateError('outbox: no hay dueño de sesión para encolar');
    }
    return owner;
  }

  /// Tope alcanzado (50 filas / ~250 MB): la captura nueva se bloquea ANTES
  /// de abrir la cámara (mockup 7D, nota 7).
  Future<bool> isFull() async {
    if (await db.totalRows() >= OutboxDb.maxRows) return true;
    return await vault.totalBytes() >= OutboxDb.maxPhotoBytes;
  }

  /// Encola la foto de un ángulo. Idempotente por `sessionId:angle`:
  /// re-capturar el mismo ángulo REEMPLAZA la fila (y borra el archivo
  /// anterior) — el backend upserta por angleKey, así que un reemplazo local
  /// es coherente con lo que pasaría en el servidor.
  Future<EnqueueResult> enqueuePhoto({
    required String checkoutSessionId,
    required String reservationId,
    required String? reservationNumber,
    required String angleKey,
    required Uint8List jpegBytes,
  }) async {
    final owner = _requireOwner();
    final key = '$checkoutSessionId:$angleKey';
    final existing = await db.byIdempotencyKey(key);
    // El reemplazo de un ángulo ya encolado no cuenta contra el tope: no
    // agrega fila nueva (y libera el archivo viejo).
    if (existing == null && await isFull()) return EnqueueResult.full;

    final photoName = await vault.store(jpegBytes);
    final payload = json.encode({
      'checkoutSessionId': checkoutSessionId,
      'reservationId': reservationId,
      'reservationNumber': reservationNumber,
      'angleKey': angleKey,
      'photoPath': photoName,
      'bytes': jpegBytes.length,
      'capturedAt': DateTime.now().toIso8601String(),
    });

    if (existing != null) {
      final oldPath = _photoPathOf(existing);
      await (db.update(db.outboxEntries)
            ..where((t) => t.id.equals(existing.id)))
          .write(OutboxEntriesCompanion(
        payload: Value(payload),
        status: const Value('pending'),
        attempts: const Value(0),
        lastError: const Value(null),
        lastErrorCode: const Value(null),
        lastErrorStatus: const Value(null),
        updatedAt: Value(DateTime.now()),
      ));
      if (oldPath != null && oldPath != photoName) await vault.delete(oldPath);
    } else {
      final now = DateTime.now();
      await db.into(db.outboxEntries).insert(OutboxEntriesCompanion.insert(
            id: newOutboxId(),
            userId: owner.userId,
            tenantId: owner.tenantId,
            locationId: Value(owner.locationId),
            groupKey: Value(checkoutSessionId),
            kind: OutboxKinds.inspectionPhoto,
            payload: payload,
            idempotencyKey: key,
            createdAt: now,
            updatedAt: now,
          ));
    }
    logger.log(OutboxEvents.enqueued, data: {
      'kind': OutboxKinds.inspectionPhoto,
      'queue_depth': await db.totalRows(),
    });
    return EnqueueResult.ok;
  }

  /// Encola el complete de la cadena, con [OutboxEntries.dependsOn] a la
  /// ÚLTIMA foto encolada de la sesión (spike 2: fotos primero, complete al
  /// final). Idempotente por `sessionId:complete` — re-terminar reemplaza el
  /// body (última firma/métricas ganan).
  Future<EnqueueResult> enqueueComplete({
    required String checkoutSessionId,
    required String reservationId,
    required String? reservationNumber,
    required Map<String, dynamic> body,
  }) async {
    final owner = _requireOwner();
    final key = '$checkoutSessionId:complete';
    final existing = await db.byIdempotencyKey(key);
    if (existing == null && await isFull()) return EnqueueResult.full;

    final photos = (await db.byGroupKey(checkoutSessionId))
        .where((r) => r.kind == OutboxKinds.inspectionPhoto)
        .toList();
    final lastPhotoId = photos.isEmpty ? null : photos.last.id;

    final payload = json.encode({
      'checkoutSessionId': checkoutSessionId,
      'reservationId': reservationId,
      'reservationNumber': reservationNumber,
      'body': body,
    });

    if (existing != null) {
      await (db.update(db.outboxEntries)
            ..where((t) => t.id.equals(existing.id)))
          .write(OutboxEntriesCompanion(
        payload: Value(payload),
        dependsOn: Value(lastPhotoId),
        status: const Value('pending'),
        attempts: const Value(0),
        lastError: const Value(null),
        lastErrorCode: const Value(null),
        lastErrorStatus: const Value(null),
        updatedAt: Value(DateTime.now()),
      ));
    } else {
      final now = DateTime.now();
      await db.into(db.outboxEntries).insert(OutboxEntriesCompanion.insert(
            id: newOutboxId(),
            userId: owner.userId,
            tenantId: owner.tenantId,
            locationId: Value(owner.locationId),
            groupKey: Value(checkoutSessionId),
            kind: OutboxKinds.inspectionComplete,
            payload: payload,
            dependsOn: Value(lastPhotoId),
            idempotencyKey: key,
            createdAt: now,
            updatedAt: now,
          ));
    }
    logger.log(InspectionEvents.completedLocal);
    logger.log(OutboxEvents.enqueued, data: {
      'kind': OutboxKinds.inspectionComplete,
      'queue_depth': await db.totalRows(),
    });
    return EnqueueResult.ok;
  }

  /// Reintento manual de un dead-letter (mockup 7B). El caller dispara el
  /// drenado después.
  Future<void> retryDead(String rowId) => db.resetDeadToPending(rowId);

  /// Descarte de un dead-letter con RASTRO de auditoría (mockup 7B′,
  /// requisito de build): quién, qué, motivo, hora — lo descartado puede ser
  /// evidencia de daños y no se evapora sin registro.
  Future<void> discardDead(OutboxEntry row) async {
    await _auditAndDelete(row, reasonCode: row.lastErrorCode ?? 'DISCARDED');
  }

  /// Purga selectiva de 6F: otra superficie completó la inspección — los
  /// envíos PENDIENTES de ESA sesión se retiran (con rastro) para no mandar
  /// duplicados.
  ///
  /// **Las filas `dead` se quedan, y esa excepción es el punto entero.** El
  /// motivo del purgado —no re-estampar sellos sobre una sesión que otra
  /// superficie ya cerró— aplica a lo que TODAVÍA se iba a mandar. Una fila
  /// muerta no se va a mandar: está esperando una decisión humana sobre
  /// EVIDENCIA DE DAÑOS, y borrarla porque el servidor selló la inspección
  /// hace desaparecer esa decisión sin que nadie la tome. Medido en la
  /// corrida e2e 2: "1 envío necesita tu decisión" → el servidor sella → la
  /// fila se esfuma sin aviso. Contra el DoD: el dead-letter es visible y
  /// solo el usuario lo descarta ([discardDead], con su sheet de
  /// consecuencias y su rastro).
  ///
  /// Devuelve cuántas filas se llevó (las vivas).
  Future<int> discardSession(String checkoutSessionId) async {
    final rows = (await db.byGroupKey(checkoutSessionId))
        .where((r) => r.status != 'dead')
        .toList();
    for (final row in rows) {
      await _auditAndDelete(row, reasonCode: 'SESSION_COMPLETED');
    }
    return rows.length;
  }

  /// Purga al cerrar sesión (ADR-7 / mockup 7C nota 6): la bandeja pertenece
  /// a la cuenta — filas Y archivos de foto se van. Devuelve cuántas filas
  /// se llevó (para telemetría/aviso).
  Future<int> purgeAllForLogout() async {
    final purged = await db.purgeAll();
    await _finishAccountPurge(purged, reasonCode: 'ACCOUNT_LOGOUT');
    return purged.length;
  }

  /// Purga por cambio de cuenta AL ENTRAR (ADR-7): todo lo que no sea del
  /// usuario entrante se va — cubre el caso de un crash/401 que dejó filas
  /// de la cuenta anterior sin el purge del logout explícito.
  Future<int> purgeForeign(String incomingUserId) async {
    final purged = await db.purgeNotOwnedBy(userId: incomingUserId);
    await _finishAccountPurge(purged, reasonCode: 'ACCOUNT_FOREIGN');
    return purged.length;
  }

  /// Cola común de las purgas de cuenta (QA MINOR-2): borrar archivos +
  /// telemetría + UNA fila resumen de auditoría — lo purgado pudo ser
  /// evidencia y hasta ahora TTL y descartes auditaban pero las purgas de
  /// cuenta no. El dueño del resumen sale de las propias filas purgadas
  /// (en logout la sesión puede estar ya a medio morir).
  Future<void> _finishAccountPurge(
    List<OutboxEntry> purged, {
    required String reasonCode,
  }) async {
    var photos = 0;
    for (final row in purged) {
      final path = _photoPathOf(row);
      if (path != null) {
        photos++;
        await vault.delete(path);
      }
    }
    if (purged.isEmpty) return;
    logger.log(OutboxEvents.purgedAccountSwitch,
        data: {'rows': purged.length, 'reason': reasonCode});
    final owner = purged.first;
    await db.insertAudit(OutboxAuditEntriesCompanion.insert(
      id: newOutboxId(),
      userId: owner.userId,
      tenantId: owner.tenantId,
      locationId: Value(owner.locationId),
      rowId: 'batch',
      rowKind: 'account_purge',
      summary: json.encode({'rows': purged.length, 'photos': photos}),
      reasonCode: Value(reasonCode),
      discardedAt: DateTime.now(),
    ));
  }

  /// TTL de arranque (ADR-7 "purga agresiva", review INN O-1): filas —y sus
  /// fotos— más viejas que [ttl] se van, con rastro de auditoría
  /// TTL_EXPIRED (lo purgado pudo ser evidencia; no se evapora sin
  /// registro). Cubre el residuo de un 401 sin re-login posterior.
  Future<int> purgeStale({Duration ttl = const Duration(days: 14)}) async {
    final purged = await db.purgeOlderThan(DateTime.now().subtract(ttl));
    for (final row in purged) {
      final payload = _payloadOf(row);
      final summary = json.encode({
        'reservationNumber': payload['reservationNumber'],
        'reservationId': payload['reservationId'],
        'angleKey': payload['angleKey'],
        'attempts': row.attempts,
      });
      await db.insertAudit(OutboxAuditEntriesCompanion.insert(
        id: newOutboxId(),
        userId: row.userId,
        tenantId: row.tenantId,
        locationId: Value(row.locationId),
        rowId: row.id,
        rowKind: row.kind,
        summary: summary,
        reasonCode: const Value('TTL_EXPIRED'),
        discardedAt: DateTime.now(),
      ));
      final path = _photoPathOf(row);
      if (path != null) await vault.delete(path);
    }
    if (purged.isNotEmpty) {
      logger.log(OutboxEvents.purgedAccountSwitch,
          data: {'rows': purged.length, 'reason': 'ttl'});
    }
    return purged.length;
  }

  /// Barrido de arranque: archivos de la bóveda SIN fila que los referencie
  /// (crash entre borrar fila y borrar archivo) se borran. Historia M1.
  Future<int> sweepOrphanFiles() async {
    final rows = await (db.select(db.outboxEntries)).get();
    final referenced = <String>{
      for (final row in rows)
        if (_photoPathOf(row) case final String path) path,
    };
    return vault.sweepOrphans(referencedNames: referenced);
  }

  Future<void> _auditAndDelete(OutboxEntry row,
      {required String reasonCode}) async {
    final payload = _payloadOf(row);
    // Resumen NO sensible: reserva + ángulo. Jamás el binario ni la firma.
    final summary = json.encode({
      'reservationNumber': payload['reservationNumber'],
      'reservationId': payload['reservationId'],
      'angleKey': payload['angleKey'],
      'attempts': row.attempts,
    });
    await db.insertAudit(OutboxAuditEntriesCompanion.insert(
      id: newOutboxId(),
      userId: row.userId,
      tenantId: row.tenantId,
      locationId: Value(row.locationId),
      rowId: row.id,
      rowKind: row.kind,
      summary: summary,
      reasonCode: Value(reasonCode),
      discardedAt: DateTime.now(),
    ));
    await db.deleteRow(row.id);
    final path = _photoPathOf(row);
    if (path != null) await vault.delete(path);
  }

  static Map<String, dynamic> _payloadOf(OutboxEntry row) {
    try {
      return json.decode(row.payload) as Map<String, dynamic>;
    } catch (_) {
      return const {};
    }
  }

  static String? _photoPathOf(OutboxEntry row) =>
      _payloadOf(row)['photoPath'] as String?;

  static String newOutboxId() {
    final rng = Random.secure();
    final sb = StringBuffer('ob_');
    for (var i = 0; i < 16; i++) {
      sb.write(rng.nextInt(256).toRadixString(16).padLeft(2, '0'));
    }
    return sb.toString();
  }
}
