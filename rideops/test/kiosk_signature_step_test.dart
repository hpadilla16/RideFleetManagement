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
/// en pares exactos, salida SOLO con mantener 3 s + PIN, y el LÍMITE de
/// reintentos de checkPin que exige el criterio registrado (checkPin es puro
/// y no cuenta — el límite vive en esta UI).
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

  setUp(() {
    confirmed = null;
    exits = 0;
    container = ProviderContainer(overrides: [
      sessionControllerProvider.overrideWith(
        () => StubSessionController(
          SessionState.authenticated(
            token: fakeJwt(
              exp: DateTime.now().add(const Duration(hours: 8)),
              sub: kFixtureUserId,
            ),
            user: sessionUserFixture(),
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
    addTearDown(container.dispose);
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

    final gesture = await tester
        .startGesture(tester.getCenter(find.text('Exit: hold 3 s + PIN')));
    await tester.pump(const Duration(milliseconds: 3100));
    await gesture.up();
    await tester.pumpAndSettle();
    expect(find.text('Exit signing mode'), findsOneWidget);

    await tester.enterText(find.byType(TextField), '1234');
    await tester.tap(find.text('Continue'));
    await tester.pumpAndSettle();
    expect(exits, 1);
    expect(probe.checked, ['1234']);
  });

  testWidgets('3 PIN erróneos: la UI LIMITA los reintentos y vuelve al staff',
      (tester) async {
    await tester.pumpWidget(kiosk());
    await tester.pumpAndSettle();

    final gesture = await tester
        .startGesture(tester.getCenter(find.text('Exit: hold 3 s + PIN')));
    await tester.pump(const Duration(milliseconds: 3100));
    await gesture.up();
    await tester.pumpAndSettle();

    for (var attempt = 1; attempt <= 3; attempt++) {
      await tester.enterText(find.byType(TextField), '9999');
      await tester.tap(find.text('Continue'));
      await tester.pumpAndSettle();
      if (attempt < 3) {
        expect(find.text('Exit signing mode'), findsOneWidget,
            reason: 'quedan intentos: el diálogo sigue');
        expect(
          find.textContaining('attempt'),
          findsOneWidget,
          reason: 'el contador de intentos es visible',
        );
      }
    }

    expect(find.text('Exit signing mode'), findsNothing,
        reason: 'al 3er fallo el diálogo se cierra');
    expect(exits, 1,
        reason: 'criterio H5: intentos agotados → volver al paso del staff');
    expect(probe.checked, hasLength(3),
        reason: 'checkPin no se martilla más allá del límite de la UI');
    expect(find.text('Too many attempts. Going back to the previous step.'),
        findsOneWidget);
  });
}
