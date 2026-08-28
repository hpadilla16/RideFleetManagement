import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:rideops/core/api/dto/checkout_session.dart';
import 'package:rideops/core/api/enums.dart';
import 'package:rideops/core/l10n/app_localizations.dart';
import 'package:rideops/core/widgets/ride_buttons.dart';
import 'package:rideops/features/checkout/application/checkout_wizard_state.dart';
import 'package:rideops/features/checkout/domain/checkout_changes.dart';
import 'package:rideops/features/checkout/domain/checkout_event_log.dart';
import 'package:rideops/features/checkout/domain/checkout_presence.dart';
import 'package:rideops/features/checkout/presentation/widgets/changed_sheet.dart';
import 'package:rideops/features/checkout/presentation/widgets/join_view.dart';
import 'package:rideops/features/checkout/presentation/widgets/terminal_view.dart';
import 'package:rideops/features/checkout/presentation/widgets/presence_sheet.dart';
import 'package:rideops/features/checkout/presentation/widgets/wizard_banners.dart';
import 'package:rideops/features/checkout/presentation/widgets/wizard_chrome.dart';

import 'helpers/checkout_test_helpers.dart';

/// Piezas nuevas de M2-H6 en aislamiento. Locale `en` como el resto de la
/// suite: se asierta contra `app_en.arb`, así que un texto en duro en el
/// código haría fallar estos tests.
///
/// La regla que persiguen casi todos: **si se dibuja una acción, tiene que
/// poder tener éxito** — y si no, se nombra el callejón en vez de ofrecer un
/// botón que rebotaría para siempre.

void main() {
  final now = DateTime.utc(2026, 8, 28, 10, 30);

  Future<void> pump(WidgetTester tester, Widget child) async {
    await tester.pumpWidget(
      MaterialApp(
        localizationsDelegates: const [
          AppLocalizations.delegate,
          GlobalMaterialLocalizations.delegate,
          GlobalWidgetsLocalizations.delegate,
          GlobalCupertinoLocalizations.delegate,
        ],
        supportedLocales: const [Locale('es'), Locale('en')],
        locale: const Locale('en'),
        home: Scaffold(body: child),
      ),
    );
    await tester.pumpAndSettle();
  }

  CheckoutPresenceDto presence(
    String surface, {
    required String name,
    Duration age = Duration.zero,
  }) =>
      CheckoutPresenceDto(
        surface: surface,
        displayName: name,
        lastSeenAt: now.subtract(age),
      );

  group('20B — "Quién está en esta sesión"', () {
    testWidgets('persona y aparato no se dibujan igual, y el agente se entera '
        'de que él también es visible', (tester) async {
      await pump(
        tester,
        WhoIsHereSheet(
          roster: presenceRoster(
            [
              presence('COUNTER', name: 'Diego Torres'),
              presence('KIOSK', name: 'Kiosk', age: const Duration(seconds: 31)),
            ],
            now,
          ),
          myName: 'Ana Ruiz',
          offline: false,
          onClose: () {},
        ),
      );

      expect(find.text('Who is in this session'), findsOneWidget);
      // El TTL se nombra en vez de esconderse.
      expect(find.text("The server's 45 s window · refreshed on every read"),
          findsOneWidget);
      // Persona: iniciales. Aparato: glifo, sin iniciales, y su subtítulo lo
      // dice con palabras.
      expect(find.text('DT'), findsOneWidget);
      expect(find.text('KI'), findsNothing);
      expect(find.text('Device · no person identified'), findsOneWidget);
      // El reverso, con nombre completo (decisión de Hector).
      expect(find.text('You · RideOps'), findsOneWidget);
      expect(find.text('Others see you as Ana Ruiz'), findsOneWidget);
      expect(
        find.textContaining('This reserves nothing'),
        findsOneWidget,
        reason: 'el riesgo real de encender el latido es leerlo como candado',
      );
    });

    testWidgets('lista vacía dice "nadie visible", JAMÁS "estás solo"',
        (tester) async {
      await pump(
        tester,
        WhoIsHereSheet(
          roster: const [],
          myName: 'Ana Ruiz',
          offline: false,
          onClose: () {},
        ),
      );
      expect(
        find.text('Nobody is visible right now. Another surface may be moving '
            'ahead without showing here.'),
        findsOneWidget,
      );
    });

    testWidgets('sin red son DOS vacíos distintos: "no verificable" no es lo '
        'mismo que "nadie visible"', (tester) async {
      await pump(
        tester,
        WhoIsHereSheet(
          roster: presenceRoster(
            [presence('COUNTER', name: 'Diego Torres')],
            now,
          ),
          myName: null,
          offline: true,
          onClose: () {},
        ),
      );
      expect(
        find.textContaining("we can't state that anyone is here right now"),
        findsOneWidget,
      );
      // El chip NO desaparece: desaparecer sigue siendo cosa del TTL.
      expect(find.text('Diego Torres'), findsOneWidget);
      // Y el punto vivo se apaga: la fila deja de decir "now".
      expect(find.text('now'), findsOneWidget,
          reason: 'solo el "ahora" de la fila propia');
      // Sin /me no se finge saber el nombre exacto.
      expect(find.text('Others see you by your full name'), findsOneWidget);
    });
  });

  group('el chip de presencia se vuelve TOCABLE (H6)', () {
    testWidgets('48 px reales de objetivo aunque el chip se dibuje a 34',
        (tester) async {
      var taps = 0;
      await pump(
        tester,
        Align(
          alignment: Alignment.topLeft,
          child: SessionHead(
            context_: null,
            presence: pickPresenceChip(
              [presence('COUNTER', name: 'Diego Torres')],
              now,
            ),
            onPresenceTap: () => taps++,
          ),
        ),
      );
      final chip = find.byType(PresenceChip);
      expect(chip, findsOneWidget);
      final target = find.descendant(of: chip, matching: find.byType(InkWell));
      expect(tester.getSize(target.first).height, greaterThanOrEqualTo(48));
      await tester.tap(chip);
      expect(taps, 1);
    });

    testWidgets('sin destino el chip queda inerte, sin botón fantasma',
        (tester) async {
      await pump(
        tester,
        Align(
          alignment: Alignment.topLeft,
          child: SessionHead(
            context_: null,
            presence: pickPresenceChip(
              [presence('COUNTER', name: 'Diego Torres')],
              now,
            ),
          ),
        ),
      );
      expect(
        find.descendant(of: find.byType(PresenceChip),
            matching: find.byType(InkWell)),
        findsNothing,
      );
    });
  });

  group('21C — el sello que cae sin mover el paso', () {
    testWidgets('dice QUÉ cayó y, sobre todo, que este paso no cambió',
        (tester) async {
      await pump(
        tester,
        ForeignAdvanceBanner(
          notice: ForeignAdvanceNotice(
            kind: ForeignAdvanceKind.stampLanded,
            stamp: CheckoutStampKind.payment,
            completedStep: 'INSPECTION_IN_PROGRESS',
            currentStep: 'INSPECTION_IN_PROGRESS',
            actor: CheckoutActorKind.otherSurface,
            at: DateTime.now().subtract(const Duration(seconds: 12)),
          ),
          onSeeChanged: () {},
        ),
      );
      expect(
        find.textContaining('Payment recorded was recorded on another surface'),
        findsOneWidget,
      );
      expect(
        find.textContaining('Keep capturing: this step did not change'),
        findsOneWidget,
        reason: 'la frase que impide que suelte el formulario a medio llenar',
      );
    });

    testWidgets('con nombre resuelto el avance ajeno lo NOMBRA; sin él cae al '
        'copy genérico en vez de a un hueco', (tester) async {
      await pump(
        tester,
        ForeignAdvanceBanner(
          notice: const ForeignAdvanceNotice(
            completedStep: 'TC_PENDING',
            currentStep: 'TC_SIGNED',
            actor: CheckoutActorKind.otherAgent,
            actorName: 'Diego Torres',
          ),
          onSeeChanged: () {},
        ),
      );
      expect(find.textContaining('was completed by Diego Torres'),
          findsOneWidget);

      await pump(
        tester,
        ForeignAdvanceBanner(
          notice: const ForeignAdvanceNotice(
            completedStep: 'TC_PENDING',
            currentStep: 'TC_SIGNED',
            actor: CheckoutActorKind.otherAgent,
          ),
          onSeeChanged: () {},
        ),
      );
      expect(find.textContaining('was completed by another agent'),
          findsOneWidget);
    });
  });

  group('22 — la matriz 409 con cara humana', () {
    testWidgets('22A `tooEarly`: ámbar, nombra los dos pasos, ofrece NAVEGAR '
        'y no dibuja "Reintentar"', (tester) async {
      var went = 0;
      await pump(
        tester,
        ConflictBanner(
          conflict: const CheckoutConflict(
            kind: CheckoutConflictKind.tooEarly,
            message: 'Illegal transition TC_PENDING → PAYMENT_PENDING',
            code: 'ILLEGAL_TRANSITION',
            attemptedStep: CheckoutStep.paymentPending,
            currentStep: CheckoutStep.tcPending,
          ),
          onDismiss: () {},
          onGoToStep: () => went++,
        ),
      );
      expect(find.text("That step isn't up yet"), findsOneWidget);
      expect(
        find.textContaining('The session is on Terms and conditions (step 2)'),
        findsOneWidget,
      );
      // El mensaje del servidor se enmarca, no se sustituye (DoD #5)…
      expect(find.text('Illegal transition TC_PENDING → PAYMENT_PENDING'),
          findsOneWidget);
      // …y el código de máquina jamás llega a la cara del agente como título.
      expect(find.text('ILLEGAL_TRANSITION'), findsNothing);
      // La puerta falsa que NO se dibuja.
      expect(find.textContaining('Retry'), findsNothing);
      await tester.tap(find.textContaining('Go to step 2'));
      expect(went, 1);
    });

    testWidgets('22B `ENTRY_GUARD` con la Bandeja VACÍA no ofrece la Bandeja: '
        'mandar a una pantalla vacía es otra puerta falsa', (tester) async {
      await pump(
        tester,
        ConflictBanner(
          conflict: const CheckoutConflict(
            kind: CheckoutConflictKind.entryGuard,
            message: 'Cannot enter CUSTOMER_SIGN_PENDING: '
                'inspectionCompletedAt is not stamped yet',
            code: 'ENTRY_GUARD',
          ),
          onDismiss: () {},
          onOpenOutbox: () {},
        ),
      );
      expect(find.text('A previous step is missing'), findsOneWidget);
      expect(find.textContaining('Open the Outbox'), findsNothing);
    });

    testWidgets('22B con filas de verdad sí la ofrece, con su número',
        (tester) async {
      var opened = 0;
      await pump(
        tester,
        ConflictBanner(
          conflict: const CheckoutConflict(
            kind: CheckoutConflictKind.entryGuard,
            message: 'Cannot enter CUSTOMER_SIGN_PENDING: '
                'inspectionCompletedAt is not stamped yet',
            code: 'ENTRY_GUARD',
          ),
          onDismiss: () {},
          onOpenOutbox: () => opened++,
          pendingUploads: 2,
        ),
      );
      await tester.tap(find.text('Open the Outbox (2)'));
      expect(opened, 1);
    });

    testWidgets('22C con el swap YA CERRADO: se nombra el callejón y no hay '
        'ningún CTA de cambio', (tester) async {
      await pump(
        tester,
        ConflictBanner(
          conflict: const CheckoutConflict(
            kind: CheckoutConflictKind.vehicleConflict,
            message: 'Vehicle conflict with reservation RES-2465',
            code: 'VEHICLE_CONFLICT',
            swapAvailable: false,
            conflictReservationRef: 'RES-2465',
          ),
          onDismiss: () {},
          onSearchReservation: () {},
        ),
      );
      expect(
        find.textContaining('can no longer be swapped from here'),
        findsOneWidget,
      );
      expect(find.text('Pick another vehicle'), findsNothing);
      // La búsqueda SÍ puede tener éxito: es una ruta local.
      expect(find.text('Search RES-2465'), findsOneWidget);
    });

    testWidgets('22C sin número legible el CTA de búsqueda desaparece',
        (tester) async {
      await pump(
        tester,
        ConflictBanner(
          conflict: const CheckoutConflict(
            kind: CheckoutConflictKind.vehicleConflict,
            message: 'La unidad no está disponible en esa ventana.',
            code: 'VEHICLE_CONFLICT',
            swapAvailable: true,
          ),
          onDismiss: () {},
          onSearchReservation: () {},
        ),
      );
      expect(find.textContaining('Search'), findsNothing);
      expect(find.text('La unidad no está disponible en esa ventana.'),
          findsOneWidget);
    });

    testWidgets('SESSION_TERMINAL no inventa una salida: terminal significa '
        'terminal', (tester) async {
      await pump(
        tester,
        ConflictBanner(
          conflict: const CheckoutConflict(
            kind: CheckoutConflictKind.terminal,
            message: 'Session is already terminal',
            code: 'SESSION_TERMINAL',
          ),
          onDismiss: () {},
          onGoToStep: () {},
          onOpenOutbox: () {},
          onSearchReservation: () {},
          pendingUploads: 3,
        ),
      );
      // Solo "Got it": ni Bandeja, ni navegación, ni búsqueda.
      expect(find.byType(BannerAction), findsOneWidget);
      expect(find.text('Got it'), findsOneWidget);
    });
  });

  group('21B — "Qué cambió desde que entraste"', () {
    CheckoutChangeSet set({int pending = 0}) => buildChangeSet(
          baseline: sessionAt(CheckoutStep.tcPending),
          current: sessionAt(
            CheckoutStep.paymentPending,
            tc: DateTime.utc(2026, 8, 28, 10, 27),
            kiosk: true,
            actorUserId: null,
          ),
          observedAt: now,
          myUserId: kMyUserId,
        );

    testWidgets('primero lo que se movió, luego el inventario COMPLETO, y al '
        'final la única frase que el agente vino a leer', (tester) async {
      await pump(
        tester,
        ChangedSheet(
          changes: set(),
          currentPosition: 4,
          pendingUploads: 0,
          onStay: () {},
        ),
      );
      expect(find.text('The step moved'), findsOneWidget);
      // Las pendientes NO se esconden: sin ellas falta media respuesta.
      expect(find.text('Pending · nobody has touched it'), findsNWidgets(3));
      expect(find.text('Nothing you did was lost.'), findsOneWidget);
      expect(find.text('Stay on step 4'), findsOneWidget);
    });

    testWidgets('con evidencia sin enviar la franja cambia a ámbar y NOMBRA '
        'cuánta — nunca se queda en verde por comodidad', (tester) async {
      await pump(
        tester,
        ChangedSheet(
          changes: set(),
          currentPosition: 4,
          pendingUploads: 1,
          onStay: () {},
        ),
      );
      expect(find.text('Nothing you did was lost.'), findsNothing);
      // Y el plural va bien formado: "1 upload", no "1 uploads".
      expect(
        find.textContaining('Careful: 1 upload has not reached the server'),
        findsOneWidget,
      );

      await pump(
        tester,
        ChangedSheet(
          changes: set(),
          currentPosition: 4,
          pendingUploads: 3,
          onStay: () {},
        ),
      );
      expect(
        find.textContaining('Careful: 3 uploads have not reached the server'),
        findsOneWidget,
      );
    });

    testWidgets('sin posición en el catálogo el CTA pierde el número, no la '
        'existencia', (tester) async {
      await pump(
        tester,
        ChangedSheet(
          changes: set(),
          currentPosition: null,
          pendingUploads: 0,
          onStay: () {},
        ),
      );
      expect(find.text('Close'), findsOneWidget);
    });
  });

  group('23 — la antesala de enganche', () {
    testWidgets('23A cuenta qué hay hecho, qué falta y entra al paso que '
        'reporta el SERVIDOR', (tester) async {
      var continued = 0;
      await pump(
        tester,
        CheckoutJoinView(
          session: sessionAt(
            CheckoutStep.inspectionHandoff,
            tc: DateTime.utc(2026, 8, 28, 10, 19),
            payment: DateTime.utc(2026, 8, 28, 10, 41),
            actorUserId: null,
            kiosk: true,
          ),
          position: 6,
          roster: const [],
          myUserId: kMyUserId,
          onContinue: () => continued++,
          onLeave: () {},
        ),
      );
      expect(find.textContaining("it's on step 6 of 10"), findsOneWidget);
      expect(find.text("What's already done"), findsOneWidget);
      expect(find.text('3 of 5 phases'), findsOneWidget);
      expect(find.text("What's left"), findsOneWidget);
      expect(
        find.text('You enter the step the server reports, not the one anyone '
            'left. Nothing is redone.'),
        findsOneWidget,
      );
      await tester.tap(find.text('Continue from step 6'));
      expect(continued, 1);
    });

    testWidgets('23B con el kiosco VIVO cambia el consejo y el PESO de los '
        'botones — nunca el permiso', (tester) async {
      var continued = 0;
      await pump(
        tester,
        CheckoutJoinView(
          session: sessionAt(CheckoutStep.customerSignPending),
          position: 8,
          roster: presenceRoster(
            [presence('KIOSK', name: 'Kiosk')],
            now,
          ),
          myUserId: kMyUserId,
          onContinue: () => continued++,
          onLeave: () {},
        ),
      );
      expect(find.text('The customer is on the kiosk right now.'),
          findsOneWidget);
      // La tarjeta de consejo vive al fondo del scroll: se busca donde está.
      await tester.scrollUntilVisible(
        find.textContaining('This is not a block. You can move ahead'),
        200,
        scrollable: find.byType(Scrollable).first,
      );
      expect(
        find.textContaining('This is not a block. You can move ahead'),
        findsOneWidget,
      );
      // El CTA sigue EXISTIENDO — solo baja a fantasma.
      final proceed =
          find.widgetWithText(RideGhostButton, 'Move ahead anyway');
      expect(proceed, findsOneWidget);
      await tester.tap(proceed);
      expect(continued, 1, reason: 'presencia que bloquea sería un lease');
    });

    testWidgets('23C muestra `abandonedReason`: es el dato que decide si '
        'conviene continuar', (tester) async {
      final raw = rawCheckoutSession();
      raw['currentStep'] = 'TC_PENDING';
      raw['abandonedAt'] = '2026-08-28T09:43:00.000Z';
      raw['abandonedReason'] = 'el cliente fue por su tarjeta';
      await pump(
        tester,
        CheckoutJoinView(
          session: sessionFromRaw(raw),
          position: 2,
          roster: const [],
          myUserId: kMyUserId,
          onContinue: () {},
          onLeave: () {},
        ),
      );
      expect(find.textContaining('was left paused'), findsOneWidget);
      expect(find.text('Reason: “el cliente fue por su tarjeta”'),
          findsOneWidget);
      expect(find.text('Where it stopped'), findsOneWidget);
      // Y se dice que continuar no "roba" nada: no existe tomar el control.
      expect(
        find.textContaining('Continuing takes nothing away from anyone'),
        findsOneWidget,
      );
    });
  });

  group('review de GD · lo que se había recortado y vuelve', () {
    testWidgets('21D · la pantalla terminal responde "¿perdí mi trabajo?" — el '
        'log dice quién movió la SESIÓN, esto dice si lo mío llegó',
        (tester) async {
      final session =
          sessionAt(CheckoutStep.closed, kiosk: true, actorUserId: null);

      await pump(
        tester,
        CheckoutTerminalView(
          session: session,
          myUserId: kMyUserId,
          onExit: () {},
        ),
      );
      expect(find.text('Nothing you did was lost.'), findsOneWidget);

      // El escenario del marco: el kiosco cierra mientras el agente captura y
      // quedan fotos huérfanas. El log NO las menciona —nunca fueron un evento
      // de la sesión— así que sin esta franja la pantalla se quedaba callada.
      await pump(
        tester,
        CheckoutTerminalView(
          session: session,
          myUserId: kMyUserId,
          pendingUploads: 2,
          onExit: () {},
        ),
      );
      expect(find.text('Nothing you did was lost.'), findsNothing);
      expect(
        find.textContaining('Careful: 2 uploads have not reached the server'),
        findsOneWidget,
      );
    });

    testWidgets('22D · el motivo de la cancelación se TRADUCE o se calla: '
        'nunca un token de máquina en la cara del agente', (tester) async {
      Future<void> withReason(String? reason) async {
        final raw = rawCheckoutSession();
        raw['currentStep'] = 'CANCELLED';
        raw['abandonedAt'] = '2026-08-28T10:58:00.000Z';
        raw['abandonedReason'] = reason;
        await pump(
          tester,
          CheckoutTerminalView(
            session: sessionFromRaw(raw),
            myUserId: kMyUserId,
            onExit: () {},
          ),
        );
      }

      await withReason('agent_paused');
      expect(find.textContaining('agent_paused'), findsNothing);

      await withReason('auto_flagged_stalled_at_tc_pending');
      expect(find.textContaining('auto_flagged'), findsNothing);
      expect(find.textContaining('The system flagged it'), findsOneWidget);

      await withReason('el cliente no se presentó');
      expect(find.textContaining('el cliente no se presentó'), findsOneWidget);
    });

    testWidgets('23C · el barrido nocturno NO se atribuye a "otro agente": '
        'nadie la pausó, la marcó un cron', (tester) async {
      Future<void> withReason(String reason) async {
        final raw = rawCheckoutSession();
        raw['currentStep'] = 'TC_PENDING';
        raw['abandonedAt'] = '2026-08-28T05:12:00.000Z';
        raw['abandonedReason'] = reason;
        await pump(
          tester,
          CheckoutJoinView(
            session: sessionFromRaw(raw),
            position: 2,
            roster: const [],
            myUserId: kMyUserId,
            onContinue: () {},
            onLeave: () {},
          ),
        );
      }

      // `auto_flagged_stalled_at_<paso>` lo escribe el scheduler (:70-71).
      // Decir "otro agente la pausó" inventaría un culpable de algo que hizo
      // un cron — y el agente saldría a buscar a un compañero que no existe.
      await withReason('auto_flagged_stalled_at_tc_pending');
      expect(find.textContaining('The system flagged this departure'),
          findsOneWidget);
      expect(find.textContaining('paused this departure'), findsNothing);
      expect(find.textContaining('was left paused'), findsNothing);
      // Y la línea de motivo explica QUÉ pasó, sin enseñar el token.
      expect(find.textContaining("it's been stopped for over 4 h"),
          findsOneWidget);
      expect(find.textContaining('auto_flagged'), findsNothing);

      // Una pausa de verdad sigue diciendo lo suyo.
      await withReason('el cliente fue por su tarjeta');
      expect(find.textContaining('The system flagged'), findsNothing);
      expect(find.textContaining('was left paused'), findsOneWidget);
    });

    testWidgets('20B · vacío Y sin red se dice "no verificable", que NO es lo '
        'mismo que "nadie visible"', (tester) async {
      await pump(
        tester,
        WhoIsHereSheet(
          roster: const [],
          myName: 'Ana Ruiz',
          offline: true,
          onClose: () {},
        ),
      );
      expect(
        find.textContaining("we can't state that anyone is here right now"),
        findsWidgets,
      );
      expect(find.textContaining('Nobody is visible right now'), findsNothing);
      // Y en ninguno de los dos casos se dice "estás solo".
      expect(find.textContaining('alone'), findsNothing);
    });

    testWidgets('el chip distingue persona de aparato SIN leer el nombre',
        (tester) async {
      await pump(
        tester,
        Align(
          alignment: Alignment.topLeft,
          child: PresenceChip(
            data: pickPresenceChip(
              [presence('COUNTER', name: 'Diego Torres')],
              now,
            ),
          ),
        ),
      );
      expect(find.text('DT'), findsOneWidget);
      expect(find.byIcon(Icons.desktop_windows_outlined), findsNothing);

      await pump(
        tester,
        Align(
          alignment: Alignment.topLeft,
          child: PresenceChip(
            data: pickPresenceChip(
              [presence('KIOSK', name: 'The lobby kiosk')],
              now,
            ),
          ),
        ),
      );
      // Glifo, no iniciales: un círculo con "TL" disfrazaría al mueble de
      // persona, que es la confusión que la distinción existe para evitar.
      expect(find.byIcon(Icons.desktop_windows_outlined), findsOneWidget);
      expect(find.text('TL'), findsNothing);
    });

    testWidgets('el chip no aplasta al CLIENTE a 360 dp', (tester) async {
      tester.view.physicalSize = const Size(360, 780);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.reset);
      await pump(
        tester,
        SessionHead(
          context_: const CheckoutReservationContext(
            customerName: 'Guillermina de la Concepción Villaseñor',
            vehicleLabel: 'Corolla 2023',
          ),
          presence: pickPresenceChip(
            [presence('COUNTER', name: 'Maximiliano Echeverría Salas')],
            now,
          ),
          mini: true,
          onPresenceTap: () {},
        ),
      );
      expect(
        tester.getSize(find.byType(PresenceChip)).width,
        lessThanOrEqualTo(360 * 0.5),
        reason: 'el tope proporcional deja sitio al cliente',
      );
      expect(find.textContaining('Guillermina'), findsOneWidget);
    });

    testWidgets('22B · el ENCUADRE se muestra SIEMPRE, también con la Bandeja '
        'en cero', (tester) async {
      await pump(
        tester,
        ConflictBanner(
          conflict: const CheckoutConflict(
            kind: CheckoutConflictKind.entryGuard,
            message: 'Cannot enter CUSTOMER_SIGN_PENDING: '
                'inspectionCompletedAt is not stamped yet',
            code: 'ENTRY_GUARD',
          ),
          onDismiss: () {},
          onOpenOutbox: () {},
        ),
      );
      // Sin esto, el agente que ACABA de terminar la inspección lee "falta la
      // inspección completada" y no tiene nada que explique la brecha entre lo
      // que ve en su teléfono y lo que el servidor tiene.
      expect(
        find.textContaining('The server closes this step when the stamp lands'),
        findsOneWidget,
      );
      // Y el CTA sigue sin dibujarse: no hay nada que drenar.
      expect(find.textContaining('Open the Outbox'), findsNothing);
    });

    testWidgets('22C · responde "qué se conserva", como el resto de la matriz',
        (tester) async {
      await pump(
        tester,
        ConflictBanner(
          conflict: const CheckoutConflict(
            kind: CheckoutConflictKind.vehicleConflict,
            message: 'Vehicle conflict with reservation RES-2465',
            code: 'VEHICLE_CONFLICT',
            swapAvailable: true,
          ),
          onDismiss: () {},
        ),
      );
      expect(find.textContaining('Kept: the customer already verified'),
          findsOneWidget);
    });
  });
}
