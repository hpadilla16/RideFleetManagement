import 'package:flutter/material.dart';

import '../../../../core/l10n/app_localizations.dart';
import '../../../../core/theme/ride_tokens.dart';

/// Piezas del PIN calcadas del mockup v2 pantalla 3 (3A/3B): dots de 17 px y
/// keypad neumórfico SUTIL — teclas de 64 px, radio 20, gradiente
/// blanco→tonal, y borde n300 SIEMPRE (regla del sistema: elevation = border
/// + shadow, nunca sombra sola; a pleno sol la sombra se lava y el borde
/// delimita la tecla). Targets ≥ 48 pt de sobra (DoD #2).

const pinLength = 4;

/// Los 4 dots del PIN. [error] pinta el grupo en rojo (estado 3B); el pulso
/// animado del mockup se omite — regla de la casa: nada de animaciones
/// infinitas (cuelgan pumpAndSettle y distraen bajo el sol).
class PinDots extends StatelessWidget {
  const PinDots({super.key, required this.filled, this.error = false});

  final int filled;
  final bool error;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    return Semantics(
      label: l10n.pinDigitsProgress(filled),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          for (var i = 0; i < pinLength; i++) ...[
            if (i > 0) const SizedBox(width: 18),
            _Dot(filled: i < filled, error: error),
          ],
        ],
      ),
    );
  }
}

class _Dot extends StatelessWidget {
  const _Dot({required this.filled, required this.error});

  final bool filled;
  final bool error;

  @override
  Widget build(BuildContext context) {
    final Color fill;
    final Color border;
    if (error) {
      fill = RideTokens.danger;
      border = RideTokens.danger;
    } else if (filled) {
      fill = RideTokens.p600;
      border = RideTokens.p600;
    } else {
      fill = RideTokens.n0;
      border = RideTokens.n400;
    }
    return Container(
      width: 17,
      height: 17,
      decoration: BoxDecoration(
        shape: BoxShape.circle,
        color: fill,
        border: Border.all(color: border, width: 2),
      ),
    );
  }
}

/// Keypad 3×4 del mockup: 1-9, [huella|hueco], 0, borrar. La huella es una
/// TECLA más (anotación 4: un toque, cero modales) — [onBiometric] null la
/// esconde y deja el hueco, exactamente como el frame 3A.
class PinKeypad extends StatelessWidget {
  const PinKeypad({
    super.key,
    required this.onDigit,
    required this.onBackspace,
    this.onBiometric,
  });

  final ValueChanged<String> onDigit;
  final VoidCallback onBackspace;
  final VoidCallback? onBiometric;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    Widget digit(String d) => _Key(
          onTap: () => onDigit(d),
          semanticsLabel: d,
          child: Text(
            d,
            style: const TextStyle(
              fontSize: 24,
              fontWeight: FontWeight.w700,
              color: RideTokens.n900,
            ),
          ),
        );
    final corner = onBiometric == null
        ? const SizedBox.expand()
        : _Key(
            onTap: onBiometric,
            kind: _KeyKind.bio,
            semanticsLabel: l10n.pinBioKeyLabel,
            child: const Icon(
              Icons.fingerprint,
              size: 30,
              color: RideTokens.p700,
            ),
          );
    final rows = <List<Widget>>[
      [digit('1'), digit('2'), digit('3')],
      [digit('4'), digit('5'), digit('6')],
      [digit('7'), digit('8'), digit('9')],
      [
        corner,
        digit('0'),
        _Key(
          onTap: onBackspace,
          kind: _KeyKind.util,
          semanticsLabel: l10n.keypadDeleteLabel,
          child: const Icon(
            Icons.backspace_outlined,
            size: 22,
            color: RideTokens.n700,
          ),
        ),
      ],
    ];
    return Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        for (final (r, row) in rows.indexed) ...[
          if (r > 0) const SizedBox(height: 12),
          Row(
            children: [
              for (final (c, key) in row.indexed) ...[
                if (c > 0) const SizedBox(width: 12),
                Expanded(child: SizedBox(height: 64, child: key)),
              ],
            ],
          ),
        ],
      ],
    );
  }
}

enum _KeyKind { digit, util, bio }

class _Key extends StatelessWidget {
  const _Key({
    required this.onTap,
    required this.child,
    required this.semanticsLabel,
    this.kind = _KeyKind.digit,
  });

  final VoidCallback? onTap;
  final Widget child;
  final String semanticsLabel;
  final _KeyKind kind;

  @override
  Widget build(BuildContext context) {
    final (gradient, border) = switch (kind) {
      _KeyKind.digit => (
        const [RideTokens.n0, Color(0xFFF7F3FF)],
        RideTokens.n300,
      ),
      _KeyKind.util => ([RideTokens.n50, RideTokens.n100], RideTokens.n300),
      _KeyKind.bio => (
        const [Color(0xFFF8F4FF), RideTokens.p100],
        RideTokens.p300,
      ),
    };
    return Semantics(
      button: true,
      label: semanticsLabel,
      child: Material(
        color: Colors.transparent,
        child: Ink(
          decoration: BoxDecoration(
            gradient: LinearGradient(
              begin: Alignment.topCenter,
              end: Alignment.bottomCenter,
              colors: gradient,
            ),
            borderRadius: BorderRadius.circular(20),
            border: Border.all(color: border),
            boxShadow: const [
              BoxShadow(
                color: Color(0x2445189E),
                blurRadius: 6,
                offset: Offset(0, 3),
                spreadRadius: -2,
              ),
              BoxShadow(
                color: Color(0x388752FE),
                blurRadius: 18,
                offset: Offset(0, 10),
                spreadRadius: -10,
              ),
            ],
          ),
          child: InkWell(
            onTap: onTap,
            borderRadius: BorderRadius.circular(20),
            child: Center(child: ExcludeSemantics(child: child)),
          ),
        ),
      ),
    );
  }
}
