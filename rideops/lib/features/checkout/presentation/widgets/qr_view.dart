import 'package:flutter/material.dart';
import 'package:qr/qr.dart';

/// QR del paso T&C (mockup 10A/10B/10D).
///
/// Se pinta a mano sobre el codificador puro `qr` porque las reglas del código
/// son del sistema de diseño, no de un paquete:
///  - **Negro puro sobre blanco puro (21:1)**: el módulo es el dato; ningún
///    tinte de marca entra aquí. Un QR morado escanea peor bajo el sol.
///  - **Quiet zone de 4 módulos** — es parte del estándar, no margen estético:
///    sin ella muchos lectores no encuentran el patrón de búsqueda.
///  - Los módulos se redondean a píxel entero: medio píxel de módulo produce
///    bordes grises que el lector interpreta como ruido.
///
/// Nivel de corrección M (~15%): el QR vive en una pantalla limpia a 30 cm, no
/// impreso en una calcomanía sucia; subir a Q/H encogería el módulo sin
/// necesidad real. La URL cabe de sobra en versiones bajas.
class QrView extends StatefulWidget {
  const QrView({
    super.key,
    required this.data,
    required this.size,
    this.dead = false,
  });

  /// URL completa (`<web>/sign/<token>`).
  final String data;

  /// Lado del cuadro, incluida la quiet zone.
  final double size;

  /// 10D — código vencido. El QR se atenúa **y deja de ser portador de
  /// información**: el estado lo dicen el pill "Vencido" y el banner. Nunca se
  /// le pide a nadie leer un código a bajo contraste.
  final bool dead;

  @override
  State<QrView> createState() => _QrViewState();
}

class _QrViewState extends State<QrView> {
  late QrImage _image = _encode(widget.data);

  /// Codificar es Reed–Solomon + evaluación de las 8 máscaras: caro para
  /// hacerlo en cada build. La pantalla del paso T&C se reconstruye 1 vez por
  /// segundo (el countdown), así que el código se codifica solo cuando la URL
  /// cambia — o sea, cuando de verdad hay token nuevo.
  static QrImage _encode(String data) => QrImage(
        QrCode(
          payload: QrPayload.fromString(data),
          errorCorrectLevel: QrErrorCorrectLevel.medium,
        ),
      );

  @override
  void didUpdateWidget(QrView oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.data != widget.data) _image = _encode(widget.data);
  }

  @override
  Widget build(BuildContext context) {
    final data = widget.data;
    final size = widget.size;
    final image = _image;
    return Semantics(
      // El QR es para la CÁMARA del cliente; un lector de pantalla no puede
      // hacer nada con la matriz, así que se anuncia lo que significa.
      image: true,
      label: data,
      child: ExcludeSemantics(
        child: Container(
          width: size,
          height: size,
          decoration: BoxDecoration(
            color: Colors.white,
            borderRadius: BorderRadius.circular(12),
          ),
          child: Opacity(
            opacity: widget.dead ? 0.13 : 1,
            child: CustomPaint(
              painter: _QrPainter(image),
              size: Size(size, size),
            ),
          ),
        ),
      ),
    );
  }
}

class _QrPainter extends CustomPainter {
  const _QrPainter(this.image);

  final QrImage image;

  /// Quiet zone del estándar, en módulos.
  static const _quietZone = 4;

  @override
  void paint(Canvas canvas, Size size) {
    final count = image.moduleCount;
    final total = count + _quietZone * 2;
    final raw = size.shortestSide / total;
    // Truncar el módulo a píxel entero y centrar el sobrante: así ningún
    // módulo queda a medio píxel (bordes grises = ruido para el lector).
    final module = raw.floorToDouble().clamp(1.0, raw);
    final drawn = module * total;
    final offset = (size.shortestSide - drawn) / 2 + module * _quietZone;

    final paint = Paint()
      ..color = const Color(0xFF000000)
      ..style = PaintingStyle.fill
      ..isAntiAlias = false;

    for (var row = 0; row < count; row++) {
      for (var col = 0; col < count; col++) {
        if (!image.isDark(row, col)) continue;
        canvas.drawRect(
          Rect.fromLTWH(
            offset + col * module,
            offset + row * module,
            module,
            module,
          ),
          paint,
        );
      }
    }
  }

  @override
  bool shouldRepaint(_QrPainter oldDelegate) =>
      !identical(oldDelegate.image, image);
}
