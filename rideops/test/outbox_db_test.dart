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
          {required String error,
          String? code,
          int? status,
          required bool dead}) =>
      db.markFailed(id, error: error, code: code, status: status, dead: dead);
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

  test('markFailed persiste el status HTTP, y null cuando no hubo respuesta',
      () async {
    await db.into(db.outboxEntries).insert(entry('a'));
    await db.into(db.outboxEntries).insert(entry('b'));

    // Rechazo del servidor SIN code (el 404 de la prueba de humo): lo único
    // que lo distingue de un fallo de red es este número.
    await db.markFailed('a',
        error: 'Not Found', code: null, status: 404, dead: true);
    final a = await rowById('a');
    expect(a.lastErrorCode, isNull);
    expect(a.lastErrorStatus, 404);

    // Fallo de red de verdad: nunca llegó respuesta.
    await db.markFailed('b', error: 'sin red', code: null, dead: false);
    expect((await rowById('b')).lastErrorStatus, isNull);
  });

  test('reintentar una fila muerta limpia también el status viejo', () async {
    await db.into(db.outboxEntries).insert(entry('a'));
    await db.markFailed('a',
        error: 'Not Found', code: null, status: 404, dead: true);

    await db.resetDeadToPending('a');

    final a = await rowById('a');
    expect(a.status, 'pending');
    expect(a.lastErrorStatus, isNull,
        reason: 'un status rancio pintaría el motivo del intento ANTERIOR');
    expect(a.lastError, isNull);
    expect(a.lastErrorCode, isNull);
  });

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
    expect(ops.deletedFiles, isEmpty,
        reason: 'la fila muere pero SIGUE en la bandeja esperando decisión: '
            'sin binario, su "Reintentar" sería una puerta falsa');

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

  test('pruneAudit: corta por edad Y por tope, conservando lo más nuevo',
      () async {
    final now = DateTime.now();
    Future<void> audit(String id, int daysAgo) =>
        db.insertAudit(OutboxAuditEntriesCompanion.insert(
          id: id,
          userId: 'u1',
          tenantId: 't1',
          rowId: 'row-$id',
          rowKind: 'inspection_photo',
          summary: '{}',
          discardedAt: now.subtract(Duration(days: daysAgo)),
        ));

    await audit('muy-viejo', 120); // cae por edad (90 días)
    await audit('viejo', 40);
    await audit('reciente', 5);
    await audit('nuevo', 1);

    await db.pruneAudit(
      olderThan: now.subtract(const Duration(days: 90)),
      keepMax: 2,
    );
    final rows = await db.auditRows();
    expect(rows.map((r) => r.id).toSet(), {'reciente', 'nuevo'},
        reason: 'primero la edad, luego el tope — sobreviven los más nuevos');
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

  // La parte MÁS cara de equivocarse de este cambio no es el texto: es el
  // esquema. Un teléfono de patio con la bandeja de H5 ya tiene el archivo
  // creado en v1; si la migración no corre, drift lanza al abrir y las fotos
  // de daños pendientes se quedan encerradas. Aquí se construye un v1 REAL
  // (derivado del DDL vivo de v2, no escrito a mano) y se abre con el código
  // de hoy.
  group('migraciones del esquema', () {
    /// DDL real de la tabla en el esquema de HOY, leído de sqlite_master.
    Future<Map<String, String>> ddlActual() async {
      final v2 = OutboxDb(NativeDatabase.memory());
      // Cualquier consulta fuerza el onCreate.
      await v2.totalRows();
      final filas = await v2
          .customSelect(
            'SELECT name, sql FROM sqlite_master '
            "WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
          )
          .get();
      final ddl = {
        for (final f in filas) f.read<String>('name'): f.read<String>('sql'),
      };
      await v2.close();
      return ddl;
    }

    /// Recorta una columna del DDL de hoy. Derivar los esquemas viejos (en vez
    /// de teclearlos) es lo que hace que el fixture no pueda mentir sobre cómo
    /// eran de verdad.
    String sinColumna(String ddl, String columna, String tipo) {
      final recortado =
          ddl.replaceAll(RegExp('"$columna" $tipo( NULL)?, '), '');
      expect(recortado, isNot(ddl),
          reason: 'si esto no recorta nada, la prueba no estaría probando la '
              'migración: el DDL de drift cambió de forma');
      expect(recortado.contains(columna), isFalse);
      return recortado;
    }

    test('un archivo v1 se abre, conserva sus filas y gana las columnas nuevas',
        () async {
      final ddl = await ddlActual();
      final ddlHoy = ddl['outbox_entries']!;

      // v1 = el DDL de hoy MENOS las dos columnas que llegaron después. Un
      // teléfono en v1 tiene que recibir las DOS migraciones en la misma
      // apertura — por eso los `if` del onUpgrade son independientes y no un
      // `else if`.
      final ddlV1Entries = sinColumna(
        sinColumna(ddlHoy, 'last_error_status', 'INTEGER'),
        'session_sealed_at',
        'INTEGER',
      );

      final viejo = OutboxDb(NativeDatabase.memory(setup: (raw) {
        raw.execute(ddlV1Entries);
        raw.execute(ddl['outbox_audit_entries']!);
        // Una fila que ya murió en v1, con la información que v1 sabía
        // guardar: mensaje crudo, sin code y sin status.
        raw.execute(
          'INSERT INTO outbox_entries (id, user_id, tenant_id, kind, payload, '
          'idempotency_key, attempts, last_error, status, created_at, updated_at) '
          "VALUES ('vieja', 'u1', 't1', 'inspection_photo', '{}', 'ik-vieja', "
          "8, 'error de antes', 'dead', 1, 1)",
        );
        raw.execute('PRAGMA user_version = 1');
      }));
      addTearDown(viejo.close);

      // La columna, PREGUNTÁNDOLE A SQLITE. Hace falta preguntar así: el
      // SELECT de drift es `SELECT *` y mapea una columna ausente a null sin
      // quejarse, así que una migración que no corrió se vería idéntica a
      // "fila vieja sin status" — y la bandeja volvería a decir "no hay
      // señal" para siempre, en silencio.
      final columnas = await viejo
          .customSelect('PRAGMA table_info(outbox_entries)')
          .get();
      expect(
        columnas.map((c) => c.read<String>('name')),
        containsAll(['last_error_status', 'session_sealed_at']),
        reason: 'un teléfono en v1 tiene que recibir las DOS migraciones',
      );

      final fila = await (viejo.select(viejo.outboxEntries)
            ..where((t) => t.id.equals('vieja')))
          .getSingle();

      expect(fila.lastError, 'error de antes',
          reason: 'la migración no puede perder trabajo pendiente');
      expect(fila.lastErrorStatus, isNull,
          reason: 'de una fila de v1 NO se sabe si hubo respuesta, y null '
              'dice exactamente eso');

      // Y a partir de aquí la columna funciona.
      await viejo.markFailed('vieja',
          error: 'Not Found', code: null, status: 404, dead: true);
      final tras = await (viejo.select(viejo.outboxEntries)
            ..where((t) => t.id.equals('vieja')))
          .getSingle();
      expect(tras.lastErrorStatus, 404);
    });

    test(
        'un archivo v2 —el de los teléfonos de hoy— gana session_sealed_at sin '
        'perder su dead-letter', () async {
      final ddl = await ddlActual();
      final ddlV2Entries =
          sinColumna(ddl['outbox_entries']!, 'session_sealed_at', 'INTEGER');

      final viejo = OutboxDb(NativeDatabase.memory(setup: (raw) {
        raw.execute(ddlV2Entries);
        raw.execute(ddl['outbox_audit_entries']!);
        // Justo la fila que este cambio hace vivir más: un rechazo esperando
        // decisión humana sobre evidencia de daños.
        raw.execute(
          'INSERT INTO outbox_entries (id, user_id, tenant_id, group_key, kind, '
          'payload, idempotency_key, attempts, last_error, last_error_code, '
          'last_error_status, status, created_at, updated_at) '
          "VALUES ('muerta', 'u1', 't1', 'cs1', 'inspection_photo', "
          "'{\"photoPath\":\"fotos/a.bin\"}', 'ik-muerta', 3, 'Gone', "
          "'TOKEN_EXPIRED', 410, 'dead', 1, 1)",
        );
        raw.execute('PRAGMA user_version = 2');
      }));
      addTearDown(viejo.close);

      final columnas =
          await viejo.customSelect('PRAGMA table_info(outbox_entries)').get();
      expect(
        columnas.map((c) => c.read<String>('name')),
        contains('session_sealed_at'),
        reason: 'la migración v2 → v3 no corrió',
      );

      final fila = await (viejo.select(viejo.outboxEntries)
            ..where((t) => t.id.equals('muerta')))
          .getSingle();
      expect(fila.status, 'dead');
      expect(fila.lastErrorCode, 'TOKEN_EXPIRED',
          reason: 'el diagnóstico que soporte va a leer no se toca');
      expect(fila.sessionSealedAt, isNull,
          reason: 'de una fila de v2 no se sabe si su sesión cerró, y null '
              'dice exactamente eso — sigue ofreciendo Reintentar');

      // Y a partir de aquí la columna funciona: sellar le quita el botón.
      final selladas = await viejo.markSessionSealed(
        groupKey: 'cs1',
        at: DateTime.utc(2026, 9, 1, 10, 30),
      );
      expect(selladas, 1);
      final tras = await (viejo.select(viejo.outboxEntries)
            ..where((t) => t.id.equals('muerta')))
          .getSingle();
      // Drift guarda el instante como epoch y lo devuelve en hora LOCAL: se
      // compara el MOMENTO, no la representación.
      expect(tras.sessionSealedAt!.toUtc(), DateTime.utc(2026, 9, 1, 10, 30));
      expect(tras.lastErrorCode, 'TOKEN_EXPIRED',
          reason: 'sellar es un hecho NUEVO, no una corrección del anterior');
    });
  });
}
