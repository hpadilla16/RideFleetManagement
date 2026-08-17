import 'package:flutter/material.dart';

import '../../../../core/l10n/app_localizations.dart';
import '../../../../core/theme/ride_tokens.dart';
import '../../application/checkout_wizard_state.dart';
import '../../domain/checkout_presence.dart';
import '../../domain/checkout_step_catalog.dart';
import '../checkout_labels.dart';

/// Cromo del wizard (mockup 8A–8F): wizbar, header de sesión (+ su variante
/// mini), rail de 5 fases y stepline.
///
/// Nada de esto decide estado: recibe lo que el servidor reportó y lo pinta.

/// Barra superior. "Pausar" SIEMPRE visible y de 48 px (nota 1): en el patio
/// la interrupción es la norma. La flecha de atrás hace lo mismo con
/// confirmación — nunca se sale de un checkout sin decidir explícitamente.
class WizardBar extends StatelessWidget {
  const WizardBar({
    super.key,
    required this.title,
    this.subtitle,
    required this.onBack,
    this.onPause,
  });

  final String title;
  final String? subtitle;
  final VoidCallback onBack;

  /// null durante el primer fetch (8F): no se ofrece pausar algo que todavía
  /// no se sabe si existe.
  final VoidCallback? onPause;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
      decoration: const BoxDecoration(
        // Plate opaco .96 — política de blur del M1 (nada de BackdropFilter
        // sin señal de capacidad).
        color: Color(0xF5FFFFFF),
        border: Border(bottom: BorderSide(color: RideTokens.n200)),
      ),
      child: Row(
        children: [
          Semantics(
            button: true,
            label: MaterialLocalizations.of(context).backButtonTooltip,
            onTap: onBack,
            child: ExcludeSemantics(
              child: _IconButtonBox(
                icon: Icons.arrow_back_rounded,
                onTap: onBack,
              ),
            ),
          ),
          const SizedBox(width: 10),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(
                  title,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(
                    fontSize: 15.5,
                    fontWeight: FontWeight.w900,
                    color: RideTokens.n900,
                  ),
                ),
                if (subtitle != null && subtitle!.isNotEmpty)
                  Text(
                    subtitle!,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(
                      fontSize: 12,
                      fontWeight: FontWeight.w700,
                      // --n-700 y no --n-600: sobre tonal, n600 mide 4.58:1 y
                      // se lava al sol (nota 2).
                      color: RideTokens.n700,
                    ),
                  ),
              ],
            ),
          ),
          if (onPause != null) ...[
            const SizedBox(width: 8),
            _PauseButton(label: l10n.coPause, onTap: onPause!),
          ],
        ],
      ),
    );
  }
}

class _IconButtonBox extends StatelessWidget {
  const _IconButtonBox({required this.icon, required this.onTap});

  final IconData icon;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return Material(
      color: RideTokens.n0,
      borderRadius: BorderRadius.circular(14),
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(14),
        child: Container(
          width: 48,
          height: 48,
          decoration: BoxDecoration(
            border: Border.all(color: RideTokens.n300, width: 1.5),
            borderRadius: BorderRadius.circular(14),
          ),
          child: Icon(icon, size: 20, color: RideTokens.n800),
        ),
      ),
    );
  }
}

class _PauseButton extends StatelessWidget {
  const _PauseButton({required this.label, required this.onTap});

  final String label;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return Material(
      color: RideTokens.n0,
      borderRadius: BorderRadius.circular(14),
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(14),
        child: Container(
          constraints: const BoxConstraints(minHeight: 48, minWidth: 48),
          padding: const EdgeInsets.symmetric(horizontal: 12),
          decoration: BoxDecoration(
            border: Border.all(color: RideTokens.n300, width: 1.5),
            borderRadius: BorderRadius.circular(14),
          ),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              const Icon(Icons.pause_rounded, size: 16, color: RideTokens.n800),
              const SizedBox(width: 5),
              Text(
                label,
                style: const TextStyle(
                  fontSize: 13,
                  fontWeight: FontWeight.w800,
                  color: RideTokens.n800,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// Header de sesión: las 3 respuestas del patio — a quién atiendo, qué unidad
/// entrego, quién más está en la sesión.
///
/// [mini] es la variante compacta del mockup: la usan las pantallas de paso
/// (H2–H5, frames 9x/10x), la vista offline (8D) y el fondo de los sheets
/// (8B/8E). La variante completa se reserva para el arranque (8A), el aviso de
/// avance ajeno (8C) y el skeleton (8F), donde establecer contexto vale el
/// alto que ocupa.
class SessionHead extends StatelessWidget {
  const SessionHead({
    super.key,
    required this.context_,
    required this.presence,
    this.mini = false,
  });

  final CheckoutReservationContext? context_;
  final PresenceChipData? presence;
  final bool mini;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    final customer = context_?.customerName;
    final vehicle = context_?.vehicleLabel;
    final chip = presence == null
        ? null
        : PresenceChip(data: presence!, mini: mini);

    if (mini) {
      final who = [customer, vehicle].nonNulls
          .where((p) => p.isNotEmpty)
          .join(' · ');
      return Container(
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 7),
        decoration: const BoxDecoration(
          color: RideTokens.tonal,
          border: Border(bottom: BorderSide(color: RideTokens.n200)),
        ),
        child: Row(
          children: [
            const Icon(Icons.person_outline_rounded,
                size: 16, color: RideTokens.p800),
            const SizedBox(width: 7),
            Expanded(
              child: Text(
                who.isEmpty ? l10n.coTitleNoNumber : who,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: const TextStyle(
                  fontSize: 13.5,
                  fontWeight: FontWeight.w800,
                  color: RideTokens.n900,
                ),
              ),
            ),
            if (chip != null) ...[const SizedBox(width: 8), chip],
          ],
        ),
      );
    }

    final plateLine = [
      if (context_?.plate != null && context_!.plate!.isNotEmpty)
        context_!.plate!,
    ].join(' · ');

    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 11),
      decoration: const BoxDecoration(
        color: RideTokens.tonal,
        border: Border(bottom: BorderSide(color: RideTokens.n200)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          _SessionRow(
            icon: Icons.person_outline_rounded,
            title: customer ?? '—',
            subtitle: context_?.reservationNumber,
          ),
          if (vehicle != null && vehicle.isNotEmpty) ...[
            const SizedBox(height: 9),
            _SessionRow(
              icon: Icons.directions_car_outlined,
              title: vehicle,
              subtitle: plateLine.isEmpty ? null : plateLine,
            ),
          ],
          if (chip != null) ...[
            const SizedBox(height: 9),
            Align(alignment: Alignment.centerLeft, child: chip),
          ],
        ],
      ),
    );
  }
}

class _SessionRow extends StatelessWidget {
  const _SessionRow({
    required this.icon,
    required this.title,
    this.subtitle,
  });

  final IconData icon;
  final String title;
  final String? subtitle;

  @override
  Widget build(BuildContext context) {
    return Row(
      crossAxisAlignment: CrossAxisAlignment.center,
      children: [
        Container(
          width: 38,
          height: 38,
          decoration: BoxDecoration(
            color: RideTokens.n0,
            borderRadius: BorderRadius.circular(13),
            border: Border.all(color: RideTokens.n200),
          ),
          child: Icon(icon, size: 20, color: RideTokens.p800),
        ),
        const SizedBox(width: 10),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisSize: MainAxisSize.min,
            children: [
              Text(
                title,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: const TextStyle(
                  fontSize: 14.5,
                  fontWeight: FontWeight.w900,
                  color: RideTokens.n900,
                ),
              ),
              if (subtitle != null && subtitle!.isNotEmpty)
                Text(
                  subtitle!,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(
                    fontSize: 12,
                    fontWeight: FontWeight.w700,
                    color: RideTokens.n700,
                  ),
                ),
            ],
          ),
        ),
      ],
    );
  }
}

/// Chip de presencia (P1). Informativo y jamás un candado: no bloquea nada y
/// desaparece solo cuando el heartbeat pasa el TTL, sin aviso ni funeral.
///
/// El punto sale de la EDAD del `lastSeenAt`, no de un booleano del servidor:
/// verde solo mientras el dato respalda la afirmación "está AHORA".
class PresenceChip extends StatelessWidget {
  const PresenceChip({super.key, required this.data, this.mini = false});

  final PresenceChipData data;
  final bool mini;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    final lastSeen = data.entry.lastSeenAt;
    final age = lastSeen == null
        ? Duration.zero
        : DateTime.now().difference(lastSeen);
    final text = l10n.coPresenceLine(
      data.entry.displayName,
      surfaceLabel(l10n, data.entry.surface),
      checkoutAgeLabel(l10n, age),
    );
    return Container(
      constraints: BoxConstraints(minHeight: mini ? 32 : 34),
      padding: EdgeInsets.symmetric(horizontal: mini ? 9 : 10, vertical: 4),
      decoration: BoxDecoration(
        color: RideTokens.p50,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: RideTokens.p200),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Container(
            width: 7,
            height: 7,
            decoration: BoxDecoration(
              shape: BoxShape.circle,
              color: data.freshness == PresenceFreshness.live
                  ? RideTokens.ok
                  : RideTokens.n400,
            ),
          ),
          const SizedBox(width: 6),
          Flexible(
            child: Text(
              text,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(
                fontSize: mini ? 11.5 : 12.5,
                fontWeight: FontWeight.w700,
                color: RideTokens.p800,
              ),
            ),
          ),
          if (data.others > 0) ...[
            const SizedBox(width: 6),
            Text(
              l10n.coPresenceMore(data.others),
              style: const TextStyle(
                fontSize: 11.5,
                fontWeight: FontWeight.w900,
                color: RideTokens.p800,
              ),
            ),
          ],
        ],
      ),
    );
  }
}

/// Rail de 5 fases. La agrupación es SOLO presentación (nota 4): 10 nodos de
/// 24 px no caben legibles en 390 px con guantes. Lo que viene se dibuja gris
/// inerte y no se calcula.
class PhaseRail extends StatelessWidget {
  const PhaseRail({super.key, required this.currentPosition});

  /// null = el servidor reporta un paso que la app no ubica en la cadena
  /// (paso nuevo, o CANCELLED): TODO queda pendiente, nada se afirma.
  final int? currentPosition;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 9),
      color: RideTokens.n0,
      child: Row(
        children: [
          for (var i = 0; i < kCheckoutPhases.length; i++)
            Expanded(
              child: _PhaseNode(
                index: i + 1,
                label: phaseLabel(l10n, kCheckoutPhases[i]),
                state: phaseStateFor(kCheckoutPhases[i], currentPosition),
              ),
            ),
        ],
      ),
    );
  }
}

class _PhaseNode extends StatelessWidget {
  const _PhaseNode({
    required this.index,
    required this.label,
    required this.state,
  });

  final int index;
  final String label;
  final PhaseNodeState state;

  @override
  Widget build(BuildContext context) {
    final (bg, fg, border) = switch (state) {
      PhaseNodeState.done => (RideTokens.okBg, RideTokens.okTx, RideTokens.okBd),
      PhaseNodeState.current => (RideTokens.p50, RideTokens.p800, RideTokens.p200),
      PhaseNodeState.pending => (RideTokens.n0, RideTokens.n600, RideTokens.n300),
    };
    return Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        Container(
          width: 24,
          height: 24,
          alignment: Alignment.center,
          decoration: BoxDecoration(
            color: bg,
            shape: BoxShape.circle,
            border: Border.all(color: border, width: 1.5),
          ),
          // El glifo ✓ es NO-TEXTO (icono ≥ 3:1): el estado legible es la
          // etiqueta de abajo, no el símbolo.
          child: state == PhaseNodeState.done
              ? const Icon(Icons.check_rounded, size: 14, color: RideTokens.okTx)
              : Text(
                  '$index',
                  style: TextStyle(
                    fontSize: 11.5,
                    fontWeight: FontWeight.w900,
                    color: fg,
                  ),
                ),
        ),
        const SizedBox(height: 4),
        Text(
          label,
          maxLines: 1,
          overflow: TextOverflow.ellipsis,
          textAlign: TextAlign.center,
          style: TextStyle(
            fontSize: 10.5,
            fontWeight: FontWeight.w800,
            color: fg,
          ),
        ),
      ],
    );
  }
}

/// Stepline: contador honesto + nombre del paso + acceso a la lista completa.
/// Es también donde vive la honestidad del dato: en offline se tiñe y añade
/// "vista de hace X" (8D) en lugar de fingir que está vivo.
class StepLine extends StatelessWidget {
  const StepLine({
    super.key,
    required this.rawStep,
    required this.position,
    required this.onTap,
    this.staleAge,
  });

  final String rawStep;

  /// null ⇒ paso fuera de la cadena lineal: se omite el contador en vez de
  /// inventar un número.
  final int? position;
  final VoidCallback onTap;

  /// Edad del dato cuando la lectura ya no está viva (offline / error).
  final Duration? staleAge;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    final stale = staleAge != null;
    final label = stepLabel(l10n, rawStep);
    return Material(
      color: stale ? RideTokens.n50 : RideTokens.n0,
      child: InkWell(
        onTap: onTap,
        child: Container(
          constraints: const BoxConstraints(minHeight: 48), // target DoD #2
          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 8),
          decoration: const BoxDecoration(
            border: Border(
              top: BorderSide(color: RideTokens.n200),
              bottom: BorderSide(color: RideTokens.n200),
            ),
          ),
          child: Row(
            children: [
              if (position != null) ...[
                Container(
                  padding:
                      const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                  decoration: BoxDecoration(
                    color: RideTokens.p50,
                    borderRadius: BorderRadius.circular(8),
                  ),
                  child: Text(
                    l10n.coStepOf(position!, kCheckoutLinearStepCount),
                    style: const TextStyle(
                      fontSize: 11.5,
                      fontWeight: FontWeight.w900,
                      color: RideTokens.p800,
                    ),
                  ),
                ),
                const SizedBox(width: 9),
              ],
              Expanded(
                child: Text(
                  stale
                      ? '$label · ${l10n.coStaleView(checkoutAgeLabel(l10n, staleAge!))}'
                      : label,
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                    fontSize: 13.5,
                    fontWeight: FontWeight.w800,
                    color: stale ? RideTokens.n700 : RideTokens.n900,
                  ),
                ),
              ),
              const SizedBox(width: 8),
              Text(
                l10n.coSeeAllSteps,
                style: const TextStyle(
                  fontSize: 12,
                  fontWeight: FontWeight.w800,
                  color: RideTokens.p700,
                ),
              ),
              const Icon(Icons.chevron_right_rounded,
                  size: 18, color: RideTokens.p700),
            ],
          ),
        ),
      ),
    );
  }
}
