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
import 'package:rideops/features/checkout/presentation/widgets/verify_cards.dart';
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

  /// Espera a que el export a PNG del lienzo REALMENTE haya salido, sondeando
  /// en vez de dormir un plazo fijo.
  ///
  /// El export pasa por el engine y sus futures no resuelven bajo fake-async,
  /// así que hay que estar en `runAsync` con el reloj de verdad. Un
  /// `delayed` fijo obliga a elegir entre lento (siempre paga el peor caso) y
  /// frágil (se cae cuando la suite satura la CPU); el sondeo sale en cuanto
  /// la condición se cumple y solo agota el tope cuando de verdad falló.
  Future<void> waitFor(
    bool Function() done, {
    Duration timeout = const Duration(seconds: 5),
  }) async {
    final deadline = DateTime.now().add(timeout);
    while (!done()) {
      if (DateTime.now().isAfter(deadline)) {
        fail('el export de la firma no salió en ${timeout.inSeconds} s');
      }
      await Future<void>.delayed(const Duration(milliseconds: 10));
    }
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
      // Sondeo acotado sobre el efecto REAL (la firma salió a la API), no un
      // plazo fijo: con la suite en paralelo 120 ms no bastaban y el
      // `signerNames` quedaba vacío — un rojo falso en una prueba de
      // contrato. Esto sale en cuanto ocurre.
      await waitFor(() => api.signatureCalls > 0);
    });
    await tester.pumpAndSettle();
  }

  /// Back del SISTEMA (el gesto/botón de Android), que es el que pasa por
  /// `PopScope` — no el de la barra del wizard.
  Future<void> systemBack(WidgetTester tester) async {
    await tester.binding.handlePopRoute();
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
    await tester.pumpAndSettle();
    expect(find.byType(KioskSignatureStep), findsNothing);
    expect(api.signatureCalls, 0,
        reason: 'la firma no se encola ni se manda a ciegas: se espera');
  });

  testWidgets(
      '18D sin red: `close()` no sale a la red ni finge un fallo — la guarda '
      'del cierre se prueba CON sello, que es el único fixture que llega a '
      'ella', (tester) async {
    // Con `unsignedSession()` esta prueba estaba enmascarada: `close()` retorna
    // tres líneas antes ("sin tinta fresca y sin sello"), así que pasaba con
    // guarda y sin ella. Con el sello puesto, revertir la guarda deja correr
    // `_runTransition` → `attemptTransition` → `blocked` → `_noteFailure`, y
    // la pantalla salta a un fallo reintentable SIN motivo del servidor, sin
    // red y sin una sola petición.
    api.current = signedSession();
    await pumpSign(tester);
    network.online = false;
    api.onGet = () async => throw apiError(ApiErrorKind.network, message: '');
    await tester.pump(const Duration(seconds: 6));
    await tester.pumpAndSettle();

    final container = ProviderScope.containerOf(
      tester.element(find.byType(CheckoutWizardScreen)),
    );
    final close =
        container.read(checkoutCloseProvider(kReservationId).notifier);
    await close.close();
    await tester.pumpAndSettle();

    expect(api.transitions, isEmpty,
        reason: 'sin red no sale ningún POST del cierre');
    // Y la pantalla NO salta al estado de fallo: sigue siendo 18D con su CTA.
    expect(find.text('Retry closing'), findsNothing);
    expect(find.byType(CloseProgressCard), findsNothing);
    expect(find.text('Close the handover'), findsOneWidget);
    final cta = tester.widget<RidePrimaryButton>(
      find.widgetWithText(RidePrimaryButton, 'Close the handover'),
    );
    expect(cta.onPressed, isNull, reason: 'deshabilitado CON causa');
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
      // Sondeo acotado sobre el efecto REAL (la firma salió a la API), no un
      // plazo fijo: con la suite en paralelo 120 ms no bastaban y el
      // `signerNames` quedaba vacío — un rojo falso en una prueba de
      // contrato. Esto sale en cuanto ocurre.
      await waitFor(() => api.signatureCalls > 0);
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
    expect(find.text('Copy the details for the counter'), findsOneWidget);
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
    // GD-SC-3: sin motivo del servidor la tarjeta NO se titula "Motivo" ni
    // usa la etiqueta de fila "Entrega" como rúbrica — no hay a quién citar,
    // así que cuenta lo que la app comprobó por su cuenta.
    expect(find.text('Checked on the reservation'), findsOneWidget,
        reason: 'pastilla');
    expect(find.text('What we checked'), findsOneWidget, reason: 'título');
    expect(find.text('Reservation status'), findsOneWidget, reason: 'rúbrica');
    expect(find.text('Reason'), findsNothing,
        reason: 'titular "Motivo" un texto que dice que no hubo motivo se '
            'contradice solo');
    expect(find.text('Server response'), findsNothing);
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
      // El estado de la reserva CAMBIA con el rechazo: sin esto, la lectura
      // rancia y la fresca son idénticas y borrar la verificación de 19B no
      // rompería nada (la prueba prometía más de lo que comprobaba).
      reservations.patchDisplayData = (raw) {
        (raw['reservation'] as Map<String, dynamic>)['status'] = 'CHECKED_OUT';
        return raw;
      };
      // 422, no 409: `NO_VEHICLE_ASSIGNED` sale de service:464-468 y la ruta
      // preserva su status (routes:12-16). El par 409+NO_VEHICLE_ASSIGNED que
      // esta prueba usaba antes no lo emite el backend en ningún camino.
      throw apiError(
        ApiErrorKind.badRequest,
        status: 422,
        message: 'Cannot finalize checkout: no vehicle is assigned.',
        code: 'NO_VEHICLE_ASSIGNED',
      );
    };
    await tester.tap(find.text('Close the handover'));
    await tester.pumpAndSettle();

    await tester.tap(find.text('Copy the details for the counter'));
    await tester.pumpAndSettle();

    expect(copied, isNotNull);
    expect(copied, contains(kSessionId));
    expect(copied, contains('NO_VEHICLE_ASSIGNED'));
    expect(copied, contains('no vehicle is assigned'));
    // 19B se resuelve EN EL MOMENTO: el estado que viaja al mostrador es el
    // que se leyó DESPUÉS del rechazo, no el que la pantalla traía de antes.
    expect(copied, contains('CHECKED_OUT'),
        reason: 'sin la verificación de 19B el reporte llevaría el CONFIRMED '
            'rancio, que es justo el dato que el mostrador va a usar');
    expect(copied, isNot(contains('CONFIRMED')));
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
    // Sin hora literal: `toLocal()` depende de la zona de la máquina y esta
    // suite no puede afirmar el reloj del CI.
    expect(
      find.textContaining('Recorded on the reservation · '),
      findsOneWidget,
      reason: 'solo porque Reservation.status lo dice, y con la hora del '
          'servidor (finishedAt)',
    );
    // La fila ancla: el hecho que el 200 SÍ prueba, con su hora.
    expect(find.text('Session'), findsOneWidget);
    expect(find.textContaining('Closed '), findsOneWidget);
    // El pie de alcance es incondicional y NO promete el contrato.
    expect(
      find.textContaining('stored in the inspection record'),
      findsOneWidget,
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
      '19C → 19A: la consulta descubre el cierre y AUN ASÍ pasa por '
      '"comprobando" — la regla vale en las DOS puertas, no solo en close()',
      (tester) async {
    api.current = signedSession();
    await pumpSign(tester);
    api.onTransition = (_) async =>
        throw apiError(ApiErrorKind.network, message: '');
    await tester.tap(find.text('Close the handover'));
    await tester.pumpAndSettle();
    expect(find.text('Check the status'), findsOneWidget);

    // El servidor sí había cerrado, y la reserva confirma la entrega. La
    // sesión trae `finishedAt` porque el backend lo sella al entrar en
    // terminal (checkout-session.service.js:412-414): una sesión cerrada de
    // verdad siempre lo tiene.
    api.current = CheckoutSessionDto.fromJson({
      ...rawCheckoutSession(),
      'currentStep': 'CLOSED',
      'inspectionCompletedAt': inspectionDone.toIso8601String(),
      'customerSignedAt': inspectionDone.toIso8601String(),
      'finishedAt': DateTime.utc(2026, 8, 17, 17, 4).toIso8601String(),
    });
    api.onGet = () async => api.current!;
    reservations.patchDisplayData = (raw) {
      (raw['reservation'] as Map<String, dynamic>)['status'] = 'CHECKED_OUT';
      return raw;
    };
    // La comprobación se retiene en vuelo: este es el frame que se está
    // fijando. Sin él, este camino podía saltar directo a "Registrada" —
    // afirmar un resultado antes de que vuelva la llamada que lo produce, que
    // es exactamente el pecado que esta historia existe para impedir.
    final gate = Completer<void>();
    reservations.displayGate = gate;

    await tester.tap(find.text('Check the status'));
    await tester.pump();
    await tester.pump();

    expect(find.text('Checkout closed'), findsOneWidget);
    expect(find.text('Handover closed'), findsNothing,
        reason: 'todavía no se ha preguntado nada');
    await tester.drag(find.byType(Scrollable).first, const Offset(0, -260));
    await tester.pump();
    expect(find.text('Checking on the reservation…'), findsOneWidget);
    expect(find.text('Not confirmed'), findsNothing);
    expect(
      find.textContaining('Recorded on the reservation'),
      findsNothing,
      reason: 'el renglón no se adelanta al 200 tampoco por esta puerta',
    );

    gate.complete();
    reservations.displayGate = null;
    await tester.pumpAndSettle();
    // De vuelta arriba: el arrastre anterior dejó el héroe fuera de la
    // ventana y el ListView ya no lo construye.
    await tester.drag(find.byType(Scrollable).first, const Offset(0, 400));
    await tester.pumpAndSettle();
    expect(find.text('Handover closed'), findsOneWidget);
    await scrollBody(tester, find.text('Record'));
    expect(find.textContaining('Recorded on the reservation'), findsOneWidget);
    expect(find.text('Checking on the reservation…'), findsNothing);
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


  // ── 19A-bis · las tres variantes de la comprobación ──────────────────────

  /// Cierra la entrega dejando la sesión en CLOSED con su `finishedAt`, que es
  /// el fixture con el que 19A/19A-bis se alcanzan de verdad.
  void closeSucceeds() {
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
  }

  testWidgets(
      '19A-bis (a): con la comprobación EN VUELO la fila dice "comprobando" — '
      'ningún renglón afirma un resultado antes de que vuelva la llamada que '
      'lo produce', (tester) async {
    api.current = signedSession();
    closeSucceeds();
    await pumpSign(tester);
    // La consulta a display-data se queda retenida: este es el frame que el
    // build no podía ni expresar (fijaba el veredicto ANTES del await).
    final gate = Completer<void>();
    reservations.displayGate = gate;

    await tester.tap(find.text('Close the handover'));
    await tester.pump();
    await tester.pump();

    expect(find.text('Checkout closed'), findsOneWidget,
        reason: 'el título no afirma la ENTREGA mientras se pregunta');
    expect(find.text('Handover closed'), findsNothing);
    // Con el spinner en línea vivo, `pumpAndSettle` no termina nunca: el
    // scroll se hace a mano, que además es el instante exacto del frame.
    await tester.drag(find.byType(Scrollable).first, const Offset(0, -260));
    await tester.pump();
    expect(find.text('Checking'), findsOneWidget, reason: 'pastilla');
    expect(find.text('Checking on the reservation…'), findsOneWidget);
    // Lo que NO se dice: el fallo que todavía no ocurrió.
    expect(find.text('Not confirmed'), findsNothing);
    expect(
      find.textContaining("couldn't confirm it on the reservation"),
      findsNothing,
      reason: 'una falsa alarma en el camino feliz enseña a ignorar la real',
    );
    // Nada bloquea: el agente puede salir y el pie lo dice.
    expect(find.textContaining('Nothing is blocked'), findsOneWidget);

    gate.complete();
    reservations.displayGate = null;
    await tester.pumpAndSettle();
    expect(find.text('Checking on the reservation…'), findsNothing);
  });

  testWidgets(
      '19A-bis (b): la comprobación no responde ⇒ la escalada ocurre en los '
      'CUATRO sitios a la vez, y ninguno es solo color', (tester) async {
    api.current = signedSession();
    closeSucceeds();
    // display-data caído: "no lo sé", que NO es "no quedó registrada".
    reservations.patchDisplayData = (raw) {
      (raw['reservation'] as Map<String, dynamic>)['status'] = 'QUE_ES_ESTO';
      return raw;
    };
    await pumpSign(tester);
    await tester.tap(find.text('Close the handover'));
    await tester.pumpAndSettle();

    // (1) el título pierde la palabra "Entrega".
    expect(find.text('Checkout closed'), findsOneWidget);
    expect(find.text('Handover closed'), findsNothing);
    // (2) el banner ámbar, que no existe en las otras dos variantes.
    expect(
      find.textContaining("couldn't confirm it on the reservation"),
      findsOneWidget,
    );
    // Y lo que el banner NO dice: la línea de llaves es de 19B, donde hay un
    // rechazo real. Aquí solo hay ignorancia.
    expect(find.textContaining("Don't hand over the keys"), findsNothing);
    // (3) la tarjeta Registro en tono warn, con su pastilla y su fila — la
    // palabra porta el estado, no el color (se afirma sobre el objeto real).
    await scrollBody(tester, find.text('Record'));
    final card = tester.widget<VerifyCard>(
      find.ancestor(of: find.text('Record'), matching: find.byType(VerifyCard)),
    );
    expect(card.tone, VerifyTone.warn);
    expect(card.pillLabel, 'Not confirmed');
    expect(find.text('Not confirmed'), findsNWidgets(2),
        reason: 'la pastilla y la fila lo dicen las dos con palabras');
    // (4) el dock cambia de acción principal.
    await scrollBody(tester, find.text('Check again'));
    expect(find.text('Check again'), findsOneWidget);
    expect(find.textContaining('not a retry of the close'), findsOneWidget);
    expect(
      logger.events.where((e) => e.$1 == 'checkout.close_ok').single.$2,
      {'handover': 'unverified'},
    );
  });

  testWidgets(
      '19A-bis (c): la reserva RESPONDE y sigue en CONFIRMED ⇒ se pinta 19B, '
      'no el ámbar — un negativo conocido no se suaviza', (tester) async {
    api.current = signedSession();
    closeSucceeds();
    // El fixture ya trae CONFIRMED: la cascada se tragó su error.
    await pumpSign(tester);
    await tester.tap(find.text('Close the handover'));
    await tester.pumpAndSettle();

    expect(
      find.textContaining('was not marked as handed over'),
      findsOneWidget,
      reason: '19B, que ya tiene botones y la instrucción de las llaves',
    );
    expect(find.text('Check again'), findsNothing);
    expect(
      find.textContaining("couldn't confirm it on the reservation"),
      findsNothing,
    );
    expect(find.text('Copy the details for the counter'), findsOneWidget);
    expect(find.textContaining("Don't hand over the keys"), findsOneWidget);
  });

  testWidgets(
      '19A-bis (d): "Volver a comprobar" es una CONSULTA — cero transiciones, '
      'y el bucle se cierra en esta pantalla', (tester) async {
    api.current = signedSession();
    closeSucceeds();
    reservations.patchDisplayData = (raw) {
      (raw['reservation'] as Map<String, dynamic>)['status'] = 'QUE_ES_ESTO';
      return raw;
    };
    await pumpSign(tester);
    await tester.tap(find.text('Close the handover'));
    await tester.pumpAndSettle();
    await scrollBody(tester, find.text('Check again'));

    final transitionsBefore = api.transitions.length;
    final displayBefore = reservations.displayDataCalls;
    // `transitions` solo prueba que no salió el POST — y eso ya lo impide el
    // guard de terminal del wizard, que es OTRA clase. Lo que fija la
    // inocencia de `recheck()` es que no tocó la API del checkout EN ABSOLUTO:
    // ni un GET de sesión, ni un refresh encubierto.
    final getsBefore = api.getCalls;
    // Esta vez la reserva sí confirma.
    reservations.patchDisplayData = (raw) {
      (raw['reservation'] as Map<String, dynamic>)['status'] = 'CHECKED_OUT';
      return raw;
    };
    await tester.tap(find.text('Check again'));
    await tester.pumpAndSettle();

    expect(api.transitions.length, transitionsBefore,
        reason: 'desde terminal canTransition es false: reintentar el cierre '
            'daría 409 ILLEGAL_TRANSITION para siempre');
    expect(api.getCalls, getsBefore,
        reason: 'recheck no re-lee la sesión: la sesión ya es terminal y lo '
            'que se consulta es la RESERVA');
    expect(reservations.displayDataCalls, displayBefore + 1,
        reason: 'exactamente una consulta, no un barrido');
    // unverified → verifying → recorded, cerrado aquí mismo.
    expect(find.text('Handover closed'), findsOneWidget);
    expect(
      find.textContaining("couldn't confirm it on the reservation"),
      findsNothing,
    );
    expect(
      logger.events
          .where((e) => e.$1 == 'checkout.handover_recheck')
          .single
          .$2,
      {'result': 'recorded'},
    );
    expect(
      logger.events.where((e) => e.$1 == 'checkout.close_ok').length,
      1,
      reason: 'el re-chequeo no es un cierre nuevo: no vuelve a contarse',
    );
  });

  testWidgets(
      '19A-bis (e): sin fecha de regreso, "Antes de que se vaya" conserva DOS '
      'renglones — el pie de alcance es incondicional', (tester) async {
    api.current = signedSession();
    closeSucceeds();
    reservations.patchDisplayData = (raw) {
      final reservation = raw['reservation'] as Map<String, dynamic>;
      reservation['status'] = 'CHECKED_OUT';
      reservation['returnAt'] = null;
      return raw;
    };
    await pumpSign(tester);
    await tester.tap(find.text('Close the handover'));
    await tester.pumpAndSettle();

    expect(find.text('Before they leave'), findsOneWidget);
    expect(find.text('Return'), findsNothing, reason: 'sin fecha no hay fila');
    expect(
      find.text('Hand over the keys and the registration card'),
      findsOneWidget,
    );
    // El segundo renglón, que además dice algo que el agente no sabía. Y NO
    // afirma el contrato: la copia es best-effort dentro de un catch
    // (checkout-session.service.js:551-557, :562).
    expect(
      find.text(
        'The departure fuel level and odometer are stored in the inspection '
        'record, not on this screen.',
      ),
      findsOneWidget,
    );
    expect(find.textContaining('must come back the same'), findsNothing);
    expect(find.textContaining('on the agreement'), findsNothing);
  });

  testWidgets(
      'MUST-1: salir mientras "Volver a comprobar" está en vuelo NO lanza — '
      'la pantalla invita a irse y el provider es autoDispose', (tester) async {
    api.current = signedSession();
    closeSucceeds();
    reservations.patchDisplayData = (raw) {
      (raw['reservation'] as Map<String, dynamic>)['status'] = 'QUE_ES_ESTO';
      return raw;
    };
    await pumpSign(tester);
    await tester.tap(find.text('Close the handover'));
    await tester.pumpAndSettle();
    await scrollBody(tester, find.text('Check again'));

    // La consulta se queda en vuelo y el agente hace lo que la propia
    // pantalla le ofrece: irse. El secundario dice "Volver al inicio" y el
    // pie promete que nada bloquea.
    final gate = Completer<void>();
    reservations.displayGate = gate;
    await tester.tap(find.text('Check again'));
    await tester.pump();
    await tester.tap(find.text('Back to home'));
    await tester.pumpAndSettle();
    expect(find.text('home'), findsOneWidget);

    // Al aterrizar la respuesta, el controller ya murió: sin la guarda de
    // `ref.mounted`, el `ref.read(eventLoggerProvider)` de la telemetría
    // lanza UnmountedRefException. La telemetría no vale una excepción.
    gate.complete();
    reservations.displayGate = null;
    await tester.pumpAndSettle();
    expect(tester.takeException(), isNull);
  });

  // ── INN-MC-1 · el gemelo de 422 del rechazo post-commit ──────────────────

  testWidgets(
      'INN-MC-1: el finalize rechazado con 422 DESPUÉS de comprometer CLOSED '
      'se reconcilia — sin puerta falsa de reintento y con el motivo intacto',
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
      // La fila ya quedó CLOSED (service:417) y el gate del finalize revienta
      // DESPUÉS, con 422 (service:473 → :81-98). NO es un 409: el camino de
      // `_resolveConflict` no lo toca, y sin re-lectura la app se queda
      // creyendo que sigue en FINALIZING.
      api.current = closedSession();
      throw apiError(
        ApiErrorKind.badRequest,
        status: 422,
        message: 'Pre-check-in must be completed before check-out can start '
            'at this location.',
        code: 'PRECHECKIN_REQUIRED',
      );
    };

    final getsBefore = api.getCalls;
    await tester.tap(find.text('Close the handover'));
    await tester.pumpAndSettle();

    // 19B, no la vista terminal genérica ni el CTA reintentable.
    expect(find.byType(CheckoutCloseOutcomeView), findsOneWidget);
    expect(find.text('Retry closing'), findsNothing,
        reason: 'desde terminal ese botón sería un 409 eterno');
    expect(find.byType(CheckoutTerminalView), findsNothing);
    // El motivo del servidor SOBREVIVE a la re-lectura y se puede citar.
    expect(
      find.text('Pre-check-in must be completed before check-out can start '
          'at this location.'),
      findsOneWidget,
    );
    expect(
      logger.events.where((e) => e.$1 == 'checkout.close_failed').single.$2,
      {'leg': 'closing', 'code': 'PRECHECKIN_REQUIRED', 'terminal': true},
      reason: 'terminal:true solo es cierto porque se volvió a leer',
    );
    // La prueba dura de que SE VOLVIÓ A LEER: el 422 disparó un GET extra.
    // (No se afirma `checkout.reconciled`: el events log atribuye el CLOSED a
    // ESTE usuario, y un movimiento propio no es una reconciliación — el tag
    // `via: rejected` existe para el re-fetch que sí descubre un avance ajeno.)
    expect(api.getCalls, greaterThan(getsBefore),
        reason: 'sin la re-lectura, `terminal` se calcula sobre un estado '
            'obsoleto y la app ofrece un reintento imposible');

    await tester.tap(find.text('Copy the details for the counter'));
    await tester.pumpAndSettle();
    expect(copied, contains('PRECHECKIN_REQUIRED'));
    expect(copied, contains('Pre-check-in must be completed'));
  });

  // ── GD-MC-3 · el detalle no es una puerta de un solo sentido ─────────────

  testWidgets(
      'GD-MC-3: desde el detalle se VUELVE al resumen — el motivo no sobrevive '
      'al re-fetch y "Copiar el detalle" solo vive ahí', (tester) async {
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
        message: 'Vehicle U-112 is taken by another open rental (R-2466).',
        code: 'VEHICLE_CONFLICT',
      );
    };
    await tester.tap(find.text('Close the handover'));
    await tester.pumpAndSettle();

    await scrollBody(tester, find.text('See session detail'));
    await tester.tap(find.text('See session detail'));
    await tester.pumpAndSettle();
    expect(find.byType(CheckoutTerminalView), findsOneWidget);
    expect(find.text('Copy the details for the counter'), findsNothing);

    // La salida explícita del propio detalle.
    await scrollBody(tester, find.text('Back to the closing summary'));
    await tester.tap(find.text('Back to the closing summary'));
    await tester.pumpAndSettle();
    expect(find.byType(CheckoutCloseOutcomeView), findsOneWidget);
    expect(find.text('Copy the details for the counter'), findsOneWidget);
    expect(
      find.text('Vehicle U-112 is taken by another open rental (R-2466).'),
      findsOneWidget,
      reason: 'el motivo sigue en pantalla: nunca se re-consultó por él',
    );

    // Y el back del SISTEMA hace lo mismo, no saca del checkout.
    await tester.tap(find.text('See session detail'));
    await tester.pumpAndSettle();
    expect(find.byType(CheckoutTerminalView), findsOneWidget);
    await systemBack(tester);
    await tester.pumpAndSettle();
    expect(find.byType(CheckoutCloseOutcomeView), findsOneWidget);
    expect(find.text('home'), findsNothing, reason: 'no se salió del checkout');
  });

  testWidgets(
      '11E intacto: la sesión que ya estaba cerrada al entrar NO ofrece volver '
      'a un resumen que nunca existió', (tester) async {
    api.current = closedSession();
    await pumpSign(tester);

    expect(find.byType(CheckoutTerminalView), findsOneWidget);
    expect(find.text('Back to the closing summary'), findsNothing);
  });

  // ── INN-S-1 · la tinta retenida ──────────────────────────────────────────

  testWidgets(
      'INN-S-1: si la firma murió por red, la vuelta ofrece REINTENTAR con el '
      'trazo que el cliente ya dio — no volver a pedírselo', (tester) async {
    api.current = unsignedSession();
    await pumpSign(tester);
    await tester.tap(find.text('Hand to the customer'));
    await tester.pumpAndSettle();

    // La pata 1 muere sin respuesta: el trazo se retiene en memoria.
    api.onSaveCustomerSignature =
        (_, _) async => throw apiError(ApiErrorKind.network, message: '');
    await signOnPad(tester);
    expect(find.text('Check the status'), findsOneWidget, reason: '19C');

    // La consulta encuentra la sesión igual: sigue sin firmar.
    api.onGet = () async => api.current!;
    await tester.tap(find.text('Check the status'));
    await tester.pumpAndSettle();

    // Antes de esto, el único CTA era "Entregar al cliente": se le pedía la
    // firma otra vez y el trazo guardado se descartaba en silencio.
    expect(find.text('Retry with the signature they gave'), findsOneWidget);
    expect(
      find.textContaining('The customer already signed on this phone'),
      findsOneWidget,
    );
    // Volver a pedirla sigue existiendo, en secundario.
    expect(find.text('Hand to the customer'), findsOneWidget);

    // Y el reintento manda el MISMO trazo, sin abrir el kiosco.
    final calls = <String>[];
    api.onSaveCustomerSignature = (dataUrl, _) async {
      calls.add(dataUrl);
      api.current = signedSession();
      return api.current!;
    };
    api.onTransition = (toStep) async {
      api.current = sessionAt(
        CheckoutStep.tryParse(toStep)!,
        inspection: inspectionDone,
        signature: inspectionDone,
      );
      return api.current!;
    };
    await tester.tap(find.text('Retry with the signature they gave'));
    await tester.pumpAndSettle();

    expect(find.byType(KioskSignatureStep), findsNothing,
        reason: 'no se le vuelve a pedir el teléfono al cliente');
    expect(calls.single, startsWith('data:image/png;base64,'));
    expect(api.transitions, ['FINALIZING', 'CLOSED']);
  });

  // ── GD-MC-5 · el CTA muerto con el why que lo contradecía ────────────────

  testWidgets(
      'GD-MC-5: en el tramo reintentable SIN red el pie dice la causa real, no '
      '"se puede volver a intentar"', (tester) async {
    api.current = signedSession();
    await pumpSign(tester);
    api.onTransition = (_) async => throw apiError(
          ApiErrorKind.badRequest,
          status: 400,
          message: 'Nope.',
          code: 'SOMETHING',
        );
    await tester.tap(find.text('Close the handover'));
    await tester.pumpAndSettle();
    expect(find.text('Retry closing'), findsOneWidget);
    expect(find.textContaining('This leg can be retried'), findsOneWidget);

    // Se cae la red con el fallo reintentable en pantalla.
    network.online = false;
    api.onGet = () async => throw apiError(ApiErrorKind.network, message: '');
    await tester.pump(const Duration(seconds: 6));
    await tester.pumpAndSettle();

    final cta = tester.widget<RidePrimaryButton>(
      find.widgetWithText(RidePrimaryButton, 'Retry closing'),
    );
    expect(cta.onPressed, isNull);
    expect(find.textContaining('This leg can be retried'), findsNothing,
        reason: 'el pie no puede prometer lo que el botón no puede cumplir');
    expect(
      find.textContaining("needs the server's confirmation"),
      findsOneWidget,
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
