// GENERATED CODE - DO NOT MODIFY BY HAND
// coverage:ignore-file
// ignore_for_file: type=lint
// ignore_for_file: unused_element, deprecated_member_use, deprecated_member_use_from_same_package, use_function_type_syntax_for_parameters, unnecessary_const, avoid_init_to_null, invalid_override_different_default_values_named, prefer_expression_function_bodies, annotate_overrides, invalid_annotation_target, unnecessary_question_mark

part of 'reservation_card.dart';

// **************************************************************************
// FreezedGenerator
// **************************************************************************

// dart format off
T _$identity<T>(T value) => value;

/// @nodoc
mixin _$ReservationCard {

 String get id; String? get reservationNumber; String get status; String get workflowMode; String? get paymentStatus;@IsoDateTimeConverter() DateTime? get pickupAt;@IsoDateTimeConverter() DateTime? get returnAt;@FlexibleDoubleConverter() double? get estimatedTotal;@IsoDateTimeConverter() DateTime? get readyForPickupAt;@IsoDateTimeConverter() DateTime? get customerInfoCompletedAt;@IsoDateTimeConverter() DateTime? get customerInfoReviewedAt;@IsoDateTimeConverter() DateTime? get estimatedServiceCompletionAt; String get repairOrderNumber; String get claimNumber; String get serviceAdvisorName; String get loanerBillingMode; String get loanerBillingStatus;@IsoDateTimeConverter() DateTime? get loanerBorrowerPacketCompletedAt; bool get loanerReturnExceptionFlag; CustomerCard? get customer; VehicleCard? get vehicle; VehicleTypeCard? get vehicleType;
/// Create a copy of ReservationCard
/// with the given fields replaced by the non-null parameter values.
@JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
$ReservationCardCopyWith<ReservationCard> get copyWith => _$ReservationCardCopyWithImpl<ReservationCard>(this as ReservationCard, _$identity);

  /// Serializes this ReservationCard to a JSON map.
  Map<String, dynamic> toJson();


@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is ReservationCard&&(identical(other.id, id) || other.id == id)&&(identical(other.reservationNumber, reservationNumber) || other.reservationNumber == reservationNumber)&&(identical(other.status, status) || other.status == status)&&(identical(other.workflowMode, workflowMode) || other.workflowMode == workflowMode)&&(identical(other.paymentStatus, paymentStatus) || other.paymentStatus == paymentStatus)&&(identical(other.pickupAt, pickupAt) || other.pickupAt == pickupAt)&&(identical(other.returnAt, returnAt) || other.returnAt == returnAt)&&(identical(other.estimatedTotal, estimatedTotal) || other.estimatedTotal == estimatedTotal)&&(identical(other.readyForPickupAt, readyForPickupAt) || other.readyForPickupAt == readyForPickupAt)&&(identical(other.customerInfoCompletedAt, customerInfoCompletedAt) || other.customerInfoCompletedAt == customerInfoCompletedAt)&&(identical(other.customerInfoReviewedAt, customerInfoReviewedAt) || other.customerInfoReviewedAt == customerInfoReviewedAt)&&(identical(other.estimatedServiceCompletionAt, estimatedServiceCompletionAt) || other.estimatedServiceCompletionAt == estimatedServiceCompletionAt)&&(identical(other.repairOrderNumber, repairOrderNumber) || other.repairOrderNumber == repairOrderNumber)&&(identical(other.claimNumber, claimNumber) || other.claimNumber == claimNumber)&&(identical(other.serviceAdvisorName, serviceAdvisorName) || other.serviceAdvisorName == serviceAdvisorName)&&(identical(other.loanerBillingMode, loanerBillingMode) || other.loanerBillingMode == loanerBillingMode)&&(identical(other.loanerBillingStatus, loanerBillingStatus) || other.loanerBillingStatus == loanerBillingStatus)&&(identical(other.loanerBorrowerPacketCompletedAt, loanerBorrowerPacketCompletedAt) || other.loanerBorrowerPacketCompletedAt == loanerBorrowerPacketCompletedAt)&&(identical(other.loanerReturnExceptionFlag, loanerReturnExceptionFlag) || other.loanerReturnExceptionFlag == loanerReturnExceptionFlag)&&(identical(other.customer, customer) || other.customer == customer)&&(identical(other.vehicle, vehicle) || other.vehicle == vehicle)&&(identical(other.vehicleType, vehicleType) || other.vehicleType == vehicleType));
}

@JsonKey(includeFromJson: false, includeToJson: false)
@override
int get hashCode => Object.hashAll([runtimeType,id,reservationNumber,status,workflowMode,paymentStatus,pickupAt,returnAt,estimatedTotal,readyForPickupAt,customerInfoCompletedAt,customerInfoReviewedAt,estimatedServiceCompletionAt,repairOrderNumber,claimNumber,serviceAdvisorName,loanerBillingMode,loanerBillingStatus,loanerBorrowerPacketCompletedAt,loanerReturnExceptionFlag,customer,vehicle,vehicleType]);

@override
String toString() {
  return 'ReservationCard(id: $id, reservationNumber: $reservationNumber, status: $status, workflowMode: $workflowMode, paymentStatus: $paymentStatus, pickupAt: $pickupAt, returnAt: $returnAt, estimatedTotal: $estimatedTotal, readyForPickupAt: $readyForPickupAt, customerInfoCompletedAt: $customerInfoCompletedAt, customerInfoReviewedAt: $customerInfoReviewedAt, estimatedServiceCompletionAt: $estimatedServiceCompletionAt, repairOrderNumber: $repairOrderNumber, claimNumber: $claimNumber, serviceAdvisorName: $serviceAdvisorName, loanerBillingMode: $loanerBillingMode, loanerBillingStatus: $loanerBillingStatus, loanerBorrowerPacketCompletedAt: $loanerBorrowerPacketCompletedAt, loanerReturnExceptionFlag: $loanerReturnExceptionFlag, customer: $customer, vehicle: $vehicle, vehicleType: $vehicleType)';
}


}

/// @nodoc
abstract mixin class $ReservationCardCopyWith<$Res>  {
  factory $ReservationCardCopyWith(ReservationCard value, $Res Function(ReservationCard) _then) = _$ReservationCardCopyWithImpl;
@useResult
$Res call({
 String id, String? reservationNumber, String status, String workflowMode, String? paymentStatus,@IsoDateTimeConverter() DateTime? pickupAt,@IsoDateTimeConverter() DateTime? returnAt,@FlexibleDoubleConverter() double? estimatedTotal,@IsoDateTimeConverter() DateTime? readyForPickupAt,@IsoDateTimeConverter() DateTime? customerInfoCompletedAt,@IsoDateTimeConverter() DateTime? customerInfoReviewedAt,@IsoDateTimeConverter() DateTime? estimatedServiceCompletionAt, String repairOrderNumber, String claimNumber, String serviceAdvisorName, String loanerBillingMode, String loanerBillingStatus,@IsoDateTimeConverter() DateTime? loanerBorrowerPacketCompletedAt, bool loanerReturnExceptionFlag, CustomerCard? customer, VehicleCard? vehicle, VehicleTypeCard? vehicleType
});


$CustomerCardCopyWith<$Res>? get customer;$VehicleCardCopyWith<$Res>? get vehicle;$VehicleTypeCardCopyWith<$Res>? get vehicleType;

}
/// @nodoc
class _$ReservationCardCopyWithImpl<$Res>
    implements $ReservationCardCopyWith<$Res> {
  _$ReservationCardCopyWithImpl(this._self, this._then);

  final ReservationCard _self;
  final $Res Function(ReservationCard) _then;

/// Create a copy of ReservationCard
/// with the given fields replaced by the non-null parameter values.
@pragma('vm:prefer-inline') @override $Res call({Object? id = null,Object? reservationNumber = freezed,Object? status = null,Object? workflowMode = null,Object? paymentStatus = freezed,Object? pickupAt = freezed,Object? returnAt = freezed,Object? estimatedTotal = freezed,Object? readyForPickupAt = freezed,Object? customerInfoCompletedAt = freezed,Object? customerInfoReviewedAt = freezed,Object? estimatedServiceCompletionAt = freezed,Object? repairOrderNumber = null,Object? claimNumber = null,Object? serviceAdvisorName = null,Object? loanerBillingMode = null,Object? loanerBillingStatus = null,Object? loanerBorrowerPacketCompletedAt = freezed,Object? loanerReturnExceptionFlag = null,Object? customer = freezed,Object? vehicle = freezed,Object? vehicleType = freezed,}) {
  return _then(_self.copyWith(
id: null == id ? _self.id : id // ignore: cast_nullable_to_non_nullable
as String,reservationNumber: freezed == reservationNumber ? _self.reservationNumber : reservationNumber // ignore: cast_nullable_to_non_nullable
as String?,status: null == status ? _self.status : status // ignore: cast_nullable_to_non_nullable
as String,workflowMode: null == workflowMode ? _self.workflowMode : workflowMode // ignore: cast_nullable_to_non_nullable
as String,paymentStatus: freezed == paymentStatus ? _self.paymentStatus : paymentStatus // ignore: cast_nullable_to_non_nullable
as String?,pickupAt: freezed == pickupAt ? _self.pickupAt : pickupAt // ignore: cast_nullable_to_non_nullable
as DateTime?,returnAt: freezed == returnAt ? _self.returnAt : returnAt // ignore: cast_nullable_to_non_nullable
as DateTime?,estimatedTotal: freezed == estimatedTotal ? _self.estimatedTotal : estimatedTotal // ignore: cast_nullable_to_non_nullable
as double?,readyForPickupAt: freezed == readyForPickupAt ? _self.readyForPickupAt : readyForPickupAt // ignore: cast_nullable_to_non_nullable
as DateTime?,customerInfoCompletedAt: freezed == customerInfoCompletedAt ? _self.customerInfoCompletedAt : customerInfoCompletedAt // ignore: cast_nullable_to_non_nullable
as DateTime?,customerInfoReviewedAt: freezed == customerInfoReviewedAt ? _self.customerInfoReviewedAt : customerInfoReviewedAt // ignore: cast_nullable_to_non_nullable
as DateTime?,estimatedServiceCompletionAt: freezed == estimatedServiceCompletionAt ? _self.estimatedServiceCompletionAt : estimatedServiceCompletionAt // ignore: cast_nullable_to_non_nullable
as DateTime?,repairOrderNumber: null == repairOrderNumber ? _self.repairOrderNumber : repairOrderNumber // ignore: cast_nullable_to_non_nullable
as String,claimNumber: null == claimNumber ? _self.claimNumber : claimNumber // ignore: cast_nullable_to_non_nullable
as String,serviceAdvisorName: null == serviceAdvisorName ? _self.serviceAdvisorName : serviceAdvisorName // ignore: cast_nullable_to_non_nullable
as String,loanerBillingMode: null == loanerBillingMode ? _self.loanerBillingMode : loanerBillingMode // ignore: cast_nullable_to_non_nullable
as String,loanerBillingStatus: null == loanerBillingStatus ? _self.loanerBillingStatus : loanerBillingStatus // ignore: cast_nullable_to_non_nullable
as String,loanerBorrowerPacketCompletedAt: freezed == loanerBorrowerPacketCompletedAt ? _self.loanerBorrowerPacketCompletedAt : loanerBorrowerPacketCompletedAt // ignore: cast_nullable_to_non_nullable
as DateTime?,loanerReturnExceptionFlag: null == loanerReturnExceptionFlag ? _self.loanerReturnExceptionFlag : loanerReturnExceptionFlag // ignore: cast_nullable_to_non_nullable
as bool,customer: freezed == customer ? _self.customer : customer // ignore: cast_nullable_to_non_nullable
as CustomerCard?,vehicle: freezed == vehicle ? _self.vehicle : vehicle // ignore: cast_nullable_to_non_nullable
as VehicleCard?,vehicleType: freezed == vehicleType ? _self.vehicleType : vehicleType // ignore: cast_nullable_to_non_nullable
as VehicleTypeCard?,
  ));
}
/// Create a copy of ReservationCard
/// with the given fields replaced by the non-null parameter values.
@override
@pragma('vm:prefer-inline')
$CustomerCardCopyWith<$Res>? get customer {
    if (_self.customer == null) {
    return null;
  }

  return $CustomerCardCopyWith<$Res>(_self.customer!, (value) {
    return _then(_self.copyWith(customer: value));
  });
}/// Create a copy of ReservationCard
/// with the given fields replaced by the non-null parameter values.
@override
@pragma('vm:prefer-inline')
$VehicleCardCopyWith<$Res>? get vehicle {
    if (_self.vehicle == null) {
    return null;
  }

  return $VehicleCardCopyWith<$Res>(_self.vehicle!, (value) {
    return _then(_self.copyWith(vehicle: value));
  });
}/// Create a copy of ReservationCard
/// with the given fields replaced by the non-null parameter values.
@override
@pragma('vm:prefer-inline')
$VehicleTypeCardCopyWith<$Res>? get vehicleType {
    if (_self.vehicleType == null) {
    return null;
  }

  return $VehicleTypeCardCopyWith<$Res>(_self.vehicleType!, (value) {
    return _then(_self.copyWith(vehicleType: value));
  });
}
}


/// Adds pattern-matching-related methods to [ReservationCard].
extension ReservationCardPatterns on ReservationCard {
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

@optionalTypeArgs TResult maybeMap<TResult extends Object?>(TResult Function( _ReservationCard value)?  $default,{required TResult orElse(),}){
final _that = this;
switch (_that) {
case _ReservationCard() when $default != null:
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

@optionalTypeArgs TResult map<TResult extends Object?>(TResult Function( _ReservationCard value)  $default,){
final _that = this;
switch (_that) {
case _ReservationCard():
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

@optionalTypeArgs TResult? mapOrNull<TResult extends Object?>(TResult? Function( _ReservationCard value)?  $default,){
final _that = this;
switch (_that) {
case _ReservationCard() when $default != null:
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

@optionalTypeArgs TResult maybeWhen<TResult extends Object?>(TResult Function( String id,  String? reservationNumber,  String status,  String workflowMode,  String? paymentStatus, @IsoDateTimeConverter()  DateTime? pickupAt, @IsoDateTimeConverter()  DateTime? returnAt, @FlexibleDoubleConverter()  double? estimatedTotal, @IsoDateTimeConverter()  DateTime? readyForPickupAt, @IsoDateTimeConverter()  DateTime? customerInfoCompletedAt, @IsoDateTimeConverter()  DateTime? customerInfoReviewedAt, @IsoDateTimeConverter()  DateTime? estimatedServiceCompletionAt,  String repairOrderNumber,  String claimNumber,  String serviceAdvisorName,  String loanerBillingMode,  String loanerBillingStatus, @IsoDateTimeConverter()  DateTime? loanerBorrowerPacketCompletedAt,  bool loanerReturnExceptionFlag,  CustomerCard? customer,  VehicleCard? vehicle,  VehicleTypeCard? vehicleType)?  $default,{required TResult orElse(),}) {final _that = this;
switch (_that) {
case _ReservationCard() when $default != null:
return $default(_that.id,_that.reservationNumber,_that.status,_that.workflowMode,_that.paymentStatus,_that.pickupAt,_that.returnAt,_that.estimatedTotal,_that.readyForPickupAt,_that.customerInfoCompletedAt,_that.customerInfoReviewedAt,_that.estimatedServiceCompletionAt,_that.repairOrderNumber,_that.claimNumber,_that.serviceAdvisorName,_that.loanerBillingMode,_that.loanerBillingStatus,_that.loanerBorrowerPacketCompletedAt,_that.loanerReturnExceptionFlag,_that.customer,_that.vehicle,_that.vehicleType);case _:
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

@optionalTypeArgs TResult when<TResult extends Object?>(TResult Function( String id,  String? reservationNumber,  String status,  String workflowMode,  String? paymentStatus, @IsoDateTimeConverter()  DateTime? pickupAt, @IsoDateTimeConverter()  DateTime? returnAt, @FlexibleDoubleConverter()  double? estimatedTotal, @IsoDateTimeConverter()  DateTime? readyForPickupAt, @IsoDateTimeConverter()  DateTime? customerInfoCompletedAt, @IsoDateTimeConverter()  DateTime? customerInfoReviewedAt, @IsoDateTimeConverter()  DateTime? estimatedServiceCompletionAt,  String repairOrderNumber,  String claimNumber,  String serviceAdvisorName,  String loanerBillingMode,  String loanerBillingStatus, @IsoDateTimeConverter()  DateTime? loanerBorrowerPacketCompletedAt,  bool loanerReturnExceptionFlag,  CustomerCard? customer,  VehicleCard? vehicle,  VehicleTypeCard? vehicleType)  $default,) {final _that = this;
switch (_that) {
case _ReservationCard():
return $default(_that.id,_that.reservationNumber,_that.status,_that.workflowMode,_that.paymentStatus,_that.pickupAt,_that.returnAt,_that.estimatedTotal,_that.readyForPickupAt,_that.customerInfoCompletedAt,_that.customerInfoReviewedAt,_that.estimatedServiceCompletionAt,_that.repairOrderNumber,_that.claimNumber,_that.serviceAdvisorName,_that.loanerBillingMode,_that.loanerBillingStatus,_that.loanerBorrowerPacketCompletedAt,_that.loanerReturnExceptionFlag,_that.customer,_that.vehicle,_that.vehicleType);case _:
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

@optionalTypeArgs TResult? whenOrNull<TResult extends Object?>(TResult? Function( String id,  String? reservationNumber,  String status,  String workflowMode,  String? paymentStatus, @IsoDateTimeConverter()  DateTime? pickupAt, @IsoDateTimeConverter()  DateTime? returnAt, @FlexibleDoubleConverter()  double? estimatedTotal, @IsoDateTimeConverter()  DateTime? readyForPickupAt, @IsoDateTimeConverter()  DateTime? customerInfoCompletedAt, @IsoDateTimeConverter()  DateTime? customerInfoReviewedAt, @IsoDateTimeConverter()  DateTime? estimatedServiceCompletionAt,  String repairOrderNumber,  String claimNumber,  String serviceAdvisorName,  String loanerBillingMode,  String loanerBillingStatus, @IsoDateTimeConverter()  DateTime? loanerBorrowerPacketCompletedAt,  bool loanerReturnExceptionFlag,  CustomerCard? customer,  VehicleCard? vehicle,  VehicleTypeCard? vehicleType)?  $default,) {final _that = this;
switch (_that) {
case _ReservationCard() when $default != null:
return $default(_that.id,_that.reservationNumber,_that.status,_that.workflowMode,_that.paymentStatus,_that.pickupAt,_that.returnAt,_that.estimatedTotal,_that.readyForPickupAt,_that.customerInfoCompletedAt,_that.customerInfoReviewedAt,_that.estimatedServiceCompletionAt,_that.repairOrderNumber,_that.claimNumber,_that.serviceAdvisorName,_that.loanerBillingMode,_that.loanerBillingStatus,_that.loanerBorrowerPacketCompletedAt,_that.loanerReturnExceptionFlag,_that.customer,_that.vehicle,_that.vehicleType);case _:
  return null;

}
}

}

/// @nodoc
@JsonSerializable()

class _ReservationCard implements ReservationCard {
  const _ReservationCard({required this.id, this.reservationNumber, required this.status, this.workflowMode = 'RENTAL', this.paymentStatus, @IsoDateTimeConverter() this.pickupAt, @IsoDateTimeConverter() this.returnAt, @FlexibleDoubleConverter() this.estimatedTotal, @IsoDateTimeConverter() this.readyForPickupAt, @IsoDateTimeConverter() this.customerInfoCompletedAt, @IsoDateTimeConverter() this.customerInfoReviewedAt, @IsoDateTimeConverter() this.estimatedServiceCompletionAt, this.repairOrderNumber = '', this.claimNumber = '', this.serviceAdvisorName = '', this.loanerBillingMode = '', this.loanerBillingStatus = '', @IsoDateTimeConverter() this.loanerBorrowerPacketCompletedAt, this.loanerReturnExceptionFlag = false, this.customer, this.vehicle, this.vehicleType});
  factory _ReservationCard.fromJson(Map<String, dynamic> json) => _$ReservationCardFromJson(json);

@override final  String id;
@override final  String? reservationNumber;
@override final  String status;
@override@JsonKey() final  String workflowMode;
@override final  String? paymentStatus;
@override@IsoDateTimeConverter() final  DateTime? pickupAt;
@override@IsoDateTimeConverter() final  DateTime? returnAt;
@override@FlexibleDoubleConverter() final  double? estimatedTotal;
@override@IsoDateTimeConverter() final  DateTime? readyForPickupAt;
@override@IsoDateTimeConverter() final  DateTime? customerInfoCompletedAt;
@override@IsoDateTimeConverter() final  DateTime? customerInfoReviewedAt;
@override@IsoDateTimeConverter() final  DateTime? estimatedServiceCompletionAt;
@override@JsonKey() final  String repairOrderNumber;
@override@JsonKey() final  String claimNumber;
@override@JsonKey() final  String serviceAdvisorName;
@override@JsonKey() final  String loanerBillingMode;
@override@JsonKey() final  String loanerBillingStatus;
@override@IsoDateTimeConverter() final  DateTime? loanerBorrowerPacketCompletedAt;
@override@JsonKey() final  bool loanerReturnExceptionFlag;
@override final  CustomerCard? customer;
@override final  VehicleCard? vehicle;
@override final  VehicleTypeCard? vehicleType;

/// Create a copy of ReservationCard
/// with the given fields replaced by the non-null parameter values.
@override @JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
_$ReservationCardCopyWith<_ReservationCard> get copyWith => __$ReservationCardCopyWithImpl<_ReservationCard>(this, _$identity);

@override
Map<String, dynamic> toJson() {
  return _$ReservationCardToJson(this, );
}

@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is _ReservationCard&&(identical(other.id, id) || other.id == id)&&(identical(other.reservationNumber, reservationNumber) || other.reservationNumber == reservationNumber)&&(identical(other.status, status) || other.status == status)&&(identical(other.workflowMode, workflowMode) || other.workflowMode == workflowMode)&&(identical(other.paymentStatus, paymentStatus) || other.paymentStatus == paymentStatus)&&(identical(other.pickupAt, pickupAt) || other.pickupAt == pickupAt)&&(identical(other.returnAt, returnAt) || other.returnAt == returnAt)&&(identical(other.estimatedTotal, estimatedTotal) || other.estimatedTotal == estimatedTotal)&&(identical(other.readyForPickupAt, readyForPickupAt) || other.readyForPickupAt == readyForPickupAt)&&(identical(other.customerInfoCompletedAt, customerInfoCompletedAt) || other.customerInfoCompletedAt == customerInfoCompletedAt)&&(identical(other.customerInfoReviewedAt, customerInfoReviewedAt) || other.customerInfoReviewedAt == customerInfoReviewedAt)&&(identical(other.estimatedServiceCompletionAt, estimatedServiceCompletionAt) || other.estimatedServiceCompletionAt == estimatedServiceCompletionAt)&&(identical(other.repairOrderNumber, repairOrderNumber) || other.repairOrderNumber == repairOrderNumber)&&(identical(other.claimNumber, claimNumber) || other.claimNumber == claimNumber)&&(identical(other.serviceAdvisorName, serviceAdvisorName) || other.serviceAdvisorName == serviceAdvisorName)&&(identical(other.loanerBillingMode, loanerBillingMode) || other.loanerBillingMode == loanerBillingMode)&&(identical(other.loanerBillingStatus, loanerBillingStatus) || other.loanerBillingStatus == loanerBillingStatus)&&(identical(other.loanerBorrowerPacketCompletedAt, loanerBorrowerPacketCompletedAt) || other.loanerBorrowerPacketCompletedAt == loanerBorrowerPacketCompletedAt)&&(identical(other.loanerReturnExceptionFlag, loanerReturnExceptionFlag) || other.loanerReturnExceptionFlag == loanerReturnExceptionFlag)&&(identical(other.customer, customer) || other.customer == customer)&&(identical(other.vehicle, vehicle) || other.vehicle == vehicle)&&(identical(other.vehicleType, vehicleType) || other.vehicleType == vehicleType));
}

@JsonKey(includeFromJson: false, includeToJson: false)
@override
int get hashCode => Object.hashAll([runtimeType,id,reservationNumber,status,workflowMode,paymentStatus,pickupAt,returnAt,estimatedTotal,readyForPickupAt,customerInfoCompletedAt,customerInfoReviewedAt,estimatedServiceCompletionAt,repairOrderNumber,claimNumber,serviceAdvisorName,loanerBillingMode,loanerBillingStatus,loanerBorrowerPacketCompletedAt,loanerReturnExceptionFlag,customer,vehicle,vehicleType]);

@override
String toString() {
  return 'ReservationCard(id: $id, reservationNumber: $reservationNumber, status: $status, workflowMode: $workflowMode, paymentStatus: $paymentStatus, pickupAt: $pickupAt, returnAt: $returnAt, estimatedTotal: $estimatedTotal, readyForPickupAt: $readyForPickupAt, customerInfoCompletedAt: $customerInfoCompletedAt, customerInfoReviewedAt: $customerInfoReviewedAt, estimatedServiceCompletionAt: $estimatedServiceCompletionAt, repairOrderNumber: $repairOrderNumber, claimNumber: $claimNumber, serviceAdvisorName: $serviceAdvisorName, loanerBillingMode: $loanerBillingMode, loanerBillingStatus: $loanerBillingStatus, loanerBorrowerPacketCompletedAt: $loanerBorrowerPacketCompletedAt, loanerReturnExceptionFlag: $loanerReturnExceptionFlag, customer: $customer, vehicle: $vehicle, vehicleType: $vehicleType)';
}


}

/// @nodoc
abstract mixin class _$ReservationCardCopyWith<$Res> implements $ReservationCardCopyWith<$Res> {
  factory _$ReservationCardCopyWith(_ReservationCard value, $Res Function(_ReservationCard) _then) = __$ReservationCardCopyWithImpl;
@override @useResult
$Res call({
 String id, String? reservationNumber, String status, String workflowMode, String? paymentStatus,@IsoDateTimeConverter() DateTime? pickupAt,@IsoDateTimeConverter() DateTime? returnAt,@FlexibleDoubleConverter() double? estimatedTotal,@IsoDateTimeConverter() DateTime? readyForPickupAt,@IsoDateTimeConverter() DateTime? customerInfoCompletedAt,@IsoDateTimeConverter() DateTime? customerInfoReviewedAt,@IsoDateTimeConverter() DateTime? estimatedServiceCompletionAt, String repairOrderNumber, String claimNumber, String serviceAdvisorName, String loanerBillingMode, String loanerBillingStatus,@IsoDateTimeConverter() DateTime? loanerBorrowerPacketCompletedAt, bool loanerReturnExceptionFlag, CustomerCard? customer, VehicleCard? vehicle, VehicleTypeCard? vehicleType
});


@override $CustomerCardCopyWith<$Res>? get customer;@override $VehicleCardCopyWith<$Res>? get vehicle;@override $VehicleTypeCardCopyWith<$Res>? get vehicleType;

}
/// @nodoc
class __$ReservationCardCopyWithImpl<$Res>
    implements _$ReservationCardCopyWith<$Res> {
  __$ReservationCardCopyWithImpl(this._self, this._then);

  final _ReservationCard _self;
  final $Res Function(_ReservationCard) _then;

/// Create a copy of ReservationCard
/// with the given fields replaced by the non-null parameter values.
@override @pragma('vm:prefer-inline') $Res call({Object? id = null,Object? reservationNumber = freezed,Object? status = null,Object? workflowMode = null,Object? paymentStatus = freezed,Object? pickupAt = freezed,Object? returnAt = freezed,Object? estimatedTotal = freezed,Object? readyForPickupAt = freezed,Object? customerInfoCompletedAt = freezed,Object? customerInfoReviewedAt = freezed,Object? estimatedServiceCompletionAt = freezed,Object? repairOrderNumber = null,Object? claimNumber = null,Object? serviceAdvisorName = null,Object? loanerBillingMode = null,Object? loanerBillingStatus = null,Object? loanerBorrowerPacketCompletedAt = freezed,Object? loanerReturnExceptionFlag = null,Object? customer = freezed,Object? vehicle = freezed,Object? vehicleType = freezed,}) {
  return _then(_ReservationCard(
id: null == id ? _self.id : id // ignore: cast_nullable_to_non_nullable
as String,reservationNumber: freezed == reservationNumber ? _self.reservationNumber : reservationNumber // ignore: cast_nullable_to_non_nullable
as String?,status: null == status ? _self.status : status // ignore: cast_nullable_to_non_nullable
as String,workflowMode: null == workflowMode ? _self.workflowMode : workflowMode // ignore: cast_nullable_to_non_nullable
as String,paymentStatus: freezed == paymentStatus ? _self.paymentStatus : paymentStatus // ignore: cast_nullable_to_non_nullable
as String?,pickupAt: freezed == pickupAt ? _self.pickupAt : pickupAt // ignore: cast_nullable_to_non_nullable
as DateTime?,returnAt: freezed == returnAt ? _self.returnAt : returnAt // ignore: cast_nullable_to_non_nullable
as DateTime?,estimatedTotal: freezed == estimatedTotal ? _self.estimatedTotal : estimatedTotal // ignore: cast_nullable_to_non_nullable
as double?,readyForPickupAt: freezed == readyForPickupAt ? _self.readyForPickupAt : readyForPickupAt // ignore: cast_nullable_to_non_nullable
as DateTime?,customerInfoCompletedAt: freezed == customerInfoCompletedAt ? _self.customerInfoCompletedAt : customerInfoCompletedAt // ignore: cast_nullable_to_non_nullable
as DateTime?,customerInfoReviewedAt: freezed == customerInfoReviewedAt ? _self.customerInfoReviewedAt : customerInfoReviewedAt // ignore: cast_nullable_to_non_nullable
as DateTime?,estimatedServiceCompletionAt: freezed == estimatedServiceCompletionAt ? _self.estimatedServiceCompletionAt : estimatedServiceCompletionAt // ignore: cast_nullable_to_non_nullable
as DateTime?,repairOrderNumber: null == repairOrderNumber ? _self.repairOrderNumber : repairOrderNumber // ignore: cast_nullable_to_non_nullable
as String,claimNumber: null == claimNumber ? _self.claimNumber : claimNumber // ignore: cast_nullable_to_non_nullable
as String,serviceAdvisorName: null == serviceAdvisorName ? _self.serviceAdvisorName : serviceAdvisorName // ignore: cast_nullable_to_non_nullable
as String,loanerBillingMode: null == loanerBillingMode ? _self.loanerBillingMode : loanerBillingMode // ignore: cast_nullable_to_non_nullable
as String,loanerBillingStatus: null == loanerBillingStatus ? _self.loanerBillingStatus : loanerBillingStatus // ignore: cast_nullable_to_non_nullable
as String,loanerBorrowerPacketCompletedAt: freezed == loanerBorrowerPacketCompletedAt ? _self.loanerBorrowerPacketCompletedAt : loanerBorrowerPacketCompletedAt // ignore: cast_nullable_to_non_nullable
as DateTime?,loanerReturnExceptionFlag: null == loanerReturnExceptionFlag ? _self.loanerReturnExceptionFlag : loanerReturnExceptionFlag // ignore: cast_nullable_to_non_nullable
as bool,customer: freezed == customer ? _self.customer : customer // ignore: cast_nullable_to_non_nullable
as CustomerCard?,vehicle: freezed == vehicle ? _self.vehicle : vehicle // ignore: cast_nullable_to_non_nullable
as VehicleCard?,vehicleType: freezed == vehicleType ? _self.vehicleType : vehicleType // ignore: cast_nullable_to_non_nullable
as VehicleTypeCard?,
  ));
}

/// Create a copy of ReservationCard
/// with the given fields replaced by the non-null parameter values.
@override
@pragma('vm:prefer-inline')
$CustomerCardCopyWith<$Res>? get customer {
    if (_self.customer == null) {
    return null;
  }

  return $CustomerCardCopyWith<$Res>(_self.customer!, (value) {
    return _then(_self.copyWith(customer: value));
  });
}/// Create a copy of ReservationCard
/// with the given fields replaced by the non-null parameter values.
@override
@pragma('vm:prefer-inline')
$VehicleCardCopyWith<$Res>? get vehicle {
    if (_self.vehicle == null) {
    return null;
  }

  return $VehicleCardCopyWith<$Res>(_self.vehicle!, (value) {
    return _then(_self.copyWith(vehicle: value));
  });
}/// Create a copy of ReservationCard
/// with the given fields replaced by the non-null parameter values.
@override
@pragma('vm:prefer-inline')
$VehicleTypeCardCopyWith<$Res>? get vehicleType {
    if (_self.vehicleType == null) {
    return null;
  }

  return $VehicleTypeCardCopyWith<$Res>(_self.vehicleType!, (value) {
    return _then(_self.copyWith(vehicleType: value));
  });
}
}


/// @nodoc
mixin _$CustomerCard {

 String get id; String? get firstName; String? get lastName; String? get email; String? get phone;
/// Create a copy of CustomerCard
/// with the given fields replaced by the non-null parameter values.
@JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
$CustomerCardCopyWith<CustomerCard> get copyWith => _$CustomerCardCopyWithImpl<CustomerCard>(this as CustomerCard, _$identity);

  /// Serializes this CustomerCard to a JSON map.
  Map<String, dynamic> toJson();


@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is CustomerCard&&(identical(other.id, id) || other.id == id)&&(identical(other.firstName, firstName) || other.firstName == firstName)&&(identical(other.lastName, lastName) || other.lastName == lastName)&&(identical(other.email, email) || other.email == email)&&(identical(other.phone, phone) || other.phone == phone));
}

@JsonKey(includeFromJson: false, includeToJson: false)
@override
int get hashCode => Object.hash(runtimeType,id,firstName,lastName,email,phone);

@override
String toString() {
  return 'CustomerCard(id: $id, firstName: $firstName, lastName: $lastName, email: $email, phone: $phone)';
}


}

/// @nodoc
abstract mixin class $CustomerCardCopyWith<$Res>  {
  factory $CustomerCardCopyWith(CustomerCard value, $Res Function(CustomerCard) _then) = _$CustomerCardCopyWithImpl;
@useResult
$Res call({
 String id, String? firstName, String? lastName, String? email, String? phone
});




}
/// @nodoc
class _$CustomerCardCopyWithImpl<$Res>
    implements $CustomerCardCopyWith<$Res> {
  _$CustomerCardCopyWithImpl(this._self, this._then);

  final CustomerCard _self;
  final $Res Function(CustomerCard) _then;

/// Create a copy of CustomerCard
/// with the given fields replaced by the non-null parameter values.
@pragma('vm:prefer-inline') @override $Res call({Object? id = null,Object? firstName = freezed,Object? lastName = freezed,Object? email = freezed,Object? phone = freezed,}) {
  return _then(_self.copyWith(
id: null == id ? _self.id : id // ignore: cast_nullable_to_non_nullable
as String,firstName: freezed == firstName ? _self.firstName : firstName // ignore: cast_nullable_to_non_nullable
as String?,lastName: freezed == lastName ? _self.lastName : lastName // ignore: cast_nullable_to_non_nullable
as String?,email: freezed == email ? _self.email : email // ignore: cast_nullable_to_non_nullable
as String?,phone: freezed == phone ? _self.phone : phone // ignore: cast_nullable_to_non_nullable
as String?,
  ));
}

}


/// Adds pattern-matching-related methods to [CustomerCard].
extension CustomerCardPatterns on CustomerCard {
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

@optionalTypeArgs TResult maybeMap<TResult extends Object?>(TResult Function( _CustomerCard value)?  $default,{required TResult orElse(),}){
final _that = this;
switch (_that) {
case _CustomerCard() when $default != null:
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

@optionalTypeArgs TResult map<TResult extends Object?>(TResult Function( _CustomerCard value)  $default,){
final _that = this;
switch (_that) {
case _CustomerCard():
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

@optionalTypeArgs TResult? mapOrNull<TResult extends Object?>(TResult? Function( _CustomerCard value)?  $default,){
final _that = this;
switch (_that) {
case _CustomerCard() when $default != null:
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

@optionalTypeArgs TResult maybeWhen<TResult extends Object?>(TResult Function( String id,  String? firstName,  String? lastName,  String? email,  String? phone)?  $default,{required TResult orElse(),}) {final _that = this;
switch (_that) {
case _CustomerCard() when $default != null:
return $default(_that.id,_that.firstName,_that.lastName,_that.email,_that.phone);case _:
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

@optionalTypeArgs TResult when<TResult extends Object?>(TResult Function( String id,  String? firstName,  String? lastName,  String? email,  String? phone)  $default,) {final _that = this;
switch (_that) {
case _CustomerCard():
return $default(_that.id,_that.firstName,_that.lastName,_that.email,_that.phone);case _:
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

@optionalTypeArgs TResult? whenOrNull<TResult extends Object?>(TResult? Function( String id,  String? firstName,  String? lastName,  String? email,  String? phone)?  $default,) {final _that = this;
switch (_that) {
case _CustomerCard() when $default != null:
return $default(_that.id,_that.firstName,_that.lastName,_that.email,_that.phone);case _:
  return null;

}
}

}

/// @nodoc
@JsonSerializable()

class _CustomerCard implements CustomerCard {
  const _CustomerCard({required this.id, this.firstName, this.lastName, this.email, this.phone});
  factory _CustomerCard.fromJson(Map<String, dynamic> json) => _$CustomerCardFromJson(json);

@override final  String id;
@override final  String? firstName;
@override final  String? lastName;
@override final  String? email;
@override final  String? phone;

/// Create a copy of CustomerCard
/// with the given fields replaced by the non-null parameter values.
@override @JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
_$CustomerCardCopyWith<_CustomerCard> get copyWith => __$CustomerCardCopyWithImpl<_CustomerCard>(this, _$identity);

@override
Map<String, dynamic> toJson() {
  return _$CustomerCardToJson(this, );
}

@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is _CustomerCard&&(identical(other.id, id) || other.id == id)&&(identical(other.firstName, firstName) || other.firstName == firstName)&&(identical(other.lastName, lastName) || other.lastName == lastName)&&(identical(other.email, email) || other.email == email)&&(identical(other.phone, phone) || other.phone == phone));
}

@JsonKey(includeFromJson: false, includeToJson: false)
@override
int get hashCode => Object.hash(runtimeType,id,firstName,lastName,email,phone);

@override
String toString() {
  return 'CustomerCard(id: $id, firstName: $firstName, lastName: $lastName, email: $email, phone: $phone)';
}


}

/// @nodoc
abstract mixin class _$CustomerCardCopyWith<$Res> implements $CustomerCardCopyWith<$Res> {
  factory _$CustomerCardCopyWith(_CustomerCard value, $Res Function(_CustomerCard) _then) = __$CustomerCardCopyWithImpl;
@override @useResult
$Res call({
 String id, String? firstName, String? lastName, String? email, String? phone
});




}
/// @nodoc
class __$CustomerCardCopyWithImpl<$Res>
    implements _$CustomerCardCopyWith<$Res> {
  __$CustomerCardCopyWithImpl(this._self, this._then);

  final _CustomerCard _self;
  final $Res Function(_CustomerCard) _then;

/// Create a copy of CustomerCard
/// with the given fields replaced by the non-null parameter values.
@override @pragma('vm:prefer-inline') $Res call({Object? id = null,Object? firstName = freezed,Object? lastName = freezed,Object? email = freezed,Object? phone = freezed,}) {
  return _then(_CustomerCard(
id: null == id ? _self.id : id // ignore: cast_nullable_to_non_nullable
as String,firstName: freezed == firstName ? _self.firstName : firstName // ignore: cast_nullable_to_non_nullable
as String?,lastName: freezed == lastName ? _self.lastName : lastName // ignore: cast_nullable_to_non_nullable
as String?,email: freezed == email ? _self.email : email // ignore: cast_nullable_to_non_nullable
as String?,phone: freezed == phone ? _self.phone : phone // ignore: cast_nullable_to_non_nullable
as String?,
  ));
}


}


/// @nodoc
mixin _$VehicleCard {

 String get id; String? get make; String? get model; int? get year; String? get internalNumber;/// El servidor ya hace fallback `plate || licensePlate || ''`.
 String get plate;
/// Create a copy of VehicleCard
/// with the given fields replaced by the non-null parameter values.
@JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
$VehicleCardCopyWith<VehicleCard> get copyWith => _$VehicleCardCopyWithImpl<VehicleCard>(this as VehicleCard, _$identity);

  /// Serializes this VehicleCard to a JSON map.
  Map<String, dynamic> toJson();


@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is VehicleCard&&(identical(other.id, id) || other.id == id)&&(identical(other.make, make) || other.make == make)&&(identical(other.model, model) || other.model == model)&&(identical(other.year, year) || other.year == year)&&(identical(other.internalNumber, internalNumber) || other.internalNumber == internalNumber)&&(identical(other.plate, plate) || other.plate == plate));
}

@JsonKey(includeFromJson: false, includeToJson: false)
@override
int get hashCode => Object.hash(runtimeType,id,make,model,year,internalNumber,plate);

@override
String toString() {
  return 'VehicleCard(id: $id, make: $make, model: $model, year: $year, internalNumber: $internalNumber, plate: $plate)';
}


}

/// @nodoc
abstract mixin class $VehicleCardCopyWith<$Res>  {
  factory $VehicleCardCopyWith(VehicleCard value, $Res Function(VehicleCard) _then) = _$VehicleCardCopyWithImpl;
@useResult
$Res call({
 String id, String? make, String? model, int? year, String? internalNumber, String plate
});




}
/// @nodoc
class _$VehicleCardCopyWithImpl<$Res>
    implements $VehicleCardCopyWith<$Res> {
  _$VehicleCardCopyWithImpl(this._self, this._then);

  final VehicleCard _self;
  final $Res Function(VehicleCard) _then;

/// Create a copy of VehicleCard
/// with the given fields replaced by the non-null parameter values.
@pragma('vm:prefer-inline') @override $Res call({Object? id = null,Object? make = freezed,Object? model = freezed,Object? year = freezed,Object? internalNumber = freezed,Object? plate = null,}) {
  return _then(_self.copyWith(
id: null == id ? _self.id : id // ignore: cast_nullable_to_non_nullable
as String,make: freezed == make ? _self.make : make // ignore: cast_nullable_to_non_nullable
as String?,model: freezed == model ? _self.model : model // ignore: cast_nullable_to_non_nullable
as String?,year: freezed == year ? _self.year : year // ignore: cast_nullable_to_non_nullable
as int?,internalNumber: freezed == internalNumber ? _self.internalNumber : internalNumber // ignore: cast_nullable_to_non_nullable
as String?,plate: null == plate ? _self.plate : plate // ignore: cast_nullable_to_non_nullable
as String,
  ));
}

}


/// Adds pattern-matching-related methods to [VehicleCard].
extension VehicleCardPatterns on VehicleCard {
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

@optionalTypeArgs TResult maybeMap<TResult extends Object?>(TResult Function( _VehicleCard value)?  $default,{required TResult orElse(),}){
final _that = this;
switch (_that) {
case _VehicleCard() when $default != null:
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

@optionalTypeArgs TResult map<TResult extends Object?>(TResult Function( _VehicleCard value)  $default,){
final _that = this;
switch (_that) {
case _VehicleCard():
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

@optionalTypeArgs TResult? mapOrNull<TResult extends Object?>(TResult? Function( _VehicleCard value)?  $default,){
final _that = this;
switch (_that) {
case _VehicleCard() when $default != null:
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

@optionalTypeArgs TResult maybeWhen<TResult extends Object?>(TResult Function( String id,  String? make,  String? model,  int? year,  String? internalNumber,  String plate)?  $default,{required TResult orElse(),}) {final _that = this;
switch (_that) {
case _VehicleCard() when $default != null:
return $default(_that.id,_that.make,_that.model,_that.year,_that.internalNumber,_that.plate);case _:
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

@optionalTypeArgs TResult when<TResult extends Object?>(TResult Function( String id,  String? make,  String? model,  int? year,  String? internalNumber,  String plate)  $default,) {final _that = this;
switch (_that) {
case _VehicleCard():
return $default(_that.id,_that.make,_that.model,_that.year,_that.internalNumber,_that.plate);case _:
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

@optionalTypeArgs TResult? whenOrNull<TResult extends Object?>(TResult? Function( String id,  String? make,  String? model,  int? year,  String? internalNumber,  String plate)?  $default,) {final _that = this;
switch (_that) {
case _VehicleCard() when $default != null:
return $default(_that.id,_that.make,_that.model,_that.year,_that.internalNumber,_that.plate);case _:
  return null;

}
}

}

/// @nodoc
@JsonSerializable()

class _VehicleCard implements VehicleCard {
  const _VehicleCard({required this.id, this.make, this.model, this.year, this.internalNumber, this.plate = ''});
  factory _VehicleCard.fromJson(Map<String, dynamic> json) => _$VehicleCardFromJson(json);

@override final  String id;
@override final  String? make;
@override final  String? model;
@override final  int? year;
@override final  String? internalNumber;
/// El servidor ya hace fallback `plate || licensePlate || ''`.
@override@JsonKey() final  String plate;

/// Create a copy of VehicleCard
/// with the given fields replaced by the non-null parameter values.
@override @JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
_$VehicleCardCopyWith<_VehicleCard> get copyWith => __$VehicleCardCopyWithImpl<_VehicleCard>(this, _$identity);

@override
Map<String, dynamic> toJson() {
  return _$VehicleCardToJson(this, );
}

@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is _VehicleCard&&(identical(other.id, id) || other.id == id)&&(identical(other.make, make) || other.make == make)&&(identical(other.model, model) || other.model == model)&&(identical(other.year, year) || other.year == year)&&(identical(other.internalNumber, internalNumber) || other.internalNumber == internalNumber)&&(identical(other.plate, plate) || other.plate == plate));
}

@JsonKey(includeFromJson: false, includeToJson: false)
@override
int get hashCode => Object.hash(runtimeType,id,make,model,year,internalNumber,plate);

@override
String toString() {
  return 'VehicleCard(id: $id, make: $make, model: $model, year: $year, internalNumber: $internalNumber, plate: $plate)';
}


}

/// @nodoc
abstract mixin class _$VehicleCardCopyWith<$Res> implements $VehicleCardCopyWith<$Res> {
  factory _$VehicleCardCopyWith(_VehicleCard value, $Res Function(_VehicleCard) _then) = __$VehicleCardCopyWithImpl;
@override @useResult
$Res call({
 String id, String? make, String? model, int? year, String? internalNumber, String plate
});




}
/// @nodoc
class __$VehicleCardCopyWithImpl<$Res>
    implements _$VehicleCardCopyWith<$Res> {
  __$VehicleCardCopyWithImpl(this._self, this._then);

  final _VehicleCard _self;
  final $Res Function(_VehicleCard) _then;

/// Create a copy of VehicleCard
/// with the given fields replaced by the non-null parameter values.
@override @pragma('vm:prefer-inline') $Res call({Object? id = null,Object? make = freezed,Object? model = freezed,Object? year = freezed,Object? internalNumber = freezed,Object? plate = null,}) {
  return _then(_VehicleCard(
id: null == id ? _self.id : id // ignore: cast_nullable_to_non_nullable
as String,make: freezed == make ? _self.make : make // ignore: cast_nullable_to_non_nullable
as String?,model: freezed == model ? _self.model : model // ignore: cast_nullable_to_non_nullable
as String?,year: freezed == year ? _self.year : year // ignore: cast_nullable_to_non_nullable
as int?,internalNumber: freezed == internalNumber ? _self.internalNumber : internalNumber // ignore: cast_nullable_to_non_nullable
as String?,plate: null == plate ? _self.plate : plate // ignore: cast_nullable_to_non_nullable
as String,
  ));
}


}


/// @nodoc
mixin _$VehicleTypeCard {

 String get id; String? get name;
/// Create a copy of VehicleTypeCard
/// with the given fields replaced by the non-null parameter values.
@JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
$VehicleTypeCardCopyWith<VehicleTypeCard> get copyWith => _$VehicleTypeCardCopyWithImpl<VehicleTypeCard>(this as VehicleTypeCard, _$identity);

  /// Serializes this VehicleTypeCard to a JSON map.
  Map<String, dynamic> toJson();


@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is VehicleTypeCard&&(identical(other.id, id) || other.id == id)&&(identical(other.name, name) || other.name == name));
}

@JsonKey(includeFromJson: false, includeToJson: false)
@override
int get hashCode => Object.hash(runtimeType,id,name);

@override
String toString() {
  return 'VehicleTypeCard(id: $id, name: $name)';
}


}

/// @nodoc
abstract mixin class $VehicleTypeCardCopyWith<$Res>  {
  factory $VehicleTypeCardCopyWith(VehicleTypeCard value, $Res Function(VehicleTypeCard) _then) = _$VehicleTypeCardCopyWithImpl;
@useResult
$Res call({
 String id, String? name
});




}
/// @nodoc
class _$VehicleTypeCardCopyWithImpl<$Res>
    implements $VehicleTypeCardCopyWith<$Res> {
  _$VehicleTypeCardCopyWithImpl(this._self, this._then);

  final VehicleTypeCard _self;
  final $Res Function(VehicleTypeCard) _then;

/// Create a copy of VehicleTypeCard
/// with the given fields replaced by the non-null parameter values.
@pragma('vm:prefer-inline') @override $Res call({Object? id = null,Object? name = freezed,}) {
  return _then(_self.copyWith(
id: null == id ? _self.id : id // ignore: cast_nullable_to_non_nullable
as String,name: freezed == name ? _self.name : name // ignore: cast_nullable_to_non_nullable
as String?,
  ));
}

}


/// Adds pattern-matching-related methods to [VehicleTypeCard].
extension VehicleTypeCardPatterns on VehicleTypeCard {
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

@optionalTypeArgs TResult maybeMap<TResult extends Object?>(TResult Function( _VehicleTypeCard value)?  $default,{required TResult orElse(),}){
final _that = this;
switch (_that) {
case _VehicleTypeCard() when $default != null:
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

@optionalTypeArgs TResult map<TResult extends Object?>(TResult Function( _VehicleTypeCard value)  $default,){
final _that = this;
switch (_that) {
case _VehicleTypeCard():
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

@optionalTypeArgs TResult? mapOrNull<TResult extends Object?>(TResult? Function( _VehicleTypeCard value)?  $default,){
final _that = this;
switch (_that) {
case _VehicleTypeCard() when $default != null:
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

@optionalTypeArgs TResult maybeWhen<TResult extends Object?>(TResult Function( String id,  String? name)?  $default,{required TResult orElse(),}) {final _that = this;
switch (_that) {
case _VehicleTypeCard() when $default != null:
return $default(_that.id,_that.name);case _:
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

@optionalTypeArgs TResult when<TResult extends Object?>(TResult Function( String id,  String? name)  $default,) {final _that = this;
switch (_that) {
case _VehicleTypeCard():
return $default(_that.id,_that.name);case _:
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

@optionalTypeArgs TResult? whenOrNull<TResult extends Object?>(TResult? Function( String id,  String? name)?  $default,) {final _that = this;
switch (_that) {
case _VehicleTypeCard() when $default != null:
return $default(_that.id,_that.name);case _:
  return null;

}
}

}

/// @nodoc
@JsonSerializable()

class _VehicleTypeCard implements VehicleTypeCard {
  const _VehicleTypeCard({required this.id, this.name});
  factory _VehicleTypeCard.fromJson(Map<String, dynamic> json) => _$VehicleTypeCardFromJson(json);

@override final  String id;
@override final  String? name;

/// Create a copy of VehicleTypeCard
/// with the given fields replaced by the non-null parameter values.
@override @JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
_$VehicleTypeCardCopyWith<_VehicleTypeCard> get copyWith => __$VehicleTypeCardCopyWithImpl<_VehicleTypeCard>(this, _$identity);

@override
Map<String, dynamic> toJson() {
  return _$VehicleTypeCardToJson(this, );
}

@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is _VehicleTypeCard&&(identical(other.id, id) || other.id == id)&&(identical(other.name, name) || other.name == name));
}

@JsonKey(includeFromJson: false, includeToJson: false)
@override
int get hashCode => Object.hash(runtimeType,id,name);

@override
String toString() {
  return 'VehicleTypeCard(id: $id, name: $name)';
}


}

/// @nodoc
abstract mixin class _$VehicleTypeCardCopyWith<$Res> implements $VehicleTypeCardCopyWith<$Res> {
  factory _$VehicleTypeCardCopyWith(_VehicleTypeCard value, $Res Function(_VehicleTypeCard) _then) = __$VehicleTypeCardCopyWithImpl;
@override @useResult
$Res call({
 String id, String? name
});




}
/// @nodoc
class __$VehicleTypeCardCopyWithImpl<$Res>
    implements _$VehicleTypeCardCopyWith<$Res> {
  __$VehicleTypeCardCopyWithImpl(this._self, this._then);

  final _VehicleTypeCard _self;
  final $Res Function(_VehicleTypeCard) _then;

/// Create a copy of VehicleTypeCard
/// with the given fields replaced by the non-null parameter values.
@override @pragma('vm:prefer-inline') $Res call({Object? id = null,Object? name = freezed,}) {
  return _then(_VehicleTypeCard(
id: null == id ? _self.id : id // ignore: cast_nullable_to_non_nullable
as String,name: freezed == name ? _self.name : name // ignore: cast_nullable_to_non_nullable
as String?,
  ));
}


}

// dart format on
