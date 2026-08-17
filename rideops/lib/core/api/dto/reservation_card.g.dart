// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'reservation_card.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

_ReservationCard _$ReservationCardFromJson(
  Map<String, dynamic> json,
) => _ReservationCard(
  id: json['id'] as String,
  reservationNumber: json['reservationNumber'] as String?,
  status: json['status'] as String,
  workflowMode: json['workflowMode'] as String? ?? 'RENTAL',
  paymentStatus: json['paymentStatus'] as String?,
  pickupAt: const IsoDateTimeConverter().fromJson(json['pickupAt'] as String?),
  returnAt: const IsoDateTimeConverter().fromJson(json['returnAt'] as String?),
  estimatedTotal: const FlexibleDoubleConverter().fromJson(
    json['estimatedTotal'],
  ),
  readyForPickupAt: const IsoDateTimeConverter().fromJson(
    json['readyForPickupAt'] as String?,
  ),
  customerInfoCompletedAt: const IsoDateTimeConverter().fromJson(
    json['customerInfoCompletedAt'] as String?,
  ),
  customerInfoReviewedAt: const IsoDateTimeConverter().fromJson(
    json['customerInfoReviewedAt'] as String?,
  ),
  estimatedServiceCompletionAt: const IsoDateTimeConverter().fromJson(
    json['estimatedServiceCompletionAt'] as String?,
  ),
  repairOrderNumber: json['repairOrderNumber'] as String? ?? '',
  claimNumber: json['claimNumber'] as String? ?? '',
  serviceAdvisorName: json['serviceAdvisorName'] as String? ?? '',
  loanerBillingMode: json['loanerBillingMode'] as String? ?? '',
  loanerBillingStatus: json['loanerBillingStatus'] as String? ?? '',
  loanerBorrowerPacketCompletedAt: const IsoDateTimeConverter().fromJson(
    json['loanerBorrowerPacketCompletedAt'] as String?,
  ),
  loanerReturnExceptionFlag:
      json['loanerReturnExceptionFlag'] as bool? ?? false,
  customer: json['customer'] == null
      ? null
      : CustomerCard.fromJson(json['customer'] as Map<String, dynamic>),
  vehicle: json['vehicle'] == null
      ? null
      : VehicleCard.fromJson(json['vehicle'] as Map<String, dynamic>),
  vehicleType: json['vehicleType'] == null
      ? null
      : VehicleTypeCard.fromJson(json['vehicleType'] as Map<String, dynamic>),
);

Map<String, dynamic> _$ReservationCardToJson(_ReservationCard instance) =>
    <String, dynamic>{
      'id': instance.id,
      'reservationNumber': instance.reservationNumber,
      'status': instance.status,
      'workflowMode': instance.workflowMode,
      'paymentStatus': instance.paymentStatus,
      'pickupAt': const IsoDateTimeConverter().toJson(instance.pickupAt),
      'returnAt': const IsoDateTimeConverter().toJson(instance.returnAt),
      'estimatedTotal': const FlexibleDoubleConverter().toJson(
        instance.estimatedTotal,
      ),
      'readyForPickupAt': const IsoDateTimeConverter().toJson(
        instance.readyForPickupAt,
      ),
      'customerInfoCompletedAt': const IsoDateTimeConverter().toJson(
        instance.customerInfoCompletedAt,
      ),
      'customerInfoReviewedAt': const IsoDateTimeConverter().toJson(
        instance.customerInfoReviewedAt,
      ),
      'estimatedServiceCompletionAt': const IsoDateTimeConverter().toJson(
        instance.estimatedServiceCompletionAt,
      ),
      'repairOrderNumber': instance.repairOrderNumber,
      'claimNumber': instance.claimNumber,
      'serviceAdvisorName': instance.serviceAdvisorName,
      'loanerBillingMode': instance.loanerBillingMode,
      'loanerBillingStatus': instance.loanerBillingStatus,
      'loanerBorrowerPacketCompletedAt': const IsoDateTimeConverter().toJson(
        instance.loanerBorrowerPacketCompletedAt,
      ),
      'loanerReturnExceptionFlag': instance.loanerReturnExceptionFlag,
      'customer': instance.customer,
      'vehicle': instance.vehicle,
      'vehicleType': instance.vehicleType,
    };

_CustomerCard _$CustomerCardFromJson(Map<String, dynamic> json) =>
    _CustomerCard(
      id: json['id'] as String,
      firstName: json['firstName'] as String?,
      lastName: json['lastName'] as String?,
      email: json['email'] as String?,
      phone: json['phone'] as String?,
    );

Map<String, dynamic> _$CustomerCardToJson(_CustomerCard instance) =>
    <String, dynamic>{
      'id': instance.id,
      'firstName': instance.firstName,
      'lastName': instance.lastName,
      'email': instance.email,
      'phone': instance.phone,
    };

_VehicleCard _$VehicleCardFromJson(Map<String, dynamic> json) => _VehicleCard(
  id: json['id'] as String,
  make: json['make'] as String?,
  model: json['model'] as String?,
  year: (json['year'] as num?)?.toInt(),
  internalNumber: json['internalNumber'] as String?,
  plate: json['plate'] as String? ?? '',
);

Map<String, dynamic> _$VehicleCardToJson(_VehicleCard instance) =>
    <String, dynamic>{
      'id': instance.id,
      'make': instance.make,
      'model': instance.model,
      'year': instance.year,
      'internalNumber': instance.internalNumber,
      'plate': instance.plate,
    };

_VehicleTypeCard _$VehicleTypeCardFromJson(Map<String, dynamic> json) =>
    _VehicleTypeCard(id: json['id'] as String, name: json['name'] as String?);

Map<String, dynamic> _$VehicleTypeCardToJson(_VehicleTypeCard instance) =>
    <String, dynamic>{'id': instance.id, 'name': instance.name};
