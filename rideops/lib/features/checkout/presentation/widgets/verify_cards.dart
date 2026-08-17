import 'package:flutter/material.dart';

import '../../../../core/theme/ride_tokens.dart';

/// Primitivas de las tarjetas de verificación del wizard (mockup 9A-9E, 10C).
///
/// Verificar es LEER, no teclear (nota 1): filas clave-valor de 13.5 px con la
/// clave en n700 (9.02:1) y el valor en n900 negrita (17.74:1), legibles de un
/// vistazo con el sol de frente mientras el agente compara la pantalla con la
/// licencia física. Ninguna de estas piezas decide nada: reciben lo que el
/// servidor reportó.

/// Tono semántico de una tarjeta y de su pill.
enum VerifyTone { ok, bad, neutral }

/// Tarjeta con encabezado + pill de estado.
class VerifyCard extends StatelessWidget {
  const VerifyCard({
    super.key,
    required this.title,
    required this.children,
    this.pillLabel,
    this.tone = VerifyTone.neutral,
  });

  final String title;
  final String? pillLabel;
  final VerifyTone tone;
  final List<Widget> children;

  @override
  Widget build(BuildContext context) {
    // El borde rojo de la tarjeta en conflicto es REFUERZO: el estado ya lo
    // dicen el pill y la fila con su motivo. El color nunca es el único
    // portador (DoD #2).
    final borderColor =
        tone == VerifyTone.bad ? RideTokens.dangerBd : RideTokens.n200;
    return Container(
      padding: const EdgeInsets.fromLTRB(13, 12, 13, 12),
      decoration: BoxDecoration(
        color: RideTokens.n0,
        borderRadius: BorderRadius.circular(20),
        border: Border.all(
          color: borderColor,
          width: tone == VerifyTone.bad ? 1.5 : 1,
        ),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: [
          Row(
            children: [
              Expanded(
                child: Text(
                  title,
                  style: const TextStyle(
                    fontSize: 14,
                    fontWeight: FontWeight.w900,
                    color: RideTokens.n900,
                  ),
                ),
              ),
              if (pillLabel != null) VerifyPill(label: pillLabel!, tone: tone),
            ],
          ),
          const SizedBox(height: 4),
          ...children,
        ],
      ),
    );
  }
}

/// Pill de estado. Siempre lleva PALABRA: "Verificado" / "Faltan datos" /
/// "En conflicto" — el color solo no puede portar el estado.
class VerifyPill extends StatelessWidget {
  const VerifyPill({super.key, required this.label, required this.tone});

  final String label;
  final VerifyTone tone;

  @override
  Widget build(BuildContext context) {
    final (bg, fg) = switch (tone) {
      VerifyTone.ok => (RideTokens.okBg, RideTokens.okTx), // 6.19:1
      VerifyTone.bad => (RideTokens.dangerBg, RideTokens.dangerTx), // 7.04:1
      VerifyTone.neutral => (RideTokens.n100, RideTokens.n800),
    };
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 4),
      decoration: BoxDecoration(
        color: bg,
        borderRadius: BorderRadius.circular(9),
      ),
      child: Text(
        label,
        style: TextStyle(
          fontSize: 11.5,
          fontWeight: FontWeight.w900,
          color: fg,
        ),
      ),
    );
  }
}

/// Fila clave-valor. [missing] pinta el valor en danger CON su palabra ("Sin
/// capturar"), nunca un hueco: un dato ausente que se ve como vacío parece un
/// error de carga.
class KvRow extends StatelessWidget {
  const KvRow({
    super.key,
    required this.label,
    required this.value,
    this.missing = false,
    this.tabular = false,
  });

  final String label;
  final String value;
  final bool missing;
  final bool tabular;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 5),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SizedBox(
            width: 104,
            child: Text(
              label,
              style: const TextStyle(
                fontSize: 13.5,
                fontWeight: FontWeight.w700,
                color: RideTokens.n700,
              ),
            ),
          ),
          const SizedBox(width: 8),
          Expanded(
            child: Text(
              value,
              style: TextStyle(
                fontSize: 13.5,
                fontWeight: FontWeight.w800,
                color: missing ? RideTokens.dangerTx : RideTokens.n900,
                fontFeatures: tabular
                    ? const [FontFeature.tabularFigures()]
                    : null,
              ),
            ),
          ),
        ],
      ),
    );
  }
}

/// Enlace de acción dentro de una tarjeta ("Cambiar vehículo"). 48 px de alto
/// con padding real: un enlace del ancho exacto de su texto se falla con
/// guantes (misma regla que `BannerAction`).
class CardLink extends StatelessWidget {
  const CardLink({
    super.key,
    required this.label,
    required this.onTap,
    this.icon = Icons.chevron_right_rounded,
  });

  final String label;
  final VoidCallback? onTap;
  final IconData icon;

  @override
  Widget build(BuildContext context) {
    final color = onTap == null ? RideTokens.n600 : RideTokens.p700;
    return Align(
      alignment: Alignment.centerLeft,
      child: Material(
        color: Colors.transparent,
        borderRadius: BorderRadius.circular(12),
        child: InkWell(
          onTap: onTap,
          borderRadius: BorderRadius.circular(12),
          child: Container(
            constraints: const BoxConstraints(minHeight: 48),
            padding: const EdgeInsets.symmetric(horizontal: 8),
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(
                  label,
                  style: TextStyle(
                    fontSize: 13.5,
                    fontWeight: FontWeight.w900,
                    color: color,
                  ),
                ),
                Icon(icon, size: 18, color: color),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// Fila-switch del seguro declinado (9A/9C).
///
/// Switch y no checkbox perdido: 56 px de alto y el estado EN PALABRAS
/// ("Apagado · se cobra la cobertura estándar"), porque el color solo no puede
/// portarlo. Encendida, la fila usa el ámbar como SUPERFICIE (n900 sobre
/// warnBg = 16.49:1).
class DeclineSwitchRow extends StatelessWidget {
  const DeclineSwitchRow({
    super.key,
    required this.title,
    required this.subtitle,
    required this.value,
    required this.onChanged,
    this.busy = false,
  });

  final String title;
  final String subtitle;
  final bool value;

  /// null = deshabilitado. La causa la escribe quien lo llama en [subtitle]:
  /// deshabilitar sin decir por qué es lo que esta app no hace.
  final ValueChanged<bool>? onChanged;
  final bool busy;

  @override
  Widget build(BuildContext context) {
    return Semantics(
      toggled: value,
      enabled: onChanged != null,
      label: title,
      hint: subtitle,
      child: ExcludeSemantics(
        child: Container(
          constraints: const BoxConstraints(minHeight: 56),
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
          decoration: BoxDecoration(
            color: value ? RideTokens.warnBg : RideTokens.n0,
            borderRadius: BorderRadius.circular(16),
            border: Border.all(
              color: value ? RideTokens.warnBd : RideTokens.n200,
            ),
          ),
          child: Row(
            children: [
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Text(
                      title,
                      style: const TextStyle(
                        fontSize: 13.5,
                        fontWeight: FontWeight.w900,
                        color: RideTokens.n900,
                      ),
                    ),
                    Text(
                      subtitle,
                      style: const TextStyle(
                        fontSize: 12.5,
                        fontWeight: FontWeight.w700,
                        color: RideTokens.n700,
                      ),
                    ),
                  ],
                ),
              ),
              const SizedBox(width: 10),
              if (busy)
                const SizedBox(
                  width: 22,
                  height: 22,
                  child: CircularProgressIndicator(
                    strokeWidth: 2.5,
                    color: RideTokens.p600,
                  ),
                )
              else
                Switch(
                  value: value,
                  onChanged: onChanged,
                  // El riel encendido usa warnTx (#8A5606) como SUPERFICIE —
                  // misma decisión que el badge ámbar de la Tanda B: ≥3:1
                  // contra el fondo de la fila, sin inventar token nuevo.
                  activeThumbColor: RideTokens.n0,
                  activeTrackColor: RideTokens.warnTx,
                  inactiveThumbColor: RideTokens.n0,
                  inactiveTrackColor: RideTokens.n400,
                ),
            ],
          ),
        ),
      ),
    );
  }
}
