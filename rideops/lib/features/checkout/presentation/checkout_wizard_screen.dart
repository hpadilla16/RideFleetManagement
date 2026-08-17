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
import '../domain/checkout_presence.dart';
import 'checkout_labels.dart';
import 'widgets/pause_sheet.dart';
import 'widgets/steps_sheet.dart';
import 'widgets/terminal_view.dart';
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
      final message = state.error?.message ?? '';
      return _MessageView(
        icon: Icons.error_outline_rounded,
        title: l10n.coLoadFailedTitle,
        // Mensaje del backend tal cual (DoD #5): la app no lo inventa. Pero
        // un error SIN mensaje (5xx pelado, socket cortado) no puede dejar un
        // hueco en blanco: ahí sí toca un copy traducido.
        body: message.isNotEmpty
            ? message
            : (state.offline
                ? l10n.errorNoConnectionRetry
                : l10n.genericError),
        actionLabel: l10n.retryButton,
        // Recuperarse es la acción PRINCIPAL de esta pantalla: va en primario.
        primary: true,
        onAction: _controller.refresh,
      );
    }

    if (session.isTerminal) {
      // Frame 11E (M2-H7): la pantalla terminal vive en su propio widget
      // porque es el destino de DOS caminos — la sesión que ya estaba cerrada
      // al entrar, y el 409 SESSION_TERMINAL al crearla desde la card.
      return CheckoutTerminalView(
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
          presence: pickPresenceChip(
            session.presence,
            clock.now(),
            // Nunca listarse a uno mismo como acompañante (inerte hasta que
            // el backend mande `actorUserId` — ver el WHY en el DTO).
            myUserId: ref.watch(sessionControllerProvider).user?.id,
          ),
          mini: mini,
          // Sin red el punto de presencia se apaga: el verde afirma "está
          // AHORA" y esa afirmación la sostiene un heartbeat del servidor que
          // ahora mismo no podemos leer.
          offline: state.offline,
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
              // ya tiene, fechados.
              _StampsCard(session: session, dataAge: age),
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
    if (ref.read(_provider).session == null) return;
    // El agente ya está viendo qué cambió: el banner cumplió su trabajo.
    _controller.dismissAdvance();
    setState(() => _sheetOpen = true);
    await showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      // Scrim de marca rgba(23,18,43,.42) — el mismo del selector de sedes
      // (nota 7 del 4C). El black54 por default de Material no es el nuestro.
      barrierColor: const Color(0x6B17122B),
      // useSafeArea: sin esto el botón de cerrar queda bajo la barra de
      // gestos en teléfonos con notch.
      useSafeArea: true,
      // Plate OPACO, no blur (política del M1: nada de BackdropFilter sin
      // señal de capacidad del dispositivo).
      backgroundColor: RideTokens.n0,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(22)),
      ),
      constraints: const BoxConstraints(maxHeight: 620),
      // VIVO, no una foto: con `ref.read` la lista, los candados de entry
      // guard y la edad quedaban clavados al instante de apertura — diría
      // "hace 3 s" dos minutos después. Y este sheet es justo el destino del
      // "Ver qué cambió" del banner de avance ajeno: mostrar ahí una lista
      // incapaz de reflejar un movimiento posterior sería mentir en la
      // historia cuyo propósito ENTERO es la verdad multi-superficie (y
      // contradiría la regla escrita en checkout_wizard_state: "nunca se
      // disfraza de vivo").
      builder: (_) => Consumer(
        builder: (_, sheetRef, _) {
          final live = sheetRef.watch(_provider);
          final session = live.session;
          if (session == null) return const SizedBox.shrink();
          return StepsSheet(
            session: session,
            myUserId: sheetRef.watch(sessionControllerProvider).user?.id,
            dataAge: live.fetchedAt == null
                ? Duration.zero
                : clock.now().difference(live.fetchedAt!),
          );
        },
      ),
    );
    if (mounted) setState(() => _sheetOpen = false);
  }

  Future<void> _openPauseSheet() async {
    final state = ref.read(_provider);
    if (state.session == null) return;
    setState(() => _sheetOpen = true);
    var pauseFailed = false;
    final outcome = await showModalBottomSheet<_PauseOutcome>(
      context: context,
      isScrollControlled: true,
      barrierColor: const Color(0x6B17122B),
      useSafeArea: true,
      backgroundColor: RideTokens.n0,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(22)),
      ),
      builder: (sheetContext) => StatefulBuilder(
        builder: (_, setSheetState) => Consumer(
          builder: (_, sheetRef, _) {
            final live = sheetRef.watch(_provider);
            return PauseSheet(
              position: live.position,
              pausing: live.pausing,
              offline: live.offline,
              pauseFailed: pauseFailed,
              onConfirm: () async {
                final ok = await _controller.pause();
                if (!sheetContext.mounted) return;
                if (ok) {
                  Navigator.of(sheetContext).pop(_PauseOutcome.paused);
                } else {
                  // Se queda ABIERTO: el fallo aparece dentro del sheet junto
                  // a la salida sin pausar, que es lo que el agente necesita.
                  setSheetState(() => pauseFailed = true);
                }
              },
              onStay: () => Navigator.of(sheetContext).pop(_PauseOutcome.stay),
              onLeaveWithoutPausing: () =>
                  Navigator.of(sheetContext).pop(_PauseOutcome.leave),
            );
          },
        ),
      ),
    );
    if (!mounted) return;
    setState(() => _sheetOpen = false);
    if (outcome == _PauseOutcome.paused || outcome == _PauseOutcome.leave) {
      _leave();
    }
  }
}

/// Qué hizo el agente en el sheet de pausa. `leave` es la salida honesta sin
/// POST (INN MC-4): no se pausó nada y se dice así.
enum _PauseOutcome { paused, stay, leave }

/// Los 4 sellos de side-effect tal como el servidor los reporta. Es la única
/// afirmación que el shell puede hacer sin el cuerpo del paso — y es la que
/// hace visible el diff del poll (un sello puede caer mientras miras).
class _StampsCard extends StatelessWidget {
  const _StampsCard({required this.session, required this.dataAge});

  final CheckoutSessionDto session;
  final Duration dataAge;

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
          // De cuándo es lo que se está afirmando: la tarjeta muestra sellos
          // del SERVIDOR, y su verdad tiene fecha de caducidad.
          Text(
            l10n.coSessionAgeLabel(checkoutAgeLabel(l10n, dataAge)),
            style: const TextStyle(
              fontSize: 12,
              fontWeight: FontWeight.w700,
              color: RideTokens.n700,
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
                      // Horas en cifras tabulares: una columna de horas que
                      // no se alinea se lee mal de un vistazo.
                      fontFeatures: const [FontFeature.tabularFigures()],
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

class _MessageView extends StatelessWidget {
  const _MessageView({
    required this.icon,
    required this.title,
    required this.body,
    required this.actionLabel,
    required this.onAction,
    this.primary = false,
  });

  final IconData icon;
  final String title;
  final String body;
  final String actionLabel;
  final VoidCallback onAction;

  /// La acción de RECUPERACIÓN va en primario (reintentar); "salir" de un
  /// estado que no es un error se queda en ghost.
  final bool primary;

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
              child: primary
                  ? RidePrimaryButton(label: actionLabel, onPressed: onAction)
                  : RideGhostButton(label: actionLabel, onPressed: onAction),
            ),
          ],
        ),
      ),
    );
  }
}
