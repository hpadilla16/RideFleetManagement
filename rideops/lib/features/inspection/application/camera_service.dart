import 'package:camera/camera.dart';
import 'package:flutter/widgets.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

/// Abstracción de la cámara (H5). Inyectable a propósito:
///  - la cámara REAL no existe en unit/widget tests — los tests usan un
///    fake (test/helpers) y la prueba física en aparato real queda declarada
///    para H6 (junto con WorkManager);
///  - el contrato del pipeline (UN controlador por SESIÓN de captura, no por
///    foto; dispose en inactive; recrear en resumed) vive aquí y no
///    regado por la UI.
abstract class InspectionCameraService {
  /// Abre la cámara trasera en [ResolutionPreset.high]. Lanza si el aparato
  /// no tiene cámara utilizable — la pantalla lo muestra como error honesto.
  Future<InspectionCameraSession> open();
}

/// UNA sesión de captura = un controlador vivo. La pantalla lo crea al
/// entrar, lo mata en [AppLifecycleState.inactive]/al salir y lo recrea en
/// resumed (DoD #8: gama media + controlador vivo de fondo = OOM).
abstract class InspectionCameraSession {
  Widget buildPreview();

  /// Toma la foto y devuelve el path del JPEG temporal SIN comprimir. El
  /// caller DEBE pasarlo por el pipeline (comprimir → cifrar → borrar temp)
  /// inmediatamente.
  Future<String> takePicture();

  Future<void> setFlash(bool enabled);

  Future<void> dispose();

  bool get isDisposed;
}

class RealInspectionCameraService implements InspectionCameraService {
  @override
  Future<InspectionCameraSession> open() async {
    final cameras = await availableCameras();
    final back = cameras.firstWhere(
      (c) => c.lensDirection == CameraLensDirection.back,
      orElse: () {
        if (cameras.isEmpty) {
          throw StateError('no camera available');
        }
        return cameras.first;
      },
    );
    final controller = CameraController(
      back,
      // high (~1080p): suficiente para el lado largo de 2048 tras comprimir;
      // max/ultraHigh solo infla el buffer que vamos a tirar.
      ResolutionPreset.high,
      enableAudio: false,
      imageFormatGroup: ImageFormatGroup.jpeg,
    );
    await controller.initialize();
    return _RealSession(controller);
  }
}

class _RealSession implements InspectionCameraSession {
  _RealSession(this._controller);

  final CameraController _controller;
  bool _disposed = false;

  @override
  Widget buildPreview() => CameraPreview(_controller);

  @override
  Future<String> takePicture() async {
    final file = await _controller.takePicture();
    return file.path;
  }

  @override
  Future<void> setFlash(bool enabled) =>
      _controller.setFlashMode(enabled ? FlashMode.torch : FlashMode.off);

  @override
  Future<void> dispose() async {
    if (_disposed) return;
    _disposed = true;
    await _controller.dispose();
  }

  @override
  bool get isDisposed => _disposed;
}

final Provider<InspectionCameraService> cameraServiceProvider =
    Provider<InspectionCameraService>((ref) => RealInspectionCameraService());
