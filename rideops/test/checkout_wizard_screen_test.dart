import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:rideops/core/api/api_error.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:rideops/core/api/api_providers.dart';
import 'package:rideops/core/api/dto/checkout_session.dart';
import 'package:rideops/core/api/enums.dart';
import 'package:rideops/core/l10n/app_localizations.dart';
import 'package:rideops/core/outbox/network_status.dart';
import 'package:rideops/core/router/app_router.dart';
import 'package:rideops/core/session/active_location.dart';
import 'package:rideops/core/session/session_controller.dart';
import 'package:rideops/core/session/session_state.dart';
import 'package:rideops/core/telemetry/event_logger.dart';
import 'package:rideops/core/widgets/ride_buttons.dart';
import 'package:rideops/features/checkout/presentation/checkout_wizard_screen.dart';
import 'package:rideops/features/checkout/presentation/widgets/transition_button.dart';
import 'package:rideops/features/checkout/presentation/widgets/pause_sheet.dart';
import 'package:rideops/features/checkout/presentation/widgets/steps_sheet.dart';
import 'package:rideops/features/checkout/presentation/widgets/wizard_banners.dart';
import 'package:rideops/features/checkout/presentation/widgets/wizard_chrome.dart';
import 'package:rideops/features/checkout/presentation/widgets/wizard_skeleton.dart';

import 'helpers/auth_test_helpers.dart';
import 'helpers/checkout_test_helpers.dart';
import 'helpers/outbox_test_helpers.dart';
import 'helpers/shell_test_helpers.dart';

/// Widget tests del shell del wizard (mockup 8A–8F). Corren en locale `en`
/// (misma convención que el resto de la suite) y se asiertan contra
/// app_en.arb.

void main() {
  final liveToken = fakeJwt(
    exp: DateTime.now().add(const Duration(hours: 8)),
    sub: kMyUserId,
  );

  ({FakeCheckoutApi api, FakeNetworkStatus network}) fakes() =>
      (api: FakeCheckoutApi(), network: FakeNetworkStatus(online: true));

  Future<void> pumpWizard(
    WidgetTester tester, {
    required FakeCheckoutApi api,
    FakeNetworkStatus? network,
    bool settle = true,

    /// Para probar en aislamiento piezas que el shell PROVEE a las historias
    /// siguientes (el CTA de transición) con el mismo cableado real.
    Widget? child,
  }) async {
    final router = GoRouter(
      initialLocation: AppRoutes.checkout(kReservationId),
      routes: [
        GoRoute(
          path: AppRoutes.home,
          builder: (_, _) => const Scaffold(body: Text('home')),
        ),
        GoRoute(
          path: AppRoutes.checkoutPattern,
          builder: (_, state) => child == null
              ? CheckoutWizardScreen(
                  reservationId: state.pathParameters['reservationId']!,
                )
              : Scaffold(body: Center(child: child)),
        ),
      ],
    );
    addTearDown(router.dispose);

    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          checkoutApiProvider.overrideWithValue(api),
          reservationsApiProvider.overrideWithValue(FakeReservationsApi()),
          eventLoggerProvider.overrideWithValue(CapturingEventLogger()),
          networkStatusProvider
              .overrideWithValue(network ?? FakeNetworkStatus(online: true)),
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
    if (settle) {
      await tester.pump(); // microtask del primer fetch
      await tester.pump();
    }
  }

  testWidgets('8F — el primer fetch muestra el skeleton con la geometría del '
      'shell, no un spinner', (tester) async {
    final f = fakes();
    // La respuesta queda colgada: es exactamente el estado 8F.
    f.api.gate = Completer();
    await pumpWizard(tester, api: f.api, network: f.network, settle: false);
    await tester.pump();

    expect(find.byType(WizardSkeleton), findsOneWidget);
    expect(find.byType(PhaseRail), findsNothing);

    // Se libera para no dejar futuros colgando al desmontar.
    f.api.gate!.complete();
    f.api.gate = null;
    await tester.pump();
    await tester.pump();
  });

  testWidgets('8A — wizard en marcha: contador honesto, rail de 5 fases y '
      'chip de presencia', (tester) async {
    final f = fakes();
    f.api.current = sessionAt(
      CheckoutStep.confirming,
      presence: [
        CheckoutPresenceDto(
          surface: 'KIOSK',
          displayName: 'María G.',
          lastSeenAt: DateTime.now().subtract(const Duration(seconds: 8)),
        ),
      ],
    );
    await pumpWizard(tester, api: f.api, network: f.network);

    expect(find.text('Step 1 of 10'), findsOneWidget);
    expect(find.text('Confirm customer and vehicle'), findsOneWidget);
    // Las 5 fases del rail, en su agrupación de presentación.
    for (final phase in ['Confirm', 'T&C', 'Payment', 'Inspection', 'Closing']) {
      expect(find.text(phase), findsOneWidget, reason: phase);
    }
    // Presencia: informativa, con la superficie nombrada.
    expect(find.byType(PresenceChip), findsOneWidget);
    expect(
      find.textContaining('María G. is in this session · kiosk'),
      findsOneWidget,
    );
    // Header completo (8A): la fila del cliente del display-data.
    expect(find.text('María González'), findsOneWidget);
  });

  testWidgets('8A — sin el campo presence (backend sin P1) NO se pinta chip',
      (tester) async {
    final f = fakes();
    f.api.current = sessionAt(CheckoutStep.confirming); // presence ausente
    await pumpWizard(tester, api: f.api, network: f.network);
    expect(find.byType(PresenceChip), findsNothing);
  });

  testWidgets('un currentStep desconocido no rompe la pantalla: nodo genérico '
      'con el nombre crudo y sin contador', (tester) async {
    final f = fakes();
    f.api.current =
        sessionAt(CheckoutStep.confirming, rawStep: 'PASO_DEL_FUTURO');
    await pumpWizard(tester, api: f.api, network: f.network);

    expect(tester.takeException(), isNull);
    expect(
      find.textContaining('Step reported by the server: PASO_DEL_FUTURO'),
      findsOneWidget,
    );
    expect(find.textContaining('Step 1 of 10'), findsNothing);
  });

  testWidgets('8C — avance ajeno: banner NO bloqueante con atribución al '
      'kiosco y auto-avance del stepper', (tester) async {
    final f = fakes();
    await pumpWizard(tester, api: f.api, network: f.network);
    expect(find.text('Step 1 of 10'), findsOneWidget);

    // El kiosco firma T&C y avanza mientras el agente mira.
    f.api.current = sessionAt(
      CheckoutStep.tcPending,
      actorUserId: null,
      kiosk: true,
    );
    await tester.pump(const Duration(seconds: 5));
    await tester.pump();

    expect(find.byType(ForeignAdvanceBanner), findsOneWidget);
    expect(find.textContaining('was completed on the kiosk'), findsOneWidget);
    expect(find.text('See what changed'), findsOneWidget);
    // Auto-avance sin pedir permiso: el stepper ya se movió.
    expect(find.text('Step 2 of 10'), findsOneWidget);
    // Y NO es un modal: la pantalla sigue operable.
    expect(find.byType(Dialog), findsNothing);
  });

  testWidgets('8D — sin red: banner con la edad del dato, stepline "seen X '
      'ago" y ninguna promesa de bandeja', (tester) async {
    final f = fakes();
    await pumpWizard(tester, api: f.api, network: f.network);

    f.api.onGet = () async =>
        throw ApiError(kind: ApiErrorKind.network, message: 'sin red');
    f.network.online = false;
    await tester.pump(const Duration(seconds: 5));
    await tester.pump();

    expect(find.byType(OfflineBanner), findsOneWidget);
    expect(
      find.textContaining('it may have changed on another surface'),
      findsOneWidget,
    );
    expect(find.textContaining('seen'), findsWidgets);
    // El dato viejo se muestra, no se borra.
    expect(find.byType(PhaseRail), findsOneWidget);
  });

  testWidgets('8B — la lista completa: 10 pasos, guards anunciados y la '
      'salida alterna aparte', (tester) async {
    final f = fakes();
    f.api.current = sessionAt(CheckoutStep.tcPending);
    await pumpWizard(tester, api: f.api, network: f.network);

    await tester.tap(find.text('See every step'));
    await tester.pumpAndSettle();

    expect(find.byType(StepsSheet), findsOneWidget);
    expect(find.text('10 steps + alternate exit'), findsOneWidget);
    // El guard del backend, explicado ANTES de que produzca un 409.
    expect(
      find.text("Waiting on: customer's T&C signature"),
      findsOneWidget,
    );
    // CANCELLED va aparte, al final y con su explicación de salida alterna
    // (hay que bajar: son 10 pasos + la salida).
    await tester.scrollUntilVisible(
      find.text('Alternate exit from any non-terminal step'),
      200,
      scrollable: find.byType(Scrollable).last,
    );
    expect(
      find.text('Alternate exit from any non-terminal step'),
      findsOneWidget,
    );
  });

  testWidgets('8E — pausar: consecuencias explícitas y POST /abandon',
      (tester) async {
    final f = fakes();
    f.api.current = sessionAt(CheckoutStep.tcPending);
    await pumpWizard(tester, api: f.api, network: f.network);

    await tester.tap(find.text('Pause'));
    await tester.pumpAndSettle();

    expect(find.byType(PauseSheet), findsOneWidget);
    expect(find.text('Save and pause this checkout?'), findsOneWidget);
    expect(
      find.textContaining('The session stays saved on step 2 of 10'),
      findsOneWidget,
    );
    // ADR-4 en lenguaje de patio.
    expect(
      find.textContaining('you enter the step the server reports'),
      findsOneWidget,
    );

    f.api.onAbandon = () async => sessionAt(
          CheckoutStep.tcPending,
          abandonedAt: DateTime.now(),
        );
    await tester.tap(find.text('Save and pause'));
    await tester.pumpAndSettle();
    expect(f.api.abandonCalls, 1);
  });

  testWidgets('la flecha de atrás no sale sin decidir: abre el mismo sheet',
      (tester) async {
    final f = fakes();
    await pumpWizard(tester, api: f.api, network: f.network);

    await tester.tap(find.byIcon(Icons.arrow_back_rounded));
    await tester.pumpAndSettle();
    expect(find.byType(PauseSheet), findsOneWidget);

    await tester.tap(find.text('Stay here'));
    await tester.pumpAndSettle();
    expect(find.byType(PauseSheet), findsNothing);
    expect(find.byType(PhaseRail), findsOneWidget);
  });

  testWidgets('sesión terminal: resumen del events log y salida, sin pasos',
      (tester) async {
    final f = fakes();
    f.api.current = sessionAt(CheckoutStep.closed);
    await pumpWizard(tester, api: f.api, network: f.network);

    expect(find.text('Checkout delivered'), findsOneWidget);
    expect(find.text('Session log'), findsOneWidget);
    expect(find.byType(PhaseRail), findsNothing);
    // Nada que pausar: el botón no se ofrece.
    expect(find.text('Pause'), findsNothing);
  });

  testWidgets('404 de by-reservation: "aún no hay sesión" (crearla es H7)',
      (tester) async {
    final f = fakes();
    f.api.onByReservation = () async => null;
    await pumpWizard(tester, api: f.api, network: f.network);

    expect(find.text('No checkout session yet'), findsOneWidget);
    expect(find.byType(PhaseRail), findsNothing);
  });

  group('TransitionButton (el CTA que usan H2–H5)', () {
    testWidgets('anti-doble-tap: el segundo toque con uno en vuelo no manda '
        'otro POST', (tester) async {
      final f = fakes();
      final gate = Completer<void>();
      f.api.onTransition = (_) async {
        await gate.future;
        return sessionAt(CheckoutStep.tcPending);
      };
      await pumpWizard(
        tester,
        api: f.api,
        network: f.network,
        child: const TransitionButton(
          reservationId: kReservationId,
          toStep: CheckoutStep.tcPending,
          label: 'Continue to T&C',
        ),
      );

      await tester.tap(find.text('Continue to T&C'));
      await tester.pump();
      // Segundo toque mientras el primero está en vuelo.
      await tester.tap(find.byType(RidePrimaryButton));
      await tester.pump();
      expect(f.api.transitionCalls, 1);

      gate.complete();
      await tester.pump();
      await tester.pump();
      expect(f.api.transitionCalls, 1);
    });

    testWidgets('sin red: deshabilitado CON CAUSA y con la regla de la '
        'bandeja escrita (ADR-5)', (tester) async {
      final f = fakes();
      await pumpWizard(
        tester,
        api: f.api,
        network: f.network,
        child: const TransitionButton(
          reservationId: kReservationId,
          toStep: CheckoutStep.tcPending,
          label: 'Continue to T&C',
        ),
      );
      expect(
        find.textContaining('The server confirms the advance'),
        findsOneWidget,
      );

      f.api.onGet = () async =>
          throw ApiError(kind: ApiErrorKind.network, message: 'sin red');
      await tester.pump(const Duration(seconds: 5));
      await tester.pump();

      expect(
        find.textContaining('Nothing from this step goes to the Outbox'),
        findsOneWidget,
      );
      await tester.tap(find.text('Continue to T&C'));
      await tester.pump();
      expect(f.api.transitionCalls, 0, reason: 'el dinero y los pasos no se '
          'encolan: se espera');
    });
  });
}
