import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:rideops/core/api/checkout_api.dart';
import 'package:rideops/core/outbox/drainer.dart';
import 'package:rideops/core/outbox/outbox_ops_impl.dart';
import 'package:rideops/core/outbox/photo_vault.dart';
import 'package:rideops/core/telemetry/event_logger.dart';

/// ApiOutboxOps contra Dio mockeado (H5): el contrato REAL del drenado —
/// mint por el Dio autenticado SIN x-view-location, upload/complete por el
/// Dio limpio, mapeo de errores a DrainOutcome y el pre-check del complete.
class RouteAdapter implements HttpClientAdapter {
  RouteAdapter(this.routes);

  /// `'<METHOD> <path>'` → respuesta. Las requests quedan en [seen].
  final Map<String, ResponseBody Function(RequestOptions)> routes;
  final seen = <RequestOptions>[];

  @override
  Future<ResponseBody> fetch(
    RequestOptions options,
    Stream<Uint8List>? requestStream,
    Future<void>? cancelFuture,
  ) async {
    seen.add(options);
    final key = '${options.method} ${options.uri.path}';
    final handler = routes[key];
    if (handler == null) {
      throw DioException.connectionError(
        requestOptions: options,
        reason: 'sin ruta: $key',
      );
    }
    return handler(options);
  }

  @override
  void close({bool force = false}) {}
}

ResponseBody jsonRes(int status, Object body) => ResponseBody.fromString(
      json.encode(body),
      status,
      headers: {
        Headers.contentTypeHeader: ['application/json'],
      },
    );

class SilentLogger implements EventLogger {
  final events = <String>[];

  @override
  void log(String event, {Map<String, Object?> data = const {}}) {
    events.add(event);
  }
}

void main() {
  late RouteAdapter authedAdapter;
  late RouteAdapter publicAdapter;
  late Directory tempDir;
  late PhotoVault vault;
  late SilentLogger logger;
  late ApiOutboxOps ops;

  ApiOutboxOps buildOps() {
    final authed = Dio(BaseOptions(baseUrl: 'https://rideops.test'))
      ..httpClientAdapter = authedAdapter;
    final public = Dio(BaseOptions(baseUrl: 'https://rideops.test'))
      ..httpClientAdapter = publicAdapter;
    return ApiOutboxOps(
      api: CheckoutApi(authedDio: authed, publicDio: public),
      vault: vault,
      logger: logger,
    );
  }

  setUp(() {
    authedAdapter = RouteAdapter({});
    publicAdapter = RouteAdapter({});
    tempDir = Directory.systemTemp.createTempSync('rideops_ops_test');
    vault = PhotoVault(
      baseDir: () async => tempDir,
      obtainKeyBytes: () async =>
          Uint8List.fromList(List.generate(32, (i) => i)),
    );
    logger = SilentLogger();
    ops = buildOps();
  });

  tearDown(() {
    try {
      tempDir.deleteSync(recursive: true);
    } catch (_) {}
  });

  group('mintInspectionToken', () {
    test('POST handoff-token SIN x-view-location y loguea remint', () async {
      authedAdapter.routes['POST /api/checkout-sessions/cs1/handoff-token'] =
          (_) => jsonRes(201, {
                'token': 'tok-abc',
                'kind': 'MOBILE_INSPECTION',
                'expiresAt': '2026-08-16T14:25:00.000Z',
                'reused': true,
              });
      final token = await ops.mintInspectionToken('cs1');
      expect(token, 'tok-abc');
      final req = authedAdapter.seen.single;
      // La decisión del drenado: el header de sede JAMÁS sale de aquí — la
      // fila lleva su locationId sellado solo como dato de propiedad.
      expect(req.headers.containsKey('x-view-location'), isFalse);
      expect(req.extra['rideops.skip_view_location'], isTrue);
      expect(logger.events, contains(OutboxEvents.remintToken));
    });

    test('404 → null (SESSION_GONE aguas arriba); red → lanza', () async {
      authedAdapter.routes['POST /api/checkout-sessions/gone/handoff-token'] =
          (_) => jsonRes(404, {'error': 'not found'});
      expect(await ops.mintInspectionToken('gone'), isNull);

      // Sin ruta registrada = error de conexión → debe LANZAR (jamás null:
      // null mataría la fila como SESSION_GONE por un blip de red).
      expect(ops.mintInspectionToken('offline'), throwsA(anything));
    });

    test('S1: 4xx de negocio (403/409/400) → null, NO lanza (sin livelock)',
        () async {
      authedAdapter.routes['POST /api/checkout-sessions/denied/handoff-token'] =
          (_) => jsonRes(403, {'error': 'Access denied'});
      expect(await ops.mintInspectionToken('denied'), isNull,
          reason: 'un 403 eterno tumbaba cada corrida sin dead-letter');

      authedAdapter
              .routes['POST /api/checkout-sessions/conflict/handoff-token'] =
          (_) => jsonRes(409, {'error': 'No agreement linked'});
      expect(await ops.mintInspectionToken('conflict'), isNull);

      // 5xx sigue siendo transitorio: lanza y la fila queda pending.
      authedAdapter.routes['POST /api/checkout-sessions/s5/handoff-token'] =
          (_) => jsonRes(500, {'error': 'Internal error'});
      expect(ops.mintInspectionToken('s5'), throwsA(anything));
    });
  });

  group('uploadPhoto', () {
    test('OK por el Dio limpio (sin bearer, sin header de sede)', () async {
      publicAdapter.routes['POST /api/mobile-inspection/tok/photo'] =
          (_) => jsonRes(200, {'angleKey': 'front', 'captured': true});
      final out = await ops.uploadPhoto(
        token: 'tok',
        angleKey: 'front',
        photoDataUrl: 'data:image/jpeg;base64,xxxx',
      );
      expect(out, isA<DrainOk>());
      final req = publicAdapter.seen.single;
      expect(req.headers.containsKey('Authorization'), isFalse);
      expect(req.headers.containsKey('x-view-location'), isFalse);
      expect((req.data as Map)['angleKey'], 'front');
    });

    test('410 TOKEN_CONSUMED → DrainReject con code (dispara re-mint único)',
        () async {
      publicAdapter.routes['POST /api/mobile-inspection/tok/photo'] = (_) =>
          jsonRes(410, {'error': 'Token already used', 'code': 'TOKEN_CONSUMED'});
      final out = await ops.uploadPhoto(
        token: 'tok',
        angleKey: 'front',
        photoDataUrl: 'x',
      );
      expect(out, isA<DrainReject>());
      expect((out as DrainReject).code, 'TOKEN_CONSUMED');
    });

    test('400 de negocio → DrainReject permanente; red/5xx/429 → transitorio',
        () async {
      publicAdapter.routes['POST /api/mobile-inspection/bad/photo'] = (_) =>
          jsonRes(400, {'error': 'Unknown angleKey: x'});
      final reject = await ops.uploadPhoto(
          token: 'bad', angleKey: 'x', photoDataUrl: 'x');
      expect(reject, isA<DrainReject>());

      publicAdapter.routes['POST /api/mobile-inspection/s5/photo'] =
          (_) => jsonRes(500, {'error': 'Internal error'});
      expect(
        await ops.uploadPhoto(token: 's5', angleKey: 'front', photoDataUrl: 'x'),
        isA<DrainTransient>(),
      );

      publicAdapter.routes['POST /api/mobile-inspection/s429/photo'] =
          (_) => jsonRes(429, {'error': 'Too many requests'});
      expect(
        await ops.uploadPhoto(
            token: 's429', angleKey: 'front', photoDataUrl: 'x'),
        isA<DrainTransient>(),
      );

      // Sin ruta = fallo de conexión.
      expect(
        await ops.uploadPhoto(
            token: 'off', angleKey: 'front', photoDataUrl: 'x'),
        isA<DrainTransient>(),
      );
    });
  });

  group('inspectionAlreadyCompleted (pre-check del complete condicional)', () {
    test('true con inspectionCompletedAt estampado; false sin sesión',
        () async {
      authedAdapter
              .routes['GET /api/checkout-sessions/by-reservation/r1'] =
          (_) => jsonRes(200, {
                'id': 'cs1',
                'reservationId': 'r1',
                'currentStep': 'INSPECTION_IN_PROGRESS',
                'inspectionCompletedAt': '2026-08-16T14:14:00.000Z',
              });
      expect(await ops.inspectionAlreadyCompleted('r1'), isTrue);
      // También SIN header de sede (la fila pudo capturarse en otra).
      expect(
        authedAdapter.seen.single.headers.containsKey('x-view-location'),
        isFalse,
      );

      authedAdapter
              .routes['GET /api/checkout-sessions/by-reservation/r2'] =
          (_) => jsonRes(404, {'error': 'not found'});
      expect(await ops.inspectionAlreadyCompleted('r2'), isFalse);
    });

    test('S1: 4xx de negocio en el pre-check → false (el complete cobra el '
        'error real); red → lanza', () async {
      authedAdapter
              .routes['GET /api/checkout-sessions/by-reservation/denied'] =
          (_) => jsonRes(403, {'error': 'Access denied'});
      expect(await ops.inspectionAlreadyCompleted('denied'), isFalse);

      expect(ops.inspectionAlreadyCompleted('offline'), throwsA(anything));
    });
  });

  group('completeInspection', () {
    test('manda el body tal cual por el Dio limpio', () async {
      publicAdapter.routes['POST /api/mobile-inspection/tok/complete'] =
          (_) => jsonRes(200, {'ok': true, 'photoCount': 8, 'hasSignature': true});
      final out = await ops.completeInspection(
        token: 'tok',
        payload: {'odometer': 48212, 'fuelLevel': 0.75},
      );
      expect(out, isA<DrainOk>());
      expect(
          (publicAdapter.seen.single.data as Map)['odometer'], 48212);
    });
  });

  test('readPhotoData descifra y arma el dataURL; perdido → null', () async {
    final bytes = Uint8List.fromList([255, 216, 255, 224, 1, 2, 3]);
    final name = await vault.store(bytes);
    final dataUrl = await ops.readPhotoData(name);
    expect(dataUrl, 'data:image/jpeg;base64,${base64.encode(bytes)}');
    expect(await ops.readPhotoData('no-existe.bin'), isNull);
  });

  test('el drenador completo corre contra estas ops: mint→upload→complete',
      () async {
    authedAdapter.routes['POST /api/checkout-sessions/cs1/handoff-token'] =
        (_) => jsonRes(201, {
              'token': 'tok-1',
              'kind': 'MOBILE_INSPECTION',
              'expiresAt': '2026-08-16T14:25:00.000Z',
              'reused': false,
            });
    authedAdapter.routes['GET /api/checkout-sessions/by-reservation/r1'] =
        (_) => jsonRes(200, {
              'id': 'cs1',
              'reservationId': 'r1',
              'currentStep': 'INSPECTION_IN_PROGRESS',
              'inspectionCompletedAt': null,
            });
    final uploaded = <String>[];
    publicAdapter.routes['POST /api/mobile-inspection/tok-1/photo'] = (req) {
      uploaded.add((req.data as Map)['angleKey'] as String);
      return jsonRes(200, {'captured': true});
    };
    var completed = 0;
    publicAdapter.routes['POST /api/mobile-inspection/tok-1/complete'] = (_) {
      completed++;
      return jsonRes(200, {'ok': true});
    };

    final name = await vault.store(Uint8List.fromList(List.filled(300, 7)));
    final store = _ListStore([
      OutboxRow(
        id: 'p1',
        kind: 'inspection_photo',
        payload: json.encode({
          'checkoutSessionId': 'cs1',
          'angleKey': 'front',
          'photoPath': name,
        }),
      ),
      OutboxRow(
        id: 'c1',
        kind: 'inspection_complete',
        dependsOn: 'p1',
        payload: json.encode({
          'checkoutSessionId': 'cs1',
          'reservationId': 'r1',
          'body': {'odometer': 1},
        }),
      ),
    ]);
    await OutboxDrainer(store: store, ops: ops).drain();
    expect(store.drained, ['p1', 'c1']);
    expect(uploaded, ['front']);
    expect(completed, 1);
    expect(await vault.read(name), isNull,
        reason: 'DrainOk borra el binario (PII fuera de disco)');
  });

  test(
      'S15: retry de un TOKEN_CONSUMED jamás es callejón — el re-check del '
      'drenador lo cierra como éxito si otra superficie completó', () async {
    authedAdapter.routes['POST /api/checkout-sessions/cs1/handoff-token'] =
        (_) => jsonRes(201, {
              'token': 'tok-1',
              'kind': 'MOBILE_INSPECTION',
              'expiresAt': '2026-08-17T14:25:00.000Z',
              'reused': false,
            });
    // Pre-check: la 1a consulta dice "aún no completada"; tras el 410, la
    // re-verificación descubre que OTRA superficie ya completó.
    var byReservationCalls = 0;
    authedAdapter.routes['GET /api/checkout-sessions/by-reservation/r1'] =
        (_) {
      byReservationCalls++;
      return jsonRes(200, {
        'id': 'cs1',
        'reservationId': 'r1',
        'currentStep': 'CLOSED',
        'inspectionCompletedAt':
            byReservationCalls == 1 ? null : '2026-08-17T14:14:00.000Z',
      });
    };
    var completeAttempts = 0;
    publicAdapter.routes['POST /api/mobile-inspection/tok-1/complete'] = (_) {
      completeAttempts++;
      return jsonRes(
          410, {'error': 'Token already used', 'code': 'TOKEN_CONSUMED'});
    };

    final store = _ListStore([
      OutboxRow(
        id: 'c1',
        kind: 'inspection_complete',
        payload: json.encode({
          'checkoutSessionId': 'cs1',
          'reservationId': 'r1',
          'body': {'odometer': 1},
        }),
      ),
    ]);
    // Es exactamente lo que corre tras el "Reintentar" de la bandeja (la
    // fila vuelve a pending y el coordinador dispara este drain).
    await OutboxDrainer(store: store, ops: ops).drain();

    expect(store.drained, ['c1'],
        reason: 'se descarta como ÉXITO — no re-estampa una sesión cerrada');
    expect(completeAttempts, 1, reason: 'un intento, no un loop');
    expect(byReservationCalls, 2, reason: 'pre-check + re-check tras el 410');

    // Y no queda nada que reintentar: otra corrida no toca la red.
    completeAttempts = 0;
    await OutboxDrainer(store: store, ops: ops).drain();
    expect(completeAttempts, 0);
  });
}

class _ListStore implements OutboxStore {
  _ListStore(this.rows);

  List<OutboxRow> rows;
  final drained = <String>[];

  @override
  Future<List<OutboxRow>> pending() async => List.of(rows);

  @override
  Future<void> resetInflight() async {}

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
    if (dead) rows.removeWhere((r) => r.id == id);
  }
}
