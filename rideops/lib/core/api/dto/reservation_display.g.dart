// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'reservation_display.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

_ReservationDisplayData _$ReservationDisplayDataFromJson(
  Map<String, dynamic> json,
) => _ReservationDisplayData(
  reservation: DisplayReservation.fromJson(
    json['reservation'] as Map<String, dynamic>,
  ),
  branding: TenantBranding.fromJson(json['branding'] as Map<String, dynamic>),
);

Map<String, dynamic> _$ReservationDisplayDataToJson(
  _ReservationDisplayData instance,
) => <String, dynamic>{
  'reservation': instance.reservation,
  'branding': instance.branding,
};

_DisplayReservation _$DisplayReservationFromJson(Map<String, dynamic> json) =>
    _DisplayReservation(
      id: json['id'] as String,
      reservationNumber: json['reservationNumber'] as String?,
      vehicle: json['vehicle'] == null
          ? null
          : DisplayVehicle.fromJson(json['vehicle'] as Map<String, dynamic>),
      customer: json['customer'] == null
          ? null
          : DisplayCustomer.fromJson(json['customer'] as Map<String, dynamic>),
      vehicleTypeId: json['vehicleTypeId'] as String?,
      rentalAgreement: json['rentalAgreement'] == null
          ? null
          : DisplayAgreement.fromJson(
              json['rentalAgreement'] as Map<String, dynamic>,
            ),
      pickupAt: const IsoDateTimeConverter().fromJson(
        json['pickupAt'] as String?,
      ),
      customerInfoCompletedAt: const IsoDateTimeConverter().fromJson(
        json['customerInfoCompletedAt'] as String?,
      ),
    );

Map<String, dynamic> _$DisplayReservationToJson(_DisplayReservation instance) =>
    <String, dynamic>{
      'id': instance.id,
      'reservationNumber': instance.reservationNumber,
      'vehicle': instance.vehicle,
      'customer': instance.customer,
      'vehicleTypeId': instance.vehicleTypeId,
      'rentalAgreement': instance.rentalAgreement,
      'pickupAt': const IsoDateTimeConverter().toJson(instance.pickupAt),
      'customerInfoCompletedAt': const IsoDateTimeConverter().toJson(
        instance.customerInfoCompletedAt,
      ),
    };

_DisplayCustomer _$DisplayCustomerFromJson(Map<String, dynamic> json) =>
    _DisplayCustomer(
      firstName: json['firstName'] as String?,
      lastName: json['lastName'] as String?,
      phone: json['phone'] as String?,
      licenseNumber: json['licenseNumber'] as String?,
      licenseState: json['licenseState'] as String?,
    );

Map<String, dynamic> _$DisplayCustomerToJson(_DisplayCustomer instance) =>
    <String, dynamic>{
      'firstName': instance.firstName,
      'lastName': instance.lastName,
      'phone': instance.phone,
      'licenseNumber': instance.licenseNumber,
      'licenseState': instance.licenseState,
    };

_DisplayAgreement _$DisplayAgreementFromJson(Map<String, dynamic> json) =>
    _DisplayAgreement(
      id: json['id'] as String,
      customerPhone: json['customerPhone'] as String?,
      licenseNumber: json['licenseNumber'] as String?,
      licenseState: json['licenseState'] as String?,
      licenseExpiry: const IsoDateTimeConverter().fromJson(
        json['licenseExpiry'] as String?,
      ),
      declinedInsurance: json['declinedInsurance'] as bool?,
    );

Map<String, dynamic> _$DisplayAgreementToJson(
  _DisplayAgreement instance,
) => <String, dynamic>{
  'id': instance.id,
  'customerPhone': instance.customerPhone,
  'licenseNumber': instance.licenseNumber,
  'licenseState': instance.licenseState,
  'licenseExpiry': const IsoDateTimeConverter().toJson(instance.licenseExpiry),
  'declinedInsurance': instance.declinedInsurance,
};

_DisplayVehicle _$DisplayVehicleFromJson(Map<String, dynamic> json) =>
    _DisplayVehicle(
      id: json['id'] as String,
      internalNumber: json['internalNumber'] as String?,
      make: json['make'] as String?,
      model: json['model'] as String?,
      year: (json['year'] as num?)?.toInt(),
      plate: json['plate'] as String?,
      mileage: (json['mileage'] as num?)?.toInt(),
      status: json['status'] as String?,
    );

Map<String, dynamic> _$DisplayVehicleToJson(_DisplayVehicle instance) =>
    <String, dynamic>{
      'id': instance.id,
      'internalNumber': instance.internalNumber,
      'make': instance.make,
      'model': instance.model,
      'year': instance.year,
      'plate': instance.plate,
      'mileage': instance.mileage,
      'status': instance.status,
    };

_TenantBranding _$TenantBrandingFromJson(Map<String, dynamic> json) =>
    _TenantBranding(
      companyName: json['companyName'] as String? ?? '',
      companyLogoUrl: json['companyLogoUrl'] as String? ?? '',
      companyPhone: json['companyPhone'] as String? ?? '',
    );

Map<String, dynamic> _$TenantBrandingToJson(_TenantBranding instance) =>
    <String, dynamic>{
      'companyName': instance.companyName,
      'companyLogoUrl': instance.companyLogoUrl,
      'companyPhone': instance.companyPhone,
    };
