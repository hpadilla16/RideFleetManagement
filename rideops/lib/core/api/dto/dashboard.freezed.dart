// GENERATED CODE - DO NOT MODIFY BY HAND
// coverage:ignore-file
// ignore_for_file: type=lint
// ignore_for_file: unused_element, deprecated_member_use, deprecated_member_use_from_same_package, use_function_type_syntax_for_parameters, unnecessary_const, avoid_init_to_null, invalid_override_different_default_values_named, prefer_expression_function_bodies, annotate_overrides, invalid_annotation_target, unnecessary_question_mark

part of 'dashboard.dart';

// **************************************************************************
// FreezedGenerator
// **************************************************************************

// dart format off
T _$identity<T>(T value) => value;

/// @nodoc
mixin _$DashboardPayload {

 String get query; SelfBlock? get self; DashboardMetrics get metrics; DashboardQueues get queues; List<ReservationCard> get searchResults;
/// Create a copy of DashboardPayload
/// with the given fields replaced by the non-null parameter values.
@JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
$DashboardPayloadCopyWith<DashboardPayload> get copyWith => _$DashboardPayloadCopyWithImpl<DashboardPayload>(this as DashboardPayload, _$identity);

  /// Serializes this DashboardPayload to a JSON map.
  Map<String, dynamic> toJson();


@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is DashboardPayload&&(identical(other.query, query) || other.query == query)&&(identical(other.self, self) || other.self == self)&&(identical(other.metrics, metrics) || other.metrics == metrics)&&(identical(other.queues, queues) || other.queues == queues)&&const DeepCollectionEquality().equals(other.searchResults, searchResults));
}

@JsonKey(includeFromJson: false, includeToJson: false)
@override
int get hashCode => Object.hash(runtimeType,query,self,metrics,queues,const DeepCollectionEquality().hash(searchResults));

@override
String toString() {
  return 'DashboardPayload(query: $query, self: $self, metrics: $metrics, queues: $queues, searchResults: $searchResults)';
}


}

/// @nodoc
abstract mixin class $DashboardPayloadCopyWith<$Res>  {
  factory $DashboardPayloadCopyWith(DashboardPayload value, $Res Function(DashboardPayload) _then) = _$DashboardPayloadCopyWithImpl;
@useResult
$Res call({
 String query, SelfBlock? self, DashboardMetrics metrics, DashboardQueues queues, List<ReservationCard> searchResults
});


$SelfBlockCopyWith<$Res>? get self;$DashboardMetricsCopyWith<$Res> get metrics;$DashboardQueuesCopyWith<$Res> get queues;

}
/// @nodoc
class _$DashboardPayloadCopyWithImpl<$Res>
    implements $DashboardPayloadCopyWith<$Res> {
  _$DashboardPayloadCopyWithImpl(this._self, this._then);

  final DashboardPayload _self;
  final $Res Function(DashboardPayload) _then;

/// Create a copy of DashboardPayload
/// with the given fields replaced by the non-null parameter values.
@pragma('vm:prefer-inline') @override $Res call({Object? query = null,Object? self = freezed,Object? metrics = null,Object? queues = null,Object? searchResults = null,}) {
  return _then(_self.copyWith(
query: null == query ? _self.query : query // ignore: cast_nullable_to_non_nullable
as String,self: freezed == self ? _self.self : self // ignore: cast_nullable_to_non_nullable
as SelfBlock?,metrics: null == metrics ? _self.metrics : metrics // ignore: cast_nullable_to_non_nullable
as DashboardMetrics,queues: null == queues ? _self.queues : queues // ignore: cast_nullable_to_non_nullable
as DashboardQueues,searchResults: null == searchResults ? _self.searchResults : searchResults // ignore: cast_nullable_to_non_nullable
as List<ReservationCard>,
  ));
}
/// Create a copy of DashboardPayload
/// with the given fields replaced by the non-null parameter values.
@override
@pragma('vm:prefer-inline')
$SelfBlockCopyWith<$Res>? get self {
    if (_self.self == null) {
    return null;
  }

  return $SelfBlockCopyWith<$Res>(_self.self!, (value) {
    return _then(_self.copyWith(self: value));
  });
}/// Create a copy of DashboardPayload
/// with the given fields replaced by the non-null parameter values.
@override
@pragma('vm:prefer-inline')
$DashboardMetricsCopyWith<$Res> get metrics {
  
  return $DashboardMetricsCopyWith<$Res>(_self.metrics, (value) {
    return _then(_self.copyWith(metrics: value));
  });
}/// Create a copy of DashboardPayload
/// with the given fields replaced by the non-null parameter values.
@override
@pragma('vm:prefer-inline')
$DashboardQueuesCopyWith<$Res> get queues {
  
  return $DashboardQueuesCopyWith<$Res>(_self.queues, (value) {
    return _then(_self.copyWith(queues: value));
  });
}
}


/// Adds pattern-matching-related methods to [DashboardPayload].
extension DashboardPayloadPatterns on DashboardPayload {
/// A variant of `map` that fallback to returning `orElse`.
///
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case final Subclass value:
///     return ...;
///   case _:
///     return orElse();
/// }
/// ```

@optionalTypeArgs TResult maybeMap<TResult extends Object?>(TResult Function( _DashboardPayload value)?  $default,{required TResult orElse(),}){
final _that = this;
switch (_that) {
case _DashboardPayload() when $default != null:
return $default(_that);case _:
  return orElse();

}
}
/// A `switch`-like method, using callbacks.
///
/// Callbacks receives the raw object, upcasted.
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case final Subclass value:
///     return ...;
///   case final Subclass2 value:
///     return ...;
/// }
/// ```

@optionalTypeArgs TResult map<TResult extends Object?>(TResult Function( _DashboardPayload value)  $default,){
final _that = this;
switch (_that) {
case _DashboardPayload():
return $default(_that);case _:
  throw StateError('Unexpected subclass');

}
}
/// A variant of `map` that fallback to returning `null`.
///
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case final Subclass value:
///     return ...;
///   case _:
///     return null;
/// }
/// ```

@optionalTypeArgs TResult? mapOrNull<TResult extends Object?>(TResult? Function( _DashboardPayload value)?  $default,){
final _that = this;
switch (_that) {
case _DashboardPayload() when $default != null:
return $default(_that);case _:
  return null;

}
}
/// A variant of `when` that fallback to an `orElse` callback.
///
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case Subclass(:final field):
///     return ...;
///   case _:
///     return orElse();
/// }
/// ```

@optionalTypeArgs TResult maybeWhen<TResult extends Object?>(TResult Function( String query,  SelfBlock? self,  DashboardMetrics metrics,  DashboardQueues queues,  List<ReservationCard> searchResults)?  $default,{required TResult orElse(),}) {final _that = this;
switch (_that) {
case _DashboardPayload() when $default != null:
return $default(_that.query,_that.self,_that.metrics,_that.queues,_that.searchResults);case _:
  return orElse();

}
}
/// A `switch`-like method, using callbacks.
///
/// As opposed to `map`, this offers destructuring.
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case Subclass(:final field):
///     return ...;
///   case Subclass2(:final field2):
///     return ...;
/// }
/// ```

@optionalTypeArgs TResult when<TResult extends Object?>(TResult Function( String query,  SelfBlock? self,  DashboardMetrics metrics,  DashboardQueues queues,  List<ReservationCard> searchResults)  $default,) {final _that = this;
switch (_that) {
case _DashboardPayload():
return $default(_that.query,_that.self,_that.metrics,_that.queues,_that.searchResults);case _:
  throw StateError('Unexpected subclass');

}
}
/// A variant of `when` that fallback to returning `null`
///
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case Subclass(:final field):
///     return ...;
///   case _:
///     return null;
/// }
/// ```

@optionalTypeArgs TResult? whenOrNull<TResult extends Object?>(TResult? Function( String query,  SelfBlock? self,  DashboardMetrics metrics,  DashboardQueues queues,  List<ReservationCard> searchResults)?  $default,) {final _that = this;
switch (_that) {
case _DashboardPayload() when $default != null:
return $default(_that.query,_that.self,_that.metrics,_that.queues,_that.searchResults);case _:
  return null;

}
}

}

/// @nodoc
@JsonSerializable()

class _DashboardPayload implements DashboardPayload {
  const _DashboardPayload({this.query = '', this.self, required this.metrics, required this.queues, final  List<ReservationCard> searchResults = const <ReservationCard>[]}): _searchResults = searchResults;
  factory _DashboardPayload.fromJson(Map<String, dynamic> json) => _$DashboardPayloadFromJson(json);

@override@JsonKey() final  String query;
@override final  SelfBlock? self;
@override final  DashboardMetrics metrics;
@override final  DashboardQueues queues;
 final  List<ReservationCard> _searchResults;
@override@JsonKey() List<ReservationCard> get searchResults {
  if (_searchResults is EqualUnmodifiableListView) return _searchResults;
  // ignore: implicit_dynamic_type
  return EqualUnmodifiableListView(_searchResults);
}


/// Create a copy of DashboardPayload
/// with the given fields replaced by the non-null parameter values.
@override @JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
_$DashboardPayloadCopyWith<_DashboardPayload> get copyWith => __$DashboardPayloadCopyWithImpl<_DashboardPayload>(this, _$identity);

@override
Map<String, dynamic> toJson() {
  return _$DashboardPayloadToJson(this, );
}

@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is _DashboardPayload&&(identical(other.query, query) || other.query == query)&&(identical(other.self, self) || other.self == self)&&(identical(other.metrics, metrics) || other.metrics == metrics)&&(identical(other.queues, queues) || other.queues == queues)&&const DeepCollectionEquality().equals(other._searchResults, _searchResults));
}

@JsonKey(includeFromJson: false, includeToJson: false)
@override
int get hashCode => Object.hash(runtimeType,query,self,metrics,queues,const DeepCollectionEquality().hash(_searchResults));

@override
String toString() {
  return 'DashboardPayload(query: $query, self: $self, metrics: $metrics, queues: $queues, searchResults: $searchResults)';
}


}

/// @nodoc
abstract mixin class _$DashboardPayloadCopyWith<$Res> implements $DashboardPayloadCopyWith<$Res> {
  factory _$DashboardPayloadCopyWith(_DashboardPayload value, $Res Function(_DashboardPayload) _then) = __$DashboardPayloadCopyWithImpl;
@override @useResult
$Res call({
 String query, SelfBlock? self, DashboardMetrics metrics, DashboardQueues queues, List<ReservationCard> searchResults
});


@override $SelfBlockCopyWith<$Res>? get self;@override $DashboardMetricsCopyWith<$Res> get metrics;@override $DashboardQueuesCopyWith<$Res> get queues;

}
/// @nodoc
class __$DashboardPayloadCopyWithImpl<$Res>
    implements _$DashboardPayloadCopyWith<$Res> {
  __$DashboardPayloadCopyWithImpl(this._self, this._then);

  final _DashboardPayload _self;
  final $Res Function(_DashboardPayload) _then;

/// Create a copy of DashboardPayload
/// with the given fields replaced by the non-null parameter values.
@override @pragma('vm:prefer-inline') $Res call({Object? query = null,Object? self = freezed,Object? metrics = null,Object? queues = null,Object? searchResults = null,}) {
  return _then(_DashboardPayload(
query: null == query ? _self.query : query // ignore: cast_nullable_to_non_nullable
as String,self: freezed == self ? _self.self : self // ignore: cast_nullable_to_non_nullable
as SelfBlock?,metrics: null == metrics ? _self.metrics : metrics // ignore: cast_nullable_to_non_nullable
as DashboardMetrics,queues: null == queues ? _self.queues : queues // ignore: cast_nullable_to_non_nullable
as DashboardQueues,searchResults: null == searchResults ? _self._searchResults : searchResults // ignore: cast_nullable_to_non_nullable
as List<ReservationCard>,
  ));
}

/// Create a copy of DashboardPayload
/// with the given fields replaced by the non-null parameter values.
@override
@pragma('vm:prefer-inline')
$SelfBlockCopyWith<$Res>? get self {
    if (_self.self == null) {
    return null;
  }

  return $SelfBlockCopyWith<$Res>(_self.self!, (value) {
    return _then(_self.copyWith(self: value));
  });
}/// Create a copy of DashboardPayload
/// with the given fields replaced by the non-null parameter values.
@override
@pragma('vm:prefer-inline')
$DashboardMetricsCopyWith<$Res> get metrics {
  
  return $DashboardMetricsCopyWith<$Res>(_self.metrics, (value) {
    return _then(_self.copyWith(metrics: value));
  });
}/// Create a copy of DashboardPayload
/// with the given fields replaced by the non-null parameter values.
@override
@pragma('vm:prefer-inline')
$DashboardQueuesCopyWith<$Res> get queues {
  
  return $DashboardQueuesCopyWith<$Res>(_self.queues, (value) {
    return _then(_self.copyWith(queues: value));
  });
}
}


/// @nodoc
mixin _$DashboardMetrics {

 int get openReservations; int get activeRentals; int get precheckinQueue; int get readyForPickup; int get dueBackToday; int get loanerOpen; int get loanerReady; int get loanerBillingAttention; int get loanerOverdue; int get issueOpen; int get issueUnderReview;
/// Create a copy of DashboardMetrics
/// with the given fields replaced by the non-null parameter values.
@JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
$DashboardMetricsCopyWith<DashboardMetrics> get copyWith => _$DashboardMetricsCopyWithImpl<DashboardMetrics>(this as DashboardMetrics, _$identity);

  /// Serializes this DashboardMetrics to a JSON map.
  Map<String, dynamic> toJson();


@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is DashboardMetrics&&(identical(other.openReservations, openReservations) || other.openReservations == openReservations)&&(identical(other.activeRentals, activeRentals) || other.activeRentals == activeRentals)&&(identical(other.precheckinQueue, precheckinQueue) || other.precheckinQueue == precheckinQueue)&&(identical(other.readyForPickup, readyForPickup) || other.readyForPickup == readyForPickup)&&(identical(other.dueBackToday, dueBackToday) || other.dueBackToday == dueBackToday)&&(identical(other.loanerOpen, loanerOpen) || other.loanerOpen == loanerOpen)&&(identical(other.loanerReady, loanerReady) || other.loanerReady == loanerReady)&&(identical(other.loanerBillingAttention, loanerBillingAttention) || other.loanerBillingAttention == loanerBillingAttention)&&(identical(other.loanerOverdue, loanerOverdue) || other.loanerOverdue == loanerOverdue)&&(identical(other.issueOpen, issueOpen) || other.issueOpen == issueOpen)&&(identical(other.issueUnderReview, issueUnderReview) || other.issueUnderReview == issueUnderReview));
}

@JsonKey(includeFromJson: false, includeToJson: false)
@override
int get hashCode => Object.hash(runtimeType,openReservations,activeRentals,precheckinQueue,readyForPickup,dueBackToday,loanerOpen,loanerReady,loanerBillingAttention,loanerOverdue,issueOpen,issueUnderReview);

@override
String toString() {
  return 'DashboardMetrics(openReservations: $openReservations, activeRentals: $activeRentals, precheckinQueue: $precheckinQueue, readyForPickup: $readyForPickup, dueBackToday: $dueBackToday, loanerOpen: $loanerOpen, loanerReady: $loanerReady, loanerBillingAttention: $loanerBillingAttention, loanerOverdue: $loanerOverdue, issueOpen: $issueOpen, issueUnderReview: $issueUnderReview)';
}


}

/// @nodoc
abstract mixin class $DashboardMetricsCopyWith<$Res>  {
  factory $DashboardMetricsCopyWith(DashboardMetrics value, $Res Function(DashboardMetrics) _then) = _$DashboardMetricsCopyWithImpl;
@useResult
$Res call({
 int openReservations, int activeRentals, int precheckinQueue, int readyForPickup, int dueBackToday, int loanerOpen, int loanerReady, int loanerBillingAttention, int loanerOverdue, int issueOpen, int issueUnderReview
});




}
/// @nodoc
class _$DashboardMetricsCopyWithImpl<$Res>
    implements $DashboardMetricsCopyWith<$Res> {
  _$DashboardMetricsCopyWithImpl(this._self, this._then);

  final DashboardMetrics _self;
  final $Res Function(DashboardMetrics) _then;

/// Create a copy of DashboardMetrics
/// with the given fields replaced by the non-null parameter values.
@pragma('vm:prefer-inline') @override $Res call({Object? openReservations = null,Object? activeRentals = null,Object? precheckinQueue = null,Object? readyForPickup = null,Object? dueBackToday = null,Object? loanerOpen = null,Object? loanerReady = null,Object? loanerBillingAttention = null,Object? loanerOverdue = null,Object? issueOpen = null,Object? issueUnderReview = null,}) {
  return _then(_self.copyWith(
openReservations: null == openReservations ? _self.openReservations : openReservations // ignore: cast_nullable_to_non_nullable
as int,activeRentals: null == activeRentals ? _self.activeRentals : activeRentals // ignore: cast_nullable_to_non_nullable
as int,precheckinQueue: null == precheckinQueue ? _self.precheckinQueue : precheckinQueue // ignore: cast_nullable_to_non_nullable
as int,readyForPickup: null == readyForPickup ? _self.readyForPickup : readyForPickup // ignore: cast_nullable_to_non_nullable
as int,dueBackToday: null == dueBackToday ? _self.dueBackToday : dueBackToday // ignore: cast_nullable_to_non_nullable
as int,loanerOpen: null == loanerOpen ? _self.loanerOpen : loanerOpen // ignore: cast_nullable_to_non_nullable
as int,loanerReady: null == loanerReady ? _self.loanerReady : loanerReady // ignore: cast_nullable_to_non_nullable
as int,loanerBillingAttention: null == loanerBillingAttention ? _self.loanerBillingAttention : loanerBillingAttention // ignore: cast_nullable_to_non_nullable
as int,loanerOverdue: null == loanerOverdue ? _self.loanerOverdue : loanerOverdue // ignore: cast_nullable_to_non_nullable
as int,issueOpen: null == issueOpen ? _self.issueOpen : issueOpen // ignore: cast_nullable_to_non_nullable
as int,issueUnderReview: null == issueUnderReview ? _self.issueUnderReview : issueUnderReview // ignore: cast_nullable_to_non_nullable
as int,
  ));
}

}


/// Adds pattern-matching-related methods to [DashboardMetrics].
extension DashboardMetricsPatterns on DashboardMetrics {
/// A variant of `map` that fallback to returning `orElse`.
///
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case final Subclass value:
///     return ...;
///   case _:
///     return orElse();
/// }
/// ```

@optionalTypeArgs TResult maybeMap<TResult extends Object?>(TResult Function( _DashboardMetrics value)?  $default,{required TResult orElse(),}){
final _that = this;
switch (_that) {
case _DashboardMetrics() when $default != null:
return $default(_that);case _:
  return orElse();

}
}
/// A `switch`-like method, using callbacks.
///
/// Callbacks receives the raw object, upcasted.
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case final Subclass value:
///     return ...;
///   case final Subclass2 value:
///     return ...;
/// }
/// ```

@optionalTypeArgs TResult map<TResult extends Object?>(TResult Function( _DashboardMetrics value)  $default,){
final _that = this;
switch (_that) {
case _DashboardMetrics():
return $default(_that);case _:
  throw StateError('Unexpected subclass');

}
}
/// A variant of `map` that fallback to returning `null`.
///
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case final Subclass value:
///     return ...;
///   case _:
///     return null;
/// }
/// ```

@optionalTypeArgs TResult? mapOrNull<TResult extends Object?>(TResult? Function( _DashboardMetrics value)?  $default,){
final _that = this;
switch (_that) {
case _DashboardMetrics() when $default != null:
return $default(_that);case _:
  return null;

}
}
/// A variant of `when` that fallback to an `orElse` callback.
///
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case Subclass(:final field):
///     return ...;
///   case _:
///     return orElse();
/// }
/// ```

@optionalTypeArgs TResult maybeWhen<TResult extends Object?>(TResult Function( int openReservations,  int activeRentals,  int precheckinQueue,  int readyForPickup,  int dueBackToday,  int loanerOpen,  int loanerReady,  int loanerBillingAttention,  int loanerOverdue,  int issueOpen,  int issueUnderReview)?  $default,{required TResult orElse(),}) {final _that = this;
switch (_that) {
case _DashboardMetrics() when $default != null:
return $default(_that.openReservations,_that.activeRentals,_that.precheckinQueue,_that.readyForPickup,_that.dueBackToday,_that.loanerOpen,_that.loanerReady,_that.loanerBillingAttention,_that.loanerOverdue,_that.issueOpen,_that.issueUnderReview);case _:
  return orElse();

}
}
/// A `switch`-like method, using callbacks.
///
/// As opposed to `map`, this offers destructuring.
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case Subclass(:final field):
///     return ...;
///   case Subclass2(:final field2):
///     return ...;
/// }
/// ```

@optionalTypeArgs TResult when<TResult extends Object?>(TResult Function( int openReservations,  int activeRentals,  int precheckinQueue,  int readyForPickup,  int dueBackToday,  int loanerOpen,  int loanerReady,  int loanerBillingAttention,  int loanerOverdue,  int issueOpen,  int issueUnderReview)  $default,) {final _that = this;
switch (_that) {
case _DashboardMetrics():
return $default(_that.openReservations,_that.activeRentals,_that.precheckinQueue,_that.readyForPickup,_that.dueBackToday,_that.loanerOpen,_that.loanerReady,_that.loanerBillingAttention,_that.loanerOverdue,_that.issueOpen,_that.issueUnderReview);case _:
  throw StateError('Unexpected subclass');

}
}
/// A variant of `when` that fallback to returning `null`
///
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case Subclass(:final field):
///     return ...;
///   case _:
///     return null;
/// }
/// ```

@optionalTypeArgs TResult? whenOrNull<TResult extends Object?>(TResult? Function( int openReservations,  int activeRentals,  int precheckinQueue,  int readyForPickup,  int dueBackToday,  int loanerOpen,  int loanerReady,  int loanerBillingAttention,  int loanerOverdue,  int issueOpen,  int issueUnderReview)?  $default,) {final _that = this;
switch (_that) {
case _DashboardMetrics() when $default != null:
return $default(_that.openReservations,_that.activeRentals,_that.precheckinQueue,_that.readyForPickup,_that.dueBackToday,_that.loanerOpen,_that.loanerReady,_that.loanerBillingAttention,_that.loanerOverdue,_that.issueOpen,_that.issueUnderReview);case _:
  return null;

}
}

}

/// @nodoc
@JsonSerializable()

class _DashboardMetrics implements DashboardMetrics {
  const _DashboardMetrics({this.openReservations = 0, this.activeRentals = 0, this.precheckinQueue = 0, this.readyForPickup = 0, this.dueBackToday = 0, this.loanerOpen = 0, this.loanerReady = 0, this.loanerBillingAttention = 0, this.loanerOverdue = 0, this.issueOpen = 0, this.issueUnderReview = 0});
  factory _DashboardMetrics.fromJson(Map<String, dynamic> json) => _$DashboardMetricsFromJson(json);

@override@JsonKey() final  int openReservations;
@override@JsonKey() final  int activeRentals;
@override@JsonKey() final  int precheckinQueue;
@override@JsonKey() final  int readyForPickup;
@override@JsonKey() final  int dueBackToday;
@override@JsonKey() final  int loanerOpen;
@override@JsonKey() final  int loanerReady;
@override@JsonKey() final  int loanerBillingAttention;
@override@JsonKey() final  int loanerOverdue;
@override@JsonKey() final  int issueOpen;
@override@JsonKey() final  int issueUnderReview;

/// Create a copy of DashboardMetrics
/// with the given fields replaced by the non-null parameter values.
@override @JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
_$DashboardMetricsCopyWith<_DashboardMetrics> get copyWith => __$DashboardMetricsCopyWithImpl<_DashboardMetrics>(this, _$identity);

@override
Map<String, dynamic> toJson() {
  return _$DashboardMetricsToJson(this, );
}

@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is _DashboardMetrics&&(identical(other.openReservations, openReservations) || other.openReservations == openReservations)&&(identical(other.activeRentals, activeRentals) || other.activeRentals == activeRentals)&&(identical(other.precheckinQueue, precheckinQueue) || other.precheckinQueue == precheckinQueue)&&(identical(other.readyForPickup, readyForPickup) || other.readyForPickup == readyForPickup)&&(identical(other.dueBackToday, dueBackToday) || other.dueBackToday == dueBackToday)&&(identical(other.loanerOpen, loanerOpen) || other.loanerOpen == loanerOpen)&&(identical(other.loanerReady, loanerReady) || other.loanerReady == loanerReady)&&(identical(other.loanerBillingAttention, loanerBillingAttention) || other.loanerBillingAttention == loanerBillingAttention)&&(identical(other.loanerOverdue, loanerOverdue) || other.loanerOverdue == loanerOverdue)&&(identical(other.issueOpen, issueOpen) || other.issueOpen == issueOpen)&&(identical(other.issueUnderReview, issueUnderReview) || other.issueUnderReview == issueUnderReview));
}

@JsonKey(includeFromJson: false, includeToJson: false)
@override
int get hashCode => Object.hash(runtimeType,openReservations,activeRentals,precheckinQueue,readyForPickup,dueBackToday,loanerOpen,loanerReady,loanerBillingAttention,loanerOverdue,issueOpen,issueUnderReview);

@override
String toString() {
  return 'DashboardMetrics(openReservations: $openReservations, activeRentals: $activeRentals, precheckinQueue: $precheckinQueue, readyForPickup: $readyForPickup, dueBackToday: $dueBackToday, loanerOpen: $loanerOpen, loanerReady: $loanerReady, loanerBillingAttention: $loanerBillingAttention, loanerOverdue: $loanerOverdue, issueOpen: $issueOpen, issueUnderReview: $issueUnderReview)';
}


}

/// @nodoc
abstract mixin class _$DashboardMetricsCopyWith<$Res> implements $DashboardMetricsCopyWith<$Res> {
  factory _$DashboardMetricsCopyWith(_DashboardMetrics value, $Res Function(_DashboardMetrics) _then) = __$DashboardMetricsCopyWithImpl;
@override @useResult
$Res call({
 int openReservations, int activeRentals, int precheckinQueue, int readyForPickup, int dueBackToday, int loanerOpen, int loanerReady, int loanerBillingAttention, int loanerOverdue, int issueOpen, int issueUnderReview
});




}
/// @nodoc
class __$DashboardMetricsCopyWithImpl<$Res>
    implements _$DashboardMetricsCopyWith<$Res> {
  __$DashboardMetricsCopyWithImpl(this._self, this._then);

  final _DashboardMetrics _self;
  final $Res Function(_DashboardMetrics) _then;

/// Create a copy of DashboardMetrics
/// with the given fields replaced by the non-null parameter values.
@override @pragma('vm:prefer-inline') $Res call({Object? openReservations = null,Object? activeRentals = null,Object? precheckinQueue = null,Object? readyForPickup = null,Object? dueBackToday = null,Object? loanerOpen = null,Object? loanerReady = null,Object? loanerBillingAttention = null,Object? loanerOverdue = null,Object? issueOpen = null,Object? issueUnderReview = null,}) {
  return _then(_DashboardMetrics(
openReservations: null == openReservations ? _self.openReservations : openReservations // ignore: cast_nullable_to_non_nullable
as int,activeRentals: null == activeRentals ? _self.activeRentals : activeRentals // ignore: cast_nullable_to_non_nullable
as int,precheckinQueue: null == precheckinQueue ? _self.precheckinQueue : precheckinQueue // ignore: cast_nullable_to_non_nullable
as int,readyForPickup: null == readyForPickup ? _self.readyForPickup : readyForPickup // ignore: cast_nullable_to_non_nullable
as int,dueBackToday: null == dueBackToday ? _self.dueBackToday : dueBackToday // ignore: cast_nullable_to_non_nullable
as int,loanerOpen: null == loanerOpen ? _self.loanerOpen : loanerOpen // ignore: cast_nullable_to_non_nullable
as int,loanerReady: null == loanerReady ? _self.loanerReady : loanerReady // ignore: cast_nullable_to_non_nullable
as int,loanerBillingAttention: null == loanerBillingAttention ? _self.loanerBillingAttention : loanerBillingAttention // ignore: cast_nullable_to_non_nullable
as int,loanerOverdue: null == loanerOverdue ? _self.loanerOverdue : loanerOverdue // ignore: cast_nullable_to_non_nullable
as int,issueOpen: null == issueOpen ? _self.issueOpen : issueOpen // ignore: cast_nullable_to_non_nullable
as int,issueUnderReview: null == issueUnderReview ? _self.issueUnderReview : issueUnderReview // ignore: cast_nullable_to_non_nullable
as int,
  ));
}


}


/// @nodoc
mixin _$DashboardQueues {

 List<ReservationCard> get precheckin; List<ReservationCard> get checkout; List<ReservationCard> get returns; List<ReservationCard> get active; List<ReservationCard> get loanerReady; List<ReservationCard> get loanerAdvisorFollowup; List<ReservationCard> get loanerBillingReview; List<ReservationCard> get loanerReturns; List<IncidentCard> get issueEscalations;
/// Create a copy of DashboardQueues
/// with the given fields replaced by the non-null parameter values.
@JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
$DashboardQueuesCopyWith<DashboardQueues> get copyWith => _$DashboardQueuesCopyWithImpl<DashboardQueues>(this as DashboardQueues, _$identity);

  /// Serializes this DashboardQueues to a JSON map.
  Map<String, dynamic> toJson();


@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is DashboardQueues&&const DeepCollectionEquality().equals(other.precheckin, precheckin)&&const DeepCollectionEquality().equals(other.checkout, checkout)&&const DeepCollectionEquality().equals(other.returns, returns)&&const DeepCollectionEquality().equals(other.active, active)&&const DeepCollectionEquality().equals(other.loanerReady, loanerReady)&&const DeepCollectionEquality().equals(other.loanerAdvisorFollowup, loanerAdvisorFollowup)&&const DeepCollectionEquality().equals(other.loanerBillingReview, loanerBillingReview)&&const DeepCollectionEquality().equals(other.loanerReturns, loanerReturns)&&const DeepCollectionEquality().equals(other.issueEscalations, issueEscalations));
}

@JsonKey(includeFromJson: false, includeToJson: false)
@override
int get hashCode => Object.hash(runtimeType,const DeepCollectionEquality().hash(precheckin),const DeepCollectionEquality().hash(checkout),const DeepCollectionEquality().hash(returns),const DeepCollectionEquality().hash(active),const DeepCollectionEquality().hash(loanerReady),const DeepCollectionEquality().hash(loanerAdvisorFollowup),const DeepCollectionEquality().hash(loanerBillingReview),const DeepCollectionEquality().hash(loanerReturns),const DeepCollectionEquality().hash(issueEscalations));

@override
String toString() {
  return 'DashboardQueues(precheckin: $precheckin, checkout: $checkout, returns: $returns, active: $active, loanerReady: $loanerReady, loanerAdvisorFollowup: $loanerAdvisorFollowup, loanerBillingReview: $loanerBillingReview, loanerReturns: $loanerReturns, issueEscalations: $issueEscalations)';
}


}

/// @nodoc
abstract mixin class $DashboardQueuesCopyWith<$Res>  {
  factory $DashboardQueuesCopyWith(DashboardQueues value, $Res Function(DashboardQueues) _then) = _$DashboardQueuesCopyWithImpl;
@useResult
$Res call({
 List<ReservationCard> precheckin, List<ReservationCard> checkout, List<ReservationCard> returns, List<ReservationCard> active, List<ReservationCard> loanerReady, List<ReservationCard> loanerAdvisorFollowup, List<ReservationCard> loanerBillingReview, List<ReservationCard> loanerReturns, List<IncidentCard> issueEscalations
});




}
/// @nodoc
class _$DashboardQueuesCopyWithImpl<$Res>
    implements $DashboardQueuesCopyWith<$Res> {
  _$DashboardQueuesCopyWithImpl(this._self, this._then);

  final DashboardQueues _self;
  final $Res Function(DashboardQueues) _then;

/// Create a copy of DashboardQueues
/// with the given fields replaced by the non-null parameter values.
@pragma('vm:prefer-inline') @override $Res call({Object? precheckin = null,Object? checkout = null,Object? returns = null,Object? active = null,Object? loanerReady = null,Object? loanerAdvisorFollowup = null,Object? loanerBillingReview = null,Object? loanerReturns = null,Object? issueEscalations = null,}) {
  return _then(_self.copyWith(
precheckin: null == precheckin ? _self.precheckin : precheckin // ignore: cast_nullable_to_non_nullable
as List<ReservationCard>,checkout: null == checkout ? _self.checkout : checkout // ignore: cast_nullable_to_non_nullable
as List<ReservationCard>,returns: null == returns ? _self.returns : returns // ignore: cast_nullable_to_non_nullable
as List<ReservationCard>,active: null == active ? _self.active : active // ignore: cast_nullable_to_non_nullable
as List<ReservationCard>,loanerReady: null == loanerReady ? _self.loanerReady : loanerReady // ignore: cast_nullable_to_non_nullable
as List<ReservationCard>,loanerAdvisorFollowup: null == loanerAdvisorFollowup ? _self.loanerAdvisorFollowup : loanerAdvisorFollowup // ignore: cast_nullable_to_non_nullable
as List<ReservationCard>,loanerBillingReview: null == loanerBillingReview ? _self.loanerBillingReview : loanerBillingReview // ignore: cast_nullable_to_non_nullable
as List<ReservationCard>,loanerReturns: null == loanerReturns ? _self.loanerReturns : loanerReturns // ignore: cast_nullable_to_non_nullable
as List<ReservationCard>,issueEscalations: null == issueEscalations ? _self.issueEscalations : issueEscalations // ignore: cast_nullable_to_non_nullable
as List<IncidentCard>,
  ));
}

}


/// Adds pattern-matching-related methods to [DashboardQueues].
extension DashboardQueuesPatterns on DashboardQueues {
/// A variant of `map` that fallback to returning `orElse`.
///
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case final Subclass value:
///     return ...;
///   case _:
///     return orElse();
/// }
/// ```

@optionalTypeArgs TResult maybeMap<TResult extends Object?>(TResult Function( _DashboardQueues value)?  $default,{required TResult orElse(),}){
final _that = this;
switch (_that) {
case _DashboardQueues() when $default != null:
return $default(_that);case _:
  return orElse();

}
}
/// A `switch`-like method, using callbacks.
///
/// Callbacks receives the raw object, upcasted.
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case final Subclass value:
///     return ...;
///   case final Subclass2 value:
///     return ...;
/// }
/// ```

@optionalTypeArgs TResult map<TResult extends Object?>(TResult Function( _DashboardQueues value)  $default,){
final _that = this;
switch (_that) {
case _DashboardQueues():
return $default(_that);case _:
  throw StateError('Unexpected subclass');

}
}
/// A variant of `map` that fallback to returning `null`.
///
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case final Subclass value:
///     return ...;
///   case _:
///     return null;
/// }
/// ```

@optionalTypeArgs TResult? mapOrNull<TResult extends Object?>(TResult? Function( _DashboardQueues value)?  $default,){
final _that = this;
switch (_that) {
case _DashboardQueues() when $default != null:
return $default(_that);case _:
  return null;

}
}
/// A variant of `when` that fallback to an `orElse` callback.
///
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case Subclass(:final field):
///     return ...;
///   case _:
///     return orElse();
/// }
/// ```

@optionalTypeArgs TResult maybeWhen<TResult extends Object?>(TResult Function( List<ReservationCard> precheckin,  List<ReservationCard> checkout,  List<ReservationCard> returns,  List<ReservationCard> active,  List<ReservationCard> loanerReady,  List<ReservationCard> loanerAdvisorFollowup,  List<ReservationCard> loanerBillingReview,  List<ReservationCard> loanerReturns,  List<IncidentCard> issueEscalations)?  $default,{required TResult orElse(),}) {final _that = this;
switch (_that) {
case _DashboardQueues() when $default != null:
return $default(_that.precheckin,_that.checkout,_that.returns,_that.active,_that.loanerReady,_that.loanerAdvisorFollowup,_that.loanerBillingReview,_that.loanerReturns,_that.issueEscalations);case _:
  return orElse();

}
}
/// A `switch`-like method, using callbacks.
///
/// As opposed to `map`, this offers destructuring.
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case Subclass(:final field):
///     return ...;
///   case Subclass2(:final field2):
///     return ...;
/// }
/// ```

@optionalTypeArgs TResult when<TResult extends Object?>(TResult Function( List<ReservationCard> precheckin,  List<ReservationCard> checkout,  List<ReservationCard> returns,  List<ReservationCard> active,  List<ReservationCard> loanerReady,  List<ReservationCard> loanerAdvisorFollowup,  List<ReservationCard> loanerBillingReview,  List<ReservationCard> loanerReturns,  List<IncidentCard> issueEscalations)  $default,) {final _that = this;
switch (_that) {
case _DashboardQueues():
return $default(_that.precheckin,_that.checkout,_that.returns,_that.active,_that.loanerReady,_that.loanerAdvisorFollowup,_that.loanerBillingReview,_that.loanerReturns,_that.issueEscalations);case _:
  throw StateError('Unexpected subclass');

}
}
/// A variant of `when` that fallback to returning `null`
///
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case Subclass(:final field):
///     return ...;
///   case _:
///     return null;
/// }
/// ```

@optionalTypeArgs TResult? whenOrNull<TResult extends Object?>(TResult? Function( List<ReservationCard> precheckin,  List<ReservationCard> checkout,  List<ReservationCard> returns,  List<ReservationCard> active,  List<ReservationCard> loanerReady,  List<ReservationCard> loanerAdvisorFollowup,  List<ReservationCard> loanerBillingReview,  List<ReservationCard> loanerReturns,  List<IncidentCard> issueEscalations)?  $default,) {final _that = this;
switch (_that) {
case _DashboardQueues() when $default != null:
return $default(_that.precheckin,_that.checkout,_that.returns,_that.active,_that.loanerReady,_that.loanerAdvisorFollowup,_that.loanerBillingReview,_that.loanerReturns,_that.issueEscalations);case _:
  return null;

}
}

}

/// @nodoc
@JsonSerializable()

class _DashboardQueues implements DashboardQueues {
  const _DashboardQueues({final  List<ReservationCard> precheckin = const <ReservationCard>[], final  List<ReservationCard> checkout = const <ReservationCard>[], final  List<ReservationCard> returns = const <ReservationCard>[], final  List<ReservationCard> active = const <ReservationCard>[], final  List<ReservationCard> loanerReady = const <ReservationCard>[], final  List<ReservationCard> loanerAdvisorFollowup = const <ReservationCard>[], final  List<ReservationCard> loanerBillingReview = const <ReservationCard>[], final  List<ReservationCard> loanerReturns = const <ReservationCard>[], final  List<IncidentCard> issueEscalations = const <IncidentCard>[]}): _precheckin = precheckin,_checkout = checkout,_returns = returns,_active = active,_loanerReady = loanerReady,_loanerAdvisorFollowup = loanerAdvisorFollowup,_loanerBillingReview = loanerBillingReview,_loanerReturns = loanerReturns,_issueEscalations = issueEscalations;
  factory _DashboardQueues.fromJson(Map<String, dynamic> json) => _$DashboardQueuesFromJson(json);

 final  List<ReservationCard> _precheckin;
@override@JsonKey() List<ReservationCard> get precheckin {
  if (_precheckin is EqualUnmodifiableListView) return _precheckin;
  // ignore: implicit_dynamic_type
  return EqualUnmodifiableListView(_precheckin);
}

 final  List<ReservationCard> _checkout;
@override@JsonKey() List<ReservationCard> get checkout {
  if (_checkout is EqualUnmodifiableListView) return _checkout;
  // ignore: implicit_dynamic_type
  return EqualUnmodifiableListView(_checkout);
}

 final  List<ReservationCard> _returns;
@override@JsonKey() List<ReservationCard> get returns {
  if (_returns is EqualUnmodifiableListView) return _returns;
  // ignore: implicit_dynamic_type
  return EqualUnmodifiableListView(_returns);
}

 final  List<ReservationCard> _active;
@override@JsonKey() List<ReservationCard> get active {
  if (_active is EqualUnmodifiableListView) return _active;
  // ignore: implicit_dynamic_type
  return EqualUnmodifiableListView(_active);
}

 final  List<ReservationCard> _loanerReady;
@override@JsonKey() List<ReservationCard> get loanerReady {
  if (_loanerReady is EqualUnmodifiableListView) return _loanerReady;
  // ignore: implicit_dynamic_type
  return EqualUnmodifiableListView(_loanerReady);
}

 final  List<ReservationCard> _loanerAdvisorFollowup;
@override@JsonKey() List<ReservationCard> get loanerAdvisorFollowup {
  if (_loanerAdvisorFollowup is EqualUnmodifiableListView) return _loanerAdvisorFollowup;
  // ignore: implicit_dynamic_type
  return EqualUnmodifiableListView(_loanerAdvisorFollowup);
}

 final  List<ReservationCard> _loanerBillingReview;
@override@JsonKey() List<ReservationCard> get loanerBillingReview {
  if (_loanerBillingReview is EqualUnmodifiableListView) return _loanerBillingReview;
  // ignore: implicit_dynamic_type
  return EqualUnmodifiableListView(_loanerBillingReview);
}

 final  List<ReservationCard> _loanerReturns;
@override@JsonKey() List<ReservationCard> get loanerReturns {
  if (_loanerReturns is EqualUnmodifiableListView) return _loanerReturns;
  // ignore: implicit_dynamic_type
  return EqualUnmodifiableListView(_loanerReturns);
}

 final  List<IncidentCard> _issueEscalations;
@override@JsonKey() List<IncidentCard> get issueEscalations {
  if (_issueEscalations is EqualUnmodifiableListView) return _issueEscalations;
  // ignore: implicit_dynamic_type
  return EqualUnmodifiableListView(_issueEscalations);
}


/// Create a copy of DashboardQueues
/// with the given fields replaced by the non-null parameter values.
@override @JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
_$DashboardQueuesCopyWith<_DashboardQueues> get copyWith => __$DashboardQueuesCopyWithImpl<_DashboardQueues>(this, _$identity);

@override
Map<String, dynamic> toJson() {
  return _$DashboardQueuesToJson(this, );
}

@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is _DashboardQueues&&const DeepCollectionEquality().equals(other._precheckin, _precheckin)&&const DeepCollectionEquality().equals(other._checkout, _checkout)&&const DeepCollectionEquality().equals(other._returns, _returns)&&const DeepCollectionEquality().equals(other._active, _active)&&const DeepCollectionEquality().equals(other._loanerReady, _loanerReady)&&const DeepCollectionEquality().equals(other._loanerAdvisorFollowup, _loanerAdvisorFollowup)&&const DeepCollectionEquality().equals(other._loanerBillingReview, _loanerBillingReview)&&const DeepCollectionEquality().equals(other._loanerReturns, _loanerReturns)&&const DeepCollectionEquality().equals(other._issueEscalations, _issueEscalations));
}

@JsonKey(includeFromJson: false, includeToJson: false)
@override
int get hashCode => Object.hash(runtimeType,const DeepCollectionEquality().hash(_precheckin),const DeepCollectionEquality().hash(_checkout),const DeepCollectionEquality().hash(_returns),const DeepCollectionEquality().hash(_active),const DeepCollectionEquality().hash(_loanerReady),const DeepCollectionEquality().hash(_loanerAdvisorFollowup),const DeepCollectionEquality().hash(_loanerBillingReview),const DeepCollectionEquality().hash(_loanerReturns),const DeepCollectionEquality().hash(_issueEscalations));

@override
String toString() {
  return 'DashboardQueues(precheckin: $precheckin, checkout: $checkout, returns: $returns, active: $active, loanerReady: $loanerReady, loanerAdvisorFollowup: $loanerAdvisorFollowup, loanerBillingReview: $loanerBillingReview, loanerReturns: $loanerReturns, issueEscalations: $issueEscalations)';
}


}

/// @nodoc
abstract mixin class _$DashboardQueuesCopyWith<$Res> implements $DashboardQueuesCopyWith<$Res> {
  factory _$DashboardQueuesCopyWith(_DashboardQueues value, $Res Function(_DashboardQueues) _then) = __$DashboardQueuesCopyWithImpl;
@override @useResult
$Res call({
 List<ReservationCard> precheckin, List<ReservationCard> checkout, List<ReservationCard> returns, List<ReservationCard> active, List<ReservationCard> loanerReady, List<ReservationCard> loanerAdvisorFollowup, List<ReservationCard> loanerBillingReview, List<ReservationCard> loanerReturns, List<IncidentCard> issueEscalations
});




}
/// @nodoc
class __$DashboardQueuesCopyWithImpl<$Res>
    implements _$DashboardQueuesCopyWith<$Res> {
  __$DashboardQueuesCopyWithImpl(this._self, this._then);

  final _DashboardQueues _self;
  final $Res Function(_DashboardQueues) _then;

/// Create a copy of DashboardQueues
/// with the given fields replaced by the non-null parameter values.
@override @pragma('vm:prefer-inline') $Res call({Object? precheckin = null,Object? checkout = null,Object? returns = null,Object? active = null,Object? loanerReady = null,Object? loanerAdvisorFollowup = null,Object? loanerBillingReview = null,Object? loanerReturns = null,Object? issueEscalations = null,}) {
  return _then(_DashboardQueues(
precheckin: null == precheckin ? _self._precheckin : precheckin // ignore: cast_nullable_to_non_nullable
as List<ReservationCard>,checkout: null == checkout ? _self._checkout : checkout // ignore: cast_nullable_to_non_nullable
as List<ReservationCard>,returns: null == returns ? _self._returns : returns // ignore: cast_nullable_to_non_nullable
as List<ReservationCard>,active: null == active ? _self._active : active // ignore: cast_nullable_to_non_nullable
as List<ReservationCard>,loanerReady: null == loanerReady ? _self._loanerReady : loanerReady // ignore: cast_nullable_to_non_nullable
as List<ReservationCard>,loanerAdvisorFollowup: null == loanerAdvisorFollowup ? _self._loanerAdvisorFollowup : loanerAdvisorFollowup // ignore: cast_nullable_to_non_nullable
as List<ReservationCard>,loanerBillingReview: null == loanerBillingReview ? _self._loanerBillingReview : loanerBillingReview // ignore: cast_nullable_to_non_nullable
as List<ReservationCard>,loanerReturns: null == loanerReturns ? _self._loanerReturns : loanerReturns // ignore: cast_nullable_to_non_nullable
as List<ReservationCard>,issueEscalations: null == issueEscalations ? _self._issueEscalations : issueEscalations // ignore: cast_nullable_to_non_nullable
as List<IncidentCard>,
  ));
}


}


/// @nodoc
mixin _$IncidentCard {

 String get id; String? get type; String? get status; String? get title; String get description;@FlexibleDoubleConverter() double? get amountClaimed;@FlexibleDoubleConverter() double? get amountResolved;@IsoDateTimeConverter() DateTime? get createdAt;@IsoDateTimeConverter() DateTime? get updatedAt;
/// Create a copy of IncidentCard
/// with the given fields replaced by the non-null parameter values.
@JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
$IncidentCardCopyWith<IncidentCard> get copyWith => _$IncidentCardCopyWithImpl<IncidentCard>(this as IncidentCard, _$identity);

  /// Serializes this IncidentCard to a JSON map.
  Map<String, dynamic> toJson();


@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is IncidentCard&&(identical(other.id, id) || other.id == id)&&(identical(other.type, type) || other.type == type)&&(identical(other.status, status) || other.status == status)&&(identical(other.title, title) || other.title == title)&&(identical(other.description, description) || other.description == description)&&(identical(other.amountClaimed, amountClaimed) || other.amountClaimed == amountClaimed)&&(identical(other.amountResolved, amountResolved) || other.amountResolved == amountResolved)&&(identical(other.createdAt, createdAt) || other.createdAt == createdAt)&&(identical(other.updatedAt, updatedAt) || other.updatedAt == updatedAt));
}

@JsonKey(includeFromJson: false, includeToJson: false)
@override
int get hashCode => Object.hash(runtimeType,id,type,status,title,description,amountClaimed,amountResolved,createdAt,updatedAt);

@override
String toString() {
  return 'IncidentCard(id: $id, type: $type, status: $status, title: $title, description: $description, amountClaimed: $amountClaimed, amountResolved: $amountResolved, createdAt: $createdAt, updatedAt: $updatedAt)';
}


}

/// @nodoc
abstract mixin class $IncidentCardCopyWith<$Res>  {
  factory $IncidentCardCopyWith(IncidentCard value, $Res Function(IncidentCard) _then) = _$IncidentCardCopyWithImpl;
@useResult
$Res call({
 String id, String? type, String? status, String? title, String description,@FlexibleDoubleConverter() double? amountClaimed,@FlexibleDoubleConverter() double? amountResolved,@IsoDateTimeConverter() DateTime? createdAt,@IsoDateTimeConverter() DateTime? updatedAt
});




}
/// @nodoc
class _$IncidentCardCopyWithImpl<$Res>
    implements $IncidentCardCopyWith<$Res> {
  _$IncidentCardCopyWithImpl(this._self, this._then);

  final IncidentCard _self;
  final $Res Function(IncidentCard) _then;

/// Create a copy of IncidentCard
/// with the given fields replaced by the non-null parameter values.
@pragma('vm:prefer-inline') @override $Res call({Object? id = null,Object? type = freezed,Object? status = freezed,Object? title = freezed,Object? description = null,Object? amountClaimed = freezed,Object? amountResolved = freezed,Object? createdAt = freezed,Object? updatedAt = freezed,}) {
  return _then(_self.copyWith(
id: null == id ? _self.id : id // ignore: cast_nullable_to_non_nullable
as String,type: freezed == type ? _self.type : type // ignore: cast_nullable_to_non_nullable
as String?,status: freezed == status ? _self.status : status // ignore: cast_nullable_to_non_nullable
as String?,title: freezed == title ? _self.title : title // ignore: cast_nullable_to_non_nullable
as String?,description: null == description ? _self.description : description // ignore: cast_nullable_to_non_nullable
as String,amountClaimed: freezed == amountClaimed ? _self.amountClaimed : amountClaimed // ignore: cast_nullable_to_non_nullable
as double?,amountResolved: freezed == amountResolved ? _self.amountResolved : amountResolved // ignore: cast_nullable_to_non_nullable
as double?,createdAt: freezed == createdAt ? _self.createdAt : createdAt // ignore: cast_nullable_to_non_nullable
as DateTime?,updatedAt: freezed == updatedAt ? _self.updatedAt : updatedAt // ignore: cast_nullable_to_non_nullable
as DateTime?,
  ));
}

}


/// Adds pattern-matching-related methods to [IncidentCard].
extension IncidentCardPatterns on IncidentCard {
/// A variant of `map` that fallback to returning `orElse`.
///
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case final Subclass value:
///     return ...;
///   case _:
///     return orElse();
/// }
/// ```

@optionalTypeArgs TResult maybeMap<TResult extends Object?>(TResult Function( _IncidentCard value)?  $default,{required TResult orElse(),}){
final _that = this;
switch (_that) {
case _IncidentCard() when $default != null:
return $default(_that);case _:
  return orElse();

}
}
/// A `switch`-like method, using callbacks.
///
/// Callbacks receives the raw object, upcasted.
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case final Subclass value:
///     return ...;
///   case final Subclass2 value:
///     return ...;
/// }
/// ```

@optionalTypeArgs TResult map<TResult extends Object?>(TResult Function( _IncidentCard value)  $default,){
final _that = this;
switch (_that) {
case _IncidentCard():
return $default(_that);case _:
  throw StateError('Unexpected subclass');

}
}
/// A variant of `map` that fallback to returning `null`.
///
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case final Subclass value:
///     return ...;
///   case _:
///     return null;
/// }
/// ```

@optionalTypeArgs TResult? mapOrNull<TResult extends Object?>(TResult? Function( _IncidentCard value)?  $default,){
final _that = this;
switch (_that) {
case _IncidentCard() when $default != null:
return $default(_that);case _:
  return null;

}
}
/// A variant of `when` that fallback to an `orElse` callback.
///
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case Subclass(:final field):
///     return ...;
///   case _:
///     return orElse();
/// }
/// ```

@optionalTypeArgs TResult maybeWhen<TResult extends Object?>(TResult Function( String id,  String? type,  String? status,  String? title,  String description, @FlexibleDoubleConverter()  double? amountClaimed, @FlexibleDoubleConverter()  double? amountResolved, @IsoDateTimeConverter()  DateTime? createdAt, @IsoDateTimeConverter()  DateTime? updatedAt)?  $default,{required TResult orElse(),}) {final _that = this;
switch (_that) {
case _IncidentCard() when $default != null:
return $default(_that.id,_that.type,_that.status,_that.title,_that.description,_that.amountClaimed,_that.amountResolved,_that.createdAt,_that.updatedAt);case _:
  return orElse();

}
}
/// A `switch`-like method, using callbacks.
///
/// As opposed to `map`, this offers destructuring.
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case Subclass(:final field):
///     return ...;
///   case Subclass2(:final field2):
///     return ...;
/// }
/// ```

@optionalTypeArgs TResult when<TResult extends Object?>(TResult Function( String id,  String? type,  String? status,  String? title,  String description, @FlexibleDoubleConverter()  double? amountClaimed, @FlexibleDoubleConverter()  double? amountResolved, @IsoDateTimeConverter()  DateTime? createdAt, @IsoDateTimeConverter()  DateTime? updatedAt)  $default,) {final _that = this;
switch (_that) {
case _IncidentCard():
return $default(_that.id,_that.type,_that.status,_that.title,_that.description,_that.amountClaimed,_that.amountResolved,_that.createdAt,_that.updatedAt);case _:
  throw StateError('Unexpected subclass');

}
}
/// A variant of `when` that fallback to returning `null`
///
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case Subclass(:final field):
///     return ...;
///   case _:
///     return null;
/// }
/// ```

@optionalTypeArgs TResult? whenOrNull<TResult extends Object?>(TResult? Function( String id,  String? type,  String? status,  String? title,  String description, @FlexibleDoubleConverter()  double? amountClaimed, @FlexibleDoubleConverter()  double? amountResolved, @IsoDateTimeConverter()  DateTime? createdAt, @IsoDateTimeConverter()  DateTime? updatedAt)?  $default,) {final _that = this;
switch (_that) {
case _IncidentCard() when $default != null:
return $default(_that.id,_that.type,_that.status,_that.title,_that.description,_that.amountClaimed,_that.amountResolved,_that.createdAt,_that.updatedAt);case _:
  return null;

}
}

}

/// @nodoc
@JsonSerializable()

class _IncidentCard implements IncidentCard {
  const _IncidentCard({required this.id, this.type, this.status, this.title, this.description = '', @FlexibleDoubleConverter() this.amountClaimed, @FlexibleDoubleConverter() this.amountResolved, @IsoDateTimeConverter() this.createdAt, @IsoDateTimeConverter() this.updatedAt});
  factory _IncidentCard.fromJson(Map<String, dynamic> json) => _$IncidentCardFromJson(json);

@override final  String id;
@override final  String? type;
@override final  String? status;
@override final  String? title;
@override@JsonKey() final  String description;
@override@FlexibleDoubleConverter() final  double? amountClaimed;
@override@FlexibleDoubleConverter() final  double? amountResolved;
@override@IsoDateTimeConverter() final  DateTime? createdAt;
@override@IsoDateTimeConverter() final  DateTime? updatedAt;

/// Create a copy of IncidentCard
/// with the given fields replaced by the non-null parameter values.
@override @JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
_$IncidentCardCopyWith<_IncidentCard> get copyWith => __$IncidentCardCopyWithImpl<_IncidentCard>(this, _$identity);

@override
Map<String, dynamic> toJson() {
  return _$IncidentCardToJson(this, );
}

@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is _IncidentCard&&(identical(other.id, id) || other.id == id)&&(identical(other.type, type) || other.type == type)&&(identical(other.status, status) || other.status == status)&&(identical(other.title, title) || other.title == title)&&(identical(other.description, description) || other.description == description)&&(identical(other.amountClaimed, amountClaimed) || other.amountClaimed == amountClaimed)&&(identical(other.amountResolved, amountResolved) || other.amountResolved == amountResolved)&&(identical(other.createdAt, createdAt) || other.createdAt == createdAt)&&(identical(other.updatedAt, updatedAt) || other.updatedAt == updatedAt));
}

@JsonKey(includeFromJson: false, includeToJson: false)
@override
int get hashCode => Object.hash(runtimeType,id,type,status,title,description,amountClaimed,amountResolved,createdAt,updatedAt);

@override
String toString() {
  return 'IncidentCard(id: $id, type: $type, status: $status, title: $title, description: $description, amountClaimed: $amountClaimed, amountResolved: $amountResolved, createdAt: $createdAt, updatedAt: $updatedAt)';
}


}

/// @nodoc
abstract mixin class _$IncidentCardCopyWith<$Res> implements $IncidentCardCopyWith<$Res> {
  factory _$IncidentCardCopyWith(_IncidentCard value, $Res Function(_IncidentCard) _then) = __$IncidentCardCopyWithImpl;
@override @useResult
$Res call({
 String id, String? type, String? status, String? title, String description,@FlexibleDoubleConverter() double? amountClaimed,@FlexibleDoubleConverter() double? amountResolved,@IsoDateTimeConverter() DateTime? createdAt,@IsoDateTimeConverter() DateTime? updatedAt
});




}
/// @nodoc
class __$IncidentCardCopyWithImpl<$Res>
    implements _$IncidentCardCopyWith<$Res> {
  __$IncidentCardCopyWithImpl(this._self, this._then);

  final _IncidentCard _self;
  final $Res Function(_IncidentCard) _then;

/// Create a copy of IncidentCard
/// with the given fields replaced by the non-null parameter values.
@override @pragma('vm:prefer-inline') $Res call({Object? id = null,Object? type = freezed,Object? status = freezed,Object? title = freezed,Object? description = null,Object? amountClaimed = freezed,Object? amountResolved = freezed,Object? createdAt = freezed,Object? updatedAt = freezed,}) {
  return _then(_IncidentCard(
id: null == id ? _self.id : id // ignore: cast_nullable_to_non_nullable
as String,type: freezed == type ? _self.type : type // ignore: cast_nullable_to_non_nullable
as String?,status: freezed == status ? _self.status : status // ignore: cast_nullable_to_non_nullable
as String?,title: freezed == title ? _self.title : title // ignore: cast_nullable_to_non_nullable
as String?,description: null == description ? _self.description : description // ignore: cast_nullable_to_non_nullable
as String,amountClaimed: freezed == amountClaimed ? _self.amountClaimed : amountClaimed // ignore: cast_nullable_to_non_nullable
as double?,amountResolved: freezed == amountResolved ? _self.amountResolved : amountResolved // ignore: cast_nullable_to_non_nullable
as double?,createdAt: freezed == createdAt ? _self.createdAt : createdAt // ignore: cast_nullable_to_non_nullable
as DateTime?,updatedAt: freezed == updatedAt ? _self.updatedAt : updatedAt // ignore: cast_nullable_to_non_nullable
as DateTime?,
  ));
}


}


/// @nodoc
mixin _$SelfBlock {

 SelfProfile? get profile; CommissionSummary? get commissions;
/// Create a copy of SelfBlock
/// with the given fields replaced by the non-null parameter values.
@JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
$SelfBlockCopyWith<SelfBlock> get copyWith => _$SelfBlockCopyWithImpl<SelfBlock>(this as SelfBlock, _$identity);

  /// Serializes this SelfBlock to a JSON map.
  Map<String, dynamic> toJson();


@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is SelfBlock&&(identical(other.profile, profile) || other.profile == profile)&&(identical(other.commissions, commissions) || other.commissions == commissions));
}

@JsonKey(includeFromJson: false, includeToJson: false)
@override
int get hashCode => Object.hash(runtimeType,profile,commissions);

@override
String toString() {
  return 'SelfBlock(profile: $profile, commissions: $commissions)';
}


}

/// @nodoc
abstract mixin class $SelfBlockCopyWith<$Res>  {
  factory $SelfBlockCopyWith(SelfBlock value, $Res Function(SelfBlock) _then) = _$SelfBlockCopyWithImpl;
@useResult
$Res call({
 SelfProfile? profile, CommissionSummary? commissions
});


$SelfProfileCopyWith<$Res>? get profile;$CommissionSummaryCopyWith<$Res>? get commissions;

}
/// @nodoc
class _$SelfBlockCopyWithImpl<$Res>
    implements $SelfBlockCopyWith<$Res> {
  _$SelfBlockCopyWithImpl(this._self, this._then);

  final SelfBlock _self;
  final $Res Function(SelfBlock) _then;

/// Create a copy of SelfBlock
/// with the given fields replaced by the non-null parameter values.
@pragma('vm:prefer-inline') @override $Res call({Object? profile = freezed,Object? commissions = freezed,}) {
  return _then(_self.copyWith(
profile: freezed == profile ? _self.profile : profile // ignore: cast_nullable_to_non_nullable
as SelfProfile?,commissions: freezed == commissions ? _self.commissions : commissions // ignore: cast_nullable_to_non_nullable
as CommissionSummary?,
  ));
}
/// Create a copy of SelfBlock
/// with the given fields replaced by the non-null parameter values.
@override
@pragma('vm:prefer-inline')
$SelfProfileCopyWith<$Res>? get profile {
    if (_self.profile == null) {
    return null;
  }

  return $SelfProfileCopyWith<$Res>(_self.profile!, (value) {
    return _then(_self.copyWith(profile: value));
  });
}/// Create a copy of SelfBlock
/// with the given fields replaced by the non-null parameter values.
@override
@pragma('vm:prefer-inline')
$CommissionSummaryCopyWith<$Res>? get commissions {
    if (_self.commissions == null) {
    return null;
  }

  return $CommissionSummaryCopyWith<$Res>(_self.commissions!, (value) {
    return _then(_self.copyWith(commissions: value));
  });
}
}


/// Adds pattern-matching-related methods to [SelfBlock].
extension SelfBlockPatterns on SelfBlock {
/// A variant of `map` that fallback to returning `orElse`.
///
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case final Subclass value:
///     return ...;
///   case _:
///     return orElse();
/// }
/// ```

@optionalTypeArgs TResult maybeMap<TResult extends Object?>(TResult Function( _SelfBlock value)?  $default,{required TResult orElse(),}){
final _that = this;
switch (_that) {
case _SelfBlock() when $default != null:
return $default(_that);case _:
  return orElse();

}
}
/// A `switch`-like method, using callbacks.
///
/// Callbacks receives the raw object, upcasted.
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case final Subclass value:
///     return ...;
///   case final Subclass2 value:
///     return ...;
/// }
/// ```

@optionalTypeArgs TResult map<TResult extends Object?>(TResult Function( _SelfBlock value)  $default,){
final _that = this;
switch (_that) {
case _SelfBlock():
return $default(_that);case _:
  throw StateError('Unexpected subclass');

}
}
/// A variant of `map` that fallback to returning `null`.
///
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case final Subclass value:
///     return ...;
///   case _:
///     return null;
/// }
/// ```

@optionalTypeArgs TResult? mapOrNull<TResult extends Object?>(TResult? Function( _SelfBlock value)?  $default,){
final _that = this;
switch (_that) {
case _SelfBlock() when $default != null:
return $default(_that);case _:
  return null;

}
}
/// A variant of `when` that fallback to an `orElse` callback.
///
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case Subclass(:final field):
///     return ...;
///   case _:
///     return orElse();
/// }
/// ```

@optionalTypeArgs TResult maybeWhen<TResult extends Object?>(TResult Function( SelfProfile? profile,  CommissionSummary? commissions)?  $default,{required TResult orElse(),}) {final _that = this;
switch (_that) {
case _SelfBlock() when $default != null:
return $default(_that.profile,_that.commissions);case _:
  return orElse();

}
}
/// A `switch`-like method, using callbacks.
///
/// As opposed to `map`, this offers destructuring.
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case Subclass(:final field):
///     return ...;
///   case Subclass2(:final field2):
///     return ...;
/// }
/// ```

@optionalTypeArgs TResult when<TResult extends Object?>(TResult Function( SelfProfile? profile,  CommissionSummary? commissions)  $default,) {final _that = this;
switch (_that) {
case _SelfBlock():
return $default(_that.profile,_that.commissions);case _:
  throw StateError('Unexpected subclass');

}
}
/// A variant of `when` that fallback to returning `null`
///
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case Subclass(:final field):
///     return ...;
///   case _:
///     return null;
/// }
/// ```

@optionalTypeArgs TResult? whenOrNull<TResult extends Object?>(TResult? Function( SelfProfile? profile,  CommissionSummary? commissions)?  $default,) {final _that = this;
switch (_that) {
case _SelfBlock() when $default != null:
return $default(_that.profile,_that.commissions);case _:
  return null;

}
}

}

/// @nodoc
@JsonSerializable()

class _SelfBlock implements SelfBlock {
  const _SelfBlock({this.profile, this.commissions});
  factory _SelfBlock.fromJson(Map<String, dynamic> json) => _$SelfBlockFromJson(json);

@override final  SelfProfile? profile;
@override final  CommissionSummary? commissions;

/// Create a copy of SelfBlock
/// with the given fields replaced by the non-null parameter values.
@override @JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
_$SelfBlockCopyWith<_SelfBlock> get copyWith => __$SelfBlockCopyWithImpl<_SelfBlock>(this, _$identity);

@override
Map<String, dynamic> toJson() {
  return _$SelfBlockToJson(this, );
}

@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is _SelfBlock&&(identical(other.profile, profile) || other.profile == profile)&&(identical(other.commissions, commissions) || other.commissions == commissions));
}

@JsonKey(includeFromJson: false, includeToJson: false)
@override
int get hashCode => Object.hash(runtimeType,profile,commissions);

@override
String toString() {
  return 'SelfBlock(profile: $profile, commissions: $commissions)';
}


}

/// @nodoc
abstract mixin class _$SelfBlockCopyWith<$Res> implements $SelfBlockCopyWith<$Res> {
  factory _$SelfBlockCopyWith(_SelfBlock value, $Res Function(_SelfBlock) _then) = __$SelfBlockCopyWithImpl;
@override @useResult
$Res call({
 SelfProfile? profile, CommissionSummary? commissions
});


@override $SelfProfileCopyWith<$Res>? get profile;@override $CommissionSummaryCopyWith<$Res>? get commissions;

}
/// @nodoc
class __$SelfBlockCopyWithImpl<$Res>
    implements _$SelfBlockCopyWith<$Res> {
  __$SelfBlockCopyWithImpl(this._self, this._then);

  final _SelfBlock _self;
  final $Res Function(_SelfBlock) _then;

/// Create a copy of SelfBlock
/// with the given fields replaced by the non-null parameter values.
@override @pragma('vm:prefer-inline') $Res call({Object? profile = freezed,Object? commissions = freezed,}) {
  return _then(_SelfBlock(
profile: freezed == profile ? _self.profile : profile // ignore: cast_nullable_to_non_nullable
as SelfProfile?,commissions: freezed == commissions ? _self.commissions : commissions // ignore: cast_nullable_to_non_nullable
as CommissionSummary?,
  ));
}

/// Create a copy of SelfBlock
/// with the given fields replaced by the non-null parameter values.
@override
@pragma('vm:prefer-inline')
$SelfProfileCopyWith<$Res>? get profile {
    if (_self.profile == null) {
    return null;
  }

  return $SelfProfileCopyWith<$Res>(_self.profile!, (value) {
    return _then(_self.copyWith(profile: value));
  });
}/// Create a copy of SelfBlock
/// with the given fields replaced by the non-null parameter values.
@override
@pragma('vm:prefer-inline')
$CommissionSummaryCopyWith<$Res>? get commissions {
    if (_self.commissions == null) {
    return null;
  }

  return $CommissionSummaryCopyWith<$Res>(_self.commissions!, (value) {
    return _then(_self.copyWith(commissions: value));
  });
}
}


/// @nodoc
mixin _$SelfProfile {

 String get id; String? get fullName; String? get email; String? get role; bool get isActive;
/// Create a copy of SelfProfile
/// with the given fields replaced by the non-null parameter values.
@JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
$SelfProfileCopyWith<SelfProfile> get copyWith => _$SelfProfileCopyWithImpl<SelfProfile>(this as SelfProfile, _$identity);

  /// Serializes this SelfProfile to a JSON map.
  Map<String, dynamic> toJson();


@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is SelfProfile&&(identical(other.id, id) || other.id == id)&&(identical(other.fullName, fullName) || other.fullName == fullName)&&(identical(other.email, email) || other.email == email)&&(identical(other.role, role) || other.role == role)&&(identical(other.isActive, isActive) || other.isActive == isActive));
}

@JsonKey(includeFromJson: false, includeToJson: false)
@override
int get hashCode => Object.hash(runtimeType,id,fullName,email,role,isActive);

@override
String toString() {
  return 'SelfProfile(id: $id, fullName: $fullName, email: $email, role: $role, isActive: $isActive)';
}


}

/// @nodoc
abstract mixin class $SelfProfileCopyWith<$Res>  {
  factory $SelfProfileCopyWith(SelfProfile value, $Res Function(SelfProfile) _then) = _$SelfProfileCopyWithImpl;
@useResult
$Res call({
 String id, String? fullName, String? email, String? role, bool isActive
});




}
/// @nodoc
class _$SelfProfileCopyWithImpl<$Res>
    implements $SelfProfileCopyWith<$Res> {
  _$SelfProfileCopyWithImpl(this._self, this._then);

  final SelfProfile _self;
  final $Res Function(SelfProfile) _then;

/// Create a copy of SelfProfile
/// with the given fields replaced by the non-null parameter values.
@pragma('vm:prefer-inline') @override $Res call({Object? id = null,Object? fullName = freezed,Object? email = freezed,Object? role = freezed,Object? isActive = null,}) {
  return _then(_self.copyWith(
id: null == id ? _self.id : id // ignore: cast_nullable_to_non_nullable
as String,fullName: freezed == fullName ? _self.fullName : fullName // ignore: cast_nullable_to_non_nullable
as String?,email: freezed == email ? _self.email : email // ignore: cast_nullable_to_non_nullable
as String?,role: freezed == role ? _self.role : role // ignore: cast_nullable_to_non_nullable
as String?,isActive: null == isActive ? _self.isActive : isActive // ignore: cast_nullable_to_non_nullable
as bool,
  ));
}

}


/// Adds pattern-matching-related methods to [SelfProfile].
extension SelfProfilePatterns on SelfProfile {
/// A variant of `map` that fallback to returning `orElse`.
///
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case final Subclass value:
///     return ...;
///   case _:
///     return orElse();
/// }
/// ```

@optionalTypeArgs TResult maybeMap<TResult extends Object?>(TResult Function( _SelfProfile value)?  $default,{required TResult orElse(),}){
final _that = this;
switch (_that) {
case _SelfProfile() when $default != null:
return $default(_that);case _:
  return orElse();

}
}
/// A `switch`-like method, using callbacks.
///
/// Callbacks receives the raw object, upcasted.
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case final Subclass value:
///     return ...;
///   case final Subclass2 value:
///     return ...;
/// }
/// ```

@optionalTypeArgs TResult map<TResult extends Object?>(TResult Function( _SelfProfile value)  $default,){
final _that = this;
switch (_that) {
case _SelfProfile():
return $default(_that);case _:
  throw StateError('Unexpected subclass');

}
}
/// A variant of `map` that fallback to returning `null`.
///
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case final Subclass value:
///     return ...;
///   case _:
///     return null;
/// }
/// ```

@optionalTypeArgs TResult? mapOrNull<TResult extends Object?>(TResult? Function( _SelfProfile value)?  $default,){
final _that = this;
switch (_that) {
case _SelfProfile() when $default != null:
return $default(_that);case _:
  return null;

}
}
/// A variant of `when` that fallback to an `orElse` callback.
///
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case Subclass(:final field):
///     return ...;
///   case _:
///     return orElse();
/// }
/// ```

@optionalTypeArgs TResult maybeWhen<TResult extends Object?>(TResult Function( String id,  String? fullName,  String? email,  String? role,  bool isActive)?  $default,{required TResult orElse(),}) {final _that = this;
switch (_that) {
case _SelfProfile() when $default != null:
return $default(_that.id,_that.fullName,_that.email,_that.role,_that.isActive);case _:
  return orElse();

}
}
/// A `switch`-like method, using callbacks.
///
/// As opposed to `map`, this offers destructuring.
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case Subclass(:final field):
///     return ...;
///   case Subclass2(:final field2):
///     return ...;
/// }
/// ```

@optionalTypeArgs TResult when<TResult extends Object?>(TResult Function( String id,  String? fullName,  String? email,  String? role,  bool isActive)  $default,) {final _that = this;
switch (_that) {
case _SelfProfile():
return $default(_that.id,_that.fullName,_that.email,_that.role,_that.isActive);case _:
  throw StateError('Unexpected subclass');

}
}
/// A variant of `when` that fallback to returning `null`
///
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case Subclass(:final field):
///     return ...;
///   case _:
///     return null;
/// }
/// ```

@optionalTypeArgs TResult? whenOrNull<TResult extends Object?>(TResult? Function( String id,  String? fullName,  String? email,  String? role,  bool isActive)?  $default,) {final _that = this;
switch (_that) {
case _SelfProfile() when $default != null:
return $default(_that.id,_that.fullName,_that.email,_that.role,_that.isActive);case _:
  return null;

}
}

}

/// @nodoc
@JsonSerializable()

class _SelfProfile implements SelfProfile {
  const _SelfProfile({required this.id, this.fullName, this.email, this.role, this.isActive = true});
  factory _SelfProfile.fromJson(Map<String, dynamic> json) => _$SelfProfileFromJson(json);

@override final  String id;
@override final  String? fullName;
@override final  String? email;
@override final  String? role;
@override@JsonKey() final  bool isActive;

/// Create a copy of SelfProfile
/// with the given fields replaced by the non-null parameter values.
@override @JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
_$SelfProfileCopyWith<_SelfProfile> get copyWith => __$SelfProfileCopyWithImpl<_SelfProfile>(this, _$identity);

@override
Map<String, dynamic> toJson() {
  return _$SelfProfileToJson(this, );
}

@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is _SelfProfile&&(identical(other.id, id) || other.id == id)&&(identical(other.fullName, fullName) || other.fullName == fullName)&&(identical(other.email, email) || other.email == email)&&(identical(other.role, role) || other.role == role)&&(identical(other.isActive, isActive) || other.isActive == isActive));
}

@JsonKey(includeFromJson: false, includeToJson: false)
@override
int get hashCode => Object.hash(runtimeType,id,fullName,email,role,isActive);

@override
String toString() {
  return 'SelfProfile(id: $id, fullName: $fullName, email: $email, role: $role, isActive: $isActive)';
}


}

/// @nodoc
abstract mixin class _$SelfProfileCopyWith<$Res> implements $SelfProfileCopyWith<$Res> {
  factory _$SelfProfileCopyWith(_SelfProfile value, $Res Function(_SelfProfile) _then) = __$SelfProfileCopyWithImpl;
@override @useResult
$Res call({
 String id, String? fullName, String? email, String? role, bool isActive
});




}
/// @nodoc
class __$SelfProfileCopyWithImpl<$Res>
    implements _$SelfProfileCopyWith<$Res> {
  __$SelfProfileCopyWithImpl(this._self, this._then);

  final _SelfProfile _self;
  final $Res Function(_SelfProfile) _then;

/// Create a copy of SelfProfile
/// with the given fields replaced by the non-null parameter values.
@override @pragma('vm:prefer-inline') $Res call({Object? id = null,Object? fullName = freezed,Object? email = freezed,Object? role = freezed,Object? isActive = null,}) {
  return _then(_SelfProfile(
id: null == id ? _self.id : id // ignore: cast_nullable_to_non_nullable
as String,fullName: freezed == fullName ? _self.fullName : fullName // ignore: cast_nullable_to_non_nullable
as String?,email: freezed == email ? _self.email : email // ignore: cast_nullable_to_non_nullable
as String?,role: freezed == role ? _self.role : role // ignore: cast_nullable_to_non_nullable
as String?,isActive: null == isActive ? _self.isActive : isActive // ignore: cast_nullable_to_non_nullable
as bool,
  ));
}


}


/// @nodoc
mixin _$CommissionSummary {

 String? get monthKey;@FlexibleDoubleConverter() double? get commissionAmount; int get agreements; int get pending; int get approved; int get paid;
/// Create a copy of CommissionSummary
/// with the given fields replaced by the non-null parameter values.
@JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
$CommissionSummaryCopyWith<CommissionSummary> get copyWith => _$CommissionSummaryCopyWithImpl<CommissionSummary>(this as CommissionSummary, _$identity);

  /// Serializes this CommissionSummary to a JSON map.
  Map<String, dynamic> toJson();


@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is CommissionSummary&&(identical(other.monthKey, monthKey) || other.monthKey == monthKey)&&(identical(other.commissionAmount, commissionAmount) || other.commissionAmount == commissionAmount)&&(identical(other.agreements, agreements) || other.agreements == agreements)&&(identical(other.pending, pending) || other.pending == pending)&&(identical(other.approved, approved) || other.approved == approved)&&(identical(other.paid, paid) || other.paid == paid));
}

@JsonKey(includeFromJson: false, includeToJson: false)
@override
int get hashCode => Object.hash(runtimeType,monthKey,commissionAmount,agreements,pending,approved,paid);

@override
String toString() {
  return 'CommissionSummary(monthKey: $monthKey, commissionAmount: $commissionAmount, agreements: $agreements, pending: $pending, approved: $approved, paid: $paid)';
}


}

/// @nodoc
abstract mixin class $CommissionSummaryCopyWith<$Res>  {
  factory $CommissionSummaryCopyWith(CommissionSummary value, $Res Function(CommissionSummary) _then) = _$CommissionSummaryCopyWithImpl;
@useResult
$Res call({
 String? monthKey,@FlexibleDoubleConverter() double? commissionAmount, int agreements, int pending, int approved, int paid
});




}
/// @nodoc
class _$CommissionSummaryCopyWithImpl<$Res>
    implements $CommissionSummaryCopyWith<$Res> {
  _$CommissionSummaryCopyWithImpl(this._self, this._then);

  final CommissionSummary _self;
  final $Res Function(CommissionSummary) _then;

/// Create a copy of CommissionSummary
/// with the given fields replaced by the non-null parameter values.
@pragma('vm:prefer-inline') @override $Res call({Object? monthKey = freezed,Object? commissionAmount = freezed,Object? agreements = null,Object? pending = null,Object? approved = null,Object? paid = null,}) {
  return _then(_self.copyWith(
monthKey: freezed == monthKey ? _self.monthKey : monthKey // ignore: cast_nullable_to_non_nullable
as String?,commissionAmount: freezed == commissionAmount ? _self.commissionAmount : commissionAmount // ignore: cast_nullable_to_non_nullable
as double?,agreements: null == agreements ? _self.agreements : agreements // ignore: cast_nullable_to_non_nullable
as int,pending: null == pending ? _self.pending : pending // ignore: cast_nullable_to_non_nullable
as int,approved: null == approved ? _self.approved : approved // ignore: cast_nullable_to_non_nullable
as int,paid: null == paid ? _self.paid : paid // ignore: cast_nullable_to_non_nullable
as int,
  ));
}

}


/// Adds pattern-matching-related methods to [CommissionSummary].
extension CommissionSummaryPatterns on CommissionSummary {
/// A variant of `map` that fallback to returning `orElse`.
///
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case final Subclass value:
///     return ...;
///   case _:
///     return orElse();
/// }
/// ```

@optionalTypeArgs TResult maybeMap<TResult extends Object?>(TResult Function( _CommissionSummary value)?  $default,{required TResult orElse(),}){
final _that = this;
switch (_that) {
case _CommissionSummary() when $default != null:
return $default(_that);case _:
  return orElse();

}
}
/// A `switch`-like method, using callbacks.
///
/// Callbacks receives the raw object, upcasted.
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case final Subclass value:
///     return ...;
///   case final Subclass2 value:
///     return ...;
/// }
/// ```

@optionalTypeArgs TResult map<TResult extends Object?>(TResult Function( _CommissionSummary value)  $default,){
final _that = this;
switch (_that) {
case _CommissionSummary():
return $default(_that);case _:
  throw StateError('Unexpected subclass');

}
}
/// A variant of `map` that fallback to returning `null`.
///
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case final Subclass value:
///     return ...;
///   case _:
///     return null;
/// }
/// ```

@optionalTypeArgs TResult? mapOrNull<TResult extends Object?>(TResult? Function( _CommissionSummary value)?  $default,){
final _that = this;
switch (_that) {
case _CommissionSummary() when $default != null:
return $default(_that);case _:
  return null;

}
}
/// A variant of `when` that fallback to an `orElse` callback.
///
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case Subclass(:final field):
///     return ...;
///   case _:
///     return orElse();
/// }
/// ```

@optionalTypeArgs TResult maybeWhen<TResult extends Object?>(TResult Function( String? monthKey, @FlexibleDoubleConverter()  double? commissionAmount,  int agreements,  int pending,  int approved,  int paid)?  $default,{required TResult orElse(),}) {final _that = this;
switch (_that) {
case _CommissionSummary() when $default != null:
return $default(_that.monthKey,_that.commissionAmount,_that.agreements,_that.pending,_that.approved,_that.paid);case _:
  return orElse();

}
}
/// A `switch`-like method, using callbacks.
///
/// As opposed to `map`, this offers destructuring.
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case Subclass(:final field):
///     return ...;
///   case Subclass2(:final field2):
///     return ...;
/// }
/// ```

@optionalTypeArgs TResult when<TResult extends Object?>(TResult Function( String? monthKey, @FlexibleDoubleConverter()  double? commissionAmount,  int agreements,  int pending,  int approved,  int paid)  $default,) {final _that = this;
switch (_that) {
case _CommissionSummary():
return $default(_that.monthKey,_that.commissionAmount,_that.agreements,_that.pending,_that.approved,_that.paid);case _:
  throw StateError('Unexpected subclass');

}
}
/// A variant of `when` that fallback to returning `null`
///
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case Subclass(:final field):
///     return ...;
///   case _:
///     return null;
/// }
/// ```

@optionalTypeArgs TResult? whenOrNull<TResult extends Object?>(TResult? Function( String? monthKey, @FlexibleDoubleConverter()  double? commissionAmount,  int agreements,  int pending,  int approved,  int paid)?  $default,) {final _that = this;
switch (_that) {
case _CommissionSummary() when $default != null:
return $default(_that.monthKey,_that.commissionAmount,_that.agreements,_that.pending,_that.approved,_that.paid);case _:
  return null;

}
}

}

/// @nodoc
@JsonSerializable()

class _CommissionSummary implements CommissionSummary {
  const _CommissionSummary({this.monthKey, @FlexibleDoubleConverter() this.commissionAmount, this.agreements = 0, this.pending = 0, this.approved = 0, this.paid = 0});
  factory _CommissionSummary.fromJson(Map<String, dynamic> json) => _$CommissionSummaryFromJson(json);

@override final  String? monthKey;
@override@FlexibleDoubleConverter() final  double? commissionAmount;
@override@JsonKey() final  int agreements;
@override@JsonKey() final  int pending;
@override@JsonKey() final  int approved;
@override@JsonKey() final  int paid;

/// Create a copy of CommissionSummary
/// with the given fields replaced by the non-null parameter values.
@override @JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
_$CommissionSummaryCopyWith<_CommissionSummary> get copyWith => __$CommissionSummaryCopyWithImpl<_CommissionSummary>(this, _$identity);

@override
Map<String, dynamic> toJson() {
  return _$CommissionSummaryToJson(this, );
}

@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is _CommissionSummary&&(identical(other.monthKey, monthKey) || other.monthKey == monthKey)&&(identical(other.commissionAmount, commissionAmount) || other.commissionAmount == commissionAmount)&&(identical(other.agreements, agreements) || other.agreements == agreements)&&(identical(other.pending, pending) || other.pending == pending)&&(identical(other.approved, approved) || other.approved == approved)&&(identical(other.paid, paid) || other.paid == paid));
}

@JsonKey(includeFromJson: false, includeToJson: false)
@override
int get hashCode => Object.hash(runtimeType,monthKey,commissionAmount,agreements,pending,approved,paid);

@override
String toString() {
  return 'CommissionSummary(monthKey: $monthKey, commissionAmount: $commissionAmount, agreements: $agreements, pending: $pending, approved: $approved, paid: $paid)';
}


}

/// @nodoc
abstract mixin class _$CommissionSummaryCopyWith<$Res> implements $CommissionSummaryCopyWith<$Res> {
  factory _$CommissionSummaryCopyWith(_CommissionSummary value, $Res Function(_CommissionSummary) _then) = __$CommissionSummaryCopyWithImpl;
@override @useResult
$Res call({
 String? monthKey,@FlexibleDoubleConverter() double? commissionAmount, int agreements, int pending, int approved, int paid
});




}
/// @nodoc
class __$CommissionSummaryCopyWithImpl<$Res>
    implements _$CommissionSummaryCopyWith<$Res> {
  __$CommissionSummaryCopyWithImpl(this._self, this._then);

  final _CommissionSummary _self;
  final $Res Function(_CommissionSummary) _then;

/// Create a copy of CommissionSummary
/// with the given fields replaced by the non-null parameter values.
@override @pragma('vm:prefer-inline') $Res call({Object? monthKey = freezed,Object? commissionAmount = freezed,Object? agreements = null,Object? pending = null,Object? approved = null,Object? paid = null,}) {
  return _then(_CommissionSummary(
monthKey: freezed == monthKey ? _self.monthKey : monthKey // ignore: cast_nullable_to_non_nullable
as String?,commissionAmount: freezed == commissionAmount ? _self.commissionAmount : commissionAmount // ignore: cast_nullable_to_non_nullable
as double?,agreements: null == agreements ? _self.agreements : agreements // ignore: cast_nullable_to_non_nullable
as int,pending: null == pending ? _self.pending : pending // ignore: cast_nullable_to_non_nullable
as int,approved: null == approved ? _self.approved : approved // ignore: cast_nullable_to_non_nullable
as int,paid: null == paid ? _self.paid : paid // ignore: cast_nullable_to_non_nullable
as int,
  ));
}


}

// dart format on
