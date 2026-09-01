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

  /// id -> status HTTP persistido en CADA markFailed (dead o no). null aquí
  /// significa "no hubo respuesta" — la bandeja depende de esa distinción.
  final statuses = <String, int?>{};

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
      {required String error,
      String? code,
      int? status,
      required bool dead}) async {
    statuses[id] = status;
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

  /// Ángulos que fallan transitorio (los demás siguen [photoOutcome]) —
  /// para el escenario S2: un ángulo intermedio atorado.
  Set<String> transientAngles = {};

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
    if (transientAngles.contains(angleKey)) {
      return const DrainTransient('red caída en este ángulo');
    }
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

  // El status HTTP tiene que SOBREVIVIR el viaje outcome → store. Si el
  // drenador lo deja caer aquí, la columna queda null y la bandeja vuelve a
  // decirle "no hay señal" al empleado por un 404 del servidor.
  test('un rechazo SIN code guarda su status HTTP en la fila muerta',
      () async {
    final ops = FakeOps(
      photoOutcome: const DrainReject(null, 'Not Found', status: 404),
    );
    final store = FakeStore([photoRow('a')]);
    await OutboxDrainer(store: store, ops: ops).drain();

    expect(store.dead, {'a': null}, reason: 'el backend no mandó code');
    expect(store.statuses['a'], 404,
        reason: 'sin el status la fila es indistinguible de un fallo de red');
  });

  test('un fallo transitorio SIN respuesta guarda status null', () async {
    final ops = FakeOps(photoOutcome: const DrainTransient('sin red'));
    final store = FakeStore([photoRow('a')]);
    await OutboxDrainer(store: store, ops: ops).drain();

    expect(store.failedPending, ['a']);
    expect(store.statuses['a'], isNull);
  });

  test('un 5xx transitorio SÍ guarda su status (el servidor contestó)',
      () async {
    final ops = FakeOps(
      photoOutcome: const DrainTransient('Service Unavailable', status: 503),
    );
    final store = FakeStore([photoRow('a')]);
    await OutboxDrainer(store: store, ops: ops).drain();

    expect(store.statuses['a'], 503);
  });

  test(
      'S2: el complete espera a TODAS las fotos de su sesión, no solo al '
      'dependsOn', () async {
    // La foto 'b' NO está en la cadena de dependsOn del complete (ángulo
    // re-capturado después) y falla transitorio: sin el guard por sesión,
    // el complete pasaría y la inspección quedaría "completa" con evidencia
    // faltante.
    final ops = FakeOps()..transientAngles = {'angle-b'};
    final store = FakeStore([
      photoRow('a'),
      photoRow('b'),
      completeRow('c', dependsOn: 'a'),
    ]);
    await OutboxDrainer(store: store, ops: ops).drain();
    expect(store.drained, ['a']);
    expect(ops.completes, 0,
        reason: 'una foto de la MISMA sesión sigue en cola: el complete espera');
    // La foto atorada sube en otra corrida y entonces sí cierra.
    ops.transientAngles = {};
    await OutboxDrainer(store: store, ops: ops).drain();
    expect(store.drained, ['a', 'b', 'c']);
    expect(ops.completes, 1);
  });

  test('S2: una foto de OTRA sesión no bloquea el complete', () async {
    final ops = FakeOps()..transientAngles = {'angle-x'};
    final otherSessionPhoto = OutboxRow(
      id: 'x',
      kind: 'inspection_photo',
      payload: json.encode({
        'checkoutSessionId': 'cs-OTRA',
        'angleKey': 'angle-x',
        'photoPath': 'x.bin',
      }),
    );
    final store = FakeStore([
      photoRow('a'),
      otherSessionPhoto,
      completeRow('c', dependsOn: 'a'),
    ]);
    await OutboxDrainer(store: store, ops: ops).drain();
    expect(ops.completes, 1,
        reason: 'las cadenas son POR sesión — otra sesión no estorba');
    expect(store.drained, ['a', 'c']);
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

  test(
      'foto a dead-letter CONSERVA el archivo: el "Reintentar" de la bandeja '
      'tiene que poder tener éxito', () async {
    final ops = FakeOps(
      photoOutcome: const DrainReject('REQUIRED_ANGLES_MISSING', 'faltan'),
    );
    final store = FakeStore([photoRow('a', path: 'fotos/a.bin')]);
    await OutboxDrainer(store: store, ops: ops).drain();
    expect(store.dead.keys, ['a']);
    // Antes se borraba aquí "para sacar la PII del disco", y eso convertía la
    // acción principal del dead-letter en una puerta falsa: la fila revivía
    // sin binario y volvía a morir con PHOTO_LOST (corrida e2e 2). La fila
    // sigue EN la bandeja esperando una decisión sobre evidencia de daños;
    // el disco se libera cuando el humano descarta, cuando el TTL de 14 días
    // la recoge o cuando se purga la cuenta.
    expect(ops.deletedFiles, isEmpty);
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

  test('transitorio que llega al tope (dead) TAMPOCO borra el archivo',
      () async {
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
    // Morir por agotar reintentos es el caso MÁS recuperable de todos: lo que
    // falló fue la red. Borrarle el binario dejaba al empleado con un botón
    // "Reintentar" y ninguna foto detrás.
    expect(ops.deletedFiles, isEmpty);
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
