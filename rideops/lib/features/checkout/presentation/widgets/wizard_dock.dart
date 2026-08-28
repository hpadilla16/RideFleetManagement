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
class WizardDock extends StatelessWidget {
  const WizardDock({
    super.key,
    required this.primary,
    this.secondary,
    this.why,
  });

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
