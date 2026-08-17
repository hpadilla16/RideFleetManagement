import 'package:freezed_annotation/freezed_annotation.dart';

part 'staff_location.freezed.dart';
part 'staff_location.g.dart';

/// Fila de `GET /api/locations/selectable`
/// (locations-selectable.routes.js:38-45): las sedes que un miembro del staff
/// puede ver, con NOMBRE — lo único que el selector de ubicación necesita.
/// Para un usuario RESTRICTED el backend ya la filtra a su set
/// (userAllowedLocationIds); para UNRESTRICTED devuelve todas las del tenant.
/// El endpoint es alcanzable por cualquier staff autenticado (montado ANTES
/// del gate settings/ADMIN — main.js:331), así que un AGENT no recibe 403.
@freezed
abstract class StaffLocation with _$StaffLocation {
  const factory StaffLocation({
    required String id,
    String? code,
    required String name,
    String? city,
    String? state,
  }) = _StaffLocation;

  factory StaffLocation.fromJson(Map<String, dynamic> json) =>
      _$StaffLocationFromJson(json);
}
