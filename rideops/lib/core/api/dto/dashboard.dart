import 'package:freezed_annotation/freezed_annotation.dart';

import 'json_converters.dart';
import 'reservation_card.dart';

part 'dashboard.freezed.dart';
part 'dashboard.g.dart';

/// `GET /api/employee-app/dashboard[?q=]` — payload completo
/// (employee-app.service.js:451-497): 11 métricas, 9 colas, bloque self con
/// comisiones y searchResults.
@freezed
abstract class DashboardPayload with _$DashboardPayload {
  const factory DashboardPayload({
    @Default('') String query,
    SelfBlock? self,
    required DashboardMetrics metrics,
    required DashboardQueues queues,
    @Default(<ReservationCard>[]) List<ReservationCard> searchResults,
  }) = _DashboardPayload;

  factory DashboardPayload.fromJson(Map<String, dynamic> json) =>
      _$DashboardPayloadFromJson(json);
}

@freezed
abstract class DashboardMetrics with _$DashboardMetrics {
  const factory DashboardMetrics({
    @Default(0) int openReservations,
    @Default(0) int activeRentals,
    @Default(0) int precheckinQueue,
    @Default(0) int readyForPickup,
    @Default(0) int dueBackToday,
    @Default(0) int loanerOpen,
    @Default(0) int loanerReady,
    @Default(0) int loanerBillingAttention,
    @Default(0) int loanerOverdue,
    @Default(0) int issueOpen,
    @Default(0) int issueUnderReview,
  }) = _DashboardMetrics;

  factory DashboardMetrics.fromJson(Map<String, dynamic> json) =>
      _$DashboardMetricsFromJson(json);
}

@freezed
abstract class DashboardQueues with _$DashboardQueues {
  const factory DashboardQueues({
    @Default(<ReservationCard>[]) List<ReservationCard> precheckin,
    @Default(<ReservationCard>[]) List<ReservationCard> checkout,
    @Default(<ReservationCard>[]) List<ReservationCard> returns,
    @Default(<ReservationCard>[]) List<ReservationCard> active,
    @Default(<ReservationCard>[]) List<ReservationCard> loanerReady,
    @Default(<ReservationCard>[]) List<ReservationCard> loanerAdvisorFollowup,
    @Default(<ReservationCard>[]) List<ReservationCard> loanerBillingReview,
    @Default(<ReservationCard>[]) List<ReservationCard> loanerReturns,
    @Default(<IncidentCard>[]) List<IncidentCard> issueEscalations,
  }) = _DashboardQueues;

  factory DashboardQueues.fromJson(Map<String, dynamic> json) =>
      _$DashboardQueuesFromJson(json);
}

/// `incidentCard` (employee-app.service.js:124-160).
@freezed
abstract class IncidentCard with _$IncidentCard {
  const factory IncidentCard({
    required String id,
    String? type,
    String? status,
    String? title,
    @Default('') String description,
    @FlexibleDoubleConverter() double? amountClaimed,
    @FlexibleDoubleConverter() double? amountResolved,
    @IsoDateTimeConverter() DateTime? createdAt,
    @IsoDateTimeConverter() DateTime? updatedAt,
  }) = _IncidentCard;

  factory IncidentCard.fromJson(Map<String, dynamic> json) =>
      _$IncidentCardFromJson(json);
}

@freezed
abstract class SelfBlock with _$SelfBlock {
  const factory SelfBlock({
    SelfProfile? profile,
    CommissionSummary? commissions,
  }) = _SelfBlock;

  factory SelfBlock.fromJson(Map<String, dynamic> json) =>
      _$SelfBlockFromJson(json);
}

@freezed
abstract class SelfProfile with _$SelfProfile {
  const factory SelfProfile({
    required String id,
    String? fullName,
    String? email,
    String? role,
    @Default(true) bool isActive,
  }) = _SelfProfile;

  factory SelfProfile.fromJson(Map<String, dynamic> json) =>
      _$SelfProfileFromJson(json);
}

@freezed
abstract class CommissionSummary with _$CommissionSummary {
  const factory CommissionSummary({
    String? monthKey,
    @FlexibleDoubleConverter() double? commissionAmount,
    @Default(0) int agreements,
    @Default(0) int pending,
    @Default(0) int approved,
    @Default(0) int paid,
  }) = _CommissionSummary;

  factory CommissionSummary.fromJson(Map<String, dynamic> json) =>
      _$CommissionSummaryFromJson(json);
}
