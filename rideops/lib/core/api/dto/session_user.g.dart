// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'session_user.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

_SessionUser _$SessionUserFromJson(Map<String, dynamic> json) => _SessionUser(
  id: json['id'] as String,
  email: json['email'] as String,
  fullName: json['fullName'] as String?,
  role: json['role'] as String,
  tenantId: json['tenantId'] as String?,
  createdByUserId: json['createdByUserId'] as String?,
  hostProfileId: json['hostProfileId'] as String?,
  screenLockExempt: json['screenLockExempt'] as bool? ?? false,
  locationIds: (json['locationIds'] as List<dynamic>?)
      ?.map((e) => e as String)
      .toList(),
  programScope: json['programScope'] as String? ?? 'BOTH',
  isServiceAccount: json['isServiceAccount'] as bool? ?? false,
  tokenVersion: (json['tokenVersion'] as num?)?.toInt() ?? 0,
  mustChangePassword: json['mustChangePassword'] as bool? ?? false,
  moduleAccess:
      (json['moduleAccess'] as Map<String, dynamic>?)?.map(
        (k, e) => MapEntry(k, e as bool),
      ) ??
      const <String, bool>{},
);

Map<String, dynamic> _$SessionUserToJson(_SessionUser instance) =>
    <String, dynamic>{
      'id': instance.id,
      'email': instance.email,
      'fullName': instance.fullName,
      'role': instance.role,
      'tenantId': instance.tenantId,
      'createdByUserId': instance.createdByUserId,
      'hostProfileId': instance.hostProfileId,
      'screenLockExempt': instance.screenLockExempt,
      'locationIds': instance.locationIds,
      'programScope': instance.programScope,
      'isServiceAccount': instance.isServiceAccount,
      'tokenVersion': instance.tokenVersion,
      'mustChangePassword': instance.mustChangePassword,
      'moduleAccess': instance.moduleAccess,
    };

_AuthResponse _$AuthResponseFromJson(Map<String, dynamic> json) =>
    _AuthResponse(
      token: json['token'] as String,
      user: SessionUser.fromJson(json['user'] as Map<String, dynamic>),
    );

Map<String, dynamic> _$AuthResponseToJson(_AuthResponse instance) =>
    <String, dynamic>{'token': instance.token, 'user': instance.user};
