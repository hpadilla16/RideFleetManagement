import 'dart:convert';
import 'dart:math';

import 'package:drift/native.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:rideops/core/db/outbox_db.dart';
import 'package:rideops/core/outbox/drain_coordinator.dart';
import 'package:rideops/core/outbox/outbox_service.dart';
import 'package:rideops/core/telemetry/event_logger.dart';

import 'helpers/auth_test_helpers.dart';

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
}
