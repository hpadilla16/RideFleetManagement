import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:rideops/core/session/lock_controller.dart';
import 'package:rideops/core/session/pin_store.dart';
import 'package:rideops/core/session/session_controller.dart';
import 'package:rideops/core/session/session_state.dart';
import 'package:rideops/features/inspection/presentation/widgets/kiosk_signature_step.dart';
import 'package:rideops/features/inspection/presentation/widgets/signature_pad.dart';

import 'helpers/auth_test_helpers.dart';
import 'helpers/shell_test_helpers.dart';

/// Modo kiosco de la firma (H5, §9-6 Variante A): suspend/resume del candado
/// en pares exactos, salida SOLO con mantener 3 s + PIN, y la cadena de
/// seguridad del review INN MC-1: el contador de intentos vive en el PASO
/// (cerrar el diálogo no lo resetea) y agotarlo deja la superficie de staff
/// BLOQUEADA — nunca abierta frente a un atacante activo.
class ProbeLockController extends LockController {
  int suspends = 0;
  int resumes = 0;
  final checked = <String>[];

  @override
  void suspendLock() {
    suspends++;
    super.suspendLock();
  }

  @override
  void resumeLock() {
    resumes++;
    super.resumeLock();
  }

  @override
  Future<bool> checkPin(String pin) async {
    checked.add(pin);
    return pin == '1234';
  }
}

void main() {
  late ProbeLockController probe;
  late ProviderContainer container;
  String? confirmed;
  var exits = 0;

  ProviderContainer makeContainer({bool screenLockExempt = true}) {
    final c = ProviderContainer(overrides: [
      sessionControllerProvider.overrideWith(
        () => StubSessionController(
          SessionState.authenticated(
            token: fakeJwt(
              exp: DateTime.now().add(const Duration(hours: 8)),
              sub: kFixtureUserId,
            ),
            user: sessionUserFixture(screenLockExempt: screenLockExempt),
          ),
        ),
      ),
      pinStoreProvider.overrideWithValue(
        InMemoryPinStore.configured(userId: kFixtureUserId),
      ),
      lockControllerProvider.overrideWith(() {
        probe = ProbeLockController();
        return probe;
      }),
    ]);
    addTearDown(c.dispose);
    return c;
  }

  setUp(() {
    confirmed = null;
    exits = 0;
    container = makeContainer();
  });

  Widget kiosk() => UncontrolledProviderScope(
        container: container,
        child: l10nApp(
          Scaffold(
            body: KioskSignatureStep(
              tenantName: 'Autos del Valle',
              tenantLogoUrl: '',
              reservationLabel: 'R-42',
              onConfirmed: (s) => confirmed = s,
              onExitToStaff: () => exits++,
            ),
          ),
        ),
      );

  Future<void> holdExitBar(WidgetTester tester) async {
    final gesture = await tester
        .startGesture(tester.getCenter(find.text('Exit: hold 3 s + PIN')));
    await tester.pump(const Duration(milliseconds: 3100));
    await gesture.up();
    await tester.pumpAndSettle();
  }

  Future<void> submitPin(WidgetTester tester, String pin) async {
    await tester.enterText(find.byType(TextField), pin);
    await tester.tap(find.text('Continue'));
    await tester.pumpAndSettle();
  }

  testWidgets('suspende el candado al entrar y lo reanuda EXACTO al salir',
      (tester) async {
    await tester.pumpWidget(kiosk());
    await tester.pumpAndSettle();
    expect(probe.suspends, 1);
    expect(probe.resumes, 0);

    // Branding del TENANT visible, cero "RideOps" frente al cliente.
    expect(find.text('Autos del Valle'), findsOneWidget);
    expect(find.text('RideOps'), findsNothing);

    await tester.pumpWidget(const SizedBox()); // desmonta el paso
    expect(probe.resumes, 1, reason: 'toda salida pasa por dispose');
  });

  testWidgets('sin nombre de tenant NO hay fallback de marca (GD-1)',
      (tester) async {
    await tester.pumpWidget(UncontrolledProviderScope(
      container: container,
      child: l10nApp(
        Scaffold(
          body: KioskSignatureStep(
            tenantName: '',
            tenantLogoUrl: '',
            reservationLabel: 'R-42',
            onConfirmed: (_) {},
            onExitToStaff: () {},
          ),
        ),
      ),
    ));
    await tester.pumpAndSettle();
    expect(find.text('Ride Fleet'), findsNothing);
    expect(find.text('RideOps'), findsNothing);
    // El subtítulo del trámite sigue anclando la superficie.
    expect(find.textContaining('Reservation R-42'), findsOneWidget);
  });

  testWidgets('toggle ES|EN cambia SOLO la superficie del cliente (GD-2)',
      (tester) async {
    await tester.pumpWidget(kiosk());
    await tester.pumpAndSettle();

    // Harness en inglés: prompt del cliente en EN, kioskbar en EN (staff).
    expect(find.textContaining('Sign to confirm'), findsOneWidget);

    await tester.tap(find.text('ES'));
    await tester.pumpAndSettle();

    // Superficie del cliente ahora en español…
    expect(find.textContaining('Firme para confirmar'), findsOneWidget);
    expect(find.text('Confirmar firma'), findsOneWidget);
    // …y la kioskbar de staff sigue en el idioma del empleado.
    expect(find.text('Exit: hold 3 s + PIN'), findsOneWidget);

    await tester.tap(find.text('EN'));
    await tester.pumpAndSettle();
    expect(find.textContaining('Sign to confirm'), findsOneWidget);
  });

  testWidgets('sin tinta no hay confirmación; con firma llega el dataURL',
      (tester) async {
    await tester.pumpWidget(kiosk());
    await tester.pumpAndSettle();

    await tester.tap(find.text('Confirm signature'));
    await tester.pump();
    expect(confirmed, isNull, reason: 'un lienzo vacío no es firma');

    // Trazo real sobre el lienzo.
    final pad = find.byType(SignaturePad);
    final center = tester.getCenter(pad);
    final gesture = await tester.startGesture(center);
    await gesture.moveBy(const Offset(60, 12));
    await tester.pump();
    await gesture.moveBy(const Offset(-30, 18));
    await tester.pump();
    await gesture.up();
    await tester.pump();

    // runAsync: el export a PNG pasa por el engine (Picture.toImage) y sus
    // futures no resuelven dentro del fake-async del test.
    await tester.runAsync(() async {
      await tester.tap(find.text('Confirm signature'));
      await tester.pump();
      await Future<void>.delayed(const Duration(milliseconds: 100));
    });
    await tester.pumpAndSettle();
    expect(confirmed, isNotNull);
    expect(confirmed, startsWith('data:image/png;base64,'));
    expect(confirmed!.length, greaterThan(200),
        reason: 'el backend estampa customerSignedAt solo con >200 chars');
  });

  testWidgets('salida: mantener 3 s abre el PIN; correcto → staff',
      (tester) async {
    await tester.pumpWidget(kiosk());
    await tester.pumpAndSettle();

    // Un tap corto NO abre nada (el cliente rozando la barra).
    await tester.tap(find.text('Exit: hold 3 s + PIN'));
    await tester.pump(const Duration(seconds: 1));
    expect(find.text('Exit signing mode'), findsNothing);

    await holdExitBar(tester);
    expect(find.text('Exit signing mode'), findsOneWidget);

    await submitPin(tester, '1234');
    expect(exits, 1);
    expect(probe.checked, ['1234']);
  });

  testWidgets(
      'INN MC-1a: cerrar el diálogo NO resetea el contador de intentos',
      (tester) async {
    await tester.pumpWidget(kiosk());
    await tester.pumpAndSettle();

    await holdExitBar(tester);
    await submitPin(tester, '0000');
    await submitPin(tester, '1111');
    expect(find.text('Exit signing mode'), findsOneWidget);

    // El "cliente" descarta el diálogo tocando fuera…
    await tester.tapAt(const Offset(5, 400));
    await tester.pumpAndSettle();
    expect(find.text('Exit signing mode'), findsNothing);

    // …y al reabrir, el contador SIGUE donde iba: un fallo más lo agota.
    await holdExitBar(tester);
    await submitPin(tester, '2222');
    expect(find.text('Exit signing mode'), findsNothing,
        reason: '3er fallo acumulado: se acabó, sin intentos regalados');
    expect(probe.checked, hasLength(3));
    expect(exits, 1, reason: 'vuelve al staff (bloqueado — ver otro test)');
  });

  testWidgets(
      'INN MC-1b: 3 PIN erróneos ⇒ vuelve al staff BLOQUEADO (candado echado)',
      (tester) async {
    // Usuario NO exento: el candado real aplica. Cold start llega bloqueado;
    // se desbloquea con el PIN (flujo normal) antes de entrar al kiosco.
    container = makeContainer(screenLockExempt: false);
    container.read(lockControllerProvider); // instancia + sincroniza
    await tester.pump();
    expect(container.read(lockControllerProvider).locked, isTrue,
        reason: 'cold start con PIN configurado llega bloqueado');
    await probe.verifyPin('1234');
    expect(container.read(lockControllerProvider).locked, isFalse);

    await tester.pumpWidget(kiosk());
    await tester.pumpAndSettle();

    await holdExitBar(tester);
    for (final pin in ['9999', '8888', '7777']) {
      await submitPin(tester, pin);
    }
    expect(find.text('Exit signing mode'), findsNothing);
    expect(exits, 1,
        reason: 'criterio H5: intentos agotados → volver al paso del staff');
    expect(probe.checked, hasLength(3),
        reason: 'checkPin no se martilla más allá del límite de la UI');
    expect(find.text('Too many attempts. Going back to the previous step.'),
        findsOneWidget);

    // Desmontar el paso = resumeLock + lock(kiosk_exit_exhausted): la
    // superficie de staff NO queda abierta para el atacante activo.
    await tester.pumpWidget(const SizedBox());
    await tester.pump();
    expect(probe.resumes, 1);
    expect(container.read(lockControllerProvider).locked, isTrue,
        reason: 'INN MC-1b: el staff aterriza en la pantalla de PIN normal, '
            'cuyos intentos agotados ya purgan PIN y cierran sesión');
  });
}
