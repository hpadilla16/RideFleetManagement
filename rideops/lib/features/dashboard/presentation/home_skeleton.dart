import 'package:flutter/material.dart';

import '../../../core/l10n/app_localizations.dart';
import '../../../core/theme/ride_tokens.dart';

/// Skeleton del home (mockups 4E/5C): replica la geometría REAL de la home
/// H4 (fila de frescura, hero alto + 2 tiles, label de cola, 2 cards) con
/// shimmer de 1.4 s — sin huesos de saludo que la pantalla no tiene, para
/// que el primer load no salte (GD S-6, review H4). Se muestra SOLO en el
/// primer load / sesión degradada — los refrescos por polling son
/// silenciosos (nota 9 del mockup).
///
/// El shimmer es un pulso de opacidad (no un gradiente que barre): mismo
/// efecto percibido, sin ShaderMask por frame en gama media. Con
/// reduced-motion (MediaQuery.disableAnimations) queda estático.
class HomeSkeleton extends StatefulWidget {
  const HomeSkeleton({super.key});

  @override
  State<HomeSkeleton> createState() => _HomeSkeletonState();
}

class _HomeSkeletonState extends State<HomeSkeleton>
    with SingleTickerProviderStateMixin {
  late final AnimationController _controller = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 1400),
  );

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    final reduceMotion = MediaQuery.of(context).disableAnimations;
    if (reduceMotion) {
      _controller.stop();
    } else if (!_controller.isAnimating) {
      _controller.repeat(reverse: true);
    }
    return Semantics(
      label: l10n.loadingLabel,
      child: ExcludeSemantics(
        child: FadeTransition(
          opacity: reduceMotion
              ? const AlwaysStoppedAnimation(1)
              : Tween<double>(begin: 1, end: 0.55).animate(
                  CurvedAnimation(
                    parent: _controller,
                    curve: Curves.easeInOut,
                  ),
                ),
          child: SafeArea(
            // Scroll sin física: en pantallas cortas el esqueleto se recorta
            // en vez de desbordar (los huesos no son contenido que leer).
            child: SingleChildScrollView(
              physics: const NeverScrollableScrollPhysics(),
              padding: const EdgeInsets.fromLTRB(16, 12, 16, 88),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  // Fila de frescura (200×14, geometría del 5C) — lo primero
                  // que la home real pinta en su lugar.
                  const _Bone(width: 200, height: 14),
                  const SizedBox(height: 16),
                  // Bento: hero alto + 2 tiles apilados (geometría de 4E).
                  SizedBox(
                    height: 150,
                    child: Row(
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: [
                        const Expanded(child: _Bone(height: 150, radius: 20)),
                        const SizedBox(width: 10),
                        Expanded(
                          child: Column(
                            children: const [
                              Expanded(child: _Bone(radius: 20)),
                              SizedBox(height: 10),
                              Expanded(child: _Bone(radius: 20)),
                            ],
                          ),
                        ),
                      ],
                    ),
                  ),
                  const SizedBox(height: 16),
                  const _Bone(width: 120, height: 12),
                  const SizedBox(height: 10),
                  const _Bone(height: 70, radius: 20),
                  const SizedBox(height: 10),
                  const _Bone(height: 70, radius: 20),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _Bone extends StatelessWidget {
  const _Bone({this.width, this.height, this.radius = 8});

  final double? width;
  final double? height;
  final double radius;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: width,
      height: height,
      decoration: BoxDecoration(
        color: RideTokens.n200,
        borderRadius: BorderRadius.circular(radius),
      ),
    );
  }
}
