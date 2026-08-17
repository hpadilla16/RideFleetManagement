import 'package:freezed_annotation/freezed_annotation.dart';

import 'json_converters.dart';

part 'reservation_card.freezed.dart';
part 'reservation_card.g.dart';

/// `reservationCard` del dashboard (employee-app.service.js:66-122). Es la
/// unidad de las 8 colas de reservas y de searchResults.
@freezed
abstract class ReservationCard with _$ReservationCard {
  const factory ReservationCard({
    required String id,
    String? reservationNumber,
    required String status,
    @Default('RENTAL') String workflowMode,
    String? paymentStatus,
    @IsoDateTimeConverter() DateTime? pickupAt,
    @IsoDateTimeConverter() DateTime? returnAt,
    @FlexibleDoubleConverter() double? estimatedTotal,
    @IsoDateTimeConverter() DateTime? readyForPickupAt,
    @IsoDateTimeConverter() DateTime? customerInfoCompletedAt,
    @IsoDateTimeConverter() DateTime? customerInfoReviewedAt,
    @IsoDateTimeConverter() DateTime? estimatedServiceCompletionAt,
    @Default('') String repairOrderNumber,
    @Default('') String claimNumber,
    @Default('') String serviceAdvisorName,
    @Default('') String loanerBillingMode,
    @Default('') String loanerBillingStatus,
    @IsoDateTimeConverter() DateTime? loanerBorrowerPacketCompletedAt,
    @Default(false) bool loanerReturnExceptionFlag,
    CustomerCard? customer,
    VehicleCard? vehicle,
    VehicleTypeCard? vehicleType,
  }) = _ReservationCard;

  factory ReservationCard.fromJson(Map<String, dynamic> json) =>
      _$ReservationCardFromJson(json);
}

@freezed
abstract class CustomerCard with _$CustomerCard {
  const factory CustomerCard({
    required String id,
    String? firstName,
    String? lastName,
    String? email,
    String? phone,
  }) = _CustomerCard;

  factory CustomerCard.fromJson(Map<String, dynamic> json) =>
      _$CustomerCardFromJson(json);
}

@freezed
abstract class VehicleCard with _$VehicleCard {
  const factory VehicleCard({
    required String id,
    String? make,
    String? model,
    int? year,
    String? internalNumber,

    /// El servidor ya hace fallback `plate || licensePlate || ''`.
    @Default('') String plate,
  }) = _VehicleCard;

  factory VehicleCard.fromJson(Map<String, dynamic> json) =>
      _$VehicleCardFromJson(json);
}

@freezed
abstract class VehicleTypeCard with _$VehicleTypeCard {
  const factory VehicleTypeCard({
    required String id,
    String? name,
  }) = _VehicleTypeCard;

  factory VehicleTypeCard.fromJson(Map<String, dynamic> json) =>
      _$VehicleTypeCardFromJson(json);
}
