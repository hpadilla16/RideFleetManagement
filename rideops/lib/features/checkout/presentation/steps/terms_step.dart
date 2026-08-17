import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:intl/intl.dart';

import '../../../../core/api/api_error.dart';
import '../../../../core/api/dto/checkout_session.dart';
import '../../../../core/api/enums.dart';
import '../../../../core/l10n/app_localizations.dart';
import '../../../../core/theme/ride_tokens.dart';
import '../../../../core/widgets/ride_buttons.dart';
import '../../application/checkout_wizard_controller.dart';
import '../../application/terms_token_controller.dart';
import '../../domain/checkout_confirm.dart';
import '../../domain/terms_token.dart';
import '../present_mode_screen.dart';
import '../widgets/qr_view.dart';
import '../widgets/transition_button.dart';
import '../widgets/verify_cards.dart';
import '../widgets/wizard_banners.dart';

/// Paso TC_PENDING (M2-H2, mockup 10A/10C/10D).
///
/// Reparto de responsabilidades, tal cual lo describe el backend:
///  - el QR lo mintea `POST /:id/terms-token` (TTL 15 min, re-uso >2 min),
///  - el cliente firma en SU teléfono y el flujo público estampa
///    `tcCompletedAt`,
///  - **RideOps se entera por POLL, no por push** — el de 5 s del wizard, este
///    paso no añade uno propio,
///  - la transición a `TC_SIGNED` la dispara el agente, y el entry guard del
///    backend exige el sello: por eso el CTA existe SOLO cuando el servidor ya
///    lo tiene (ADR-4 hecho visible, nota 7).
class TermsStep extends ConsumerStatefulWidget {
  const TermsStep({
    super.key,
    required this.reservationId,
    required this.banners,
  });

  final String reservationId;
  final List<Widget> banners;

  @override
  ConsumerState<TermsStep> createState() => _TermsStepState();
}

class _TermsStepState extends ConsumerState<TermsStep> {
  /// Tick de 1 Hz mientras hay un código vivo. Es INFORMACIÓN, no decoración:
  /// sigue corriendo con reduced-motion (nota de motion del mockup) y por eso
  /// no hay barra que se vacíe ni pulso.
  Timer? _tick;

  @override
  void initState() {
    super.initState();
    _tick = Timer.periodic(const Duration(seconds: 1), (_) {
      if (mounted) setState(() {});
    });
  }

  @override
  void dispose() {
    _tick?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    final wizard = ref.watch(checkoutWizardProvider(widget.reservationId));
    final session = wizard.session;
    if (session == null) return const SizedBox.shrink();

    // 10C: el CTA aparece porque el SELLO existe, jamás porque un timer creyó
    // que ya era hora.
    if (session.tcCompletedAt != null) {
      return _SignedView(
        reservationId: widget.reservationId,
        session: session,
        banners: widget.banners,
      );
    }

    final tokenState = ref.watch(termsTokenProvider(session.id));
    final controller = ref.read(termsTokenProvider(session.id).notifier);
    final countdown = TermsCountdown.of(tokenState.token?.expiresAt);
    final url = controller.signUrl;
    // El vencimiento se cuenta DESPUÉS del frame, no dentro del build: el
    // build corre en cada repaint y la telemetría no puede depender de eso.
    // El controller además deduplica por token (el tick es de 1 Hz).
    if (countdown.isExpired && tokenState.hasToken) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted) controller.noteExpired();
      });
    }

    // Sin red no hay QR que mostrar: puede saberlo el shell (poll muerto) o
    // el propio mint (su error de red). Las dos cosas significan lo mismo para
    // el agente y merecen el mismo copy honesto.
    final cannotMint = wizard.offline ||
        tokenState.error?.kind == ApiErrorKind.network;

    return Column(
      children: [
        Expanded(
          child: ListView(
            padding: const EdgeInsets.fromLTRB(14, 12, 14, 12),
            children: [
              ...widget.banners,
              if (countdown.isExpired && tokenState.hasToken) ...[
                // "Nada se perdió" PRIMERO, causa después: el vencimiento es
                // rutina y la copy no puede dejar creer que se rompió algo.
                WizardBanner(
                  icon: Icons.schedule_rounded,
                  iconColor: RideTokens.warnTx,
                  background: RideTokens.warnBg,
                  border: RideTokens.warnBd,
                  child: Text(
                    l10n.coTermsExpiredBanner(
                      DateFormat.Hm(Localizations.localeOf(context).toString())
                          .format(tokenState.token!.expiresAt!.toLocal()),
                    ),
                    style: const TextStyle(
                      fontSize: 12.5,
                      fontWeight: FontWeight.w700,
                      color: RideTokens.warnTx,
                    ),
                  ),
                ),
                const SizedBox(height: 12),
              ] else
                Padding(
                  padding: const EdgeInsets.only(bottom: 12),
                  child: Text(
                    l10n.coTermsInstruction,
                    style: const TextStyle(
                      fontSize: 14.5,
                      fontWeight: FontWeight.w800,
                      color: RideTokens.n800,
                    ),
                  ),
                ),
              _QrPanel(
                url: url,
                countdown: countdown,
                minting: tokenState.minting,
                errorMessage: tokenState.error?.message,
                offline: cannotMint,
                onRetry: controller.mint,
                // Reintentar el mint SIEMPRE se ofrece (salvo con uno en
                // vuelo): es una petición del agente, inocua, y esconderla
                // dejaría la pantalla sin salida cuando la señal vuelve.
              ),
              if (url != null && !countdown.isExpired) ...[
                const SizedBox(height: 12),
                RideGhostButton(
                  label: l10n.coTermsPresent,
                  onPressed: () => openPresentMode(
                    context,
                    ref,
                    reservationId: widget.reservationId,
                    sessionId: session.id,
                  ),
                ),
                const SizedBox(height: 12),
                // Espera honesta en vez de spinner infinito: el poll ya corre.
                WizardBanner(
                  icon: Icons.info_outline_rounded,
                  iconColor: RideTokens.focus,
                  background: RideTokens.infoBg,
                  border: RideTokens.infoBd,
                  child: Text(
                    l10n.coTermsWaiting,
                    style: const TextStyle(
                      fontSize: 12.5,
                      fontWeight: FontWeight.w700,
                      color: RideTokens.n800,
                    ),
                  ),
                ),
              ],
              if (tokenState.lastMintReused != null) ...[
                const SizedBox(height: 12),
                _ReMintNotice(reused: tokenState.lastMintReused!),
              ],
            ],
          ),
        ),
        Padding(
          padding: const EdgeInsets.fromLTRB(14, 0, 14, 14),
          child: _ReMintDock(
            expired: countdown.isExpired,
            minting: tokenState.minting,
            offline: cannotMint,
            onReMint: controller.mint,
          ),
        ),
      ],
    );
  }
}

/// Cuadro del QR + pill del countdown (10A/10D).
class _QrPanel extends StatelessWidget {
  const _QrPanel({
    required this.url,
    required this.countdown,
    required this.minting,
    required this.errorMessage,
    required this.offline,
    required this.onRetry,
  });

  final String? url;
  final TermsCountdown countdown;
  final bool minting;
  final String? errorMessage;
  final bool offline;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: RideTokens.n0,
        borderRadius: BorderRadius.circular(20),
        border: Border.all(color: RideTokens.n200),
      ),
      child: Column(
        children: [
          if (url == null)
            _QrPlaceholder(
              minting: minting,
              // Mensaje del servidor tal cual; sin él, copy honesto según la
              // causa (sin red el mint no puede salir: el código lo emite el
              // servidor, no la app).
              message: minting
                  ? l10n.coTermsMinting
                  : offline
                      ? l10n.coTermsOfflineWhy
                      : (errorMessage?.isNotEmpty ?? false)
                          ? errorMessage!
                          : l10n.coTermsMintFailed,
              onRetry: minting ? null : onRetry,
            )
          else ...[
            Stack(
              alignment: Alignment.center,
              children: [
                QrView(data: url!, size: 184, dead: countdown.isExpired),
                if (countdown.isExpired)
                  Column(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      const Icon(Icons.schedule_rounded,
                          size: 30, color: RideTokens.warnTx),
                      const SizedBox(height: 6),
                      Text(
                        l10n.coTermsExpiredOverlay,
                        style: const TextStyle(
                          fontSize: 13.5,
                          fontWeight: FontWeight.w900,
                          color: RideTokens.warnTx,
                        ),
                      ),
                    ],
                  ),
              ],
            ),
            const SizedBox(height: 12),
            CountdownPill(countdown: countdown),
          ],
        ],
      ),
    );
  }
}

/// Pill del countdown: `mm:ss` en cifras TABULARES (el ancho no salta al
/// pasar de 10:00 a 9:59) y tres estados nombrados.
///
/// El ámbar de los 2 min no es estético: es la frontera en la que el backend
/// deja de reusar el token vigente (ver [kTermsTokenReuseFloor]).
class CountdownPill extends StatelessWidget {
  const CountdownPill({super.key, required this.countdown});

  final TermsCountdown countdown;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    final (bg, fg, label) = switch (countdown.phase) {
      TermsCountdownPhase.live => (
          RideTokens.n50,
          RideTokens.n900,
          l10n.coTermsExpiresIn,
        ),
      TermsCountdownPhase.closing => (
          RideTokens.warnBg,
          RideTokens.warnTx,
          l10n.coTermsExpiresIn,
        ),
      TermsCountdownPhase.expired => (
          RideTokens.dangerBg,
          RideTokens.dangerTx,
          l10n.coTermsExpired,
        ),
    };
    return Container(
      constraints: const BoxConstraints(minHeight: 38),
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 7),
      decoration: BoxDecoration(
        color: bg,
        borderRadius: BorderRadius.circular(12),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Text(
            label,
            style: TextStyle(
              fontSize: 12.5,
              fontWeight: FontWeight.w800,
              color: fg,
            ),
          ),
          const SizedBox(width: 8),
          Text(
            countdown.mmss,
            style: TextStyle(
              fontSize: 16,
              fontWeight: FontWeight.w900,
              color: fg,
              fontFeatures: const [FontFeature.tabularFigures()],
            ),
          ),
        ],
      ),
    );
  }
}

class _QrPlaceholder extends StatelessWidget {
  const _QrPlaceholder({
    required this.minting,
    required this.message,
    required this.onRetry,
  });

  final bool minting;
  final String message;
  final VoidCallback? onRetry;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    return Column(
      children: [
        SizedBox(
          width: 184,
          height: 184,
          child: DecoratedBox(
            decoration: BoxDecoration(
              color: RideTokens.n50,
              borderRadius: BorderRadius.circular(12),
              border: Border.all(color: RideTokens.n200),
            ),
            child: Center(
              child: minting
                  ? const CircularProgressIndicator(color: RideTokens.p600)
                  : const Icon(Icons.qr_code_2_rounded,
                      size: 44, color: RideTokens.n500),
            ),
          ),
        ),
        const SizedBox(height: 12),
        Text(
          message,
          textAlign: TextAlign.center,
          style: const TextStyle(
            fontSize: 13,
            fontWeight: FontWeight.w700,
            color: RideTokens.n700,
          ),
        ),
        if (onRetry != null) ...[
          const SizedBox(height: 10),
          SizedBox(
            width: 200,
            child: RideGhostButton(
              label: l10n.retryButton,
              onPressed: onRetry,
            ),
          ),
        ],
      ],
    );
  }
}

/// Resultado HONESTO de la re-emisión (nota 9): cuando el backend reusa el
/// token vigente, se dice — no se finge una emisión que no ocurrió.
class _ReMintNotice extends StatelessWidget {
  const _ReMintNotice({required this.reused});

  final bool reused;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    return WizardBanner(
      icon: reused ? Icons.info_outline_rounded : Icons.check_circle_outline,
      iconColor: reused ? RideTokens.focus : RideTokens.ok,
      background: reused ? RideTokens.infoBg : RideTokens.okBg,
      border: reused ? RideTokens.infoBd : RideTokens.okBd,
      child: Text(
        reused ? l10n.coTermsReused : l10n.coTermsReissued,
        style: TextStyle(
          fontSize: 12.5,
          fontWeight: FontWeight.w700,
          color: reused ? RideTokens.n800 : RideTokens.okTx,
        ),
      ),
    );
  }
}

/// Dock del paso mientras no hay firma: la única acción es re-emitir. Vencido
/// (10D) sube a primario; vivo (10A) se queda en ghost — el agente no debería
/// tocarlo mientras el código sirve.
class _ReMintDock extends StatelessWidget {
  const _ReMintDock({
    required this.expired,
    required this.minting,
    required this.offline,
    required this.onReMint,
  });

  final bool expired;
  final bool minting;
  final bool offline;
  final VoidCallback onReMint;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    final onPressed = minting || offline ? null : onReMint;
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
          if (expired)
            RidePrimaryButton(
              label: l10n.coTermsReissue,
              loading: minting,
              onPressed: onPressed,
            )
          else
            RideGhostButton(label: l10n.coTermsReissue, onPressed: onPressed),
          const SizedBox(height: 9),
          Text(
            offline
                ? l10n.coTermsOfflineWhy
                : expired
                    ? l10n.coTermsExpiredWhy
                    : l10n.coTermsReissueWhy,
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

/// 10C — el sello llegó (por el teléfono del cliente o por otra superficie: la
/// UI se pinta IGUAL, la fuente del sello no la cambia).
class _SignedView extends ConsumerWidget {
  const _SignedView({
    required this.reservationId,
    required this.session,
    required this.banners,
  });

  final String reservationId;
  final CheckoutSessionDto session;
  final List<Widget> banners;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = AppLocalizations.of(context)!;
    final state = ref.watch(checkoutWizardProvider(reservationId));
    final locale = Localizations.localeOf(context).toString();
    final time = DateFormat.Hm(locale).format(session.tcCompletedAt!.toLocal());
    final name = state.context?.customer?.fullName;
    final declined = declinedInsuranceOf(
      session: session,
      agreement: state.context?.agreement,
    );

    return Column(
      children: [
        Expanded(
          child: ListView(
            padding: const EdgeInsets.fromLTRB(14, 12, 14, 12),
            children: [
              ...banners,
              const SizedBox(height: 6),
              const Center(
                child: Icon(Icons.check_circle_rounded,
                    size: 44, color: RideTokens.ok),
              ),
              const SizedBox(height: 10),
              Text(
                l10n.coTermsSignedTitle,
                textAlign: TextAlign.center,
                style: const TextStyle(
                  fontSize: 19,
                  fontWeight: FontWeight.w900,
                  color: RideTokens.n900,
                ),
              ),
              const SizedBox(height: 4),
              Text(
                // El éxito nombra a QUIÉN y CUÁNDO — es la frase que el agente
                // le repite al cliente. Lo que NO se afirma es DÓNDE firmó: el
                // sello puede venir del teléfono del cliente o del kiosco, y
                // la sesión no lo distingue.
                name == null
                    ? l10n.coTermsSignedBodyNoName(time)
                    : l10n.coTermsSignedBody(name, time),
                textAlign: TextAlign.center,
                style: const TextStyle(
                  fontSize: 13.5,
                  fontWeight: FontWeight.w700,
                  color: RideTokens.n700,
                ),
              ),
              const SizedBox(height: 16),
              VerifyCard(
                title: l10n.coTermsRecord,
                tone: VerifyTone.ok,
                pillLabel: l10n.coTermsRecordConfirmed,
                children: [
                  KvRow(
                    label: l10n.coTermsRecordSigned,
                    value: time,
                    tabular: true,
                  ),
                  KvRow(
                    label: l10n.coTermsRecordAddenda,
                    value: declined
                        ? l10n.coTermsAddendaDecline
                        : l10n.coTermsAddendaNone,
                  ),
                ],
              ),
            ],
          ),
        ),
        Padding(
          padding: const EdgeInsets.fromLTRB(14, 0, 14, 14),
          child: TransitionButton(
            reservationId: reservationId,
            toStep: CheckoutStep.tcSigned,
            label: l10n.coTermsCta,
            why: l10n.coTermsCtaWhy,
          ),
        ),
      ],
    );
  }
}
