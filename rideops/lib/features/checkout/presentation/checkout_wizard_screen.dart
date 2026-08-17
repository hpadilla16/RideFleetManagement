import 'package:clock/clock.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:intl/intl.dart';

import '../../../core/api/dto/checkout_session.dart';
import '../../../core/l10n/app_localizations.dart';
import '../../../core/router/app_router.dart';
import '../../../core/session/active_location.dart';
import '../../../core/session/session_controller.dart';
import '../../../core/theme/ride_tokens.dart';
import '../../../core/widgets/ride_buttons.dart';
import '../../shell/location_denied_view.dart';
import '../application/checkout_wizard_controller.dart';
import '../application/checkout_wizard_state.dart';
import '../domain/checkout_event_log.dart';
import '../domain/checkout_presence.dart';
import 'checkout_labels.dart';
import 'widgets/pause_sheet.dart';
import 'widgets/steps_sheet.dart';
import 'widgets/wizard_banners.dart';
import 'widgets/wizard_chrome.dart';
import 'widgets/wizard_skeleton.dart';

/// Shell del wizard de checkout (M2-H1, mockup 8A–8F). Ruta
/// `/checkout/:reservationId`, FUERA del ShellRoute: sin tabs ni chip de sede
/// — el header propio del flujo manda, igual que la inspección.
///
/// Esta pantalla NO sabe de la máquina de estados: dibuja `currentStep` y deja
/// los huecos donde H2–H5 montan el cuerpo de cada paso.
class CheckoutWizardScreen extends ConsumerStatefulWidget {
  const CheckoutWizardScreen({super.key, required this.reservationId});

  final String reservationId;

  @override
  ConsumerState<CheckoutWizardScreen> createState() =>
      _CheckoutWizardScreenState();
}

class _CheckoutWizardScreenState extends ConsumerState<CheckoutWizardScreen> {
  /// El header de sesión pasa a su variante mini cuando un sheet ocupa la
  /// pantalla (8B/8E) o cuando el banner offline se lleva el alto (8D).
  bool _sheetOpen = false;

  NotifierProvider<CheckoutWizardController, CheckoutWizardState>
      get _provider => checkoutWizardProvider(widget.reservationId);

  CheckoutWizardController get _controller => ref.read(_provider.notifier);

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    final state = ref.watch(_provider);

    // Nunca se sale de un checkout sin decidir explícitamente (nota 1): la
    // flecha —y el back del sistema— abren el mismo sheet de pausa. Cuando no
    // hay nada que pausar (sesión terminal, 404, error de arranque) el back
    // es directo: pedir confirmación de algo inexistente sería teatro.
    final needsPauseDecision = state.session != null && !state.isTerminal;

    return PopScope(
      canPop: !needsPauseDecision,
      onPopInvokedWithResult: (didPop, _) {
        if (!didPop) _openPauseSheet();
      },
      child: Scaffold(
        backgroundColor: RideTokens.n50,
        body: SafeArea(
          child: Column(
            children: [
              WizardBar(
                title: state.context?.reservationNumber == null
                    ? l10n.coTitleNoNumber
                    : l10n.coTitle(state.context!.reservationNumber!),
                subtitle: _scopeLine(),
                onBack: () {
                  if (needsPauseDecision) {
                    _openPauseSheet();
                  } else {
                    _leave();
                  }
                },
                onPause: needsPauseDecision ? _openPauseSheet : null,
              ),
              Expanded(child: _body(l10n, state)),
            ],
          ),
        ),
      ),
    );
  }

  /// "Autos del Valle · Patio Centro" — tenant (superficie de staff) + sede
  /// activa del selector. Se omite lo que no se sabe en lugar de rellenar.
  String? _scopeLine() {
    final tenant = ref.watch(_provider).context?.tenantName;
    final location = ref.watch(activeLocationProvider).locationName;
    final parts = [tenant, location].nonNulls.where((p) => p.isNotEmpty);
    return parts.isEmpty ? null : parts.join(' · ');
  }

  Widget _body(AppLocalizations l10n, CheckoutWizardState state) {
    // 8F: skeleton con la geometría real, solo en el primer fetch.
    if (state.firstLoad) return const WizardSkeleton();

    if (state.viewLocationDenied) {
      return LocationDeniedView(
        locationName: ref.watch(activeLocationProvider).locationName,
        onRetry: _controller.refresh,
      );
    }

    if (state.notFound) {
      return _MessageView(
        icon: Icons.inbox_outlined,
        title: l10n.coNoSessionTitle,
        body: l10n.coNoSessionBody,
        actionLabel: l10n.coExit,
        onAction: _leave,
      );
    }

    final session = state.session;
    if (session == null) {
      return _MessageView(
        icon: Icons.error_outline_rounded,
        title: l10n.coLoadFailedTitle,
        // Mensaje del backend tal cual (DoD #5): la app no lo inventa.
        body: state.error?.message ?? '',
        actionLabel: l10n.retryButton,
        onAction: _controller.refresh,
      );
    }

    if (session.isTerminal) {
      return _TerminalView(
        session: session,
        myUserId: ref.watch(sessionControllerProvider).user?.id,
        onExit: _leave,
      );
    }

    final age = state.fetchedAt == null
        ? Duration.zero
        : clock.now().difference(state.fetchedAt!);
    final mini = _sheetOpen || state.offline;

    return Column(
      children: [
        SessionHead(
          context_: state.context,
          presence: pickPresenceChip(session.presence, clock.now()),
          mini: mini,
        ),
        PhaseRail(currentPosition: state.position),
        StepLine(
          rawStep: session.currentStep,
          position: state.position,
          staleAge: state.offline ? age : null,
          onTap: _openStepsSheet,
        ),
        Expanded(
          child: ListView(
            padding: const EdgeInsets.fromLTRB(14, 12, 14, 20),
            children: [
              if (state.offline) ...[
                OfflineBanner(age: age, onRetry: _controller.refresh),
                const SizedBox(height: 10),
              ],
              if (state.advance != null) ...[
                ForeignAdvanceBanner(
                  notice: state.advance!,
                  onSeeChanged: _openStepsSheet,
                ),
                const SizedBox(height: 10),
              ],
              if (state.conflict != null) ...[
                ConflictBanner(
                  conflict: state.conflict!,
                  onDismiss: _controller.dismissConflict,
                ),
                const SizedBox(height: 10),
              ],
              // Cuerpo del paso. H1 entrega el shell: cada paso concreto
              // (CONFIRMING H2, pago H3, inspección H4, firma H5) reemplaza
              // esto por el suyo. Mientras tanto se muestra lo único que el
              // shell puede afirmar por sí mismo: los sellos que el servidor
              // ya tiene.
              _StampsCard(session: session),
            ],
          ),
        ),
      ],
    );
  }

  void _leave() {
    if (context.canPop()) {
      context.pop();
    } else {
      context.go(AppRoutes.home);
    }
  }

  Future<void> _openStepsSheet() async {
    final state = ref.read(_provider);
    final session = state.session;
    if (session == null) return;
    // El agente ya está viendo qué cambió: el banner cumplió su trabajo.
    _controller.dismissAdvance();
    setState(() => _sheetOpen = true);
    await showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      // Plate OPACO, no blur (política del M1: nada de BackdropFilter sin
      // señal de capacidad del dispositivo).
      backgroundColor: RideTokens.n0,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(22)),
      ),
      constraints: const BoxConstraints(maxHeight: 620),
      builder: (_) => StepsSheet(
        session: session,
        myUserId: ref.read(sessionControllerProvider).user?.id,
        dataAge: state.fetchedAt == null
            ? Duration.zero
            : clock.now().difference(state.fetchedAt!),
      ),
    );
    if (mounted) setState(() => _sheetOpen = false);
  }

  Future<void> _openPauseSheet() async {
    final state = ref.read(_provider);
    if (state.session == null) return;
    setState(() => _sheetOpen = true);
    final paused = await showModalBottomSheet<bool>(
      context: context,
      isScrollControlled: true,
      backgroundColor: RideTokens.n0,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(22)),
      ),
      builder: (sheetContext) => Consumer(
        builder: (_, sheetRef, _) => PauseSheet(
          position: sheetRef.watch(_provider).position,
          pausing: sheetRef.watch(_provider).pausing,
          onConfirm: () async {
            final ok = await _controller.pause();
            if (!sheetContext.mounted) return;
            Navigator.of(sheetContext).pop(ok);
          },
          onStay: () => Navigator.of(sheetContext).pop(false),
        ),
      ),
    );
    if (!mounted) return;
    setState(() => _sheetOpen = false);
    if (paused == true) {
      _leave();
    } else if (paused == false && ref.read(_provider).error != null) {
      // El abandon falló (sin red, o 409 de sesión terminal): se dice, no se
      // simula que pausó.
      final l10n = AppLocalizations.of(context)!;
      ScaffoldMessenger.of(context)
          .showSnackBar(SnackBar(content: Text(l10n.coPauseFailed)));
    }
  }
}

/// Los 4 sellos de side-effect tal como el servidor los reporta. Es la única
/// afirmación que el shell puede hacer sin el cuerpo del paso — y es la que
/// hace visible el diff del poll (un sello puede caer mientras miras).
class _StampsCard extends StatelessWidget {
  const _StampsCard({required this.session});

  final CheckoutSessionDto session;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    final format = DateFormat.Hm(Localizations.localeOf(context).toString());
    final rows = <(String, DateTime?)>[
      (l10n.coStampTc, session.tcCompletedAt),
      (l10n.coStampPayment, session.paymentCompletedAt),
      (l10n.coStampInspection, session.inspectionCompletedAt),
      (l10n.coStampSignature, session.customerSignedAt),
    ];
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
          Text(
            l10n.coStampsTitle,
            style: const TextStyle(
              fontSize: 14,
              fontWeight: FontWeight.w900,
              color: RideTokens.n900,
            ),
          ),
          const SizedBox(height: 8),
          for (final (label, at) in rows)
            Padding(
              padding: const EdgeInsets.symmetric(vertical: 4),
              child: Row(
                children: [
                  Icon(
                    at == null
                        ? Icons.radio_button_unchecked_rounded
                        : Icons.check_circle_rounded,
                    size: 17,
                    color: at == null ? RideTokens.n400 : RideTokens.ok,
                  ),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Text(
                      label,
                      style: const TextStyle(
                        fontSize: 13,
                        fontWeight: FontWeight.w800,
                        color: RideTokens.n800,
                      ),
                    ),
                  ),
                  Text(
                    at == null
                        ? l10n.coStampPending
                        : l10n.coStampDone(format.format(at.toLocal())),
                    style: TextStyle(
                      fontSize: 12.5,
                      fontWeight: FontWeight.w700,
                      color: at == null ? RideTokens.n600 : RideTokens.okTx,
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

/// Sesión terminal (CLOSED / CANCELLED, y el destino del 409
/// SESSION_TERMINAL / CHECKOUT_TERMINAL): resumen del events log. No hay
/// nada que avanzar aquí — se cuenta qué pasó y se ofrece la salida.
class _TerminalView extends StatelessWidget {
  const _TerminalView({
    required this.session,
    required this.myUserId,
    required this.onExit,
  });

  final CheckoutSessionDto session;
  final String? myUserId;
  final VoidCallback onExit;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    final format = DateFormat.Hm(Localizations.localeOf(context).toString());
    final events = parseCheckoutEvents(session.events).reversed.toList();
    final cancelled = session.currentStep == 'CANCELLED';
    return ListView(
      padding: const EdgeInsets.fromLTRB(16, 18, 16, 20),
      children: [
        Icon(
          cancelled ? Icons.cancel_outlined : Icons.verified_outlined,
          size: 34,
          color: cancelled ? RideTokens.dangerTx : RideTokens.okTx,
        ),
        const SizedBox(height: 10),
        Text(
          cancelled ? l10n.coTerminalCancelledTitle : l10n.coTerminalClosedTitle,
          style: const TextStyle(
            fontSize: 19,
            fontWeight: FontWeight.w900,
            color: RideTokens.n900,
          ),
        ),
        const SizedBox(height: 4),
        Text(
          l10n.coTerminalBody,
          style: const TextStyle(
            fontSize: 13.5,
            fontWeight: FontWeight.w700,
            color: RideTokens.n700,
          ),
        ),
        const SizedBox(height: 16),
        Text(
          l10n.coTerminalLogTitle,
          style: const TextStyle(
            fontSize: 14,
            fontWeight: FontWeight.w900,
            color: RideTokens.n900,
          ),
        ),
        const SizedBox(height: 8),
        for (final event in events)
          if (event.isTransition)
            Padding(
              padding: const EdgeInsets.symmetric(vertical: 3),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const Icon(Icons.circle, size: 7, color: RideTokens.n400),
                  const SizedBox(width: 9),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Text(
                          stepLabel(l10n, event.to!),
                          style: const TextStyle(
                            fontSize: 13,
                            fontWeight: FontWeight.w800,
                            color: RideTokens.n900,
                          ),
                        ),
                        Text(
                          doneLabel(
                            l10n,
                            event: event,
                            myUserId: myUserId,
                            time: event.at == null
                                ? '—'
                                : format.format(event.at!.toLocal()),
                          ),
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
            ),
        const SizedBox(height: 18),
        RidePrimaryButton(label: l10n.coExit, onPressed: onExit),
      ],
    );
  }
}

class _MessageView extends StatelessWidget {
  const _MessageView({
    required this.icon,
    required this.title,
    required this.body,
    required this.actionLabel,
    required this.onAction,
  });

  final IconData icon;
  final String title;
  final String body;
  final String actionLabel;
  final VoidCallback onAction;

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 26),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(icon, size: 34, color: RideTokens.n600),
            const SizedBox(height: 12),
            Text(
              title,
              textAlign: TextAlign.center,
              style: const TextStyle(
                fontSize: 17,
                fontWeight: FontWeight.w900,
                color: RideTokens.n900,
              ),
            ),
            const SizedBox(height: 6),
            Text(
              body,
              textAlign: TextAlign.center,
              style: const TextStyle(
                fontSize: 13.5,
                fontWeight: FontWeight.w600,
                color: RideTokens.n700,
              ),
            ),
            const SizedBox(height: 16),
            SizedBox(
              width: 220,
              child: RideGhostButton(label: actionLabel, onPressed: onAction),
            ),
          ],
        ),
      ),
    );
  }
}
