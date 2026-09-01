import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:rideops/core/widgets/ride_buttons.dart';

/// Opacidad de los botones del design system.
///
/// Existe por un hallazgo de diseño sobre el pie del paso 1: `RidePrimaryButton`
/// metía `loading` en la MISMA expresión que el deshabilitado
/// (`enabled = onPressed != null && !loading` → `opacity: enabled ? 1 : 0.55`),
/// así que un botón trabajando se componía entero al 55 % sobre un pie casi
/// blanco. El gradiente se aclaraba hacia blanco y el texto blanco seguía
/// blanco: "Consultando al servidor…" quedaba a 2.43-2.62:1 — peor que el
/// ~3.5:1 del ghost deshabilitado al que ese spinner sustituyó.
///
/// La regla que estas pruebas fijan: **trabajar no es estar apagado**. Sin tap
/// y sin ink en los dos casos, pero con tinta plena mientras se trabaja.

void main() {
  /// Opacidad COMPUESTA: el producto de todos los `Opacity` del subárbol del
  /// botón, no el del primero que aparezca. Si alguien envuelve el widget en
  /// otra capa, lo que ve el agente es el producto — y es el producto lo que
  /// se mide contra 4.5:1.
  double composedOpacity(WidgetTester tester, Finder button) {
    final layers = tester.widgetList<Opacity>(
      find.descendant(of: button, matching: find.byType(Opacity)),
    );
    return layers.fold<double>(1, (acc, o) => acc * o.opacity);
  }

  Future<void> pump(WidgetTester tester, Widget button) => tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            // Fondo del pie del wizard: el 55 % se componía CONTRA esto, que es
            // lo que aclaraba el gradiente hasta perder el texto blanco.
            backgroundColor: const Color(0xFFFAFAFB),
            body: Center(child: button),
          ),
        ),
      );

  group('RidePrimaryButton', () {
    testWidgets('trabajando se dibuja a opacidad PLENA — es el único elemento '
        'que comunica "estoy trabajando", y a 0.55 sobre el pie casi blanco no '
        'se lee bajo el sol', (tester) async {
      await pump(
        tester,
        RidePrimaryButton(
          label: 'Continue',
          loadingLabel: 'Asking the server…',
          loading: true,
          onPressed: () {},
        ),
      );

      expect(
        composedOpacity(tester, find.byType(RidePrimaryButton)),
        1.0,
        reason: 'un botón que trabaja debe verse activo, no deshabilitado',
      );
      expect(find.text('Asking the server…'), findsOneWidget);
    });

    testWidgets('trabajando SIN callback también va a opacidad plena: es la '
        'forma exacta en que lo usa el paso 1 (TransitionButton apaga su '
        'onPressed mientras display-data viaja)', (tester) async {
      await pump(
        tester,
        const RidePrimaryButton(
          label: 'Continue to T&C',
          loadingLabel: 'Asking the server…',
          loading: true,
          onPressed: null,
        ),
      );

      expect(composedOpacity(tester, find.byType(RidePrimaryButton)), 1.0);
    });

    testWidgets('el atenuado LEGÍTIMO sobrevive: sin callback y SIN trabajo '
        'sigue al 0.55 — el desacople no puede encender un botón muerto',
        (tester) async {
      await pump(
        tester,
        const RidePrimaryButton(label: 'Continue', onPressed: null),
      );

      expect(
        composedOpacity(tester, find.byType(RidePrimaryButton)),
        0.55,
        reason: 'un CTA bloqueado se sigue viendo bloqueado (8D)',
      );
    });

    testWidgets('habilitado y ocioso: opacidad plena', (tester) async {
      await pump(
        tester,
        RidePrimaryButton(label: 'Continue', onPressed: () {}),
      );

      expect(composedOpacity(tester, find.byType(RidePrimaryButton)), 1.0);
    });

    testWidgets('la tinta plena NO lo vuelve tocable: trabajando sigue sin '
        'disparar el callback ni pintar ink', (tester) async {
      var taps = 0;
      await pump(
        tester,
        RidePrimaryButton(
          label: 'Continue',
          loading: true,
          onPressed: () => taps++,
        ),
      );

      await tester.tap(find.byType(RidePrimaryButton));
      await tester.pump();

      expect(
        taps,
        0,
        reason: 'el desacople es de TINTA; el guard anti-doble-tap sigue vivo',
      );
      expect(
        tester.widget<InkWell>(find.byType(InkWell)).onTap,
        isNull,
        reason: 'sin onTap no hay ink: el botón no responde al dedo',
      );
    });
  });

  group('RideGhostButton', () {
    // El hermano NO metía `loading` en su expresión de opacidad
    // (`onPressed == null ? 0.55 : 1`), así que ya se comportaba bien en el
    // caso que se usa. Se fija aquí para que la corrección del primario no se
    // "propague" luego en la dirección equivocada.
    testWidgets('trabajando con callback: opacidad plena', (tester) async {
      await pump(
        tester,
        RideGhostButton(
          label: 'Refresh customer data',
          loadingLabel: 'Asking the server…',
          loading: true,
          onPressed: () {},
        ),
      );

      expect(composedOpacity(tester, find.byType(RideGhostButton)), 1.0);
    });

    testWidgets('sin callback: 0.55', (tester) async {
      await pump(
        tester,
        const RideGhostButton(label: 'Refresh', onPressed: null),
      );

      expect(composedOpacity(tester, find.byType(RideGhostButton)), 0.55);
    });
  });
}
