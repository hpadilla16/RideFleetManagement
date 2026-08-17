import 'dart:async';
import 'dart:convert';

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

  Future<void> pumpConfirming(
    WidgetTester tester, {
    required FakeCheckoutApi api,
    required FakeReservationsApi reservations,
    required FakeNetworkStatus network,
    required CapturingEventLogger logger,
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
    await tester.pumpAndSettle();
  }

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
    expect(find.textContaining('48,190 km'), findsOneWidget);
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
    // del cliente — eso vive en el mostrador).
    expect(find.text('Check again'), findsOneWidget);
    final before = f.reservations.displayDataCalls;
    await tester.tap(find.text('Check again'));
    await tester.pumpAndSettle();
    expect(f.reservations.displayDataCalls, greaterThan(before));
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
    expect(find.textContaining('R-2466'), findsOneWidget);
    expect(find.textContaining('VEHICLE_CONFLICT'), findsNothing);
    expect(find.text('In conflict'), findsOneWidget);
    // Una salida primaria, siempre.
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

  testWidgets('el paso se dibuja aunque display-data no responda: sin contexto '
      'no se inventan datos, se nombran como faltantes', (tester) async {
    final f = fakes();
    await pumpConfirming(
      tester,
      api: f.api,
      reservations: FakeReservationsApi(fail: true),
      network: f.network,
      logger: f.logger,
    );

    expect(find.byType(VerifyCard), findsWidgets);
    expect(find.text('Not captured'), findsWidgets);
    final cta = tester.widget<RidePrimaryButton>(
      find.widgetWithText(RidePrimaryButton, 'Continue to T&C'),
    );
    expect(cta.onPressed, isNull, reason: 'sin datos no se afirma verificado');
  });
}
