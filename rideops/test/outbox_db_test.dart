import 'dart:convert';

import 'package:drift/drift.dart' hide isNull, isNotNull;
import 'package:drift/native.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:rideops/core/db/outbox_db.dart';
import 'package:rideops/core/outbox/drainer.dart';

/// Adaptador de prueba OutboxDb → OutboxStore, atado a un dueño fijo, para
/// correr el drenador REAL contra la DB REAL (in-memory). El adaptador de
/// producción (con el dueño vivo de la sesión) llega en la historia de
/// wiring; la lógica que se prueba aquí es la de OutboxDb.
class DbStore implements OutboxStore {
  DbStore(this.db, {this.userId = 'u1', this.tenantId = 't1'});

  final OutboxDb db;
  final String userId;
  final String tenantId;

  @override
  Future<List<OutboxRow>> pending() async {
    final rows = await db.pendingFor(userId: userId, tenantId: tenantId);
    return [
      for (final r in rows)
        OutboxRow(
          id: r.id,
          kind: r.kind,
          payload: r.payload,
          dependsOn: r.dependsOn,
          attempts: r.attempts,
        ),
    ];
  }

  @override
  Future<void> resetInflight() async {
    await db.resetInflightToPending(userId: userId, tenantId: tenantId);
  }

  @override
  Future<void> markInflight(String id) => db.markInflight(id);

  @override
  Future<void> markDrained(String id) => db.markDrained(id);

  @override
  Future<void> markFailed(String id,
          {required String error, String? code, required bool dead}) =>
      db.markFailed(id, error: error, code: code, dead: dead);
}

class TestOps implements OutboxOps {
  TestOps({this.photoOutcome = const DrainOk()});

  DrainOutcome photoOutcome;
  int uploads = 0;
  final deletedFiles = <String>[];

  @override
  Future<String?> mintInspectionToken(String checkoutSessionId) async => 'tok';

  @override
  Future<DrainOutcome> uploadPhoto({
    required String token,
    required String angleKey,
    required String photoDataUrl,
    String? notes,
  }) async {
    uploads++;
    return photoOutcome;
  }

  @override
  Future<bool> inspectionAlreadyCompleted(String reservationId) async => false;

  @override
  Future<DrainOutcome> completeInspection({
    required String token,
    required Map<String, dynamic> payload,
  }) async =>
      const DrainOk();

  @override
  Future<String?> readPhotoData(String path) async =>
      'data:image/jpeg;base64,${'x' * 300}';

  @override
  Future<void> deletePhotoFile(String path) async {
    deletedFiles.add(path);
  }
}

OutboxEntriesCompanion entry(
  String id, {
  String userId = 'u1',
  String tenantId = 't1',
  String kind = 'inspection_photo',
  String status = 'pending',
}) {
  final now = DateTime.now();
  return OutboxEntriesCompanion.insert(
    id: id,
    userId: userId,
    tenantId: tenantId,
    kind: kind,
    payload: json.encode({
      'checkoutSessionId': 'cs1',
      'angleKey': 'front-$id',
      'photoPath': 'fotos/$id.bin',
    }),
    idempotencyKey: 'ik-$id',
    status: Value(status),
    createdAt: now,
    updatedAt: now,
  );
}

void main() {
  late OutboxDb db;

  setUp(() {
    db = OutboxDb(NativeDatabase.memory());
  });

  tearDown(() async {
    await db.close();
  });

  Future<OutboxEntry> rowById(String id) =>
      (db.select(db.outboxEntries)..where((e) => e.id.equals(id))).getSingle();

  test('markFailed incrementa attempts atómicamente en cada fallo', () async {
    await db.into(db.outboxEntries).insert(entry('a'));

    await db.markFailed('a', error: 'red', code: null, dead: false);
    expect((await rowById('a')).attempts, 1);
    expect((await rowById('a')).status, 'pending');

    await db.markFailed('a', error: 'red otra vez', code: null, dead: false);
    final r = await rowById('a');
    expect(r.attempts, 2);
    expect(r.lastError, 'red otra vez');
  });

  test('reintentos transitorios acaban en dead al llegar al tope (e2e)',
      () async {
    await db.into(db.outboxEntries).insert(entry('a'));
    final ops = TestOps(photoOutcome: const DrainTransient('sin red'));
    final drainer = OutboxDrainer(
      store: DbStore(db),
      ops: ops,
      maxAttemptsBeforeDead: 3,
    );

    // Antes del fix, attempts se quedaba en 0 (Value.absent()) y este loop
    // jamás terminaba en dead: reintento infinito.
    await drainer.drain();
    await drainer.drain();
    await drainer.drain();

    final r = await rowById('a');
    expect(r.status, 'dead');
    expect(r.attempts, 3);
    expect(ops.uploads, 3);
    expect(ops.deletedFiles, ['fotos/a.bin'],
        reason: 'al morir la fila, el binario también se va');

    // Muerta, ya no se sirve: una corrida más no sube nada.
    await drainer.drain();
    expect(ops.uploads, 3);
  });

  test('fila inflight huérfana se recupera y drena en la siguiente corrida',
      () async {
    await db.into(db.outboxEntries).insert(entry('a', status: 'inflight'));

    // Sanidad: pendingFor NO la ve — sin el reset se perdería en silencio.
    expect(await db.pendingFor(userId: 'u1', tenantId: 't1'), isEmpty);

    final ops = TestOps();
    await OutboxDrainer(store: DbStore(db), ops: ops).drain();
    expect(ops.uploads, 1);
    expect(
      await (db.select(db.outboxEntries)).get(),
      isEmpty,
      reason: 'drenó y la fila se fue',
    );
  });

  test('resetInflightToPending respeta dueño (userId + tenantId)', () async {
    await db.into(db.outboxEntries).insert(entry('mine', status: 'inflight'));
    await db
        .into(db.outboxEntries)
        .insert(entry('theirs', userId: 'u2', status: 'inflight'));

    await db.resetInflightToPending(userId: 'u1', tenantId: 't1');
    expect((await rowById('mine')).status, 'pending');
    expect((await rowById('theirs')).status, 'inflight',
        reason: 'las filas ajenas no se tocan (se purgan al cambiar cuenta)');
  });

  test('watchAllFor emite con cada escritura (el badge del shell vive de él)',
      () async {
    final snapshots = <int>[];
    final sub = db
        .watchAllFor(userId: 'u1', tenantId: 't1')
        .listen((rows) => snapshots.add(rows.length));
    await pumpEventQueue();
    await db.into(db.outboxEntries).insert(entry('a'));
    await pumpEventQueue();
    await db.into(db.outboxEntries).insert(entry('b', userId: 'u2'));
    await pumpEventQueue();
    expect(snapshots.first, 0);
    expect(snapshots.last, 1,
        reason: 'las filas de OTRO dueño no aparecen en el stream');
    await sub.cancel();
  });

  test('purgeNotOwnedBy devuelve las filas borradas con sus payloads',
      () async {
    await db.into(db.outboxEntries).insert(entry('a', userId: 'saliente'));
    await db.into(db.outboxEntries).insert(entry('b', userId: 'saliente'));
    await db.into(db.outboxEntries).insert(entry('c', userId: 'entrante'));

    final purged = await db.purgeNotOwnedBy(userId: 'entrante');
    expect(purged.map((r) => r.id).toSet(), {'a', 'b'});
    // El caller usa estos payloads para borrar los archivos de foto (PII):
    final paths = purged
        .map((r) => (json.decode(r.payload)
            as Map<String, dynamic>)['photoPath'] as String)
        .toSet();
    expect(paths, {'fotos/a.bin', 'fotos/b.bin'});

    final remaining = await (db.select(db.outboxEntries)).get();
    expect(remaining.map((r) => r.id).toList(), ['c']);
  });
}
