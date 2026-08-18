import '../../../../core/l10n/app_localizations.dart';

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

/// Los interiores usan el hint de encuadre "área" (nota 6 del mockup 6B).
bool isInteriorAngle(String key) =>
    key == 'front_seat' || key == 'rear_seat' || key == 'dash' || key == 'trunk';
