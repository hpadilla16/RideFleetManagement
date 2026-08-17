import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:drift/drift.dart' show Value;
import 'package:drift/native.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:rideops/core/api/api_providers.dart';
import 'package:rideops/core/db/outbox_db.dart';
import 'package:rideops/core/db/outbox_providers.dart';
import 'package:rideops/core/outbox/network_status.dart';
import 'package:rideops/core/outbox/outbox_service.dart';
import 'package:rideops/core/outbox/photo_vault.dart';
import 'package:rideops/core/session/active_location.dart';
import 'package:rideops/core/session/kiosk_guard.dart';
import 'package:rideops/core/session/pin_store.dart';
import 'package:rideops/core/session/session_controller.dart';
import 'package:rideops/core/session/session_state.dart';
import 'package:rideops/features/inspection/application/camera_service.dart';
import 'package:rideops/features/inspection/application/inspection_controller.dart';
import 'package:rideops/features/inspection/application/inspection_state.dart';
import 'package:rideops/features/inspection/application/photo_pipeline.dart';
import 'package:rideops/features/inspection/presentation/camera_capture_screen.dart';
import 'package:rideops/features/inspection/presentation/inspection_screen.dart';

import 'helpers/auth_test_helpers.dart';
import 'helpers/outbox_test_helpers.dart';
import 'helpers/shell_test_helpers.dart';

/// Flujo de inspección (H5, mockup 6A-6F) contra API mockeada y outbox REAL
/// en memoria: gate front+rear, reconciliación 6F con purga selectiva,
/// offline honesto en la carga, y el e2e de cámara fake → pipeline →
/// fila encolada con la sede SELLADA.
void main() {
  const tenantId = 'cmdten001fixture0000000001';
  const activeLocationId = 'cmdloc001fixture0000000001';

  late RouteAdapter authed;
  late RouteAdapter public;
  late OutboxDb db;
  late Directory tempDir;
  late PhotoVault vault;
  late FakeCameraService camera;
  late ProviderContainer container;

  Map<String, dynamic> sessionJson({String? completedAt}) => {
        'id': 'cs1',
        'reservationId': 'r1',
        'tenantId': tenantId,
        'currentStep': 'INSPECTION_HANDOFF',
        'inspectionCompletedAt': completedAt,
      };

  void routeHappyPath() {
    authed.routes['GET /api/checkout-sessions/by-reservation/r1'] =
        (_) => jsonRes(200, sessionJson());
    authed.routes['GET /api/reservations/r1/display-data'] = (_) => jsonRes(
          200,
          json.decode(
            File('test/fixtures/reservation_display_data.json')
                .readAsStringSync(),
          ) as Map<String, dynamic>,
        );
    authed.routes['POST /api/checkout-sessions/cs1/handoff-token'] =
        (_) => jsonRes(201, {
              'token': 'tok-1',
              'kind': 'MOBILE_INSPECTION',
              'expiresAt': '2026-08-16T14:25:00.000Z',
              'reused': false,
            });
    public.routes['GET /api/mobile-inspection/tok-1'] = (_) => jsonRes(200, {
          'reservationNumber': 'R-20260816-0042',
          'agreementNumber': 'A-42',
          'vehicle': '2023 Toyota Corolla · IKL-427',
          'angles': [
            for (final key in kInspectionAngleKeys)
              {'key': key, 'label': key, 'captured': false},
          ],
          'expiresAt': '2026-08-16T14:25:00.000Z',
        });
  }

  setUp(() {
    authed = RouteAdapter();
    public = RouteAdapter();
    db = OutboxDb(NativeDatabase.memory());
    tempDir = Directory.systemTemp.createTempSync('rideops_flow_test');
    vault = tempVault(tempDir);
    camera = FakeCameraService();

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
      pinStoreProvider.overrideWithValue(
        InMemoryPinStore.configured(userId: kFixtureUserId),
      ),
      kioskGuardStoreProvider.overrideWithValue(InMemoryKioskGuardStore()),
      activeLocationStoreProvider.overrideWithValue(
        InMemoryActiveLocationStore(json.encode({
          'userId': kFixtureUserId,
          'locationId': activeLocationId,
          'locationName': 'Patio Centro',
        })),
      ),
      authedDioProvider.overrideWithValue(
        Dio(BaseOptions(baseUrl: 'https://rideops.test'))
          ..httpClientAdapter = authed,
      ),
      publicDioProvider.overrideWithValue(
        Dio(BaseOptions(baseUrl: 'https://rideops.test'))
          ..httpClientAdapter = public,
      ),
      outboxDbProvider.overrideWithValue(db),
      photoVaultProvider.overrideWithValue(vault),
      networkStatusProvider.overrideWithValue(FakeNetworkStatus()),
      cameraServiceProvider.overrideWithValue(camera),
      photoPipelineProvider.overrideWithValue(
        PhotoPipeline(
          // Sync: el dart:io async no resuelve bajo fake-async.
          compressor: (src) async => File(src).readAsBytesSync(),
        ),
      ),
    ]);
    addTearDown(container.dispose);
  });

  tearDown(() async {
    await db.close();
    try {
      tempDir.deleteSync(recursive: true);
    } catch (_) {}
  });

  Widget app(Widget home) => UncontrolledProviderScope(
        container: container,
        child: l10nApp(home),
      );

  testWidgets('el CTA replica el gate del backend: front+rear habilitan',
      (tester) async {
    routeHappyPath();
    await tester.pumpWidget(app(const InspectionScreen(reservationId: 'r1')));
    await tester.pumpAndSettle();

    // Cargó: header con reserva + grid de 8.
    expect(find.text('Checkout inspection'), findsOneWidget);
    expect(find.text('Front'), findsOneWidget);
    expect(find.text('Trunk'), findsOneWidget);

    final controller =
        container.read(inspectionControllerProvider('r1').notifier);
    expect(container.read(inspectionControllerProvider('r1')).requiredCaptured,
        isFalse);

    // Solo front NO habilita (rear sigue pendiente).
    await controller.enqueueCapturedPhoto(
      angleKey: 'front',
      bytes: Uint8List.fromList(List.filled(300, 1)),
      msCompress: 5,
    );
    await tester.pump();
    expect(container.read(inspectionControllerProvider('r1')).requiredCaptured,
        isFalse);

    await controller.enqueueCapturedPhoto(
      angleKey: 'rear',
      bytes: Uint8List.fromList(List.filled(300, 2)),
      msCompress: 5,
    );
    await tester.pump();
    expect(container.read(inspectionControllerProvider('r1')).requiredCaptured,
        isTrue);

    // Avanza a métricas (el CTA vive bajo el fold del viewport de test).
    await tester.ensureVisible(find.text('Continue to metrics'));
    await tester.tap(find.text('Continue to metrics'));
    await tester.pumpAndSettle();
    expect(find.text('Vehicle metrics'), findsOneWidget);
    // Última lectura desde display-data (Vehicle.mileage del fixture).
    expect(find.text('Last recorded reading: 48190 mi'), findsOneWidget);

    // Las filas encoladas llevan la sede activa SELLADA (criterio H5).
    final rows = await db.allFor(userId: kFixtureUserId, tenantId: tenantId);
    expect(rows, hasLength(2));
    expect(rows.map((r) => r.locationId).toSet(), {activeLocationId});
    expect(rows.map((r) => r.groupKey).toSet(), {'cs1'});

    // GD-5/INN S-4: el combustible SIN default no deja avanzar a firma —
    // odómetro y limpieza solos no bastan.
    controller.setOdometer(48212);
    controller.setCleanliness(4);
    expect(container.read(inspectionControllerProvider('r1')).metricsComplete,
        isFalse, reason: 'fuel sin capturar = evidencia sin capturar');
    controller.setFuelEighths(6);
    expect(container.read(inspectionControllerProvider('r1')).metricsComplete,
        isTrue);

    // INN S-3: el complete viaja con el firmante sellado desde display-data.
    controller
        .confirmSignature('data:image/png;base64,${'x' * 300}');
    await controller.finish();
    final complete = (await db.allFor(
            userId: kFixtureUserId, tenantId: tenantId))
        .singleWhere((r) => r.kind == OutboxKinds.inspectionComplete);
    final body = (json.decode(complete.payload)
        as Map<String, dynamic>)['body'] as Map<String, dynamic>;
    expect(body['signerName'], 'María González');
    expect(body['fuelLevel'], 0.75);
  });

  testWidgets('6F: sesión ya completada → reconciliación + purga selectiva',
      (tester) async {
    authed.routes['GET /api/checkout-sessions/by-reservation/r1'] = (_) =>
        jsonRes(200, sessionJson(completedAt: '2026-08-16T14:14:00.000Z'));
    // Review GD: el 6F pinta la reserva (display-data también en esta rama)
    // y cuenta la historia con hora.
    authed.routes['GET /api/reservations/r1/display-data'] = (_) => jsonRes(
          200,
          json.decode(
            File('test/fixtures/reservation_display_data.json')
                .readAsStringSync(),
          ) as Map<String, dynamic>,
        );
    // Fila pendiente de ESA sesión que debe retirarse.
    final now = DateTime.now();
    await db.into(db.outboxEntries).insert(OutboxEntriesCompanion.insert(
          id: 'p1',
          userId: kFixtureUserId,
          tenantId: tenantId,
          kind: OutboxKinds.inspectionPhoto,
          payload: json.encode({
            'checkoutSessionId': 'cs1',
            'reservationId': 'r1',
            'reservationNumber': 'R-42',
          }),
          idempotencyKey: 'cs1:front',
          groupKey: const Value('cs1'),
          createdAt: now,
          updatedAt: now,
        ));

    await tester.pumpWidget(app(const InspectionScreen(reservationId: 'r1')));
    await tester.pumpAndSettle();

    expect(find.text('This inspection is already complete'), findsOneWidget);
    // Chip con la reserva (display-data llegó también en la rama 6F) y el
    // copy con hora del cierre (review GD).
    expect(find.text('Reservation R-20260816-0042'), findsOneWidget);
    expect(
      find.textContaining('Another screen closed it at'),
      findsOneWidget,
    );
    expect(await db.totalRows(), 0,
        reason: 'los envíos de esa sesión se retiraron de la bandeja');
    final audit = await db.auditRows();
    expect(audit.single.reasonCode, 'SESSION_COMPLETED',
        reason: 'la purga selectiva deja rastro');
  });

  testWidgets('offline en la carga: estado honesto con reintentar',
      (tester) async {
    // Sin rutas: el adapter responde error de conexión.
    await tester.pumpWidget(app(const InspectionScreen(reservationId: 'r1')));
    await tester.pumpAndSettle();

    expect(
      find.textContaining('Starting an inspection needs signal once'),
      findsOneWidget,
    );
    expect(find.text('Retry'), findsOneWidget);

    // Vuelve la señal → reintentar carga de verdad.
    routeHappyPath();
    await tester.tap(find.text('Retry'));
    await tester.pumpAndSettle();
    expect(find.text('Checkout inspection'), findsOneWidget);
  });

  testWidgets(
      'cámara fake e2e: shutter → pipeline → fila cifrada encolada y '
      'avance al siguiente ángulo', (tester) async {
    routeHappyPath();
    // El controller necesita la sesión cargada ANTES de capturar.
    container.read(inspectionControllerProvider('r1').notifier);
    await tester.pumpWidget(app(const SizedBox()));
    await tester.pumpAndSettle();

    await tester.pumpWidget(app(const CameraCaptureScreen(
      reservationId: 'r1',
      initialAngleKey: 'front',
    )));
    await tester.pumpAndSettle();
    expect(find.text('Front · 1 of 8'), findsOneWidget);

    await tester.tap(find.bySemanticsLabel('Take photo'));
    await tester.pumpAndSettle();

    // Flujo continuo (nota 5): avanzó solo al siguiente pendiente.
    expect(find.text('Rear · 2 of 8'), findsOneWidget);
    expect(camera.sessions.single.captures, 1);

    final rows = await db.allFor(userId: kFixtureUserId, tenantId: tenantId);
    expect(rows, hasLength(1));
    expect(rows.single.idempotencyKey, 'cs1:front');
    final payload = json.decode(rows.single.payload) as Map<String, dynamic>;
    // El binario quedó CIFRADO en la bóveda y el temporal se borró.
    expect(await vault.read(payload['photoPath'] as String),
        FakeCameraSession.sensorBytes);
    final angle =
        container.read(inspectionControllerProvider('r1')).angles['front']!;
    expect(angle.status, AngleStatus.queued);
    expect(angle.bytes, FakeCameraSession.sensorBytes.length);
  });

  testWidgets('con la bandeja LLENA la captura se bloquea antes de la cámara',
      (tester) async {
    routeHappyPath();
    final now = DateTime.now();
    for (var i = 0; i < OutboxDb.maxRows; i++) {
      await db.into(db.outboxEntries).insert(OutboxEntriesCompanion.insert(
            id: 'fill-$i',
            userId: kFixtureUserId,
            tenantId: tenantId,
            kind: OutboxKinds.inspectionPhoto,
            payload: '{}',
            idempotencyKey: 'fill-$i',
            createdAt: now,
            updatedAt: now,
          ));
    }

    await tester.pumpWidget(app(const InspectionScreen(reservationId: 'r1')));
    await tester.pumpAndSettle();
    expect(find.textContaining('The outbox is full'), findsWidgets);

    await tester.tap(find.text('Front'));
    await tester.pumpAndSettle();
    // No se abrió la cámara: seguimos en el grid y el aviso está en pantalla.
    expect(camera.sessions, isEmpty);
    expect(find.text('Checkout inspection'), findsOneWidget);
  });
}
