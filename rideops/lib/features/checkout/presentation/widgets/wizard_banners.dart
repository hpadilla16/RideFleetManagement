import 'package:flutter/material.dart';

import '../../../../core/l10n/app_localizations.dart';
import '../../../../core/theme/ride_tokens.dart';
import '../../application/checkout_wizard_state.dart';
import '../../domain/checkout_event_log.dart';
import '../checkout_labels.dart';

/// Banners del shell: avance ajeno (8C) y sin red (8D).

/// Contenedor común. El color del icono es semántico; el TEXTO siempre va en
/// la rampa neutra alta — un azul/ámbar de texto sobre su propio fondo no da
/// margen al sol del patio.
class WizardBanner extends StatelessWidget {
  const WizardBanner({
    super.key,
    required this.icon,
    required this.iconColor,
    required this.background,
    required this.border,
    required this.child,
  });

  final IconData icon;
  final Color iconColor;
  final Color background;
  final Color border;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.fromLTRB(11, 10, 11, 10),
      decoration: BoxDecoration(
        color: background,
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: border),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(icon, size: 18, color: iconColor),
          const SizedBox(width: 9),
          Expanded(child: child),
        ],
      ),
    );
  }
}

/// 8C — otra superficie avanzó este paso.
///
/// INFORMATIVO, nunca modal: con 4 superficies conviviendo, un diálogo por
/// avance ajeno sería un bloqueo cada pocos minutos. El stepper ya se movió
/// solo; esto solo explica por qué.
class ForeignAdvanceBanner extends StatelessWidget {
  const ForeignAdvanceBanner({
    super.key,
    required this.notice,
    required this.onSeeChanged,
  });

  final ForeignAdvanceNotice notice;
  final VoidCallback onSeeChanged;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    final age = notice.at == null
        ? null
        : checkoutAgeLabel(l10n, DateTime.now().difference(notice.at!));
    final completed = stepLabel(l10n, notice.completedStep);
    final head = switch (notice.actor) {
      CheckoutActorKind.kiosk =>
        l10n.coAdvancedKiosk(completed, age ?? l10n.ageMoment),
      CheckoutActorKind.otherAgent =>
        l10n.coAdvancedOtherAgent(completed, age ?? l10n.ageMoment),
      // "otra superficie" cubre tanto al sistema como a un actor que el log
      // no identifica: se dice lo que se sabe, no más.
      _ => l10n.coAdvancedOtherSurface(completed, age ?? l10n.ageMoment),
    };
    return WizardBanner(
      icon: Icons.info_outline_rounded,
      iconColor: RideTokens.focus,
      background: const Color(0xFFEAF2FE),
      border: const Color(0xFFC9DDF8),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: [
          Text(
            '$head ${l10n.coAdvancedNow(stepLabel(l10n, notice.currentStep))}',
            style: const TextStyle(
              fontSize: 12.5,
              fontWeight: FontWeight.w700,
              color: RideTokens.n800,
            ),
          ),
          const SizedBox(height: 4),
          InkWell(
            onTap: onSeeChanged,
            child: Container(
              constraints: const BoxConstraints(minHeight: 32),
              alignment: Alignment.centerLeft,
              child: Text(
                l10n.coAdvancedSeeChanged,
                style: const TextStyle(
                  fontSize: 12.5,
                  fontWeight: FontWeight.w900,
                  color: RideTokens.p700,
                  decoration: TextDecoration.underline,
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }
}

/// 8D — sin red, honesto.
///
/// La advertencia específica del M2 no es "dato viejo": es dato viejo
/// MIENTRAS otra superficie puede estar avanzando.
class OfflineBanner extends StatelessWidget {
  const OfflineBanner({super.key, required this.age, required this.onRetry});

  final Duration age;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    return WizardBanner(
      icon: Icons.warning_amber_rounded,
      iconColor: RideTokens.warnTx,
      background: RideTokens.warnBg,
      border: RideTokens.warnBd,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: [
          Text(
            l10n.coOfflineBanner(checkoutAgeLabel(l10n, age)),
            style: const TextStyle(
              fontSize: 12.5,
              fontWeight: FontWeight.w700,
              color: RideTokens.warnTx,
            ),
          ),
          const SizedBox(height: 4),
          InkWell(
            onTap: onRetry,
            child: Container(
              constraints: const BoxConstraints(minHeight: 32),
              alignment: Alignment.centerLeft,
              child: Text(
                l10n.retryButton,
                style: const TextStyle(
                  fontSize: 12.5,
                  fontWeight: FontWeight.w900,
                  color: RideTokens.warnTx,
                  decoration: TextDecoration.underline,
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }
}

/// Negativa del servidor tras un 409 ya reconciliado (matriz de ADR-4). El
/// mensaje SIEMPRE es el del backend; el título solo lo enmarca.
class ConflictBanner extends StatelessWidget {
  const ConflictBanner({
    super.key,
    required this.conflict,
    required this.onDismiss,
  });

  final CheckoutConflict conflict;
  final VoidCallback onDismiss;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    final title = switch (conflict.kind) {
      CheckoutConflictKind.entryGuard => l10n.coConflictEntryGuardTitle,
      CheckoutConflictKind.vehicleConflict => l10n.coConflictVehicleTitle,
      CheckoutConflictKind.terminal => l10n.coTerminalBody,
      CheckoutConflictKind.generic => l10n.coConflictGenericTitle,
    };
    // ENTRY_GUARD: además del mensaje del servidor, se nombra QUÉ falta con
    // el mismo copy que la lista de pasos ya anticipaba con el candado.
    final guardLine = conflict.guard == null
        ? null
        : guardLabel(l10n, conflict.guard!);
    return WizardBanner(
      icon: Icons.error_outline_rounded,
      iconColor: RideTokens.dangerTx,
      background: RideTokens.dangerBg,
      border: RideTokens.dangerBd,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: [
          Text(
            title,
            style: const TextStyle(
              fontSize: 13,
              fontWeight: FontWeight.w900,
              color: RideTokens.dangerTx,
            ),
          ),
          if (guardLine != null)
            Text(
              guardLine,
              style: const TextStyle(
                fontSize: 12.5,
                fontWeight: FontWeight.w800,
                color: RideTokens.dangerTx,
              ),
            ),
          Text(
            conflict.message,
            style: const TextStyle(
              fontSize: 12.5,
              fontWeight: FontWeight.w700,
              color: RideTokens.n800,
            ),
          ),
          const SizedBox(height: 4),
          InkWell(
            onTap: onDismiss,
            child: Container(
              constraints: const BoxConstraints(minHeight: 32),
              alignment: Alignment.centerLeft,
              child: Text(
                l10n.coConflictDismiss,
                style: const TextStyle(
                  fontSize: 12.5,
                  fontWeight: FontWeight.w900,
                  color: RideTokens.dangerTx,
                  decoration: TextDecoration.underline,
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }
}
