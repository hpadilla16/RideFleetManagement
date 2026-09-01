import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:rideops/core/api/api_error.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:rideops/core/api/api_providers.dart';
import 'package:rideops/core/db/outbox_providers.dart';
import 'package:rideops/core/api/dto/checkout_session.dart';
import 'package:rideops/core/api/enums.dart';
import 'package:rideops/core/l10n/app_localizations.dart';
import 'package:rideops/core/lifecycle/app_visibility.dart';
import 'package:rideops/core/outbox/network_status.dart';
import 'package:rideops/core/router/app_router.dart';
import 'package:rideops/core/session/active_location.dart';
import 'package:rideops/core/session/session_controller.dart';
import 'package:rideops/core/session/session_state.dart';
import 'package:rideops/core/telemetry/event_logger.dart';
import 'package:rideops/core/theme/ride_tokens.dart';
import 'package:rideops/core/widgets/ride_buttons.dart';
import 'package:rideops/features/checkout/presentation/checkout_wizard_screen.dart';
import 'package:rideops/features/checkout/presentation/widgets/transition_button.dart';
import 'package:rideops/features/checkout/presentation/widgets/pause_sheet.dart';
import 'package:rideops/features/checkout/presentation/widgets/steps_sheet.dart';
import 'package:rideops/features/checkout/presentation/widgets/terminal_view.dart';
import 'package:rideops/features/checkout/presentation/widgets/wizard_banners.dart';
import 'package:rideops/features/checkout/presentation/widgets/wizard_chrome.dart';
import 'package:rideops/features/checkout/presentation/widgets/wizard_dock.dart';
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
          // M2-H6: la pantalla terminal lee la BANDEJA para poder responder
          // "¿perdí mi trabajo?" (21D). Sin este override sale el stream real
          // de drift y deja un timer vivo al desmontar — el mismo cableado que
          // checkout_inspection_test ya hacía.
          outboxRowsProvider.overrideWith((ref) => const Stream.empty()),
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
    // Presencia: informativa, con la superficie nombrada — que es el propósito
    // del chip. Desde M2-H6 se dice en la forma CORTA de los marcos: la línea
    // larga no cabía a 360 dp y lo primero que se cortaba era justo la
    // superficie (GD-MC-1).
    expect(find.byType(PresenceChip), findsOneWidget);
    expect(find.text('María G. · kiosk'), findsOneWidget);
    // La línea completa no se pierde: viaja entera al lector de pantalla.
    //
    // Se afirma hasta el final —incluida la EDAD—, no hasta `· kiosk`: el
    // componente de antigüedad no lo fijaba ninguna prueba, y es justo el que
    // distingue la línea completa de la forma corta cuando el punto está
    // apagado. El `\d+` evita romperse en un borde de segundo.
    expect(
      tester.getSemantics(find.byType(PresenceChip)).label,
      matches(
        RegExp(
          r'^María G\. is in this session · kiosk · \d+ s ago'
          r': see who is in this session$',
        ),
      ),
    );
    // Header completo (8A): la fila del cliente del display-data.
    expect(find.text('María González'), findsOneWidget);
  });

  testWidgets('M2-H6 — sin nadie visible el chip SÍ se pinta, y dice "nadie '
      'visible": es la única puerta al reverso del latido', (tester) async {
    final f = fakes();
    f.api.current = sessionAt(CheckoutStep.confirming); // presence ausente
    await pumpWizard(tester, api: f.api, network: f.network);

    // Cambio deliberado respecto de H1 (review de GD): entonces el chip era
    // decorativo y esconderlo sin compañía era correcto. Desde H6 el chip es
    // la ÚNICA entrada a "Quién está aquí", y ahí vive el aviso de que el
    // agente empezó a aparecer con su nombre en las otras superficies. Con el
    // chip condicionado a que hubiera compañía, el agente que trabaja solo —el
    // caso normal en el patio— no se enteraba nunca.
    expect(find.byType(PresenceChip), findsOneWidget);
    expect(find.text('Nobody visible right now'), findsOneWidget);
    // Y NUNCA "estás solo": lo que se afirma es que no hay nadie VISIBLE.
    expect(find.textContaining('alone'), findsNothing);
    // Sigue siendo un objetivo real de 48 px.
    final target = find.descendant(
      of: find.byType(PresenceChip),
      matching: find.byType(InkWell),
    );
    expect(tester.getSize(target.first).height, greaterThanOrEqualTo(48));
  });

  testWidgets('M2-H6 · 21C-bis — el aviso de SELLO va DENTRO del pie, encima '
      'del CTA y fuera del scroll', (tester) async {
    final f = fakes();
    f.api.current = sessionAt(CheckoutStep.tcPending);
    await pumpWizard(tester, api: f.api, network: f.network);
    await tester.pumpAndSettle();
    // Entrar en el paso 2 abre la antesala de enganche; se cruza, porque lo
    // que se mide aquí es el PIE del paso.
    await skipJoinGate(tester);
    expect(find.byType(ForeignAdvanceBanner), findsNothing);

    // El mostrador cobra mientras el agente sigue en términos: cae el sello y
    // el paso NO se mueve.
    f.api.current = sessionAt(CheckoutStep.tcPending, payment: DateTime.now());
    await tester.pump(const Duration(seconds: 5));
    await tester.pumpAndSettle();

    final banner = find.byType(ForeignAdvanceBanner);
    expect(banner, findsOneWidget);
    expect(
      find.textContaining('Keep capturing: this step did not change'),
      findsOneWidget,
    );

    // (1) FUERA del scroll. Dentro, con el teclado abierto quedaría fuera de
    // vista y además desplazaría el campo que se está tecleando.
    expect(
      find.ancestor(of: banner, matching: find.byType(Scrollable)),
      findsNothing,
    );

    // (2) DENTRO del pie — no debajo, que era un segundo pie, ni flotando
    // sobre el CTA, que lo taparía. Decisión de Hector sobre el marco 21C-bis.
    final dock = find.byType(WizardDock);
    expect(dock, findsOneWidget);
    expect(find.ancestor(of: banner, matching: dock), findsOneWidget);

    // (3) ENCIMA del CTA, que es todo el argumento: la franja que el pulgar
    // alcanza sin recolocar la mano tiene que llevar la acción que continúa el
    // trabajo, no un aviso cuya única acción es opcional.
    // Se compara contra el `primary` REAL del pie y no contra un tipo
    // adivinado: cada paso decide cuál es su acción principal (avanzar,
    // cambiar de unidad, re-emitir el código), y la regla es la misma para
    // todos.
    final cta = find.byWidget(tester.widget<WizardDock>(dock).primary);
    expect(cta, findsOneWidget);
    expect(
      tester.getBottomLeft(banner).dy,
      lessThanOrEqualTo(tester.getTopLeft(cta).dy),
      reason: 'el aviso no puede quedar por debajo del primario',
    );

    // (4) Un solo pie: un filete, ninguna sombra hacia arriba (GD-SC-2).
    //
    // Se miran los contenedores ENTRE el aviso y el pie —sus envoltorios— y no
    // solo sus descendientes: la versión anterior de esta aserción buscaba
    // dentro del banner, y el `Container` full-bleed que hubo que quitar era
    // su PADRE. Miraba exactamente donde el defecto no estaba.
    //
    // La invariante es de conteo: entre el aviso y el borde del pie puede
    // haber UN filete superior — el del propio dock — y ni uno más. Dos
    // filetes horizontales seguidos en 24 px de alto son un bug visual, no una
    // jerarquía.
    bool topOnlyRule(BoxDecoration d) {
      final b = d.border;
      return b is Border &&
          b.top.width > 0 &&
          b.left.width == 0 &&
          b.right.width == 0;
    }

    final betweenBannerAndDock = <BoxDecoration>[
      for (final c in tester.widgetList<Container>(
        find.ancestor(of: banner, matching: find.descendant(
          of: dock,
          matching: find.byType(Container),
          matchRoot: true,
        )),
      ))
        if (c.decoration case final BoxDecoration d) d,
      for (final c in tester.widgetList<Container>(
        find.descendant(of: banner, matching: find.byType(Container)),
      ))
        if (c.decoration case final BoxDecoration d) d,
    ];

    expect(
      betweenBannerAndDock.where(topOnlyRule).length,
      1,
      reason: 'un pie, un filete: el del dock y ninguno más',
    );
    expect(
      betweenBannerAndDock.any(
        (d) => (d.boxShadow ?? const <BoxShadow>[])
            .any((sh) => sh.offset.dy < 0),
      ),
      isFalse,
      reason: 'la sombra hacia arriba era la tercera señal de "segundo pie"',
    );
  });

  testWidgets('M2-H6 · 21C sin dock — en un paso que no construye pie, el '
      'aviso conserva el anclaje de la lámina', (tester) async {
    // ── Por qué esta prueba existe ────────────────────────────────────────
    //
    // QA borró el bloque entero del aviso en la rama `_ =>` y las 701 pruebas
    // siguieron verdes. El hueco cayó justo en el ÚNICO camino que NO pasa por
    // `WizardDockNotice`: ahí el aviso se enhebra como parámetro explícito, que
    // es exactamente el modo de fallo —alguien deja de reenviarlo y desaparece
    // sin que nadie grite— que el widget heredado existe para evitar en los
    // otros 15 sitios. El argumento arquitectónico no cubría su propia
    // excepción; esta prueba sí.
    //
    // La rama sirve TC_SIGNED, PAYMENT_PENDING y PAID: tres pasos vivos.
    final f = fakes();
    // PAYMENT_PENDING con el sello de T&C ya puesto — es como se llega ahí
    // (TC_SIGNED lo exige), así que el estado es producible por el backend.
    f.api.current = sessionAt(CheckoutStep.paymentPending, tc: DateTime.now());
    await pumpWizard(tester, api: f.api, network: f.network);
    await tester.pumpAndSettle();
    await skipJoinGate(tester);

    // Este paso NO tiene pie: es la premisa de la prueba, y se afirma en vez
    // de suponerse — si algún día gana uno, esta prueba tiene que enterarse.
    expect(find.byType(WizardDock), findsNothing);
    expect(find.byType(ForeignAdvanceBanner), findsNothing);

    // La inspección se sella mientras el agente está en el paso de pago: el
    // escenario canónico del 21C en esta rama.
    f.api.current = sessionAt(
      CheckoutStep.paymentPending,
      tc: DateTime.now(),
      inspection: DateTime.now(),
    );
    await tester.pump(const Duration(seconds: 5));
    await tester.pumpAndSettle();

    final banner = find.byType(ForeignAdvanceBanner);
    expect(banner, findsOneWidget, reason: 'sin pie el aviso NO puede perderse');
    expect(
      find.textContaining('Keep capturing: this step did not change'),
      findsOneWidget,
    );

    // Sigue FUERA del scroll: es la regla que no depende de que haya dock.
    expect(
      find.ancestor(of: banner, matching: find.byType(Scrollable)),
      findsNothing,
    );

    // Y anclado al PIE: por debajo del cuerpo del paso.
    final list = find.byType(Scrollable).first;
    expect(
      tester.getTopLeft(banner).dy,
      greaterThanOrEqualTo(tester.getBottomLeft(list).dy - 1),
      reason: 'el aviso va debajo del cuerpo, no encima ni dentro',
    );
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

  testWidgets('MAJOR-2 — el sheet de pasos está VIVO: con la lista abierta, un '
      'avance de otra superficie mueve el paso actual y suelta su candado',
      (tester) async {
    final f = fakes();
    f.api.current = sessionAt(CheckoutStep.tcPending);
    await pumpWizard(tester, api: f.api, network: f.network);

    await tester.tap(find.text('See every step'));
    await tester.pumpAndSettle();
    expect(find.byType(StepsSheet), findsOneWidget);
    // El guard de TC_SIGNED se anuncia porque tcCompletedAt no está sellado.
    expect(find.text("Waiting on: customer's T&C signature"), findsOneWidget);
    expect(find.text('In progress'), findsOneWidget);

    // El cliente firma en su teléfono y el kiosco avanza — con el sheet
    // abierto, que es justo el destino del "Ver qué cambió".
    f.api.current = sessionAt(
      CheckoutStep.tcSigned,
      actorUserId: null,
      kiosk: true,
      tc: DateTime.now(),
    );
    await tester.pump(const Duration(seconds: 5));
    await tester.pumpAndSettle();

    expect(find.byType(StepsSheet), findsOneWidget, reason: 'sigue abierta');
    expect(
      find.text("Waiting on: customer's T&C signature"),
      findsNothing,
      reason: 'el sello llegó: el candado ya no puede seguir puesto',
    );
    // El paso actual de la LISTA se movió: "Términos firmados" pasa a estar en
    // curso y el anterior queda como completado.
    expect(
      find.descendant(
        of: find.byType(StepsSheet),
        matching: find.textContaining('Completed'),
      ),
      findsWidgets,
    );
    // Y el stepline de atrás también: la pantalla entera reaccionó.
    expect(find.text('Step 3 of 10'), findsOneWidget);
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

  testWidgets('MC-4 — sin red el agente NO queda encerrado: pausar se apaga '
      'con su causa y hay salida honesta sin POST', (tester) async {
    final f = fakes();
    f.api.current = sessionAt(CheckoutStep.tcPending);
    await pumpWizard(tester, api: f.api, network: f.network);

    f.api.onGet = () async =>
        throw ApiError(kind: ApiErrorKind.network, message: 'sin red');
    await tester.pump(const Duration(seconds: 5));
    await tester.pump();

    await tester.tap(find.text('Pause'));
    await tester.pumpAndSettle();
    expect(find.textContaining('Pausing needs a connection'), findsOneWidget);

    // El primario está apagado (un POST offline falla siempre) y la salida
    // real existe.
    await tester.tap(find.text('Save and pause'));
    await tester.pumpAndSettle();
    expect(f.api.abandonCalls, 0);

    await tester.tap(find.text('Leave without pausing'));
    await tester.pumpAndSettle();
    expect(f.api.abandonCalls, 0, reason: 'salir no inventa un POST');
    expect(find.byType(PauseSheet), findsNothing);
    expect(find.text('home'), findsOneWidget, reason: 'salió de verdad');
  });

  testWidgets('MC-4 — si el POST de pausa falla, el sheet se queda con el '
      'error y la salida a un toque', (tester) async {
    final f = fakes();
    f.api.current = sessionAt(CheckoutStep.tcPending);
    f.api.onAbandon = () async => throw ApiError(
          kind: ApiErrorKind.conflict,
          message: 'Session is already terminal',
          status: 409,
        );
    await pumpWizard(tester, api: f.api, network: f.network);

    await tester.tap(find.text('Pause'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Save and pause'));
    await tester.pumpAndSettle();

    expect(f.api.abandonCalls, 1);
    expect(find.byType(PauseSheet), findsOneWidget, reason: 'no se cierra en '
        'silencio fingiendo que pausó');
    expect(find.textContaining('Could not pause'), findsOneWidget);
    expect(find.text('Leave without pausing'), findsOneWidget);
  });

  testWidgets('SC-5 — la pausa del poll también funciona AQUÍ: el wizard vive '
      'fuera del shell y la señal de visibilidad la da LockObserver',
      (tester) async {
    final f = fakes();
    await pumpWizard(tester, api: f.api, network: f.network);
    final container = ProviderScope.containerOf(
      tester.element(find.byType(CheckoutWizardScreen)),
    );

    // Un tick normal ocurre a los 5 s…
    await tester.pump(const Duration(seconds: 5));
    await tester.pump();
    expect(f.api.getCalls, 1);

    // …y con la app en background, ninguno.
    container.read(appVisibilityProvider.notifier).setVisible(false);
    await tester.pump();
    await tester.pump(const Duration(minutes: 2));
    expect(f.api.getCalls, 1, reason: 'el poll de 5 s no corre en el bolsillo');

    // Al volver: lectura inmediata, que es cuando el dato viejo más miente.
    container.read(appVisibilityProvider.notifier).setVisible(true);
    await tester.pump();
    expect(f.api.getCalls, 2);
  });

  group('acabado del mockup (review de GD)', () {
    testWidgets('el rail lleva conector y la fase ACTUAL es relleno sólido de '
        'marca (no puede pesar menos que la hecha)', (tester) async {
      final f = fakes();
      f.api.current = sessionAt(CheckoutStep.paymentPending);
      await pumpWizard(tester, api: f.api, network: f.network);

      // Conectores: 4 tramos entre 5 nodos ⇒ 8 mitades, ninguna transparente
      // salvo los extremos.
      final rail = find.byType(PhaseRail);
      expect(rail, findsOneWidget);

      final dots = tester.widgetList<Container>(
        find.descendant(of: rail, matching: find.byType(Container)),
      );
      final solids = dots.where((c) {
        final d = c.decoration;
        return d is BoxDecoration &&
            d.shape == BoxShape.circle &&
            d.color == RideTokens.p600;
      });
      expect(solids, hasLength(1), reason: 'una sola fase actual, sólida');
      final halo = solids.first.decoration as BoxDecoration;
      expect(halo.boxShadow?.first.color, RideTokens.brandA20);

      final connectors = dots.where((c) =>
          c.constraints == null &&
          c.decoration == null &&
          c.color != null &&
          c.color != Colors.transparent);
      expect(connectors, isNotEmpty, reason: 'sin conector son 5 chips sueltos');

      // Alto táctil del rail.
      expect(tester.getSize(rail).height, greaterThanOrEqualTo(48));
    });

    testWidgets('las acciones de banner tienen 44 px de alto y área más ancha '
        'que su texto', (tester) async {
      final f = fakes();
      await pumpWizard(tester, api: f.api, network: f.network);
      f.api.current = sessionAt(
        CheckoutStep.tcPending,
        actorUserId: null,
        kiosk: true,
      );
      await tester.pump(const Duration(seconds: 5));
      await tester.pump();

      final action = find.byType(BannerAction);
      expect(action, findsOneWidget);
      final box = tester.getRect(action);
      expect(box.height, greaterThanOrEqualTo(44));
      expect(
        box.width,
        greaterThan(tester.getRect(find.text('See what changed')).width),
        reason: 'hit-slop real, no el ancho exacto del texto',
      );
    });

    testWidgets('sin red el punto de presencia deja de ser verde (no se '
        'afirma liveness que no podemos leer) pero el chip NO desaparece',
        (tester) async {
      final f = fakes();
      f.api.current = sessionAt(
        CheckoutStep.confirming,
        presence: [
          CheckoutPresenceDto(
            surface: 'KIOSK',
            displayName: 'María G.',
            lastSeenAt: DateTime.now().subtract(const Duration(seconds: 5)),
          ),
        ],
      );
      await pumpWizard(tester, api: f.api, network: f.network);

      Color dotColor() {
        final dot = tester.widgetList<Container>(
          find.descendant(
            of: find.byType(PresenceChip),
            matching: find.byType(Container),
          ),
        ).firstWhere((c) {
          final d = c.decoration;
          return d is BoxDecoration && d.shape == BoxShape.circle;
        });
        return (dot.decoration! as BoxDecoration).color!;
      }

      expect(dotColor(), RideTokens.ok);

      f.api.onGet = () async =>
          throw ApiError(kind: ApiErrorKind.network, message: 'sin red');
      await tester.pump(const Duration(seconds: 5));
      await tester.pump();

      expect(find.byType(PresenceChip), findsOneWidget,
          reason: 'desaparecer sigue siendo cosa EXCLUSIVA del TTL');
      expect(dotColor(), RideTokens.n500);
    });

    testWidgets('el header responde "para cuándo" y no repite el número de '
        'reserva del wizbar', (tester) async {
      final f = fakes();
      // Se ancla en un paso SIN cuerpo propio, que es donde el header va
      // COMPLETO y responde las tres preguntas del patio.
      //
      // Ojo con el porqué: esta prueba NO estaba mal. En H1 la regla era
      // `mini = _sheetOpen || state.offline`, así que en CONFIRMING el header
      // iba completo y aquí se medía el header de verdad. Lo invalidó H2 al
      // meter `_hasStepBody` en esa regla (checkout_wizard_screen.dart:165):
      // desde entonces CONFIRMING tiene cuerpo propio, el header va mini y lo
      // que se estaría midiendo serían las tarjetas del paso.
      f.api.current = sessionAt(CheckoutStep.paymentPending);
      await pumpWizard(tester, api: f.api, network: f.network);

      expect(find.textContaining('Departs'), findsOneWidget);
      expect(find.textContaining('Pre-check-in done'), findsOneWidget);
      // Y la unidad del odómetro del HEADER, que no tenía ninguna aserción:
      // decía "km" mientras la tarjeta del paso 1 del MISMO wizard decía
      // "mi", con el mismo entero del mismo `Vehicle.mileage`. El header
      // completo se pinta justo en los pasos de pago/firma/cierre, así que el
      // agente veía las dos unidades con segundos de diferencia.
      expect(find.textContaining('Odometer 48,190 mi'), findsOneWidget);
      expect(find.textContaining('km'), findsNothing);
      // El número vive SOLO en el wizbar.
      expect(find.textContaining('R-20260816-0042'), findsOneWidget);
    });

    testWidgets('el dock del CTA trae hairline y el "why" centrado',
        (tester) async {
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
      final dock = tester.widget<Container>(
        find
            .descendant(
              of: find.byType(TransitionButton),
              matching: find.byType(Container),
            )
            .first,
      );
      final border = (dock.decoration! as BoxDecoration).border!;
      expect(border.top.color, RideTokens.n200);

      final why = tester.widget<Text>(
        find.textContaining('The server confirms the advance'),
      );
      expect(why.textAlign, TextAlign.center);
      expect(why.style!.fontSize, 12.5);
    });

    testWidgets('GD-SC-3 — hay UN dock, no tres: el CTA de avance y el dock de '
        'conflicto salen del mismo WizardDock', (tester) async {
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
        find.descendant(
          of: find.byType(TransitionButton),
          matching: find.byType(WizardDock),
        ),
        findsOneWidget,
      );

      // Y el del 9D, que H2 había reimplementado con la misma geometría copiada.
      f.api.onTransition = (_) async => throw ApiError(
            kind: ApiErrorKind.conflict,
            status: 409,
            code: 'VEHICLE_CONFLICT',
            message: 'Vehicle is still out on open rental R-2466',
          );
      await pumpWizard(tester, api: f.api, network: f.network);
      await tester.tap(find.text('Continue to T&C'));
      await tester.pumpAndSettle();
      expect(find.widgetWithText(WizardDock, 'Pick another vehicle'),
          findsOneWidget);
    });

    testWidgets('los sheets usan el scrim de marca y respetan la safe area',
        (tester) async {
      final f = fakes();
      await pumpWizard(tester, api: f.api, network: f.network);
      await tester.tap(find.text('See every step'));
      await tester.pumpAndSettle();

      final barrier = tester.widgetList<ModalBarrier>(
        find.byType(ModalBarrier),
      ).firstWhere((b) => b.color != null);
      expect(barrier.color, const Color(0x6B17122B));
      // useSafeArea envuelve el sheet POR FUERA: el SafeArea es ancestro del
      // contenido, no descendiente.
      expect(
        find.ancestor(
          of: find.byType(StepsSheet),
          matching: find.byType(SafeArea),
        ),
        findsWidgets,
        reason: 'sin esto el botón queda bajo la barra de gestos',
      );
    });
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

    // Frame 11E (M2-H7): la pantalla terminal es la noticia de un trabajo
    // hecho, no un error.
    expect(find.byType(CheckoutTerminalView), findsOneWidget);
    expect(find.text('This checkout is already closed'), findsOneWidget);
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
