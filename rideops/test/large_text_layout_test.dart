import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:rideops/core/l10n/app_localizations.dart';
import 'package:rideops/core/widgets/ride_buttons.dart';
import 'package:rideops/features/checkout/presentation/widgets/wizard_chrome.dart';
import 'package:rideops/features/inspection/presentation/widgets/angle_labels.dart';

/// **Piezas compartidas bajo texto grande** (review GD-MC-4 y su SHOULD).
///
/// Las dos que se prueban aquí son de USO TRANSVERSAL —el botón primario lo
/// montan H1, H2, H4 y H7; la stepline es el cromo de todo el wizard— y las dos
/// fallaban igual: un hijo NO flexible de un `Row` se mide con ancho ilimitado,
/// así que no envuelve nunca y desborda con franjas amarillas en vez de
/// adaptarse. Con las etiquetas más largas de la app (es) y la escala de texto
/// que un agente de patio sí usa bajo el sol, eso rompía el ÚNICO CTA de
/// pantallas sin salida alternativa (17E).
///
/// El desbordamiento de render se reporta como excepción de framework: por eso
/// la aserción es `takeException()`, y no una foto.
void main() {
  Widget scaled({
    required double scale,
    required Widget child,
    Locale locale = const Locale('es'),
  }) =>
      MaterialApp(
        locale: locale,
        localizationsDelegates: const [
          AppLocalizations.delegate,
          GlobalMaterialLocalizations.delegate,
          GlobalWidgetsLocalizations.delegate,
          GlobalCupertinoLocalizations.delegate,
        ],
        supportedLocales: const [Locale('es'), Locale('en')],
        builder: (context, widget) => MediaQuery(
          data: MediaQuery.of(context)
              .copyWith(textScaler: TextScaler.linear(scale)),
          child: widget!,
        ),
        home: Scaffold(body: child),
      );

  testWidgets(
      'el CTA primario ENVUELVE la etiqueta más larga de H4 en vez de '
      'desbordar (es · escala 1.5)', (tester) async {
    // El ancho real del dock del wizard en un teléfono de 360 dp: 332 px.
    await tester.pumpWidget(scaled(
      scale: 1.5,
      child: Center(
        child: SizedBox(
          width: 332,
          child: Builder(
            builder: (context) {
              final l10n = AppLocalizations.of(context)!;
              return RidePrimaryButton(
                // "Tomar Lado izquierdo otra vez" — la etiqueta más larga que
                // produce el paso 4 (17E).
                label: l10n.coInspRetakeCta(angleLabel(l10n, 'left')),
                onPressed: () {},
              );
            },
          ),
        ),
      ),
    ));
    await tester.pumpAndSettle();

    expect(tester.takeException(), isNull);
    // Y no "cabe" por haberse recortado: envolvió dentro del botón, que creció
    // por encima de sus 56 px mínimos.
    final button = tester.getSize(find.byType(RidePrimaryButton));
    expect(button.width, 332);
    expect(button.height, greaterThan(56));
    expect(tester.getSize(find.byType(Text)).width, lessThanOrEqualTo(300));
  });

  testWidgets('la stepline no desborda con el nombre y el trailing más largos '
      '(320 dp · escala 2.0)', (tester) async {
    tester.view.physicalSize = const Size(320, 640);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);

    await tester.pumpWidget(scaled(
      scale: 2,
      child: StepLine(
        rawStep: 'INSPECTION_IN_PROGRESS',
        position: 7,
        onTap: () {},
      ),
    ));
    await tester.pumpAndSettle();

    expect(tester.takeException(), isNull);
  });

  testWidgets('el tope de los extremos es LAXO: con sitio, cada pieza mide lo '
      'suyo y nadie se parte en dos renglones', (tester) async {
    // Ancho de sobra para las tres piezas. La fuente de los tests dibuja cada
    // glifo cuadrado (mucho más ancha que la real), así que "hay sitio" se
    // demuestra con holgura y no con los píxeles de un teléfono concreto.
    tester.view.physicalSize = const Size(900, 600);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);

    await tester.pumpWidget(scaled(
      scale: 1,
      locale: const Locale('en'),
      child: StepLine(
        rawStep: 'INSPECTION_IN_PROGRESS',
        position: 7,
        onTap: () {},
      ),
    ));
    await tester.pumpAndSettle();

    // El acceso al mapa de pasos sigue en UNA línea: es justo lo que un
    // `Flexible` a secas habría estrangulado, porque el reparto de un Row es
    // por flex y no por necesidad.
    expect(tester.getSize(find.text('See every step')).height, lessThan(20));
    expect(tester.getSize(find.text('Step 7 of 10')).height, lessThan(20));
    expect(
      tester.getSize(find.text('Inspection in progress')).height,
      lessThan(24),
    );
  });
}
