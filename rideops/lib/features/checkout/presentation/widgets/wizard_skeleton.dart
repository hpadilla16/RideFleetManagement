import 'package:flutter/material.dart';

import '../../../../core/l10n/app_localizations.dart';
import '../../../../core/theme/ride_tokens.dart';

/// 8F — loading del shell: la GEOMETRÍA REAL del wizard (header de sesión con
/// dos filas, rail de 5 nodos, cuerpo con dos tarjetas y dock), no un spinner
/// centrado. Así el primer fetch no hace saltar la pantalla cuando llega el
/// dato.
///
/// Mismo shimmer que el skeleton del home: pulso de opacidad, no un gradiente
/// que barre — mismo efecto percibido sin un ShaderMask por frame en gama
/// media. Con reduced-motion queda estático.
class WizardSkeleton extends StatefulWidget {
  const WizardSkeleton({super.key});

  @override
  State<WizardSkeleton> createState() => _WizardSkeletonState();
}

class _WizardSkeletonState extends State<WizardSkeleton>
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
                  CurvedAnimation(parent: _controller, curve: Curves.easeInOut),
                ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              // Header de sesión (dos filas: cliente + vehículo)
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 11),
                color: RideTokens.tonal,
                child: Column(
                  children: [
                    _bone(height: 38, width: 38, radius: 13, row: true),
                    const SizedBox(height: 9),
                    _bone(height: 38, width: 38, radius: 13, row: true),
                  ],
                ),
              ),
              // Rail de 5 fases
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 9),
                color: RideTokens.n0,
                child: Row(
                  children: [
                    for (var i = 0; i < 5; i++)
                      const Expanded(
                        child: Column(
                          children: [
                            _Bone(height: 24, width: 24, radius: 12),
                            SizedBox(height: 4),
                            _Bone(height: 9, width: 40, radius: 4),
                          ],
                        ),
                      ),
                  ],
                ),
              ),
              // Cuerpo: label + dos tarjetas + dock
              Expanded(
                child: Container(
                  color: RideTokens.n50,
                  padding: const EdgeInsets.fromLTRB(14, 14, 14, 14),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: const [
                      _Bone(height: 13, width: 150, radius: 6),
                      SizedBox(height: 12),
                      _Bone(height: 104, radius: 20),
                      SizedBox(height: 10),
                      _Bone(height: 78, radius: 20),
                      Spacer(),
                      _Bone(height: 56, radius: 18),
                    ],
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _bone({
    required double height,
    required double width,
    required double radius,
    bool row = false,
  }) {
    if (!row) return _Bone(height: height, width: width, radius: radius);
    return Row(
      children: [
        _Bone(height: height, width: width, radius: radius),
        const SizedBox(width: 10),
        const Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              _Bone(height: 15, width: 150, radius: 6),
              SizedBox(height: 6),
              _Bone(height: 11, width: 190, radius: 6),
            ],
          ),
        ),
      ],
    );
  }
}

class _Bone extends StatelessWidget {
  const _Bone({required this.height, this.width, required this.radius});

  final double height;
  final double? width;
  final double radius;

  @override
  Widget build(BuildContext context) {
    return Container(
      height: height,
      width: width,
      decoration: BoxDecoration(
        color: RideTokens.n200,
        borderRadius: BorderRadius.circular(radius),
      ),
    );
  }
}
