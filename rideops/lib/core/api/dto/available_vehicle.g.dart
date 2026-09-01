// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'available_vehicle.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

_AvailableVehicle _$AvailableVehicleFromJson(Map<String, dynamic> json) =>
    _AvailableVehicle(
      id: json['id'] as String,
      internalNumber: json['internalNumber'] as String?,
      plate: json['plate'] as String?,
      make: json['make'] as String?,
      model: json['model'] as String?,
      year: (json['year'] as num?)?.toInt(),
      color: json['color'] as String?,
      mileage: (json['mileage'] as num?)?.toInt(),
      status: json['status'] as String?,
      vehicleTypeId: json['vehicleTypeId'] as String?,
      vehicleType: json['vehicleType'] == null
          ? null
          : VehicleTypeRef.fromJson(
              json['vehicleType'] as Map<String, dynamic>,
            ),
      homeLocationId: json['homeLocationId'] as String?,
      homeLocation: json['homeLocation'] == null
          ? null
          : LocationRef.fromJson(json['homeLocation'] as Map<String, dynamic>),
    );

Map<String, dynamic> _$AvailableVehicleToJson(_AvailableVehicle instance) =>
    <String, dynamic>{
      'id': instance.id,
      'internalNumber': instance.internalNumber,
      'plate': instance.plate,
      'make': instance.make,
      'model': instance.model,
      'year': instance.year,
      'color': instance.color,
      'mileage': instance.mileage,
      'status': instance.status,
      'vehicleTypeId': instance.vehicleTypeId,
      'vehicleType': instance.vehicleType,
      'homeLocationId': instance.homeLocationId,
      'homeLocation': instance.homeLocation,
    };

_VehicleTypeRef _$VehicleTypeRefFromJson(Map<String, dynamic> json) =>
    _VehicleTypeRef(id: json['id'] as String, name: json['name'] as String?);

Map<String, dynamic> _$VehicleTypeRefToJson(_VehicleTypeRef instance) =>
    <String, dynamic>{'id': instance.id, 'name': instance.name};

_LocationRef _$LocationRefFromJson(Map<String, dynamic> json) =>
    _LocationRef(id: json['id'] as String, name: json['name'] as String?);

Map<String, dynamic> _$LocationRefToJson(_LocationRef instance) =>
    <String, dynamic>{'id': instance.id, 'name': instance.name};
