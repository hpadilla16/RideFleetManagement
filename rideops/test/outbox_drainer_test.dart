import 'dart:async';
import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:rideops/core/outbox/drainer.dart';

class FakeStore implements OutboxStore {
  FakeStore(this.rows);

  List<OutboxRow> rows;

  /// Filas atoradas en 'inflight' (proceso muerto a media corrida);
  /// [resetInflight] las regresa a [rows], como hace la DB real.
  final inflightRows = <OutboxRow>[];
  int resetInflightCalls = 0;
  int pendingCalls = 0;

  final drained = <String>[];
  final dead = <String, String?>{}; // id -> code
  final failedPending = <String>[];

  @override
  Future<List<OutboxRow>> pending() async {
    pendingCalls++;
    return List.of(rows);
  }

  @override
  Future<void> resetInflight() async {
    resetInflightCalls++;
    rows.addAll(inflightRows);
    inflightRows.clear();
  }

  @override
  Future<void> markInflight(String id) async {}

  @override
  Future<void> markDrained(String id) async {
    drained.add(id);
    rows.removeWhere((r) => r.id == id);
  }

  @override
  Future<void> markFailed(String id,
      {required String error, String? code, required bool dead}) async {
    if (dead) {
      this.dead[id] = code;
      rows.removeWhere((r) => r.id == id);
    } else {
      failedPending.add(id);
    }
  }
}

class FakeOps implements OutboxOps {
  FakeOps({
    this.alreadyCompleted = false,
    this.alreadyCompletedAnswers,
    this.failPhotoWithTokenConsumedOnce = false,
    this.failCompleteWithTokenConsumedOnce = false,
    this.photoOutcome = const DrainOk(),
  });

  bool alreadyCompleted;

  /// Respuestas en orden para [inspectionAlreadyCompleted]; agotadas, cae en
  /// [alreadyCompleted]. Permite simular "no estaba completada al pre-check,
  /// SÍ al re-check tras TOKEN_CONSUMED".
  List<bool>? alreadyCompletedAnswers;
  bool failPhotoWithTokenConsumedOnce;
  bool failCompleteWithTokenConsumedOnce;
  DrainOutcome photoOutcome;

  /// Compuerta opcional para colgar subidas y probar concurrencia.
  Future<void>? uploadGate;

  int mints = 0;
  final uploadedAngles = <String>[];
  final usedTokens = <String>[];
  final deletedFiles = <String>[];
  int completes = 0;
  int completedChecks = 0;

  @override
  Future<String?> mintInspectionToken(String checkoutSessionId) async {
    mints++;
    return 'token-$mints';
  }

  @override
  Future<DrainOutcome> uploadPhoto({
    required String token,
    required String angleKey,
    required String photoDataUrl,
    String? notes,
  }) async {
    final gate = uploadGate;
    if (gate != null) await gate;
    usedTokens.add(token);
    if (failPhotoWithTokenConsumedOnce) {
      failPhotoWithTokenConsumedOnce = false;
      return const DrainReject('TOKEN_CONSUMED', 'Token already used');
    }
    if (photoOutcome is DrainOk) uploadedAngles.add(angleKey);
    return photoOutcome;
  }

  @override
  Future<bool> inspectionAlreadyCompleted(String reservationId) async {
    completedChecks++;
    final q = alreadyCompletedAnswers;
    if (q != null && q.isNotEmpty) return q.removeAt(0);
    return alreadyCompleted;
  }

  @override
  Future<DrainOutcome> completeInspection({
    required String token,
    required Map<String, dynamic> payload,
  }) async {
    if (failCompleteWithTokenConsumedOnce) {
      failCompleteWithTokenConsumedOnce = false;
      return const DrainReject('TOKEN_CONSUMED', 'Token already used');
    }
    completes++;
    return const DrainOk();
  }

  @override
  Future<String?> readPhotoData(String path) async =>
      path == 'lost.bin' ? null : 'data:image/jpeg;base64,${'x' * 300}';

  @override
  Future<void> deletePhotoFile(String path) async {
    deletedFiles.add(path);
  }
}

OutboxRow photoRow(String id, {String? dependsOn, String path = 'p.bin'}) =>
    OutboxRow(
      id: id,
      kind: 'inspection_photo',
      dependsOn: dependsOn,
      payload: json.encode({
        'checkoutSessionId': 'cs1',
        'angleKey': 'angle-$id',
        'photoPath': path,
      }),
    );

OutboxRow completeRow(String id, {String? dependsOn}) => OutboxRow(
      id: id,
      kind: 'inspection_complete',
      dependsOn: dependsOn,
      payload: json.encode({
        'checkoutSessionId': 'cs1',
        'reservationId': 'r1',
        'body': {'odometer': 12345},
      }),
    );

void main() {
  test('fotos drenan antes del complete aunque lleguen desordenadas', () async {
    final ops = FakeOps();
    final store = FakeStore([
      completeRow('c', dependsOn: 'b'),
      photoRow('a'),
      photoRow('b', dependsOn: 'a'),
    ]);
    await OutboxDrainer(store: store, ops: ops).drain();
    expect(store.drained, ['a', 'b', 'c']);
    expect(ops.completes, 1);
    // Un solo mint para todo el lote — no un token por foto.
    expect(ops.mints, 1);
  });

  test('410 TOKEN_CONSUMED re-emite una vez y la foto pasa', () async {
    final ops = FakeOps(failPhotoWithTokenConsumedOnce: true);
    final store = FakeStore([photoRow('a')]);
    await OutboxDrainer(store: store, ops: ops).drain();
    expect(store.drained, ['a']);
    expect(ops.mints, 2, reason: 'token original + re-mint tras el 410');
    expect(ops.usedTokens, ['token-1', 'token-2']);
  });

  test('complete se descarta como éxito si otra superficie ya completó',
      () async {
    final ops = FakeOps(alreadyCompleted: true);
    final store = FakeStore([completeRow('c')]);
    await OutboxDrainer(store: store, ops: ops).drain();
    expect(store.drained, ['c']);
    expect(ops.completes, 0, reason: 'no pisa timestamps de sesión cerrada');
    expect(ops.mints, 0);
  });

  test('rechazo permanente va a dead-letter con su code', () async {
    final ops = FakeOps(
      photoOutcome: const DrainReject('REQUIRED_ANGLES_MISSING', 'faltan'),
    );
    final store = FakeStore([photoRow('a')]);
    await OutboxDrainer(store: store, ops: ops).drain();
    expect(store.dead, {'a': 'REQUIRED_ANGLES_MISSING'});
  });

  test('si la foto falla, su complete dependiente NO corre este drenado',
      () async {
    final ops = FakeOps(photoOutcome: const DrainTransient('red caída'));
    final store = FakeStore([
      photoRow('a'),
      completeRow('c', dependsOn: 'a'),
    ]);
    await OutboxDrainer(store: store, ops: ops).drain();
    expect(store.drained, isEmpty);
    expect(ops.completes, 0);
    expect(store.failedPending, ['a']);
  });

  test('foto perdida en disco → dead-letter, no loop eterno', () async {
    final ops = FakeOps();
    final store = FakeStore([photoRow('a', path: 'lost.bin')]);
    await OutboxDrainer(store: store, ops: ops).drain();
    expect(store.dead, {'a': 'PHOTO_LOST'});
  });

  test('kind desconocido → dead-letter inmediato (ADR-5)', () async {
    final ops = FakeOps();
    final store = FakeStore([
      OutboxRow(id: 'x', kind: 'charge_sale', payload: '{}'),
    ]);
    await OutboxDrainer(store: store, ops: ops).drain();
    expect(store.dead, {'x': 'UNKNOWN_KIND'});
  });

  test('transitorio repetido acaba en dead al llegar al tope', () async {
    final ops = FakeOps(photoOutcome: const DrainTransient('red'));
    final store = FakeStore([
      OutboxRow(
        id: 'a',
        kind: 'inspection_photo',
        payload: json.encode({
          'checkoutSessionId': 'cs1',
          'angleKey': 'front',
          'photoPath': 'p.bin',
        }),
        attempts: 7,
      ),
    ]);
    await OutboxDrainer(store: store, ops: ops, maxAttemptsBeforeDead: 8)
        .drain();
    expect(store.dead.keys, ['a']);
  });

  test('filas inflight huérfanas se recuperan al inicio del drenado', () async {
    final ops = FakeOps();
    final store = FakeStore([]);
    // El proceso murió entre markInflight y el outcome: la fila quedó
    // 'inflight' y pending() (solo 'pending') jamás la volvería a servir.
    store.inflightRows.add(photoRow('a'));
    await OutboxDrainer(store: store, ops: ops).drain();
    expect(store.resetInflightCalls, 1);
    expect(store.drained, ['a'], reason: 'la fila huérfana volvió a drenar');
  });

  test('complete tras TOKEN_CONSUMED re-verifica y NO re-manda si ya quedó',
      () async {
    final ops = FakeOps(
      failCompleteWithTokenConsumedOnce: true,
      // Pre-check: aún no completada. Re-check tras el 410: otra superficie
      // la completó mientras tanto.
      alreadyCompletedAnswers: [false, true],
    );
    final store = FakeStore([completeRow('c')]);
    await OutboxDrainer(store: store, ops: ops).drain();
    expect(store.drained, ['c'], reason: 'se descarta como éxito');
    expect(ops.completes, 0,
        reason: 'no re-estampa inspectionCompletedAt en una sesión cerrada');
    expect(ops.mints, 1, reason: 'sin re-mint: el re-check corta antes');
    expect(ops.completedChecks, 2);
  });

  test('complete tras TOKEN_* SÍ re-manda si el re-check dice no-completada',
      () async {
    final ops = FakeOps(
      failCompleteWithTokenConsumedOnce: true,
      alreadyCompletedAnswers: [false, false], // token venció, nadie completó
    );
    final store = FakeStore([completeRow('c')]);
    await OutboxDrainer(store: store, ops: ops).drain();
    expect(store.drained, ['c']);
    expect(ops.completes, 1);
    expect(ops.mints, 2, reason: 'token original + re-mint tras el 410');
  });

  test('DrainOk de foto borra el archivo de disco', () async {
    final ops = FakeOps();
    final store = FakeStore([photoRow('a', path: 'fotos/a.bin')]);
    await OutboxDrainer(store: store, ops: ops).drain();
    expect(store.drained, ['a']);
    expect(ops.deletedFiles, ['fotos/a.bin']);
  });

  test('foto a dead-letter también borra el archivo (PII fuera de disco)',
      () async {
    final ops = FakeOps(
      photoOutcome: const DrainReject('REQUIRED_ANGLES_MISSING', 'faltan'),
    );
    final store = FakeStore([photoRow('a', path: 'fotos/a.bin')]);
    await OutboxDrainer(store: store, ops: ops).drain();
    expect(store.dead.keys, ['a']);
    expect(ops.deletedFiles, ['fotos/a.bin']);
  });

  test('transitorio NO borra el archivo mientras la fila siga pending',
      () async {
    final ops = FakeOps(photoOutcome: const DrainTransient('red caída'));
    final store = FakeStore([photoRow('a', path: 'fotos/a.bin')]);
    await OutboxDrainer(store: store, ops: ops).drain();
    expect(store.failedPending, ['a']);
    expect(ops.deletedFiles, isEmpty,
        reason: 'la foto aún puede subir en la próxima corrida');
  });

  test('transitorio que llega al tope (dead) borra el archivo', () async {
    final ops = FakeOps(photoOutcome: const DrainTransient('red'));
    final store = FakeStore([
      OutboxRow(
        id: 'a',
        kind: 'inspection_photo',
        payload: json.encode({
          'checkoutSessionId': 'cs1',
          'angleKey': 'front',
          'photoPath': 'fotos/a.bin',
        }),
        attempts: 7,
      ),
    ]);
    await OutboxDrainer(store: store, ops: ops, maxAttemptsBeforeDead: 8)
        .drain();
    expect(store.dead.keys, ['a']);
    expect(ops.deletedFiles, ['fotos/a.bin']);
  });

  test('dead de un kind sin foto NO intenta borrar archivos', () async {
    final ops = FakeOps();
    final store = FakeStore([
      OutboxRow(id: 'x', kind: 'charge_sale', payload: '{}'),
    ]);
    await OutboxDrainer(store: store, ops: ops).drain();
    expect(store.dead.keys, ['x']);
    expect(ops.deletedFiles, isEmpty);
  });

  test('single-flight: dos drains concurrentes comparten UNA corrida',
      () async {
    final ops = FakeOps();
    final gate = Completer<void>();
    ops.uploadGate = gate.future;
    final store = FakeStore([photoRow('a')]);
    final drainer = OutboxDrainer(store: store, ops: ops);

    final first = drainer.drain();
    final second = drainer.drain();
    expect(identical(first, second), isTrue,
        reason: 'el segundo disparo recibe el Future de la corrida en vuelo');

    gate.complete();
    await Future.wait([first, second]);
    expect(store.pendingCalls, 1, reason: 'una sola corrida contra la DB');

    // Al terminar, el candado se suelta: un drain nuevo corre de verdad.
    ops.uploadGate = null;
    await drainer.drain();
    expect(store.pendingCalls, 2);
  });
}
