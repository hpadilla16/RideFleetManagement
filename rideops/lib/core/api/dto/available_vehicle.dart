import 'package:freezed_annotation/freezed_annotation.dart';

part 'available_vehicle.freezed.dart';
part 'available_vehicle.g.dart';

/// Fila de `GET /api/reservations/:id/available-vehicles`
/// (`reservations.routes.js:992-1092`) — la lista del sheet de swap (9E).
///
/// **Por qué ESTE endpoint y no `GET /api/vehicles`** (que es lo que usa el
/// wizard web, `checkout-wizard-v2/page.js:376`): el MUST del mockup es
/// "solo unidades que el servidor da por disponibles". `/api/vehicles` trae la
/// flota entera y deja el filtro al cliente, así que el agente vería unidades
/// que el swap va a rechazar. Este endpoint las descarta EN SERVIDOR:
///  - reservas que se solapan en la ventana (`NEW`/`CONFIRMED`/`CHECKED_OUT`),
///  - bloqueos de disponibilidad activos,
///  - `IN_MAINTENANCE` / `OUT_OF_SERVICE` / `SOLD`,
/// y ordena por afinidad (misma clase o misma sede de la reserva).
///
/// Un detalle que la UI DEPENDE de él: la unidad actualmente asignada viaja
/// SIEMPRE y de primera (`preferred.unshift`, :1064-1067) aunque esté en
/// conflicto — es exactamente la fila que 9E pinta INERTE con su motivo en vez
/// de omitirla.
///
/// Lo que este endpoint **no** hace y la copy no puede prometer: no filtra por
/// la sede activa del selector (solo por tenant + programa), así que el sheet
/// declara "según el servidor" y nombra la sede de CADA unidad, en lugar de
/// titular la lista con la sede del mostrador.
@freezed
abstract class AvailableVehicle with _$AvailableVehicle {
  const AvailableVehicle._();

  const factory AvailableVehicle({
    required String id,
    String? internalNumber,
    String? plate,
    String? make,
    String? model,
    int? year,
    String? color,

    /// Espejo del odómetro (`Vehicle.mileage`).
    int? mileage,

    /// AVAILABLE | RENTED | RESERVED | … Se muestra crudo solo cuando NO es
    /// AVAILABLE: el candidato pasó el filtro del servidor, pero el agente
    /// merece ver que la unidad no está en el patio ahora mismo.
    String? status,
    String? vehicleTypeId,
    VehicleTypeRef? vehicleType,
    String? homeLocationId,
    LocationRef? homeLocation,
  }) = _AvailableVehicle;

  factory AvailableVehicle.fromJson(Map<String, dynamic> json) =>
      _$AvailableVehicleFromJson(json);

  /// "U-118 · Corolla 2023" — número interno primero: es lo que el agente lee
  /// en la llave y en el parabrisas.
  String get label {
    final model = [make, this.model, year?.toString()].nonNulls.join(' ');
    return [internalNumber, model.isEmpty ? null : model]
        .nonNulls
        .where((p) => p.isNotEmpty)
        .join(' · ');
  }

  bool get isAvailableNow => (status ?? '').toUpperCase() == 'AVAILABLE';
}

@freezed
abstract class VehicleTypeRef with _$VehicleTypeRef {
  const factory VehicleTypeRef({required String id, String? name}) =
      _VehicleTypeRef;

  factory VehicleTypeRef.fromJson(Map<String, dynamic> json) =>
      _$VehicleTypeRefFromJson(json);
}

@freezed
abstract class LocationRef with _$LocationRef {
  const factory LocationRef({required String id, String? name}) = _LocationRef;

  factory LocationRef.fromJson(Map<String, dynamic> json) =>
      _$LocationRefFromJson(json);
}
