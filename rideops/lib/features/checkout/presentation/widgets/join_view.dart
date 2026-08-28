import 'package:clock/clock.dart';
import 'package:flutter/material.dart';
import 'package:intl/intl.dart';

import '../../../../core/api/dto/checkout_session.dart';
import '../../../../core/l10n/app_localizations.dart';
import '../../../../core/theme/ride_tokens.dart';
import '../../../../core/widgets/ride_buttons.dart';
import '../../domain/checkout_changes.dart';
import '../../domain/checkout_event_log.dart';
import '../../domain/checkout_presence.dart';
import '../../domain/checkout_step_catalog.dart';
import '../checkout_labels.dart';
import 'wizard_banners.dart';

/// Frames 23A / 23B / 23C — la antesala de enganche.
///
/// El wizard ya entraba directo al paso que reporta el servidor, y eso es
/// correcto por ADR-4. El problema no era el destino: era aterrizar en el
/// **paso 7** sin saber quién hizo los seis anteriores ni si conviene seguir.
///
/// **No es un paso nuevo de la máquina de estados.** Es la MISMA lectura de
/// `GET /by-reservation/:id` mostrada antes de empujar al agente a trabajar:
/// no infiere nada, no transiciona nada y su único botón es local.
///
/// Aparece solo cuando hay algo que contar (la sesión no está en el paso 1, o
/// la abrió otra persona). Una sesión que el propio agente acaba de crear
/// entra directo, como hoy: meterle una antesala a un checkout recién abierto
/// sería un toque de más por cada salida del día.
class CheckoutJoinView extends StatelessWidget {
  const CheckoutJoinView({
    super.key,
    required this.session,
    required this.position,
    required this.roster,
    required this.myUserId,
    required this.onContinue,
    required this.onLeave,
  });

  final CheckoutSessionDto session;

  /// Posición reportada por el servidor. Null = paso que esta versión no ubica
  /// en la cadena; entonces el CTA pierde el número, no la existencia.
  final int? position;

  final List<PresenceRosterEntry> roster;
  final String? myUserId;
  final VoidCallback onContinue;
  final VoidCallback onLeave;

  bool get _startedByOther {
    final by = session.startedByUserId;
    return myUserId != null && by != null && by != myUserId;
  }

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    final locale = Localizations.localeOf(context).toString();
    final format = DateFormat.Hm(locale);
    final now = clock.now();
    final progress = phaseProgress(position);
    final changes = buildChangeSet(
      // Sin baseline: la antesala describe LA SESIÓN, no un diff. Los sellos
      // salen como "ya estaban" porque el agente acaba de llegar — que es
      // exactamente lo que pasó.
      baseline: null,
      current: session,
      observedAt: now,
      myUserId: myUserId,
    );
    // 23B — un aparato volteado al cliente está latiendo AHORA. Cambia el
    // consejo y el peso de los botones; nunca el permiso.
    final deviceLive = hasLiveDevicePresence(roster);
    final paused = session.abandonedAt;

    return Column(
      children: [
        Expanded(
          child: ListView(
            padding: const EdgeInsets.fromLTRB(14, 12, 14, 8),
            children: [
              if (paused != null) ...[
                _pausedBanner(l10n, paused, now),
                const SizedBox(height: 10),
              ] else ...[
                _startedBanner(l10n, format),
                const SizedBox(height: 10),
              ],
              if (deviceLive) ...[
                _KioskActiveBanner(),
                const SizedBox(height: 10),
              ] else if (roster.isEmpty) ...[
                // La misma regla de §20 aplicada al momento en que más tienta
                // romperla: llegar a una sesión abandonada e inferir "está
                // libre". Puede haber alguien en el mostrador cuya pestaña no
                // late. Se dice "nadie VISIBLE", jamás "estás solo".
                Text(
                  l10n.coPresenceEmptyShort,
                  style: const TextStyle(
                    fontSize: 12.5,
                    fontWeight: FontWeight.w700,
                    color: RideTokens.n700,
                  ),
                ),
                const SizedBox(height: 10),
              ],
              _Card(
                title: paused == null
                    ? l10n.coJoinDoneTitle
                    : l10n.coJoinWhereItStoppedTitle,
                pill: l10n.coJoinDonePill(progress.done, progress.total),
                pillTone: _Tone.ok,
                rows: [
                  for (final stamp in changes.stamps)
                    if (stamp.status != CheckoutStampStatus.pending)
                      (
                        stampLabel(l10n, stamp.kind),
                        _stampLine(l10n, format, stamp),
                        true,
                      ),
                ],
                // Sin ningún sello puesto todavía no se finge un inventario:
                // se dice que no hay nada hecho.
                emptyLine: l10n.coChangedUntouched,
              ),
              const SizedBox(height: 10),
              _Card(
                title: l10n.coJoinPendingTitle,
                pill: l10n.coJoinPendingPill,
                pillTone: _Tone.mut,
                rows: [
                  for (final stamp in changes.stamps)
                    if (stamp.status == CheckoutStampStatus.pending)
                      (
                        stampLabel(l10n, stamp.kind),
                        l10n.coStampPending,
                        false,
                      ),
                ],
                emptyLine: l10n.coStampDone(format.format(now.toLocal())),
              ),
              if (deviceLive) ...[
                const SizedBox(height: 10),
                _AdviceCard(),
              ],
            ],
          ),
        ),
        Container(
          decoration: const BoxDecoration(
            border: Border(top: BorderSide(color: RideTokens.n200)),
          ),
          padding: const EdgeInsets.fromLTRB(14, 12, 14, 14),
          child: Column(
            children: [
              // 23B — el botón principal cambia de PESO, no de existencia: con
              // el cliente usando el kiosco "avanzar" baja a fantasma y
              // "volver" sube. La jerarquía carga el consejo sin quitarle la
              // decisión al agente, que es quien está viendo el patio.
              if (deviceLive) ...[
                RideGhostButton(
                  label: l10n.coJoinProceedAnyway,
                  onPressed: onContinue,
                ),
                const SizedBox(height: 9),
                RidePrimaryButton(
                  label: l10n.coTerminalBackToList,
                  onPressed: onLeave,
                ),
              ] else ...[
                RidePrimaryButton(
                  label: position == null
                      ? l10n.coJoinContinueCtaUnknownStep
                      : l10n.coJoinContinueCta(position!),
                  onPressed: onContinue,
                ),
                const SizedBox(height: 9),
                RideGhostButton(
                  label: l10n.coTerminalBackToList,
                  onPressed: onLeave,
                ),
              ],
              const SizedBox(height: 9),
              Text(
                // Se nombra explícitamente que continuar no "roba" la sesión:
                // hay UNA CheckoutSession por reserva (reservationId @unique),
                // así que no existe transferir, reclamar ni desbloquear.
                // Decirlo evita que el agente busque un botón de "tomar el
                // control" que ninguna versión de esta app va a tener.
                paused == null
                    ? l10n.coJoinContinueWhy
                    : l10n.coJoinNoStealWhy,
                textAlign: TextAlign.center,
                style: const TextStyle(
                  fontSize: 12.5,
                  fontWeight: FontWeight.w700,
                  color: RideTokens.n700,
                  height: 1.4,
                ),
              ),
            ],
          ),
        ),
      ],
    );
  }

  Widget _startedBanner(AppLocalizations l10n, DateFormat format) {
    final started = session.startedAt;
    final index = position ?? 0;
    final line = _startedByOther
        ? l10n.coJoinBannerStartedByOther(index, kCheckoutLinearStepCount)
        : started == null
            // No se nombra QUIÉN la abrió: `startedByUserId` viaja como id y
            // el servidor no manda su nombre. Se dice lo que se sabe.
            ? l10n.coJoinBannerStarted(index, kCheckoutLinearStepCount)
            : l10n.coJoinBannerStartedAt(
                format.format(started.toLocal()),
                index,
                kCheckoutLinearStepCount,
              );
    return WizardBanner(
      icon: Icons.info_outline_rounded,
      iconColor: RideTokens.focus,
      background: RideTokens.infoBg,
      border: RideTokens.infoBd,
      child: Text(
        line,
        style: const TextStyle(
          fontSize: 13,
          fontWeight: FontWeight.w700,
          color: RideTokens.n800,
        ),
      ),
    );
  }

  /// 23C — la dejó pausada alguien. `abandonedReason` es el dato que DECIDE:
  /// "el cliente fue por su tarjeta" y "la unidad no arranca" llevan a
  /// acciones opuestas. Ya viaja en el DTO y hasta H6 no se mostraba.
  Widget _pausedBanner(AppLocalizations l10n, DateTime pausedAt, DateTime now) {
    final age = checkoutAgeLabel(l10n, now.difference(pausedAt));
    final events = parseCheckoutEvents(session.events);
    final abandon = lastEventOfKind(events, 'ABANDONED');
    final byOther =
        abandon != null && abandon.actorKind(myUserId) != CheckoutActorKind.you;
    // El barrido nocturno también escribe `abandonedAt` (scheduler:70-71), y
    // ahí NADIE pausó nada: decir "otro agente la pausó" inventaría un culpable
    // de algo que hizo un cron.
    final autoStalled = classifyAbandonReason(session.abandonedReason) ==
        CheckoutAbandonKind.autoStalled;
    // Y el motivo se TRADUCE o se calla: crudo produce «Motivo: "agent_paused"»
    // en la cara del agente, que es el pecado que la lámina prohíbe.
    final reason = abandonReasonLine(l10n, session.abandonedReason);
    return WizardBanner(
      icon: Icons.pause_circle_outline_rounded,
      iconColor: RideTokens.warnTx,
      background: RideTokens.warnBg,
      border: RideTokens.warnBd,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: [
          Text(
            autoStalled
                ? l10n.coJoinPausedBySystem(age)
                : byOther
                    ? l10n.coJoinPausedByOther(age)
                    // Sin actor identificable no se afirma "otro agente".
                    : l10n.coJoinPausedBySomeone(age),
            style: const TextStyle(
              fontSize: 13,
              fontWeight: FontWeight.w800,
              color: RideTokens.warnTx,
            ),
          ),
          if (reason != null)
            Text(
              reason,
              style: const TextStyle(
                fontSize: 12.5,
                fontWeight: FontWeight.w700,
                color: RideTokens.n800,
              ),
            ),
        ],
      ),
    );
  }

  String _stampLine(
    AppLocalizations l10n,
    DateFormat format,
    CheckoutStampChange stamp,
  ) {
    final time = stamp.at == null ? '' : format.format(stamp.at!.toLocal());
    return switch (stamp.actor) {
      CheckoutActorKind.you => l10n.coStepDoneByYou(time),
      CheckoutActorKind.kiosk => l10n.coStepDoneKiosk(time),
      CheckoutActorKind.otherAgent => stamp.actorName == null
          ? l10n.coStepDoneOtherAgent(time)
          : l10n.coChangedByOtherAgent(stamp.actorName!, time),
      CheckoutActorKind.otherSurface => l10n.coStepDone(time),
      null => l10n.coStepDone(time),
    };
  }
}

/// El aviso que hace que encender el latido valga la pena: sin presencia el
/// agente entra al paso 8 y toca "continuar" mientras el cliente está firmando
/// del otro lado del lobby.
class _KioskActiveBanner extends StatelessWidget {
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
            l10n.coJoinKioskActiveTitle,
            style: const TextStyle(
              fontSize: 13,
              fontWeight: FontWeight.w900,
              color: RideTokens.warnTx,
            ),
          ),
          Text(
            l10n.coJoinKioskActiveBody,
            style: const TextStyle(
              fontSize: 12.5,
              fontWeight: FontWeight.w700,
              color: RideTokens.n800,
            ),
          ),
        ],
      ),
    );
  }
}

class _AdviceCard extends StatelessWidget {
  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    return _Card(
      title: l10n.coJoinAdviceTitle,
      pill: l10n.coJoinAdvicePill,
      pillTone: _Tone.mut,
      rows: [
        (l10n.coJoinAdviceWaitKey, l10n.coJoinAdviceWait, false),
        (l10n.coJoinAdviceLeaveKey, l10n.coJoinAdviceLeave, false),
      ],
      emptyLine: null,
      // "Lo que esto NO es": la presencia informa, no bloquea. Sin esta línea
      // el ámbar se lee como un candado y el agente se queda esperando a que
      // se le levante algo que nunca estuvo puesto.
      footer: l10n.coJoinNotABlock,
    );
  }
}

enum _Tone { ok, mut }

class _Card extends StatelessWidget {
  const _Card({
    required this.title,
    required this.pill,
    required this.pillTone,
    required this.rows,
    required this.emptyLine,
    this.footer,
  });

  final String title;
  final String pill;
  final _Tone pillTone;

  /// (etiqueta, valor, positivo)
  final List<(String, String, bool)> rows;

  /// Qué decir cuando no hay filas. Null ⇒ la tarjeta se dibuja sin nada, que
  /// solo pasa en la de consejo (que siempre trae sus dos filas).
  final String? emptyLine;

  final String? footer;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.fromLTRB(13, 12, 13, 12),
      decoration: BoxDecoration(
        color: RideTokens.n0,
        borderRadius: BorderRadius.circular(20),
        border: Border.all(color: RideTokens.n200),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(
                child: Text(
                  title,
                  style: const TextStyle(
                    fontSize: 14.5,
                    fontWeight: FontWeight.w900,
                    color: RideTokens.n900,
                  ),
                ),
              ),
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 3),
                decoration: BoxDecoration(
                  color: pillTone == _Tone.ok
                      ? RideTokens.okBg
                      : RideTokens.n50,
                  borderRadius: BorderRadius.circular(8),
                  border: Border.all(
                    color: pillTone == _Tone.ok
                        ? RideTokens.okBd
                        : RideTokens.n200,
                  ),
                ),
                child: Text(
                  pill,
                  style: TextStyle(
                    fontSize: 11.5,
                    fontWeight: FontWeight.w900,
                    color: pillTone == _Tone.ok
                        ? RideTokens.okTx
                        : RideTokens.n700,
                  ),
                ),
              ),
            ],
          ),
          const SizedBox(height: 6),
          if (rows.isEmpty && emptyLine != null)
            Text(
              emptyLine!,
              style: const TextStyle(
                fontSize: 13,
                fontWeight: FontWeight.w700,
                color: RideTokens.n700,
              ),
            ),
          for (final (label, value, positive) in rows)
            Padding(
              padding: const EdgeInsets.symmetric(vertical: 4),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  SizedBox(
                    width: 96,
                    child: Text(
                      label,
                      style: const TextStyle(
                        fontSize: 13,
                        fontWeight: FontWeight.w700,
                        color: RideTokens.n700,
                      ),
                    ),
                  ),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Text(
                      value,
                      style: TextStyle(
                        fontSize: 13,
                        fontWeight: positive
                            ? FontWeight.w800
                            : FontWeight.w700,
                        color: positive ? RideTokens.okTx : RideTokens.n700,
                      ),
                    ),
                  ),
                ],
              ),
            ),
          if (footer != null) ...[
            const SizedBox(height: 8),
            Container(
              padding: const EdgeInsets.fromLTRB(12, 10, 12, 10),
              decoration: BoxDecoration(
                color: RideTokens.n25,
                borderRadius: BorderRadius.circular(12),
                border: const Border(
                  left: BorderSide(color: RideTokens.n400, width: 4),
                ),
              ),
              child: Text(
                footer!,
                style: const TextStyle(
                  fontSize: 12.5,
                  fontWeight: FontWeight.w700,
                  color: RideTokens.n800,
                  height: 1.4,
                ),
              ),
            ),
          ],
        ],
      ),
    );
  }
}
