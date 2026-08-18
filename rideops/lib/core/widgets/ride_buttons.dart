import 'package:flutter/material.dart';

import '../theme/ride_tokens.dart';

/// Botones del design system (mockup v2: .btn-primary / .btn-ghost).
///
/// Nacieron en features/auth (H1) y se promovieron a core/ en el review de
/// H3 (GD MC-4): la pantalla 4D necesitaba el primario real y las features
/// no se importan entre sí (regla del blueprint §1) — dos estilos "primario"
/// paralelos habrían sido deuda instantánea. auth_widgets.dart los
/// re-exporta, así que los imports de H1 siguen funcionando.

/// Botón primario del mockup (56 px, gradiente + glow). [loading] colapsa a
/// spinner + texto de progreso; [onPressed] null = deshabilitado (opacidad
/// .55 como el mockup, y sin ink).
class RidePrimaryButton extends StatelessWidget {
  const RidePrimaryButton({
    super.key,
    required this.label,
    required this.onPressed,
    this.loading = false,
    this.loadingLabel,
  });

  final String label;
  final VoidCallback? onPressed;
  final bool loading;
  final String? loadingLabel;

  @override
  Widget build(BuildContext context) {
    final enabled = onPressed != null && !loading;
    return Opacity(
      opacity: enabled ? 1 : 0.55,
      child: Material(
        color: Colors.transparent,
        child: Ink(
          decoration: BoxDecoration(
            gradient: RideTokens.primaryButtonGradient,
            borderRadius: BorderRadius.circular(18),
            boxShadow: const [
              BoxShadow(
                color: Color(0x598752FE),
                blurRadius: 28,
                offset: Offset(0, 14),
                spreadRadius: -12,
              ),
            ],
          ),
          child: InkWell(
            onTap: enabled ? onPressed : null,
            borderRadius: BorderRadius.circular(18),
            child: Container(
              constraints: const BoxConstraints(minHeight: 56),
              alignment: Alignment.center,
              child: Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  if (loading) ...[
                    const SizedBox(
                      width: 18,
                      height: 18,
                      child: CircularProgressIndicator(
                        strokeWidth: 3,
                        color: Colors.white,
                      ),
                    ),
                    const SizedBox(width: 10),
                  ],
                  Text(
                    loading ? (loadingLabel ?? label) : label,
                    style: const TextStyle(
                      color: Colors.white,
                      fontSize: 16,
                      fontWeight: FontWeight.w800,
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

/// Botón secundario "ghost" (48 px, borde neutro) — p. ej. "Reintentar".
class RideGhostButton extends StatelessWidget {
  const RideGhostButton({
    super.key,
    required this.label,
    required this.onPressed,
  });

  final String label;
  final VoidCallback? onPressed;

  @override
  Widget build(BuildContext context) {
    return Material(
      color: RideTokens.n0,
      borderRadius: BorderRadius.circular(14),
      child: InkWell(
        onTap: onPressed,
        borderRadius: BorderRadius.circular(14),
        child: Container(
          constraints: const BoxConstraints(minHeight: 48),
          alignment: Alignment.center,
          decoration: BoxDecoration(
            border: Border.all(color: RideTokens.n300, width: 1.5),
            borderRadius: BorderRadius.circular(14),
          ),
          child: Text(
            label,
            style: const TextStyle(
              color: RideTokens.n800,
              fontSize: 14.5,
              fontWeight: FontWeight.w800,
            ),
          ),
        ),
      ),
    );
  }
}
