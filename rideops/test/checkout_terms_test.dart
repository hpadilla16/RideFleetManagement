import 'dart:io';

import 'package:clock/clock.dart';
import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:rideops/core/api/api_error.dart';
import 'package:rideops/core/api/api_providers.dart';
import 'package:rideops/core/api/enums.dart';
import 'package:rideops/core/config/app_config.dart';
import 'package:rideops/core/device/presentation_mode.dart';
import 'package:rideops/core/l10n/app_localizations.dart';
import 'package:rideops/core/outbox/network_status.dart';
import 'package:rideops/core/router/app_router.dart';
import 'package:rideops/core/session/active_location.dart';
import 'package:rideops/core/session/lock_controller.dart';
import 'package:rideops/core/session/session_controller.dart';
import 'package:rideops/core/session/session_state.dart';
import 'package:rideops/core/telemetry/event_logger.dart';
import 'package:rideops/core/widgets/ride_buttons.dart';
import 'package:rideops/features/checkout/presentation/checkout_wizard_screen.dart';
import 'package:rideops/features/checkout/presentation/present_mode_screen.dart';
import 'package:rideops/features/checkout/presentation/steps/terms_step.dart';
import 'package:rideops/features/checkout/presentation/widgets/qr_view.dart';
import 'package:rideops/features/checkout/presentation/widgets/wizard_dock.dart';

import 'helpers/auth_test_helpers.dart';
import 'helpers/checkout_test_helpers.dart';
import 'helpers/outbox_test_helpers.dart';
import 'helpers/shell_test_helpers.dart';

/// Paso T&C (mockup 10A-10D) + modo presentación. Locale `en`, como el resto
/// de la suite.

/// Geometría REAL del código pintado: lado del símbolo (lo que se escanea) y
/// lado del módulo. El contenedor mide `símbolo + 8 · módulo`, así que el
/// módulo se despeja de la diferencia — y así la prueba fija el SÍMBOLO, que es
/// lo que el mockup aprueba, sin depender de cuántos módulos salga la URL.
({double symbol, double module}) qrGeometry(WidgetTester tester) {
  final total = tester.getSize(find.byType(QrView)).width;
  final paint = tester.widget<CustomPaint>(
    find.descendant(
      of: find.byType(QrView),
      matching: find.byType(CustomPaint),
    ),
  );
  return (symbol: paint.size.width, module: (total - paint.size.width) / 8);
}

void main() {
  final liveToken = fakeJwt(
    exp: DateTime.now().add(const Duration(hours: 8)),
    sub: kMyUserId,
  );

  ({
    FakeCheckoutApi api,
    FakeReservationsApi reservations,
    FakeNetworkStatus network,
    CapturingEventLogger logger,
  }) fakes() => (
        api: FakeCheckoutApi()..current = sessionAt(CheckoutStep.tcPending),
        reservations: FakeReservationsApi(),
        network: FakeNetworkStatus(online: true),
        logger: CapturingEventLogger(),
      );

  /// Candado y pantalla del modo presentación: SIEMPRE stubs. El real leería
  /// Keystore y el de pantalla hablaría con dos plugins que en un widget test
  /// no existen — y lo que se está probando es el PAR entrar/salir, no el
  /// plugin.
  late StubLockController lock;

  Future<void> pumpTerms(
    WidgetTester tester, {
    required FakeCheckoutApi api,
    required FakeReservationsApi reservations,
    required FakeNetworkStatus network,
    required CapturingEventLogger logger,
    NoopPresentationScreen? presentationScreen,
  }) async {
    lock = StubLockController();
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
          lockControllerProvider.overrideWith(() => lock),
          presentationScreenProvider.overrideWithValue(
            presentationScreen ?? NoopPresentationScreen(),
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
  }

  /// El cuerpo del paso es un scroll y el lienzo del test mide 600 px: el QR
  /// empuja el banner de espera y los avisos de re-emisión bajo la línea de
  /// flotación, igual que en un teléfono real.
  Future<void> scrollBody(WidgetTester tester, Finder target) async {
    await tester.scrollUntilVisible(
      target,
      120,
      scrollable: find.byType(Scrollable).first,
    );
    await tester.pumpAndSettle();
  }

  testWidgets('10A — al entrar al paso se mintea el código y se muestra el QR '
      'con su countdown; la espera es honesta, sin spinner infinito',
      (tester) async {
    final f = fakes();
    await pumpTerms(
      tester,
      api: f.api,
      reservations: f.reservations,
      network: f.network,
      logger: f.logger,
    );

    expect(f.api.termsTokenCalls, 1, reason: 'mint al entrar (service:708-712)');
    expect(find.byType(QrView), findsOneWidget);
    expect(find.textContaining('scan it with their phone camera'), findsOneWidget);
    expect(find.text('Expires in'), findsOneWidget);
    await scrollBody(tester, find.textContaining('updates itself'));
    expect(find.textContaining('updates itself'), findsOneWidget);
    expect(find.byType(CircularProgressIndicator), findsNothing);
    // El QR codifica la URL de la app WEB, no la de la API.
    final qr = tester.widget<QrView>(find.byType(QrView));
    expect(qr.data, AppConfig.current.signUrl('tok_terms_fixture_0001'));
    expect(qr.dead, isFalse);
    expect(
      f.logger.events
          .where((e) => e.$1 == 'checkout.terms_token_minted')
          .single
          .$2['reused'],
      false,
    );
  });

  testWidgets('10A — el countdown corre en mm:ss y pasa a ámbar EXACTAMENTE '
      'en la ventana de re-minteo del backend (2 min)', (tester) async {
    final f = fakes();
    // Reloj controlado: el token vence 2 min y 3 s después de "ahora".
    final start = DateTime.utc(2026, 8, 17, 9, 44);
    await withClock(Clock.fixed(start), () async {
      f.api.onMintTermsToken = () async => termsToken(
            ttl: const Duration(minutes: 2, seconds: 3),
          );
      await pumpTerms(
        tester,
        api: f.api,
        reservations: f.reservations,
        network: f.network,
        logger: f.logger,
      );
      expect(find.text('02:03'), findsOneWidget);
      // El pill NO es ámbar todavía: por encima de 2 min el backend reusa.
      expect(find.text('Expires in'), findsOneWidget);
    });

    // +4 s: cruzamos el piso de 2 min. El tick de 1 Hz lo refleja solo.
    await withClock(Clock.fixed(start.add(const Duration(seconds: 4))), () async {
      await tester.pump(const Duration(seconds: 1));
      expect(find.text('01:59'), findsOneWidget);
    });
  });

  testWidgets('re-emisión honesta: cuando el backend REUSA, la copy lo dice '
      '("sigue siendo el mismo código") en vez de fingir una emisión',
      (tester) async {
    final f = fakes();
    await pumpTerms(
      tester,
      api: f.api,
      reservations: f.reservations,
      network: f.network,
      logger: f.logger,
    );

    // El mint idempotente devuelve el MISMO token con reused: true.
    f.api.onMintTermsToken = () async => termsToken(reused: true);
    await tester.tap(find.text('Generate a new code'));
    await tester.pumpAndSettle();

    await scrollBody(tester, find.textContaining('still the same code'));
    expect(find.textContaining('still the same code'), findsOneWidget);
    expect(find.textContaining('New code ready'), findsNothing);
    expect(
      f.logger.events
          .where((e) => e.$1 == 'checkout.terms_token_minted')
          .last
          .$2['reused'],
      true,
    );
  });

  testWidgets('re-emisión que SÍ emite: el QR cambia y la copy avisa que el '
      'anterior dejó de servir', (tester) async {
    final f = fakes();
    await pumpTerms(
      tester,
      api: f.api,
      reservations: f.reservations,
      network: f.network,
      logger: f.logger,
    );
    final before = tester.widget<QrView>(find.byType(QrView)).data;

    f.api.onMintTermsToken = () async => termsToken(token: 'tok_nuevo_0002');
    await tester.tap(find.text('Generate a new code'));
    await tester.pumpAndSettle();

    await scrollBody(tester, find.textContaining('New code ready'));
    expect(find.textContaining('New code ready'), findsOneWidget);
    expect(tester.widget<QrView>(find.byType(QrView)).data, isNot(before));
  });

  testWidgets('10D — vencido: el QR queda inerte, el estado se dice con '
      'palabras y la re-emisión sube a primario', (tester) async {
    final f = fakes();
    final start = DateTime.utc(2026, 8, 17, 9, 59);
    await withClock(Clock.fixed(start), () async {
      f.api.onMintTermsToken =
          () async => termsToken(ttl: const Duration(seconds: 2));
      await pumpTerms(
        tester,
        api: f.api,
        reservations: f.reservations,
        network: f.network,
        logger: f.logger,
      );
    });

    await withClock(Clock.fixed(start.add(const Duration(seconds: 5))), () async {
      await tester.pump(const Duration(seconds: 1));

      expect(find.text('Expired'), findsWidgets);
      expect(find.text('00:00'), findsOneWidget);
      expect(find.text('Code expired'), findsOneWidget);
      expect(find.textContaining('Nothing was lost'), findsOneWidget);
      // El QR se atenúa pero YA NO es portador de información.
      expect(tester.widget<QrView>(find.byType(QrView)).dead, isTrue);
      // Y la acción sube a primario.
      expect(
        find.widgetWithText(RidePrimaryButton, 'Generate a new code'),
        findsOneWidget,
      );
      // No se ofrece presentar un código muerto.
      expect(find.text('Show to customer (full screen)'), findsNothing);
      expect(
        f.logger.events.where((e) => e.$1 == 'checkout.terms_token_expired'),
        hasLength(1),
        reason: 'una vez por token, no una por tick',
      );
    });
  });

  testWidgets('10C — la firma llega POR POLL: el CTA aparece porque el sello '
      'existe, no porque un timer lo decidiera', (tester) async {
    final f = fakes();
    await pumpTerms(
      tester,
      api: f.api,
      reservations: f.reservations,
      network: f.network,
      logger: f.logger,
    );
    expect(find.text('Continue to payment'), findsNothing);

    // El cliente firma en su teléfono; el flujo público estampa tcCompletedAt
    // y el poll de 5 s del wizard lo trae.
    f.api.current = sessionAt(
      CheckoutStep.tcPending,
      tc: DateTime.now().subtract(const Duration(seconds: 30)),
    );
    await tester.pump(const Duration(seconds: 5));
    await tester.pumpAndSettle();

    expect(find.text('Terms signed'), findsOneWidget);
    expect(find.textContaining('María González signed at'), findsOneWidget);
    expect(find.text('Confirmed by the server'), findsOneWidget);
    expect(find.byType(QrView), findsNothing, reason: 'el QR ya no sirve');
    final cta = tester.widget<RidePrimaryButton>(
      find.widgetWithText(RidePrimaryButton, 'Continue to payment'),
    );
    expect(cta.onPressed, isNotNull);
    expect(
      find.textContaining('only exists because the server already has'),
      findsOneWidget,
    );
    expect(
      f.logger.events.where((e) => e.$1 == 'checkout.terms_signed_seen'),
      hasLength(1),
    );
  });

  testWidgets('10C — el CTA transiciona a TC_SIGNED (el guard del backend '
      'exige el sello, y el sello ya está)', (tester) async {
    final f = fakes();
    f.api.current = sessionAt(CheckoutStep.tcPending, tc: DateTime.now());
    await pumpTerms(
      tester,
      api: f.api,
      reservations: f.reservations,
      network: f.network,
      logger: f.logger,
    );

    await tester.tap(find.text('Continue to payment'));
    await tester.pumpAndSettle();
    expect(f.api.transitions, ['TC_SIGNED']);
  });

  testWidgets('10C — el anexo del seguro se refleja en el registro cuando el '
      'cliente declinó', (tester) async {
    final f = fakes();
    final raw = rawCheckoutSession();
    raw['currentStep'] = CheckoutStep.tcPending.wire;
    raw['tcCompletedAt'] = DateTime.utc(2026, 8, 17, 9, 47).toIso8601String();
    raw['events'] =
        '[{"kind":"DECLINED_INSURANCE","declined":true,"actorUserId":"$kMyUserId"}]';
    f.api.current = sessionFromRaw(raw);
    await pumpTerms(
      tester,
      api: f.api,
      reservations: f.reservations,
      network: f.network,
      logger: f.logger,
    );

    expect(find.text('Coverage-decline addendum'), findsOneWidget);
    expect(find.text('None (insurance accepted)'), findsNothing);
  });

  testWidgets('sin red no se finge un QR: se dice quién emite el código y no '
      'se manda nada (ADR-5: ningún paso se encola)', (tester) async {
    final f = fakes();
    f.api.onMintTermsToken = () async =>
        throw ApiError(kind: ApiErrorKind.network, message: 'sin red');
    await pumpTerms(
      tester,
      api: f.api,
      reservations: f.reservations,
      network: f.network,
      logger: f.logger,
    );

    expect(find.byType(QrView), findsNothing);
    expect(find.textContaining('server issues the code'), findsWidgets);
    expect(find.text('Retry'), findsOneWidget);
  });

  testWidgets('el mint que falla con mensaje del servidor lo muestra tal cual '
      'y deja reintentar', (tester) async {
    final f = fakes();
    f.api.onMintTermsToken = () async => throw ApiError(
          kind: ApiErrorKind.forbidden,
          status: 403,
          message: 'You do not have access to that location.',
        );
    await pumpTerms(
      tester,
      api: f.api,
      reservations: f.reservations,
      network: f.network,
      logger: f.logger,
    );

    expect(find.text('You do not have access to that location.'), findsOneWidget);
    final calls = f.api.termsTokenCalls;
    await scrollBody(tester, find.text('Retry'));
    await tester.tap(find.text('Retry'));
    await tester.pumpAndSettle();
    expect(f.api.termsTokenCalls, greaterThan(calls));
  });

  group('10B — modo presentación (volteado al cliente)', () {
    Future<void> openPresentation(WidgetTester tester) async {
      await scrollBody(tester, find.text('Show to customer (full screen)'));
      await tester.tap(find.text('Show to customer (full screen)'));
      await tester.pumpAndSettle();
    }

    testWidgets('QR grande, marca del TENANT y CERO marca de plataforma',
        (tester) async {
      final f = fakes();
      await pumpTerms(
        tester,
        api: f.api,
        reservations: f.reservations,
        network: f.network,
        logger: f.logger,
      );
      await openPresentation(tester);

      expect(find.byType(PresentModeScreen), findsOneWidget);
      expect(tester.widget<QrView>(find.byType(QrView)).size, 230);
      // GD-MC-1: `size` describe el SÍMBOLO. Lo que se fija es lo que se
      // escanea, no el cuadro con la quiet zone incluida.
      final geometry = qrGeometry(tester);
      expect(geometry.symbol, lessThanOrEqualTo(230));
      expect(
        geometry.symbol,
        greaterThanOrEqualTo(230 * 0.95),
        reason: 'el símbolo mide lo aprobado (el snap a píxel físico se come '
            'menos del 5%); antes de GD-MC-1 la quiet zone iba POR DENTRO y '
            'el símbolo caía a ~165-185',
      );
      expect(
        tester.getSize(find.byType(QrView)).width,
        closeTo(geometry.symbol + 8 * geometry.module, 0.01),
        reason: 'la quiet zone de 4 módulos crece hacia AFUERA',
      );
      // Marca del tenant, en el idioma del cliente.
      expect(find.text('Autos del Valle'), findsOneWidget);
      expect(find.textContaining('Reservation R-20260816-0042'), findsOneWidget);
      // CERO marca de plataforma (el centinela que el QA del M1 ya cazó).
      expect(find.text('Ride Fleet'), findsNothing);
      expect(find.text('RideOps'), findsNothing);
      expect(find.textContaining('RideOps'), findsNothing);
      // Salida visible.
      expect(find.text('Exit presentation'), findsOneWidget);
      // NO es modo kiosco: sin barra persistente ni salida con PIN.
      expect(find.textContaining('hold 3 s'), findsNothing);
      expect(find.byType(TextField), findsNothing);
      expect(
        f.logger.events.where((e) => e.$1 == 'checkout.present_mode_shown'),
        hasLength(1),
      );
    });

    testWidgets('tenant SIN branding: la barra desaparece entera, sin fallback '
        'a la marca de la plataforma (GD-1)', (tester) async {
      final f = fakes();
      // Exactamente lo que responde el backend sin branding configurado
      // (reservations.routes.js:619).
      f.reservations.patchDisplayData = (raw) {
        raw['branding'] = {
          'companyName': 'Ride Fleet',
          'companyLogoUrl': '',
          'companyPhone': '',
        };
        return raw;
      };
      await pumpTerms(
        tester,
        api: f.api,
        reservations: f.reservations,
        network: f.network,
        logger: f.logger,
      );
      await openPresentation(tester);

      expect(find.text('Ride Fleet'), findsNothing);
      expect(find.text('RF'), findsNothing);
      expect(find.byType(QrView), findsOneWidget,
          reason: 'el trámite sigue: lo que falta es la marca, no el código');
    });

    testWidgets('al cliente NO se le pone un reloj en la cara: sin countdown '
        'salvo bajo 2 min, y ahí con copy tranquilizadora', (tester) async {
      final f = fakes();
      final start = DateTime.utc(2026, 8, 17, 9, 44);
      await withClock(Clock.fixed(start), () async {
        f.api.onMintTermsToken = () async => termsToken(
              ttl: const Duration(minutes: 2, seconds: 2),
            );
        await pumpTerms(
          tester,
          api: f.api,
          reservations: f.reservations,
          network: f.network,
          logger: f.logger,
        );
        await openPresentation(tester);
        // Por encima del umbral: ni countdown ni "vence".
        expect(find.textContaining('left —'), findsNothing);
        expect(find.text('Expires in'), findsNothing);
      });

      await withClock(Clock.fixed(start.add(const Duration(seconds: 5))),
          () async {
        await tester.pump(const Duration(seconds: 1));
        expect(find.textContaining('left —'), findsOneWidget);
        expect(
          find.textContaining('the agent issues another one right away'),
          findsOneWidget,
        );
      });
    });

    testWidgets('la firma llega mientras la pantalla está volteada: el modo se '
        'cierra solo y el agente recupera su estado real', (tester) async {
      final f = fakes();
      await pumpTerms(
        tester,
        api: f.api,
        reservations: f.reservations,
        network: f.network,
        logger: f.logger,
      );
      await openPresentation(tester);
      expect(find.byType(PresentModeScreen), findsOneWidget);

      f.api.current = sessionAt(CheckoutStep.tcPending, tc: DateTime.now());
      await tester.pump(const Duration(seconds: 5));
      await tester.pumpAndSettle();

      expect(find.byType(PresentModeScreen), findsNothing);
      expect(find.text('Terms signed'), findsOneWidget);
    });

    testWidgets('GD-MC-2 + INN-S-3 — al entrar: brillo/wakelock encendidos y '
        'candado de personal SUSPENDIDO; al salir, los dos se deshacen',
        (tester) async {
      final f = fakes();
      final screen = NoopPresentationScreen();
      await pumpTerms(
        tester,
        api: f.api,
        reservations: f.reservations,
        network: f.network,
        logger: f.logger,
        presentationScreen: screen,
      );
      expect(screen.enters, 0);

      await openPresentation(tester);
      expect(screen.enters, 1, reason: 'brillo al máximo + pantalla despierta');
      // El candado de 5 min no puede saltar mientras el cliente lee: el
      // setState de 1 Hz no cuenta como actividad.
      expect(lock.suspends, 1);
      expect(lock.resumes, 0);

      await tester.tap(find.text('Exit presentation'));
      await tester.pumpAndSettle();

      expect(screen.exits, 1, reason: 'restauración simétrica en dispose');
      expect(lock.resumes, 1);
    });

    testWidgets('la restauración también corre cuando el modo se cierra SOLO '
        '(firma recibida), no solo con el botón de salida', (tester) async {
      final f = fakes();
      final screen = NoopPresentationScreen();
      await pumpTerms(
        tester,
        api: f.api,
        reservations: f.reservations,
        network: f.network,
        logger: f.logger,
        presentationScreen: screen,
      );
      await openPresentation(tester);

      f.api.current = sessionAt(CheckoutStep.tcPending, tc: DateTime.now());
      await tester.pump(const Duration(seconds: 5));
      await tester.pumpAndSettle();

      expect(find.byType(PresentModeScreen), findsNothing);
      expect(screen.exits, 1);
      expect(lock.resumes, 1);
    });

    testWidgets('GD-SC-2 — el QR del cliente lleva marco: bajo reflejo es lo '
        'que le dice dónde apuntar', (tester) async {
      final f = fakes();
      await pumpTerms(
        tester,
        api: f.api,
        reservations: f.reservations,
        network: f.network,
        logger: f.logger,
      );
      await openPresentation(tester);

      expect(
        find.ancestor(of: find.byType(QrView), matching: find.byType(QrFrame)),
        findsOneWidget,
      );
    });

    testWidgets('"Salir de presentación" devuelve al paso con su QR',
        (tester) async {
      final f = fakes();
      await pumpTerms(
        tester,
        api: f.api,
        reservations: f.reservations,
        network: f.network,
        logger: f.logger,
      );
      await openPresentation(tester);

      await tester.tap(find.text('Exit presentation'));
      await tester.pumpAndSettle();

      expect(find.byType(PresentModeScreen), findsNothing);
      expect(find.byType(TermsStep), findsOneWidget);
      expect(f.api.termsTokenCalls, 1, reason: 'salir no re-emite nada');
    });
  });

  testWidgets('GD-SC-3 — el dock de re-emisión NO es un tercer dock hecho a '
      'mano: es el WizardDock común', (tester) async {
    final f = fakes();
    await pumpTerms(
      tester,
      api: f.api,
      reservations: f.reservations,
      network: f.network,
      logger: f.logger,
    );

    expect(
      find.widgetWithText(WizardDock, 'Generate a new code'),
      findsOneWidget,
    );
  });

  testWidgets('GD-MC-1 (10A) — el QR del paso también mide su SÍMBOLO: 184 dp '
      'de código, no 184 con la quiet zone comiéndose 39', (tester) async {
    final f = fakes();
    await pumpTerms(
      tester,
      api: f.api,
      reservations: f.reservations,
      network: f.network,
      logger: f.logger,
    );

    final geometry = qrGeometry(tester);
    expect(geometry.symbol, lessThanOrEqualTo(184));
    expect(geometry.symbol, greaterThanOrEqualTo(184 * 0.95));
  });

  testWidgets('GD-SC-8 / INN-S-4 — el lector de pantalla NO dicta el token: la '
      'etiqueta del QR es copy traducida', (tester) async {
    final handle = tester.ensureSemantics();
    final f = fakes();
    await pumpTerms(
      tester,
      api: f.api,
      reservations: f.reservations,
      network: f.network,
      logger: f.logger,
    );

    final qr = tester.widget<QrView>(find.byType(QrView));
    expect(qr.semanticsLabel, 'QR code to sign the terms');
    expect(qr.semanticsLabel.contains('tok_terms'), isFalse);
    expect(qr.semanticsLabel.contains('http'), isFalse);
    // Y lo que de verdad se publica al árbol de accesibilidad tampoco.
    final node = tester.getSemantics(find.byType(QrView));
    expect(node.label, contains('QR code to sign the terms'));
    expect(node.label.contains('tok_terms'), isFalse,
        reason: 'el token es una credencial al portador: no se dicta');
    expect(node.label.contains('/sign/'), isFalse);
    handle.dispose();
  });

  group('QrMetrics — la quiet zone va POR FUERA (GD-MC-1)', () {
    // Rango real de versiones para una URL de firma: 29 (v3) a 37 (v5).
    for (final count in [29, 33, 37]) {
      for (final dpr in [1.0, 2.0, 3.0]) {
        test('símbolo $count módulos @ ${dpr}x', () {
          final m = QrMetrics.resolve(
            symbolSide: 230,
            moduleCount: count,
            devicePixelRatio: dpr,
          );
          expect(m.symbol, m.module * count);
          expect(m.total, m.symbol + 8 * m.module,
              reason: 'contenedor = símbolo + 8 módulos de quiet zone');
          expect(m.symbol, lessThanOrEqualTo(230));
          expect(m.symbol, greaterThan(230 - count / dpr),
              reason: 'cada módulo pierde menos de un píxel FÍSICO');
          expect(
            (m.module * dpr - (m.module * dpr).roundToDouble()).abs(),
            lessThan(1e-9),
            reason: 'el módulo cae en píxel físico entero',
          );
        });
      }
    }

    test('un símbolo absurdamente chico nunca produce módulos de 0 dp', () {
      final m = QrMetrics.resolve(
        symbolSide: 4,
        moduleCount: 37,
        devicePixelRatio: 3,
      );
      expect(m.module, greaterThan(0));
      expect(m.total, greaterThan(m.symbol));
    });
  });

  test('CENTINELA (como el del M1): ningún archivo de la superficie volteada '
      'al cliente nombra la plataforma', () {
    for (final path in [
      'lib/features/checkout/presentation/present_mode_screen.dart',
      'lib/features/checkout/presentation/widgets/qr_view.dart',
    ]) {
      // Se permite en COMENTARIOS (documentan justamente la regla); lo que no
      // puede existir es un literal de UI con la marca, así que se leen solo
      // las líneas de código.
      final code = File(path)
          .readAsLinesSync()
          .where((line) => !line.trimLeft().startsWith('//'))
          .join('\n');
      final uiLiterals = RegExp(r"""(['"])(Ride ?Fleet|RideOps)\1""");
      expect(uiLiterals.hasMatch(code), isFalse,
          reason: '$path no puede llevar marca de plataforma en un literal');
    }
    // Y las llaves de l10n de esta superficie tampoco.
    for (final arb in ['lib/core/l10n/app_es.arb', 'lib/core/l10n/app_en.arb']) {
      final source = File(arb).readAsStringSync();
      final presentKeys = RegExp(r'"coPresent[A-Za-z]*": "([^"]*)"')
          .allMatches(source)
          .map((m) => m.group(1)!);
      expect(presentKeys, isNotEmpty);
      for (final value in presentKeys) {
        expect(value.contains('Ride Fleet'), isFalse);
        expect(value.contains('RideOps'), isFalse);
      }
    }
  });
}
