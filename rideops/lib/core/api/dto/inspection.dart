import 'package:freezed_annotation/freezed_annotation.dart';

import 'json_converters.dart';

part 'inspection.freezed.dart';
part 'inspection.g.dart';

/// `POST /api/checkout-sessions/:id/handoff-token` →
/// `mintHandoffToken` (checkout-session.service.js:700-771).
/// [reused] llega true solo cuando devolvió un token existente aún vigente.
@freezed
abstract class HandoffToken with _$HandoffToken {
  const HandoffToken._();

  const factory HandoffToken({
    required String token,
    @IsoDateTimeConverter() DateTime? expiresAt,
    required String kind,
    @Default(false) bool reused,

    /// URL ABSOLUTA que el cliente abre al escanear el QR, ya resuelta por el
    /// servidor (`publicUrlForToken`, checkout-session.service.js:62-64).
    ///
    /// Llega solo en `TERMS_SIGNING`: para `MOBILE_INSPECTION` el backend
    /// manda **null** a propósito —ese token se canjea por API y no tiene
    /// página pública— y adivinarle una ruta sería peor que omitirla. O sea
    /// que null aquí NO es "backend viejo", puede ser "este kind no tiene
    /// URL"; el fallback de la app cubre los dos casos igual.
    String? signUrl,
  }) = _HandoffToken;

  factory HandoffToken.fromJson(Map<String, dynamic> json) =>
      _$HandoffTokenFromJson(json);

  /// El drenador re-emite si quedan <2 min (el propio mint deja de reusar
  /// bajo ese piso — checkout-session.service.js:713-717).
  bool aliveFor(Duration margin, {DateTime Function() now = DateTime.now}) {
    final exp = expiresAt;
    if (exp == null) return false;
    return now().add(margin).isBefore(exp);
  }
}

/// `GET /api/mobile-inspection/:token` → `loadSession`
/// (mobile-inspection.service.js:118-143).
@freezed
abstract class MobileInspectionState with _$MobileInspectionState {
  const factory MobileInspectionState({
    String? reservationNumber,
    String? agreementNumber,
    String? vehicle,
    @Default(<InspectionAngle>[]) List<InspectionAngle> angles,
    @IsoDateTimeConverter() DateTime? expiresAt,
  }) = _MobileInspectionState;

  factory MobileInspectionState.fromJson(Map<String, dynamic> json) =>
      _$MobileInspectionStateFromJson(json);
}

/// Los 8 ángulos canónicos (INSPECTION_ANGLES,
/// mobile-inspection.service.js:35-44). `front` y `rear` son obligatorios
/// para completar (REQUIRED_ANGLES_MISSING).
@freezed
abstract class InspectionAngle with _$InspectionAngle {
  const factory InspectionAngle({
    required String key,
    required String label,
    @Default(false) bool captured,
  }) = _InspectionAngle;

  factory InspectionAngle.fromJson(Map<String, dynamic> json) =>
      _$InspectionAngleFromJson(json);
}
