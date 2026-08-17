import 'package:flutter/foundation.dart';

/// Política de contraseña — espejo EXACTO de `validatePassword` del backend
/// (backend/src/modules/auth/auth.routes.js:19-30):
///
///   PASSWORD_MIN_LENGTH = 12
///   PASSWORD_REGEX = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^a-zA-Z0-9]).{12,}$/
///
/// más la regla del servicio (auth.service.js:274-276): la nueva debe ser
/// DISTINTA de la actual. El checklist vivo de la pantalla 2 del mockup
/// renderiza estas reglas; el servidor manda igual (el submit puede fallar
/// 400 aunque el checklist pase — p. ej. si la política del backend cambia).
/// Si el backend mueve la política, este archivo cambia en el mismo PR.
@immutable
class PasswordPolicyResult {
  const PasswordPolicyResult({
    required this.hasMinLength,
    required this.hasLowercase,
    required this.hasUppercase,
    required this.hasDigit,
    required this.hasSpecial,
    required this.differsFromCurrent,
  });

  final bool hasMinLength;
  final bool hasLowercase;
  final bool hasUppercase;
  final bool hasDigit;
  final bool hasSpecial;
  final bool differsFromCurrent;

  static const ruleCount = 6;

  int get metCount => [
        hasMinLength,
        hasLowercase,
        hasUppercase,
        hasDigit,
        hasSpecial,
        differsFromCurrent,
      ].where((m) => m).length;

  bool get allMet => metCount == ruleCount;

  /// Medidor de fuerza del mockup: 4 segmentos proporcionales a las reglas
  /// cumplidas (decorativo — el estado legible vive en el checklist). Piso
  /// de 1 segmento con cualquier regla cumplida (GD S-2): el usuario teclea
  /// su primera letra y el medidor YA responde, no a la tercera regla.
  int get strengthSegments {
    if (metCount == 0) return 0;
    final raw = (metCount * 4) ~/ ruleCount;
    return raw < 1 ? 1 : raw;
  }
}

abstract final class PasswordPolicy {
  static const minLength = 12; // PASSWORD_MIN_LENGTH del backend

  static final _lower = RegExp('[a-z]');
  static final _upper = RegExp('[A-Z]');
  static final _digit = RegExp(r'\d');
  static final _special = RegExp('[^a-zA-Z0-9]');

  static PasswordPolicyResult evaluate({
    required String candidate,
    required String current,
  }) {
    return PasswordPolicyResult(
      hasMinLength: candidate.length >= minLength,
      hasLowercase: _lower.hasMatch(candidate),
      hasUppercase: _upper.hasMatch(candidate),
      hasDigit: _digit.hasMatch(candidate),
      hasSpecial: _special.hasMatch(candidate),
      // Backend compara String(current) === String(new); vacía no cuenta como
      // "distinta" — sin texto aún no hay nada que evaluar.
      differsFromCurrent: candidate.isNotEmpty && candidate != current,
    );
  }
}
