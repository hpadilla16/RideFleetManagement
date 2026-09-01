import 'package:flutter/material.dart';
import 'package:intl/intl.dart';

import '../../../../core/l10n/app_localizations.dart';
import '../../../../core/theme/ride_tokens.dart';
import '../../../../core/widgets/ride_buttons.dart';
import '../../domain/checkout_changes.dart';
import '../../domain/checkout_event_log.dart';
import '../checkout_labels.dart';
import 'wizard_banners.dart';

/// Frame 21B — "Qué cambió desde que entraste".
///
/// El botón "Ver qué cambió" existe desde H1 y hasta hoy abría la lista de
/// pasos, que responde OTRA pregunta ("¿dónde va la sesión?"). Esta hoja
/// responde la que el agente trae: **¿qué se movió mientras yo estaba dentro,
/// quién lo movió, y perdí algo?**
///
/// El orden no es decorativo: primero lo que cambió, luego el inventario
/// completo, y al final —en verde o en ámbar— la única frase que el agente
/// vino a leer.
class ChangedSheet extends StatelessWidget {
  const ChangedSheet({
    super.key,
    required this.changes,
    required this.currentPosition,
    required this.pendingUploads,
    required this.onStay,
  });

  final CheckoutChangeSet changes;

  /// Posición del paso actual, para el CTA "Seguir en el paso N". Null (paso
  /// fuera del catálogo) ⇒ el CTA se queda en "Cerrar", sin número inventado.
  final int? currentPosition;

  /// Filas de la bandeja que todavía no llegaron al servidor. **Es lo que
  /// decide si la franja final es verde o ámbar**: la promesa "nada se perdió"
  /// solo se puede hacer sobre lo que el servidor ya tiene.
  final int pendingUploads;

  final VoidCallback onStay;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    final locale = Localizations.localeOf(context).toString();
    final format = DateFormat.Hm(locale);
    return Padding(
      padding: const EdgeInsets.fromLTRB(14, 8, 14, 16),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Center(
            child: Container(
              width: 44,
              height: 5,
              margin: const EdgeInsets.only(top: 2, bottom: 10),
              decoration: BoxDecoration(
                color: RideTokens.n300,
                borderRadius: BorderRadius.circular(3),
              ),
            ),
          ),
          Text(
            l10n.coChangedTitle,
            style: const TextStyle(
              fontSize: 17,
              fontWeight: FontWeight.w900,
              color: RideTokens.n900,
            ),
          ),
          const SizedBox(height: 2),
          Text(
            l10n.coChangedSub(format.format(changes.observedAt.toLocal())),
            style: const TextStyle(
              fontSize: 12.5,
              fontWeight: FontWeight.w700,
              color: RideTokens.n700,
            ),
          ),
          const SizedBox(height: 12),
          Flexible(
            child: SingleChildScrollView(
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  // El paso movido va PRIMERO cuando lo hay: es el cambio que
                  // reordena todo lo demás.
                  if (changes.stepMoved) ...[
                    _Row(
                      icon: Icons.arrow_forward_rounded,
                      tone: _Tone.changed,
                      title: l10n.coChangedStepMoved,
                      detail: l10n.coChangedStepMovedDetail(
                        stepLabel(l10n, changes.stepFrom!),
                        stepLabel(l10n, changes.stepTo!),
                      ),
                    ),
                    const SizedBox(height: 7),
                  ],
                  for (final stamp in changes.stamps) ...[
                    _stampRow(l10n, format, stamp),
                    const SizedBox(height: 7),
                  ],
                  if (!changes.hasChanges) ...[
                    Text(
                      l10n.coChangedNoChanges,
                      style: const TextStyle(
                        fontSize: 13,
                        fontWeight: FontWeight.w700,
                        color: RideTokens.n700,
                      ),
                    ),
                    const SizedBox(height: 7),
                  ],
                ],
              ),
            ),
          ),
          const SizedBox(height: 4),
          // Verde o ámbar, nunca verde "por comodidad": si hay evidencia sin
          // enviar, se NOMBRA cuánta. Misma franja que la pantalla terminal
          // (21D): la pregunta es la misma, la respuesta tiene que serlo.
          WorkSafetyBanner(pendingUploads: pendingUploads),
          const SizedBox(height: 12),
          RidePrimaryButton(
            label: currentPosition == null
                ? l10n.coSheetClose
                : l10n.coChangedStayCta(currentPosition!),
            onPressed: onStay,
          ),
        ],
      ),
    );
  }

  Widget _stampRow(
    AppLocalizations l10n,
    DateFormat format,
    CheckoutStampChange stamp,
  ) {
    final title = stampLabel(l10n, stamp.kind);
    if (stamp.status == CheckoutStampStatus.pending) {
      return _Row(
        icon: Icons.schedule_rounded,
        tone: _Tone.none,
        title: title,
        detail: l10n.coChangedUntouched,
      );
    }
    final time = stamp.at == null ? '' : format.format(stamp.at!.toLocal());
    final mine = stamp.actor == CheckoutActorKind.you;
    // Atribución con el mismo criterio que el resto de la app: nombre propio
    // cuando la presencia lo resuelve, superficie cuando no, y "completado" a
    // secas cuando el log no tiene la transición (los sellos los estampan
    // handlers que no escriben actor).
    final detail = switch (stamp.actor) {
      CheckoutActorKind.you => l10n.coChangedByYou(time),
      CheckoutActorKind.kiosk => l10n.coChangedByKiosk(time),
      CheckoutActorKind.otherAgent => stamp.actorName == null
          ? l10n.coStepDoneOtherAgent(time)
          : l10n.coChangedByOtherAgent(stamp.actorName!, time),
      CheckoutActorKind.otherSurface => l10n.coChangedByOtherSurface(time),
      null => l10n.coStepDone(time),
    };
    return _Row(
      icon: Icons.check_rounded,
      tone: mine ? _Tone.mine : _Tone.changed,
      title: title,
      detail: detail,
    );
  }
}

/// `.drow` del mockup. Tres tonos y nada más: verde para lo que cambió,
/// morado para lo tuyo, neutro para lo intacto.
enum _Tone { changed, mine, none }

class _Row extends StatelessWidget {
  const _Row({
    required this.icon,
    required this.tone,
    required this.title,
    required this.detail,
  });

  final IconData icon;
  final _Tone tone;
  final String title;
  final String detail;

  @override
  Widget build(BuildContext context) {
    final (bg, bd, chipBg, chipFg) = switch (tone) {
      _Tone.changed => (
          const Color(0xFFFBFFFD),
          RideTokens.okBd,
          RideTokens.okBg,
          RideTokens.okTx,
        ),
      _Tone.mine => (
          RideTokens.p50,
          RideTokens.brandA20,
          RideTokens.p100,
          RideTokens.p800,
        ),
      _Tone.none => (
          RideTokens.n25,
          RideTokens.n200,
          RideTokens.n100,
          RideTokens.n600,
        ),
    };
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 11, vertical: 9),
      decoration: BoxDecoration(
        color: bg,
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: bd),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Container(
            width: 26,
            height: 26,
            alignment: Alignment.center,
            decoration: BoxDecoration(color: chipBg, shape: BoxShape.circle),
            child: Icon(icon, size: 14, color: chipFg),
          ),
          const SizedBox(width: 10),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(
                  title,
                  style: const TextStyle(
                    fontSize: 13.5,
                    fontWeight: FontWeight.w900,
                    color: RideTokens.n900,
                    height: 1.25,
                  ),
                ),
                Text(
                  detail,
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
      ),
    );
  }
}
