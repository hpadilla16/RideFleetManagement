import 'package:freezed_annotation/freezed_annotation.dart';

import 'json_converters.dart';

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

    /// Grupo (clase) reservado. El sheet de swap (9E) lo compara con el
    /// `vehicleTypeId` de cada candidata para decir "mismo grupo" sin
    /// inventarse una jerarquía de tarifas que el endpoint no manda.
    String? vehicleTypeId,

    /// Snapshot del contrato (`getById` :1585-1668). Es la verdad LEGAL de la
    /// entrega: el PDF imprime estos campos, no los de la ficha viva del
    /// cliente — por eso la tarjeta 9A los prefiere y cae a `customer` solo
    /// cuando el snapshot está vacío.
    DisplayAgreement? rentalAgreement,

    /// Cuándo sale el coche. Es la TERCERA respuesta que el patio necesita en
    /// el header del wizard (mockup 8A: "Salida hoy 10:30"): a quién atiendo,
    /// qué unidad entrego, **para cuándo**.
    @IsoDateTimeConverter() DateTime? pickupAt,

    /// Sello del pre-checkin (`Reservation.customerInfoCompletedAt`,
    /// schema.prisma:1526). Es además el gate del 422 PRECHECKIN_REQUIRED en
    /// las sedes que lo exigen: verlo ANTES ahorra el viaje a la negativa.
    @IsoDateTimeConverter() DateTime? customerInfoCompletedAt,
  }) = _DisplayReservation;

  factory DisplayReservation.fromJson(Map<String, dynamic> json) =>
      _$DisplayReservationFromJson(json);
}

/// Cliente de la reserva. El nombre se sella como `signerName` del complete
/// de inspección (la firma legal lleva firmante, review INN S-3); licencia y
/// teléfono son las dos filas que el agente CONFRONTA contra la licencia
/// física en el paso CONFIRMING (9A) y las dos que 9B nombra cuando faltan.
///
/// OJO con el modelo: `Customer` **no tiene** vencimiento de licencia
/// (schema.prisma, modelo Customer) — ese dato vive solo en el snapshot del
/// contrato ([DisplayAgreement.licenseExpiry]).
@freezed
abstract class DisplayCustomer with _$DisplayCustomer {
  const DisplayCustomer._();

  const factory DisplayCustomer({
    String? firstName,
    String? lastName,
    String? phone,
    String? licenseNumber,
    String? licenseState,
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

/// Snapshot del `RentalAgreement` que viaja dentro de display-data
/// (`reservations.service.js` `getById` :1585-1668).
@freezed
abstract class DisplayAgreement with _$DisplayAgreement {
  const DisplayAgreement._();

  const factory DisplayAgreement({
    required String id,
    String? customerPhone,
    String? licenseNumber,
    String? licenseState,
    @IsoDateTimeConverter() DateTime? licenseExpiry,

    /// Bandera del anexo de rechazo de cobertura (`RentalAgreement
    /// .declinedInsurance`, schema.prisma:2231) — lo que el switch de 9C
    /// escribe vía `POST /:id/declined-insurance`.
    ///
    /// **Hoy llega SIEMPRE null y no es un descuido del DTO**: el `select` de
    /// `getById` (:1585-1668) NO incluye la columna — solo el select de LISTA
    /// la trae (`reservations.service.js:285`). Consecuencia verificada: el
    /// wizard web lee `reservation.rentalAgreement?.declinedInsurance` de este
    /// mismo payload (`checkout-wizard-v2/page.js:750`) y por eso su switch
    /// arranca APAGADO aunque el seguro ya esté declinado — bug preexistente
    /// del web, registrado por H2.
    ///
    /// Por eso RideOps deriva el estado del `events[]` de la sesión (el
    /// `DECLINED_INSURANCE` que escribe `setDeclinedInsurance`) y trata este
    /// campo como la fuente PREFERENTE en cuanto el backend lo mande: null =
    /// "el servidor no lo dice", nunca "false".
    bool? declinedInsurance,
  }) = _DisplayAgreement;

  factory DisplayAgreement.fromJson(Map<String, dynamic> json) =>
      _$DisplayAgreementFromJson(json);
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

    /// `Vehicle.status` crudo (AVAILABLE | RENTED | IN_MAINTENANCE | …). La
    /// tarjeta de vehículo (9A) SOLO afirma "Disponible" cuando el servidor
    /// dice AVAILABLE; cualquier otro valor se muestra como estado neutro con
    /// su palabra, nunca traducido a una promesa que el dato no sostiene.
    String? status,
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
/// del backend ('Ride Fleet', '') que la UI trata como "sin branding".
@freezed
abstract class TenantBranding with _$TenantBranding {
  const TenantBranding._();

  const factory TenantBranding({
    @Default('') String companyName,
    @Default('') String companyLogoUrl,
    @Default('') String companyPhone,
  }) = _TenantBranding;

  factory TenantBranding.fromJson(Map<String, dynamic> json) =>
      _$TenantBrandingFromJson(json);

  /// Default de PLATAFORMA que el backend inyecta cuando el tenant no
  /// configuró branding (`rentalSettings?.companyName || 'Ride Fleet'`,
  /// reservations.routes.js:619).
  static const platformDefaultName = 'Ride Fleet';

  /// Nombre APTO para superficies volteadas al cliente (QA MAJOR de H5):
  /// el centinela 'Ride Fleet' viaja del backend y aquí se NEUTRALIZA a
  /// vacío — un tenant sin branding no puede mostrarle nuestra marca (ni
  /// las iniciales "RF" derivadas) al cliente durante la firma legal
  /// (regla GD-1). Punto ÚNICO del filtro: todo consumidor de cara al
  /// cliente usa este getter, nunca [companyName] crudo.
  ///
  /// Gap anotado para backend: que display-data devuelva null en vez del
  /// default de plataforma — este filtro es el parche del cliente y
  /// sacrificaría a un tenant legítimamente llamado "Ride Fleet".
  String get clientSafeCompanyName =>
      companyName == platformDefaultName ? '' : companyName;
}
