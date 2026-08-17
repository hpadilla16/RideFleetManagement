// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'dashboard.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

_DashboardPayload _$DashboardPayloadFromJson(Map<String, dynamic> json) =>
    _DashboardPayload(
      query: json['query'] as String? ?? '',
      self: json['self'] == null
          ? null
          : SelfBlock.fromJson(json['self'] as Map<String, dynamic>),
      metrics: DashboardMetrics.fromJson(
        json['metrics'] as Map<String, dynamic>,
      ),
      queues: DashboardQueues.fromJson(json['queues'] as Map<String, dynamic>),
      searchResults:
          (json['searchResults'] as List<dynamic>?)
              ?.map((e) => ReservationCard.fromJson(e as Map<String, dynamic>))
              .toList() ??
          const <ReservationCard>[],
    );

Map<String, dynamic> _$DashboardPayloadToJson(_DashboardPayload instance) =>
    <String, dynamic>{
      'query': instance.query,
      'self': instance.self,
      'metrics': instance.metrics,
      'queues': instance.queues,
      'searchResults': instance.searchResults,
    };

_DashboardMetrics _$DashboardMetricsFromJson(Map<String, dynamic> json) =>
    _DashboardMetrics(
      openReservations: (json['openReservations'] as num?)?.toInt() ?? 0,
      activeRentals: (json['activeRentals'] as num?)?.toInt() ?? 0,
      precheckinQueue: (json['precheckinQueue'] as num?)?.toInt() ?? 0,
      readyForPickup: (json['readyForPickup'] as num?)?.toInt() ?? 0,
      dueBackToday: (json['dueBackToday'] as num?)?.toInt() ?? 0,
      loanerOpen: (json['loanerOpen'] as num?)?.toInt() ?? 0,
      loanerReady: (json['loanerReady'] as num?)?.toInt() ?? 0,
      loanerBillingAttention:
          (json['loanerBillingAttention'] as num?)?.toInt() ?? 0,
      loanerOverdue: (json['loanerOverdue'] as num?)?.toInt() ?? 0,
      issueOpen: (json['issueOpen'] as num?)?.toInt() ?? 0,
      issueUnderReview: (json['issueUnderReview'] as num?)?.toInt() ?? 0,
    );

Map<String, dynamic> _$DashboardMetricsToJson(_DashboardMetrics instance) =>
    <String, dynamic>{
      'openReservations': instance.openReservations,
      'activeRentals': instance.activeRentals,
      'precheckinQueue': instance.precheckinQueue,
      'readyForPickup': instance.readyForPickup,
      'dueBackToday': instance.dueBackToday,
      'loanerOpen': instance.loanerOpen,
      'loanerReady': instance.loanerReady,
      'loanerBillingAttention': instance.loanerBillingAttention,
      'loanerOverdue': instance.loanerOverdue,
      'issueOpen': instance.issueOpen,
      'issueUnderReview': instance.issueUnderReview,
    };

_DashboardQueues _$DashboardQueuesFromJson(Map<String, dynamic> json) =>
    _DashboardQueues(
      precheckin:
          (json['precheckin'] as List<dynamic>?)
              ?.map((e) => ReservationCard.fromJson(e as Map<String, dynamic>))
              .toList() ??
          const <ReservationCard>[],
      checkout:
          (json['checkout'] as List<dynamic>?)
              ?.map((e) => ReservationCard.fromJson(e as Map<String, dynamic>))
              .toList() ??
          const <ReservationCard>[],
      returns:
          (json['returns'] as List<dynamic>?)
              ?.map((e) => ReservationCard.fromJson(e as Map<String, dynamic>))
              .toList() ??
          const <ReservationCard>[],
      active:
          (json['active'] as List<dynamic>?)
              ?.map((e) => ReservationCard.fromJson(e as Map<String, dynamic>))
              .toList() ??
          const <ReservationCard>[],
      loanerReady:
          (json['loanerReady'] as List<dynamic>?)
              ?.map((e) => ReservationCard.fromJson(e as Map<String, dynamic>))
              .toList() ??
          const <ReservationCard>[],
      loanerAdvisorFollowup:
          (json['loanerAdvisorFollowup'] as List<dynamic>?)
              ?.map((e) => ReservationCard.fromJson(e as Map<String, dynamic>))
              .toList() ??
          const <ReservationCard>[],
      loanerBillingReview:
          (json['loanerBillingReview'] as List<dynamic>?)
              ?.map((e) => ReservationCard.fromJson(e as Map<String, dynamic>))
              .toList() ??
          const <ReservationCard>[],
      loanerReturns:
          (json['loanerReturns'] as List<dynamic>?)
              ?.map((e) => ReservationCard.fromJson(e as Map<String, dynamic>))
              .toList() ??
          const <ReservationCard>[],
      issueEscalations:
          (json['issueEscalations'] as List<dynamic>?)
              ?.map((e) => IncidentCard.fromJson(e as Map<String, dynamic>))
              .toList() ??
          const <IncidentCard>[],
    );

Map<String, dynamic> _$DashboardQueuesToJson(_DashboardQueues instance) =>
    <String, dynamic>{
      'precheckin': instance.precheckin,
      'checkout': instance.checkout,
      'returns': instance.returns,
      'active': instance.active,
      'loanerReady': instance.loanerReady,
      'loanerAdvisorFollowup': instance.loanerAdvisorFollowup,
      'loanerBillingReview': instance.loanerBillingReview,
      'loanerReturns': instance.loanerReturns,
      'issueEscalations': instance.issueEscalations,
    };

_IncidentCard _$IncidentCardFromJson(Map<String, dynamic> json) =>
    _IncidentCard(
      id: json['id'] as String,
      type: json['type'] as String?,
      status: json['status'] as String?,
      title: json['title'] as String?,
      description: json['description'] as String? ?? '',
      amountClaimed: const FlexibleDoubleConverter().fromJson(
        json['amountClaimed'],
      ),
      amountResolved: const FlexibleDoubleConverter().fromJson(
        json['amountResolved'],
      ),
      createdAt: const IsoDateTimeConverter().fromJson(
        json['createdAt'] as String?,
      ),
      updatedAt: const IsoDateTimeConverter().fromJson(
        json['updatedAt'] as String?,
      ),
    );

Map<String, dynamic> _$IncidentCardToJson(_IncidentCard instance) =>
    <String, dynamic>{
      'id': instance.id,
      'type': instance.type,
      'status': instance.status,
      'title': instance.title,
      'description': instance.description,
      'amountClaimed': const FlexibleDoubleConverter().toJson(
        instance.amountClaimed,
      ),
      'amountResolved': const FlexibleDoubleConverter().toJson(
        instance.amountResolved,
      ),
      'createdAt': const IsoDateTimeConverter().toJson(instance.createdAt),
      'updatedAt': const IsoDateTimeConverter().toJson(instance.updatedAt),
    };

_SelfBlock _$SelfBlockFromJson(Map<String, dynamic> json) => _SelfBlock(
  profile: json['profile'] == null
      ? null
      : SelfProfile.fromJson(json['profile'] as Map<String, dynamic>),
  commissions: json['commissions'] == null
      ? null
      : CommissionSummary.fromJson(json['commissions'] as Map<String, dynamic>),
);

Map<String, dynamic> _$SelfBlockToJson(_SelfBlock instance) =>
    <String, dynamic>{
      'profile': instance.profile,
      'commissions': instance.commissions,
    };

_SelfProfile _$SelfProfileFromJson(Map<String, dynamic> json) => _SelfProfile(
  id: json['id'] as String,
  fullName: json['fullName'] as String?,
  email: json['email'] as String?,
  role: json['role'] as String?,
  isActive: json['isActive'] as bool? ?? true,
);

Map<String, dynamic> _$SelfProfileToJson(_SelfProfile instance) =>
    <String, dynamic>{
      'id': instance.id,
      'fullName': instance.fullName,
      'email': instance.email,
      'role': instance.role,
      'isActive': instance.isActive,
    };

_CommissionSummary _$CommissionSummaryFromJson(Map<String, dynamic> json) =>
    _CommissionSummary(
      monthKey: json['monthKey'] as String?,
      commissionAmount: const FlexibleDoubleConverter().fromJson(
        json['commissionAmount'],
      ),
      agreements: (json['agreements'] as num?)?.toInt() ?? 0,
      pending: (json['pending'] as num?)?.toInt() ?? 0,
      approved: (json['approved'] as num?)?.toInt() ?? 0,
      paid: (json['paid'] as num?)?.toInt() ?? 0,
    );

Map<String, dynamic> _$CommissionSummaryToJson(_CommissionSummary instance) =>
    <String, dynamic>{
      'monthKey': instance.monthKey,
      'commissionAmount': const FlexibleDoubleConverter().toJson(
        instance.commissionAmount,
      ),
      'agreements': instance.agreements,
      'pending': instance.pending,
      'approved': instance.approved,
      'paid': instance.paid,
    };
