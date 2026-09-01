import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:rideops/features/inspection/application/inspection_controller.dart';
import 'package:rideops/features/inspection/application/inspection_state.dart';
import 'package:rideops/features/inspection/presentation/widgets/inspection_bodies.dart';

import 'helpers/shell_test_helpers.dart';

/// El sub-paso de MÉTRICAS con el teclado numérico abierto (hallazgo e2e,
/// menor 2).
///
/// Lo observado en el patio: al teclear el odómetro, la fila de LIMPIEZA
/// quedaba recortada contra el pie del wizard y el teclado numérico no tenía
/// ninguna salida — ni tecla de acción, ni toque fuera: solo el BACK físico
/// del teléfono.
///
/// La geometría de esta suite reproduce el hueco real: el cuerpo del paso vive
/// en un `SingleChildScrollView` con el [WizardDock] debajo, y con el teclado
/// abierto ese viewport se queda en ~340 dp mientras el formulario mide ~450.

/// Controller inerte: el cuerpo solo LE HABLA (setters), nunca lee de él —
/// el estado entra por parámetro. Sobreescribir los setters evita montar un
/// `ProviderContainer` para probar una cuestión de layout.
class _StubController extends InspectionController {
  _StubController() : super('r1');

  int? cleanliness;
  int? odometer;

  @override
  void setOdometer(int? value) => odometer = value;

  @override
  void setFuelEighths(int eighths) {}

  @override
  void setCleanliness(int value) => cleanliness = value;

  @override
  void setNotes(String value) {}
}

void main() {
  const state = InspectionFlowState(
    phase: InspectionFlowPhase.active,
    step: InspectionStep.metrics,
    previousOdometer: 48190,
  );

  /// Altura del viewport de scroll que deja el teclado numérico abierto en un
  /// Android de gama media, una vez descontados el wizbar, el dock y la barra
  /// de sub-paso.
  const viewport = 340.0;

  /// Empuja el odómetro hacia abajo como lo hacen los banners del shell
  /// (offline, avance ajeno, ángulo muerto), que es cuando el problema
  /// aparece de verdad.
  const leadingHeight = 400.0;

  late _StubController controller;

  setUp(() => controller = _StubController());

  /// El cuerpo montado con la MISMA geometría que `_CaptureView`: scroll
  /// expandido arriba, pie fijo abajo.
  Future<ScrollController> pumpMetrics(
    WidgetTester tester, {
    double height = viewport,
    double leading = leadingHeight,
  }) async {
    final scroll = ScrollController();
    addTearDown(scroll.dispose);
    await tester.pumpWidget(
      l10nApp(
        Scaffold(
          body: Column(
            children: [
              SizedBox(
                height: height,
                child: SingleChildScrollView(
                  controller: scroll,
                  padding: const EdgeInsets.fromLTRB(14, 12, 14, 12),
                  child: InspectionMetricsBody(
                    state: state,
                    controller: controller,
                    leading: [SizedBox(height: leading)],
                  ),
                ),
              ),
              // El pie del wizard: lo que el agente veía tapando la fila.
              Container(height: 60, color: const Color(0xFFEEEEEE)),
            ],
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    return scroll;
  }

  Rect viewportRect(WidgetTester tester) =>
      tester.getRect(find.byType(SingleChildScrollView));

  testWidgets('al enfocar el odómetro, su bloque sube al TOPE del viewport y '
      'el selector de limpieza entra en pantalla', (tester) async {
    final scroll = await pumpMetrics(tester);

    // Punto de partida realista: el agente llega con el campo al borde de
    // abajo (es donde lo deja el auto-scroll mínimo del sistema). La fila de
    // limpieza está fuera de la pantalla.
    final odometerField = find.byType(TextField).first;
    scroll.jumpTo(tester.getRect(odometerField).bottom -
        viewportRect(tester).bottom +
        scroll.offset);
    await tester.pumpAndSettle();
    expect(
      tester.getRect(find.text('5')).top,
      greaterThan(viewportRect(tester).bottom),
      reason: 'punto de partida: la limpieza está fuera del viewport',
    );

    await tester.tap(odometerField);
    await tester.pumpAndSettle();

    // El campo enfocado se ve ENTERO (no solo el cursor, que es todo lo que
    // garantiza EditableText por su cuenta)…
    final field = tester.getRect(odometerField);
    final view = viewportRect(tester);
    expect(field.top, greaterThanOrEqualTo(view.top - 0.5));
    expect(field.bottom, lessThanOrEqualTo(view.bottom));
    // …y el espacio que queda debajo se gasta en los controles que siguen:
    // el selector de limpieza COMPLETO, que es lo que el agente toca después.
    final cleanliness = tester.getRect(find.text('5'));
    expect(cleanliness.top, greaterThanOrEqualTo(view.top));
    expect(
      cleanliness.bottom,
      lessThanOrEqualTo(view.bottom),
      reason: 'sin esto la fila se queda detrás del dock, que es el hallazgo',
    );
  });

  testWidgets('tocar fuera del campo cierra el teclado: en Android el '
      'onTapOutside por defecto NO desenfoca y el numérico se quedaba puesto',
      (tester) async {
    // Sin banners y con pantalla holgada: aquí lo que se prueba es la SALIDA
    // del teclado, no la geometría del viewport encogido.
    await pumpMetrics(tester, height: 540, leading: 0);
    final odometerField = find.byType(TextField).first;

    await tester.tap(odometerField);
    await tester.pumpAndSettle();
    expect(
      tester.testTextInput.isVisible,
      isTrue,
      reason: 'el teclado numérico está abierto',
    );

    // El agente toca el número de limpieza que quiere: UN gesto que selecciona
    // Y devuelve la pantalla completa.
    await tester.tap(find.text('4'));
    await tester.pumpAndSettle();

    expect(controller.cleanliness, 4);
    expect(
      tester.testTextInput.isVisible,
      isFalse,
      reason: 'antes solo lo cerraba el BACK físico del teléfono',
    );
  });

  testWidgets('el campo declara la acción "listo" del IME y la cablea a '
      'cerrar el teclado', (tester) async {
    await pumpMetrics(tester, height: 540, leading: 0);
    final odometerField = find.byType(TextField).first;

    final field = tester.widget<TextField>(odometerField);
    expect(
      field.textInputAction,
      TextInputAction.done,
      reason: 'es el último campo numérico del paso: la acción es cerrar, no '
          'saltar al siguiente',
    );

    await tester.tap(odometerField);
    await tester.pumpAndSettle();
    expect(tester.testTextInput.isVisible, isTrue);

    await tester.testTextInput.receiveAction(TextInputAction.done);
    await tester.pumpAndSettle();
    expect(tester.testTextInput.isVisible, isFalse);
  });

  testWidgets('SC-3: las NOTAS también cierran su teclado al tocar fuera — '
      'son multilínea, así que su tecla de acción es un salto de línea y el '
      'toque fuera es la ÚNICA salida que tienen', (tester) async {
    await pumpMetrics(tester, height: 540, leading: 0);
    // El segundo TextField del cuerpo es el de notas.
    final notes = find.byType(TextField).last;

    await tester.tap(notes);
    await tester.pumpAndSettle();
    expect(tester.testTextInput.isVisible, isTrue);

    await tester.tap(find.text('4'));
    await tester.pumpAndSettle();

    expect(controller.cleanliness, 4);
    expect(
      tester.testTextInput.isVisible,
      isFalse,
      reason: 'desenfocar SOLO el odómetro dejaba este teclado puesto',
    );
  });

  testWidgets('la última lectura se escribe con el MISMO formato y unidad que '
      'el paso 1 (menor 1: "48,190 mi", no "48190 mi" ni "48.190 km")',
      (tester) async {
    await pumpMetrics(tester, height: 540, leading: 0);
    expect(find.text('Last recorded reading: 48,190 mi'), findsOneWidget);
    // Y el sufijo del campo sale del MISMO token del catálogo.
    expect(
      tester
          .widget<TextField>(find.byType(TextField).first)
          .decoration!
          .suffixText,
      'mi',
    );
  });
}
