import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../../core/api/enums.dart';
import '../../../../core/l10n/app_localizations.dart';
import '../../../../core/theme/ride_tokens.dart';
import '../../../../core/widgets/ride_buttons.dart';
import '../../application/checkout_wizard_controller.dart';
import '../../application/checkout_wizard_state.dart';

/// CTA de avance del wizard. Lo usan las pantallas de paso (H2–H5): el shell
/// solo lo provee.
///
/// Tres reglas que viven aquí para que ninguna pantalla de paso las repita
/// (ni las olvide):
///  1. **Anti-doble-tap**: mientras hay un POST en vuelo el botón queda
///     deshabilitado y en estado de carga; el controller además rechaza la
///     segunda llamada aunque alguien lo invoque por código.
///  2. **Deshabilitado CON CAUSA, no escondido** (8D): sin red se dice por
///     qué, y se declara la regla que el patio necesita interiorizar — los
///     pasos del checkout NO entran a la bandeja de salida (ADR-5); se
///     esperan.
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

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      mainAxisSize: MainAxisSize.min,
      children: [
        RidePrimaryButton(
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
        const SizedBox(height: 7),
        Text(
          state.offline ? l10n.coBlockedOfflineWhy : l10n.coTransitionWhy,
          style: const TextStyle(
            fontSize: 12,
            fontWeight: FontWeight.w700,
            color: RideTokens.n700,
          ),
        ),
      ],
    );
  }
}
