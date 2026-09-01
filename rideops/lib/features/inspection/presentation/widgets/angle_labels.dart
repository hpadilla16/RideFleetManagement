import '../../../../core/l10n/app_localizations.dart';
import '../../application/inspection_state.dart';

/// Etiquetas localizadas de los 8 ángulos canónicos. El backend manda labels
/// en inglés fijo (INSPECTION_ANGLES) — la app localiza por llave (ADR-8) y
/// solo caería al label del wire si apareciera una llave desconocida.
String angleLabel(AppLocalizations l10n, String key) => switch (key) {
      'front' => l10n.angleFront,
      'rear' => l10n.angleRear,
      'left' => l10n.angleLeft,
      'right' => l10n.angleRight,
      'front_seat' => l10n.angleFrontSeat,
      'rear_seat' => l10n.angleRearSeat,
      'dash' => l10n.angleDash,
      'trunk' => l10n.angleTrunk,
      _ => key,
    };

/// "el combustible y la limpieza" — el bloqueo del sub-paso de métricas
/// NOMBRADO, con la misma mecánica de lista legible que ya usa el paso 1
/// (`confirming_step.dart:_missingLabel`).
///
/// Devuelve null cuando no falta nada: el pie no pone subtexto donde no hay
/// bloqueo que explicar.
String? metricsBlockedWhy(AppLocalizations l10n, InspectionFlowState state) {
  final parts = [
    for (final field in state.missingMetrics)
      switch (field) {
        MetricsField.odometer => l10n.metricsFieldOdometer,
        MetricsField.fuel => l10n.metricsFieldFuel,
        MetricsField.cleanliness => l10n.metricsFieldCleanliness,
      },
  ];
  if (parts.isEmpty) return null;
  final list = parts.length == 1
      ? parts.single
      : '${parts.sublist(0, parts.length - 1).join(', ')} '
          '${l10n.metricsFieldJoin} ${parts.last}';
  return l10n.metricsBlockedWhy(list);
}

/// Los interiores usan el hint de encuadre "área" (nota 6 del mockup 6B).
bool isInteriorAngle(String key) =>
    key == 'front_seat' || key == 'rear_seat' || key == 'dash' || key == 'trunk';
