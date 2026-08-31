import 'package:flutter/material.dart';

import '../../../../core/theme/ride_tokens.dart';

/// **El pie del wizard**, una sola vez (review GD-SC-3).
///
/// [TransitionButton] ya declaraba que el dock vivía ahí "para que ninguna
/// pantalla de paso lo repita"… y H2 lo reimplementó DOS veces más (el dock de
/// conflicto de 9D y el de re-emisión de 10A/10D) con la misma geometría
/// copiada. Tres copias de un hairline son tres formas de que el pie del
/// wizard cambie de forma entre pasos sin que nadie lo note.
///
/// Geometría del mockup, y ya no se escribe en ningún otro lado:
/// hairline `--n-200` de borde a borde, padding 12/0/0, gap 9 entre piezas y
/// el `.why` CENTRADO en 12.5/750 sobre `--n-700` (8.53:1).
/// Cómo llega el aviso al pie sin que cada paso tenga que acordarse.
///
/// **Desviación consciente del diff del marco**, que proponía pasarlo por
/// parámetro desde el shell hasta el paso y de ahí al dock. En el código real
/// hay **15 sitios** que construyen [WizardDock] —seis solo en la inspección,
/// uno por sub-paso—, así que el enhebrado explícito significaría acertar en
/// los seis y que ningún paso futuro se olvide. Un aviso que desaparece porque
/// alguien no lo reenvió es justo el fallo silencioso que M2-H6 existe para no
/// tener.
///
/// El marco pide que los otros pies "lo hereden sin tocarlos", y esto lo
/// cumple literalmente: el shell publica el aviso y el ÚNICO widget que dibuja
/// el pie lo consume. Cero cambios en los 14 sitios.
class WizardDockNotice extends InheritedWidget {
  const WizardDockNotice({
    super.key,
    required this.notice,
    required super.child,
  });

  /// null = no hay nada que anunciar en el pie (el caso normal).
  final Widget? notice;

  static Widget? of(BuildContext context) => context
      .dependOnInheritedWidgetOfExactType<WizardDockNotice>()
      ?.notice;

  @override
  bool updateShouldNotify(WizardDockNotice oldWidget) =>
      oldWidget.notice != notice;
}

class WizardDock extends StatelessWidget {
  const WizardDock({
    super.key,
    this.leading,
    required this.primary,
    this.secondary,
    this.why,
  });

  /// Aviso NO accionable que tiene que estar SIEMPRE visible sin tapar el
  /// primario (M2-H6, marco 21C-bis). Va ARRIBA del CTA y DENTRO del único
  /// filete del pie: en flujo, no superpuesto.
  ///
  /// Nace del avance ajeno por SELLO, que llega con el paso intacto y muchas
  /// veces con el agente tecleando. Estaba debajo del dock, y ahí el pie más
  /// alcanzable —el que el pulgar encuentra sin recolocar la mano— lo ocupaba
  /// información, mientras el CTA que continúa el trabajo quedaba 127 px más
  /// arriba. La prioridad estaba invertida.
  ///
  /// Se resuelve aquí y no en cada paso por lo mismo que este archivo existe
  /// (review GD-SC-3): el pie del wizard se escribe UNA vez. Es opcional, así
  /// que los pies que ya existen (9D, 10D) lo heredan sin tocarse.
  final Widget? leading;

  /// Acción principal del pie. Cada paso decide cuál es: avanzar (9A/10C),
  /// elegir otra unidad (9D) o re-emitir el código (10D).
  final Widget primary;

  /// Acción de apoyo. Va DEBAJO del primario y encima del [why].
  final Widget? secondary;

  /// Subtexto que explica el estado del pie. Siempre centrado; null lo omite
  /// junto con su separación.
  final String? why;

  @override
  Widget build(BuildContext context) {
    final why_ = why;
    // El parámetro gana al heredado: un pie puede pedir su propio aviso, y así
    // el widget sigue siendo probable en aislamiento.
    final leading_ = leading ?? WizardDockNotice.of(context);
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.fromLTRB(0, 12, 0, 0),
      decoration: const BoxDecoration(
        border: Border(top: BorderSide(color: RideTokens.n200)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        mainAxisSize: MainAxisSize.min,
        children: [
          if (leading_ != null) ...[
            leading_,
            // El mismo gap de 9 px que ya separan `secondary` y `why`: el pie
            // tiene un ritmo y el aviso no introduce uno nuevo.
            const SizedBox(height: 9),
          ],
          primary,
          if (secondary != null) ...[
            const SizedBox(height: 9),
            secondary!,
          ],
          if (why_ != null) ...[
            const SizedBox(height: 9),
            Text(
              why_,
              textAlign: TextAlign.center,
              style: const TextStyle(
                fontSize: 12.5,
                fontWeight: FontWeight.w700,
                color: RideTokens.n700,
              ),
            ),
          ],
        ],
      ),
    );
  }
}
