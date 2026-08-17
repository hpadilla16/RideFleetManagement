import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../../core/api/enums.dart';
import '../../../../core/l10n/app_localizations.dart';
import '../../../../core/theme/ride_tokens.dart';
import '../../../../core/widgets/ride_buttons.dart';
import '../../application/checkout_wizard_controller.dart';
import '../../application/checkout_wizard_state.dart';

/// **El DOCK del wizard** — CTA de avance + su subtexto, con el hairline
/// superior a sangre. Lo usan las pantallas de paso (H2–H5): el shell no
/// entrega solo el botón porque entonces cada historia inventaría su propio
/// dock y el pie del wizard cambiaría de forma entre pasos.
///
/// Geometría del mockup: `margin-top:auto` (lo pega abajo cuando el cuerpo es
/// un Column con Spacer o un scroll), hairline `--n-200` de borde a borde,
/// padding 12/0/0, gap 9, y el `.why` CENTRADO en 12.5/750 sobre `--n-700`
/// (8.53:1).
///
/// Tres reglas que viven aquí para que ninguna pantalla de paso las repita
/// (ni las olvide):
///  1. **Anti-doble-tap**: mientras hay un POST en vuelo el botón queda
///     deshabilitado y en estado de carga; el controller además rechaza la
///     segunda llamada aunque alguien lo invoque por código.
///  2. **Deshabilitado CON CAUSA, no escondido** (8D): sin red se dice por
///     qué, y se declara la regla que el patio necesita interiorizar — los
///     pasos del checkout NO entran a la bandeja de salida (ADR-5); se
///     esperan. La causa viaja también como hint de accesibilidad: un lector
///     de pantalla no puede quedarse solo con "botón atenuado".
///  3. El `toStep` viene de la pantalla, jamás de un cálculo sobre el
///     catálogo (ADR-4).
class TransitionButton extends ConsumerWidget {
  const TransitionButton({
    super.key,
    required this.reservationId,
    required this.toStep,
    required this.label,
    this.onOutcome,
  });

  final String reservationId;
  final CheckoutStep toStep;
  final String label;

  /// Le permite al paso reaccionar (navegar, mostrar algo) sin duplicar la
  /// matriz 409, que ya resolvió el controller.
  final void Function(CheckoutTransitionOutcome outcome)? onOutcome;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = AppLocalizations.of(context)!;
    final state = ref.watch(checkoutWizardProvider(reservationId));
    final enabled = state.canTransition;
    final why = state.offline ? l10n.coBlockedOfflineWhy : l10n.coTransitionWhy;

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
          Semantics(
            button: true,
            enabled: enabled,
            label: label,
            // Deshabilitado CON CAUSA también para quien no ve el gris.
            hint: enabled
                ? null
                : (state.offline ? l10n.coBlockedOfflineShort : null),
            child: ExcludeSemantics(
              child: RidePrimaryButton(
                label: label,
                loading: state.transitionInFlight,
                onPressed: enabled
                    ? () async {
                        final outcome = await ref
                            .read(checkoutWizardProvider(reservationId).notifier)
                            .transitionTo(toStep);
                        onOutcome?.call(outcome);
                      }
                    : null,
              ),
            ),
          ),
          const SizedBox(height: 9),
          Text(
            why,
            textAlign: TextAlign.center,
            style: const TextStyle(
              fontSize: 12.5,
              fontWeight: FontWeight.w700,
              color: RideTokens.n700,
            ),
          ),
        ],
      ),
    );
  }
}
