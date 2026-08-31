import 'dart:async';
import 'dart:io';
import 'dart:typed_data';

import 'package:drift/native.dart';
import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:intl/intl.dart';
import 'package:rideops/core/api/api_providers.dart';
import 'package:rideops/core/api/enums.dart';
import 'package:rideops/core/db/outbox_db.dart';
import 'package:rideops/core/db/outbox_providers.dart';
import 'package:rideops/core/l10n/app_localizations.dart';
import 'package:rideops/core/outbox/network_status.dart';
import 'package:rideops/core/outbox/outbox_service.dart';
import 'package:rideops/core/outbox/photo_vault.dart';
import 'package:rideops/core/router/app_router.dart';
import 'package:rideops/core/session/active_location.dart';
import 'package:rideops/core/session/session_controller.dart';
import 'package:rideops/core/session/session_state.dart';
import 'package:rideops/core/telemetry/event_logger.dart';
import 'package:rideops/core/widgets/ride_buttons.dart';
import 'package:rideops/features/checkout/presentation/checkout_wizard_screen.dart';
import 'package:rideops/features/checkout/presentation/widgets/wizard_chrome.dart';
import 'package:rideops/features/inspection/application/camera_service.dart';
import 'package:rideops/features/inspection/application/inspection_controller.dart';
import 'package:rideops/features/inspection/application/inspection_outbox_view.dart';
import 'package:rideops/features/inspection/application/inspection_state.dart';
import 'package:rideops/features/inspection/application/photo_pipeline.dart';
import 'package:rideops/features/inspection/presentation/camera_capture_screen.dart';
import 'package:rideops/features/inspection/presentation/widgets/inspection_bodies.dart';

import 'helpers/auth_test_helpers.dart';
import 'helpers/checkout_test_helpers.dart';
import 'helpers/outbox_test_helpers.dart';
import 'helpers/shell_test_helpers.dart';

/// **M2-H4 — la inspección como paso 4 del wizard** (mockup 17A-17F).
///
/// Las filas de la bandeja las escribe el `OutboxService` REAL sobre una DB
/// real en memoria; el stream que alimenta a la UI es un controller del test
/// que emite ESAS filas (drift `watch()` deja un Timer al cerrarse que rompe
/// el `!timersPending` del desmontaje de flutter_test — política registrada en
/// outbox_test_helpers). Nada se afirma contra un objeto inventado por el
/// propio test.
void main() {
  final liveToken = fakeJwt(
    exp: DateTime.now().add(const Duration(hours: 8)),
    sub: kMyUserId,
  );
  final tenantId = sessionUserFixture().tenantId ?? '';

  late OutboxDb db;
  late Directory tempDir;
  late PhotoVault vault;
  late StreamController<List<OutboxEntry>> rowStream;
  late FakeCheckoutApi api;
  late FakeReservationsApi reservations;
  late FakeNetworkStatus network;
  late CapturingEventLogger logger;
  late FakeCameraService camera;

  setUp(() {
    db = OutboxDb(NativeDatabase.memory());
    tempDir = Directory.systemTemp.createTempSync('rideops_h4');
    vault = tempVault(tempDir);
    rowStream = StreamController<List<OutboxEntry>>.broadcast();
    api = FakeCheckoutApi();
    reservations = FakeReservationsApi();
    network = FakeNetworkStatus(online: true);
    logger = CapturingEventLogger();
    camera = FakeCameraService();
  });

  tearDown(() async {
    await rowStream.close();
    await db.close();
    try {
      tempDir.deleteSync(recursive: true);
    } catch (_) {}
  });

  /// El servicio REAL de la bandeja: las filas del test se escriben por el
  /// mismo camino que las escribe la app.
  OutboxService outbox() => OutboxService(
        db: db,
        vault: vault,
        logger: logger,
        ownerOf: () =>
            OutboxOwner(userId: kMyUserId, tenantId: tenantId),
      );

  Future<List<OutboxEntry>> allRows() =>
      db.allFor(userId: kMyUserId, tenantId: tenantId);

  /// Publica en el stream lo que la DB tiene AHORA — el equivalente exacto de
  /// lo que emitiría `watchAllFor`.
  Future<void> publishRows() async => rowStream.add(await allRows());

  Future<void> enqueuePhoto(String angleKey) => outbox().enqueuePhoto(
        checkoutSessionId: kSessionId,
        reservationId: kReservationId,
        reservationNumber: 'R-2481',
        angleKey: angleKey,
        jpegBytes: Uint8List.fromList(List.filled(400, 7)),
      );

  Future<void> enqueueComplete() => outbox().enqueueComplete(
        checkoutSessionId: kSessionId,
        reservationId: kReservationId,
        reservationNumber: 'R-2481',
        body: const {'odometer': 24131},
      );

  Future<OutboxEntry> rowFor(String idempotencyKey) async =>
      (await db.byIdempotencyKey(idempotencyKey))!;

  /// El contenedor VIVO de la app montada — para empujar el flujo por donde lo
  /// empuja la app (el controller) sin inventar estado.
  ProviderContainer container(WidgetTester tester) =>
      ProviderScope.containerOf(
        tester.element(find.byType(CheckoutWizardScreen)),
      );

  /// [rows] permite sustituir el stream de la bandeja por uno de emisión
  /// ÚNICA — la forma de reproducir "la bandeja ya había emitido antes de que
  /// la red devolviera el id de sesión", que es el orden normal (leer la DB es
  /// más rápido que un GET).
  Future<void> pumpWizard(
    WidgetTester tester, {
    Stream<List<OutboxEntry>>? rows,
  }) async {
    final router = GoRouter(
      initialLocation: AppRoutes.checkout(kReservationId),
      routes: [
        GoRoute(
          path: AppRoutes.home,
          builder: (_, _) => const Scaffold(body: Text('home')),
        ),
        GoRoute(
          path: AppRoutes.outbox,
          builder: (_, _) => const Scaffold(body: Text('outbox-screen')),
        ),
        GoRoute(
          path: AppRoutes.checkoutPattern,
          builder: (_, state) => CheckoutWizardScreen(
            reservationId: state.pathParameters['reservationId']!,
          ),
        ),
      ],
    );
    addTearDown(router.dispose);

    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          checkoutApiProvider.overrideWithValue(api),
          reservationsApiProvider.overrideWithValue(reservations),
          eventLoggerProvider.overrideWithValue(logger),
          networkStatusProvider.overrideWithValue(network),
          outboxDbProvider.overrideWithValue(db),
          photoVaultProvider.overrideWithValue(vault),
          outboxRowsProvider.overrideWith((ref) => rows ?? rowStream.stream),
          cameraServiceProvider.overrideWithValue(camera),
          photoPipelineProvider.overrideWithValue(
            PhotoPipeline(
              // Sync: el dart:io async no resuelve bajo el fake-async del test.
              compressor: (src) async => File(src).readAsBytesSync(),
            ),
          ),
          activeLocationProvider.overrideWith(
            () => StubActiveLocation(
              const ActiveLocation.pinned(
                locationId: 'loc-1',
                locationName: 'Patio Centro',
              ),
            ),
          ),
          sessionControllerProvider.overrideWith(
            () => MutableSessionController(
              SessionState.authenticated(
                token: liveToken,
                user: sessionUserFixture(),
              ),
            ),
          ),
        ],
        child: MaterialApp.router(
          routerConfig: router,
          localizationsDelegates: const [
            AppLocalizations.delegate,
            GlobalMaterialLocalizations.delegate,
            GlobalWidgetsLocalizations.delegate,
            GlobalCupertinoLocalizations.delegate,
          ],
          supportedLocales: const [Locale('es'), Locale('en')],
        ),
      ),
    );
    await tester.pumpAndSettle();
    if (rows == null) {
      await publishRows();
      await tester.pumpAndSettle();
    }
    // M2-H6: entrar a media sesión muestra primero la antesala de enganche
    // (23A). Estos tests prueban el CUERPO del paso, así que la cruzan; la
    // antesala tiene su propia suite (checkout_join_test.dart).
    await skipJoinGate(tester);
  }

  // ── 17A · el paso 6, antes de empezar ─────────────────────────────────────

  testWidgets(
      '17A: INSPECTION_HANDOFF dice "paso 6 de 10" con el cromo COMPLETO, '
      'cuenta qué se va a pedir y arranca la inspección con una transición '
      'de verdad', (tester) async {
    api.current = sessionAt(
      CheckoutStep.inspectionHandoff,
      payment: DateTime.utc(2026, 8, 17, 16, 24),
    );
    await pumpWizard(tester);

    // El contador dice el número REAL del servidor: la fase 4 del rail cubre
    // dos pasos, pero aquí nunca se lee "6.5".
    expect(find.text('Step 6 of 10'), findsOneWidget);
    expect(find.text('Hand off to inspection'), findsOneWidget);
    // Cromo completo: el rail de 5 fases sigue en pantalla y el mapa de pasos
    // se anuncia.
    expect(find.byType(PhaseRail), findsOneWidget);
    expect(find.text('See every step'), findsOneWidget);
    expect(find.byType(InspectionSubStepBar), findsNothing);

    expect(find.text('What gets captured here'), findsOneWidget);
    expect(find.text('8 angles · Front and Rear required'), findsOneWidget);
    // La promesa offline llega CON su límite en la misma frase.
    expect(
      find.textContaining('The step moves on when the server receives them'),
      findsOneWidget,
    );

    await tester.tap(find.text('Start inspection'));
    await tester.pumpAndSettle();
    expect(api.transitions, ['INSPECTION_IN_PROGRESS']);
  });

  testWidgets(
      '17A: pintar el handoff NO monta el flujo de captura — ningún token '
      'público de inspección minteado por mirar el paso 6', (tester) async {
    api.current = sessionAt(CheckoutStep.inspectionHandoff);
    await pumpWizard(tester);

    expect(find.text('Start inspection'), findsOneWidget);
    // `mintHandoffToken` crea un enlace MOBILE_INSPECTION sin autenticación y
    // de 15 minutos (checkout-session.service.js:700-751). Este frame no lee
    // nada de eso: emitirlo al pintar sería regalar acceso por adelantado.
    expect(api.handoffTokenCalls, 0);
    expect(api.inspectionStateCalls, 0);
  });

  // ── 17B · captura con el cromo comprimido y UN solo CTA ───────────────────

  testWidgets(
      '17B: en captura el rail se guarda, la stepline nombra el sub-paso sin '
      'tocar el contador, y el pie del wizard hospeda el ÚNICO CTA',
      (tester) async {
    api.current = sessionAt(CheckoutStep.inspectionInProgress);
    final semantics = tester.ensureSemantics();
    await pumpWizard(tester);

    // Cromo COMPRIMIDO (decisión aprobada): fuera el rail, dentro el
    // sub-progreso. "Pausar" sobrevive — es lo que no se podía perder.
    expect(find.byType(PhaseRail), findsNothing);
    expect(find.byType(InspectionSubStepBar), findsOneWidget);
    expect(find.text('Pause'), findsOneWidget);

    // El número del servidor NO se toca; lo que cambia es el nombre.
    expect(find.text('Step 7 of 10'), findsOneWidget);
    expect(find.text('Inspection · photos'), findsOneWidget);
    // La stepline cambia su trailing: el mapa de 10 pasos cede al contador.
    expect(find.text('See every step'), findsNothing);
    expect(find.text('0 of 8'), findsOneWidget);
    // Pero la fila SIGUE abriéndolo: si el trailing deja de decirlo con
    // palabras, lo dice la semántica — un lector de pantalla no puede anunciar
    // "botón" a secas.
    final stepLineNode = tester.getSemantics(find.descendant(
      of: find.byType(StepLine),
      matching: find.byType(InkWell),
    ));
    expect(stepLineNode.hint, 'See every step');
    // Y se anuncia como UNA fila: número de paso, nombre y contador fundidos
    // en el mismo nodo, no tres nodos sueltos alrededor de un botón mudo.
    expect(stepLineNode.label, contains('Inspection · photos'));

    // UN solo CTA: el de la captura, montado en el pie del wizard.
    expect(find.byType(RidePrimaryButton), findsOneWidget);
    expect(find.text('Continue to metrics'), findsOneWidget);
    // Sin front+rear el CTA está bloqueado CON su causa, no escondido.
    expect(
      find.textContaining('Front and Rear are required'),
      findsOneWidget,
    );
    expect(
      tester.widget<RidePrimaryButton>(find.byType(RidePrimaryButton)).onPressed,
      isNull,
    );
    semantics.dispose();
  });

  testWidgets('17B: tocar un ángulo abre la cámara a pantalla completa — el '
      'cromo del wizard se SUSPENDE del todo', (tester) async {
    api.current = sessionAt(CheckoutStep.inspectionInProgress);
    await pumpWizard(tester);

    await tester.tap(find.text('Front'));
    await tester.pumpAndSettle();

    expect(find.byType(CameraCaptureScreen), findsOneWidget);
    expect(find.byType(WizardBar), findsNothing);
    expect(find.byType(StepLine), findsNothing);
  });

  // ── 17D · completa en este teléfono ≠ completa ────────────────────────────

  testWidgets(
      '17D: con el cierre en la bandeja y sin sello del servidor, el CTA de '
      'avance se muestra BLOQUEADO con su causa y no dispara ninguna '
      'transición', (tester) async {
    api.current = sessionAt(CheckoutStep.inspectionInProgress);
    await enqueuePhoto('front');
    await enqueuePhoto('rear');
    await enqueueComplete();
    network.online = false;
    await pumpWizard(tester);

    // La afirmación exacta del frame: completa AQUÍ, no en el servidor.
    expect(
      find.textContaining('The inspection is complete on this phone'),
      findsOneWidget,
    );
    // Y lo que el servidor SÍ tiene, fechado y por separado.
    expect(find.text('What the server already has'), findsOneWidget);
    expect(find.text('Inspection'), findsOneWidget);
    expect(find.text('Pending'), findsNWidgets(2));

    // De cuándo es esa lectura del servidor: sin la edad, "Pendiente" no
    // distingue una lectura viva de una congelada.
    expect(find.textContaining('State from'), findsOneWidget);

    expect(find.text('Continue to signature and close'), findsOneWidget);
    expect(
      find.textContaining('The server closes this step when it receives'),
      findsOneWidget,
    );
    // Salida real, no solo un botón gris: la bandeja, con su cuenta.
    expect(find.text('Open outbox (3)'), findsOneWidget);

    // Lo que de verdad importa: tocarlo NO manda el POST que devolvería 409
    // ENTRY_GUARD.
    await tester.tap(find.text('Continue to signature and close'));
    await tester.pumpAndSettle();
    expect(api.transitionCalls, 0);

    // Y la salida lleva a la bandeja de verdad.
    await tester.tap(find.text('Open outbox (3)'));
    await tester.pumpAndSettle();
    expect(find.text('outbox-screen'), findsOneWidget);
  });

  testWidgets(
      'GD-MC-7: la firma del paso 4 DENTRO del wizard también dice qué se '
      'firma — es la copia que el cliente ve primero', (tester) async {
    // La otra prueba de GD-MC-7 ejercita la pantalla suelta
    // (inspection_screen). Esta fija la OTRA copia, la del wizard
    // (inspection_step.dart), que es la que corre en el camino normal: el
    // cliente firma aquí y cinco minutos después vuelve a firmar la entrega
    // en el mismo teléfono.
    api.current = sessionAt(CheckoutStep.inspectionInProgress);
    await pumpWizard(tester);

    container(tester)
        .read(inspectionControllerProvider(kReservationId).notifier)
        .goToStep(InspectionStep.signature);
    await tester.pumpAndSettle();

    // Pie de identidad: la unidad viaja desde display-data por
    // inspection_state:134. Sin placa el widget arma el pie igual; sin unidad
    // lo omitiría entero (kiosk_signature_step:_footLine) — cero riesgo.
    expect(
      find.textContaining('Toyota Corolla 2023'),
      findsOneWidget,
      reason: 'sin esto el cliente firma sin saber QUÉ está firmando',
    );
    // Y cero cromo de staff frente al cliente, que es la otra mitad del trato.
    expect(find.text('Pause'), findsNothing);
  });

  // ── 17E · una foto obligatoria muerta ─────────────────────────────────────

  testWidgets(
      '17E: la foto obligatoria muerta se nombra con el motivo del servidor y '
      'el dock cambia a "tomarla otra vez" — el cierre bloqueado deja de ser '
      'la historia', (tester) async {
    api.current = sessionAt(CheckoutStep.inspectionInProgress);
    await enqueuePhoto('front');
    await enqueuePhoto('rear');
    await enqueueComplete();
    await db.markFailed(
      (await rowFor('$kSessionId:front')).id,
      error: 'The server rejected it: this inspection link is no longer valid.',
      code: 'TOKEN_INVALID',
      dead: true,
    );
    await pumpWizard(tester);

    expect(
      find.textContaining("The Front photo couldn't be sent"),
      findsOneWidget,
    );
    // Mensaje del backend tal cual (DoD #5), no una paráfrasis.
    expect(
      find.text(
        'The server rejected it: this inspection link is no longer valid.',
      ),
      findsOneWidget,
    );
    // El estado de los DOS obligatorios, con palabras y no solo con color.
    expect(find.text('Required angles'), findsOneWidget);
    expect(find.text('1 missing'), findsOneWidget);
    expect(find.text("Didn't reach the server"), findsOneWidget);

    // Un botón que arregla las dos cosas; el CTA bloqueado del 17D se retira.
    expect(find.text('Retake Front'), findsOneWidget);
    expect(find.text('Continue to signature and close'), findsNothing);
    expect(find.text('Open outbox (1 failure)'), findsOneWidget);

    expect(
      logger.events.where((e) => e.$1 == 'inspection.required_angle_dead'),
      hasLength(1),
    );

    await tester.tap(find.text('Retake Front'));
    await tester.pumpAndSettle();
    expect(find.byType(CameraCaptureScreen), findsOneWidget);
  });

  testWidgets(
      '17E: con los 8 ángulos tomados y uno OBLIGATORIO muerto, el chip del '
      'cromo cuenta fallas — jamás "8 de 8 ✓" sobre el banner que avisa del '
      'rechazo', (tester) async {
    api.current = sessionAt(CheckoutStep.inspectionInProgress);
    for (final key in kInspectionAngleKeys) {
      await enqueuePhoto(key);
    }
    await enqueueComplete();
    await db.markFailed(
      (await rowFor('$kSessionId:front')).id,
      error: 'The server rejected it: this inspection link is no longer valid.',
      code: 'TOKEN_INVALID',
      dead: true,
    );
    await pumpWizard(tester);

    // El chip es lo más escaneado del cromo: aquí NO puede afirmar "listo".
    // `captured` cuenta queued|onServer y no sabe de filas muertas — las 8
    // están tomadas y aun así el cierre está condenado.
    expect(
      container(tester)
          .read(inspectionControllerProvider(kReservationId))
          .capturedCount,
      8,
    );
    expect(find.text('8 of 8 ✓'), findsNothing);
    expect(find.text('1 failed'), findsOneWidget);
    // Y el banner que explica el rechazo sigue debajo, no en su lugar.
    expect(
      find.textContaining("The Front photo couldn't be sent"),
      findsOneWidget,
    );
  });

  testWidgets(
      '17E: la foto muerta que YA estaba en la bandeja cuando el paso se '
      'montó cuenta igual — la bandeja emite antes que la red', (tester) async {
    api.current = sessionAt(CheckoutStep.inspectionInProgress);
    await enqueuePhoto('front');
    await db.markFailed(
      (await rowFor('$kSessionId:front')).id,
      error: 'The server rejected it: this inspection link is no longer valid.',
      code: 'TOKEN_INVALID',
      dead: true,
    );

    // Emisión ÚNICA y anterior a que el paso conozca el id de sesión: después
    // de esto la bandeja no vuelve a cambiar. Un `listen` a secas no se
    // enteraría jamás —el de riverpod 3 no admite fireImmediately dentro de
    // build— y el paso se quedaría esperando un cierre que el servidor ya
    // decidió rechazar, sin banner y sin evento.
    await pumpWizard(tester, rows: Stream.value(await allRows()));

    expect(
      find.textContaining("The Front photo couldn't be sent"),
      findsOneWidget,
    );
    expect(
      logger.events.where((e) => e.$1 == 'inspection.required_angle_dead'),
      hasLength(1),
    );
  });

  // ── el CTA que no hacía nada ni decía nada ────────────────────────────────

  testWidgets(
      'con la bandeja LLENA, "Terminar" deja de ser un no-op mudo: el aviso '
      'vive en el cuerpo del resumen y lo heredan las dos superficies',
      (tester) async {
    api.current = sessionAt(CheckoutStep.inspectionInProgress);
    await enqueuePhoto('front');
    await enqueuePhoto('rear');
    await pumpWizard(tester);

    // Se llega al resumen por donde se llega de verdad: métricas + firma.
    final controller = container(tester)
        .read(inspectionControllerProvider(kReservationId).notifier);
    controller
      ..setOdometer(24131)
      ..setFuelEighths(6)
      ..setCleanliness(4)
      ..confirmSignature('data:image/png;base64,${'x' * 300}');
    await tester.pumpAndSettle();
    expect(find.text('Finish and send'), findsOneWidget);
    expect(find.textContaining('The outbox is full'), findsNothing);

    // El tope se alcanza entre medias (otro checkout llenó el teléfono).
    final now = DateTime.now();
    for (var i = await db.totalRows(); i < OutboxDb.maxRows; i++) {
      await db.into(db.outboxEntries).insert(OutboxEntriesCompanion.insert(
            id: 'fill-$i',
            userId: kMyUserId,
            tenantId: tenantId,
            kind: OutboxKinds.inspectionPhoto,
            payload: '{}',
            idempotencyKey: 'fill-$i',
            createdAt: now,
            updatedAt: now,
          ));
    }

    await tester.tap(find.text('Finish and send'));
    await tester.pumpAndSettle();

    // El paso 4 descarta el EnqueueResult a propósito (el estado ya lo dice):
    // por eso el aviso tiene que estar en el CUERPO, no en un snackbar de una
    // sola superficie.
    expect(find.textContaining('The outbox is full'), findsOneWidget);
    expect(
      (await allRows()).where((r) => r.kind == OutboxKinds.inspectionComplete),
      isEmpty,
      reason: 'nada se encoló: el CTA no mintió',
    );
  });

  // ── 17F · sellada por el servidor ─────────────────────────────────────────

  testWidgets(
      '17F: con el sello del servidor vuelve el cromo completo, el resumen se '
      'pinta con HORAS DEL SERVIDOR y la firma se atribuye a la inspección '
      'solo si los dos sellos son el mismo instante', (tester) async {
    final at = DateTime.utc(2026, 8, 17, 16, 54);
    api.current = sessionAt(
      CheckoutStep.inspectionInProgress,
      inspection: at,
      signature: at,
    );
    await pumpWizard(tester);

    expect(find.byType(PhaseRail), findsOneWidget);
    expect(find.byType(InspectionSubStepBar), findsNothing);
    // El paso sigue siendo el 7 (el servidor no lo movió); lo que cambia es
    // el nombre, porque "en curso" ya sería falso.
    expect(find.text('Step 7 of 10'), findsOneWidget);
    expect(find.text('Inspection completed'), findsWidgets);

    expect(find.text('Check-out inspection'), findsOneWidget);
    // El paso formatea con DateFormat.Hm (mismo formateador que el resto del
    // wizard), así que la expectativa se construye igual — no con otro.
    final time = DateFormat.Hm('en').format(at.toLocal());
    expect(find.text('Received $time'), findsNWidgets(2));
    expect(find.text('Customer signature'), findsOneWidget);
    expect(
      find.textContaining('at the end of the inspection'),
      findsOneWidget,
    );
    expect(
      find.textContaining('The customer already signed'),
      findsOneWidget,
    );

    await tester.tap(find.text('Continue to closing'));
    await tester.pumpAndSettle();
    expect(api.transitions, ['CUSTOMER_SIGN_PENDING']);
  });

  testWidgets(
      '17F: firma con sello DISTINTO al de la inspección no se atribuye a la '
      'inspección — la puso otra superficie', (tester) async {
    api.current = sessionAt(
      CheckoutStep.inspectionInProgress,
      inspection: DateTime.utc(2026, 8, 17, 16, 54),
      signature: DateTime.utc(2026, 8, 17, 16, 58),
    );
    await pumpWizard(tester);

    expect(find.text('Customer signature'), findsOneWidget);
    expect(find.textContaining('at the end of the inspection'), findsNothing);
  });

  // ── la bandeja como fuente de la verdad local ─────────────────────────────

  group('vista de la bandeja (filas reales de la DB)', () {
    test('agrupa por sesión, distingue muertas y guarda el motivo del backend',
        () async {
      final service = OutboxService(
        db: db,
        vault: vault,
        logger: logger,
        ownerOf: () => OutboxOwner(userId: kMyUserId, tenantId: tenantId),
      );
      await service.enqueuePhoto(
        checkoutSessionId: kSessionId,
        reservationId: kReservationId,
        reservationNumber: 'R-2481',
        angleKey: 'front',
        jpegBytes: Uint8List.fromList(List.filled(10, 1)),
      );
      await service.enqueuePhoto(
        checkoutSessionId: 'otra-sesion',
        reservationId: 'otra-reserva',
        reservationNumber: 'R-9',
        angleKey: 'rear',
        jpegBytes: Uint8List.fromList(List.filled(10, 2)),
      );
      await service.enqueueComplete(
        checkoutSessionId: kSessionId,
        reservationId: kReservationId,
        reservationNumber: 'R-2481',
        body: const {},
      );
      await db.markFailed(
        (await db.byIdempotencyKey('$kSessionId:front'))!.id,
        error: 'link vencido',
        code: 'TOKEN_EXPIRED',
        dead: true,
      );

      final view = inspectionOutboxViewOf(
        await db.allFor(userId: kMyUserId, tenantId: tenantId),
        checkoutSessionId: kSessionId,
      );

      expect(view.photos['front'], OutboxDelivery.dead);
      expect(view.isDeadAngle('front'), isTrue);
      expect(view.deadReasons['front'], 'link vencido');
      // La foto de OTRA sesión no cuenta en este paso.
      expect(view.photos.containsKey('rear'), isFalse);
      expect(view.completeQueued, isTrue);
      expect(view.queuedRows, 1);
      expect(view.deadRows, 1);
      expect(view.totalRows, 2);
      expect(view.queuedPhotos, 0, reason: 'la muerta no va a salir sola');
    });
  });

  // ── promoción "en bandeja" → "el servidor la tiene" ───────────────────────

  group('promoción de ángulos', () {
    late ProviderContainer container;

    ProviderContainer buildContainer() {
      final c = ProviderContainer(overrides: [
        checkoutApiProvider.overrideWithValue(api),
        reservationsApiProvider.overrideWithValue(reservations),
        eventLoggerProvider.overrideWithValue(logger),
        networkStatusProvider.overrideWithValue(network),
        outboxDbProvider.overrideWithValue(db),
        photoVaultProvider.overrideWithValue(vault),
        outboxRowsProvider.overrideWith((ref) => rowStream.stream),
        activeLocationProvider.overrideWith(
          () => StubActiveLocation(
            const ActiveLocation.pinned(
              locationId: 'loc-1',
              locationName: 'Patio Centro',
            ),
          ),
        ),
        sessionControllerProvider.overrideWith(
          () => MutableSessionController(
            SessionState.authenticated(
              token: liveToken,
              user: sessionUserFixture(),
            ),
          ),
        ),
      ]);
      addTearDown(c.dispose);
      return c;
    }

    setUp(() {
      // Sin red: este grupo prueba la reconciliación con la BANDEJA, no el
      // drenado. Con red, el coordinador que dispara `enqueueCapturedPhoto`
      // saldría a subir la foto contra un Dio sin adapter y la mataría en
      // dead-letter antes de que el test pudiera observar nada.
      network.online = false;
      api.current = sessionAt(CheckoutStep.inspectionInProgress);
      container = buildContainer();
    });

    Future<InspectionFlowState> load() async {
      container.listen(
        inspectionControllerProvider(kReservationId),
        (_, _) {},
        fireImmediately: true,
      );
      await Future<void>.delayed(Duration.zero);
      await Future<void>.delayed(Duration.zero);
      return container.read(inspectionControllerProvider(kReservationId));
    }

    test('una fila que DESAPARECE tras haber estado encolada pasa a "el '
        'servidor la tiene"; sin haberla visto encolada, no', () async {
      await load();
      final controller =
          container.read(inspectionControllerProvider(kReservationId).notifier);
      await controller.enqueueCapturedPhoto(
        angleKey: 'front',
        bytes: Uint8List.fromList(List.filled(50, 3)),
        msCompress: 4,
      );
      expect(
        container.read(inspectionControllerProvider(kReservationId))
            .angles['front']!
            .status,
        AngleStatus.queued,
      );

      // CONTROL NEGATIVO: una emisión vacía SIN haber visto antes la fila no
      // puede promover nada — si lo hiciera, la primera emisión del stream
      // pintaría "enviada" cualquier foto encolada en una corrida anterior.
      rowStream.add(const []);
      await Future<void>.delayed(Duration.zero);
      expect(
        container.read(inspectionControllerProvider(kReservationId))
            .angles['front']!
            .status,
        AngleStatus.queued,
        reason: 'sin "estaba antes" no hay prueba de envío',
      );

      // Ahora sí: se ve la fila, y después se ve desaparecer (el drenado solo
      // borra con 2xx).
      rowStream.add(await db.allFor(userId: kMyUserId, tenantId: tenantId));
      await Future<void>.delayed(Duration.zero);
      rowStream.add(const []);
      await Future<void>.delayed(Duration.zero);
      expect(
        container.read(inspectionControllerProvider(kReservationId))
            .angles['front']!
            .status,
        AngleStatus.onServer,
      );
    });

    test('la fila que MUERE no se promueve: sigue sin llegar al servidor',
        () async {
      await load();
      final controller =
          container.read(inspectionControllerProvider(kReservationId).notifier);
      await controller.enqueueCapturedPhoto(
        angleKey: 'front',
        bytes: Uint8List.fromList(List.filled(50, 3)),
        msCompress: 4,
      );
      rowStream.add(await db.allFor(userId: kMyUserId, tenantId: tenantId));
      await Future<void>.delayed(Duration.zero);

      await db.markFailed(
        (await db.byIdempotencyKey('$kSessionId:front'))!.id,
        error: 'rechazada',
        code: 'TOKEN_INVALID',
        dead: true,
      );
      rowStream.add(await db.allFor(userId: kMyUserId, tenantId: tenantId));
      await Future<void>.delayed(Duration.zero);

      expect(
        container.read(inspectionControllerProvider(kReservationId))
            .angles['front']!
            .status,
        AngleStatus.queued,
      );
    });

    test('el sello del servidor retira los envíos de ESA sesión con rastro, y '
        'esa desaparición NO se lee como "enviada"', () async {
      await load();
      final controller =
          container.read(inspectionControllerProvider(kReservationId).notifier);
      await controller.enqueueCapturedPhoto(
        angleKey: 'front',
        bytes: Uint8List.fromList(List.filled(50, 3)),
        msCompress: 4,
      );
      rowStream.add(await db.allFor(userId: kMyUserId, tenantId: tenantId));
      await Future<void>.delayed(Duration.zero);

      await controller.noteCompletedByServer(DateTime.utc(2026, 8, 17, 16, 54));
      expect(await db.totalRows(), 0);
      final audit = await db.auditRows();
      expect(audit.single.reasonCode, 'SESSION_COMPLETED');

      rowStream.add(const []);
      await Future<void>.delayed(Duration.zero);
      expect(
        container.read(inspectionControllerProvider(kReservationId))
            .angles['front']!
            .status,
        AngleStatus.queued,
        reason: 'purgada no es enviada — el servidor nunca la recibió',
      );
    });

    test('retryDeadRows revive TODAS las filas muertas de la sesión (la foto '
        'y el cierre) con los intentos en cero', () async {
      await load();
      final service = OutboxService(
        db: db,
        vault: vault,
        logger: logger,
        ownerOf: () => OutboxOwner(userId: kMyUserId, tenantId: tenantId),
      );
      await service.enqueuePhoto(
        checkoutSessionId: kSessionId,
        reservationId: kReservationId,
        reservationNumber: 'R-2481',
        angleKey: 'front',
        jpegBytes: Uint8List.fromList(List.filled(10, 1)),
      );
      await service.enqueueComplete(
        checkoutSessionId: kSessionId,
        reservationId: kReservationId,
        reservationNumber: 'R-2481',
        body: const {},
      );
      for (final key in ['$kSessionId:front', '$kSessionId:complete']) {
        await db.markFailed(
          (await db.byIdempotencyKey(key))!.id,
          error: 'REQUIRED_ANGLES_MISSING',
          code: 'REQUIRED_ANGLES_MISSING',
          dead: true,
        );
      }

      final revived = await container
          .read(inspectionControllerProvider(kReservationId).notifier)
          .retryDeadRows();

      expect(revived, 2);
      final rows = await db.allFor(userId: kMyUserId, tenantId: tenantId);
      expect(rows.map((r) => r.status).toSet(), {'pending'});
      expect(rows.map((r) => r.attempts).toSet(), {0});
      expect(rows.map((r) => r.lastErrorCode).nonNulls, isEmpty);
    });

    test('con el cierre YA encolado, el flujo se restaura en el sub-paso de '
        'espera, no en fotos', () async {
      final service = OutboxService(
        db: db,
        vault: vault,
        logger: logger,
        ownerOf: () => OutboxOwner(userId: kMyUserId, tenantId: tenantId),
      );
      await service.enqueueComplete(
        checkoutSessionId: kSessionId,
        reservationId: kReservationId,
        reservationNumber: 'R-2481',
        body: const {},
      );

      final state = await load();
      expect(state.completeQueued, isTrue);
      expect(state.step, InspectionStep.summary);
    });
  });
}
