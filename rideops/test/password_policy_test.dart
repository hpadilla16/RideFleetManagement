import 'package:flutter_test/flutter_test.dart';
import 'package:rideops/features/auth/domain/password_policy.dart';

/// Espejo de validatePassword del backend (auth.routes.js:19-30) + la regla
/// "distinta de la actual" (auth.service.js:274-276). Si estas expectativas
/// dejan de cuadrar con el backend, se actualizan AMBOS lados en el mismo PR.
void main() {
  PasswordPolicyResult eval(String candidate, {String current = 'Temp#12345678'}) =>
      PasswordPolicy.evaluate(candidate: candidate, current: current);

  test('contraseña que el backend acepta cumple todo', () {
    final r = eval(r'PatioCentro#2026');
    expect(r.allMet, isTrue);
    expect(r.metCount, PasswordPolicyResult.ruleCount);
    expect(r.strengthSegments, 4);
  });

  test('mínimo 12 (PASSWORD_MIN_LENGTH), no 8', () {
    // 11 chars con todas las clases: el backend la RECHAZA por longitud.
    final r = eval(r'Patio#2026a');
    expect(r.hasLowercase, isTrue);
    expect(r.hasUppercase, isTrue);
    expect(r.hasDigit, isTrue);
    expect(r.hasSpecial, isTrue);
    expect(r.hasMinLength, isFalse);
    expect(r.allMet, isFalse);
  });

  test('cada clase de carácter se detecta por separado', () {
    expect(eval('patiocentro#2026').hasUppercase, isFalse);
    expect(eval('PATIOCENTRO#2026').hasLowercase, isFalse);
    expect(eval('PatioCentro#abc').hasDigit, isFalse);
    expect(eval('PatioCentro2026').hasSpecial, isFalse);
  });

  test('igual a la actual no cuenta como distinta (regla del servicio)', () {
    final r = eval(r'Temp#12345678', current: r'Temp#12345678');
    expect(r.differsFromCurrent, isFalse);
    expect(r.allMet, isFalse);
  });

  test('candidata vacía no cumple nada', () {
    final r = eval('');
    expect(r.metCount, 0);
    expect(r.strengthSegments, 0);
  });

  test('el medidor crece proporcional a las reglas cumplidas', () {
    // Solo minúsculas: 2 reglas (lowercase + distinta) de 6 → 1 segmento.
    expect(eval('abc').metCount, 2);
    expect(eval('abc').strengthSegments, 1);
  });
}
