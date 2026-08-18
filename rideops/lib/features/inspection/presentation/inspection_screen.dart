import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
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
import 'widgets/angle_grid.dart';
import 'widgets/kiosk_signature_step.dart';

/// Flujo de inspección nativa en 3 pasos (mockup 6A-6F): fotos → métricas →
/// firma (kiosco) → resumen. Ruta: /inspection/:reservationId.
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
        _Stepper(step: state.step),
        Expanded(
          child: switch (state.step) {
            InspectionStep.photos => _PhotosStep(
                state: state,
                l10n: l10n,
                online: _online,
                onTapAngle: _openCamera,
                onContinue: state.requiredCaptured
                    ? () => controller.goToStep(InspectionStep.metrics)
                    : null,
              ),
            InspectionStep.metrics => _MetricsStep(
                state: state,
                l10n: l10n,
                controller: controller,
              ),
            InspectionStep.summary => _SummaryStep(
                state: state,
                l10n: l10n,
                online: _online,
                onFinish: () async {
                  final result = await controller.finish();
                  if (!context.mounted) return;
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
                },
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

class _Stepper extends StatelessWidget {
  const _Stepper({required this.step});

  final InspectionStep step;

  @override
  Widget build(BuildContext context) {
    final active = switch (step) {
      InspectionStep.photos => 1,
      InspectionStep.metrics => 2,
      InspectionStep.signature || InspectionStep.summary => 3,
    };
    return Padding(
      padding: const EdgeInsets.fromLTRB(18, 10, 18, 0),
      child: Row(
        children: [
          for (var i = 0; i < 3; i++) ...[
            if (i > 0) const SizedBox(width: 6),
            Expanded(
              child: Container(
                height: 5,
                decoration: BoxDecoration(
                  borderRadius: BorderRadius.circular(3),
                  gradient: i < active
                      ? const LinearGradient(
                          colors: [Color(0xFF7F4FF0), RideTokens.p600])
                      : null,
                  color: i < active ? null : RideTokens.n200,
                ),
              ),
            ),
          ],
        ],
      ),
    );
  }
}

class _PhotosStep extends StatelessWidget {
  const _PhotosStep({
    required this.state,
    required this.l10n,
    required this.online,
    required this.onTapAngle,
    required this.onContinue,
  });

  final InspectionFlowState state;
  final AppLocalizations l10n;
  final bool online;
  final void Function(String angleKey) onTapAngle;
  final VoidCallback? onContinue;

  @override
  Widget build(BuildContext context) {
    return SingleChildScrollView(
      padding: const EdgeInsets.fromLTRB(18, 12, 18, 22),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          if (!online) ...[
            _WarnBanner(text: l10n.inspOfflineBanner),
            const SizedBox(height: 10),
          ],
          if (state.outboxFull) ...[
            _WarnBanner(text: l10n.inspOutboxFull),
            const SizedBox(height: 10),
          ],
          AngleGrid(angles: state.angles, onTapAngle: onTapAngle),
          const SizedBox(height: 16),
          RidePrimaryButton(
            label: l10n.inspContinueMetrics,
            onPressed: onContinue,
          ),
          const SizedBox(height: 8),
          Text(
            // El gate en positivo (nota 4): el 409 REQUIRED_ANGLES_MISSING
            // no debería ocurrir nunca desde esta UI.
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
    );
  }
}

class _MetricsStep extends StatefulWidget {
  const _MetricsStep({
    required this.state,
    required this.l10n,
    required this.controller,
  });

  final InspectionFlowState state;
  final AppLocalizations l10n;
  final InspectionController controller;

  @override
  State<_MetricsStep> createState() => _MetricsStepState();
}

class _MetricsStepState extends State<_MetricsStep> {
  late final TextEditingController _odometer;
  late final TextEditingController _notes;

  @override
  void initState() {
    super.initState();
    _odometer = TextEditingController(
        text: widget.state.odometer?.toString() ?? '');
    _notes = TextEditingController(text: widget.state.notes);
  }

  @override
  void dispose() {
    _odometer.dispose();
    _notes.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final l10n = widget.l10n;
    final state = widget.state;
    final controller = widget.controller;
    final prev = state.previousOdometer;
    final lowerThanPrev = state.odometer != null &&
        prev != null &&
        state.odometer! < prev;

    return SingleChildScrollView(
      padding: const EdgeInsets.fromLTRB(18, 10, 18, 22),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          _FieldLabel(l10n.metricsOdometer),
          TextField(
            controller: _odometer,
            keyboardType: TextInputType.number,
            inputFormatters: [FilteringTextInputFormatter.digitsOnly],
            style: const TextStyle(
              fontSize: 24,
              fontWeight: FontWeight.w800,
              color: RideTokens.n900,
              fontFeatures: [FontFeature.tabularFigures()],
            ),
            decoration: _inputDecoration(
              suffixText: l10n.metricsOdometerUnit,
            ),
            onChanged: (v) => controller.setOdometer(int.tryParse(v)),
          ),
          if (prev != null) ...[
            const SizedBox(height: 6),
            Text(
              // Fuente: endpoint autenticado (display-data → Vehicle.mileage)
              // — nota 7 del mockup: el token de inspección NO trae esto.
              l10n.metricsPrevReading('$prev'),
              style: const TextStyle(
                fontSize: 12.5,
                fontWeight: FontWeight.w600,
                color: RideTokens.n700,
              ),
            ),
          ],
          if (lowerThanPrev) ...[
            const SizedBox(height: 6),
            // Warning NO bloqueante: el backend acepta — la corrección es
            // humana (nota 7).
            _WarnBanner(text: l10n.metricsOdometerLower),
          ],
          _FieldLabel(l10n.metricsFuel),
          _FuelBar(
            eighths: state.fuelEighths,
            onChanged: controller.setFuelEighths,
            emptyLabel: l10n.fuelEmpty,
            fullLabel: l10n.fuelFull,
          ),
          _FieldLabel(l10n.metricsCleanliness),
          _CleanlinessRow(
            selected: state.cleanliness,
            onChanged: controller.setCleanliness,
            dirtyLabel: l10n.cleanDirty,
            spotlessLabel: l10n.cleanSpotless,
          ),
          _FieldLabel(l10n.metricsNotes),
          TextField(
            controller: _notes,
            minLines: 3,
            maxLines: 5,
            maxLength: 2000,
            style: const TextStyle(fontSize: 14, color: RideTokens.n800),
            decoration: _inputDecoration(counterText: ''),
            onChanged: controller.setNotes,
          ),
          const SizedBox(height: 16),
          RidePrimaryButton(
            label: l10n.inspContinueSignature,
            onPressed: state.metricsComplete
                ? () => controller.goToStep(InspectionStep.signature)
                : null,
          ),
        ],
      ),
    );
  }

  static InputDecoration _inputDecoration({
    String? suffixText,
    String? counterText,
  }) =>
      InputDecoration(
        suffixText: suffixText,
        counterText: counterText,
        filled: true,
        fillColor: RideTokens.n0,
        contentPadding:
            const EdgeInsets.symmetric(horizontal: 14, vertical: 14),
        enabledBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(16),
          borderSide: const BorderSide(color: RideTokens.n300, width: 1.5),
        ),
        focusedBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(16),
          // Foco AZUL del sistema — nunca morado sobre morado.
          borderSide: const BorderSide(color: RideTokens.focus, width: 2),
        ),
      );
}

class _FieldLabel extends StatelessWidget {
  const _FieldLabel(this.text);

  final String text;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(top: 14, bottom: 6),
      child: Text(
        text.toUpperCase(),
        style: const TextStyle(
          fontSize: 12,
          fontWeight: FontWeight.w700,
          letterSpacing: 0.6,
          color: RideTokens.n600,
        ),
      ),
    );
  }
}

/// Combustible en octavos (fuelbar del mockup 6C) — targets por segmento
/// ≥48 px de alto vía el gesto sobre toda la fila. [eighths] null = SIN
/// seleccionar (GD-5/INN S-4: sin default de "lleno" — evidencia
/// contractual se captura, no se presume).
class _FuelBar extends StatelessWidget {
  const _FuelBar({
    required this.eighths,
    required this.onChanged,
    required this.emptyLabel,
    required this.fullLabel,
  });

  final int? eighths;
  final ValueChanged<int> onChanged;
  final String emptyLabel;
  final String fullLabel;

  @override
  Widget build(BuildContext context) {
    final filled = eighths ?? 0;
    return Column(
      children: [
        Row(
          children: [
            for (var i = 1; i <= 8; i++) ...[
              if (i > 1) const SizedBox(width: 4),
              Expanded(
                child: Semantics(
                  button: true,
                  label: '$i/8',
                  selected: eighths == i,
                  onTap: () => onChanged(i),
                  child: ExcludeSemantics(
                    child: InkWell(
                      onTap: () => onChanged(i),
                      borderRadius: BorderRadius.circular(7),
                      child: Container(
                        height: 48,
                        decoration: BoxDecoration(
                          borderRadius: BorderRadius.circular(7),
                          gradient: i <= filled
                              ? const LinearGradient(
                                  begin: Alignment.topCenter,
                                  end: Alignment.bottomCenter,
                                  colors: [Color(0xFF9F79FF), RideTokens.p600],
                                )
                              : null,
                          color: i <= filled ? null : RideTokens.n200,
                          border: Border.all(
                            color: i <= filled
                                ? RideTokens.p600
                                : RideTokens.n300,
                          ),
                        ),
                      ),
                    ),
                  ),
                ),
              ),
            ],
          ],
        ),
        const SizedBox(height: 6),
        Row(
          mainAxisAlignment: MainAxisAlignment.spaceBetween,
          children: [
            Text(emptyLabel, style: _edgeStyle),
            Text(
              eighths == null ? '—' : '$eighths/8',
              style: const TextStyle(
                fontSize: 15,
                fontWeight: FontWeight.w800,
                color: RideTokens.n900,
                fontFeatures: [FontFeature.tabularFigures()],
              ),
            ),
            Text(fullLabel, style: _edgeStyle),
          ],
        ),
      ],
    );
  }

  static const _edgeStyle = TextStyle(
    fontSize: 12.5,
    fontWeight: FontWeight.w700,
    color: RideTokens.n700,
  );
}

/// Limpieza 1-5 en segmentos de 52 px con NÚMERO (nota 8: bajo el sol el
/// color se lava, el dígito no).
class _CleanlinessRow extends StatelessWidget {
  const _CleanlinessRow({
    required this.selected,
    required this.onChanged,
    required this.dirtyLabel,
    required this.spotlessLabel,
  });

  final int? selected;
  final ValueChanged<int> onChanged;
  final String dirtyLabel;
  final String spotlessLabel;

  @override
  Widget build(BuildContext context) {
    return Column(
      children: [
        Row(
          children: [
            for (var i = 1; i <= 5; i++) ...[
              if (i > 1) const SizedBox(width: 8),
              Expanded(
                child: Semantics(
                  button: true,
                  label: '$i',
                  selected: selected == i,
                  onTap: () => onChanged(i),
                  child: ExcludeSemantics(
                    child: Material(
                      color:
                          selected == i ? RideTokens.p50 : RideTokens.n0,
                      borderRadius: BorderRadius.circular(14),
                      child: InkWell(
                        onTap: () => onChanged(i),
                        borderRadius: BorderRadius.circular(14),
                        child: Container(
                          height: 52,
                          alignment: Alignment.center,
                          decoration: BoxDecoration(
                            borderRadius: BorderRadius.circular(14),
                            border: Border.all(
                              color: selected == i
                                  ? RideTokens.p600
                                  : RideTokens.n300,
                              width: 1.5,
                            ),
                          ),
                          child: Text(
                            '$i',
                            style: TextStyle(
                              fontSize: 14.5,
                              fontWeight: FontWeight.w800,
                              color: selected == i
                                  ? RideTokens.p800
                                  : RideTokens.n700,
                            ),
                          ),
                        ),
                      ),
                    ),
                  ),
                ),
              ),
            ],
          ],
        ),
        const SizedBox(height: 6),
        Row(
          mainAxisAlignment: MainAxisAlignment.spaceBetween,
          children: [
            Text(dirtyLabel, style: _FuelBar._edgeStyle),
            Text(spotlessLabel, style: _FuelBar._edgeStyle),
          ],
        ),
      ],
    );
  }
}

/// Resumen final (6E): qué viaja, cómo viaja y el CTA que dice la verdad
/// según la red.
class _SummaryStep extends StatelessWidget {
  const _SummaryStep({
    required this.state,
    required this.l10n,
    required this.online,
    required this.onFinish,
  });

  final InspectionFlowState state;
  final AppLocalizations l10n;
  final bool online;
  final Future<void> Function() onFinish;

  @override
  Widget build(BuildContext context) {
    final photoCount = state.capturedCount;
    return Padding(
      padding: const EdgeInsets.fromLTRB(18, 12, 18, 22),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          if (!online) ...[
            _WarnBanner(text: l10n.inspOfflineBanner),
            const SizedBox(height: 10),
          ],
          Container(
            padding: const EdgeInsets.all(14),
            decoration: BoxDecoration(
              color: RideTokens.n0,
              borderRadius: BorderRadius.circular(20),
              border: Border.all(color: const Color(0x248752FE)),
            ),
            child: Row(
              children: [
                Container(
                  width: 42,
                  height: 42,
                  decoration: BoxDecoration(
                    color: const Color(0x148752FE),
                    borderRadius: BorderRadius.circular(14),
                  ),
                  child: const Icon(Icons.outbox_outlined,
                      size: 20, color: RideTokens.p700),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        l10n.summaryQueueTitle(photoCount),
                        style: const TextStyle(
                          fontSize: 15,
                          fontWeight: FontWeight.w800,
                          color: RideTokens.n900,
                        ),
                      ),
                      const SizedBox(height: 2),
                      Text(
                        // "Guardado local cifrado" — respaldado por ADR-7
                        // (SQLCipher + AES-GCM de la bóveda), no adorno.
                        l10n.summaryQueueMeta,
                        style: const TextStyle(
                          fontSize: 12.5,
                          fontWeight: FontWeight.w600,
                          color: RideTokens.n600,
                        ),
                      ),
                    ],
                  ),
                ),
                const SizedBox(width: 8),
                Container(
                  padding:
                      const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                  decoration: BoxDecoration(
                    color: const Color(0xFFEAF2FE),
                    border: Border.all(color: const Color(0xFFC5DCFB)),
                    borderRadius: BorderRadius.circular(7),
                  ),
                  child: Text(
                    online
                        ? l10n.summaryQueueBadgeOnline
                        : l10n.summaryQueueBadgeOffline,
                    style: const TextStyle(
                      fontSize: 10.5,
                      fontWeight: FontWeight.w800,
                      color: RideTokens.n800,
                    ),
                  ),
                ),
              ],
            ),
          ),
          const Spacer(),
          RidePrimaryButton(
            label: online ? l10n.inspFinishOnline : l10n.inspFinishOffline,
            onPressed: state.signatureDataUrl == null ? null : onFinish,
          ),
          if (state.linkExpiresAt != null) ...[
            const SizedBox(height: 8),
            Text(
              // Informativo: el drenador re-mintea al drenar (spike 2) — el
              // vencimiento no amenaza la bandeja.
              l10n.inspLinkExpires(
                TimeOfDay.fromDateTime(state.linkExpiresAt!.toLocal())
                    .format(context),
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

class _WarnBanner extends StatelessWidget {
  const _WarnBanner({required this.text});

  final String text;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
      decoration: BoxDecoration(
        color: RideTokens.warnBg,
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: RideTokens.warnBd),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Icon(Icons.warning_amber_rounded,
              size: 18, color: RideTokens.warnTx),
          const SizedBox(width: 10),
          Expanded(
            child: Text(
              text,
              style: const TextStyle(
                fontSize: 13.5,
                fontWeight: FontWeight.w600,
                color: RideTokens.warnTx,
                height: 1.45,
              ),
            ),
          ),
        ],
      ),
    );
  }
}
