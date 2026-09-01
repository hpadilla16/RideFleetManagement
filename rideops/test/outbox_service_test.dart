import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:drift/drift.dart' show Value;
import 'package:drift/native.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:rideops/core/db/outbox_db.dart';
import 'package:rideops/core/outbox/outbox_service.dart';
import 'package:rideops/core/outbox/photo_vault.dart';
import 'package:rideops/core/telemetry/event_logger.dart';

/// OutboxService (H5): encolado de la cadena con el dueño SELLADO
/// (userId/tenantId/locationId — criterio registrado), idempotencia por
/// `sessionId:angle`, tope que PAUSA, purga con borrado de archivos y rastro
/// de auditoría en descartes.
class RecordingLogger implements EventLogger {
  final events = <(String, Map<String, Object?>)>[];

  @override
  void log(String event, {Map<String, Object?> data = const {}}) {
    events.add((event, data));
  }

  Iterable<String> get names => events.map((e) => e.$1);
}

void main() {
  late OutboxDb db;
  late Directory tempDir;
  late PhotoVault vault;
  late RecordingLogger logger;
  late OutboxService service;
  OutboxOwner? owner;

  Uint8List photo([int seed = 1]) =>
      Uint8List.fromList(List.generate(400, (i) => (i + seed) % 256));

  setUp(() {
    db = OutboxDb(NativeDatabase.memory());
    tempDir = Directory.systemTemp.createTempSync('rideops_svc_test');
    vault = PhotoVault(
      baseDir: () async => tempDir,
      obtainKeyBytes: () async =>
          Uint8List.fromList(List.generate(32, (i) => i)),
    );
    logger = RecordingLogger();
    owner = const OutboxOwner(
      userId: 'u1',
      tenantId: 't1',
      locationId: 'loc-centro',
    );
    service = OutboxService(
      db: db,
      vault: vault,
      logger: logger,
      ownerOf: () => owner,
    );
  });

  tearDown(() async {
    await db.close();
    try {
      tempDir.deleteSync(recursive: true);
    } catch (_) {}
  });

  test('enqueuePhoto sella dueño + sede activa y cifra el binario', () async {
    final result = await service.enqueuePhoto(
      checkoutSessionId: 'cs1',
      reservationId: 'r1',
      reservationNumber: 'R-42',
      angleKey: 'front',
      jpegBytes: photo(),
    );
    expect(result, EnqueueResult.ok);

    final rows = await db.allFor(userId: 'u1', tenantId: 't1');
    expect(rows, hasLength(1));
    final row = rows.single;
    expect(row.userId, 'u1');
    expect(row.tenantId, 't1');
    expect(row.locationId, 'loc-centro',
        reason: 'la sede activa se SELLA al encolar (criterio H5)');
    expect(row.groupKey, 'cs1');
    expect(row.idempotencyKey, 'cs1:front');
    expect(row.kind, OutboxKinds.inspectionPhoto);

    final payload = json.decode(row.payload) as Map<String, dynamic>;
    expect(payload['reservationNumber'], 'R-42');
    expect(payload['bytes'], 400);
    // El binario vive en la bóveda (cifrado), no en la fila.
    final stored = await vault.read(payload['photoPath'] as String);
    expect(stored, photo());
    expect(logger.names, contains(OutboxEvents.enqueued));
  });

  test('re-capturar el mismo ángulo REEMPLAZA la fila y borra el archivo viejo',
      () async {
    await service.enqueuePhoto(
      checkoutSessionId: 'cs1',
      reservationId: 'r1',
      reservationNumber: 'R-42',
      angleKey: 'front',
      jpegBytes: photo(1),
    );
    final firstPath = (json.decode(
      (await db.allFor(userId: 'u1', tenantId: 't1')).single.payload,
    ) as Map<String, dynamic>)['photoPath'] as String;

    await service.enqueuePhoto(
      checkoutSessionId: 'cs1',
      reservationId: 'r1',
      reservationNumber: 'R-42',
      angleKey: 'front',
      jpegBytes: photo(2),
    );

    final rows = await db.allFor(userId: 'u1', tenantId: 't1');
    expect(rows, hasLength(1), reason: 'upsert, no duplicado');
    final newPath = (json.decode(rows.single.payload)
        as Map<String, dynamic>)['photoPath'] as String;
    expect(newPath, isNot(firstPath));
    expect(await vault.read(firstPath), isNull,
        reason: 'el binario reemplazado no queda huérfano');
    expect(await vault.read(newPath), photo(2));
  });

  test('enqueueComplete cuelga dependsOn de la ÚLTIMA foto de la sesión',
      () async {
    await service.enqueuePhoto(
      checkoutSessionId: 'cs1',
      reservationId: 'r1',
      reservationNumber: 'R-42',
      angleKey: 'front',
      jpegBytes: photo(),
    );
    await service.enqueuePhoto(
      checkoutSessionId: 'cs1',
      reservationId: 'r1',
      reservationNumber: 'R-42',
      angleKey: 'rear',
      jpegBytes: photo(),
    );
    await service.enqueueComplete(
      checkoutSessionId: 'cs1',
      reservationId: 'r1',
      reservationNumber: 'R-42',
      body: {
        'odometer': 48212,
        'fuelLevel': 0.75,
        'cleanliness': 4,
        'notes': null,
        'signatureDataUrl': 'data:image/png;base64,${'x' * 300}',
        'signerName': null,
      },
    );

    final rows = await db.allFor(userId: 'u1', tenantId: 't1');
    final complete =
        rows.singleWhere((r) => r.kind == OutboxKinds.inspectionComplete);
    final photos =
        rows.where((r) => r.kind == OutboxKinds.inspectionPhoto).toList();
    expect(complete.dependsOn, photos.last.id,
        reason: 'la cadena del spike 2: fotos → complete');
    expect(complete.idempotencyKey, 'cs1:complete');
    final body = (json.decode(complete.payload)
        as Map<String, dynamic>)['body'] as Map<String, dynamic>;
    expect(body['fuelLevel'], 0.75);
    expect(logger.names, contains(InspectionEvents.completedLocal));
  });

  test('el tope PAUSA el encolado sin purgar (mockup 7D)', () async {
    // Llenar hasta el tope con filas mínimas de otro flujo.
    final now = DateTime.now();
    for (var i = 0; i < OutboxDb.maxRows; i++) {
      await db.into(db.outboxEntries).insert(
            OutboxEntriesCompanion.insert(
              id: 'fill-$i',
              userId: 'u1',
              tenantId: 't1',
              kind: OutboxKinds.inspectionPhoto,
              payload: '{}',
              idempotencyKey: 'fill-$i',
              createdAt: now,
              updatedAt: now,
            ),
          );
    }
    expect(await service.isFull(), isTrue);

    final result = await service.enqueuePhoto(
      checkoutSessionId: 'cs9',
      reservationId: 'r9',
      reservationNumber: 'R-9',
      angleKey: 'front',
      jpegBytes: photo(),
    );
    expect(result, EnqueueResult.full);
    expect(await db.totalRows(), OutboxDb.maxRows,
        reason: 'nada se purga solo; el tope solo pausa');
    expect(await vault.totalBytes(), 0,
        reason: 'con la bandeja llena no se escribe ni el archivo');
  });

  test('purgeAllForLogout borra filas Y archivos + telemetría', () async {
    await service.enqueuePhoto(
      checkoutSessionId: 'cs1',
      reservationId: 'r1',
      reservationNumber: 'R-42',
      angleKey: 'front',
      jpegBytes: photo(),
    );
    final purged = await service.purgeAllForLogout();
    expect(purged, 1);
    expect(await db.totalRows(), 0);
    expect(await vault.totalBytes(), 0,
        reason: 'PII fuera de disco al cerrar sesión (ADR-7)');
    expect(logger.names, contains(OutboxEvents.purgedAccountSwitch));
    // QA MINOR-2: la purga de cuenta deja fila resumen de auditoría.
    final audit = (await db.auditRows()).single;
    expect(audit.reasonCode, 'ACCOUNT_LOGOUT');
    expect(audit.rowKind, 'account_purge');
    expect(audit.userId, 'u1', reason: 'el dueño sale de lo purgado');
    final summary = json.decode(audit.summary) as Map<String, dynamic>;
    expect(summary['rows'], 1);
    expect(summary['photos'], 1);
  });

  test('purgeForeign al entrar OTRA cuenta se lleva filas y archivos ajenos',
      () async {
    await service.enqueuePhoto(
      checkoutSessionId: 'cs1',
      reservationId: 'r1',
      reservationNumber: 'R-42',
      angleKey: 'front',
      jpegBytes: photo(),
    );
    final purged = await service.purgeForeign('u2');
    expect(purged, 1);
    expect(await db.totalRows(), 0);
    expect(await vault.totalBytes(), 0);
    // QA MINOR-2: también la purga por cuenta ajena deja resumen.
    final audit = (await db.auditRows()).single;
    expect(audit.reasonCode, 'ACCOUNT_FOREIGN');
    expect(audit.rowKind, 'account_purge');
  });

  test('discardDead deja RASTRO de auditoría (quién/qué/motivo/hora)',
      () async {
    await service.enqueuePhoto(
      checkoutSessionId: 'cs1',
      reservationId: 'r1',
      reservationNumber: 'R-42',
      angleKey: 'front',
      jpegBytes: photo(),
    );
    final row = (await db.allFor(userId: 'u1', tenantId: 't1')).single;
    await db.markFailed(row.id,
        error: 'faltan', code: 'REQUIRED_ANGLES_MISSING', dead: true);

    await service.discardDead((await db.byId(row.id))!);

    expect(await db.totalRows(), 0);
    expect(await vault.totalBytes(), 0);
    final audit = await db.auditRows();
    expect(audit, hasLength(1));
    expect(audit.single.userId, 'u1');
    expect(audit.single.reasonCode, 'REQUIRED_ANGLES_MISSING');
    expect(audit.single.rowKind, OutboxKinds.inspectionPhoto);
    expect(audit.single.synced, isFalse,
        reason: 'sincronizable: queda esperando el endpoint de backend');
    final summary =
        json.decode(audit.single.summary) as Map<String, dynamic>;
    expect(summary['reservationNumber'], 'R-42');
    expect(summary.containsKey('photoPath'), isFalse,
        reason: 'el resumen jamás lleva el binario ni su path');
  });

  test('discardSession (6F) retira la cadena completa con rastro', () async {
    await service.enqueuePhoto(
      checkoutSessionId: 'cs1',
      reservationId: 'r1',
      reservationNumber: 'R-42',
      angleKey: 'front',
      jpegBytes: photo(),
    );
    await service.enqueueComplete(
      checkoutSessionId: 'cs1',
      reservationId: 'r1',
      reservationNumber: 'R-42',
      body: const {},
    );
    // Otra sesión NO se toca.
    await service.enqueuePhoto(
      checkoutSessionId: 'cs2',
      reservationId: 'r2',
      reservationNumber: 'R-43',
      angleKey: 'front',
      jpegBytes: photo(),
    );

    final removed = await service.discardSession('cs1');
    expect(removed, 2);
    final remaining = await db.allFor(userId: 'u1', tenantId: 't1');
    expect(remaining.single.groupKey, 'cs2');
    final audit = await db.auditRows();
    expect(audit, hasLength(2));
    expect(audit.map((a) => a.reasonCode).toSet(), {'SESSION_COMPLETED'});
  });

  test(
      'F2 — discardSession NO se lleva los dead-letter: esa decisión es del '
      'humano', () async {
    // Cadena típica: una foto que el servidor rechazó (evidencia de daños
    // esperando decisión) y otra todavía viva.
    await service.enqueuePhoto(
      checkoutSessionId: 'cs1',
      reservationId: 'r1',
      reservationNumber: 'R-42',
      angleKey: 'front',
      jpegBytes: photo(),
    );
    await service.enqueuePhoto(
      checkoutSessionId: 'cs1',
      reservationId: 'r1',
      reservationNumber: 'R-42',
      angleKey: 'rear',
      jpegBytes: photo(7),
    );
    final rows = await db.allFor(userId: 'u1', tenantId: 't1');
    final muerta = rows.firstWhere(
      (r) =>
          (json.decode(r.payload) as Map<String, dynamic>)['angleKey'] ==
          'front',
    );
    await db.markFailed(muerta.id,
        error: 'el servidor la rechazó', code: 'BAD_REQUEST', dead: true);

    // Otra superficie selló la inspección (6F / frame 17F).
    final removed = await service.discardSession('cs1');

    expect(removed, 1, reason: 'solo la fila VIVA se retira');
    final remaining = await db.allFor(userId: 'u1', tenantId: 't1');
    expect(remaining.single.id, muerta.id);
    expect(remaining.single.status, 'dead');
    // Y su binario sigue ahí: las dos salidas de la decisión —reenviar o
    // descartar— necesitan la foto.
    final payload =
        json.decode(remaining.single.payload) as Map<String, dynamic>;
    expect(await vault.read(payload['photoPath'] as String), isNotNull);
    // Lo único auditado es lo que de verdad se destruyó.
    final audit = await db.auditRows();
    expect(audit, hasLength(1));
    expect(audit.single.reasonCode, 'SESSION_COMPLETED');
  });

  test('sweepOrphanFiles borra archivos sin fila y respeta los referenciados',
      () async {
    await service.enqueuePhoto(
      checkoutSessionId: 'cs1',
      reservationId: 'r1',
      reservationNumber: 'R-42',
      angleKey: 'front',
      jpegBytes: photo(),
    );
    // Huérfano: archivo en la bóveda sin fila (crash a media purga).
    await vault.store(photo(9));

    final removed = await service.sweepOrphanFiles();
    expect(removed, 1);
    final payload = json.decode(
      (await db.allFor(userId: 'u1', tenantId: 't1')).single.payload,
    ) as Map<String, dynamic>;
    expect(await vault.read(payload['photoPath'] as String), isNotNull);
  });

  test('purgeStale (TTL 14 días): fila vieja fuera CON rastro y sin archivo',
      () async {
    await service.enqueuePhoto(
      checkoutSessionId: 'cs-vieja',
      reservationId: 'r-vieja',
      reservationNumber: 'R-1',
      angleKey: 'front',
      jpegBytes: photo(1),
    );
    await service.enqueuePhoto(
      checkoutSessionId: 'cs-fresca',
      reservationId: 'r-fresca',
      reservationNumber: 'R-2',
      angleKey: 'front',
      jpegBytes: photo(2),
    );
    // Envejecer la primera fila 20 días (residuo de un 401 sin re-login).
    final oldRow = (await db.byGroupKey('cs-vieja')).single;
    await (db.update(db.outboxEntries)..where((t) => t.id.equals(oldRow.id)))
        .write(OutboxEntriesCompanion(
      createdAt: Value(DateTime.now().subtract(const Duration(days: 20))),
    ));

    final purged = await service.purgeStale();
    expect(purged, 1);
    final remaining = await db.allFor(userId: 'u1', tenantId: 't1');
    expect(remaining.single.groupKey, 'cs-fresca',
        reason: 'lo fresco no se toca');
    final freshPath = (json.decode(remaining.single.payload)
        as Map<String, dynamic>)['photoPath'] as String;
    expect(await vault.read(freshPath), isNotNull);
    final oldPath = (json.decode(oldRow.payload)
        as Map<String, dynamic>)['photoPath'] as String;
    expect(await vault.read(oldPath), isNull,
        reason: 'la foto vieja (PII) también se va');
    final audit = await db.auditRows();
    expect(audit.single.reasonCode, 'TTL_EXPIRED',
        reason: 'nada se evapora sin registro');
  });

  test('sin dueño de sesión, encolar truena (bug de orquestación, no dato)',
      () async {
    owner = null;
    expect(
      () => service.enqueuePhoto(
        checkoutSessionId: 'cs1',
        reservationId: 'r1',
        reservationNumber: null,
        angleKey: 'front',
        jpegBytes: photo(),
      ),
      throwsStateError,
    );
  });
}
