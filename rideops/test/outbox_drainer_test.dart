import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:rideops/core/outbox/drainer.dart';

class FakeStore implements OutboxStore {
  FakeStore(this.rows);

  List<OutboxRow> rows;
  final drained = <String>[];
  final dead = <String, String?>{}; // id -> code
  final failedPending = <String>[];

  @override
  Future<List<OutboxRow>> pending() async => List.of(rows);

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
    this.failPhotoWithTokenConsumedOnce = false,
    this.photoOutcome = const DrainOk(),
  });

  bool alreadyCompleted;
  bool failPhotoWithTokenConsumedOnce;
  DrainOutcome photoOutcome;

  int mints = 0;
  final uploadedAngles = <String>[];
  final usedTokens = <String>[];
  int completes = 0;

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
    usedTokens.add(token);
    if (failPhotoWithTokenConsumedOnce) {
      failPhotoWithTokenConsumedOnce = false;
      return const DrainReject('TOKEN_CONSUMED', 'Token already used');
    }
    if (photoOutcome is DrainOk) uploadedAngles.add(angleKey);
    return photoOutcome;
  }

  @override
  Future<bool> inspectionAlreadyCompleted(String reservationId) async =>
      alreadyCompleted;

  @override
  Future<DrainOutcome> completeInspection({
    required String token,
    required Map<String, dynamic> payload,
  }) async {
    completes++;
    return const DrainOk();
  }

  @override
  Future<String?> readPhotoData(String path) async =>
      path == 'lost.bin' ? null : 'data:image/jpeg;base64,${'x' * 300}';
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
}
