// GENERATED CODE - DO NOT MODIFY BY HAND
// coverage:ignore-file
// ignore_for_file: type=lint
// ignore_for_file: unused_element, deprecated_member_use, deprecated_member_use_from_same_package, use_function_type_syntax_for_parameters, unnecessary_const, avoid_init_to_null, invalid_override_different_default_values_named, prefer_expression_function_bodies, annotate_overrides, invalid_annotation_target, unnecessary_question_mark

part of 'checkout_session.dart';

// **************************************************************************
// FreezedGenerator
// **************************************************************************

// dart format off
T _$identity<T>(T value) => value;

/// @nodoc
mixin _$CheckoutSessionDto {

 String get id; String get reservationId; String? get agreementId; String? get tenantId; String get currentStep;/// JSON string del log de transiciones — se muestra en soporte, no se
/// parsea en caliente.
 String? get events;@IsoDateTimeConverter() DateTime? get tcCompletedAt;@IsoDateTimeConverter() DateTime? get paymentCompletedAt;@IsoDateTimeConverter() DateTime? get inspectionCompletedAt;@IsoDateTimeConverter() DateTime? get customerSignedAt;@IsoDateTimeConverter() DateTime? get startedAt;@IsoDateTimeConverter() DateTime? get finishedAt;@IsoDateTimeConverter() DateTime? get abandonedAt; String? get abandonedReason;@IsoDateTimeConverter() DateTime? get autoEmailedAt; String? get startedByUserId;
/// Create a copy of CheckoutSessionDto
/// with the given fields replaced by the non-null parameter values.
@JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
$CheckoutSessionDtoCopyWith<CheckoutSessionDto> get copyWith => _$CheckoutSessionDtoCopyWithImpl<CheckoutSessionDto>(this as CheckoutSessionDto, _$identity);

  /// Serializes this CheckoutSessionDto to a JSON map.
  Map<String, dynamic> toJson();


@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is CheckoutSessionDto&&(identical(other.id, id) || other.id == id)&&(identical(other.reservationId, reservationId) || other.reservationId == reservationId)&&(identical(other.agreementId, agreementId) || other.agreementId == agreementId)&&(identical(other.tenantId, tenantId) || other.tenantId == tenantId)&&(identical(other.currentStep, currentStep) || other.currentStep == currentStep)&&(identical(other.events, events) || other.events == events)&&(identical(other.tcCompletedAt, tcCompletedAt) || other.tcCompletedAt == tcCompletedAt)&&(identical(other.paymentCompletedAt, paymentCompletedAt) || other.paymentCompletedAt == paymentCompletedAt)&&(identical(other.inspectionCompletedAt, inspectionCompletedAt) || other.inspectionCompletedAt == inspectionCompletedAt)&&(identical(other.customerSignedAt, customerSignedAt) || other.customerSignedAt == customerSignedAt)&&(identical(other.startedAt, startedAt) || other.startedAt == startedAt)&&(identical(other.finishedAt, finishedAt) || other.finishedAt == finishedAt)&&(identical(other.abandonedAt, abandonedAt) || other.abandonedAt == abandonedAt)&&(identical(other.abandonedReason, abandonedReason) || other.abandonedReason == abandonedReason)&&(identical(other.autoEmailedAt, autoEmailedAt) || other.autoEmailedAt == autoEmailedAt)&&(identical(other.startedByUserId, startedByUserId) || other.startedByUserId == startedByUserId));
}

@JsonKey(includeFromJson: false, includeToJson: false)
@override
int get hashCode => Object.hash(runtimeType,id,reservationId,agreementId,tenantId,currentStep,events,tcCompletedAt,paymentCompletedAt,inspectionCompletedAt,customerSignedAt,startedAt,finishedAt,abandonedAt,abandonedReason,autoEmailedAt,startedByUserId);

@override
String toString() {
  return 'CheckoutSessionDto(id: $id, reservationId: $reservationId, agreementId: $agreementId, tenantId: $tenantId, currentStep: $currentStep, events: $events, tcCompletedAt: $tcCompletedAt, paymentCompletedAt: $paymentCompletedAt, inspectionCompletedAt: $inspectionCompletedAt, customerSignedAt: $customerSignedAt, startedAt: $startedAt, finishedAt: $finishedAt, abandonedAt: $abandonedAt, abandonedReason: $abandonedReason, autoEmailedAt: $autoEmailedAt, startedByUserId: $startedByUserId)';
}


}

/// @nodoc
abstract mixin class $CheckoutSessionDtoCopyWith<$Res>  {
  factory $CheckoutSessionDtoCopyWith(CheckoutSessionDto value, $Res Function(CheckoutSessionDto) _then) = _$CheckoutSessionDtoCopyWithImpl;
@useResult
$Res call({
 String id, String reservationId, String? agreementId, String? tenantId, String currentStep, String? events,@IsoDateTimeConverter() DateTime? tcCompletedAt,@IsoDateTimeConverter() DateTime? paymentCompletedAt,@IsoDateTimeConverter() DateTime? inspectionCompletedAt,@IsoDateTimeConverter() DateTime? customerSignedAt,@IsoDateTimeConverter() DateTime? startedAt,@IsoDateTimeConverter() DateTime? finishedAt,@IsoDateTimeConverter() DateTime? abandonedAt, String? abandonedReason,@IsoDateTimeConverter() DateTime? autoEmailedAt, String? startedByUserId
});




}
/// @nodoc
class _$CheckoutSessionDtoCopyWithImpl<$Res>
    implements $CheckoutSessionDtoCopyWith<$Res> {
  _$CheckoutSessionDtoCopyWithImpl(this._self, this._then);

  final CheckoutSessionDto _self;
  final $Res Function(CheckoutSessionDto) _then;

/// Create a copy of CheckoutSessionDto
/// with the given fields replaced by the non-null parameter values.
@pragma('vm:prefer-inline') @override $Res call({Object? id = null,Object? reservationId = null,Object? agreementId = freezed,Object? tenantId = freezed,Object? currentStep = null,Object? events = freezed,Object? tcCompletedAt = freezed,Object? paymentCompletedAt = freezed,Object? inspectionCompletedAt = freezed,Object? customerSignedAt = freezed,Object? startedAt = freezed,Object? finishedAt = freezed,Object? abandonedAt = freezed,Object? abandonedReason = freezed,Object? autoEmailedAt = freezed,Object? startedByUserId = freezed,}) {
  return _then(_self.copyWith(
id: null == id ? _self.id : id // ignore: cast_nullable_to_non_nullable
as String,reservationId: null == reservationId ? _self.reservationId : reservationId // ignore: cast_nullable_to_non_nullable
as String,agreementId: freezed == agreementId ? _self.agreementId : agreementId // ignore: cast_nullable_to_non_nullable
as String?,tenantId: freezed == tenantId ? _self.tenantId : tenantId // ignore: cast_nullable_to_non_nullable
as String?,currentStep: null == currentStep ? _self.currentStep : currentStep // ignore: cast_nullable_to_non_nullable
as String,events: freezed == events ? _self.events : events // ignore: cast_nullable_to_non_nullable
as String?,tcCompletedAt: freezed == tcCompletedAt ? _self.tcCompletedAt : tcCompletedAt // ignore: cast_nullable_to_non_nullable
as DateTime?,paymentCompletedAt: freezed == paymentCompletedAt ? _self.paymentCompletedAt : paymentCompletedAt // ignore: cast_nullable_to_non_nullable
as DateTime?,inspectionCompletedAt: freezed == inspectionCompletedAt ? _self.inspectionCompletedAt : inspectionCompletedAt // ignore: cast_nullable_to_non_nullable
as DateTime?,customerSignedAt: freezed == customerSignedAt ? _self.customerSignedAt : customerSignedAt // ignore: cast_nullable_to_non_nullable
as DateTime?,startedAt: freezed == startedAt ? _self.startedAt : startedAt // ignore: cast_nullable_to_non_nullable
as DateTime?,finishedAt: freezed == finishedAt ? _self.finishedAt : finishedAt // ignore: cast_nullable_to_non_nullable
as DateTime?,abandonedAt: freezed == abandonedAt ? _self.abandonedAt : abandonedAt // ignore: cast_nullable_to_non_nullable
as DateTime?,abandonedReason: freezed == abandonedReason ? _self.abandonedReason : abandonedReason // ignore: cast_nullable_to_non_nullable
as String?,autoEmailedAt: freezed == autoEmailedAt ? _self.autoEmailedAt : autoEmailedAt // ignore: cast_nullable_to_non_nullable
as DateTime?,startedByUserId: freezed == startedByUserId ? _self.startedByUserId : startedByUserId // ignore: cast_nullable_to_non_nullable
as String?,
  ));
}

}


/// Adds pattern-matching-related methods to [CheckoutSessionDto].
extension CheckoutSessionDtoPatterns on CheckoutSessionDto {
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

@optionalTypeArgs TResult maybeMap<TResult extends Object?>(TResult Function( _CheckoutSessionDto value)?  $default,{required TResult orElse(),}){
final _that = this;
switch (_that) {
case _CheckoutSessionDto() when $default != null:
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

@optionalTypeArgs TResult map<TResult extends Object?>(TResult Function( _CheckoutSessionDto value)  $default,){
final _that = this;
switch (_that) {
case _CheckoutSessionDto():
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

@optionalTypeArgs TResult? mapOrNull<TResult extends Object?>(TResult? Function( _CheckoutSessionDto value)?  $default,){
final _that = this;
switch (_that) {
case _CheckoutSessionDto() when $default != null:
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

@optionalTypeArgs TResult maybeWhen<TResult extends Object?>(TResult Function( String id,  String reservationId,  String? agreementId,  String? tenantId,  String currentStep,  String? events, @IsoDateTimeConverter()  DateTime? tcCompletedAt, @IsoDateTimeConverter()  DateTime? paymentCompletedAt, @IsoDateTimeConverter()  DateTime? inspectionCompletedAt, @IsoDateTimeConverter()  DateTime? customerSignedAt, @IsoDateTimeConverter()  DateTime? startedAt, @IsoDateTimeConverter()  DateTime? finishedAt, @IsoDateTimeConverter()  DateTime? abandonedAt,  String? abandonedReason, @IsoDateTimeConverter()  DateTime? autoEmailedAt,  String? startedByUserId)?  $default,{required TResult orElse(),}) {final _that = this;
switch (_that) {
case _CheckoutSessionDto() when $default != null:
return $default(_that.id,_that.reservationId,_that.agreementId,_that.tenantId,_that.currentStep,_that.events,_that.tcCompletedAt,_that.paymentCompletedAt,_that.inspectionCompletedAt,_that.customerSignedAt,_that.startedAt,_that.finishedAt,_that.abandonedAt,_that.abandonedReason,_that.autoEmailedAt,_that.startedByUserId);case _:
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

@optionalTypeArgs TResult when<TResult extends Object?>(TResult Function( String id,  String reservationId,  String? agreementId,  String? tenantId,  String currentStep,  String? events, @IsoDateTimeConverter()  DateTime? tcCompletedAt, @IsoDateTimeConverter()  DateTime? paymentCompletedAt, @IsoDateTimeConverter()  DateTime? inspectionCompletedAt, @IsoDateTimeConverter()  DateTime? customerSignedAt, @IsoDateTimeConverter()  DateTime? startedAt, @IsoDateTimeConverter()  DateTime? finishedAt, @IsoDateTimeConverter()  DateTime? abandonedAt,  String? abandonedReason, @IsoDateTimeConverter()  DateTime? autoEmailedAt,  String? startedByUserId)  $default,) {final _that = this;
switch (_that) {
case _CheckoutSessionDto():
return $default(_that.id,_that.reservationId,_that.agreementId,_that.tenantId,_that.currentStep,_that.events,_that.tcCompletedAt,_that.paymentCompletedAt,_that.inspectionCompletedAt,_that.customerSignedAt,_that.startedAt,_that.finishedAt,_that.abandonedAt,_that.abandonedReason,_that.autoEmailedAt,_that.startedByUserId);case _:
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

@optionalTypeArgs TResult? whenOrNull<TResult extends Object?>(TResult? Function( String id,  String reservationId,  String? agreementId,  String? tenantId,  String currentStep,  String? events, @IsoDateTimeConverter()  DateTime? tcCompletedAt, @IsoDateTimeConverter()  DateTime? paymentCompletedAt, @IsoDateTimeConverter()  DateTime? inspectionCompletedAt, @IsoDateTimeConverter()  DateTime? customerSignedAt, @IsoDateTimeConverter()  DateTime? startedAt, @IsoDateTimeConverter()  DateTime? finishedAt, @IsoDateTimeConverter()  DateTime? abandonedAt,  String? abandonedReason, @IsoDateTimeConverter()  DateTime? autoEmailedAt,  String? startedByUserId)?  $default,) {final _that = this;
switch (_that) {
case _CheckoutSessionDto() when $default != null:
return $default(_that.id,_that.reservationId,_that.agreementId,_that.tenantId,_that.currentStep,_that.events,_that.tcCompletedAt,_that.paymentCompletedAt,_that.inspectionCompletedAt,_that.customerSignedAt,_that.startedAt,_that.finishedAt,_that.abandonedAt,_that.abandonedReason,_that.autoEmailedAt,_that.startedByUserId);case _:
  return null;

}
}

}

/// @nodoc
@JsonSerializable()

class _CheckoutSessionDto extends CheckoutSessionDto {
  const _CheckoutSessionDto({required this.id, required this.reservationId, this.agreementId, this.tenantId, required this.currentStep, this.events, @IsoDateTimeConverter() this.tcCompletedAt, @IsoDateTimeConverter() this.paymentCompletedAt, @IsoDateTimeConverter() this.inspectionCompletedAt, @IsoDateTimeConverter() this.customerSignedAt, @IsoDateTimeConverter() this.startedAt, @IsoDateTimeConverter() this.finishedAt, @IsoDateTimeConverter() this.abandonedAt, this.abandonedReason, @IsoDateTimeConverter() this.autoEmailedAt, this.startedByUserId}): super._();
  factory _CheckoutSessionDto.fromJson(Map<String, dynamic> json) => _$CheckoutSessionDtoFromJson(json);

@override final  String id;
@override final  String reservationId;
@override final  String? agreementId;
@override final  String? tenantId;
@override final  String currentStep;
/// JSON string del log de transiciones — se muestra en soporte, no se
/// parsea en caliente.
@override final  String? events;
@override@IsoDateTimeConverter() final  DateTime? tcCompletedAt;
@override@IsoDateTimeConverter() final  DateTime? paymentCompletedAt;
@override@IsoDateTimeConverter() final  DateTime? inspectionCompletedAt;
@override@IsoDateTimeConverter() final  DateTime? customerSignedAt;
@override@IsoDateTimeConverter() final  DateTime? startedAt;
@override@IsoDateTimeConverter() final  DateTime? finishedAt;
@override@IsoDateTimeConverter() final  DateTime? abandonedAt;
@override final  String? abandonedReason;
@override@IsoDateTimeConverter() final  DateTime? autoEmailedAt;
@override final  String? startedByUserId;

/// Create a copy of CheckoutSessionDto
/// with the given fields replaced by the non-null parameter values.
@override @JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
_$CheckoutSessionDtoCopyWith<_CheckoutSessionDto> get copyWith => __$CheckoutSessionDtoCopyWithImpl<_CheckoutSessionDto>(this, _$identity);

@override
Map<String, dynamic> toJson() {
  return _$CheckoutSessionDtoToJson(this, );
}

@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is _CheckoutSessionDto&&(identical(other.id, id) || other.id == id)&&(identical(other.reservationId, reservationId) || other.reservationId == reservationId)&&(identical(other.agreementId, agreementId) || other.agreementId == agreementId)&&(identical(other.tenantId, tenantId) || other.tenantId == tenantId)&&(identical(other.currentStep, currentStep) || other.currentStep == currentStep)&&(identical(other.events, events) || other.events == events)&&(identical(other.tcCompletedAt, tcCompletedAt) || other.tcCompletedAt == tcCompletedAt)&&(identical(other.paymentCompletedAt, paymentCompletedAt) || other.paymentCompletedAt == paymentCompletedAt)&&(identical(other.inspectionCompletedAt, inspectionCompletedAt) || other.inspectionCompletedAt == inspectionCompletedAt)&&(identical(other.customerSignedAt, customerSignedAt) || other.customerSignedAt == customerSignedAt)&&(identical(other.startedAt, startedAt) || other.startedAt == startedAt)&&(identical(other.finishedAt, finishedAt) || other.finishedAt == finishedAt)&&(identical(other.abandonedAt, abandonedAt) || other.abandonedAt == abandonedAt)&&(identical(other.abandonedReason, abandonedReason) || other.abandonedReason == abandonedReason)&&(identical(other.autoEmailedAt, autoEmailedAt) || other.autoEmailedAt == autoEmailedAt)&&(identical(other.startedByUserId, startedByUserId) || other.startedByUserId == startedByUserId));
}

@JsonKey(includeFromJson: false, includeToJson: false)
@override
int get hashCode => Object.hash(runtimeType,id,reservationId,agreementId,tenantId,currentStep,events,tcCompletedAt,paymentCompletedAt,inspectionCompletedAt,customerSignedAt,startedAt,finishedAt,abandonedAt,abandonedReason,autoEmailedAt,startedByUserId);

@override
String toString() {
  return 'CheckoutSessionDto(id: $id, reservationId: $reservationId, agreementId: $agreementId, tenantId: $tenantId, currentStep: $currentStep, events: $events, tcCompletedAt: $tcCompletedAt, paymentCompletedAt: $paymentCompletedAt, inspectionCompletedAt: $inspectionCompletedAt, customerSignedAt: $customerSignedAt, startedAt: $startedAt, finishedAt: $finishedAt, abandonedAt: $abandonedAt, abandonedReason: $abandonedReason, autoEmailedAt: $autoEmailedAt, startedByUserId: $startedByUserId)';
}


}

/// @nodoc
abstract mixin class _$CheckoutSessionDtoCopyWith<$Res> implements $CheckoutSessionDtoCopyWith<$Res> {
  factory _$CheckoutSessionDtoCopyWith(_CheckoutSessionDto value, $Res Function(_CheckoutSessionDto) _then) = __$CheckoutSessionDtoCopyWithImpl;
@override @useResult
$Res call({
 String id, String reservationId, String? agreementId, String? tenantId, String currentStep, String? events,@IsoDateTimeConverter() DateTime? tcCompletedAt,@IsoDateTimeConverter() DateTime? paymentCompletedAt,@IsoDateTimeConverter() DateTime? inspectionCompletedAt,@IsoDateTimeConverter() DateTime? customerSignedAt,@IsoDateTimeConverter() DateTime? startedAt,@IsoDateTimeConverter() DateTime? finishedAt,@IsoDateTimeConverter() DateTime? abandonedAt, String? abandonedReason,@IsoDateTimeConverter() DateTime? autoEmailedAt, String? startedByUserId
});




}
/// @nodoc
class __$CheckoutSessionDtoCopyWithImpl<$Res>
    implements _$CheckoutSessionDtoCopyWith<$Res> {
  __$CheckoutSessionDtoCopyWithImpl(this._self, this._then);

  final _CheckoutSessionDto _self;
  final $Res Function(_CheckoutSessionDto) _then;

/// Create a copy of CheckoutSessionDto
/// with the given fields replaced by the non-null parameter values.
@override @pragma('vm:prefer-inline') $Res call({Object? id = null,Object? reservationId = null,Object? agreementId = freezed,Object? tenantId = freezed,Object? currentStep = null,Object? events = freezed,Object? tcCompletedAt = freezed,Object? paymentCompletedAt = freezed,Object? inspectionCompletedAt = freezed,Object? customerSignedAt = freezed,Object? startedAt = freezed,Object? finishedAt = freezed,Object? abandonedAt = freezed,Object? abandonedReason = freezed,Object? autoEmailedAt = freezed,Object? startedByUserId = freezed,}) {
  return _then(_CheckoutSessionDto(
id: null == id ? _self.id : id // ignore: cast_nullable_to_non_nullable
as String,reservationId: null == reservationId ? _self.reservationId : reservationId // ignore: cast_nullable_to_non_nullable
as String,agreementId: freezed == agreementId ? _self.agreementId : agreementId // ignore: cast_nullable_to_non_nullable
as String?,tenantId: freezed == tenantId ? _self.tenantId : tenantId // ignore: cast_nullable_to_non_nullable
as String?,currentStep: null == currentStep ? _self.currentStep : currentStep // ignore: cast_nullable_to_non_nullable
as String,events: freezed == events ? _self.events : events // ignore: cast_nullable_to_non_nullable
as String?,tcCompletedAt: freezed == tcCompletedAt ? _self.tcCompletedAt : tcCompletedAt // ignore: cast_nullable_to_non_nullable
as DateTime?,paymentCompletedAt: freezed == paymentCompletedAt ? _self.paymentCompletedAt : paymentCompletedAt // ignore: cast_nullable_to_non_nullable
as DateTime?,inspectionCompletedAt: freezed == inspectionCompletedAt ? _self.inspectionCompletedAt : inspectionCompletedAt // ignore: cast_nullable_to_non_nullable
as DateTime?,customerSignedAt: freezed == customerSignedAt ? _self.customerSignedAt : customerSignedAt // ignore: cast_nullable_to_non_nullable
as DateTime?,startedAt: freezed == startedAt ? _self.startedAt : startedAt // ignore: cast_nullable_to_non_nullable
as DateTime?,finishedAt: freezed == finishedAt ? _self.finishedAt : finishedAt // ignore: cast_nullable_to_non_nullable
as DateTime?,abandonedAt: freezed == abandonedAt ? _self.abandonedAt : abandonedAt // ignore: cast_nullable_to_non_nullable
as DateTime?,abandonedReason: freezed == abandonedReason ? _self.abandonedReason : abandonedReason // ignore: cast_nullable_to_non_nullable
as String?,autoEmailedAt: freezed == autoEmailedAt ? _self.autoEmailedAt : autoEmailedAt // ignore: cast_nullable_to_non_nullable
as DateTime?,startedByUserId: freezed == startedByUserId ? _self.startedByUserId : startedByUserId // ignore: cast_nullable_to_non_nullable
as String?,
  ));
}


}

// dart format on
