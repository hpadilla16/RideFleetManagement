import 'dart:convert';
import 'dart:io';
import 'dart:math';

import 'package:drift/drift.dart' show Value;
import 'package:drift/native.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:rideops/core/db/outbox_db.dart';
import 'package:rideops/core/db/outbox_providers.dart';
import 'package:rideops/core/outbox/background_drain.dart';
import 'package:rideops/core/outbox/drain_coordinator.dart';
import 'package:rideops/core/outbox/drainer.dart';
import 'package:rideops/core/outbox/network_status.dart';
import 'package:rideops/core/outbox/outbox_service.dart';
import 'package:rideops/core/telemetry/event_logger.dart';

import 'helpers/auth_test_helpers.dart';
import 'helpers/outbox_test_helpers.dart';

/// Scheduler de background que solo REGISTRA llamadas — el contrato del
/// relevo (H6) se prueba sin tocar el plugin de WorkManager.
class RecordingScheduler implements BackgroundDrainScheduler {
  int ensured = 0;
  int cancels = 0;

  @override
  Future<void> ensureScheduled() async => ensured++;

  @override
  Future<void> cancel() async => cancels++;
}

/// Ops mínimas para corridas del coordinador: siempre hay token y la foto
/// "existe"; [photoOutcome] decide el destino de cada subida.
class _CoordOps implements OutboxOps {
  _CoordOps({this.photoOutcome = const DrainOk()});

  DrainOutcome photoOutcome;

  /// Subidas REALMENTE intentadas. Es el oráculo del rescate de inflight: la
  /// fila puede cambiar de estado en la DB y no salir ni un POST.
  int uploads = 0;

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
  Future<String?> readPhotoData(String path) async => 'data:image/jpeg;base64,x';

  @override
  Future<void> deletePhotoFile(String path) async {}
}

/// Coordinador del drenado (H5): curva de backoff con jitter (tope 15 min —
/// nota 3 del mockup 7B) y la telemetría colgada del store adapter.
void main() {
  group('retryDelayFor', () {
    test('crece exponencial y se topa en 15 min (+jitter <5 s)', () {
      final r = Random(7);
      Duration d(int n) => DrainCoordinator.retryDelayFor(n, random: r);

      expect(d(0).inSeconds, inInclusiveRange(30, 35));
      expect(d(1).inSeconds, inInclusiveRange(60, 65));
      expect(d(2).inSeconds, inInclusiveRange(120, 125));
      // Tope: 15 min aunque el contador siga subiendo.
      expect(d(10).inMinutes, inInclusiveRange(15, 15));
      expect(d(40).inMinutes, inInclusiveRange(15, 15));
      expect(d(40).inSeconds, lessThan(15 * 60 + 5));
    });
  });

  group('DbOutboxStore', () {
    test('telemetría drained_ok / entry_dead con kind y code', () async {
      final db = OutboxDb(NativeDatabase.memory());
      addTearDown(db.close);
      final logger = CapturingEventLogger();
      var drainedCallbacks = 0;
      final store = DbOutboxStore(
        db: db,
        ownerOf: () => const OutboxOwner(userId: 'u1', tenantId: 't1'),
        logger: logger,
        onDrained: () => drainedCallbacks++,
      );

      final now = DateTime.now();
      await db.into(db.outboxEntries).insert(OutboxEntriesCompanion.insert(
            id: 'a',
            userId: 'u1',
            tenantId: 't1',
            kind: OutboxKinds.inspectionPhoto,
            payload: json.encode({'angleKey': 'front'}),
            idempotencyKey: 'ik-a',
            createdAt: now,
            updatedAt: now,
          ));
      await db.into(db.outboxEntries).insert(OutboxEntriesCompanion.insert(
            id: 'b',
            userId: 'u1',
            tenantId: 't1',
            kind: OutboxKinds.inspectionComplete,
            payload: '{}',
            idempotencyKey: 'ik-b',
            createdAt: now,
            updatedAt: now,
          ));

      final pending = await store.pending();
      expect(pending.map((r) => r.id), ['a', 'b']);

      await store.markDrained('a');
      expect(logger.has(OutboxEvents.drainedOk), isTrue);
      expect(
        logger.events
            .firstWhere((e) => e.$1 == OutboxEvents.drainedOk)
            .$2['kind'],
        OutboxKinds.inspectionPhoto,
      );
      expect(drainedCallbacks, 1);

      await store.markFailed('b',
          error: 'faltan', code: 'REQUIRED_ANGLES_MISSING', dead: true);
      expect(
        logger.events
            .firstWhere((e) => e.$1 == OutboxEvents.entryDead)
            .$2['code'],
        'REQUIRED_ANGLES_MISSING',
      );
      expect(drainedCallbacks, 2,
          reason: 'un dead también sale de la cola drenable (anillo 7A)');
    });

    test('el rescate de filas inflight se CUENTA (outbox.inflight_rescued)',
        () async {
      final db = OutboxDb(NativeDatabase.memory());
      addTearDown(db.close);
      final logger = CapturingEventLogger();
      final store = DbOutboxStore(
        db: db,
        ownerOf: () => const OutboxOwner(userId: 'u1', tenantId: 't1'),
        logger: logger,
      );
      final now = DateTime.now();
      await db.into(db.outboxEntries).insert(OutboxEntriesCompanion.insert(
            id: 'huerfana',
            userId: 'u1',
            tenantId: 't1',
            kind: OutboxKinds.inspectionPhoto,
            payload: json.encode({'angleKey': 'front'}),
            idempotencyKey: 'ik-huerfana',
            status: const Value('inflight'),
            createdAt: now,
            updatedAt: now,
          ));

      await store.resetInflight();
      expect(
        logger.events
            .firstWhere((e) => e.$1 == OutboxEvents.inflightRescued)
            .$2['rows'],
        1,
      );

      // Sin huérfanas NO se emite: el evento tiene que medir incidentes, no
      // corridas.
      logger.events.clear();
      await store.resetInflight();
      expect(logger.has(OutboxEvents.inflightRescued), isFalse);
    });

    test('sin dueño de sesión el store no sirve filas ni resetea nada',
        () async {
      final db = OutboxDb(NativeDatabase.memory());
      addTearDown(db.close);
      final store = DbOutboxStore(
        db: db,
        ownerOf: () => null,
        logger: const NoopEventLogger(),
      );
      expect(await store.pending(), isEmpty);
      await store.resetInflight(); // no truena
    });
  });

  group('relevo de background (H6)', () {
    Future<void> insertPhotoRow(
      OutboxDb db, {
      String id = 'a',
      String status = 'pending',
    }) async {
      final now = DateTime.now();
      await db.into(db.outboxEntries).insert(OutboxEntriesCompanion.insert(
            id: id,
            userId: 'u1',
            tenantId: 't1',
            kind: OutboxKinds.inspectionPhoto,
            payload: json.encode({
              'checkoutSessionId': 'cs1',
              'reservationId': 'r1',
              'angleKey': 'front',
              'photoPath': 'p.bin',
            }),
            idempotencyKey: 'ik-$id',
            status: Value(status),
            createdAt: now,
            updatedAt: now,
          ));
    }

    ({
      ProviderContainer container,
      RecordingScheduler scheduler,
      DbOutboxStore store,
    }) harness({
      required OutboxDb db,
      required bool online,
      required _CoordOps ops,
    }) {
      final store = DbOutboxStore(
        db: db,
        ownerOf: () => const OutboxOwner(userId: 'u1', tenantId: 't1'),
        logger: const NoopEventLogger(),
      );
      final scheduler = RecordingScheduler();
      final tempDir =
          Directory.systemTemp.createTempSync('rideops_coord_test');
      addTearDown(() => tempDir.deleteSync(recursive: true));
      final container = ProviderContainer(overrides: [
        networkStatusProvider
            .overrideWithValue(FakeNetworkStatus(online: online)),
        outboxDbProvider.overrideWithValue(db),
        outboxServiceProvider.overrideWithValue(OutboxService(
          db: db,
          vault: tempVault(tempDir),
          logger: const NoopEventLogger(),
          ownerOf: () => null,
        )),
        outboxStoreProvider.overrideWithValue(store),
        outboxDrainerProvider
            .overrideWithValue(OutboxDrainer(store: store, ops: ops)),
        backgroundDrainSchedulerProvider.overrideWithValue(scheduler),
      ]);
      addTearDown(container.dispose);
      container.listen(drainCoordinatorProvider, (_, _) {});
      return (container: container, scheduler: scheduler, store: store);
    }

    test('sin red con filas pendientes: agenda la one-off y NO drena',
        () async {
      final db = OutboxDb(NativeDatabase.memory());
      addTearDown(db.close);
      await insertPhotoRow(db);
      final h = harness(db: db, online: false, ops: _CoordOps());
      await h.container
          .read(drainCoordinatorProvider.notifier)
          .kick('enqueue');
      await pumpEventQueue();
      expect(h.scheduler.ensured, greaterThanOrEqualTo(1),
          reason: 'el relevo del OS dispara al volver la red aunque la app muera');
      expect((await h.store.pending()).length, 1, reason: 'nada drenó offline');
    });

    test('corrida que deja pendientes (transitorio): agenda el relevo',
        () async {
      final db = OutboxDb(NativeDatabase.memory());
      addTearDown(db.close);
      await insertPhotoRow(db);
      final h = harness(
        db: db,
        online: true,
        ops: _CoordOps(photoOutcome: const DrainTransient('red mala')),
      );
      await h.container
          .read(drainCoordinatorProvider.notifier)
          .kick('test');
      await pumpEventQueue();
      expect(h.scheduler.ensured, greaterThanOrEqualTo(1),
          reason: 'el timer de backoff muere con el proceso; la one-off no');
      expect((await h.store.pending()).length, 1);
    });

    test(
        'F4 — fila ÚNICA en inflight: el kick la rescata y el POST sale de '
        'verdad', () async {
      final db = OutboxDb(NativeDatabase.memory());
      addTearDown(db.close);
      // Una corrida anterior murió entre markInflight y el outcome (un 401 a
      // media subida, el proceso muerto). No hay NADA en pending.
      await insertPhotoRow(db, status: 'inflight');
      expect(await db.pendingFor(userId: 'u1', tenantId: 't1'), isEmpty,
          reason: 'sanidad: la compuerta del kick mira justo esto');

      final ops = _CoordOps();
      final h = harness(db: db, online: true, ops: ops);
      // El mismo "Enviar ahora" de la bandeja (outbox_screen.dart).
      await h.container.read(drainCoordinatorProvider.notifier).kick('manual');
      await pumpEventQueue();

      // Sin el rescate ANTES de contar, pendingBefore daba 0, el kick se
      // devolvía y `drain()` —donde vive resetInflight— jamás corría: la foto
      // se quedaba en "Subiendo" para siempre, inmune a Enviar ahora y a un
      // arranque en frío (corrida e2e 2).
      expect(ops.uploads, 1, reason: 'el POST tiene que salir');
      expect(await (db.select(db.outboxEntries)).get(), isEmpty,
          reason: 'drenó y la fila se fue');
    });

    test('bandeja vaciada: cancela el relevo', () async {
      final db = OutboxDb(NativeDatabase.memory());
      addTearDown(db.close);
      await insertPhotoRow(db);
      final h = harness(db: db, online: true, ops: _CoordOps());
      await h.container
          .read(drainCoordinatorProvider.notifier)
          .kick('test');
      await pumpEventQueue();
      expect((await h.store.pending()), isEmpty);
      expect(h.scheduler.cancels, greaterThanOrEqualTo(1),
          reason: 'sin pendientes, despertar el proceso en balde quema cuota');
    });
  });
}
