import 'package:flutter/material.dart';

import '../../../../core/l10n/app_localizations.dart';
import '../../../../core/theme/ride_tokens.dart';
import '../../../../core/widgets/ride_buttons.dart';
import '../../domain/checkout_step_catalog.dart';
import 'wizard_banners.dart';

/// 8E — "Guardar y pausar" (`POST /:id/abandon`).
///
/// Consecuencias EXPLÍCITAS en dos bloques (qué se conserva / qué puede
/// pasar). La frase clave —"al volver entras al paso que reporte el
/// servidor"— es ADR-4 dicho en lenguaje de patio: evita la queja "lo dejé en
/// pago y volvió a inspección".
class PauseSheet extends StatelessWidget {
  const PauseSheet({
    super.key,
    required this.position,
    required this.pausing,
    required this.onConfirm,
    required this.onStay,
  });

  /// null cuando el servidor reporta un paso fuera de la cadena: el copy no
  /// menciona un número que no puede afirmar.
  final int? position;
  final bool pausing;
  final VoidCallback onConfirm;
  final VoidCallback onStay;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 10, 16, 16),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Center(
            child: Container(
              width: 42,
              height: 4,
              decoration: BoxDecoration(
                color: RideTokens.n300,
                borderRadius: BorderRadius.circular(2),
              ),
            ),
          ),
          const SizedBox(height: 12),
          Text(
            l10n.coPauseTitle,
            style: const TextStyle(
              fontSize: 17,
              fontWeight: FontWeight.w900,
              color: RideTokens.n900,
            ),
          ),
          const SizedBox(height: 3),
          Text(
            position == null
                ? l10n.coPauseSubUnknownStep
                : l10n.coPauseSub(position!, kCheckoutLinearStepCount),
            style: const TextStyle(
              fontSize: 12.5,
              fontWeight: FontWeight.w700,
              color: RideTokens.n700,
            ),
          ),
          const SizedBox(height: 12),
          WizardBanner(
            icon: Icons.check_rounded,
            iconColor: RideTokens.okTx,
            background: RideTokens.okBg,
            border: RideTokens.okBd,
            child: Text(
              l10n.coPauseKeeps,
              style: const TextStyle(
                fontSize: 12.5,
                fontWeight: FontWeight.w700,
                color: RideTokens.okTx,
              ),
            ),
          ),
          const SizedBox(height: 10),
          WizardBanner(
            icon: Icons.schedule_rounded,
            iconColor: RideTokens.warnTx,
            background: RideTokens.warnBg,
            border: RideTokens.warnBd,
            child: Text(
              l10n.coPauseWarn,
              style: const TextStyle(
                fontSize: 12.5,
                fontWeight: FontWeight.w700,
                color: RideTokens.warnTx,
              ),
            ),
          ),
          const SizedBox(height: 14),
          RidePrimaryButton(
            label: l10n.coPauseConfirm,
            loading: pausing,
            onPressed: pausing ? null : onConfirm,
          ),
          const SizedBox(height: 9),
          RideGhostButton(label: l10n.coPauseStay, onPressed: onStay),
        ],
      ),
    );
  }
}
