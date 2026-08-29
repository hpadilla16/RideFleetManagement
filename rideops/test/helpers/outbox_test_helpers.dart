import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:drift/native.dart';
import 'package:flutter/widgets.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:rideops/core/db/outbox_db.dart';
import 'package:rideops/core/outbox/network_status.dart';
import 'package:rideops/core/outbox/photo_vault.dart';
import 'package:rideops/features/inspection/application/camera_service.dart';

/// Utilería compartida de los tests de H5 (bandeja + inspección).

/// Silenciadores de la bandeja para tests que montan la app pero NO son de
/// outbox. Uso (los 4 juntos, dentro de `overrides: [...]`):
///
/// ```dart
/// outboxDbProvider.overrideWith(buildMemoryOutboxDb),
/// photoVaultProvider.overrideWith(buildQuietVault),
/// networkStatusProvider.overrideWithValue(FakeNetworkStatus()),
/// outboxRowsProvider.overrideWith((ref) => Stream.value(const [])),
/// ```
///
/// Por qué: (1) el LazyDatabase real pediría path_provider, que no existe en
/// tests; (2) el watch() de drift crea un Timer al cerrarse que dispara el
/// chequeo `!timersPending` de flutter_test durante el desmontaje final —
/// por eso las filas van como stream ESTÁTICO y la cobertura del stream real
/// vive en outbox_db_test (test plano, sin ese invariante).
OutboxDb buildMemoryOutboxDb(Ref ref) {
  final db = OutboxDb(NativeDatabase.memory());
  ref.onDispose(db.close);
  return db;
}

PhotoVault buildQuietVault(Ref ref) =>
    tempVault(Directory.systemTemp.createTempSync('rideops_quiet_vault'));

/// Fila de outbox construida a mano (sin DB) para streams estáticos.
OutboxEntry outboxEntryFixture({
  required String id,
  required String userId,
  required String tenantId,
  String kind = 'inspection_photo',
  String status = 'pending',
  Map<String, Object?> payload = const {'angleKey': 'front'},
}) {
  final now = DateTime.now();
  return OutboxEntry(
    id: id,
    userId: userId,
    tenantId: tenantId,
    kind: kind,
    payload: json.encode(payload),
    idempotencyKey: 'ik-$id',
    attempts: 0,
    status: status,
    createdAt: now,
    updatedAt: now,
  );
}

/// Adapter Dio ruteado: `'<METHOD> <path>'` → respuesta; sin ruta = error de
/// conexión (simula offline).
class RouteAdapter implements HttpClientAdapter {
  RouteAdapter([Map<String, ResponseBody Function(RequestOptions)>? routes])
      : routes = routes ?? {};

  final Map<String, ResponseBody Function(RequestOptions)> routes;
  final seen = <RequestOptions>[];

  @override
  Future<ResponseBody> fetch(
    RequestOptions options,
    Stream<Uint8List>? requestStream,
    Future<void>? cancelFuture,
  ) async {
    seen.add(options);
    final handler = routes['${options.method} ${options.uri.path}'];
    if (handler == null) {
      throw DioException.connectionError(
        requestOptions: options,
        reason: 'sin ruta (offline simulado)',
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

/// Red falsa para el coordinador del drenado — default OFFLINE para que los
/// widget tests no intenten drenar contra adapters sin rutas.
class FakeNetworkStatus implements NetworkStatus {
  FakeNetworkStatus({this.online = false});

  bool online;
  final reconnects = StreamController<void>.broadcast();

  @override
  Future<bool> hasNetwork() async => online;

  @override
  Stream<void> get onReconnected => reconnects.stream;
}

/// Bóveda sobre un directorio temporal del test.
PhotoVault tempVault(Directory dir) => PhotoVault(
      baseDir: () async => dir,
      obtainKeyBytes: () async =>
          Uint8List.fromList(List.generate(32, (i) => i)),
    );

/// Cámara FALSA (la real no existe en unit/widget tests — la prueba física
/// en aparato queda declarada para H6 junto con WorkManager). [capture]
/// escribe un JPEG mínimo temporal y devuelve su path, como la real.
class FakeCameraService implements InspectionCameraService {
  FakeCameraService({this.failOpen = false});

  bool failOpen;
  final sessions = <FakeCameraSession>[];

  @override
  Future<InspectionCameraSession> open() async {
    if (failOpen) throw StateError('no camera available');
    final session = FakeCameraSession();
    sessions.add(session);
    return session;
  }
}

class FakeCameraSession implements InspectionCameraSession {
  bool _disposed = false;
  bool flashOn = false;
  int captures = 0;

  /// Bytes "del sensor" — un JPEG de mentira suficientemente grande para
  /// que el pipeline tenga algo que mover.
  static final sensorBytes =
      Uint8List.fromList([0xFF, 0xD8, 0xFF, 0xE0, ...List.filled(600, 0x42)]);

  @override
  Widget buildPreview() => const ColoredBox(color: Color(0xFF000000));

  @override
  Future<String> takePicture() async {
    captures++;
    final file = File(
      '${Directory.systemTemp.path}${Platform.pathSeparator}'
      'rideops_fake_shot_${DateTime.now().microsecondsSinceEpoch}.jpg',
    );
    // Sync: el dart:io async no resuelve bajo el fake-async del test.
    file.writeAsBytesSync(sensorBytes);
    return file.path;
  }

  @override
  Future<void> setFlash(bool enabled) async => flashOn = enabled;

  @override
  Future<void> dispose() async => _disposed = true;

  @override
  bool get isDisposed => _disposed;
}
