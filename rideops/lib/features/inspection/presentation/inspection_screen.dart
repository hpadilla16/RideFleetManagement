import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/l10n/app_localizations.dart';
import '../../../core/outbox/network_status.dart';
import '../../../core/outbox/outbox_service.dart';
import '../../../core/router/app_router.dart';
import '../../../core/theme/ride_tokens.dart';
import '../../../core/widgets/ride_buttons.dart';
import '../application/inspection_controller.dart';
import '../application/inspection_state.dart';
import 'camera_capture_screen.dart';
import 'widgets/angle_labels.dart';
import 'widgets/inspection_bodies.dart';
import 'widgets/kiosk_signature_step.dart';

/// Flujo de inspección nativa en 3 pasos (mockup 6A-6F): fotos → métricas →
/// firma (kiosco) → resumen. Ruta: /inspection/:reservationId.
///
/// Sigue viva junto al paso 4 del wizard (M2-H4): la bandeja de salida abre
/// aquí sus filas muertas y el drenado la necesita. Los CUERPOS de los tres
/// sub-pasos son los mismos widgets que monta el wizard
/// (`widgets/inspection_bodies.dart`); lo único distinto es quién pone el
/// CTA — aquí la propia pantalla, allá el pie del wizard.
class InspectionScreen extends ConsumerStatefulWidget {
  const InspectionScreen({super.key, required this.reservationId});

  final String reservationId;

  @override
  ConsumerState<InspectionScreen> createState() => _InspectionScreenState();
}

class _InspectionScreenState extends ConsumerState<InspectionScreen> {
  bool _online = true;

  NotifierProvider<InspectionController, InspectionFlowState> get _provider =>
      inspectionControllerProvider(widget.reservationId);

  @override
  void initState() {
    super.initState();
    _refreshOnline();
  }

  Future<void> _refreshOnline() async {
    try {
      final has = await ref.read(networkStatusProvider).hasNetwork();
      if (mounted) setState(() => _online = has);
    } catch (_) {}
  }

  Future<void> _finish(
    InspectionController controller,
    AppLocalizations l10n,
  ) async {
    final result = await controller.finish();
    if (!mounted) return;
    if (result == EnqueueResult.ok) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(l10n.inspFinishQueued)),
      );
      context.go(AppRoutes.home);
    } else {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(l10n.inspOutboxFull)),
      );
    }
  }

  Future<void> _openCamera(String angleKey) async {
    // Tope de la bandeja: se bloquea ANTES de abrir la cámara (nota 7 del
    // mockup 7D), con la instrucción única: conéctate.
    final state = ref.read(_provider);
    if (state.outboxFull) {
      final l10n = AppLocalizations.of(context)!;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(l10n.inspOutboxFull)),
      );
      return;
    }
    await Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) => CameraCaptureScreen(
          reservationId: widget.reservationId,
          initialAngleKey: angleKey,
        ),
      ),
    );
    await _refreshOnline();
  }

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    final state = ref.watch(_provider);
    final controller = ref.read(_provider.notifier);

    return Scaffold(
      backgroundColor: RideTokens.n50,
      body: SafeArea(
        child: switch (state.phase) {
          InspectionFlowPhase.loading => const Center(
              child: CircularProgressIndicator(color: RideTokens.p600),
            ),
          InspectionFlowPhase.offline => _LoadError(
              icon: Icons.wifi_off_rounded,
              title: l10n.errorNoConnectionRetry,
              body: l10n.inspLoadOffline,
              onRetry: controller.load,
            ),
          InspectionFlowPhase.failed => _LoadError(
              icon: Icons.error_outline_rounded,
              title: l10n.genericError,
              // Mensaje del backend tal cual (403 de sede, guards de la
              // sesión): la app no lo inventa (DoD #5).
              body: state.error?.message ?? '',
              onRetry: controller.load,
            ),
          InspectionFlowPhase.alreadyCompleted =>
            _AlreadyCompleted(state: state, l10n: l10n),
          InspectionFlowPhase.active => _buildActive(context, l10n, state,
              controller),
        },
      ),
    );
  }

  Widget _buildActive(
    BuildContext context,
    AppLocalizations l10n,
    InspectionFlowState state,
    InspectionController controller,
  ) {
    // El paso de firma es pantalla completa del CLIENTE: sin header de
    // staff, sin stepper — cero rastro de RideOps (nota 10).
    if (state.step == InspectionStep.signature) {
      return KioskSignatureStep(
        // GD-1 + QA MAJOR: JAMÁS marca propia frente al cliente — el getter
        // neutraliza además el centinela 'Ride Fleet' que el backend manda
        // como default de plataforma. Sin nombre, el paso oculta la fila
        // (queda el subtítulo del trámite).
        tenantName: state.branding?.clientSafeCompanyName ?? '',
        tenantLogoUrl: state.branding?.companyLogoUrl ?? '',
        reservationLabel: state.reservationNumber ?? '—',
        // Pie de identidad (GD-MC-7): en un mismo checkout el cliente firma DOS
        // veces en este teléfono con cinco minutos de diferencia —la revisión y
        // la entrega—, y sin este renglón la primera no dice QUÉ se está
        // firmando. Sin placa el widget arma "…· Corolla 2023"; sin unidad omite
        // el pie entero (kiosk_signature_step.dart:_footLine).
        vehicleLabel: state.vehicleLabel,
        onConfirmed: controller.confirmSignature,
        onExitToStaff: () => controller.goToStep(InspectionStep.metrics),
      );
    }

    return Column(
      children: [
        _Header(state: state, l10n: l10n, onBack: () {
          switch (state.step) {
            case InspectionStep.photos:
              context.go(AppRoutes.home);
            case InspectionStep.metrics:
              controller.goToStep(InspectionStep.photos);
            case InspectionStep.summary:
              controller.goToStep(InspectionStep.metrics);
            case InspectionStep.signature:
              break; // no llega: la firma renderiza arriba
          }
        }),
        InspectionSubStepBar(step: state.step),
        Expanded(
          child: switch (state.step) {
            InspectionStep.photos => SingleChildScrollView(
                padding: const EdgeInsets.fromLTRB(18, 12, 18, 22),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    InspectionPhotosBody(
                      state: state,
                      online: _online,
                      onTapAngle: _openCamera,
                    ),
                    const SizedBox(height: 16),
                    RidePrimaryButton(
                      label: l10n.inspContinueMetrics,
                      onPressed: state.requiredCaptured
                          ? () => controller.goToStep(InspectionStep.metrics)
                          : null,
                    ),
                    const SizedBox(height: 8),
                    Text(
                      // El gate en positivo (nota 4): el 409
                      // REQUIRED_ANGLES_MISSING no debería ocurrir nunca desde
                      // esta UI.
                      l10n.inspRequiredFootnote,
                      textAlign: TextAlign.center,
                      style: const TextStyle(
                        fontSize: 12.5,
                        fontWeight: FontWeight.w600,
                        color: RideTokens.n700,
                      ),
                    ),
                  ],
                ),
              ),
            InspectionStep.metrics => SingleChildScrollView(
                padding: const EdgeInsets.fromLTRB(18, 10, 18, 22),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    InspectionMetricsBody(
                      state: state,
                      controller: controller,
                    ),
                    const SizedBox(height: 16),
                    RidePrimaryButton(
                      label: l10n.inspContinueSignature,
                      onPressed: state.metricsComplete
                          ? () => controller.goToStep(InspectionStep.signature)
                          : null,
                    ),
                    // Mismo gate, misma frase: el cuerpo es compartido y el
                    // motivo del bloqueo también tiene que serlo.
                    if (!state.metricsComplete) ...[
                      const SizedBox(height: 8),
                      Text(
                        metricsBlockedWhy(l10n, state)!,
                        textAlign: TextAlign.center,
                        style: const TextStyle(
                          fontSize: 12.5,
                          fontWeight: FontWeight.w700,
                          color: RideTokens.n700,
                        ),
                      ),
                    ],
                  ],
                ),
              ),
            InspectionStep.summary => Padding(
                padding: const EdgeInsets.fromLTRB(18, 12, 18, 22),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    InspectionSummaryBody(state: state, online: _online),
                    const Spacer(),
                    RidePrimaryButton(
                      label: _online
                          ? l10n.inspFinishOnline
                          : l10n.inspFinishOffline,
                      onPressed: state.signatureDataUrl == null
                          ? null
                          : () => _finish(controller, l10n),
                    ),
                    if (state.linkExpiresAt != null) ...[
                      const SizedBox(height: 8),
                      Text(
                        // Informativo: el drenador re-mintea al drenar (spike
                        // 2) — el vencimiento no amenaza la bandeja.
                        l10n.inspLinkExpires(
                          TimeOfDay.fromDateTime(
                            state.linkExpiresAt!.toLocal(),
                          ).format(context),
                        ),
                        textAlign: TextAlign.center,
                        style: const TextStyle(
                          fontSize: 12.5,
                          fontWeight: FontWeight.w600,
                          color: RideTokens.n700,
                        ),
                      ),
                    ],
                  ],
                ),
              ),
            InspectionStep.signature => const SizedBox.shrink(),
          },
        ),
      ],
    );
  }
}

class _Header extends StatelessWidget {
  const _Header({required this.state, required this.l10n, required this.onBack});

  final InspectionFlowState state;
  final AppLocalizations l10n;
  final VoidCallback onBack;

  @override
  Widget build(BuildContext context) {
    final meta = [
      if (state.reservationNumber != null) state.reservationNumber!,
      if (state.vehicleLabel != null) state.vehicleLabel!,
    ].join(' · ');
    final captured = state.capturedCount;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
      decoration: const BoxDecoration(
        color: Color(0xF5FFFFFF), // plate opaco .96 (política de blur)
        border: Border(bottom: BorderSide(color: RideTokens.n200)),
      ),
      child: Row(
        children: [
          Semantics(
            button: true,
            label: MaterialLocalizations.of(context).backButtonTooltip,
            onTap: onBack,
            child: ExcludeSemantics(
              child: Material(
                color: RideTokens.n0,
                borderRadius: BorderRadius.circular(14),
                child: InkWell(
                  onTap: onBack,
                  borderRadius: BorderRadius.circular(14),
                  child: Container(
                    width: 48,
                    height: 48,
                    decoration: BoxDecoration(
                      border: Border.all(color: RideTokens.n300, width: 1.5),
                      borderRadius: BorderRadius.circular(14),
                    ),
                    child: const Icon(Icons.arrow_back_rounded,
                        size: 20, color: RideTokens.n800),
                  ),
                ),
              ),
            ),
          ),
          const SizedBox(width: 10),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  state.step == InspectionStep.metrics
                      ? l10n.metricsTitle
                      : l10n.inspTitle,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(
                    fontSize: 15.5,
                    fontWeight: FontWeight.w800,
                    color: RideTokens.n900,
                  ),
                ),
                if (meta.isNotEmpty)
                  Text(
                    meta,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(
                      fontSize: 12,
                      fontWeight: FontWeight.w600,
                      color: RideTokens.n600,
                    ),
                  ),
              ],
            ),
          ),
          const SizedBox(width: 8),
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 4),
            decoration: BoxDecoration(
              color: captured >= 8 ? RideTokens.okBg : RideTokens.p50,
              border: Border.all(
                color: captured >= 8 ? RideTokens.okBd : RideTokens.brandA20,
              ),
              borderRadius: BorderRadius.circular(8),
            ),
            child: Text(
              captured >= 8
                  ? l10n.inspProgressDone
                  : l10n.inspProgressChip(captured),
              style: TextStyle(
                fontSize: 12.5,
                fontWeight: FontWeight.w700,
                color: captured >= 8 ? RideTokens.okTx : RideTokens.p800,
              ),
            ),
          ),
        ],
      ),
    );
  }
}

/// 6F — reconciliación: otra superficie completó primero. Tono informativo
/// (azul), no error: el trabajo del patio no se perdió, ya estaba hecho.
class _AlreadyCompleted extends StatelessWidget {
  const _AlreadyCompleted({required this.state, required this.l10n});

  final InspectionFlowState state;
  final AppLocalizations l10n;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(24, 24, 24, 24),
      child: Column(
        children: [
          const Spacer(),
          Container(
            width: 64,
            height: 64,
            decoration: BoxDecoration(
              color: const Color(0xFFEAF2FE),
              shape: BoxShape.circle,
              border: Border.all(color: const Color(0xFFC5DCFB), width: 1.5),
            ),
            child: const Icon(Icons.info_outline_rounded,
                size: 30, color: Color(0xFF0B63D6)),
          ),
          const SizedBox(height: 12),
          Text(
            l10n.alreadyCompletedTitle,
            textAlign: TextAlign.center,
            style: const TextStyle(
              fontSize: 22,
              fontWeight: FontWeight.w800,
              color: RideTokens.n900,
            ),
          ),
          const SizedBox(height: 8),
          Text(
            // Con hora del cierre cuando la sesión la trae (review GD): la
            // reconciliación se cuenta en pasado y con dato.
            state.completedAt == null
                ? l10n.alreadyCompletedBody
                : l10n.alreadyCompletedBodyAt(
                    TimeOfDay.fromDateTime(state.completedAt!.toLocal())
                        .format(context),
                  ),
            textAlign: TextAlign.center,
            style: const TextStyle(
              fontSize: 14,
              fontWeight: FontWeight.w500,
              color: RideTokens.n700,
            ),
          ),
          if (state.reservationNumber != null) ...[
            const SizedBox(height: 10),
            Container(
              padding:
                  const EdgeInsets.symmetric(horizontal: 9, vertical: 4),
              decoration: BoxDecoration(
                color: RideTokens.okBg,
                border: Border.all(color: RideTokens.okBd),
                borderRadius: BorderRadius.circular(8),
              ),
              child: Text(
                l10n.alreadyCompletedChip(state.reservationNumber!),
                style: const TextStyle(
                  fontSize: 12.5,
                  fontWeight: FontWeight.w700,
                  color: RideTokens.okTx,
                ),
              ),
            ),
          ],
          const Spacer(),
          RidePrimaryButton(
            label: l10n.backToHome,
            onPressed: () => context.go(AppRoutes.home),
          ),
        ],
      ),
    );
  }
}

class _LoadError extends StatelessWidget {
  const _LoadError({
    required this.icon,
    required this.title,
    required this.body,
    required this.onRetry,
  });

  final IconData icon;
  final String title;
  final String body;
  final Future<void> Function() onRetry;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    return Padding(
      padding: const EdgeInsets.all(24),
      child: Column(
        children: [
          const Spacer(),
          Container(
            width: 64,
            height: 64,
            decoration: BoxDecoration(
              color: RideTokens.warnBg,
              shape: BoxShape.circle,
              border: Border.all(color: RideTokens.warnBd, width: 1.5),
            ),
            child: Icon(icon, size: 30, color: RideTokens.warnTx),
          ),
          const SizedBox(height: 12),
          Text(
            title,
            textAlign: TextAlign.center,
            style: const TextStyle(
              fontSize: 18,
              fontWeight: FontWeight.w800,
              color: RideTokens.n900,
            ),
          ),
          if (body.isNotEmpty) ...[
            const SizedBox(height: 8),
            Text(
              body,
              textAlign: TextAlign.center,
              style: const TextStyle(
                fontSize: 14,
                fontWeight: FontWeight.w500,
                color: RideTokens.n700,
              ),
            ),
          ],
          const Spacer(),
          RidePrimaryButton(label: l10n.retryButton, onPressed: onRetry),
          const SizedBox(height: 10),
          RideGhostButton(
            label: l10n.backToHome,
            onPressed: () => context.go(AppRoutes.home),
          ),
        ],
      ),
    );
  }
}
