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

/// Cuánto se espera a que `takePicture()` resuelva antes de declarar colgado
/// el obturador.
///
/// Existe porque se puede colgar PARA SIEMPRE: con GPU por software, el future
/// del plugin nunca resolvió y la pantalla se quedó sin spinner, sin error y
/// sin foto — el agente tocando un botón muerto (corrida e2e 2). No se caza la
/// causa (es del aparato), se caza el SILENCIO.
///
/// 12 s es holgado a propósito: un teléfono de gama media con poca luz puede
/// tardar 2-3 s entre el disparo y el JPEG, y cortar una captura buena por
/// impaciencia sería peor que esperar de más una vez.
const kShutterTimeout = Duration(seconds: 12);

class _CameraCaptureScreenState extends ConsumerState<CameraCaptureScreen>
    with WidgetsBindingObserver {
  InspectionCameraSession? _session;
  Object? _cameraError;

  /// El último error vino de un obturador colgado, no de abrir la cámara. Es
  /// la MISMA pantalla de error con otro título: la salida (reintentar/cerrar)
  /// es idéntica, pero "No se pudo abrir la cámara" sería falso — la cámara
  /// estaba abierta y enseñando la imagen.
  bool _shutterTimedOut = false;
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
        _shutterTimedOut = false;
      });
    } catch (e) {
      if (mounted) {
        setState(() {
          _cameraError = e;
          _shutterTimedOut = false;
        });
      }
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
      // El timeout es la diferencia entre "tarda" y "no va a volver". Sin él
      // un `takePicture()` que nunca resuelve deja `_shooting` en true para
      // siempre: obturador muerto, cero señales, cero salidas.
      final tempPath =
          await session.takePicture().timeout(kShutterTimeout);
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
    } on TimeoutException {
      // El obturador se colgó. Se cuenta (la taxonomía necesita saber en qué
      // aparatos pasa) y se SUELTA EL CONTROLADOR: un plugin que no devolvió
      // la foto no va a devolver la siguiente, así que la recuperación de
      // verdad es abrir la cámara otra vez — que es justo lo que hace el
      // "Reintentar" de la pantalla de error. `dispose` va sin await por
      // contrato (_disposeCamera), no vaya a colgarse también.
      ref.read(eventLoggerProvider).log(CameraEvents.shutterTimeout,
          data: {'timeout_s': kShutterTimeout.inSeconds});
      _controller.markCaptureFailed(angleKey);
      _disposeCamera();
      if (mounted) setState(() => _shutterTimedOut = true);
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

  /// Heurística del permiso denegado: el plugin de cámara reporta
  /// CameraException con code 'CameraAccessDenied*' (Android/iOS).
  static bool _looksLikePermissionError(Object error) {
    final text = error.toString().toLowerCase();
    return text.contains('accessdenied') || text.contains('permission');
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
    // Los dos fallos comparten pantalla porque comparten salida (reintentar /
    // cerrar); lo que NO comparten es el título, y ahí está la honestidad:
    // con el obturador colgado la cámara sí abrió.
    final failed = _cameraError != null || _shutterTimedOut;

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
                        child: failed
                            ? _CameraErrorState(
                                l10n: l10n,
                                timedOut: _shutterTimedOut,
                                permissionDenied: _cameraError != null &&
                                    _looksLikePermissionError(_cameraError!),
                                onRetry: _openCamera,
                                onClose: () => Navigator.of(context).pop(),
                              )
                            : const CircularProgressIndicator(
                                color: Colors.white),
                      ),
                    ),
                  // Guía de encuadre honesta (nota 6): esquinas + silueta
                  // del ángulo al 55 % — ayuda de composición, NO detección
                  // automática (el mockup aprobado la dibuja; decisión PM).
                  if (!failed)
                    Positioned.fill(
                      child: Padding(
                        padding: const EdgeInsets.fromLTRB(28, 90, 28, 120),
                        child: _CornerGuide(angleKey: _angleKey),
                      ),
                    ),
                  // Scrim inferior bajo el hint (review GD): franja oscura
                  // real en vez de confiar solo en text-shadow sobre un
                  // viewport claro.
                  Positioned(
                    left: 0,
                    right: 0,
                    bottom: 0,
                    child: IgnorePointer(
                      child: Container(
                        height: 76,
                        decoration: const BoxDecoration(
                          gradient: LinearGradient(
                            begin: Alignment.bottomCenter,
                            end: Alignment.topCenter,
                            colors: [Color(0xB317122B), Color(0x0017122B)],
                          ),
                        ),
                      ),
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
                          alignment: Alignment.center,
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
                          // Disparo en curso: además del atenuado, MOVIMIENTO.
                          // El atenuado solo dice "algo cambió"; a pleno sol y
                          // con el brazo estirado, lo que separa "está
                          // trabajando" de "no registró el toque" es que gire.
                          // El estado no vive en la animación (el botón ya
                          // ignora toques y hay timeout detrás): esto es
                          // refuerzo, así que con reduced-motion desaparece.
                          child: _shooting &&
                                  !MediaQuery.disableAnimationsOf(context)
                              ? const SizedBox(
                                  width: 28,
                                  height: 28,
                                  child: CircularProgressIndicator(
                                    strokeWidth: 3,
                                    color: RideTokens.p600,
                                  ),
                                )
                              : null,
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

/// Estado de error de cámara con SALIDA (review GD): reintentar siempre, y
/// con permiso denegado la pista de ir a Ajustes — nunca un callejón con
/// solo texto.
class _CameraErrorState extends StatelessWidget {
  const _CameraErrorState({
    required this.l10n,
    required this.permissionDenied,
    required this.onRetry,
    required this.onClose,
    this.timedOut = false,
  });

  final AppLocalizations l10n;
  final bool permissionDenied;
  final Future<void> Function() onRetry;
  final VoidCallback onClose;

  /// El fallo fue el OBTURADOR colgado, no la apertura. Cambia el título y el
  /// cuerpo: la cámara abrió y estuvo enseñando la imagen, así que "No se
  /// pudo abrir la cámara" sería un diagnóstico falso — y el agente que lo
  /// lea va a ir a buscar el permiso que sí tiene.
  final bool timedOut;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.all(24),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Icon(
            timedOut
                ? Icons.hourglass_disabled_rounded
                : Icons.no_photography_outlined,
            size: 40,
            color: Colors.white,
          ),
          const SizedBox(height: 12),
          Text(
            timedOut ? l10n.camShutterStuckTitle : l10n.camErrorTitle,
            textAlign: TextAlign.center,
            style: const TextStyle(
              color: Colors.white,
              fontSize: 16,
              fontWeight: FontWeight.w800,
            ),
          ),
          if (timedOut) ...[
            const SizedBox(height: 8),
            Text(
              l10n.camShutterStuckHint,
              textAlign: TextAlign.center,
              style: const TextStyle(
                color: Color(0xE0FFFFFF),
                fontSize: 13.5,
                fontWeight: FontWeight.w600,
                height: 1.45,
              ),
            ),
          ] else if (permissionDenied) ...[
            const SizedBox(height: 8),
            Text(
              l10n.camErrorPermissionHint,
              textAlign: TextAlign.center,
              style: const TextStyle(
                color: Color(0xE0FFFFFF),
                fontSize: 13.5,
                fontWeight: FontWeight.w600,
                height: 1.45,
              ),
            ),
          ],
          const SizedBox(height: 16),
          _OutlinedLightButton(label: l10n.retryButton, onTap: onRetry),
          const SizedBox(height: 8),
          _OutlinedLightButton(label: l10n.camClose, onTap: onClose),
        ],
      ),
    );
  }
}

class _OutlinedLightButton extends StatelessWidget {
  const _OutlinedLightButton({required this.label, required this.onTap});

  final String label;
  final void Function() onTap;

  @override
  Widget build(BuildContext context) {
    return Material(
      color: const Color(0x1AFFFFFF),
      borderRadius: BorderRadius.circular(14),
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(14),
        child: Container(
          constraints: const BoxConstraints(minHeight: 48),
          alignment: Alignment.center,
          decoration: BoxDecoration(
            border: Border.all(color: const Color(0x59FFFFFF), width: 1.5),
            borderRadius: BorderRadius.circular(14),
          ),
          child: Text(
            label,
            style: const TextStyle(
              color: Colors.white,
              fontSize: 14.5,
              fontWeight: FontWeight.w800,
            ),
          ),
        ),
      ),
    );
  }
}

class _CornerGuide extends StatelessWidget {
  const _CornerGuide({required this.angleKey});

  final String angleKey;

  @override
  Widget build(BuildContext context) {
    return CustomPaint(painter: _CornerPainter(angleKey: angleKey));
  }
}

class _CornerPainter extends CustomPainter {
  _CornerPainter({required this.angleKey});

  final String angleKey;

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

    _paintSilhouette(canvas, size);
  }

  /// Silueta del ángulo al 55 % (nota 6 del mockup / decisión PM): costado
  /// para left/right, frente/atrás para front/rear, glifo de habitáculo
  /// para interiores. Ayuda de composición estilizada — jamás promete
  /// detección.
  void _paintSilhouette(Canvas canvas, Size size) {
    final paint = Paint()
      ..color = const Color(0x8CFFFFFF) // blanco al 55 %
      ..strokeWidth = 2.5
      ..strokeCap = StrokeCap.round
      ..strokeJoin = StrokeJoin.round
      ..style = PaintingStyle.stroke;

    // Caja de diseño 240×110 centrada un poco arriba del medio (el hint y
    // el dock viven abajo).
    const dw = 240.0, dh = 110.0;
    final scale = (size.width * 0.72 / dw).clamp(0.5, 2.0);
    canvas.save();
    canvas.translate(
      (size.width - dw * scale) / 2,
      size.height * 0.44 - (dh * scale) / 2,
    );
    canvas.scale(scale);

    switch (angleKey) {
      case 'left' || 'right':
        // Costado (el path del mockup 6B).
        final body = Path()
          ..moveTo(18, 78)
          ..cubicTo(22, 60, 38, 48, 62, 44)
          ..lineTo(88, 26)
          ..cubicTo(96, 21, 104, 19, 118, 19)
          ..lineTo(156, 19)
          ..cubicTo(178, 19, 200, 29, 214, 44)
          ..lineTo(222, 54)
          ..cubicTo(230, 56, 234, 62, 234, 70)
          ..lineTo(234, 78)
          ..lineTo(218, 78);
        canvas.drawPath(body, paint);
        canvas.drawCircle(const Offset(62, 82), 15, paint);
        canvas.drawCircle(const Offset(182, 82), 15, paint);
        canvas.drawLine(const Offset(77, 82), const Offset(167, 82), paint);
      case 'front' || 'rear':
        // Frente/atrás: capó + parabrisas + faros/llantas.
        final front = Path()
          ..moveTo(40, 90)
          ..lineTo(40, 62)
          ..cubicTo(40, 50, 48, 42, 60, 40)
          ..lineTo(76, 18)
          ..cubicTo(80, 13, 86, 10, 94, 10)
          ..lineTo(146, 10)
          ..cubicTo(154, 10, 160, 13, 164, 18)
          ..lineTo(180, 40)
          ..cubicTo(192, 42, 200, 50, 200, 62)
          ..lineTo(200, 90);
        canvas.drawPath(front, paint);
        canvas.drawLine(const Offset(84, 40), const Offset(156, 40), paint);
        canvas.drawOval(
            const Rect.fromLTWH(52, 58, 28, 12), paint); // faro izq
        canvas.drawOval(
            const Rect.fromLTWH(160, 58, 28, 12), paint); // faro der
        canvas.drawLine(const Offset(46, 96), const Offset(76, 96), paint);
        canvas.drawLine(const Offset(164, 96), const Offset(194, 96), paint);
      default:
        // Interior (asientos/tablero/cajuela): marco redondeado + asiento.
        canvas.drawRRect(
          RRect.fromRectAndRadius(
            const Rect.fromLTWH(50, 10, 140, 90),
            const Radius.circular(16),
          ),
          paint,
        );
        final seat = Path()
          ..moveTo(96, 78)
          ..lineTo(96, 40)
          ..cubicTo(96, 30, 104, 26, 112, 28)
          ..lineTo(120, 30)
          ..cubicTo(126, 32, 128, 38, 128, 44)
          ..lineTo(128, 64)
          ..cubicTo(140, 66, 146, 70, 146, 78)
          ..close();
        canvas.drawPath(seat, paint);
    }
    canvas.restore();
  }

  @override
  bool shouldRepaint(covariant _CornerPainter oldDelegate) =>
      oldDelegate.angleKey != angleKey;
}
