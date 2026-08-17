// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'checkout_session.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

_CheckoutSessionDto _$CheckoutSessionDtoFromJson(Map<String, dynamic> json) =>
    _CheckoutSessionDto(
      id: json['id'] as String,
      reservationId: json['reservationId'] as String,
      agreementId: json['agreementId'] as String?,
      tenantId: json['tenantId'] as String?,
      currentStep: json['currentStep'] as String,
      events: json['events'] as String?,
      tcCompletedAt: const IsoDateTimeConverter().fromJson(
        json['tcCompletedAt'] as String?,
      ),
      paymentCompletedAt: const IsoDateTimeConverter().fromJson(
        json['paymentCompletedAt'] as String?,
      ),
      inspectionCompletedAt: const IsoDateTimeConverter().fromJson(
        json['inspectionCompletedAt'] as String?,
      ),
      customerSignedAt: const IsoDateTimeConverter().fromJson(
        json['customerSignedAt'] as String?,
      ),
      startedAt: const IsoDateTimeConverter().fromJson(
        json['startedAt'] as String?,
      ),
      finishedAt: const IsoDateTimeConverter().fromJson(
        json['finishedAt'] as String?,
      ),
      abandonedAt: const IsoDateTimeConverter().fromJson(
        json['abandonedAt'] as String?,
      ),
      abandonedReason: json['abandonedReason'] as String?,
      autoEmailedAt: const IsoDateTimeConverter().fromJson(
        json['autoEmailedAt'] as String?,
      ),
      startedByUserId: json['startedByUserId'] as String?,
      stateVersion: (json['stateVersion'] as num?)?.toInt(),
      presence: (json['presence'] as List<dynamic>?)
          ?.map((e) => CheckoutPresenceDto.fromJson(e as Map<String, dynamic>))
          .toList(),
    );

Map<String, dynamic> _$CheckoutSessionDtoToJson(
  _CheckoutSessionDto instance,
) => <String, dynamic>{
  'id': instance.id,
  'reservationId': instance.reservationId,
  'agreementId': instance.agreementId,
  'tenantId': instance.tenantId,
  'currentStep': instance.currentStep,
  'events': instance.events,
  'tcCompletedAt': const IsoDateTimeConverter().toJson(instance.tcCompletedAt),
  'paymentCompletedAt': const IsoDateTimeConverter().toJson(
    instance.paymentCompletedAt,
  ),
  'inspectionCompletedAt': const IsoDateTimeConverter().toJson(
    instance.inspectionCompletedAt,
  ),
  'customerSignedAt': const IsoDateTimeConverter().toJson(
    instance.customerSignedAt,
  ),
  'startedAt': const IsoDateTimeConverter().toJson(instance.startedAt),
  'finishedAt': const IsoDateTimeConverter().toJson(instance.finishedAt),
  'abandonedAt': const IsoDateTimeConverter().toJson(instance.abandonedAt),
  'abandonedReason': instance.abandonedReason,
  'autoEmailedAt': const IsoDateTimeConverter().toJson(instance.autoEmailedAt),
  'startedByUserId': instance.startedByUserId,
  'stateVersion': instance.stateVersion,
  'presence': instance.presence,
};

_CheckoutPresenceDto _$CheckoutPresenceDtoFromJson(Map<String, dynamic> json) =>
    _CheckoutPresenceDto(
      surface: json['surface'] as String? ?? '',
      displayName: json['displayName'] as String? ?? '',
      lastSeenAt: const IsoDateTimeConverter().fromJson(
        json['lastSeenAt'] as String?,
      ),
      actorUserId: json['actorUserId'] as String?,
    );

Map<String, dynamic> _$CheckoutPresenceDtoToJson(
  _CheckoutPresenceDto instance,
) => <String, dynamic>{
  'surface': instance.surface,
  'displayName': instance.displayName,
  'lastSeenAt': const IsoDateTimeConverter().toJson(instance.lastSeenAt),
  'actorUserId': instance.actorUserId,
};
