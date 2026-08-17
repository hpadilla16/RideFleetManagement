import 'package:flutter/material.dart';

/// Tokens visuales del mockup aprobado (ops-app-plan/mockups/m1-tanda-a-v2.html)
/// — misma base que frontend/src/app/globals.css. Solo los que M1 usa; se
/// agregan conforme los consumen las pantallas (no un design system entero).
///
/// Reglas duras del mockup que estos tokens sostienen:
///  - Foco AZUL [focus], nunca morado sobre morado.
///  - Gradiente aurora SOLO decorativo (login/splash); ningún dato encima.
///  - Elevation = borde + sombra, nunca sombra sola (se lava a pleno sol).
abstract final class RideTokens {
  // Rampa neutra
  static const n0 = Color(0xFFFFFFFF);
  static const n25 = Color(0xFFFBFAFF);
  static const n50 = Color(0xFFF7F5FD);
  static const n100 = Color(0xFFF2EFF9);
  static const n200 = Color(0xFFE9E4F4);
  static const n300 = Color(0xFFD9D2EA);
  static const n400 = Color(0xFFB3AAC9);
  static const n600 = Color(0xFF736A8B);
  static const n700 = Color(0xFF4B4362);
  static const n800 = Color(0xFF2E2745);
  static const n900 = Color(0xFF17122B);

  // Rampa púrpura de marca
  static const p50 = Color(0xFFF4EFFF);
  static const p100 = Color(0xFFEBE2FF);
  static const p200 = Color(0xFFD9C9FF);
  static const p300 = Color(0xFFC0A8FF);
  static const p600 = Color(0xFF6A35E0);
  static const p700 = Color(0xFF5A26C9);
  static const p800 = Color(0xFF45189E);
  static const brand = Color(0xFF8752FE);
  static const brandA20 = Color(0x338752FE);

  // Semánticos
  static const okBg = Color(0xFFE6F7F1);
  static const okBd = Color(0xFFBFE8D9);
  static const okTx = Color(0xFF08674E);
  static const ok = Color(0xFF0F8A68);
  static const warnBg = Color(0xFFFDF3E2);
  static const warnBd = Color(0xFFF3DCB5);
  static const warnTx = Color(0xFF8A5606);
  static const danger = Color(0xFFC02626);
  static const dangerBg = Color(0xFFFDECEA);
  static const dangerBd = Color(0xFFF6CDC9);
  static const dangerTx = Color(0xFF9C1D1D);

  /// Foco accesible del design system (regla: azul, no morado).
  static const focus = Color(0xFF0B63D6);
  static const focusHalo = Color(0x380B63D6);

  /// Superficie tonal derivada de la marca (checklist de política, PIN H2).
  static const tonal = Color(0xFFF6F2FF);

  /// Aurora (login/splash): linear 158° + acento cálido. Los radiales del
  /// mockup se aproximan con un segundo gradiente suave — decorativo puro.
  static const aurora = LinearGradient(
    begin: Alignment.topLeft,
    end: Alignment.bottomRight,
    colors: [Color(0xFF1C0F4A), Color(0xFF2E1071), Color(0xFF45189E), Color(0xFF5A26C9)],
    stops: [0.0, 0.42, 0.80, 1.0],
  );
  static const auroraWarm = Color(0x52FF8A5C); // rgba(255,138,92,.32)
  static const auroraWarmEnd = Color(0x00FF8A5C); // mismo tono, alpha 0

  /// Fondo .tonal-scr del mockup (éxito 2C, PIN H2): tonal → n50 al 60%.
  static const tonalScreenGradient = LinearGradient(
    begin: Alignment.topCenter,
    end: Alignment.bottomCenter,
    colors: [tonal, n50],
    stops: [0.0, 0.6],
  );

  /// Botón primario del mockup: gradiente vertical #7442e8 → p600.
  static const primaryButtonGradient = LinearGradient(
    begin: Alignment.topCenter,
    end: Alignment.bottomCenter,
    colors: [Color(0xFF7442E8), p600],
  );
}
