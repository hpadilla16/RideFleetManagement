import 'package:flutter/material.dart';

import '../../../../core/theme/ride_tokens.dart';

/// Piezas compartidas de las pantallas de auth, calcadas del mockup v2:
/// inputs de 54 px con foco AZUL, botón primario de 56 px con gradiente,
/// banners semánticos. Targets ≥ 48 pt en todo lo tocable (DoD #2).

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

/// Botón secundario "ghost" (48 px, borde neutro) — p. ej. "Reintentar ahora".
class RideGhostButton extends StatelessWidget {
  const RideGhostButton({super.key, required this.label, required this.onPressed});

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

enum RideBannerKind { danger, warn, ok }

/// Banner semántico del mockup. [detail] es la línea secundaria opcional para
/// mensajes crudos del backend (el título SIEMPRE va localizado — DoD/ADR-8).
class RideBanner extends StatelessWidget {
  const RideBanner({
    super.key,
    required this.kind,
    required this.text,
    this.detail,
  });

  final RideBannerKind kind;
  final String text;
  final String? detail;

  @override
  Widget build(BuildContext context) {
    final (bg, bd, tx, icon) = switch (kind) {
      RideBannerKind.danger => (
          RideTokens.dangerBg,
          RideTokens.dangerBd,
          RideTokens.dangerTx,
          Icons.error_outline,
        ),
      RideBannerKind.warn => (
          RideTokens.warnBg,
          RideTokens.warnBd,
          RideTokens.warnTx,
          Icons.warning_amber_outlined,
        ),
      RideBannerKind.ok => (
          RideTokens.okBg,
          RideTokens.okBd,
          RideTokens.okTx,
          Icons.check_circle_outline,
        ),
    };
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
      decoration: BoxDecoration(
        color: bg,
        border: Border.all(color: bd),
        borderRadius: BorderRadius.circular(14),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(icon, size: 18, color: tx),
          const SizedBox(width: 10),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  text,
                  style: TextStyle(
                    color: tx,
                    fontSize: 13.5,
                    fontWeight: FontWeight.w600,
                    height: 1.45,
                  ),
                ),
                if (detail != null)
                  Padding(
                    padding: const EdgeInsets.only(top: 4),
                    child: Text(
                      detail!,
                      style: TextStyle(
                        color: tx,
                        fontSize: 12,
                        fontWeight: FontWeight.w500,
                      ),
                    ),
                  ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

/// Etiqueta de campo del mockup (.f-label): mayúsculas, 12 px, gris.
class FieldLabel extends StatelessWidget {
  const FieldLabel(this.text, {super.key});

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

/// Input de 54 px del mockup: borde 1.5, radio 16, foco AZUL con halo, estado
/// de error rojo. El toggle de ojo mide 44 px visuales dentro de un hit-target
/// de 48 (IconButton respeta el mínimo material de 48).
class RideTextField extends StatelessWidget {
  const RideTextField({
    super.key,
    required this.controller,
    this.hasError = false,
    this.obscure = false,
    this.onToggleObscure,
    this.obscureToggleLabel,
    this.keyboardType,
    this.textInputAction,
    this.autofillHints,
    this.onChanged,
    this.onSubmitted,
    this.enabled = true,
  });

  final TextEditingController controller;
  final bool hasError;
  final bool obscure;

  /// Si viene, el campo muestra el ojo de ver/ocultar contraseña.
  final VoidCallback? onToggleObscure;
  final String? obscureToggleLabel;
  final TextInputType? keyboardType;
  final TextInputAction? textInputAction;
  final Iterable<String>? autofillHints;
  final ValueChanged<String>? onChanged;
  final ValueChanged<String>? onSubmitted;
  final bool enabled;

  @override
  Widget build(BuildContext context) {
    OutlineInputBorder border(Color color, [double width = 1.5]) =>
        OutlineInputBorder(
          borderRadius: BorderRadius.circular(16),
          borderSide: BorderSide(color: color, width: width),
        );
    return TextField(
      controller: controller,
      obscureText: obscure,
      enabled: enabled,
      keyboardType: keyboardType,
      textInputAction: textInputAction,
      autofillHints: autofillHints,
      onChanged: onChanged,
      onSubmitted: onSubmitted,
      style: const TextStyle(
        fontSize: 15.5,
        fontWeight: FontWeight.w600,
        color: RideTokens.n900,
      ),
      decoration: InputDecoration(
        filled: true,
        fillColor: hasError ? const Color(0xFFFFFBFB) : RideTokens.n0,
        contentPadding:
            const EdgeInsets.symmetric(horizontal: 14, vertical: 16),
        constraints: const BoxConstraints(minHeight: 54),
        enabledBorder:
            border(hasError ? RideTokens.danger : RideTokens.n300),
        focusedBorder: border(RideTokens.focus, 2),
        disabledBorder: border(RideTokens.n200),
        suffixIcon: onToggleObscure == null
            ? null
            : IconButton(
                onPressed: onToggleObscure,
                tooltip: obscureToggleLabel,
                iconSize: 22,
                color: RideTokens.n600,
                icon: Icon(
                  obscure
                      ? Icons.visibility_outlined
                      : Icons.visibility_off_outlined,
                ),
              ),
      ),
    );
  }
}
