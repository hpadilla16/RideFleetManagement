// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'staff_location.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

_StaffLocation _$StaffLocationFromJson(Map<String, dynamic> json) =>
    _StaffLocation(
      id: json['id'] as String,
      code: json['code'] as String?,
      name: json['name'] as String,
      city: json['city'] as String?,
      state: json['state'] as String?,
    );

Map<String, dynamic> _$StaffLocationToJson(_StaffLocation instance) =>
    <String, dynamic>{
      'id': instance.id,
      'code': instance.code,
      'name': instance.name,
      'city': instance.city,
      'state': instance.state,
    };
