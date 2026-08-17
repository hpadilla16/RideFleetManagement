import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../../core/api/enums.dart';
import '../../../../core/l10n/app_localizations.dart';
import '../../../../core/widgets/ride_buttons.dart';
import '../../application/checkout_wizard_controller.dart';
import '../../application/checkout_wizard_state.dart';
import 'wizard_dock.dart';

/// **CTA de avance del wizard**, montado sobre el [WizardDock] común. Lo usan
/// las pantallas de paso (H2–H5): el shell no entrega solo el botón porque
/// entonces cada historia inventaría su propio pie y el dock del wizard
/// cambiaría de forma entre pasos.
///
/// La geometría (hairline, paddings, gaps, el `.why` centrado) vive en
/// [WizardDock] desde el review GD-SC-3 — aquí solo queda la LÓGICA del CTA.
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
    this.why,
    this.blockedWhy,
    this.secondary,
  });

  final String reservationId;
  final CheckoutStep toStep;
  final String label;

  /// Le permite al paso reaccionar (navegar, mostrar algo) sin duplicar la
  /// matriz 409, que ya resolvió el controller.
  final void Function(CheckoutTransitionOutcome outcome)? onOutcome;

  /// Subtexto del dock cuando el CTA está HABILITADO. Cada paso puede
  /// explicar por qué su botón existe: en 10C, "este botón solo existe porque
  /// el servidor ya tiene la firma registrada" es ADR-4 dicho en voz alta.
  /// Sin él se usa el texto genérico del wizard.
  final String? why;

  /// Bloqueo LOCAL con su causa ya redactada (9B: "Faltan licencia y teléfono
  /// del cliente…"). No sustituye al servidor —el cliente valida para ahorrar
  /// viajes, nunca para reemplazar la máquina (ADR-4)— y por eso el paso que
  /// lo usa tiene que ofrecer además la salida: aquí abajo, en [secondary].
  ///
  /// Regla que este parámetro protege: el CTA **no se esconde**, se bloquea
  /// diciendo QUÉ falta. Un botón ausente no se puede preguntar.
  final String? blockedWhy;

  /// Acción secundaria del dock (9B "Volver a consultar", 9D "Elegir otro
  /// vehículo"). Va DEBAJO del primario y encima del `.why`.
  final Widget? secondary;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = AppLocalizations.of(context)!;
    final state = ref.watch(checkoutWizardProvider(reservationId));
    final enabled = state.canTransition && blockedWhy == null;
    final whyText = blockedWhy ??
        (state.offline
            ? l10n.coBlockedOfflineWhy
            : (why ?? l10n.coTransitionWhy));

    return WizardDock(
      why: whyText,
      secondary: secondary,
      primary: Semantics(
        button: true,
        enabled: enabled,
        label: label,
        // Deshabilitado CON CAUSA también para quien no ve el gris.
        hint: enabled
            ? null
            : (blockedWhy ??
                (state.offline ? l10n.coBlockedOfflineShort : null)),
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
    );
  }
}
