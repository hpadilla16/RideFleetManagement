import 'package:flutter/material.dart';
import 'package:intl/intl.dart';

import '../../../../core/l10n/app_localizations.dart';
import '../../../../core/theme/ride_tokens.dart';
import '../../application/inspection_state.dart';
import 'angle_labels.dart';

/// Grid 2×4 de los 8 ángulos (mockup 6A): tiles ≥96 px, obligatorios con
/// chip ámbar, miniatura con scrim .85 bajo el texto (regla del sistema:
/// nunca texto sobre imagen sin plate/scrim medido).
class AngleGrid extends StatelessWidget {
  const AngleGrid({
    super.key,
    required this.angles,
    required this.onTapAngle,
    this.deadAngles = const {},
  });

  final Map<String, AngleUi> angles;
  final void Function(String angleKey) onTapAngle;

  /// Ángulos cuya fila MURIÓ en la bandeja (M2-H4, frame 17E). No es un
  /// estado de captura —la foto se tomó bien— sino de entrega: el tile lo
  /// dice con palabras ("No llegó al servidor") además del color, porque de
  /// eso depende que el agente entienda por qué el paso no avanza.
  final Set<String> deadAngles;

  @override
  Widget build(BuildContext context) {
    return GridView.count(
      crossAxisCount: 2,
      shrinkWrap: true,
      physics: const NeverScrollableScrollPhysics(),
      mainAxisSpacing: 10,
      crossAxisSpacing: 10,
      childAspectRatio: 1.7,
      children: [
        for (final key in kInspectionAngleKeys)
          _AngleTile(
            angle: angles[key] ?? AngleUi(key: key),
            required: kRequiredAngleKeys.contains(key),
            dead: deadAngles.contains(key),
            onTap: () => onTapAngle(key),
          ),
      ],
    );
  }
}

class _AngleTile extends StatelessWidget {
  const _AngleTile({
    required this.angle,
    required this.required,
    required this.dead,
    required this.onTap,
  });

  final AngleUi angle;
  final bool required;
  final bool dead;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    final label = angleLabel(l10n, angle.key);
    final captured = angle.countsAsCaptured && !dead;
    final failed = angle.status == AngleStatus.failed || dead;
    // Hora de CAPTURA (reloj de este teléfono, describiendo un hecho local).
    // No se usa para "enviada": el instante del envío no lo sabemos — la fila
    // se borra al drenar — y fecharlo con la captura sería datar mal la
    // evidencia.
    final capturedAt = angle.capturedAt;
    final time = capturedAt == null
        ? null
        : DateFormat.Hm(Localizations.localeOf(context).toString())
            .format(capturedAt.toLocal());

    final subtitle = dead
        ? l10n.inspPhotoDead
        : switch (angle.status) {
            AngleStatus.pending => l10n.anglePending,
            AngleStatus.compressing => l10n.angleCompressing,
            AngleStatus.failed => l10n.angleFailedRetry,
            // "en bandeja" con su hora (17B); sin hora —fila restaurada de
            // una corrida anterior— se cae al peso, que es lo que hay.
            AngleStatus.queued => time != null
                ? l10n.inspPhotoQueued(time)
                : angle.bytes == null
                    ? l10n.angleQueued
                    : '${l10n.angleQueued} · ${formatBytes(angle.bytes!)}',
            // Capturada AQUÍ y sin fila = drenó con 2xx ⇒ "enviada al
            // servidor". Sin captura local, el servidor ya la tenía al entrar.
            AngleStatus.onServer =>
              time != null ? l10n.inspPhotoSent : l10n.angleOnServer,
          };

    return Semantics(
      button: true,
      label: '$label. $subtitle',
      onTap: onTap,
      child: ExcludeSemantics(
        child: Material(
          color: Colors.transparent,
          child: InkWell(
            onTap: onTap,
            borderRadius: BorderRadius.circular(20),
            child: Container(
              constraints: const BoxConstraints(minHeight: 96),
              clipBehavior: Clip.antiAlias,
              decoration: BoxDecoration(
                color: failed ? const Color(0xFFFFFBFB) : RideTokens.n0,
                borderRadius: BorderRadius.circular(20),
                border: Border.all(
                  color: captured
                      ? RideTokens.okBd
                      : failed
                          ? RideTokens.dangerBd
                          : RideTokens.n300,
                  width: 1.5,
                ),
              ),
              child: Stack(
                fit: StackFit.expand,
                children: [
                  if (angle.thumbnail != null) ...[
                    Image.memory(
                      angle.thumbnail!,
                      fit: BoxFit.cover,
                      // Miniatura decodificada pequeña (DoD #8): jamás el
                      // bitmap completo de 2048 px por tile.
                      cacheWidth: 360,
                      gaplessPlayback: true,
                    ),
                    // Scrim .85 SOSTENIDO bajo las dos líneas de texto y
                    // recién ahí desvanecido (review GD-3: si el .85 solo
                    // vive en el borde inferior, el subtexto cae en la zona
                    // desvanecida y sobre foto blanca da ≈2-3:1).
                    const DecoratedBox(
                      decoration: BoxDecoration(
                        gradient: LinearGradient(
                          begin: Alignment.bottomCenter,
                          end: Alignment.topCenter,
                          colors: [
                            Color(0xD917122B),
                            Color(0xD917122B),
                            Color(0x0017122B),
                          ],
                          stops: [0.0, 0.42, 0.62],
                        ),
                      ),
                    ),
                  ],
                  Padding(
                    padding: const EdgeInsets.all(10),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      mainAxisAlignment: MainAxisAlignment.end,
                      children: [
                        if (!captured && angle.thumbnail == null)
                          Expanded(
                            child: Center(
                              child: Icon(
                                Icons.photo_camera_outlined,
                                size: 26,
                                color: failed
                                    ? RideTokens.dangerBd
                                    : RideTokens.n400,
                              ),
                            ),
                          ),
                        Text(
                          label,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: TextStyle(
                            fontSize: 13.5,
                            fontWeight: FontWeight.w800,
                            color: angle.thumbnail != null
                                ? Colors.white
                                : RideTokens.n800,
                          ),
                        ),
                        Text(
                          subtitle,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: TextStyle(
                            fontSize: 11.5,
                            fontWeight:
                                failed ? FontWeight.w700 : FontWeight.w600,
                            color: angle.thumbnail != null
                                ? const Color(0xE0FFFFFF)
                                : failed
                                    ? RideTokens.dangerTx
                                    : RideTokens.n600,
                          ),
                        ),
                      ],
                    ),
                  ),
                  if (required)
                    Positioned(
                      top: 8,
                      left: 8,
                      child: Container(
                        padding: const EdgeInsets.symmetric(
                            horizontal: 8, vertical: 2),
                        decoration: BoxDecoration(
                          // Plate .85 medido sobre foto (review GD-4) — el
                          // .55 del primer corte no aguantaba foto clara.
                          color: angle.thumbnail != null
                              ? const Color(0xD917122B)
                              : RideTokens.warnBg,
                          borderRadius: BorderRadius.circular(7),
                          border: angle.thumbnail != null
                              ? null
                              : Border.all(color: RideTokens.warnBd),
                        ),
                        child: Text(
                          l10n.angleRequiredChip.toUpperCase(),
                          style: TextStyle(
                            fontSize: 10.5,
                            fontWeight: FontWeight.w800,
                            letterSpacing: 0.5,
                            color: angle.thumbnail != null
                                ? Colors.white
                                : RideTokens.warnTx,
                          ),
                        ),
                      ),
                    ),
                  Positioned(
                    top: 8,
                    right: 8,
                    // Muerta en la bandeja: la insignia es la de fallo aunque
                    // la CAPTURA saliera bien — lo que el agente necesita ver
                    // es que esa foto no está en el servidor.
                    child: _StatusBadge(
                      status: dead ? AngleStatus.failed : angle.status,
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

  static String formatBytes(int bytes) {
    if (bytes >= 1024 * 1024) {
      return '${(bytes / (1024 * 1024)).toStringAsFixed(1)} MB';
    }
    return '${(bytes / 1024).round()} KB';
  }
}

class _StatusBadge extends StatelessWidget {
  const _StatusBadge({required this.status});

  final AngleStatus status;

  @override
  Widget build(BuildContext context) {
    switch (status) {
      case AngleStatus.pending:
        return const SizedBox.shrink();
      case AngleStatus.compressing:
        return Container(
          width: 26,
          height: 26,
          padding: const EdgeInsets.all(5),
          decoration: BoxDecoration(
            color: RideTokens.n0,
            shape: BoxShape.circle,
            border: Border.all(color: RideTokens.n300, width: 1.5),
          ),
          child: const CircularProgressIndicator(
            strokeWidth: 2.5,
            color: RideTokens.p600,
          ),
        );
      case AngleStatus.failed:
        return Container(
          width: 26,
          height: 26,
          decoration: BoxDecoration(
            color: RideTokens.dangerBg,
            shape: BoxShape.circle,
            border: Border.all(color: RideTokens.dangerBd, width: 1.5),
          ),
          child: const Icon(Icons.close_rounded,
              size: 14, color: RideTokens.dangerTx),
        );
      case AngleStatus.queued:
      case AngleStatus.onServer:
        // Check blanco sobre --ok: icono (umbral no-texto 3:1 — medido
        // 4.3:1 en el mockup); el texto de estado vive en el subtexto.
        return Container(
          width: 26,
          height: 26,
          decoration: const BoxDecoration(
            color: RideTokens.ok,
            shape: BoxShape.circle,
            boxShadow: [BoxShadow(color: Colors.white, spreadRadius: 2)],
          ),
          child: const Icon(Icons.check_rounded, size: 15, color: Colors.white),
        );
    }
  }
}
