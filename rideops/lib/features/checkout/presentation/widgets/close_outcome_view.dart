import 'package:flutter/material.dart';
import 'package:flutter/semantics.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:intl/intl.dart';

import '../../../../core/api/dto/checkout_session.dart';
import '../../../../core/l10n/app_localizations.dart';
import '../../../../core/theme/ride_tokens.dart';
import '../../../../core/widgets/ride_buttons.dart';
import '../../application/checkout_close_controller.dart';
import '../../application/checkout_wizard_controller.dart';
import '../steps/sign_step.dart';
import 'close_progress.dart';
import 'verify_cards.dart';
import 'wizard_banners.dart';
import 'wizard_dock.dart';

/// Los dos finales del cierre (M2-H5, mockup 19A y 19B).
///
/// Se dibuja SOLO cuando esta pantalla participó del cierre. Una sesión que ya
/// estaba cerrada al entrar sigue aterrizando en `CheckoutTerminalView` (11E):
/// "entrega las llaves y la tarjeta de circulación" tiene sentido con el
/// cliente enfrente, no cuando alguien abre un checkout de ayer.
///
/// **Lo que esta pantalla no dice** y no es olvido: nunca afirma que el
/// contrato "salió por correo" (`autoEmailedAt` se estampa ANTES de disparar
/// un envío fire-and-forget, checkout-session.service.js:597-612), y nunca
/// ofrece "Reintentar cierre" sobre una sesión terminal (`canTransition` es
/// false desde terminal, state-machine.js:94 — sería un 409 eterno).
class CheckoutCloseOutcomeView extends ConsumerWidget {
  const CheckoutCloseOutcomeView({
    super.key,
    required this.reservationId,
    required this.session,
    required this.close,
    required this.onExit,
  });

  final String reservationId;
  final CheckoutSessionDto session;
  final CheckoutCloseState close;
  final VoidCallback onExit;

  /// ¿La entrega quedó a medio registrar? Dos caminos distintos aterrizan
  /// aquí y los dos merecen 19B:
  ///  - el servidor RECHAZÓ el finalize con la sesión ya cerrada (:417 commitea
  ///    `CLOSED` antes de la cascada, y el 409/422 escapa después);
  ///  - el cierre respondió 200 pero la reserva NO avanzó — la cascada se
  ///    tragó su error (:526, :533, :557, :571) y solo `Reservation.status`
  ///    lo delata.
  bool get _halfClosed =>
      close.failureKind == CloseFailureKind.rejectedTerminal ||
      close.handover == HandoverVerdict.notRecorded;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    // Región viva (nota 14 del 19A-bis): al resolver la comprobación, la fila
    // "Entrega" anuncia su nuevo valor — quien no ve el cambio de tono tiene
    // que enterarse igual. El negativo definitivo no se anuncia aquí: la
    // pantalla ENTERA cambia a 19B y el lector la lee de nuevo.
    ref.listen(
      checkoutCloseProvider(reservationId).select((s) => s.handover),
      (prev, next) {
        if (prev != HandoverVerdict.verifying) return;
        final l10n = AppLocalizations.of(context)!;
        final announcement = switch (next) {
          HandoverVerdict.recorded => _handoverRecordedLine(context, l10n),
          HandoverVerdict.unverified => l10n.coRecordHandoverUnconfirmed,
          _ => null,
        };
        if (announcement != null) {
          // `sendAnnouncement` y no `announce` (deprecada desde 3.35: no
          // soporta múltiples ventanas). La dirección sale de
          // `Directionality.of` y no de un `ltr` cableado — además `intl`
          // exporta su propio `TextDirection` y sombrea al de dart:ui aquí.
          SemanticsService.sendAnnouncement(
            View.of(context),
            announcement,
            Directionality.of(context),
          );
        }
      },
    );
    return _halfClosed ? _failed(context, ref) : _closed(context, ref);
  }

  /// "Registrada en la reserva · 11:04" — con la hora del SERVIDOR
  /// (`finishedAt`); sin ella, la palabra sola antes que una hora inventada.
  String _handoverRecordedLine(BuildContext context, AppLocalizations l10n) {
    final at = session.finishedAt;
    if (at == null) return l10n.coRecordPillRecorded;
    final format = DateFormat.Hm(Localizations.localeOf(context).toString());
    return l10n.coRecordHandoverRecorded(format.format(at.toLocal()));
  }

  // ── 19A ────────────────────────────────────────────────────────────────

  Widget _closed(BuildContext context, WidgetRef ref) {
    final l10n = AppLocalizations.of(context)!;
    final locale = Localizations.localeOf(context).toString();
    final format = DateFormat.Hm(locale);
    final wizard = ref.watch(checkoutWizardProvider(reservationId));
    final data = wizard.context;
    final verdict = close.handover;
    final recorded = verdict == HandoverVerdict.recorded;
    final verifying = verdict == HandoverVerdict.verifying;
    final unverified = verdict == HandoverVerdict.unverified;
    final closedTime = session.finishedAt == null
        ? null
        : format.format(session.finishedAt!.toLocal());

    // "Laura Méndez · Corolla 2023 · 11:04" — se arma con lo que EXISTE; lo
    // que no llegó se omite en vez de dejar un separador huérfano.
    final subtitle = [
      data?.customerName,
      data?.vehicleLabel,
      ?closedTime,
    ].nonNulls.where((p) => p.isNotEmpty).join(' · ');

    return Column(
      children: [
        Expanded(
          child: ListView(
            padding: const EdgeInsets.fromLTRB(14, 14, 14, 6),
            children: [
              // El héroe VERDE se queda en las tres variantes (nota 1 del
              // 19A-bis): nombra el hecho que el 200 sí prueba. Lo que no se
              // queda es la palabra — "Entrega cerrada" afirma justo lo que en
              // `verifying`/`unverified` no está confirmado, así que ahí el
              // título es "Checkout cerrado" (vocabulario ya aprobado en 19B).
              _Hero(
                tone: VerifyTone.ok,
                icon: Icons.check_rounded,
                title: recorded
                    ? l10n.coClosedTitle
                    : l10n.coClosedTitleUnverified,
                body: subtitle.isEmpty ? null : subtitle,
              ),
              // El aviso se cuela ENTRE el héroe y la primera tarjeta: la
              // advertencia tiene que leerse ANTES de la instrucción de
              // entregar las llaves. Y a propósito NO dice "no entregues las
              // llaves" — esa línea es de 19B, donde hay un rechazo real;
              // aquí solo hay ignorancia (nota 10).
              if (unverified) ...[
                const SizedBox(height: 14),
                WizardBanner(
                  icon: Icons.warning_amber_rounded,
                  iconColor: RideTokens.warnTx,
                  background: RideTokens.warnBg,
                  border: RideTokens.warnBd,
                  child: Text(
                    l10n.coRecordHandoverUnverifiedNotice,
                    style: const TextStyle(
                      fontSize: 12.5,
                      fontWeight: FontWeight.w700,
                      color: RideTokens.warnTx, // 5.59:1 medido
                      height: 1.4,
                    ),
                  ),
                ),
              ],
              const SizedBox(height: 14),
              // Lo PRIMERO es lo que se hace en los siguientes 30 segundos: el
              // agente sigue con el cliente delante. El registro va debajo.
              // El orden NO cambia entre variantes (nota 2): mover bloques
              // entre estados de la misma pantalla la vuelve inestable justo
              // cuando el agente necesita orientarse.
              VerifyCard(
                title: l10n.coBeforeTheyGoTitle,
                children: [
                  KvRow(
                    label: l10n.coBeforeKeysLabel,
                    value: l10n.coBeforeKeys,
                  ),
                  if (_returnLine(context, data?.returnAt,
                      data?.returnLocationName) case final line?)
                    KvRow(label: l10n.coBeforeReturnLabel, value: line),
                  // Pie de alcance (SC-1 camino B, aprobado): INCONDICIONAL,
                  // así la tarjeta nunca baja de dos renglones — ni en una
                  // reserva sin fecha de regreso.
                  NoteRow(text: l10n.coBeforeScopeNote),
                ],
              ),
              const SizedBox(height: 12),
              // La pastilla describe la COMPROBACIÓN —lo único que varía en
              // esta pantalla— y el hecho duro ("la sesión cerró, y a qué
              // hora") baja a la fila ancla (notas 4 y 5). La palabra
              // acompaña siempre al tono: el color nunca porta el estado solo.
              VerifyCard(
                title: l10n.coRecordTitle,
                tone: recorded
                    ? VerifyTone.ok
                    : (unverified ? VerifyTone.warn : VerifyTone.neutral),
                pillLabel: recorded
                    ? l10n.coRecordPillRecorded
                    : (verifying
                        ? l10n.coRecordPillChecking
                        : l10n.coRecordPillUnverified),
                children: [
                  // La fila ancla: el hecho que el 200 SÍ prueba, con su hora
                  // del servidor. Sin `finishedAt` se omite — media afirmación
                  // no orienta a nadie y la hora del teléfono no es prueba.
                  if (closedTime != null)
                    KvRow(
                      label: l10n.coRecordRowSession,
                      value: l10n.coRecordSessionClosedAt(closedTime),
                      tabular: true,
                    ),
                  // La ENTREGA se afirma solo con lo que dice
                  // `Reservation.status`: la respuesta de `transition` no
                  // reporta el resultado de la cascada (pedido P9), así que
                  // sin esta lectura la pantalla no tendría derecho a decirlo.
                  // Y mientras la lectura VIAJA, el renglón no afirma nada:
                  // dice que está preguntando (la regla del 19A-bis).
                  KvRow(
                    label: l10n.coRecordHandoverLabel,
                    value: recorded
                        ? _handoverRecordedLine(context, l10n)
                        : (verifying
                            ? l10n.coRecordHandoverChecking
                            : l10n.coRecordHandoverUnconfirmed),
                    busy: verifying,
                    warn: unverified,
                  ),
                  if (session.customerSignedAt case final at?)
                    KvRow(
                      label: l10n.coRecordSignatureLabel,
                      value: [data?.customerName, format.format(at.toLocal())]
                          .nonNulls
                          .join(' · '),
                      tabular: true,
                    ),
                  KvRow(
                    label: l10n.coRecordContractLabel,
                    // "Se pidió enviarlo", nunca "salió": el sello prueba la
                    // petición, no la entrega.
                    value: session.autoEmailedAt == null
                        ? l10n.coRecordEmailNotRequested
                        : l10n.coRecordEmailRequested(
                            format.format(session.autoEmailedAt!.toLocal()),
                          ),
                  ),
                ],
              ),
            ],
          ),
        ),
        // El pie del wizard vive en UN solo widget (GD-MC-4): esta pantalla lo
        // había vuelto a dibujar a mano —cuarta copia de la misma geometría—
        // justo al lado de 19B, que a un toque de distancia sí usa el dock.
        //
        // En `unverified` la acción principal es "Volver a comprobar": si la
        // copy dice "compruébalo" y el botón morado dice "Volver al inicio",
        // el color contradice a la frase y gana el color (nota 12). Es la
        // MISMA consulta que la app ya hizo sola — jamás un reintento del
        // cierre. Durante `verifying` nada se bloquea: el agente puede salir.
        Padding(
          padding: const EdgeInsets.fromLTRB(14, 0, 14, 14),
          child: WizardDock(
            why: unverified
                ? l10n.coRecordHandoverRecheckWhy
                : (verifying ? l10n.coRecordHandoverCheckingWhy : null),
            primary: unverified || verifying
                ? RidePrimaryButton(
                    label: l10n.coRecordHandoverRecheck,
                    // Spinner EN el botón, nunca un overlay que tape lo que
                    // el agente está leyendo (regla de 19C).
                    loading: verifying,
                    onPressed: unverified
                        ? () => ref
                            .read(checkoutCloseProvider(reservationId).notifier)
                            .recheck()
                        : null,
                  )
                : RidePrimaryButton(
                    label: l10n.coBackHome,
                    onPressed: onExit,
                  ),
            secondary: unverified || verifying
                ? RideGhostButton(label: l10n.coBackHome, onPressed: onExit)
                : RideGhostButton(
                    label: l10n.coSessionDetail,
                    onPressed: () => ref
                        .read(checkoutCloseProvider(reservationId).notifier)
                        .showSessionDetail(),
                  ),
          ),
        ),
      ],
    );
  }

  /// "19 ago · 10:30 · Patio Centro" con lo que exista. Sin `returnAt` la fila
  /// entera se omite: media fecha no orienta a nadie.
  String? _returnLine(BuildContext context, DateTime? at, String? location) {
    if (at == null) return null;
    final locale = Localizations.localeOf(context).toString();
    final local = at.toLocal();
    return [
      DateFormat.MMMd(locale).format(local),
      DateFormat.Hm(locale).format(local),
      if (location != null && location.isNotEmpty) location,
    ].join(' · ');
  }

  // ── 19B ────────────────────────────────────────────────────────────────

  Widget _failed(BuildContext context, WidgetRef ref) {
    final l10n = AppLocalizations.of(context)!;
    final wizard = ref.watch(checkoutWizardProvider(reservationId));
    // Con motivo del servidor se cita; sin él (el caso silencioso) se explica
    // lo que SÍ se verificó, y se dice que se verificó.
    final serverReason = close.failureMessage;

    return Column(
      children: [
        Expanded(
          child: ListView(
            padding: const EdgeInsets.fromLTRB(14, 12, 14, 6),
            children: [
              WizardBanner(
                icon: Icons.error_outline_rounded,
                iconColor: RideTokens.dangerTx,
                background: RideTokens.dangerBg,
                border: RideTokens.dangerBd,
                child: Text(
                  serverReason == null
                      ? l10n.coCloseNotRecordedTitle
                      : l10n.coCloseFailedTitle,
                  style: const TextStyle(
                    fontSize: 12.5,
                    fontWeight: FontWeight.w700,
                    color: RideTokens.dangerTx,
                    height: 1.4,
                  ),
                ),
              ),
              const SizedBox(height: 12),
              CloseProgressCard(
                signature: close.signature,
                finalizing: close.finalizing,
                closing: close.closing,
                signatureAt: close.signatureAt,
                failedAt: close.failedAt,
              ),
              const SizedBox(height: 12),
              // Dos ramas, dos rúbricas (GD-SC-3): con motivo del servidor la
              // tarjeta CITA ("Motivo · Respuesta del servidor"); sin él no
              // hay a quién citar, así que se titula por lo que la app hizo
              // ("Lo que comprobamos · Estado de la reserva"). Titular "Motivo"
              // un texto que dice que no hubo motivo era contradecirse solo.
              ServerReasonCard(
                message: serverReason ?? l10n.coCloseNotRecordedReason,
                title: serverReason == null ? l10n.coCloseVerifiedTitle : null,
                pillLabel: serverReason == null
                    ? l10n.coCloseVerifiedPill
                    : l10n.coCloseReasonPill,
                label: serverReason == null
                    ? l10n.coCloseVerifiedLabel
                    : l10n.coServerReasonLabel,
              ),
              const SizedBox(height: 12),
              // Se DECLARA que no hay reintento porque de verdad no lo hay.
              // Un botón "Reintentar cierre" daría 409 ILLEGAL_TRANSITION para
              // siempre: la puerta falsa que este proyecto prohíbe.
              WizardBanner(
                icon: Icons.schedule_rounded,
                iconColor: RideTokens.warnTx,
                background: RideTokens.warnBg,
                border: RideTokens.warnBd,
                child: Text(
                  l10n.coCloseNoRetry,
                  style: const TextStyle(
                    fontSize: 12.5,
                    fontWeight: FontWeight.w700,
                    color: RideTokens.n800,
                    height: 1.4,
                  ),
                ),
              ),
            ],
          ),
        ),
        Padding(
          padding: const EdgeInsets.fromLTRB(14, 0, 14, 14),
          child: WizardDock(
            // La línea que de verdad protege el negocio.
            why: l10n.coHoldKeys,
            // "Avisar al mostrador" NO se dibuja: no existe canal. Ver el WHY
            // largo en el encabezado del archivo del paso. El principal pasa a
            // ser copiar el detalle — que la app SÍ puede hacer hoy — porque
            // lo que no puede pasar es quedarse sin botón.
            primary: RidePrimaryButton(
              label: l10n.coCopyProblem,
              onPressed: () => copyProblemDetail(
                context,
                ref,
                reservationId: reservationId,
                session: session,
                close: close,
                reservationContext: wizard.context,
              ),
            ),
            secondary: RideGhostButton(
              label: l10n.coSessionDetail,
              onPressed: () => ref
                  .read(checkoutCloseProvider(reservationId).notifier)
                  .showSessionDetail(),
            ),
          ),
        ),
      ],
    );
  }
}

/// `.center-state` + `.big-ic`. Fin de trámite legal, no logro de videojuego:
/// un tick, el nombre, la unidad y la hora del servidor. Nada de confeti — y
/// menos con el cliente mirando.
class _Hero extends StatelessWidget {
  const _Hero({
    required this.tone,
    required this.icon,
    required this.title,
    this.body,
  });

  final VerifyTone tone;
  final IconData icon;
  final String title;
  final String? body;

  @override
  Widget build(BuildContext context) {
    final (bg, bd, fg) = switch (tone) {
      VerifyTone.ok => (RideTokens.okBg, RideTokens.okBd, RideTokens.okTx),
      VerifyTone.bad => (
          RideTokens.dangerBg,
          RideTokens.dangerBd,
          RideTokens.dangerTx,
        ),
      VerifyTone.neutral => (
          RideTokens.n100,
          RideTokens.n200,
          RideTokens.n800,
        ),
      // El héroe NUNCA se pinta ámbar (nota 1 del 19A-bis): nombra el hecho
      // que el 200 sí prueba. Está por completitud del switch; lo que cambia
      // entre variantes es el TÍTULO, no el color.
      VerifyTone.warn => (
          RideTokens.warnBg,
          RideTokens.warnBd,
          RideTokens.warnTx,
        ),
    };
    return Column(
      children: [
        Container(
          width: 64,
          height: 64,
          decoration: BoxDecoration(
            color: bg,
            shape: BoxShape.circle,
            border: Border.all(color: bd, width: 1.5),
          ),
          child: Icon(icon, size: 30, color: fg),
        ),
        const SizedBox(height: 12),
        Text(
          title,
          textAlign: TextAlign.center,
          style: const TextStyle(
            fontSize: 22,
            fontWeight: FontWeight.w900,
            color: RideTokens.n900,
            height: 1.2,
          ),
        ),
        if (body != null) ...[
          const SizedBox(height: 8),
          ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 300),
            child: Text(
              body!,
              textAlign: TextAlign.center,
              style: const TextStyle(
                fontSize: 14,
                fontWeight: FontWeight.w600,
                color: RideTokens.n700,
                height: 1.4,
              ),
            ),
          ),
        ],
      ],
    );
  }
}
