import 'dart:async';
import 'dart:convert';

import 'package:clock/clock.dart';
import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:rideops/core/api/api_error.dart';
import 'package:rideops/core/api/api_providers.dart';
import 'package:rideops/core/api/dto/available_vehicle.dart';
import 'package:rideops/core/api/enums.dart';
import 'package:rideops/core/l10n/app_localizations.dart';
import 'package:rideops/core/outbox/network_status.dart';
import 'package:rideops/core/router/app_router.dart';
import 'package:rideops/core/session/active_location.dart';
import 'package:rideops/core/session/session_controller.dart';
import 'package:rideops/core/session/session_state.dart';
import 'package:rideops/core/telemetry/event_logger.dart';
import 'package:rideops/core/widgets/ride_buttons.dart';
import 'package:rideops/features/checkout/application/checkout_wizard_controller.dart';
import 'package:rideops/features/checkout/presentation/checkout_wizard_screen.dart';
import 'package:rideops/features/checkout/presentation/widgets/vehicle_swap_sheet.dart';
import 'package:rideops/features/checkout/presentation/widgets/verify_cards.dart';
import 'package:rideops/features/checkout/presentation/widgets/wizard_chrome.dart';

import 'helpers/auth_test_helpers.dart';
import 'helpers/checkout_test_helpers.dart';
import 'helpers/outbox_test_helpers.dart';
import 'helpers/shell_test_helpers.dart';

/// Tabla de estados del paso CONFIRMING (mockup 9A-9E). Locale `en` como el
/// resto de la suite; se asierta contra app_en.arb.

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
  }) fakes({bool online = true}) => (
        api: FakeCheckoutApi()..current = sessionAt(CheckoutStep.confirming),
        reservations: FakeReservationsApi(),
        network: FakeNetworkStatus(online: online),
        logger: CapturingEventLogger(),
      );

  /// [settle] a false para los frames con un spinner VIVO: un
  /// `CircularProgressIndicator` anima indefinidamente y `pumpAndSettle`
  /// expira esperando un reposo que nunca llega (misma razón por la que la
  /// prueba GD-MC-5 usa `pump()` a secas).
  Future<void> pumpConfirming(
    WidgetTester tester, {
    required FakeCheckoutApi api,
    required FakeReservationsApi reservations,
    required FakeNetworkStatus network,
    required CapturingEventLogger logger,
    bool settle = true,
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
      await tester.pumpAndSettle();
    } else {
      await tester.pump();
      await tester.pump();
    }
    // M2-H6: entrar a media sesión muestra primero la antesala de enganche
    // (23A). Estos tests prueban el CUERPO del paso, así que la cruzan; la
    // antesala tiene su propia suite (checkout_join_test.dart).
    await skipJoinGate(tester);
  }

  /// El contenedor VIVO de la app montada — mismo patrón que
  /// checkout_inspection_test.dart:123. MC-2 lo necesita porque su escenario
  /// (datos completos, re-lectura que falla) no tiene botón que tocar: con la
  /// tarjeta verde el pie no ofrece nada, que es justo el punto.
  ProviderContainer container(WidgetTester tester) =>
      ProviderScope.containerOf(
        tester.element(find.byType(CheckoutWizardScreen)),
      );

  /// La tarjeta del VEHÍCULO, por su título. Se mira el widget y no un texto
  /// suelto porque lo que se afirma es el tono y la pastilla —las dos señales
  /// de vejez— y "Available" o "seen 3 min ago" sueltos en la pantalla no
  /// dicen en cuál de las dos tarjetas salieron.
  VerifyCard vehicleCard(WidgetTester tester) => tester.widget<VerifyCard>(
        find.ancestor(
          of: find.text('Vehicle'),
          matching: find.byType(VerifyCard),
        ),
      );

  /// El cuerpo del paso es un scroll: en el lienzo del test (600 px de alto)
  /// el switch del seguro cae bajo la línea de flotación, igual que en un
  /// teléfono real con las dos tarjetas abiertas.
  Future<void> scrollBody(WidgetTester tester, Finder target) async {
    await tester.scrollUntilVisible(
      target,
      120,
      scrollable: find.byType(Scrollable).first,
    );
    await tester.pumpAndSettle();
  }

  testWidgets('9A — todo verificado: dos tarjetas con los datos que el agente '
      'confronta, switch apagado con su consecuencia en palabras, CTA vivo',
      (tester) async {
    final f = fakes();
    await pumpConfirming(
      tester,
      api: f.api,
      reservations: f.reservations,
      network: f.network,
      logger: f.logger,
    );

    expect(find.text('Customer'), findsOneWidget);
    expect(find.text('Vehicle'), findsOneWidget);
    expect(find.text('Verified'), findsOneWidget);
    expect(find.text('María González'), findsOneWidget);
    // Licencia CON vencimiento: el número vive en el cliente, la caducidad en
    // el snapshot del contrato.
    expect(find.textContaining('B-4482913'), findsOneWidget);
    expect(find.textContaining('expires'), findsOneWidget);
    expect(find.text('+52 998 123 4567'), findsOneWidget);
    // El estado del vehículo se afirma solo porque el servidor dice AVAILABLE.
    expect(find.text('Available'), findsOneWidget);
    // Millas, no kilómetros: es lo que factura el backend (computeExcessMileage
    // cobra por milla) y lo que rotula el mostrador web.
    expect(find.textContaining('48,190 mi'), findsOneWidget);
    // El switch dice su estado EN PALABRAS, no solo con color.
    await scrollBody(tester, find.text('Customer declines insurance'));
    expect(find.text('Customer declines insurance'), findsOneWidget);
    expect(find.textContaining('standard coverage is charged'), findsOneWidget);
    // Y el CTA de avance está vivo.
    final cta = tester.widget<RidePrimaryButton>(
      find.widgetWithText(RidePrimaryButton, 'Continue to T&C'),
    );
    expect(cta.onPressed, isNotNull);
    // Canon del header: pantalla de paso ⇒ variante mini.
    expect(
      tester.widget<SessionHead>(find.byType(SessionHead)).mini,
      isTrue,
      reason: 'la pantalla tiene cuerpo propio: el header va compacto',
    );
  });

  testWidgets('9A — el CTA transiciona a TC_PENDING (destino de la PANTALLA, '
      'no inferido del catálogo)', (tester) async {
    final f = fakes();
    await pumpConfirming(
      tester,
      api: f.api,
      reservations: f.reservations,
      network: f.network,
      logger: f.logger,
    );

    f.api.current = sessionAt(CheckoutStep.tcPending);
    await tester.tap(find.text('Continue to T&C'));
    await tester.pumpAndSettle();

    expect(f.api.transitions, ['TC_PENDING']);
  });

  testWidgets('9B — datos incompletos: el CTA NO se esconde, se bloquea '
      'diciendo qué falta y dónde, y deja una salida real', (tester) async {
    final f = fakes();
    // El servidor manda una reserva sin licencia ni teléfono capturados.
    f.reservations.patchDisplayData = (raw) {
      final reservation = raw['reservation'] as Map<String, dynamic>;
      final customer = reservation['customer'] as Map<String, dynamic>;
      customer['licenseNumber'] = null;
      customer['phone'] = '';
      final agreement = reservation['rentalAgreement'] as Map<String, dynamic>;
      agreement['licenseNumber'] = null;
      agreement['customerPhone'] = null;
      return raw;
    };
    await pumpConfirming(
      tester,
      api: f.api,
      reservations: f.reservations,
      network: f.network,
      logger: f.logger,
    );

    // El CTA sigue en pantalla (un botón ausente no se puede preguntar).
    final cta = tester.widget<RidePrimaryButton>(
      find.widgetWithText(RidePrimaryButton, 'Continue to T&C'),
    );
    expect(cta.onPressed, isNull);
    // Con QUÉ falta, nombrado, y DÓNDE se resuelve.
    expect(find.textContaining('the license and the phone'), findsOneWidget);
    expect(find.textContaining('counter'), findsOneWidget);
    // Cada dato faltante se ve como faltante, no como hueco.
    expect(find.text('Not captured'), findsNWidgets(2));
    expect(find.text('Missing data'), findsOneWidget);
    // Y la salida: volver a preguntarle al servidor (RideOps no captura datos
    // del cliente — eso vive en el mostrador). La etiqueta NOMBRA el objeto:
    // "Volver a consultar" no decía qué se consultaba (GD-MC-5a).
    expect(find.text('Refresh customer data'), findsOneWidget);
    final before = f.reservations.displayDataCalls;
    await tester.tap(find.text('Refresh customer data'));
    await tester.pumpAndSettle();
    expect(f.reservations.displayDataCalls, greaterThan(before));
    // Y el ACUSE: la consulta terminó y el servidor sigue sin los datos
    // (GD-MC-5b — antes esto no mostraba absolutamente nada).
    expect(
      find.textContaining(
        "Checked just now: the server still doesn't have the license and the "
        'phone',
      ),
      findsOneWidget,
    );
  });

  testWidgets('GD-MC-5 — mientras la re-consulta está en vuelo el botón lo '
      'MUESTRA: spinner + texto de progreso, y no admite un segundo toque',
      (tester) async {
    final f = fakes();
    f.reservations.patchDisplayData = (raw) {
      final reservation = raw['reservation'] as Map<String, dynamic>;
      (reservation['customer'] as Map<String, dynamic>)['phone'] = null;
      (reservation['rentalAgreement'] as Map<String, dynamic>)['customerPhone'] =
          null;
      return raw;
    };
    await pumpConfirming(
      tester,
      api: f.api,
      reservations: f.reservations,
      network: f.network,
      logger: f.logger,
    );

    // La lectura de sesión se queda colgada: el botón tiene que declararlo.
    final gate = Completer<void>();
    f.api.onGet = () async {
      await gate.future;
      return f.api.current!;
    };

    await tester.tap(find.text('Refresh customer data'));
    await tester.pump();

    expect(find.text('Asking the server…'), findsOneWidget);
    final ghost = tester.widget<RideGhostButton>(
      find.byType(RideGhostButton),
    );
    expect(ghost.loading, isTrue);
    final callsWhileBusy = f.reservations.displayDataCalls;
    await tester.tap(find.byType(RideGhostButton), warnIfMissed: false);
    await tester.pump();
    expect(f.reservations.displayDataCalls, callsWhileBusy,
        reason: 'un segundo toque con una consulta viva no manda otra');

    gate.complete();
    await tester.pumpAndSettle();
    expect(find.text('Refresh customer data'), findsOneWidget);
  });

  testWidgets('INN-MC-3 — reserva de cortesía (DEALERSHIP_LOANER): el switch '
      'del seguro NO existe; un anexo de rechazo sobre un contrato de cero no '
      'tiene sentido y el web ya lo esconde', (tester) async {
    final f = fakes();
    f.reservations.patchDisplayData = (raw) {
      (raw['reservation'] as Map<String, dynamic>)['workflowMode'] =
          'DEALERSHIP_LOANER';
      return raw;
    };
    await pumpConfirming(
      tester,
      api: f.api,
      reservations: f.reservations,
      network: f.network,
      logger: f.logger,
    );

    expect(find.byType(Switch), findsNothing);
    expect(find.text('Customer declines insurance'), findsNothing);
    // El resto del paso sigue completo: lo que se retira es UNA decisión que
    // no aplica, no la verificación.
    expect(find.text('Customer'), findsOneWidget);
    expect(find.text('Vehicle'), findsOneWidget);
    expect(
      tester
          .widget<RidePrimaryButton>(
            find.widgetWithText(RidePrimaryButton, 'Continue to T&C'),
          )
          .onPressed,
      isNotNull,
    );
  });

  testWidgets('una reserva RENTAL conserva el switch (el gate es el modo, no '
      'un default silencioso)', (tester) async {
    final f = fakes();
    await pumpConfirming(
      tester,
      api: f.api,
      reservations: f.reservations,
      network: f.network,
      logger: f.logger,
    );
    await scrollBody(tester, find.byType(Switch));
    expect(find.byType(Switch), findsOneWidget);
  });

  testWidgets('GD-MC-6 — la fila de pre-checkin no tartamudea: la clave nombra '
      'el campo y el VALOR dice estado y hora', (tester) async {
    final f = fakes();
    await pumpConfirming(
      tester,
      api: f.api,
      reservations: f.reservations,
      network: f.network,
      logger: f.logger,
    );

    expect(find.text('Pre-check-in'), findsOneWidget);
    expect(find.textContaining('Completed '), findsOneWidget);
    expect(find.text('Pre-check-in done'), findsNothing);
  });

  testWidgets('GD-SC-4 — la fila del switch es tocable ENTERA, no solo el '
      'switch pegado al borde', (tester) async {
    final f = fakes();
    await pumpConfirming(
      tester,
      api: f.api,
      reservations: f.reservations,
      network: f.network,
      logger: f.logger,
    );

    await scrollBody(tester, find.text('Customer declines insurance'));
    // Se toca el TÍTULO, en el extremo opuesto al switch.
    await tester.tap(find.text('Customer declines insurance'));
    await tester.pumpAndSettle();

    expect(f.api.declinedValues, [true]);
  });

  testWidgets('INN-S-2 — 409 sobre la unidad elegida: causa TRADUCIDA encima '
      'del cuerpo del servidor (que sigue visible con su dato)', (tester) async {
    final f = fakes();
    await pumpConfirming(
      tester,
      api: f.api,
      reservations: f.reservations,
      network: f.network,
      logger: f.logger,
    );

    f.api.onSwapVehicle = (_) async => throw ApiError(
          kind: ApiErrorKind.conflict,
          status: 409,
          code: 'VEHICLE_DOUBLE_BOOKED',
          message: 'Vehicle already reserved on this window (R-2470)',
        );

    await scrollBody(tester, find.text('Change vehicle'));
    await tester.tap(find.text('Change vehicle'));
    await tester.pumpAndSettle();
    await tester.tap(find.textContaining('U-118'));
    await tester.pumpAndSettle();
    await tester.tap(find.textContaining('Switch to U-118'));
    await tester.pumpAndSettle();

    expect(
      find.text('That unit is already reserved for this same window.'),
      findsOneWidget,
    );
    expect(find.textContaining('R-2470'), findsOneWidget,
        reason: 'DoD #5: el cuerpo del servidor no se sustituye, se enmarca');
  });

  testWidgets('INN-S-2 — 409 SWAP_LOCKED: el banner traduce la causa y el '
      'enum crudo del servidor deja de ser la única explicación', (tester) async {
    final f = fakes();
    await pumpConfirming(
      tester,
      api: f.api,
      reservations: f.reservations,
      network: f.network,
      logger: f.logger,
    );

    f.api.onSwapVehicle = (_) async => throw ApiError(
          kind: ApiErrorKind.conflict,
          status: 409,
          code: 'SWAP_LOCKED',
          message: 'Cannot swap vehicle once inspection has started '
              '(currentStep=INSPECTION_IN_PROGRESS)',
        );

    await scrollBody(tester, find.text('Change vehicle'));
    await tester.tap(find.text('Change vehicle'));
    await tester.pumpAndSettle();
    await tester.tap(find.textContaining('U-118'));
    await tester.pumpAndSettle();
    await tester.tap(find.textContaining('Switch to U-118'));
    await tester.pumpAndSettle();

    expect(find.text('The server refused the vehicle change'), findsOneWidget);
    expect(
      find.text("This session's inspection already started: from there on the "
          'unit cannot be changed.'),
      findsOneWidget,
    );
    // El cuerpo del servidor sigue ahí, enum crudo incluido (DoD #5).
    expect(find.textContaining('currentStep=INSPECTION_IN_PROGRESS'),
        findsOneWidget);
  });

  testWidgets('MC-4 (parcial) — la unidad inerte no cita al servidor en un '
      'renglón de 12.5 px: usa copy propia cuando hay conflicto vivo',
      (tester) async {
    final f = fakes();
    await pumpConfirming(
      tester,
      api: f.api,
      reservations: f.reservations,
      network: f.network,
      logger: f.logger,
    );

    f.api.onTransition = (_) async => throw ApiError(
          kind: ApiErrorKind.conflict,
          status: 409,
          code: 'VEHICLE_CONFLICT',
          message: 'Vehicle is still out on open rental R-2466 — complete its '
              'check-in (or swap vehicles) first',
        );
    await tester.tap(find.text('Continue to T&C'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Pick another vehicle'));
    await tester.pumpAndSettle();

    expect(
      find.text('Current unit · the server reports it committed to another '
          'rental'),
      findsOneWidget,
    );
    // La cita íntegra del servidor vive donde sí cabe: el banner del paso —
    // que desde M2-H6 además ofrece buscar la otra reserva (22C), así que el
    // número aparece dos veces a propósito: en la cita y en la acción.
    expect(
      find.text(
        'Vehicle is still out on open rental R-2466 — complete its check-in '
        '(or swap vehicles) first',
      ),
      findsOneWidget,
    );
    expect(find.text('Search R-2466'), findsOneWidget);
  });

  /// GD-MC-7 / GD-SC-1 se prueban sobre las primitivas y no sobre el paso
  /// entero: lo que se está midiendo es la GEOMETRÍA de la tarjeta con el texto
  /// del sistema en grande, y montar el wizard completo metería el dock y la
  /// lista en la misma medición.
  Future<void> pumpCard(WidgetTester tester, double scale, Widget card) async {
    await tester.pumpWidget(
      MaterialApp(
        localizationsDelegates: const [
          AppLocalizations.delegate,
          GlobalMaterialLocalizations.delegate,
          GlobalWidgetsLocalizations.delegate,
          GlobalCupertinoLocalizations.delegate,
        ],
        supportedLocales: const [Locale('es'), Locale('en')],
        home: MediaQuery(
          data: MediaQueryData(textScaler: TextScaler.linear(scale)),
          // 360 dp: el teléfono chico del patio.
          child: Center(child: SizedBox(width: 360, child: card)),
        ),
      ),
    );
    await tester.pumpAndSettle();
  }

  testWidgets('GD-MC-7 — el encabezado de VerifyCard no desborda a escala 2.0: '
      'el pill baja de renglón en vez de romper la fila', (tester) async {
    await pumpCard(
      tester,
      2.0,
      const VerifyCard(
        title: 'Registro',
        tone: VerifyTone.ok,
        pillLabel: 'Confirmado por el servidor',
        children: [KvRow(label: 'Firmado', value: '09:47')],
      ),
    );

    expect(tester.takeException(), isNull);
    expect(find.byType(VerifyCard), findsOneWidget);
  });

  testWidgets('GD-SC-1 — a escala grande la fila clave-valor se APILA: la '
      'clave deja de recortarse contra un ancho fijo', (tester) async {
    const row = KvRow(label: 'Odómetro', value: '48 190 km');
    await pumpCard(tester, 1.0, const VerifyCard(title: 'x', children: [row]));
    final tight = tester.getTopLeft(find.text('48 190 km')).dy;
    final labelTop = tester.getTopLeft(find.text('Odómetro')).dy;
    expect(tight, labelTop, reason: 'a escala normal van en la misma línea');

    await pumpCard(tester, 2.0, const VerifyCard(title: 'x', children: [row]));
    expect(
      tester.getTopLeft(find.text('48 190 km')).dy,
      greaterThan(tester.getTopLeft(find.text('Odómetro')).dy),
      reason: 'a escala 2.0 el valor baja debajo de su clave',
    );
    expect(tester.takeException(), isNull);
  });

  testWidgets('9C — declinar el seguro: POST, consecuencia declarada y '
      'ventana de arrepentimiento; el estado sale del servidor', (tester) async {
    final f = fakes();
    await pumpConfirming(
      tester,
      api: f.api,
      reservations: f.reservations,
      network: f.network,
      logger: f.logger,
    );

    // La respuesta del POST trae el evento recién escrito: la UI se re-dibuja
    // DESDE ahí, no desde un estado local del switch.
    final raw = rawCheckoutSession();
    raw['currentStep'] = CheckoutStep.confirming.wire;
    // El fixture trae sellos de una sesión avanzada; en el paso 1 no hay
    // ninguno (y con tcCompletedAt el switch se cerraría, que es otro caso).
    raw['tcCompletedAt'] = null;
    raw['paymentCompletedAt'] = null;
    raw['inspectionCompletedAt'] = null;
    raw['customerSignedAt'] = null;
    raw['events'] = json.encode([
      {'kind': 'SESSION_STARTED', 'actorUserId': kMyUserId},
      {'kind': 'DECLINED_INSURANCE', 'declined': true, 'actorUserId': kMyUserId},
    ]);
    f.api.onDeclinedInsurance = (declined) async => sessionFromRaw(raw);

    await scrollBody(tester, find.byType(Switch));
    await tester.tap(find.byType(Switch));
    await tester.pumpAndSettle();

    expect(f.api.declinedValues, [true]);
    expect(tester.widget<Switch>(find.byType(Switch)).value, isTrue);
    await scrollBody(tester, find.textContaining('coverage-decline addendum'));
    expect(find.textContaining('coverage-decline addendum'), findsOneWidget);
    expect(
      find.textContaining('while the terms are unsigned'),
      findsOneWidget,
      reason: 'la ventana de arrepentimiento se declara con la consecuencia',
    );
    // Sin diálogo de confirmación a propósito (nota 6).
    expect(find.byType(AlertDialog), findsNothing);
    expect(
      f.logger.events.where((e) => e.$1 == 'checkout.declined_insurance_set'),
      hasLength(1),
    );
  });

  testWidgets('9C — con T&C ya firmado el switch se apaga CON causa: el anexo '
      'firmado no puede cambiar aquí', (tester) async {
    final f = fakes();
    f.api.current = sessionAt(
      CheckoutStep.confirming,
      tc: DateTime.now().subtract(const Duration(minutes: 3)),
    );
    await pumpConfirming(
      tester,
      api: f.api,
      reservations: f.reservations,
      network: f.network,
      logger: f.logger,
    );

    await scrollBody(tester, find.byType(Switch));
    expect(tester.widget<Switch>(find.byType(Switch)).onChanged, isNull);
    expect(find.textContaining('Terms are already signed'), findsOneWidget);
  });

  testWidgets('sin red: ni switch ni swap salen a la red, y cada bloqueo dice '
      'su causa (ADR-5: ningún paso se encola)', (tester) async {
    final f = fakes();
    await pumpConfirming(
      tester,
      api: f.api,
      reservations: f.reservations,
      network: f.network,
      logger: f.logger,
    );
    // Offline HONESTO como lo define el shell (8D): no basta el plugin de
    // conectividad — la lectura tiene que morir sin respuesta.
    f.api.onGet = () async =>
        throw ApiError(kind: ApiErrorKind.network, message: 'sin red');
    f.network.online = false;
    await tester.pump(const Duration(seconds: 5));
    await tester.pumpAndSettle();

    await scrollBody(tester, find.byType(Switch));
    expect(tester.widget<Switch>(find.byType(Switch)).onChanged, isNull);
    expect(find.textContaining('recorded by the server'), findsOneWidget);
    // El enlace de swap no se ofrece sin servidor: su lista y su escritura son
    // del servidor.
    expect(find.text('Change vehicle'), findsNothing);
    expect(f.api.declinedInsuranceCalls, 0);
  });

  testWidgets('9D — 409 VEHICLE_CONFLICT con sesión viva: negativa del '
      'servidor + tarjeta en conflicto + UNA salida primaria al swap',
      (tester) async {
    final f = fakes();
    await pumpConfirming(
      tester,
      api: f.api,
      reservations: f.reservations,
      network: f.network,
      logger: f.logger,
    );

    f.api.onTransition = (_) async => throw ApiError(
          kind: ApiErrorKind.conflict,
          status: 409,
          code: 'VEHICLE_CONFLICT',
          message: 'Vehicle is still out on open rental R-2466 — complete its '
              'check-in (or swap vehicles) first',
        );
    await tester.tap(find.text('Continue to T&C'));
    await tester.pumpAndSettle();

    // Mensaje del servidor tal cual (el código de máquina jamás se muestra).
    expect(
      find.text(
        'Vehicle is still out on open rental R-2466 — complete its check-in '
        '(or swap vehicles) first',
      ),
      findsOneWidget,
    );
    expect(find.textContaining('VEHICLE_CONFLICT'), findsNothing);
    expect(find.text('In conflict'), findsOneWidget);
    // M2-H6 (22C): el número de la OTRA reserva se lee del texto del servidor
    // y se convierte en una acción que sí puede tener éxito — la búsqueda es
    // una ruta local (`/search?q=`) que ya existe desde H7.
    expect(find.text('Search R-2466'), findsOneWidget);
    // Y sigue habiendo UNA sola salida primaria: el CTA de swap vive en el
    // dock del paso, NO duplicado en el banner (GD-SC-3).
    expect(find.text('Pick another vehicle'), findsOneWidget);
    expect(
      find.widgetWithText(RidePrimaryButton, 'Pick another vehicle'),
      findsOneWidget,
    );
    expect(find.textContaining('Nothing was lost'), findsOneWidget);
    // Y el CTA de avanzar ya no está: la salida es cambiar de unidad.
    expect(find.text('Continue to T&C'), findsNothing);
  });

  testWidgets('9E — el sheet lista solo lo que el SERVIDOR da por disponible, '
      'declara su frescura y deja la unidad actual INERTE con su motivo',
      (tester) async {
    final f = fakes();
    await pumpConfirming(
      tester,
      api: f.api,
      reservations: f.reservations,
      network: f.network,
      logger: f.logger,
    );

    await scrollBody(tester, find.text('Change vehicle'));
    await tester.tap(find.text('Change vehicle'));
    await tester.pumpAndSettle();

    expect(find.byType(VehicleSwapSheet), findsOneWidget);
    expect(f.reservations.availableVehiclesCalls, 1);
    // Frescura declarada.
    expect(find.textContaining('Available per the server'), findsOneWidget);
    // Candidatas elegibles + la unidad actual, inerte y con motivo legible.
    expect(find.textContaining('U-118'), findsOneWidget);
    expect(find.textContaining('U-140'), findsOneWidget);
    expect(find.textContaining('U-112'), findsWidgets);
    expect(find.textContaining('cannot be swapped for itself'), findsOneWidget);
    // Mismo grupo / otro grupo se derivan del vehicleTypeId de la reserva.
    expect(find.textContaining('Same class'), findsOneWidget);
    expect(find.textContaining('Different class'), findsOneWidget);
    // El primario nace deshabilitado hasta elegir.
    expect(
      tester
          .widget<RidePrimaryButton>(
            find.widgetWithText(RidePrimaryButton, 'Pick a unit'),
          )
          .onPressed,
      isNull,
    );
  });

  testWidgets('9E — la unidad inerte NO usa opacidad (MUST de GD): su motivo '
      'se lee a contraste pleno', (tester) async {
    final f = fakes();
    await pumpConfirming(
      tester,
      api: f.api,
      reservations: f.reservations,
      network: f.network,
      logger: f.logger,
    );
    await scrollBody(tester, find.text('Change vehicle'));
    await tester.tap(find.text('Change vehicle'));
    await tester.pumpAndSettle();

    final reason = find.textContaining('cannot be swapped for itself');
    expect(
      find.ancestor(of: reason, matching: find.byType(Opacity)),
      findsNothing,
      reason: 'atenuar la única explicación disponible sería esconderla',
    );
  });

  testWidgets('9E — swap OK: POST, sesión aplicada y display-data re-leída '
      '(el paso NO cambia, cambian los datos)', (tester) async {
    final f = fakes();
    await pumpConfirming(
      tester,
      api: f.api,
      reservations: f.reservations,
      network: f.network,
      logger: f.logger,
    );
    final displayCallsBefore = f.reservations.displayDataCalls;

    await scrollBody(tester, find.text('Change vehicle'));
    await tester.tap(find.text('Change vehicle'));
    await tester.pumpAndSettle();
    await tester.tap(find.textContaining('U-118'));
    await tester.pumpAndSettle();
    await tester.tap(find.textContaining('Switch to U-118'));
    await tester.pumpAndSettle();

    expect(f.api.swappedVehicleIds, ['cmea77xh20004vehu118']);
    expect(find.byType(VehicleSwapSheet), findsNothing, reason: 'se cierra');
    expect(f.reservations.displayDataCalls, greaterThan(displayCallsBefore),
        reason: 'la unidad vieja no puede quedarse en el header');
    expect(
      f.logger.events.where((e) => e.$1 == 'checkout.vehicle_swapped'),
      hasLength(1),
    );
  });

  testWidgets(
      'F5 — swap aceptado + re-lectura caída: la tarjeta del VEHÍCULO dice su '
      'edad y avisa que la unidad puede ser la reemplazada', (tester) async {
    final f = fakes();
    await pumpConfirming(
      tester,
      api: f.api,
      reservations: f.reservations,
      network: f.network,
      logger: f.logger,
    );
    // Estado de partida: la unidad del fixture, sin una sola señal de vejez.
    await scrollBody(tester, find.text('Change vehicle'));
    expect(vehicleCard(tester).tone, VerifyTone.neutral);
    expect(vehicleCard(tester).pillLabel, 'Available');

    // El servidor ACEPTA el swap y, justo después, display-data se cae. La
    // reserva ya tiene otra unidad; la pantalla sigue con la vieja.
    await tester.tap(find.text('Change vehicle'));
    await tester.pumpAndSettle();
    await tester.tap(find.textContaining('U-118'));
    await tester.pumpAndSettle();
    f.reservations.failWith = displayDataNetworkDeath();
    await tester.tap(find.textContaining('Switch to U-118'));
    await tester.pumpAndSettle();

    expect(f.api.swappedVehicleIds, ['cmea77xh20004vehu118'],
        reason: 'el swap SÍ quedó en el servidor');

    // La tarjeta del vehículo sigue enseñando la unidad REEMPLAZADA con su
    // odómetro — eso no se puede evitar, la re-lectura no llegó. Lo que sí se
    // puede es no pintarla como recién comprobada.
    await scrollBody(tester, find.text('Unit change'));
    expect(find.textContaining('IKL-427'), findsWidgets);
    expect(vehicleCard(tester).tone, VerifyTone.warn,
        reason: 'la tarjeta del vehículo también envejece');
    expect(vehicleCard(tester).pillLabel, startsWith('seen'),
        reason: 'ese "Available" es tan viejo como la unidad que acompaña');
    expect(find.text('Saved on the server · not re-read here'), findsOneWidget);

    // Y el subtexto del CTA habla de la UNIDAD, no de la licencia: el copy de
    // stale genérico mandaba a confrontar el documento del cliente mientras
    // el coche de la tarjeta era otro.
    expect(
      find.textContaining('may be the one you just replaced'),
      findsOneWidget,
    );
    expect(
      find.textContaining('check it against the license'),
      findsNothing,
      reason: 'lo que cambió no lo detecta una licencia en la mano',
    );

    // La entrega NO se bloquea: el swap quedó guardado y el dato del cliente
    // sigue siendo el que el servidor dijo (regla 8D).
    final cta = tester.widget<RidePrimaryButton>(
      find.widgetWithText(RidePrimaryButton, 'Continue to T&C'),
    );
    expect(cta.onPressed, isNotNull);

    // Una consulta que SÍ responde apaga el aviso — y es la única cosa que lo
    // apaga.
    f.reservations.failWith = null;
    await container(tester)
        .read(checkoutWizardProvider(kReservationId).notifier)
        .retryContext();
    await tester.pumpAndSettle();
    await scrollBody(tester, find.text('Change vehicle'));
    expect(find.text('Unit change'), findsNothing);
    expect(vehicleCard(tester).pillLabel, 'Available');
    expect(vehicleCard(tester).tone, VerifyTone.neutral);
  });

  testWidgets(
      'F5 — la vejez SIN swap también tiñe la tarjeta del vehículo: sale de '
      'la MISMA consulta que la del cliente', (tester) async {
    final f = fakes();
    await pumpConfirming(
      tester,
      api: f.api,
      reservations: f.reservations,
      network: f.network,
      logger: f.logger,
    );

    // Un refresco de fondo que se cae, sin swap de por medio (mismo escenario
    // que MC-2, mirando la tarjeta de abajo).
    f.reservations.failWith = displayDataDenial(status: 500);
    await container(tester)
        .read(checkoutWizardProvider(kReservationId).notifier)
        .retryContext();
    await tester.pumpAndSettle();
    await scrollBody(tester, find.text('Change vehicle'));

    expect(vehicleCard(tester).tone, VerifyTone.warn);
    expect(vehicleCard(tester).pillLabel, startsWith('seen'),
        reason: 'la unidad, la placa y el odómetro salen del mismo payload '
            'que el nombre del cliente: envejecen juntos');
    // Sin swap NO se acusa de nada a la unidad: solo es un dato viejo.
    expect(find.text('Unit change'), findsNothing);
  });

  testWidgets('9E — 409 sobre la unidad elegida: el sheet se QUEDA abierto con '
      'el mensaje del servidor y recarga su lista', (tester) async {
    final f = fakes();
    await pumpConfirming(
      tester,
      api: f.api,
      reservations: f.reservations,
      network: f.network,
      logger: f.logger,
    );

    f.api.onSwapVehicle = (_) async => throw ApiError(
          kind: ApiErrorKind.conflict,
          status: 409,
          code: 'VEHICLE_DOUBLE_BOOKED',
          message: 'Vehicle already reserved on this window (R-2470)',
        );

    await scrollBody(tester, find.text('Change vehicle'));
    await tester.tap(find.text('Change vehicle'));
    await tester.pumpAndSettle();
    final listCalls = f.reservations.availableVehiclesCalls;
    await tester.tap(find.textContaining('U-118'));
    await tester.pumpAndSettle();
    await tester.tap(find.textContaining('Switch to U-118'));
    await tester.pumpAndSettle();

    expect(find.byType(VehicleSwapSheet), findsOneWidget,
        reason: 'elegir otra unidad se hace AQUÍ');
    expect(find.textContaining('R-2470'), findsOneWidget);
    expect(f.reservations.availableVehiclesCalls, greaterThan(listCalls));
  });

  testWidgets('9E — 409 SWAP_LOCKED: el swap dejó de existir para esta sesión, '
      'el sheet se cierra y la negativa queda en el paso', (tester) async {
    final f = fakes();
    await pumpConfirming(
      tester,
      api: f.api,
      reservations: f.reservations,
      network: f.network,
      logger: f.logger,
    );

    f.api.onSwapVehicle = (_) async => throw ApiError(
          kind: ApiErrorKind.conflict,
          status: 409,
          code: 'SWAP_LOCKED',
          message: 'Cannot swap vehicle once inspection has started '
              '(currentStep=INSPECTION_IN_PROGRESS)',
        );

    await scrollBody(tester, find.text('Change vehicle'));
    await tester.tap(find.text('Change vehicle'));
    await tester.pumpAndSettle();
    await tester.tap(find.textContaining('U-118'));
    await tester.pumpAndSettle();
    await tester.tap(find.textContaining('Switch to U-118'));
    await tester.pumpAndSettle();

    expect(find.byType(VehicleSwapSheet), findsNothing);
    expect(find.textContaining('once inspection has started'), findsOneWidget);
  });

  testWidgets('9E — lista vacía: se dice, con reintento; nunca un sheet en '
      'blanco', (tester) async {
    final f = fakes();
    f.reservations.onAvailableVehicles = () async => const <AvailableVehicle>[];
    await pumpConfirming(
      tester,
      api: f.api,
      reservations: f.reservations,
      network: f.network,
      logger: f.logger,
    );
    await scrollBody(tester, find.text('Change vehicle'));
    await tester.tap(find.text('Change vehicle'));
    await tester.pumpAndSettle();

    expect(find.textContaining('no other free units'), findsOneWidget);
    expect(find.text('Retry'), findsOneWidget);
  });

  testWidgets('9E — la lista falla: mensaje del SERVIDOR y reintento real',
      (tester) async {
    final f = fakes();
    f.reservations.onAvailableVehicles = () async => throw ApiError(
          kind: ApiErrorKind.forbidden,
          status: 403,
          message: 'You do not have access to that location.',
        );
    await pumpConfirming(
      tester,
      api: f.api,
      reservations: f.reservations,
      network: f.network,
      logger: f.logger,
    );
    await scrollBody(tester, find.text('Change vehicle'));
    await tester.tap(find.text('Change vehicle'));
    await tester.pumpAndSettle();

    expect(
      find.text('You do not have access to that location.'),
      findsOneWidget,
    );
    final calls = f.reservations.availableVehiclesCalls;
    await tester.tap(find.text('Retry'));
    await tester.pumpAndSettle();
    expect(f.reservations.availableVehiclesCalls, greaterThan(calls));
  });

  testWidgets('mientras una escritura del paso está viva, el CTA de avance se '
      'apaga (no se avanza sobre un swap a medio aplicar)', (tester) async {
    final f = fakes();
    await pumpConfirming(
      tester,
      api: f.api,
      reservations: f.reservations,
      network: f.network,
      logger: f.logger,
    );

    final gate = Completer<void>();
    f.api.onDeclinedInsurance = (declined) async {
      await gate.future;
      return f.api.current!;
    };
    await scrollBody(tester, find.byType(Switch));
    await tester.tap(find.byType(Switch));
    await tester.pump();

    final cta = tester.widget<RidePrimaryButton>(
      find.widgetWithText(RidePrimaryButton, 'Continue to T&C'),
    );
    expect(cta.onPressed, isNull);

    gate.complete();
    await tester.pumpAndSettle();
  });

  // ── el dato inalcanzable NO es un dato faltante (hallazgo e2e, MAJOR) ──
  //
  // La corrida contra backend real pegó aquí: display-data devolvía 404 (el id
  // de la reserva dev colisionaba con la ruta de `reservationNumber`, arreglado
  // en 5ff8422e) y esta pantalla decía «Consultado ahora: el servidor sigue sin
  // el nombre, la licencia y el teléfono» — con el servidor teniendo los tres —
  // y bloqueaba la entrega. Cada aserción de aquí abajo cita el TEXTO, porque
  // el defecto era exactamente el texto.

  testWidgets('display-data 404: la pantalla NO acusa al servidor de no tener '
      'los datos — dice que no pudo consultar, cita la negativa cruda y ofrece '
      'reintentar', (tester) async {
    final f = fakes();
    f.reservations.failWith = displayDataDenial();
    await pumpConfirming(
      tester,
      api: f.api,
      reservations: f.reservations,
      network: f.network,
      logger: f.logger,
    );

    // LO QUE NO PUEDE APARECER. Los tres textos son afirmaciones sobre lo que
    // el servidor tiene, y aquí no se sabe nada de eso.
    expect(
      find.textContaining("the server still doesn't have"),
      findsNothing,
      reason: 'la petición falló: el servidor no dijo que le faltara nada',
    );
    expect(
      find.textContaining('are missing'),
      findsNothing,
      reason: 'ese copy nombra campos faltantes; no hay respuesta que nombrar',
    );
    expect(find.text('Not captured'), findsNothing);
    expect(find.text('Missing data'), findsNothing);

    // LO QUE SÍ. Un veredicto de ignorancia, en palabras, no solo en color.
    expect(find.text('Not checked'), findsWidgets);
    expect(find.text('Could not be checked'), findsWidgets);
    expect(
      find.textContaining('identity cannot be confirmed'),
      findsOneWidget,
      reason: 'el bloqueo cambia de naturaleza: no falta un dato, falta la '
          'consulta',
    );
    // Y para AHÍ (review MC-3b). La oración "esto no dice nada sobre qué datos
    // tenga el servidor" era defensa técnica: cuatro renglones centrados a
    // 12.5 px bajo un botón muerto. Que no se acusa a nadie ya lo dicen la
    // pastilla ámbar y el valor de cada fila.
    expect(
      find.textContaining('says nothing about what data'),
      findsNothing,
      reason: 'el no-acusar lo hacen la pastilla y el ámbar, no un párrafo',
    );
    // La negativa del servidor, literal (DoD #5) — sin diagnóstico inventado
    // y sin envoltorio: la CLAVE dice qué es la fila, el VALOR es el cuerpo
    // del servidor tal cual.
    expect(find.text('Server response'), findsOneWidget);
    expect(find.text('Reservation not found'), findsOneWidget);
    // Y una acción que PUEDE tener éxito, no una puerta falsa.
    expect(find.text('Retry the lookup'), findsOneWidget);
    expect(
      find.text('Refresh customer data'),
      findsNothing,
      reason: 'ese botón promete refrescar DATOS; aquí se reintenta la consulta',
    );

    final cta = tester.widget<RidePrimaryButton>(
      find.widgetWithText(RidePrimaryButton, 'Continue to T&C'),
    );
    expect(cta.onPressed, isNull, reason: 'sin consulta no se confirma nada');

    // Telemetría del defecto: cuántas entregas se quedan sin poder confirmarse
    // por una consulta caída (y con qué status), no por datos faltantes.
    expect(
      f.logger.events
          .where((e) => e.$1 == 'checkout.context_unreachable')
          .map((e) => e.$2['status']),
      contains('404'),
    );
  });

  testWidgets('el reintento con el backend ya sano deja la pantalla NORMAL: '
      'datos reales, verde y CTA vivo', (tester) async {
    final f = fakes();
    f.reservations.failWith = displayDataDenial();
    await pumpConfirming(
      tester,
      api: f.api,
      reservations: f.reservations,
      network: f.network,
      logger: f.logger,
    );
    expect(find.text('Retry the lookup'), findsOneWidget);

    // El backend vuelve en sí entre un toque y el siguiente.
    f.reservations.failWith = null;
    await tester.tap(find.text('Retry the lookup'));
    await tester.pumpAndSettle();

    expect(find.text('María González'), findsOneWidget);
    expect(find.textContaining('B-4482913'), findsOneWidget);
    expect(find.text('+52 998 123 4567'), findsOneWidget);
    expect(find.text('Verified'), findsOneWidget);
    expect(find.text('Could not be checked'), findsNothing);
    expect(find.text('Retry the lookup'), findsNothing);
    expect(
      find.text('Server response'),
      findsNothing,
      reason: 'la negativa vieja no puede sobrevivir a una consulta buena',
    );
    final cta = tester.widget<RidePrimaryButton>(
      find.widgetWithText(RidePrimaryButton, 'Continue to T&C'),
    );
    expect(cta.onPressed, isNotNull);
    expect(
      f.logger.events
          .where((e) => e.$1 == 'checkout.context_retry')
          .map((e) => e.$2['result']),
      ['answered'],
    );
  });

  testWidgets('el reintento que vuelve a fallar acusa la CONSULTA, jamás los '
      'datos', (tester) async {
    final f = fakes();
    f.reservations.failWith = displayDataDenial(
      status: 500,
      serverError: 'Internal Server Error',
    );
    await pumpConfirming(
      tester,
      api: f.api,
      reservations: f.reservations,
      network: f.network,
      logger: f.logger,
    );

    await tester.tap(find.text('Retry the lookup'));
    await tester.pumpAndSettle();

    expect(
      find.textContaining("still isn't getting through"),
      findsOneWidget,
      reason: 'el acuse habla del intento; el de campos faltantes sería falso',
    );
    expect(find.textContaining("the server still doesn't have"), findsNothing);
    // El botón sigue vivo: reintentar OTRA vez es legítimo — la consulta puede
    // funcionar en el siguiente toque, a diferencia de un FORWARD ya negado.
    expect(find.text('Retry the lookup'), findsOneWidget);
    expect(
      f.logger.events
          .where((e) => e.$1 == 'checkout.context_retry')
          .map((e) => e.$2['result']),
      ['unreachable'],
    );
  });

  testWidgets('la petición que muere SIN respuesta no inventa un cuerpo: mismo '
      'veredicto, sin renglón de cita', (tester) async {
    final f = fakes();
    f.reservations.failWith = displayDataNetworkDeath();
    await pumpConfirming(
      tester,
      api: f.api,
      reservations: f.reservations,
      network: f.network,
      logger: f.logger,
    );

    expect(find.text('Could not be checked'), findsWidgets);
    expect(find.textContaining('identity cannot be confirmed'), findsOneWidget);
    expect(
      find.text('Server response'),
      findsNothing,
      reason: 'no hubo respuesta: citar una sería inventarla',
    );
    // F1 — y en concreto, NADA de la prosa de la librería. Es el texto exacto
    // que la corrida e2e 2 encontró bajo "Server response:": inglés, de Dio,
    // sobre una petición que jamás llegó a un servidor.
    expect(
      find.textContaining('cannot be solved by the library'),
      findsNothing,
      reason: 'un mensaje de librería no es la palabra del servidor',
    );
    expect(find.text('Retry the lookup'), findsOneWidget);
    expect(
      f.logger.events
          .where((e) => e.$1 == 'checkout.context_unreachable')
          .map((e) => e.$2['status']),
      contains('network'),
    );
  });

  testWidgets('un fallo SIN ApiError (parseo) cae en el mismo veredicto y '
      'tampoco acusa', (tester) async {
    final f = fakes();
    await pumpConfirming(
      tester,
      api: f.api,
      reservations: FakeReservationsApi(fail: true),
      network: f.network,
      logger: f.logger,
    );

    expect(find.byType(VerifyCard), findsWidgets);
    expect(find.text('Could not be checked'), findsWidgets);
    expect(find.text('Not captured'), findsNothing);
    final cta = tester.widget<RidePrimaryButton>(
      find.widgetWithText(RidePrimaryButton, 'Continue to T&C'),
    );
    expect(cta.onPressed, isNull, reason: 'sin datos no se afirma verificado');
  });

  testWidgets('9B sigue intacto: cuando el servidor SÍ contesta y el campo '
      'viene vacío, ahí sí se nombra', (tester) async {
    final f = fakes();
    f.reservations.patchDisplayData = (raw) {
      final reservation = raw['reservation'] as Map<String, dynamic>;
      (reservation['customer'] as Map<String, dynamic>)['phone'] = null;
      (reservation['rentalAgreement'] as Map<String, dynamic>)['customerPhone'] =
          null;
      return raw;
    };
    await pumpConfirming(
      tester,
      api: f.api,
      reservations: f.reservations,
      network: f.network,
      logger: f.logger,
    );

    expect(find.text('Not captured'), findsOneWidget);
    expect(find.text('Missing data'), findsOneWidget);
    expect(find.textContaining('the phone'), findsOneWidget);
    expect(find.text('Could not be checked'), findsNothing);
    expect(find.text('Retry the lookup'), findsNothing);
    expect(find.text('Refresh customer data'), findsOneWidget);
    expect(
      f.logger.has('checkout.context_unreachable'),
      isFalse,
      reason: 'la consulta llegó perfectamente: no hay nada que reportar',
    );
  });

  testWidgets('MC-4 — la PRIMERA respuesta tras un dato inalcanzable no puede '
      'decir que el servidor "sigue" sin nada: no hay consulta anterior con '
      'la que comparar', (tester) async {
    final f = fakes();
    f.reservations.failWith = displayDataDenial();
    // Cuando por fin conteste, contestará sin teléfono.
    f.reservations.patchDisplayData = (raw) {
      final reservation = raw['reservation'] as Map<String, dynamic>;
      (reservation['customer'] as Map<String, dynamic>)['phone'] = null;
      (reservation['rentalAgreement'] as Map<String, dynamic>)['customerPhone'] =
          null;
      return raw;
    };
    await pumpConfirming(
      tester,
      api: f.api,
      reservations: f.reservations,
      network: f.network,
      logger: f.logger,
    );

    f.reservations.failWith = null;
    await tester.tap(find.text('Retry the lookup'));
    await tester.pumpAndSettle();

    // Llegó la primera respuesta y sí le falta el teléfono: eso se nombra.
    expect(find.text('Not captured'), findsOneWidget);
    expect(find.textContaining('the phone'), findsOneWidget);
    // Pero NO como un "sigue sin": esta es la primera respuesta que llega.
    expect(
      find.textContaining("still doesn't have"),
      findsNothing,
      reason: 'no hay ninguna consulta anterior que dijera lo mismo',
    );
    expect(find.textContaining('are missing'), findsOneWidget);
  });

  testWidgets('MC-2 — datos buenos con la consulta de ahora caída: NO se '
      'borran ni se quedan en verde; la pastilla pasa a decir su edad y el '
      'CTA sigue vivo', (tester) async {
    final f = fakes();
    await pumpConfirming(
      tester,
      api: f.api,
      reservations: f.reservations,
      network: f.network,
      logger: f.logger,
    );
    expect(find.text('Verified'), findsOneWidget);

    // display-data se cae mientras el poll de la SESIÓN sigue perfecto: el
    // shell no pinta ninguna vejez porque `offline` sale del error de sesión.
    // La re-lectura se empuja por el controller —la misma que dispara el
    // swap— porque con la tarjeta completa el pie no ofrece ningún botón.
    f.reservations.failWith = displayDataDenial(status: 500);
    await container(tester)
        .read(checkoutWizardProvider(kReservationId).notifier)
        .retryContext();
    await tester.pumpAndSettle();

    // El dato NO se borra (regla 8D)…
    expect(find.text('María González'), findsOneWidget);
    expect(find.text('+52 998 123 4567'), findsOneWidget);
    expect(find.text('Could not be checked'), findsNothing);
    // …pero deja de afirmarse comprobado, y dice CUÁNTO hace que lo está.
    expect(
      find.text('Verified'),
      findsNothing,
      reason: 'ese pill afirma que esto se acaba de comprobar',
    );
    expect(find.textContaining('seen'), findsOneWidget);
    expect(find.textContaining('ago'), findsOneWidget);
    // Y no se bloquea: un refresco de fondo fallido no puede detener una
    // entrega sobre datos que el servidor sí dio.
    final cta = tester.widget<RidePrimaryButton>(
      find.widgetWithText(RidePrimaryButton, 'Continue to T&C'),
    );
    expect(cta.onPressed, isNotNull);
    expect(
      find.text('Server response'),
      findsNothing,
      reason: 'con la tarjeta utilizable no se cita un 500 junto al cliente',
    );
  });

  testWidgets('SC-1 — mientras la consulta viaja el progreso lo lleva el '
      'PRIMARIO: el slot secundario no existe, así que no hay nada que '
      'colapsar cuando cae el veredicto', (tester) async {
    final f = fakes();
    f.reservations.failWith = displayDataDenial();
    // display-data se queda EN VUELO: es el frame que esta lámina existe para
    // hacer expresable, y sin la compuerta la consulta resuelve en el mismo
    // microtask y nunca se ve.
    f.reservations.displayGate = Completer<void>();
    await pumpConfirming(
      tester,
      api: f.api,
      reservations: f.reservations,
      network: f.network,
      logger: f.logger,
      settle: false,
    );
    await tester.pump();

    expect(
      find.textContaining("Checking the customer's record"),
      findsOneWidget,
    );
    // El progreso está EN EL PRIMARIO: altura fija, blanco sobre el gradiente
    // a opacidad plena. En el ghost deshabilitado iba al 55 %
    // (ride_buttons.dart:124) — ~3.5:1 para el único elemento que dice "estoy
    // trabajando", en un patio con sol.
    final primary = tester.widget<RidePrimaryButton>(
      find.byType(RidePrimaryButton),
    );
    expect(primary.loading, isTrue);
    expect(primary.onPressed, isNull);
    expect(find.text('Asking the server…'), findsOneWidget);
    expect(
      find.byType(RideGhostButton),
      findsNothing,
      reason: 'reintentar algo que ya está en vuelo es una puerta falsa',
    );
    final primaryBefore = tester.getRect(find.byType(RidePrimaryButton));

    f.reservations.displayGate!.complete();
    await tester.pump();
    await tester.pump();

    // Camino raro (checking → unreachable): aparece el reintento.
    expect(find.text('Retry the lookup'), findsOneWidget);
    expect(
      tester.getRect(find.byType(RidePrimaryButton)).height,
      primaryBefore.height,
    );
  });

  testWidgets('SC-1-bis — el camino NORMAL (consultando → datos completos), '
      'que es el que ocurre en cada entrega: el pie no encoge porque el slot '
      'secundario nunca llegó a existir', (tester) async {
    final f = fakes();
    // Sin `failWith`: la consulta va a responder bien y completa. Solo se
    // retiene para poder mirar el frame de "consultando".
    f.reservations.displayGate = Completer<void>();
    await pumpConfirming(
      tester,
      api: f.api,
      reservations: f.reservations,
      network: f.network,
      logger: f.logger,
      settle: false,
    );
    await tester.pump();

    expect(find.text('Checking…'), findsWidgets);
    expect(
      find.byType(RideGhostButton),
      findsNothing,
      reason: 'un ghost aquí es un slot que DESAPARECE al llegar la respuesta',
    );
    final primaryBefore = tester.getRect(find.byType(RidePrimaryButton));

    f.reservations.displayGate!.complete();
    await tester.pumpAndSettle();

    // Llegó todo: verde, CTA vivo y ningún secundario (no hay nada que
    // consultar).
    expect(find.text('Verified'), findsOneWidget);
    expect(find.byType(RideGhostButton), findsNothing);
    final cta = tester.widget<RidePrimaryButton>(
      find.byType(RidePrimaryButton),
    );
    expect(cta.loading, isFalse);
    expect(cta.onPressed, isNotNull);

    // Y lo que este caso existe para medir: el CTA no da el salto de un botón
    // entero. Con el progreso en el slot secundario, el ghost desaparecía al
    // llegar la respuesta y el primario BAJABA 57 px (48 del botón + 9 de
    // gap) con el pulgar ya en camino — y a diferencia del caso de arriba,
    // eso pasaba en CADA entrega, no en el camino raro.
    expect(find.text('Continue to T&C'), findsOneWidget);
    final moved =
        (tester.getRect(find.byType(RidePrimaryButton)).top - primaryBefore.top)
            .abs();
    expect(
      moved,
      lessThan(48),
      reason: 'un desplazamiento de 48+ px ES el slot secundario colapsando',
    );
    // El resto que sí se mueve (~18 px, y hacia ARRIBA) es el `why` pasando de
    // un renglón a dos: `coTransitionWhy` es más largo que el de "consultando".
    // Es comportamiento del dock desde H1, igual en todos los pasos, y va en
    // dirección contraria al pulgar — el dedo aterriza en el subtexto, no
    // sobre otro botón. Se deja medido para que un cambio de copy que lo
    // convierta en un salto de verdad no pase inadvertido.
    expect(moved, lessThanOrEqualTo(20));
  });

  testWidgets('SHOULD — la vejez tiene horizonte: pasado un ciclo de handoff '
      'completo el aviso deja de decir "confírmalo contra la licencia" y manda '
      'a re-consultar antes de firmar', (tester) async {
    final f = fakes();
    // Reloj propio: el umbral son los 15 min de HANDOFF_TOKEN_TTL_MIN y no se
    // esperan de verdad.
    final start = DateTime.utc(2026, 9, 1, 10);
    var now = start;
    await withClock(Clock(() => now), () async {
      await pumpConfirming(
        tester,
        api: f.api,
        reservations: f.reservations,
        network: f.network,
        logger: f.logger,
      );

      // Recién caída la consulta: la comprobación es la que el agente ya hace.
      f.reservations.failWith = displayDataDenial(status: 500);
      now = start.add(const Duration(minutes: 2));
      await container(tester)
          .read(checkoutWizardProvider(kReservationId).notifier)
          .retryContext();
      await tester.pumpAndSettle();
      expect(find.textContaining('check it against the license'), findsOneWidget);
      expect(find.textContaining('Check again before signing'), findsNothing);

      // Pasado el horizonte, lo que pudo cambiar es el CONTRATO, y eso una
      // licencia en la mano no lo detecta.
      now = start.add(const Duration(minutes: 40));
      await container(tester)
          .read(checkoutWizardProvider(kReservationId).notifier)
          .retryContext();
      await tester.pumpAndSettle();
      expect(find.textContaining('Check again before signing'), findsOneWidget);
      expect(find.textContaining('check it against the license'), findsNothing);
      // Con la EDAD dentro, no el umbral: es el dato con el que se decide.
      // Sale en los DOS sitios que hablan de vejez, la pastilla y el why.
      expect(find.textContaining('40 min'), findsNWidgets(2));
      // Y apunta a un botón que EXISTE.
      expect(find.text('Refresh customer data'), findsOneWidget);
    });
  });
}
