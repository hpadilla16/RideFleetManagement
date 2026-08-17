import 'package:freezed_annotation/freezed_annotation.dart';

import '../enums.dart';

part 'session_user.freezed.dart';
part 'session_user.g.dart';

/// `buildSessionUser` del backend (auth.service.js:87-115). Es lo que llega
/// en `POST /api/auth/login`, `GET /api/auth/me` y
/// `POST /api/auth/change-password` (todos devuelven `{ token, user }` o el
/// user directo en /me).
@freezed
abstract class SessionUser with _$SessionUser {
  const SessionUser._();

  const factory SessionUser({
    required String id,
    required String email,
    String? fullName,
    required String role,
    String? tenantId,
    String? createdByUserId,
    String? hostProfileId,
    @Default(false) bool screenLockExempt,

    /// `null` = TODAS las ubicaciones (usuario UNRESTRICTED). El backend
    /// normaliza lista vacía a null (parseLocationIds, auth.service.js:78-85).
    List<String>? locationIds,
    @Default('BOTH') String programScope,
    @Default(false) bool isServiceAccount,
    @Default(0) int tokenVersion,

    /// true → la sesión solo alcanza change-password/me/refresh; todo lo
    /// demás 403 PASSWORD_CHANGE_REQUIRED. La app rutea a la pantalla de
    /// cambio forzado (M1).
    @Default(false) bool mustChangePassword,

    /// Mapa booleano sobre los 21 MODULE_KEYS (lib/module-access.js:6-47).
    /// `paymentActions` es el que gobierna los botones de dinero en M2.
    @Default(<String, bool>{}) Map<String, bool> moduleAccess,
  }) = _SessionUser;

  factory SessionUser.fromJson(Map<String, dynamic> json) =>
      _$SessionUserFromJson(json);

  UserRole? get roleEnum => UserRole.tryParse(role);

  bool get isLocationRestricted =>
      locationIds != null && locationIds!.isNotEmpty;

  bool can(String moduleKey) => moduleAccess[moduleKey] ?? false;
}

/// Respuesta de login/change-password: `{ token, user }`.
@freezed
abstract class AuthResponse with _$AuthResponse {
  const factory AuthResponse({
    required String token,
    required SessionUser user,
  }) = _AuthResponse;

  factory AuthResponse.fromJson(Map<String, dynamic> json) =>
      _$AuthResponseFromJson(json);
}
