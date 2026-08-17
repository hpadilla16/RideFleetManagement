import 'package:freezed_annotation/freezed_annotation.dart';

part 'reservation_display.freezed.dart';
part 'reservation_display.g.dart';

/// `GET /api/reservations/:id/display-data` (reservations.routes.js:588-627)
/// → `{ reservation, insurancePlans, additionalServices, branding }`.
///
/// H5 consume DOS cosas de este payload:
///  - [branding]: la superficie volteada al cliente (firma 6D) pinta el
///    TENANT — logo, nombre — y CERO rastro de RideOps (REGROUND §4).
///  - [reservation]: número de reserva + vehículo (etiqueta del header de
///    inspección y `vehicle.mileage` como "última lectura registrada" del
///    odómetro — nota 7 del mockup 6C: endpoint autenticado, NO el token).
///
/// El resto del payload (planes, servicios, charges) se ignora a propósito:
/// json_serializable descarta llaves no declaradas.
@freezed
abstract class ReservationDisplayData with _$ReservationDisplayData {
  const factory ReservationDisplayData({
    required DisplayReservation reservation,
    required TenantBranding branding,
  }) = _ReservationDisplayData;

  factory ReservationDisplayData.fromJson(Map<String, dynamic> json) =>
      _$ReservationDisplayDataFromJson(json);
}

/// Subconjunto de la fila de reserva (reservationsService.getById incluye
/// `vehicle: true` y `customer` con select — :1539-1580).
@freezed
abstract class DisplayReservation with _$DisplayReservation {
  const factory DisplayReservation({
    required String id,
    String? reservationNumber,
    DisplayVehicle? vehicle,
    DisplayCustomer? customer,
  }) = _DisplayReservation;

  factory DisplayReservation.fromJson(Map<String, dynamic> json) =>
      _$DisplayReservationFromJson(json);
}

/// Cliente de la reserva — solo el nombre: se sella como `signerName` del
/// complete de inspección (la firma legal lleva firmante, review INN S-3).
@freezed
abstract class DisplayCustomer with _$DisplayCustomer {
  const DisplayCustomer._();

  const factory DisplayCustomer({
    String? firstName,
    String? lastName,
  }) = _DisplayCustomer;

  factory DisplayCustomer.fromJson(Map<String, dynamic> json) =>
      _$DisplayCustomerFromJson(json);

  /// "María González" o null si no hay nada que sellar.
  String? get fullName {
    final name =
        [firstName, lastName].nonNulls.where((p) => p.isNotEmpty).join(' ');
    return name.isEmpty ? null : name;
  }
}

/// Campos del modelo `Vehicle` (schema.prisma:776+) que la inspección usa.
@freezed
abstract class DisplayVehicle with _$DisplayVehicle {
  const DisplayVehicle._();

  const factory DisplayVehicle({
    required String id,
    String? internalNumber,
    String? make,
    String? model,
    int? year,
    String? plate,

    /// Espejo vivo del historial de millas (Vehicle.mileage, default 0) —
    /// la "última lectura registrada" bajo el campo de odómetro.
    int? mileage,
  }) = _DisplayVehicle;

  factory DisplayVehicle.fromJson(Map<String, dynamic> json) =>
      _$DisplayVehicleFromJson(json);

  /// "Toyota Corolla 2023 · U-112" — la etiqueta del insphead del mockup 6A.
  String get label {
    final name = [make, model, year?.toString()].nonNulls.join(' ');
    return [name, internalNumber]
        .nonNulls
        .where((p) => p.isNotEmpty)
        .join(' · ');
  }
}

/// Branding del tenant resuelto en servidor (routes:618-622) — con defaults
/// del backend ('Ride Fleet', '') que la UI trata como "sin logo".
@freezed
abstract class TenantBranding with _$TenantBranding {
  const factory TenantBranding({
    @Default('') String companyName,
    @Default('') String companyLogoUrl,
    @Default('') String companyPhone,
  }) = _TenantBranding;

  factory TenantBranding.fromJson(Map<String, dynamic> json) =>
      _$TenantBrandingFromJson(json);
}
