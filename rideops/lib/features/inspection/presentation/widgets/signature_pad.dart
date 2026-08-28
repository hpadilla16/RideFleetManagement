import 'dart:convert';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';

import '../../../../core/theme/ride_tokens.dart';

/// Lienzo de firma del modo kiosco (6D). Trazo con el dedo, sin presión ni
/// florituras: strokes de polilíneas suavizadas por el propio muestreo del
/// gesto. El export a PNG (fondo blanco, tinta oscura) produce un dataURL
/// que supera de sobra los 200 chars que el backend usa como umbral de
/// "hay firma" (mobile-inspection.service.js:229).
class SignaturePadController extends ChangeNotifier {
  final List<List<Offset>> _strokes = [];
  Size _lastSize = Size.zero;

  bool get hasInk =>
      _strokes.any((s) => s.length > 1); // un tap suelto no es firma

  void startStroke(Offset point) {
    _strokes.add([point]);
    notifyListeners();
  }

  void extendStroke(Offset point) {
    if (_strokes.isEmpty) return;
    _strokes.last.add(point);
    notifyListeners();
  }

  void clear() {
    _strokes.clear();
    notifyListeners();
  }

  /// PNG con la geometría del lienzo real (la última pintada). Devuelve un
  /// dataURL image/png listo para el body del complete.
  Future<String> toPngDataUrl({double pixelRatio = 2.0}) async {
    final size = _lastSize.isEmpty ? const Size(600, 240) : _lastSize;
    final recorder = ui.PictureRecorder();
    final canvas = Canvas(recorder)..scale(pixelRatio);
    canvas.drawRect(
      Offset.zero & size,
      Paint()..color = Colors.white,
    );
    _paintStrokes(canvas);
    final image = await recorder.endRecording().toImage(
          (size.width * pixelRatio).round(),
          (size.height * pixelRatio).round(),
        );
    final bytes = await image.toByteData(format: ui.ImageByteFormat.png);
    image.dispose();
    return 'data:image/png;base64,${base64Encode(bytes!.buffer.asUint8List())}';
  }

  void _paintStrokes(Canvas canvas) {
    final paint = Paint()
      ..color = RideTokens.n900
      ..strokeWidth = 2.5
      ..strokeCap = StrokeCap.round
      ..strokeJoin = StrokeJoin.round
      ..style = PaintingStyle.stroke;
    for (final stroke in _strokes) {
      if (stroke.length == 1) {
        canvas.drawCircle(stroke.first, 1.5, paint..style = PaintingStyle.fill);
        paint.style = PaintingStyle.stroke;
        continue;
      }
      final path = Path()..moveTo(stroke.first.dx, stroke.first.dy);
      for (final p in stroke.skip(1)) {
        path.lineTo(p.dx, p.dy);
      }
      canvas.drawPath(path, paint);
    }
  }
}

class SignaturePad extends StatelessWidget {
  const SignaturePad({super.key, required this.controller, this.hint});

  final SignaturePadController controller;
  final String? hint;

  @override
  Widget build(BuildContext context) {
    return LayoutBuilder(builder: (context, constraints) {
      controller._lastSize =
          Size(constraints.maxWidth, constraints.maxHeight);
      return GestureDetector(
        // Pan inmediato: la firma no puede esperar el slop de un scroll.
        onPanStart: (d) => controller.startStroke(d.localPosition),
        onPanUpdate: (d) => controller.extendStroke(d.localPosition),
        child: Container(
          decoration: BoxDecoration(
            color: RideTokens.n0,
            borderRadius: BorderRadius.circular(22),
            border: Border.all(
              color: RideTokens.n300,
              width: 2,
            ),
          ),
          child: Stack(
            children: [
              Positioned.fill(
                child: AnimatedBuilder(
                  animation: controller,
                  builder: (context, _) => CustomPaint(
                    painter: _SignaturePainter(controller),
                  ),
                ),
              ),
              Positioned(
                left: 26,
                right: 26,
                bottom: 44,
                child: Container(height: 1.5, color: RideTokens.n300),
              ),
              if (hint != null)
                Positioned(
                  left: 0,
                  right: 0,
                  bottom: 18,
                  child: Text(
                    hint!,
                    textAlign: TextAlign.center,
                    style: const TextStyle(
                      fontSize: 12.5,
                      fontWeight: FontWeight.w600,
                      color: RideTokens.n600,
                    ),
                  ),
                ),
            ],
          ),
        ),
      );
    });
  }
}

class _SignaturePainter extends CustomPainter {
  _SignaturePainter(this.controller) : super(repaint: controller);

  final SignaturePadController controller;

  @override
  void paint(Canvas canvas, Size size) => controller._paintStrokes(canvas);

  @override
  bool shouldRepaint(_SignaturePainter oldDelegate) => true;
}
