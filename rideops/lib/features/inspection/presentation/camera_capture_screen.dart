import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/l10n/app_localizations.dart';
import '../../../core/telemetry/event_logger.dart';
import '../../../core/theme/ride_tokens.dart';
import '../application/camera_service.dart';
import '../application/inspection_controller.dart';
import '../application/inspection_state.dart';
import '../application/photo_pipeline.dart';
import 'widgets/angle_labels.dart';

/// Cámara de captura (mockup 6B): overlay de esquinas + etiqueta del ángulo
/// sobre plate oscuro, shutter de 76 px, flash y cierre. Flujo continuo: al
/// capturar un ángulo avanza SOLO al siguiente pendiente (nota 5).
///
/// Contrato de vida del controlador (DoD #8, gama media):
///  - UN controlador por SESIÓN de captura (no por foto).
///  - dispose en [AppLifecycleState.inactive] y al salir; recrear en
///    resumed. La compresión corre fuera de este widget (pipeline) — cerrar
///    la cámara nunca cancela una foto ya tomada.
class CameraCaptureScreen extends ConsumerStatefulWidget {
  const CameraCaptureScreen({
    super.key,
    required this.reservationId,
    required this.initialAngleKey,
  });

  final String reservationId;
  final String initialAngleKey;

  @override
  ConsumerState<CameraCaptureScreen> createState() =>
      _CameraCaptureScreenState();
}

class _CameraCaptureScreenState extends ConsumerState<CameraCaptureScreen>
    with WidgetsBindingObserver {
  InspectionCameraSession? _session;
  Object? _cameraError;
  late String _angleKey;
  bool _flashOn = false;
  bool _shooting = false;

  InspectionController get _controller => ref
      .read(inspectionControllerProvider(widget.reservationId).notifier);

  @override
  void initState() {
    super.initState();
    _angleKey = widget.initialAngleKey;
    WidgetsBinding.instance.addObserver(this);
    _openCamera();
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _disposeCamera();
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    // inactive cubre también el task switcher: el controlador se suelta YA
    // (el sistema puede matar el proceso con la cámara abierta) y se recrea
    // al volver.
    if (state == AppLifecycleState.inactive ||
        state == AppLifecycleState.paused) {
      _disposeCamera();
    } else if (state == AppLifecycleState.resumed && _session == null) {
      _openCamera();
    }
  }

  @override
  void didHaveMemoryPressure() {
    // Guard de OOM (taxonomía camera.oom_guard): con el sistema pidiendo
    // memoria, el preview es lo primero que se suelta — la foto en curso ya
    // salió del controlador.
    ref.read(eventLoggerProvider).log(CameraEvents.oomGuard);
    _disposeCamera();
    if (mounted) setState(() {});
  }

  Future<void> _openCamera() async {
    try {
      final session = await ref.read(cameraServiceProvider).open();
      if (!mounted) {
        await session.dispose();
        return;
      }
      if (_flashOn) await session.setFlash(true);
      setState(() {
        _session = session;
        _cameraError = null;
      });
    } catch (e) {
      if (mounted) setState(() => _cameraError = e);
    }
  }

  void _disposeCamera() {
    final session = _session;
    _session = null;
    // Fire-and-forget: soltar el hardware no puede bloquear el hilo de UI
    // (el sistema ya nos está quitando el foco cuando esto corre).
    if (session != null) unawaited(session.dispose());
  }

  Future<void> _shoot() async {
    final session = _session;
    if (session == null || _shooting) return;
    setState(() => _shooting = true);
    final angleKey = _angleKey;
    try {
      unawaited(HapticFeedback.lightImpact());
      final tempPath = await session.takePicture();
      _controller.markCompressing(angleKey);
      // La compresión + cifrado + encolado corren SIN bloquear la cámara:
      // el tile del grid muestra el spinner y el agente sigue al siguiente
      // ángulo (flujo de una mano). Fire-and-forget deliberado — el estado
      // del ángulo (queued/failed) lo reporta el propio pipeline.
      unawaited(_processInBackground(angleKey, tempPath));
      final next = _controller.nextPendingAngle(afterKey: angleKey);
      if (!mounted) return;
      if (next == null) {
        Navigator.of(context).pop();
      } else {
        setState(() => _angleKey = next);
      }
    } catch (_) {
      _controller.markCaptureFailed(angleKey);
    } finally {
      if (mounted) setState(() => _shooting = false);
    }
  }

  Future<void> _processInBackground(String angleKey, String tempPath) async {
    try {
      final photo =
          await ref.read(photoPipelineProvider).process(tempPath);
      await _controller.enqueueCapturedPhoto(
        angleKey: angleKey,
        bytes: photo.bytes,
        msCompress: photo.msCompress,
      );
    } catch (_) {
      _controller.markCaptureFailed(angleKey);
    }
  }

  Future<void> _toggleFlash() async {
    final session = _session;
    if (session == null) return;
    final next = !_flashOn;
    try {
      await session.setFlash(next);
      if (mounted) setState(() => _flashOn = next);
    } catch (_) {}
  }

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    final label = angleLabel(l10n, _angleKey);
    final position = kInspectionAngleKeys.indexOf(_angleKey) + 1;

    return Scaffold(
      backgroundColor: RideTokens.n900,
      body: SafeArea(
        child: Column(
          children: [
            Expanded(
              child: Stack(
                fit: StackFit.expand,
                children: [
                  if (_session != null)
                    _session!.buildPreview()
                  else
                    ColoredBox(
                      color: RideTokens.n900,
                      child: Center(
                        child: _cameraError != null
                            ? Padding(
                                padding: const EdgeInsets.all(24),
                                child: Text(
                                  l10n.genericError,
                                  textAlign: TextAlign.center,
                                  style: const TextStyle(
                                    color: Colors.white,
                                    fontWeight: FontWeight.w600,
                                  ),
                                ),
                              )
                            : const CircularProgressIndicator(
                                color: Colors.white),
                      ),
                    ),
                  // Guía de encuadre honesta (nota 6): esquinas — ayuda de
                  // composición, NO detección automática.
                  const Positioned.fill(
                    child: Padding(
                      padding: EdgeInsets.fromLTRB(28, 90, 28, 120),
                      child: _CornerGuide(),
                    ),
                  ),
                  Positioned(
                    top: 14,
                    left: 0,
                    right: 0,
                    child: Center(
                      child: Container(
                        padding: const EdgeInsets.symmetric(
                            horizontal: 14, vertical: 8),
                        decoration: BoxDecoration(
                          // Plate .85 (contraste ≥5.1:1 medido, nota 5).
                          color: const Color(0xD917122B),
                          borderRadius: BorderRadius.circular(12),
                          border: Border.all(color: const Color(0x2EFFFFFF)),
                        ),
                        child: Text(
                          l10n.camAnglePill(label, position),
                          style: const TextStyle(
                            color: Colors.white,
                            fontSize: 13.5,
                            fontWeight: FontWeight.w800,
                          ),
                        ),
                      ),
                    ),
                  ),
                  Positioned(
                    left: 0,
                    right: 0,
                    bottom: 12,
                    child: Text(
                      isInteriorAngle(_angleKey)
                          ? l10n.camHintInterior
                          : l10n.camHintExterior,
                      textAlign: TextAlign.center,
                      style: const TextStyle(
                        color: Colors.white,
                        fontSize: 13,
                        fontWeight: FontWeight.w700,
                        shadows: [
                          Shadow(color: Colors.black, blurRadius: 3),
                        ],
                      ),
                    ),
                  ),
                ],
              ),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(26, 16, 26, 26),
              child: Row(
                mainAxisAlignment: MainAxisAlignment.spaceBetween,
                children: [
                  _DockButton(
                    icon: _flashOn
                        ? Icons.flash_on_rounded
                        : Icons.flash_off_rounded,
                    label: l10n.camFlash,
                    onTap: _toggleFlash,
                  ),
                  Semantics(
                    button: true,
                    label: l10n.camShutter,
                    onTap: _shoot,
                    child: ExcludeSemantics(
                      child: GestureDetector(
                        onTap: _shoot,
                        // Shutter 76 px (mockup, target DoD #2).
                        child: Container(
                          width: 76,
                          height: 76,
                          decoration: BoxDecoration(
                            shape: BoxShape.circle,
                            color: _shooting
                                ? const Color(0xB3FFFFFF)
                                : Colors.white,
                            border: Border.all(
                              color: const Color(0x59FFFFFF),
                              width: 5,
                            ),
                          ),
                        ),
                      ),
                    ),
                  ),
                  _DockButton(
                    icon: Icons.close_rounded,
                    label: l10n.camClose,
                    onTap: () => Navigator.of(context).pop(),
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _DockButton extends StatelessWidget {
  const _DockButton({
    required this.icon,
    required this.label,
    required this.onTap,
  });

  final IconData icon;
  final String label;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return Semantics(
      button: true,
      label: label,
      onTap: onTap,
      child: ExcludeSemantics(
        child: Material(
          color: const Color(0x1AFFFFFF),
          borderRadius: BorderRadius.circular(18),
          child: InkWell(
            onTap: onTap,
            borderRadius: BorderRadius.circular(18),
            child: Container(
              width: 56,
              height: 56,
              decoration: BoxDecoration(
                borderRadius: BorderRadius.circular(18),
                border: Border.all(color: const Color(0x38FFFFFF)),
              ),
              child: Column(
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  Icon(icon, size: 20, color: Colors.white),
                  const SizedBox(height: 2),
                  Text(
                    label,
                    style: const TextStyle(
                      color: Colors.white,
                      fontSize: 10,
                      fontWeight: FontWeight.w700,
                    ),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _CornerGuide extends StatelessWidget {
  const _CornerGuide();

  @override
  Widget build(BuildContext context) {
    return CustomPaint(painter: _CornerPainter());
  }
}

class _CornerPainter extends CustomPainter {
  @override
  void paint(Canvas canvas, Size size) {
    final paint = Paint()
      ..color = const Color(0xF2FFFFFF)
      ..strokeWidth = 3.5
      ..strokeCap = StrokeCap.round
      ..style = PaintingStyle.stroke;
    const len = 34.0;
    void corner(Offset origin, bool right, bool bottom) {
      final dx = right ? -len : len;
      final dy = bottom ? -len : len;
      canvas.drawLine(origin, origin.translate(dx, 0), paint);
      canvas.drawLine(origin, origin.translate(0, dy), paint);
    }

    corner(Offset.zero, false, false);
    corner(Offset(size.width, 0), true, false);
    corner(Offset(0, size.height), false, true);
    corner(Offset(size.width, size.height), true, true);
  }

  @override
  bool shouldRepaint(covariant CustomPainter oldDelegate) => false;
}
