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
    );

Map<String, dynamic> _$DisplayReservationToJson(_DisplayReservation instance) =>
    <String, dynamic>{
      'id': instance.id,
      'reservationNumber': instance.reservationNumber,
      'vehicle': instance.vehicle,
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
