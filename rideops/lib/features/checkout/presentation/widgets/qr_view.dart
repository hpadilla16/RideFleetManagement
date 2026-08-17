import 'package:flutter/material.dart';
import 'package:qr/qr.dart';

import '../../../../core/theme/ride_tokens.dart';

/// QR del paso T&C (mockup 10A/10B/10D).
///
/// Se pinta a mano sobre el codificador puro `qr` porque las reglas del código
/// son del sistema de diseño, no de un paquete:
///  - **Negro puro sobre blanco puro (21:1)**: el módulo es el dato; ningún
///    tinte de marca entra aquí. Un QR morado escanea peor bajo el sol.
///  - **Quiet zone de 4 módulos** — es parte del estándar, no margen estético:
///    sin ella muchos lectores no encuentran el patrón de búsqueda. Va POR
///    FUERA del lado pedido (ver [size]).
///  - Los módulos se alinean a píxel FÍSICO entero: medio píxel de módulo
///    produce bordes grises que el lector interpreta como ruido.
///
/// Nivel de corrección M (~15%): el QR vive en una pantalla limpia a 30 cm, no
/// impreso en una calcomanía sucia; subir a Q/H encogería el módulo sin
/// necesidad real. La URL cabe de sobra en versiones bajas.
class QrView extends StatefulWidget {
  const QrView({
    super.key,
    required this.data,
    required this.size,
    required this.semanticsLabel,
    this.dead = false,
  });

  /// URL completa (`<web>/sign/<token>`).
  final String data;

  /// Lado del **SÍMBOLO**, sin la quiet zone (review GD-MC-1).
  ///
  /// Antes este parámetro describía el cuadro COMPLETO y la quiet zone se
  /// comía 8 de los N+8 módulos por dentro: con 29–37 módulos, un `size: 230`
  /// producía un símbolo real de ~165–185 dp — **20-28% menos de lo aprobado**,
  /// en la única pantalla que ve el cliente. Como el alcance de lectura es de
  /// ~10× el lado del símbolo, esos 45 dp perdidos son medio metro de distancia
  /// de escaneo. Ahora el widget MIDE `size + 8·módulo`: el símbolo conserva el
  /// lado aprobado y la quiet zone crece hacia afuera.
  final double size;

  /// Etiqueta para lectores de pantalla. **Obligatoria y traducida**: aquí
  /// vivía la URL firmada COMPLETA, o sea que TalkBack leía el token en voz
  /// alta — y ese token es una credencial al portador (review GD-SC-8 /
  /// INN-S-4). Además, dictar 120 caracteres de URL no le sirve a nadie.
  final String semanticsLabel;

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
    final image = _image;
    final metrics = QrMetrics.resolve(
      symbolSide: widget.size,
      moduleCount: image.moduleCount,
      devicePixelRatio: MediaQuery.maybeDevicePixelRatioOf(context) ?? 1,
    );
    return Semantics(
      // El QR es para la CÁMARA del cliente; un lector de pantalla no puede
      // hacer nada con la matriz, así que se anuncia lo que significa —
      // jamás la URL, que lleva el token dentro.
      image: true,
      label: widget.semanticsLabel,
      child: ExcludeSemantics(
        child: Container(
          // La quiet zone ES este padding: 4 módulos de blanco por fuera del
          // símbolo, como manda el estándar.
          width: metrics.total,
          height: metrics.total,
          decoration: BoxDecoration(
            color: Colors.white,
            borderRadius: BorderRadius.circular(12),
          ),
          alignment: Alignment.center,
          child: Opacity(
            opacity: widget.dead ? 0.13 : 1,
            child: SizedBox(
              width: metrics.symbol,
              height: metrics.symbol,
              child: CustomPaint(
                painter: _QrPainter(image, metrics.module),
                size: Size(metrics.symbol, metrics.symbol),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// Geometría resuelta del código. Pública y pura para que la prueba pueda
/// fijar el tamaño del **símbolo** (que es lo que se escanea) y no el del
/// contenedor.
@immutable
class QrMetrics {
  const QrMetrics({
    required this.module,
    required this.symbol,
    required this.total,
  });

  /// Lado de un módulo, en dp.
  final double module;

  /// Lado del símbolo (`module × moduleCount`).
  final double symbol;

  /// Lado del cuadro completo (`symbol + 8 × module`).
  final double total;

  /// Quiet zone del estándar, en módulos POR LADO.
  static const quietZoneModules = 4;

  /// [symbolSide] es lo que el diseño aprobó para el SÍMBOLO.
  ///
  /// El módulo se trunca a píxel **físico** entero (no lógico): en un teléfono
  /// de 3× truncar a dp regalaba hasta 3 dp por módulo — ~12% del símbolo — sin
  /// comprar nada, porque lo que el rasterizador alinea son píxeles físicos.
  /// Con el snap correcto la pérdida queda por debajo del 4%.
  static QrMetrics resolve({
    required double symbolSide,
    required int moduleCount,
    required double devicePixelRatio,
  }) {
    final dpr = devicePixelRatio <= 0 ? 1.0 : devicePixelRatio;
    final ideal = symbolSide / moduleCount;
    final snapped = (ideal * dpr).floorToDouble() / dpr;
    // Nunca por debajo de un píxel físico: un módulo de 0 dp no se ve.
    final module = snapped < 1 / dpr ? 1 / dpr : snapped;
    final symbol = module * moduleCount;
    return QrMetrics(
      module: module,
      symbol: symbol,
      total: symbol + module * quietZoneModules * 2,
    );
  }
}

/// Marco del QR (review GD-SC-2). 10A lo tenía vía su panel y 10B no: bajo
/// reflejo, el marco es lo que le dice al cliente DÓNDE apuntar la cámara, así
/// que los dos lo comparten desde aquí en vez de que cada pantalla dibuje el
/// suyo.
class QrFrame extends StatelessWidget {
  const QrFrame({super.key, required this.child});

  final Widget child;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: RideTokens.n0,
        borderRadius: BorderRadius.circular(20),
        border: Border.all(color: RideTokens.n300, width: 1.5),
      ),
      child: child,
    );
  }
}

class _QrPainter extends CustomPainter {
  const _QrPainter(this.image, this.module);

  final QrImage image;

  /// Lado del módulo ya resuelto por [QrMetrics]: el painter no vuelve a
  /// calcularlo para que lo pintado y lo medido no puedan divergir.
  final double module;

  @override
  void paint(Canvas canvas, Size size) {
    final count = image.moduleCount;
    final paint = Paint()
      ..color = const Color(0xFF000000)
      ..style = PaintingStyle.fill
      ..isAntiAlias = false;

    for (var row = 0; row < count; row++) {
      for (var col = 0; col < count; col++) {
        if (!image.isDark(row, col)) continue;
        canvas.drawRect(
          Rect.fromLTWH(col * module, row * module, module, module),
          paint,
        );
      }
    }
  }

  @override
  bool shouldRepaint(_QrPainter oldDelegate) =>
      !identical(oldDelegate.image, image) || oldDelegate.module != module;
}
