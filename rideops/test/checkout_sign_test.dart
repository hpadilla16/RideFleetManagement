import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:rideops/core/api/api_error.dart';
import 'package:rideops/core/api/api_providers.dart';
import 'package:rideops/core/api/dto/checkout_session.dart';
import 'package:rideops/core/api/enums.dart';
import 'package:rideops/core/l10n/app_localizations.dart';
import 'package:rideops/core/outbox/network_status.dart';
import 'package:rideops/core/router/app_router.dart';
import 'package:rideops/core/session/active_location.dart';
import 'package:rideops/core/session/lock_controller.dart';
import 'package:rideops/core/session/session_controller.dart';
import 'package:rideops/core/session/session_state.dart';
import 'package:rideops/core/theme/ride_tokens.dart';
import 'package:rideops/core/telemetry/event_logger.dart';
import 'package:rideops/core/widgets/ride_buttons.dart';
import 'package:rideops/features/checkout/presentation/checkout_wizard_screen.dart';
import 'package:rideops/features/checkout/presentation/steps/sign_step.dart';
import 'package:rideops/features/checkout/presentation/widgets/close_outcome_view.dart';
import 'package:rideops/features/checkout/application/checkout_close_controller.dart';
import 'package:rideops/features/checkout/presentation/widgets/close_progress.dart';
import 'package:rideops/features/checkout/presentation/widgets/terminal_view.dart';
import 'package:rideops/features/inspection/presentation/widgets/kiosk_signature_step.dart';
import 'package:rideops/features/inspection/presentation/widgets/signature_pad.dart';

import 'helpers/auth_test_helpers.dart';
import 'helpers/checkout_test_helpers.dart';
import 'helpers/outbox_test_helpers.dart';
import 'helpers/shell_test_helpers.dart';

/// **M2-H5 — firma del cliente y cierre de la entrega** (mockup 18 y 19).
///
/// Todo lo que se afirma aquí se afirma contra el OBJETO REAL: la sesión sale
/// del fixture del serializer de Prisma, el contexto sale del fixture de
/// `display-data`, y los tres tramos del cierre se cuentan por las llamadas
/// que el fake registra — nunca por un estado que el test se inventa.
void main() {
  final liveToken = fakeJwt(
    exp: DateTime.now().add(const Duration(hours: 8)),
    sub: kMyUserId,
  );

  /// Instante en el que el complete de la inspección estampó los DOS sellos.
  /// Es el camino normal de RideOps: `mobile-inspection.service.js:265-281`
  /// escribe `inspectionCompletedAt` y `customerSignedAt` en un ÚNICO write.
  final inspectionDone = DateTime.utc(2026, 8, 17, 16, 54);

  late FakeCheckoutApi api;
  late FakeReservationsApi reservations;
  late FakeNetworkStatus network;
  late CapturingEventLogger logger;
  late StubLockController lock;

  setUp(() {
    api = FakeCheckoutApi();
    reservations = FakeReservationsApi();
    network = FakeNetworkStatus(online: true);
    logger = CapturingEventLogger();
    lock = StubLockController();
  });

  /// Sesión en el paso 8 con la firma YA sellada por la inspección (18D).
  CheckoutSessionDto signedSession() => sessionAt(
        CheckoutStep.customerSignPending,
        inspection: inspectionDone,
        signature: inspectionDone,
      );

  /// Sesión en el paso 8 SIN firma: la inspección se cerró en otra superficie
  /// (o sin firma), que es el camino minoritario de 18A/18B.
  CheckoutSessionDto unsignedSession() => sessionAt(
        CheckoutStep.customerSignPending,
        inspection: inspectionDone,
      );

  CheckoutSessionDto closedSession() => sessionAt(
        CheckoutStep.closed,
        inspection: inspectionDone,
        signature: inspectionDone,
      );

  Future<void> pumpSign(WidgetTester tester) async {
    final router = GoRouter(
      initialLocation: AppRoutes.checkout(kReservationId),
      routes: [
        GoRoute(
          path: AppRoutes.home,
          builder: (_, _) => const Scaffold(body: Text('home')),
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
          // El candado real lee Keystore; aquí solo interesa que el kiosco
          // suspenda y reanude en pares exactos.
          lockControllerProvider.overrideWith(() => lock),
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
  }

  /// Trazo REAL sobre el lienzo + confirmación. El export a PNG pasa por el
  /// engine, cuyos futures no resuelven bajo el fake-async del test.
  Future<void> signOnPad(WidgetTester tester) async {
    final gesture = await tester.startGesture(
      tester.getCenter(find.byType(SignaturePad)),
    );
    await gesture.moveBy(const Offset(60, 12));
    await tester.pump();
    await gesture.moveBy(const Offset(-30, 18));
    await tester.pump();
    await gesture.up();
    await tester.pump();
    await tester.runAsync(() async {
      await tester.tap(find.text('Confirm signature'));
      await tester.pump();
      await Future<void>.delayed(const Duration(milliseconds: 120));
    });
    await tester.pumpAndSettle();
  }

  Future<void> scrollBody(WidgetTester tester, Finder target) async {
    await tester.scrollUntilVisible(
      target,
      120,
      scrollable: find.byType(Scrollable).first,
    );
    await tester.pumpAndSettle();
  }

  // ── 18D · el camino NORMAL ────────────────────────────────────────────────

  testWidgets(
      '18D: el paso 8 se decide por el SELLO, no por currentStep — con '
      'customerSignedAt puesto NO se le pide la firma otra vez al cliente',
      (tester) async {
    api.current = signedSession();
    await pumpSign(tester);

    // El shell enruta el paso 8 a la pantalla de firma; el servidor sigue
    // reportando el paso 8 y el contador lo dice tal cual.
    expect(find.byType(SignStep), findsOneWidget);
    expect(find.text('Step 8 of 10'), findsOneWidget);
    expect(find.text('The customer already signed'), findsOneWidget);
    // Se atribuye a la inspección SOLO porque los dos sellos son el mismo
    // instante (un único write del complete móvil).
    expect(
      find.textContaining('signed at the end of the inspection'),
      findsOneWidget,
    );
    // Y lo que NO está: la pantalla de entrega del teléfono.
    expect(find.text('Turn the phone to the customer'), findsNothing);
    expect(find.text('Hand to the customer'), findsNothing);
    // El firmante sale de display-data (la misma fuente que sella signerName).
    await scrollBody(tester, find.text('María González'));
    expect(find.text('María González'), findsOneWidget);
    expect(find.text('Close the handover'), findsOneWidget);
  });

  testWidgets(
      '18D: sellos DISTINTOS ⇒ no se atribuye la firma a la inspección',
      (tester) async {
    // La firma llegó por otra superficie, 20 minutos después del complete.
    api.current = sessionAt(
      CheckoutStep.customerSignPending,
      inspection: inspectionDone,
      signature: inspectionDone.add(const Duration(minutes: 20)),
    );
    await pumpSign(tester);

    expect(find.text('The customer already signed'), findsOneWidget);
    expect(
      find.textContaining('signed at the end of the inspection'),
      findsNothing,
      reason: 'sellos distintos: la sesión no dice DÓNDE firmó',
    );
    expect(find.textContaining('signature was recorded at'), findsOneWidget);
  });

  // ── 18A/18B · el camino minoritario ───────────────────────────────────────

  testWidgets(
      '18A: sin sello de firma se entrega el teléfono — y la pantalla declara '
      'las cuatro reglas del kiosco, incluido que agotar el PIN BLOQUEA la app',
      (tester) async {
    api.current = unsignedSession();
    await pumpSign(tester);

    expect(find.text('Turn the phone to the customer'), findsOneWidget);
    expect(
      find.textContaining('The app locks onto the signature'),
      findsOneWidget,
    );
    expect(find.textContaining('hold the top bar for 3 s'), findsOneWidget);
    expect(
      find.textContaining('Three wrong PINs and the app locks'),
      findsOneWidget,
      reason: 'el límite ya está construido; el agente lo sabe ANTES de soltar',
    );
    // Marca del TENANT, jamás la nuestra.
    expect(
      find.textContaining('branded as Autos del Valle'),
      findsOneWidget,
    );
    expect(find.text('The customer already signed'), findsNothing);
  });

  testWidgets(
      '18A sin red: la entrega del teléfono se BLOQUEA con causa y la firma '
      'no se encola nunca', (tester) async {
    api.current = unsignedSession();
    await pumpSign(tester);
    // Offline HONESTO: el plugin solo reporta interfaz; el veredicto lo da la
    // request. Se reproduce el par real — sin interfaz y con la lectura
    // muriendo sin respuesta.
    network.online = false;
    api.onGet = () async => throw apiError(ApiErrorKind.network, message: '');
    await tester.pump(const Duration(seconds: 6));
    await tester.pumpAndSettle();

    final cta = tester.widget<RidePrimaryButton>(
      find.widgetWithText(RidePrimaryButton, 'Hand to the customer'),
    );
    expect(cta.onPressed, isNull, reason: 'deshabilitado, no escondido');
    expect(
      find.textContaining("signature can't be collected offline"),
      findsOneWidget,
    );

    // Y el bloqueo NO vive solo en el botón: se invoca el controller REAL,
    // que es lo que un botón mal habilitado (o una carrera) llamaría.
    final container = ProviderScope.containerOf(
      tester.element(find.byType(CheckoutWizardScreen)),
    );
    final close =
        container.read(checkoutCloseProvider(kReservationId).notifier);
    expect(close.openKiosk(), isFalse);
    await close.close();
    await tester.pumpAndSettle();
    expect(find.byType(KioskSignatureStep), findsNothing);
    expect(api.signatureCalls, 0,
        reason: 'la firma no se encola ni se manda a ciegas: se espera');
  });

  testWidgets(
      '18B: el kiosco de la entrega es el MISMO del M1 (candado suspendido, '
      'tinta neutra) apuntado a otro trámite, y firma con la identidad de lo '
      'que se firma al pie', (tester) async {
    api.current = unsignedSession();
    await pumpSign(tester);
    await tester.tap(find.text('Hand to the customer'));
    await tester.pumpAndSettle();

    expect(find.byType(KioskSignatureStep), findsOneWidget);
    expect(lock.suspends, 1, reason: 'el candado no puede saltar a media firma');
    // Copy del trámite de ENTREGA, no de la revisión del M1.
    expect(
      find.textContaining('receiving the vehicle and accept the rental'),
      findsOneWidget,
    );
    expect(find.textContaining('Vehicle handover'), findsOneWidget);
    // Pie de identidad (18B nota 6): tenant · unidad · placa.
    expect(
      find.textContaining('Toyota Corolla 2023 · U-112 · Plate IKL-427'),
      findsOneWidget,
    );
    // Cero cromo de staff frente al cliente.
    expect(find.text('Step 8 of 10'), findsNothing);
    expect(find.text('Pause'), findsNothing);

    // Y CERO MARCA DE PLATAFORMA: la barra de modo vive 60 segundos a la
    // vista de quien está firmando un contrato. Tinta neutra, no el morado
    // de RideOps (decisión de Hector sobre la nota 3 del 18B). Se afirma
    // sobre el gradiente REAL que se pinta, no sobre un comentario.
    final bar = tester.widget<Container>(
      find
          .ancestor(
            of: find.text('Signing mode · lock paused'),
            matching: find.byType(Container),
          )
          .first,
    );
    final gradient =
        (bar.decoration! as BoxDecoration).gradient! as LinearGradient;
    expect(gradient.colors, [RideTokens.n900, RideTokens.n800]);
    expect(gradient.colors.contains(RideTokens.brand), isFalse);
    expect(gradient.colors.contains(RideTokens.p800), isFalse);
  });

  // ── 18C · tres llamadas, tres renglones ───────────────────────────────────

  testWidgets(
      '18C: el cierre son TRES llamadas del cliente en orden — firma, '
      'FINALIZING y CLOSED — y el signerName viaja sellado desde display-data',
      (tester) async {
    api.current = unsignedSession();
    await pumpSign(tester);
    await tester.tap(find.text('Hand to the customer'));
    await tester.pumpAndSettle();

    // Cada respuesta mueve la sesión como lo haría el servidor.
    api.onSaveCustomerSignature = (dataUrl, signerName) async {
      api.current = sessionAt(
        CheckoutStep.customerSignPending,
        inspection: inspectionDone,
        signature: DateTime.utc(2026, 8, 17, 17, 4),
      );
      return api.current!;
    };
    api.onTransition = (toStep) async {
      api.current = sessionAt(
        CheckoutStep.tryParse(toStep)!,
        inspection: inspectionDone,
        signature: DateTime.utc(2026, 8, 17, 17, 4),
      );
      return api.current!;
    };

    await signOnPad(tester);

    expect(api.signatureCalls, 1);
    expect(
      api.signatureDataUrls.single,
      startsWith('data:image/png;base64,'),
    );
    expect(api.signatureDataUrls.single.length, greaterThan(200),
        reason: 'el backend exige >200 chars (SIGNATURE_REQUIRED)');
    expect(
      api.signerNames.single,
      'María González',
      reason: 'sin esto la firma queda ANÓNIMA en el contrato',
    );
    // El orden es el del cliente: el backend no encadena nada aquí.
    expect(api.transitions, ['FINALIZING', 'CLOSED']);
    expect(logger.events.where((e) => e.$1 == 'checkout.close_started').single.$2,
        {'legs': 3});
  });

  testWidgets(
      '18C: mientras corre el cierre se dibujan los TRES renglones, y '
      '"Firma recibida" solo aparece cuando el 200 de la firma ya llegó',
      (tester) async {
    api.current = unsignedSession();
    await pumpSign(tester);
    await tester.tap(find.text('Hand to the customer'));
    await tester.pumpAndSettle();

    // La transición a FINALIZING se queda en vuelo: es el instante del frame.
    final hold = Completer<void>();
    api.onSaveCustomerSignature = (_, _) async {
      api.current = sessionAt(
        CheckoutStep.customerSignPending,
        inspection: inspectionDone,
        signature: DateTime.utc(2026, 8, 17, 17, 4),
      );
      return api.current!;
    };
    api.onTransition = (toStep) async {
      await hold.future;
      return api.current!;
    };

    // Con un POST en vuelo hay spinner vivo: `pumpAndSettle` no terminaría
    // nunca. Se bombea a mano, que es exactamente el instante del frame 18C.
    final gesture = await tester.startGesture(
      tester.getCenter(find.byType(SignaturePad)),
    );
    await gesture.moveBy(const Offset(60, 12));
    await tester.pump();
    await gesture.moveBy(const Offset(-30, 18));
    await tester.pump();
    await gesture.up();
    await tester.pump();
    await tester.runAsync(() async {
      await tester.tap(find.text('Confirm signature'));
      await tester.pump();
      await Future<void>.delayed(const Duration(milliseconds: 120));
    });
    await tester.pump();
    await tester.pump();

    expect(find.byType(CloseProgressCard), findsOneWidget);
    expect(find.text('Signature saved to the agreement'), findsOneWidget);
    expect(find.text('Generating the agreement'), findsOneWidget);
    expect(find.text('Recording the handover'), findsOneWidget);
    expect(
      find.textContaining('You can take the phone back'),
      findsOneWidget,
      reason: 'el 200 de customer-signature ya respondió: es verdad al decirlo',
    );
    // El pie no promete atomicidad: pide lo único útil.
    expect(find.textContaining('three server confirmations'), findsOneWidget);
    // Soltar el tramo: el cierre corre en la zona async REAL (el export a PNG
    // lo obligó), así que se libera ahí. Se bombea a mano —sin
    // `pumpAndSettle`— porque los timers que nacieron dentro de `runAsync` son
    // del reloj de verdad y el fake-async no los drena.
    await tester.runAsync(() async {
      hold.complete();
      await Future<void>.delayed(const Duration(milliseconds: 200));
    });
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));
    expect(api.transitions, ['FINALIZING', 'CLOSED']);
  });

  // ── 19B · cerrado pero NO entregado ───────────────────────────────────────

  testWidgets(
      '19B: el servidor rechaza el finalize con la sesión YA cerrada — se cita '
      'su motivo, se declara que no hay reintento y NO se dibuja el botón que '
      'daría 409 eterno', (tester) async {
    api.current = signedSession();
    await pumpSign(tester);

    api.onTransition = (toStep) async {
      if (toStep == 'FINALIZING') {
        api.current = sessionAt(
          CheckoutStep.finalizing,
          inspection: inspectionDone,
          signature: inspectionDone,
        );
        return api.current!;
      }
      // La fila ya quedó CLOSED (service:417) y DESPUÉS explota la cascada.
      api.current = closedSession();
      throw apiError(
        ApiErrorKind.conflict,
        message: 'Vehicle U-112 is taken by another open rental (R-2466).',
        code: 'VEHICLE_CONFLICT',
      );
    };

    await tester.tap(find.text('Close the handover'));
    await tester.pumpAndSettle();

    expect(find.byType(CheckoutCloseOutcomeView), findsOneWidget);
    expect(
      find.textContaining('did not record the handover'),
      findsOneWidget,
    );
    // El motivo va CITADO, no traducido.
    expect(
      find.text('Vehicle U-112 is taken by another open rental (R-2466).'),
      findsOneWidget,
    );
    await scrollBody(tester, find.textContaining("can't be retried from here"));
    expect(find.textContaining("can't be retried from here"), findsOneWidget);
    expect(find.text('Retry closing'), findsNothing);
    // Sin canal al mostrador no se dibuja el botón que no puede cumplir; la
    // acción real sube a principal y la pantalla NUNCA se queda sin botón.
    expect(find.text('Notify the counter'), findsNothing);
    expect(find.text('Copy the problem details'), findsOneWidget);
    expect(
      find.textContaining("Don't hand over the keys"),
      findsOneWidget,
    );
    expect(
      logger.events
          .where((e) => e.$1 == 'checkout.close_failed')
          .single
          .$2,
      {'leg': 'closing', 'code': 'VEHICLE_CONFLICT', 'terminal': true},
    );
  });

  testWidgets(
      '19B silencioso: el cierre responde 200 pero la reserva sigue en '
      'CONFIRMED — se VERIFICA con Reservation.status en vez de creerle al 200',
      (tester) async {
    api.current = signedSession();
    api.onTransition = (toStep) async {
      api.current = sessionAt(
        CheckoutStep.tryParse(toStep)!,
        inspection: inspectionDone,
        signature: inspectionDone,
      );
      return api.current!;
    };
    // El fixture ya trae "CONFIRMED": la cascada se tragó su error.
    await pumpSign(tester);
    await tester.tap(find.text('Close the handover'));
    await tester.pumpAndSettle();

    expect(find.byType(CheckoutCloseOutcomeView), findsOneWidget);
    expect(
      find.textContaining('was not marked as handed over'),
      findsOneWidget,
    );
    expect(find.text('Checked on the reservation'), findsOneWidget);
    expect(find.text('Handover closed'), findsNothing);
    expect(
      logger.events.where((e) => e.$1 == 'checkout.close_ok').single.$2,
      {'handover': 'not_recorded'},
    );
  });

  testWidgets('19B: "Copiar el detalle" pone en el portapapeles lo que el '
      'mostrador necesita — porque el motivo NO sobrevive al re-fetch',
      (tester) async {
    String? copied;
    tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
      SystemChannels.platform,
      (call) async {
        if (call.method == 'Clipboard.setData') {
          copied = (call.arguments as Map)['text'] as String?;
        }
        return null;
      },
    );
    addTearDown(() => tester.binding.defaultBinaryMessenger
        .setMockMethodCallHandler(SystemChannels.platform, null));

    api.current = signedSession();
    await pumpSign(tester);
    api.onTransition = (toStep) async {
      if (toStep == 'FINALIZING') {
        api.current = sessionAt(
          CheckoutStep.finalizing,
          inspection: inspectionDone,
          signature: inspectionDone,
        );
        return api.current!;
      }
      api.current = closedSession();
      throw apiError(
        ApiErrorKind.conflict,
        message: 'Cannot finalize checkout: no vehicle is assigned.',
        code: 'NO_VEHICLE_ASSIGNED',
      );
    };
    await tester.tap(find.text('Close the handover'));
    await tester.pumpAndSettle();

    await tester.tap(find.text('Copy the problem details'));
    await tester.pumpAndSettle();

    expect(copied, isNotNull);
    expect(copied, contains(kSessionId));
    expect(copied, contains('NO_VEHICLE_ASSIGNED'));
    expect(copied, contains('no vehicle is assigned'));
    expect(copied, contains('CONFIRMED'),
        reason: 'el estado verificado de la reserva viaja con el reporte');
  });

  // ── 19A · entrega cerrada ─────────────────────────────────────────────────

  testWidgets(
      '19A: con la reserva ya en CHECKED_OUT se cierra en verde, se dice qué '
      'hacer en los siguientes 30 s, y el correo se "pidió" — jamás "salió"',
      (tester) async {
    api.current = signedSession();
    api.onTransition = (toStep) async {
      api.current = CheckoutSessionDto.fromJson({
        ...rawCheckoutSession(),
        'currentStep': toStep,
        'inspectionCompletedAt': inspectionDone.toIso8601String(),
        'customerSignedAt': inspectionDone.toIso8601String(),
        'finishedAt': DateTime.utc(2026, 8, 17, 17, 4).toIso8601String(),
        'autoEmailedAt': DateTime.utc(2026, 8, 17, 17, 4).toIso8601String(),
      });
      return api.current!;
    };
    reservations.patchDisplayData = (raw) {
      (raw['reservation'] as Map<String, dynamic>)['status'] = 'CHECKED_OUT';
      return raw;
    };
    await pumpSign(tester);
    await tester.tap(find.text('Close the handover'));
    await tester.pumpAndSettle();

    expect(find.text('Handover closed'), findsOneWidget);
    expect(find.text('Before they leave'), findsOneWidget);
    expect(
      find.text('Hand over the keys and the registration card'),
      findsOneWidget,
    );
    // La sede de la fila es la de DEVOLUCIÓN de la reserva.
    expect(find.textContaining('Patio Centro'), findsWidgets);
    await scrollBody(tester, find.text('Record'));
    expect(
      find.text('The reservation is marked as handed over'),
      findsOneWidget,
      reason: 'solo porque Reservation.status lo dice',
    );
    expect(
      find.textContaining('Email delivery was requested at'),
      findsOneWidget,
    );
    expect(find.textContaining('was sent'), findsNothing);
    expect(
      logger.events.where((e) => e.$1 == 'checkout.close_ok').single.$2,
      {'handover': 'recorded'},
    );
  });

  testWidgets('19A: "Ver el detalle de la sesión" abre el log de 11E, y la '
      'sesión que ya estaba cerrada al ENTRAR sigue aterrizando en 11E',
      (tester) async {
    api.current = signedSession();
    api.onTransition = (toStep) async {
      api.current = sessionAt(
        CheckoutStep.tryParse(toStep)!,
        inspection: inspectionDone,
        signature: inspectionDone,
      );
      return api.current!;
    };
    reservations.patchDisplayData = (raw) {
      (raw['reservation'] as Map<String, dynamic>)['status'] = 'CHECKED_OUT';
      return raw;
    };
    await pumpSign(tester);
    await tester.tap(find.text('Close the handover'));
    await tester.pumpAndSettle();

    expect(find.byType(CheckoutTerminalView), findsNothing);
    await scrollBody(tester, find.text('See session detail'));
    await tester.tap(find.text('See session detail'));
    await tester.pumpAndSettle();
    expect(find.byType(CheckoutTerminalView), findsOneWidget);
  });

  testWidgets(
      '11E intacto: entrar a una sesión YA cerrada no muestra "entrega las '
      'llaves" — ese consejo solo vale con el cliente enfrente', (tester) async {
    api.current = closedSession();
    await pumpSign(tester);

    expect(find.byType(CheckoutTerminalView), findsOneWidget);
    expect(find.byType(CheckoutCloseOutcomeView), findsNothing);
    expect(find.text('Before they leave'), findsNothing);
  });

  // ── 19C · no se sabe si entró ─────────────────────────────────────────────

  testWidgets(
      '19C: la red muere a media secuencia — los tramos confirmados quedan en '
      'su hora y los que no respondieron quedan DESCONOCIDOS; la salida es '
      'consultar, nunca reintentar a ciegas', (tester) async {
    api.current = signedSession();
    await pumpSign(tester);
    api.onTransition = (toStep) async =>
        throw apiError(ApiErrorKind.network, message: '');

    await tester.tap(find.text('Close the handover'));
    await tester.pumpAndSettle();

    expect(find.textContaining("don't know whether it went through"),
        findsOneWidget);
    // La stepline dice el sub-estado; sin red le añade su edad, así que se
    // busca por contenido y no por igualdad exacta.
    expect(find.textContaining('Closing unconfirmed'), findsOneWidget);
    // "No sé" y no "no pasó": el tramo que murió sin respuesta y los que le
    // siguen quedan DESCONOCIDOS — se afirma contra el objeto real, no contra
    // el glifo. El confirmado conserva su hora.
    await scrollBody(tester, find.byType(CloseProgressCard));
    final card = tester.widget<CloseProgressCard>(
      find.byType(CloseProgressCard),
    );
    expect(card.signature, CloseLegState.done);
    expect(card.finalizing, CloseLegState.unknown);
    expect(card.closing, CloseLegState.unknown);
    expect(find.text('No response'), findsNWidgets(2));
    // El tramo confirmado conserva su HORA del servidor y lo dice.
    expect(find.textContaining('· confirmed'), findsOneWidget);
    // Las dos reglas se DECLARAN.
    expect(find.text('What will NOT happen'), findsOneWidget);
    expect(find.text("The app won't retry the close on its own."),
        findsOneWidget);
    expect(find.text('Closing never goes into the outbox.'), findsOneWidget);

    // "Consultar el estado" es un GET, jamás un POST repetido.
    final transitionsBefore = api.transitions.length;
    final getsBefore = api.getCalls;
    api.onTransition = null;
    await tester.tap(find.text('Check the status'));
    await tester.pumpAndSettle();
    expect(api.transitions.length, transitionsBefore,
        reason: 'ADR-5 aplicado al cierre: se consulta, no se reproduce');
    expect(api.getCalls, greaterThan(getsBefore));
  });

  testWidgets(
      '19C: si la consulta descubre que el cierre SÍ entró, se cuenta como '
      '19A y se verifica la entrega', (tester) async {
    api.current = signedSession();
    await pumpSign(tester);
    api.onTransition = (_) async =>
        throw apiError(ApiErrorKind.network, message: '');
    await tester.tap(find.text('Close the handover'));
    await tester.pumpAndSettle();
    expect(find.text('Check the status'), findsOneWidget);

    // El servidor sí había cerrado.
    api.current = closedSession();
    api.onGet = () async => api.current!;
    reservations.patchDisplayData = (raw) {
      (raw['reservation'] as Map<String, dynamic>)['status'] = 'CHECKED_OUT';
      return raw;
    };
    await tester.tap(find.text('Check the status'));
    await tester.pumpAndSettle();

    expect(find.text('Handover closed'), findsOneWidget);
  });

  // ── "Volver a pedir la firma" ─────────────────────────────────────────────

  testWidgets(
      '18D: "Volver a pedir la firma" avisa que SUSTITUYE antes de abrir el '
      'kiosco, y cancelar no abre nada', (tester) async {
    api.current = signedSession();
    await pumpSign(tester);
    await scrollBody(tester, find.text('Ask for the signature again'));

    await tester.tap(find.text('Ask for the signature again'));
    await tester.pumpAndSettle();
    expect(find.text('Replace the saved signature?'), findsOneWidget);
    expect(find.textContaining('REPLACES the one already on the agreement'),
        findsOneWidget);

    await tester.tap(find.text('Cancel'));
    await tester.pumpAndSettle();
    expect(find.byType(KioskSignatureStep), findsNothing);

    await tester.tap(find.text('Ask for the signature again'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Yes, ask again'));
    await tester.pumpAndSettle();
    expect(find.byType(KioskSignatureStep), findsOneWidget);
  });

  testWidgets(
      'la firma que SUSTITUYE se mide: signature_saved viaja con replaced:true',
      (tester) async {
    api.current = signedSession();
    await pumpSign(tester);
    await scrollBody(tester, find.text('Ask for the signature again'));
    await tester.tap(find.text('Ask for the signature again'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Yes, ask again'));
    await tester.pumpAndSettle();

    api.onSaveCustomerSignature = (_, _) async => api.current!;
    api.onTransition = (toStep) async {
      api.current = sessionAt(
        CheckoutStep.tryParse(toStep)!,
        inspection: inspectionDone,
        signature: inspectionDone,
      );
      return api.current!;
    };
    await signOnPad(tester);

    expect(
      logger.events
          .where((e) => e.$1 == 'checkout.signature_saved')
          .single
          .$2,
      {'replaced': true},
    );
  });

  // ── FINALIZING · reanudar el último tramo ────────────────────────────────

  testWidgets(
      'FINALIZING: al volver, el cierre continúa el ÚLTIMO tramo — no repite '
      'la transición que el servidor ya tiene', (tester) async {
    api.current = sessionAt(
      CheckoutStep.finalizing,
      inspection: inspectionDone,
      signature: inspectionDone,
    );
    api.onTransition = (toStep) async {
      api.current = sessionAt(
        CheckoutStep.tryParse(toStep)!,
        inspection: inspectionDone,
        signature: inspectionDone,
      );
      return api.current!;
    };
    await pumpSign(tester);
    expect(find.text('Step 9 of 10'), findsOneWidget);

    await tester.tap(find.text('Close the handover'));
    await tester.pumpAndSettle();

    expect(api.transitions, ['CLOSED'],
        reason: 'el tramo que el servidor ya tiene se SALTA, no se repite');
    expect(api.signatureCalls, 0, reason: 'la firma ya estaba sellada');
  });
}
