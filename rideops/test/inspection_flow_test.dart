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
import 'package:rideops/core/telemetry/event_logger.dart';
import 'package:rideops/core/widgets/ride_buttons.dart';
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
  late CapturingEventLogger logger;
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
    logger = CapturingEventLogger();

    container = ProviderContainer(overrides: [
      eventLoggerProvider.overrideWithValue(logger),
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
    // Última lectura desde display-data (Vehicle.mileage del fixture), con el
    // MISMO formato y la MISMA unidad que la tarjeta del paso 1: antes esta
    // línea decía "48190 mi" mientras confirmación decía "48,190 km" para el
    // mismo entero (hallazgo e2e, menor 1).
    expect(find.text('Last recorded reading: 48,190 mi'), findsOneWidget);

    // Las filas encoladas llevan la sede activa SELLADA (criterio H5).
    final rows = await db.allFor(userId: kFixtureUserId, tenantId: tenantId);
    expect(rows, hasLength(2));
    expect(rows.map((r) => r.locationId).toSet(), {activeLocationId});
    expect(rows.map((r) => r.groupKey).toSet(), {'cs1'});

    // MC-5: el CTA bloqueado NOMBRA lo que falta también en esta superficie —
    // el cuerpo es compartido y el motivo del bloqueo también tiene que serlo.
    await tester.pumpAndSettle();
    expect(
      find.text(
        'Still to capture: the odometer, the fuel level and the cleanliness.',
      ),
      findsOneWidget,
    );

    // GD-5/INN S-4: el combustible SIN default no deja avanzar a firma —
    // odómetro y limpieza solos no bastan.
    controller.setOdometer(48212);
    controller.setCleanliness(4);
    expect(container.read(inspectionControllerProvider('r1')).metricsComplete,
        isFalse, reason: 'fuel sin capturar = evidencia sin capturar');
    await tester.pumpAndSettle();
    expect(
      find.text('Still to capture: the fuel level.'),
      findsOneWidget,
      reason: 'el gate del combustible es invisible sin una palabra que lo diga',
    );
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

  testWidgets(
      'F0 — el obturador colgado deja de ser silencio: timeout, mensaje '
      'honesto y la cámara suelta', (tester) async {
    routeHappyPath();
    camera.hangOnCapture = true;
    container.read(inspectionControllerProvider('r1').notifier);
    await tester.pumpWidget(app(const SizedBox()));
    await tester.pumpAndSettle();

    await tester.pumpWidget(app(const CameraCaptureScreen(
      reservationId: 'r1',
      initialAngleKey: 'front',
    )));
    await tester.pumpAndSettle();

    await tester.tap(find.bySemanticsLabel('Take photo'));
    // Sin `pumpAndSettle`: mientras el disparo viaja hay un spinner vivo (y
    // ANTES de este arreglo, un spinner que jamás terminaría).
    await tester.pump();
    expect(find.text('The camera never returned the photo'), findsNothing,
        reason: 'a los 0 s todavía no hay nada que declarar colgado');

    // El aparato nunca devuelve la foto (GPU por software). Hasta este
    // cambio, aquí no pasaba NADA: ni spinner que acabara, ni error, ni
    // salida — el agente tocando un botón muerto para siempre.
    await tester.pump(kShutterTimeout + const Duration(seconds: 1));
    await tester.pumpAndSettle();

    expect(find.text('The camera never returned the photo'), findsOneWidget);
    expect(find.text('Could not open the camera'), findsNothing,
        reason: 'la cámara SÍ abrió: ese título mandaría a revisar un permiso '
            'que el agente ya tiene');
    // Voz ACTIVA (review GD-SC-7): la app dice lo que hizo. "La cámara se
    // cerró" deja al agente preguntándose si se rompió algo.
    expect(find.textContaining('We closed the camera'), findsOneWidget);
    // Salidas reales, las dos.
    expect(find.text('Retry'), findsOneWidget);
    expect(find.text('Close'), findsWidgets);
    // Y el controlador se soltó: un plugin que no devolvió esta foto no va a
    // devolver la siguiente (DoD #8 — además, cámara viva = memoria viva).
    expect(camera.sessions.single.isDisposed, isTrue);
    // El ángulo no se queda diciendo que está capturando.
    expect(
      container.read(inspectionControllerProvider('r1')).angles['front']!.status,
      AngleStatus.failed,
    );
    expect(
      logger.events
          .firstWhere((e) => e.$1 == CameraEvents.shutterTimeout)
          .$2['timeout_s'],
      kShutterTimeout.inSeconds,
    );

    // Y "Reintentar" es una acción de VERDAD: reabre la cámara (una sesión
    // nueva) en vez de repintar el mismo callejón.
    camera.hangOnCapture = false;
    await tester.tap(find.text('Retry'));
    await tester.pumpAndSettle();
    expect(camera.sessions, hasLength(2));
    expect(find.text('The camera never returned the photo'), findsNothing);
  });

  testWidgets(
      'GD-MC-7: la firma de la INSPECCIÓN también dice QUÉ se firma — el '
      'cliente firma dos veces en el mismo teléfono con cinco minutos de '
      'diferencia', (tester) async {
    routeHappyPath();
    await tester.pumpWidget(app(const InspectionScreen(reservationId: 'r1')));
    await tester.pumpAndSettle();

    container
        .read(inspectionControllerProvider('r1').notifier)
        .goToStep(InspectionStep.signature);
    await tester.pumpAndSettle();

    // Pie de identidad: tenant · unidad. Sin `plate` en el flujo de
    // inspección el widget arma el pie igual (kiosk_signature_step:_footLine),
    // y sin unidad lo omitiría entero — cero riesgo de separador huérfano.
    expect(
      find.textContaining('Toyota Corolla 2023'),
      findsOneWidget,
      reason: 'la unidad viaja desde display-data por inspection_state',
    );
    expect(find.textContaining('Plate'), findsNothing,
        reason: 'la placa no vive en el estado de la inspección');
  });

  testWidgets(
      'el cierre encolado restaura el resumen CON su firma y sus métricas: la '
      'pantalla suelta no aterriza en un CTA muerto', (tester) async {
    routeHappyPath();
    // Corrida anterior: se tocó "Terminar" sin red. La fila del cierre lleva
    // TODO el cuerpo (spike 2) y es la ÚNICA copia de la firma que existe en
    // este teléfono — el estado del controller no sobrevive al proceso.
    //
    // Este es el escenario al que manda "Abrir inspección" de la bandeja
    // (outbox_screen.dart) cuando la fila murió: restaurar el sub-paso sin
    // restaurar la firma dejaba al agente en el resumen con "Terminar"
    // deshabilitado, sin explicación y con el grid dos toques atrás.
    await container.read(outboxServiceProvider).enqueueComplete(
          checkoutSessionId: 'cs1',
          reservationId: 'r1',
          reservationNumber: 'R-20260816-0042',
          body: {
            'odometer': 48212,
            'fuelLevel': 0.75,
            'cleanliness': 4,
            'notes': 'Rayon en la defensa',
            'signatureDataUrl': 'data:image/png;base64,${'x' * 300}',
            'signerName': 'María González',
          },
        );

    await tester.pumpWidget(app(const InspectionScreen(reservationId: 'r1')));
    await tester.pumpAndSettle();

    // Aterriza en el resumen (no en el grid) y el CTA está VIVO.
    final cta = find.widgetWithText(
      RidePrimaryButton,
      'Finish — will send on reconnect',
    );
    expect(cta, findsOneWidget);
    expect(tester.widget<RidePrimaryButton>(cta).onPressed, isNotNull);

    final state = container.read(inspectionControllerProvider('r1'));
    expect(state.step, InspectionStep.summary);
    expect(state.signatureDataUrl, isNotNull);
    // Y no solo la firma: sin las métricas, re-terminar reescribiría la fila
    // con un cuerpo vacío (el enqueue REEMPLAZA el body).
    expect(state.odometer, 48212);
    expect(state.fuelEighths, 6);
    expect(state.cleanliness, 4);
    expect(state.notes, 'Rayon en la defensa');
    expect(state.metricsComplete, isTrue);

    // Volver a terminar es seguro por construcción: idempotente por
    // `sessionId:complete`, misma fila, cuerpo intacto.
    await container
        .read(inspectionControllerProvider('r1').notifier)
        .finish();
    final rows = await db.allFor(userId: kFixtureUserId, tenantId: tenantId);
    final complete =
        rows.singleWhere((r) => r.kind == OutboxKinds.inspectionComplete);
    final body = (json.decode(complete.payload)
        as Map<String, dynamic>)['body'] as Map<String, dynamic>;
    expect(body['signatureDataUrl'], isNotNull);
    expect(body['odometer'], 48212);
    expect(body['fuelLevel'], 0.75);
    expect(body['signerName'], 'María González');
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

    // GD-MC-5: este es EL muro —el agente está junto al coche y la cámara no
    // abre—, así que el aviso no puede prometer solo señal. Con dead-letters
    // dentro, "conéctate y se vacía" manda a caminar hacia la ventana por
    // filas que la red no va a mover nunca.
    expect(
      find.textContaining('what the server rejected only leaves when you '
          'decide'),
      findsWidgets,
    );
    // Y hay salida: la bandeja es la única pantalla donde se decide.
    expect(find.text('Open the outbox'), findsWidgets);
  });
}
