import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:drift/drift.dart' show Value;
import 'package:drift/native.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:rideops/core/db/outbox_db.dart';
import 'package:rideops/core/db/outbox_providers.dart';
import 'package:rideops/core/outbox/network_status.dart';
import 'package:rideops/core/outbox/outbox_service.dart';
import 'package:rideops/core/outbox/photo_vault.dart';
import 'package:rideops/core/session/active_location.dart';
import 'package:rideops/core/session/session_controller.dart';
import 'package:rideops/core/session/session_state.dart';
import 'package:rideops/features/outbox/presentation/outbox_screen.dart';

import 'helpers/auth_test_helpers.dart';
import 'helpers/outbox_test_helpers.dart';
import 'helpers/shell_test_helpers.dart';

/// Bandeja UI (H5, mockup 7A-7D): motivo en humano + acción a la medida del
/// code, descarte con sheet de consecuencias + rastro, tope que pausa y
/// estado feliz.
void main() {
  const tenantId = 'cmdten001fixture0000000001';

  late OutboxDb db;
  late Directory tempDir;
  late PhotoVault vault;
  late FakeNetworkStatus network;
  late ProviderContainer container;

  setUp(() {
    db = OutboxDb(NativeDatabase.memory());
    tempDir = Directory.systemTemp.createTempSync('rideops_tray_test');
    vault = tempVault(tempDir);
    network = FakeNetworkStatus(online: false);
    container = ProviderContainer(overrides: [
      sessionControllerProvider.overrideWith(
        () => StubSessionController(
          SessionState.authenticated(
            token: fakeJwt(
              exp: DateTime.now().add(const Duration(hours: 8)),
              sub: kFixtureUserId,
            ),
            user: sessionUserFixture(),
          ),
        ),
      ),
      activeLocationStoreProvider
          .overrideWithValue(InMemoryActiveLocationStore()),
      outboxDbProvider.overrideWithValue(db),
      photoVaultProvider.overrideWithValue(vault),
      networkStatusProvider.overrideWithValue(network),
    ]);
    addTearDown(container.dispose);
  });

  tearDown(() async {
    await db.close();
    try {
      tempDir.deleteSync(recursive: true);
    } catch (_) {}
  });

  Future<void> seedRow({
    required String id,
    required String kind,
    String status = 'pending',
    String? code,
    String? photoPath,
    String? dependsOn,
    int attempts = 0,
  }) async {
    final now = DateTime.now();
    await db.into(db.outboxEntries).insert(OutboxEntriesCompanion.insert(
          id: id,
          userId: kFixtureUserId,
          tenantId: tenantId,
          kind: kind,
          groupKey: const Value('cs1'),
          payload: json.encode({
            'checkoutSessionId': 'cs1',
            'reservationId': 'r1',
            'reservationNumber': 'R-2492',
            if (kind == OutboxKinds.inspectionPhoto) 'angleKey': 'trunk',
            if (kind == OutboxKinds.inspectionPhoto) 'bytes': 402 * 1024,
            'photoPath': ?photoPath,
          }),
          dependsOn: Value(dependsOn),
          idempotencyKey: 'ik-$id',
          status: Value(status),
          attempts: Value(attempts),
          lastError: Value(code == null && status == 'dead' ? 'red' : code),
          lastErrorCode: Value(code),
          createdAt: now,
          updatedAt: now,
        ));
  }

  Widget tray() => UncontrolledProviderScope(
        container: container,
        child: l10nApp(const Scaffold(body: OutboxScreen())),
      );

  testWidgets('vacía = estado feliz', (tester) async {
    await tester.pumpWidget(tray());
    await tester.pumpAndSettle();
    expect(find.text('All sent'), findsOneWidget);
  });

  testWidgets(
      'dead-letter REQUIRED_ANGLES_MISSING: motivo humano + "Abrir '
      'inspección", sin Reintentar', (tester) async {
    await seedRow(
      id: 'c1',
      kind: OutboxKinds.inspectionComplete,
      status: 'dead',
      code: 'REQUIRED_ANGLES_MISSING',
      attempts: 5,
    );
    await tester.pumpWidget(tray());
    await tester.pumpAndSettle();

    expect(find.textContaining('front and rear angles are missing'),
        findsOneWidget);
    expect(find.text('Open inspection'), findsOneWidget);
    expect(find.text('Discard'), findsOneWidget);
    expect(find.text('Retry'), findsNothing,
        reason: 'reintentar sin las fotos daría el mismo 400');
    expect(find.textContaining('needs your decision'), findsOneWidget);
  });

  testWidgets('dead-letter TOKEN_EXPIRED: Reintentar re-encola y drena',
      (tester) async {
    await seedRow(
      id: 'p1',
      kind: OutboxKinds.inspectionPhoto,
      status: 'dead',
      code: 'TOKEN_EXPIRED',
      attempts: 2,
    );
    await tester.pumpWidget(tray());
    await tester.pumpAndSettle();

    expect(find.textContaining('upload permit expired'), findsOneWidget);
    await tester.tap(find.text('Retry'));
    await tester.pumpAndSettle();

    final row = (await db.allFor(userId: kFixtureUserId, tenantId: tenantId))
        .single;
    expect(row.status, 'pending');
    expect(row.attempts, 0, reason: 'el humano decidió: contador de nuevo');
  });

  testWidgets('PHOTO_LOST: solo Descartar (no hay nada que reintentar)',
      (tester) async {
    await seedRow(
      id: 'p1',
      kind: OutboxKinds.inspectionPhoto,
      status: 'dead',
      code: 'PHOTO_LOST',
    );
    await tester.pumpWidget(tray());
    await tester.pumpAndSettle();
    expect(find.text('Retry'), findsNothing);
    expect(find.text('Open inspection'), findsNothing);
    expect(find.text('Discard'), findsOneWidget);
  });

  testWidgets('descarte: sheet con consecuencias + rastro + archivo borrado',
      (tester) async {
    final name =
        await vault.store(Uint8List.fromList(List.filled(200, 7)));
    await seedRow(
      id: 'p1',
      kind: OutboxKinds.inspectionPhoto,
      status: 'dead',
      code: 'SESSION_GONE',
      photoPath: name,
    );
    await tester.pumpWidget(tray());
    await tester.pumpAndSettle();

    await tester.tap(find.text('Discard'));
    await tester.pumpAndSettle();
    // Consecuencias explícitas antes del botón destructivo.
    expect(find.textContaining('will be deleted from this phone'),
        findsOneWidget);

    // La opción segura conserva.
    await tester.tap(find.text('Keep in outbox'));
    await tester.pumpAndSettle();
    expect(await db.totalRows(), 1);

    await tester.tap(find.text('Discard'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Yes, discard'));
    await tester.pumpAndSettle();

    expect(await db.totalRows(), 0);
    expect(await vault.read(name), isNull, reason: 'el binario también se va');
    final audit = await db.auditRows();
    expect(audit.single.reasonCode, 'SESSION_GONE',
        reason: 'rastro de auditoría: quién/qué/motivo/hora');
    expect(audit.single.userId, kFixtureUserId);
  });

  testWidgets('cadena visible: el complete "espera sus fotos"',
      (tester) async {
    await seedRow(id: 'p1', kind: OutboxKinds.inspectionPhoto);
    await seedRow(
      id: 'c1',
      kind: OutboxKinds.inspectionComplete,
      dependsOn: 'p1',
    );
    await tester.pumpWidget(tray());
    await tester.pumpAndSettle();
    expect(find.text('WAITS FOR ITS PHOTOS'), findsOneWidget);
    expect(find.text('QUEUED'), findsOneWidget);
  });

  testWidgets('tope: banner "llena" + CTA honesto deshabilitado sin red',
      (tester) async {
    for (var i = 0; i < OutboxDb.maxRows; i++) {
      await seedRow(id: 'row-$i', kind: OutboxKinds.inspectionPhoto);
    }
    await tester.pumpWidget(tray());
    await tester.pumpAndSettle();

    expect(find.text('The outbox is full'), findsOneWidget);
    // El CTA y su nota viven al FINAL de la lista de 50 — scrollear hasta
    // ellos (el ListView construye perezoso).
    await tester.dragUntilVisible(
      find.text('Send now (no signal)'),
      find.byType(ListView),
      const Offset(0, -400),
    );
    // Sin red: el CTA existe pero dice la causa y no dispara nada.
    expect(find.text('Send now (no signal)'), findsOneWidget);
    expect(find.textContaining('New captures are paused'), findsOneWidget);
  });
}
