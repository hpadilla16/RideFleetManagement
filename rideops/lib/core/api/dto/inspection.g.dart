// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'inspection.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

_HandoffToken _$HandoffTokenFromJson(Map<String, dynamic> json) =>
    _HandoffToken(
      token: json['token'] as String,
      expiresAt: const IsoDateTimeConverter().fromJson(
        json['expiresAt'] as String?,
      ),
      kind: json['kind'] as String,
      reused: json['reused'] as bool? ?? false,
    );

Map<String, dynamic> _$HandoffTokenToJson(_HandoffToken instance) =>
    <String, dynamic>{
      'token': instance.token,
      'expiresAt': const IsoDateTimeConverter().toJson(instance.expiresAt),
      'kind': instance.kind,
      'reused': instance.reused,
    };

_MobileInspectionState _$MobileInspectionStateFromJson(
  Map<String, dynamic> json,
) => _MobileInspectionState(
  reservationNumber: json['reservationNumber'] as String?,
  agreementNumber: json['agreementNumber'] as String?,
  vehicle: json['vehicle'] as String?,
  angles:
      (json['angles'] as List<dynamic>?)
          ?.map((e) => InspectionAngle.fromJson(e as Map<String, dynamic>))
          .toList() ??
      const <InspectionAngle>[],
  expiresAt: const IsoDateTimeConverter().fromJson(
    json['expiresAt'] as String?,
  ),
);

Map<String, dynamic> _$MobileInspectionStateToJson(
  _MobileInspectionState instance,
) => <String, dynamic>{
  'reservationNumber': instance.reservationNumber,
  'agreementNumber': instance.agreementNumber,
  'vehicle': instance.vehicle,
  'angles': instance.angles,
  'expiresAt': const IsoDateTimeConverter().toJson(instance.expiresAt),
};

_InspectionAngle _$InspectionAngleFromJson(Map<String, dynamic> json) =>
    _InspectionAngle(
      key: json['key'] as String,
      label: json['label'] as String,
      captured: json['captured'] as bool? ?? false,
    );

Map<String, dynamic> _$InspectionAngleToJson(_InspectionAngle instance) =>
    <String, dynamic>{
      'key': instance.key,
      'label': instance.label,
      'captured': instance.captured,
    };
