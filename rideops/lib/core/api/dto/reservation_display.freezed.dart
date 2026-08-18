// GENERATED CODE - DO NOT MODIFY BY HAND
// coverage:ignore-file
// ignore_for_file: type=lint
// ignore_for_file: unused_element, deprecated_member_use, deprecated_member_use_from_same_package, use_function_type_syntax_for_parameters, unnecessary_const, avoid_init_to_null, invalid_override_different_default_values_named, prefer_expression_function_bodies, annotate_overrides, invalid_annotation_target, unnecessary_question_mark

part of 'reservation_display.dart';

// **************************************************************************
// FreezedGenerator
// **************************************************************************

// dart format off
T _$identity<T>(T value) => value;

/// @nodoc
mixin _$ReservationDisplayData {

 DisplayReservation get reservation; TenantBranding get branding;
/// Create a copy of ReservationDisplayData
/// with the given fields replaced by the non-null parameter values.
@JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
$ReservationDisplayDataCopyWith<ReservationDisplayData> get copyWith => _$ReservationDisplayDataCopyWithImpl<ReservationDisplayData>(this as ReservationDisplayData, _$identity);

  /// Serializes this ReservationDisplayData to a JSON map.
  Map<String, dynamic> toJson();


@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is ReservationDisplayData&&(identical(other.reservation, reservation) || other.reservation == reservation)&&(identical(other.branding, branding) || other.branding == branding));
}

@JsonKey(includeFromJson: false, includeToJson: false)
@override
int get hashCode => Object.hash(runtimeType,reservation,branding);

@override
String toString() {
  return 'ReservationDisplayData(reservation: $reservation, branding: $branding)';
}


}

/// @nodoc
abstract mixin class $ReservationDisplayDataCopyWith<$Res>  {
  factory $ReservationDisplayDataCopyWith(ReservationDisplayData value, $Res Function(ReservationDisplayData) _then) = _$ReservationDisplayDataCopyWithImpl;
@useResult
$Res call({
 DisplayReservation reservation, TenantBranding branding
});


$DisplayReservationCopyWith<$Res> get reservation;$TenantBrandingCopyWith<$Res> get branding;

}
/// @nodoc
class _$ReservationDisplayDataCopyWithImpl<$Res>
    implements $ReservationDisplayDataCopyWith<$Res> {
  _$ReservationDisplayDataCopyWithImpl(this._self, this._then);

  final ReservationDisplayData _self;
  final $Res Function(ReservationDisplayData) _then;

/// Create a copy of ReservationDisplayData
/// with the given fields replaced by the non-null parameter values.
@pragma('vm:prefer-inline') @override $Res call({Object? reservation = null,Object? branding = null,}) {
  return _then(_self.copyWith(
reservation: null == reservation ? _self.reservation : reservation // ignore: cast_nullable_to_non_nullable
as DisplayReservation,branding: null == branding ? _self.branding : branding // ignore: cast_nullable_to_non_nullable
as TenantBranding,
  ));
}
/// Create a copy of ReservationDisplayData
/// with the given fields replaced by the non-null parameter values.
@override
@pragma('vm:prefer-inline')
$DisplayReservationCopyWith<$Res> get reservation {
  
  return $DisplayReservationCopyWith<$Res>(_self.reservation, (value) {
    return _then(_self.copyWith(reservation: value));
  });
}/// Create a copy of ReservationDisplayData
/// with the given fields replaced by the non-null parameter values.
@override
@pragma('vm:prefer-inline')
$TenantBrandingCopyWith<$Res> get branding {
  
  return $TenantBrandingCopyWith<$Res>(_self.branding, (value) {
    return _then(_self.copyWith(branding: value));
  });
}
}


/// Adds pattern-matching-related methods to [ReservationDisplayData].
extension ReservationDisplayDataPatterns on ReservationDisplayData {
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

@optionalTypeArgs TResult maybeMap<TResult extends Object?>(TResult Function( _ReservationDisplayData value)?  $default,{required TResult orElse(),}){
final _that = this;
switch (_that) {
case _ReservationDisplayData() when $default != null:
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

@optionalTypeArgs TResult map<TResult extends Object?>(TResult Function( _ReservationDisplayData value)  $default,){
final _that = this;
switch (_that) {
case _ReservationDisplayData():
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

@optionalTypeArgs TResult? mapOrNull<TResult extends Object?>(TResult? Function( _ReservationDisplayData value)?  $default,){
final _that = this;
switch (_that) {
case _ReservationDisplayData() when $default != null:
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

@optionalTypeArgs TResult maybeWhen<TResult extends Object?>(TResult Function( DisplayReservation reservation,  TenantBranding branding)?  $default,{required TResult orElse(),}) {final _that = this;
switch (_that) {
case _ReservationDisplayData() when $default != null:
return $default(_that.reservation,_that.branding);case _:
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

@optionalTypeArgs TResult when<TResult extends Object?>(TResult Function( DisplayReservation reservation,  TenantBranding branding)  $default,) {final _that = this;
switch (_that) {
case _ReservationDisplayData():
return $default(_that.reservation,_that.branding);case _:
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

@optionalTypeArgs TResult? whenOrNull<TResult extends Object?>(TResult? Function( DisplayReservation reservation,  TenantBranding branding)?  $default,) {final _that = this;
switch (_that) {
case _ReservationDisplayData() when $default != null:
return $default(_that.reservation,_that.branding);case _:
  return null;

}
}

}

/// @nodoc
@JsonSerializable()

class _ReservationDisplayData implements ReservationDisplayData {
  const _ReservationDisplayData({required this.reservation, required this.branding});
  factory _ReservationDisplayData.fromJson(Map<String, dynamic> json) => _$ReservationDisplayDataFromJson(json);

@override final  DisplayReservation reservation;
@override final  TenantBranding branding;

/// Create a copy of ReservationDisplayData
/// with the given fields replaced by the non-null parameter values.
@override @JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
_$ReservationDisplayDataCopyWith<_ReservationDisplayData> get copyWith => __$ReservationDisplayDataCopyWithImpl<_ReservationDisplayData>(this, _$identity);

@override
Map<String, dynamic> toJson() {
  return _$ReservationDisplayDataToJson(this, );
}

@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is _ReservationDisplayData&&(identical(other.reservation, reservation) || other.reservation == reservation)&&(identical(other.branding, branding) || other.branding == branding));
}

@JsonKey(includeFromJson: false, includeToJson: false)
@override
int get hashCode => Object.hash(runtimeType,reservation,branding);

@override
String toString() {
  return 'ReservationDisplayData(reservation: $reservation, branding: $branding)';
}


}

/// @nodoc
abstract mixin class _$ReservationDisplayDataCopyWith<$Res> implements $ReservationDisplayDataCopyWith<$Res> {
  factory _$ReservationDisplayDataCopyWith(_ReservationDisplayData value, $Res Function(_ReservationDisplayData) _then) = __$ReservationDisplayDataCopyWithImpl;
@override @useResult
$Res call({
 DisplayReservation reservation, TenantBranding branding
});


@override $DisplayReservationCopyWith<$Res> get reservation;@override $TenantBrandingCopyWith<$Res> get branding;

}
/// @nodoc
class __$ReservationDisplayDataCopyWithImpl<$Res>
    implements _$ReservationDisplayDataCopyWith<$Res> {
  __$ReservationDisplayDataCopyWithImpl(this._self, this._then);

  final _ReservationDisplayData _self;
  final $Res Function(_ReservationDisplayData) _then;

/// Create a copy of ReservationDisplayData
/// with the given fields replaced by the non-null parameter values.
@override @pragma('vm:prefer-inline') $Res call({Object? reservation = null,Object? branding = null,}) {
  return _then(_ReservationDisplayData(
reservation: null == reservation ? _self.reservation : reservation // ignore: cast_nullable_to_non_nullable
as DisplayReservation,branding: null == branding ? _self.branding : branding // ignore: cast_nullable_to_non_nullable
as TenantBranding,
  ));
}

/// Create a copy of ReservationDisplayData
/// with the given fields replaced by the non-null parameter values.
@override
@pragma('vm:prefer-inline')
$DisplayReservationCopyWith<$Res> get reservation {
  
  return $DisplayReservationCopyWith<$Res>(_self.reservation, (value) {
    return _then(_self.copyWith(reservation: value));
  });
}/// Create a copy of ReservationDisplayData
/// with the given fields replaced by the non-null parameter values.
@override
@pragma('vm:prefer-inline')
$TenantBrandingCopyWith<$Res> get branding {
  
  return $TenantBrandingCopyWith<$Res>(_self.branding, (value) {
    return _then(_self.copyWith(branding: value));
  });
}
}


/// @nodoc
mixin _$DisplayReservation {

 String get id; String? get reservationNumber; DisplayVehicle? get vehicle; DisplayCustomer? get customer;
/// Create a copy of DisplayReservation
/// with the given fields replaced by the non-null parameter values.
@JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
$DisplayReservationCopyWith<DisplayReservation> get copyWith => _$DisplayReservationCopyWithImpl<DisplayReservation>(this as DisplayReservation, _$identity);

  /// Serializes this DisplayReservation to a JSON map.
  Map<String, dynamic> toJson();


@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is DisplayReservation&&(identical(other.id, id) || other.id == id)&&(identical(other.reservationNumber, reservationNumber) || other.reservationNumber == reservationNumber)&&(identical(other.vehicle, vehicle) || other.vehicle == vehicle)&&(identical(other.customer, customer) || other.customer == customer));
}

@JsonKey(includeFromJson: false, includeToJson: false)
@override
int get hashCode => Object.hash(runtimeType,id,reservationNumber,vehicle,customer);

@override
String toString() {
  return 'DisplayReservation(id: $id, reservationNumber: $reservationNumber, vehicle: $vehicle, customer: $customer)';
}


}

/// @nodoc
abstract mixin class $DisplayReservationCopyWith<$Res>  {
  factory $DisplayReservationCopyWith(DisplayReservation value, $Res Function(DisplayReservation) _then) = _$DisplayReservationCopyWithImpl;
@useResult
$Res call({
 String id, String? reservationNumber, DisplayVehicle? vehicle, DisplayCustomer? customer
});


$DisplayVehicleCopyWith<$Res>? get vehicle;$DisplayCustomerCopyWith<$Res>? get customer;

}
/// @nodoc
class _$DisplayReservationCopyWithImpl<$Res>
    implements $DisplayReservationCopyWith<$Res> {
  _$DisplayReservationCopyWithImpl(this._self, this._then);

  final DisplayReservation _self;
  final $Res Function(DisplayReservation) _then;

/// Create a copy of DisplayReservation
/// with the given fields replaced by the non-null parameter values.
@pragma('vm:prefer-inline') @override $Res call({Object? id = null,Object? reservationNumber = freezed,Object? vehicle = freezed,Object? customer = freezed,}) {
  return _then(_self.copyWith(
id: null == id ? _self.id : id // ignore: cast_nullable_to_non_nullable
as String,reservationNumber: freezed == reservationNumber ? _self.reservationNumber : reservationNumber // ignore: cast_nullable_to_non_nullable
as String?,vehicle: freezed == vehicle ? _self.vehicle : vehicle // ignore: cast_nullable_to_non_nullable
as DisplayVehicle?,customer: freezed == customer ? _self.customer : customer // ignore: cast_nullable_to_non_nullable
as DisplayCustomer?,
  ));
}
/// Create a copy of DisplayReservation
/// with the given fields replaced by the non-null parameter values.
@override
@pragma('vm:prefer-inline')
$DisplayVehicleCopyWith<$Res>? get vehicle {
    if (_self.vehicle == null) {
    return null;
  }

  return $DisplayVehicleCopyWith<$Res>(_self.vehicle!, (value) {
    return _then(_self.copyWith(vehicle: value));
  });
}/// Create a copy of DisplayReservation
/// with the given fields replaced by the non-null parameter values.
@override
@pragma('vm:prefer-inline')
$DisplayCustomerCopyWith<$Res>? get customer {
    if (_self.customer == null) {
    return null;
  }

  return $DisplayCustomerCopyWith<$Res>(_self.customer!, (value) {
    return _then(_self.copyWith(customer: value));
  });
}
}


/// Adds pattern-matching-related methods to [DisplayReservation].
extension DisplayReservationPatterns on DisplayReservation {
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

@optionalTypeArgs TResult maybeMap<TResult extends Object?>(TResult Function( _DisplayReservation value)?  $default,{required TResult orElse(),}){
final _that = this;
switch (_that) {
case _DisplayReservation() when $default != null:
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

@optionalTypeArgs TResult map<TResult extends Object?>(TResult Function( _DisplayReservation value)  $default,){
final _that = this;
switch (_that) {
case _DisplayReservation():
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

@optionalTypeArgs TResult? mapOrNull<TResult extends Object?>(TResult? Function( _DisplayReservation value)?  $default,){
final _that = this;
switch (_that) {
case _DisplayReservation() when $default != null:
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

@optionalTypeArgs TResult maybeWhen<TResult extends Object?>(TResult Function( String id,  String? reservationNumber,  DisplayVehicle? vehicle,  DisplayCustomer? customer)?  $default,{required TResult orElse(),}) {final _that = this;
switch (_that) {
case _DisplayReservation() when $default != null:
return $default(_that.id,_that.reservationNumber,_that.vehicle,_that.customer);case _:
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

@optionalTypeArgs TResult when<TResult extends Object?>(TResult Function( String id,  String? reservationNumber,  DisplayVehicle? vehicle,  DisplayCustomer? customer)  $default,) {final _that = this;
switch (_that) {
case _DisplayReservation():
return $default(_that.id,_that.reservationNumber,_that.vehicle,_that.customer);case _:
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

@optionalTypeArgs TResult? whenOrNull<TResult extends Object?>(TResult? Function( String id,  String? reservationNumber,  DisplayVehicle? vehicle,  DisplayCustomer? customer)?  $default,) {final _that = this;
switch (_that) {
case _DisplayReservation() when $default != null:
return $default(_that.id,_that.reservationNumber,_that.vehicle,_that.customer);case _:
  return null;

}
}

}

/// @nodoc
@JsonSerializable()

class _DisplayReservation implements DisplayReservation {
  const _DisplayReservation({required this.id, this.reservationNumber, this.vehicle, this.customer});
  factory _DisplayReservation.fromJson(Map<String, dynamic> json) => _$DisplayReservationFromJson(json);

@override final  String id;
@override final  String? reservationNumber;
@override final  DisplayVehicle? vehicle;
@override final  DisplayCustomer? customer;

/// Create a copy of DisplayReservation
/// with the given fields replaced by the non-null parameter values.
@override @JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
_$DisplayReservationCopyWith<_DisplayReservation> get copyWith => __$DisplayReservationCopyWithImpl<_DisplayReservation>(this, _$identity);

@override
Map<String, dynamic> toJson() {
  return _$DisplayReservationToJson(this, );
}

@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is _DisplayReservation&&(identical(other.id, id) || other.id == id)&&(identical(other.reservationNumber, reservationNumber) || other.reservationNumber == reservationNumber)&&(identical(other.vehicle, vehicle) || other.vehicle == vehicle)&&(identical(other.customer, customer) || other.customer == customer));
}

@JsonKey(includeFromJson: false, includeToJson: false)
@override
int get hashCode => Object.hash(runtimeType,id,reservationNumber,vehicle,customer);

@override
String toString() {
  return 'DisplayReservation(id: $id, reservationNumber: $reservationNumber, vehicle: $vehicle, customer: $customer)';
}


}

/// @nodoc
abstract mixin class _$DisplayReservationCopyWith<$Res> implements $DisplayReservationCopyWith<$Res> {
  factory _$DisplayReservationCopyWith(_DisplayReservation value, $Res Function(_DisplayReservation) _then) = __$DisplayReservationCopyWithImpl;
@override @useResult
$Res call({
 String id, String? reservationNumber, DisplayVehicle? vehicle, DisplayCustomer? customer
});


@override $DisplayVehicleCopyWith<$Res>? get vehicle;@override $DisplayCustomerCopyWith<$Res>? get customer;

}
/// @nodoc
class __$DisplayReservationCopyWithImpl<$Res>
    implements _$DisplayReservationCopyWith<$Res> {
  __$DisplayReservationCopyWithImpl(this._self, this._then);

  final _DisplayReservation _self;
  final $Res Function(_DisplayReservation) _then;

/// Create a copy of DisplayReservation
/// with the given fields replaced by the non-null parameter values.
@override @pragma('vm:prefer-inline') $Res call({Object? id = null,Object? reservationNumber = freezed,Object? vehicle = freezed,Object? customer = freezed,}) {
  return _then(_DisplayReservation(
id: null == id ? _self.id : id // ignore: cast_nullable_to_non_nullable
as String,reservationNumber: freezed == reservationNumber ? _self.reservationNumber : reservationNumber // ignore: cast_nullable_to_non_nullable
as String?,vehicle: freezed == vehicle ? _self.vehicle : vehicle // ignore: cast_nullable_to_non_nullable
as DisplayVehicle?,customer: freezed == customer ? _self.customer : customer // ignore: cast_nullable_to_non_nullable
as DisplayCustomer?,
  ));
}

/// Create a copy of DisplayReservation
/// with the given fields replaced by the non-null parameter values.
@override
@pragma('vm:prefer-inline')
$DisplayVehicleCopyWith<$Res>? get vehicle {
    if (_self.vehicle == null) {
    return null;
  }

  return $DisplayVehicleCopyWith<$Res>(_self.vehicle!, (value) {
    return _then(_self.copyWith(vehicle: value));
  });
}/// Create a copy of DisplayReservation
/// with the given fields replaced by the non-null parameter values.
@override
@pragma('vm:prefer-inline')
$DisplayCustomerCopyWith<$Res>? get customer {
    if (_self.customer == null) {
    return null;
  }

  return $DisplayCustomerCopyWith<$Res>(_self.customer!, (value) {
    return _then(_self.copyWith(customer: value));
  });
}
}


/// @nodoc
mixin _$DisplayCustomer {

 String? get firstName; String? get lastName;
/// Create a copy of DisplayCustomer
/// with the given fields replaced by the non-null parameter values.
@JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
$DisplayCustomerCopyWith<DisplayCustomer> get copyWith => _$DisplayCustomerCopyWithImpl<DisplayCustomer>(this as DisplayCustomer, _$identity);

  /// Serializes this DisplayCustomer to a JSON map.
  Map<String, dynamic> toJson();


@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is DisplayCustomer&&(identical(other.firstName, firstName) || other.firstName == firstName)&&(identical(other.lastName, lastName) || other.lastName == lastName));
}

@JsonKey(includeFromJson: false, includeToJson: false)
@override
int get hashCode => Object.hash(runtimeType,firstName,lastName);

@override
String toString() {
  return 'DisplayCustomer(firstName: $firstName, lastName: $lastName)';
}


}

/// @nodoc
abstract mixin class $DisplayCustomerCopyWith<$Res>  {
  factory $DisplayCustomerCopyWith(DisplayCustomer value, $Res Function(DisplayCustomer) _then) = _$DisplayCustomerCopyWithImpl;
@useResult
$Res call({
 String? firstName, String? lastName
});




}
/// @nodoc
class _$DisplayCustomerCopyWithImpl<$Res>
    implements $DisplayCustomerCopyWith<$Res> {
  _$DisplayCustomerCopyWithImpl(this._self, this._then);

  final DisplayCustomer _self;
  final $Res Function(DisplayCustomer) _then;

/// Create a copy of DisplayCustomer
/// with the given fields replaced by the non-null parameter values.
@pragma('vm:prefer-inline') @override $Res call({Object? firstName = freezed,Object? lastName = freezed,}) {
  return _then(_self.copyWith(
firstName: freezed == firstName ? _self.firstName : firstName // ignore: cast_nullable_to_non_nullable
as String?,lastName: freezed == lastName ? _self.lastName : lastName // ignore: cast_nullable_to_non_nullable
as String?,
  ));
}

}


/// Adds pattern-matching-related methods to [DisplayCustomer].
extension DisplayCustomerPatterns on DisplayCustomer {
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

@optionalTypeArgs TResult maybeMap<TResult extends Object?>(TResult Function( _DisplayCustomer value)?  $default,{required TResult orElse(),}){
final _that = this;
switch (_that) {
case _DisplayCustomer() when $default != null:
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

@optionalTypeArgs TResult map<TResult extends Object?>(TResult Function( _DisplayCustomer value)  $default,){
final _that = this;
switch (_that) {
case _DisplayCustomer():
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

@optionalTypeArgs TResult? mapOrNull<TResult extends Object?>(TResult? Function( _DisplayCustomer value)?  $default,){
final _that = this;
switch (_that) {
case _DisplayCustomer() when $default != null:
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

@optionalTypeArgs TResult maybeWhen<TResult extends Object?>(TResult Function( String? firstName,  String? lastName)?  $default,{required TResult orElse(),}) {final _that = this;
switch (_that) {
case _DisplayCustomer() when $default != null:
return $default(_that.firstName,_that.lastName);case _:
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

@optionalTypeArgs TResult when<TResult extends Object?>(TResult Function( String? firstName,  String? lastName)  $default,) {final _that = this;
switch (_that) {
case _DisplayCustomer():
return $default(_that.firstName,_that.lastName);case _:
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

@optionalTypeArgs TResult? whenOrNull<TResult extends Object?>(TResult? Function( String? firstName,  String? lastName)?  $default,) {final _that = this;
switch (_that) {
case _DisplayCustomer() when $default != null:
return $default(_that.firstName,_that.lastName);case _:
  return null;

}
}

}

/// @nodoc
@JsonSerializable()

class _DisplayCustomer extends DisplayCustomer {
  const _DisplayCustomer({this.firstName, this.lastName}): super._();
  factory _DisplayCustomer.fromJson(Map<String, dynamic> json) => _$DisplayCustomerFromJson(json);

@override final  String? firstName;
@override final  String? lastName;

/// Create a copy of DisplayCustomer
/// with the given fields replaced by the non-null parameter values.
@override @JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
_$DisplayCustomerCopyWith<_DisplayCustomer> get copyWith => __$DisplayCustomerCopyWithImpl<_DisplayCustomer>(this, _$identity);

@override
Map<String, dynamic> toJson() {
  return _$DisplayCustomerToJson(this, );
}

@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is _DisplayCustomer&&(identical(other.firstName, firstName) || other.firstName == firstName)&&(identical(other.lastName, lastName) || other.lastName == lastName));
}

@JsonKey(includeFromJson: false, includeToJson: false)
@override
int get hashCode => Object.hash(runtimeType,firstName,lastName);

@override
String toString() {
  return 'DisplayCustomer(firstName: $firstName, lastName: $lastName)';
}


}

/// @nodoc
abstract mixin class _$DisplayCustomerCopyWith<$Res> implements $DisplayCustomerCopyWith<$Res> {
  factory _$DisplayCustomerCopyWith(_DisplayCustomer value, $Res Function(_DisplayCustomer) _then) = __$DisplayCustomerCopyWithImpl;
@override @useResult
$Res call({
 String? firstName, String? lastName
});




}
/// @nodoc
class __$DisplayCustomerCopyWithImpl<$Res>
    implements _$DisplayCustomerCopyWith<$Res> {
  __$DisplayCustomerCopyWithImpl(this._self, this._then);

  final _DisplayCustomer _self;
  final $Res Function(_DisplayCustomer) _then;

/// Create a copy of DisplayCustomer
/// with the given fields replaced by the non-null parameter values.
@override @pragma('vm:prefer-inline') $Res call({Object? firstName = freezed,Object? lastName = freezed,}) {
  return _then(_DisplayCustomer(
firstName: freezed == firstName ? _self.firstName : firstName // ignore: cast_nullable_to_non_nullable
as String?,lastName: freezed == lastName ? _self.lastName : lastName // ignore: cast_nullable_to_non_nullable
as String?,
  ));
}


}


/// @nodoc
mixin _$DisplayVehicle {

 String get id; String? get internalNumber; String? get make; String? get model; int? get year; String? get plate;/// Espejo vivo del historial de millas (Vehicle.mileage, default 0) —
/// la "última lectura registrada" bajo el campo de odómetro.
 int? get mileage;
/// Create a copy of DisplayVehicle
/// with the given fields replaced by the non-null parameter values.
@JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
$DisplayVehicleCopyWith<DisplayVehicle> get copyWith => _$DisplayVehicleCopyWithImpl<DisplayVehicle>(this as DisplayVehicle, _$identity);

  /// Serializes this DisplayVehicle to a JSON map.
  Map<String, dynamic> toJson();


@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is DisplayVehicle&&(identical(other.id, id) || other.id == id)&&(identical(other.internalNumber, internalNumber) || other.internalNumber == internalNumber)&&(identical(other.make, make) || other.make == make)&&(identical(other.model, model) || other.model == model)&&(identical(other.year, year) || other.year == year)&&(identical(other.plate, plate) || other.plate == plate)&&(identical(other.mileage, mileage) || other.mileage == mileage));
}

@JsonKey(includeFromJson: false, includeToJson: false)
@override
int get hashCode => Object.hash(runtimeType,id,internalNumber,make,model,year,plate,mileage);

@override
String toString() {
  return 'DisplayVehicle(id: $id, internalNumber: $internalNumber, make: $make, model: $model, year: $year, plate: $plate, mileage: $mileage)';
}


}

/// @nodoc
abstract mixin class $DisplayVehicleCopyWith<$Res>  {
  factory $DisplayVehicleCopyWith(DisplayVehicle value, $Res Function(DisplayVehicle) _then) = _$DisplayVehicleCopyWithImpl;
@useResult
$Res call({
 String id, String? internalNumber, String? make, String? model, int? year, String? plate, int? mileage
});




}
/// @nodoc
class _$DisplayVehicleCopyWithImpl<$Res>
    implements $DisplayVehicleCopyWith<$Res> {
  _$DisplayVehicleCopyWithImpl(this._self, this._then);

  final DisplayVehicle _self;
  final $Res Function(DisplayVehicle) _then;

/// Create a copy of DisplayVehicle
/// with the given fields replaced by the non-null parameter values.
@pragma('vm:prefer-inline') @override $Res call({Object? id = null,Object? internalNumber = freezed,Object? make = freezed,Object? model = freezed,Object? year = freezed,Object? plate = freezed,Object? mileage = freezed,}) {
  return _then(_self.copyWith(
id: null == id ? _self.id : id // ignore: cast_nullable_to_non_nullable
as String,internalNumber: freezed == internalNumber ? _self.internalNumber : internalNumber // ignore: cast_nullable_to_non_nullable
as String?,make: freezed == make ? _self.make : make // ignore: cast_nullable_to_non_nullable
as String?,model: freezed == model ? _self.model : model // ignore: cast_nullable_to_non_nullable
as String?,year: freezed == year ? _self.year : year // ignore: cast_nullable_to_non_nullable
as int?,plate: freezed == plate ? _self.plate : plate // ignore: cast_nullable_to_non_nullable
as String?,mileage: freezed == mileage ? _self.mileage : mileage // ignore: cast_nullable_to_non_nullable
as int?,
  ));
}

}


/// Adds pattern-matching-related methods to [DisplayVehicle].
extension DisplayVehiclePatterns on DisplayVehicle {
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

@optionalTypeArgs TResult maybeMap<TResult extends Object?>(TResult Function( _DisplayVehicle value)?  $default,{required TResult orElse(),}){
final _that = this;
switch (_that) {
case _DisplayVehicle() when $default != null:
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

@optionalTypeArgs TResult map<TResult extends Object?>(TResult Function( _DisplayVehicle value)  $default,){
final _that = this;
switch (_that) {
case _DisplayVehicle():
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

@optionalTypeArgs TResult? mapOrNull<TResult extends Object?>(TResult? Function( _DisplayVehicle value)?  $default,){
final _that = this;
switch (_that) {
case _DisplayVehicle() when $default != null:
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

@optionalTypeArgs TResult maybeWhen<TResult extends Object?>(TResult Function( String id,  String? internalNumber,  String? make,  String? model,  int? year,  String? plate,  int? mileage)?  $default,{required TResult orElse(),}) {final _that = this;
switch (_that) {
case _DisplayVehicle() when $default != null:
return $default(_that.id,_that.internalNumber,_that.make,_that.model,_that.year,_that.plate,_that.mileage);case _:
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

@optionalTypeArgs TResult when<TResult extends Object?>(TResult Function( String id,  String? internalNumber,  String? make,  String? model,  int? year,  String? plate,  int? mileage)  $default,) {final _that = this;
switch (_that) {
case _DisplayVehicle():
return $default(_that.id,_that.internalNumber,_that.make,_that.model,_that.year,_that.plate,_that.mileage);case _:
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

@optionalTypeArgs TResult? whenOrNull<TResult extends Object?>(TResult? Function( String id,  String? internalNumber,  String? make,  String? model,  int? year,  String? plate,  int? mileage)?  $default,) {final _that = this;
switch (_that) {
case _DisplayVehicle() when $default != null:
return $default(_that.id,_that.internalNumber,_that.make,_that.model,_that.year,_that.plate,_that.mileage);case _:
  return null;

}
}

}

/// @nodoc
@JsonSerializable()

class _DisplayVehicle extends DisplayVehicle {
  const _DisplayVehicle({required this.id, this.internalNumber, this.make, this.model, this.year, this.plate, this.mileage}): super._();
  factory _DisplayVehicle.fromJson(Map<String, dynamic> json) => _$DisplayVehicleFromJson(json);

@override final  String id;
@override final  String? internalNumber;
@override final  String? make;
@override final  String? model;
@override final  int? year;
@override final  String? plate;
/// Espejo vivo del historial de millas (Vehicle.mileage, default 0) —
/// la "última lectura registrada" bajo el campo de odómetro.
@override final  int? mileage;

/// Create a copy of DisplayVehicle
/// with the given fields replaced by the non-null parameter values.
@override @JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
_$DisplayVehicleCopyWith<_DisplayVehicle> get copyWith => __$DisplayVehicleCopyWithImpl<_DisplayVehicle>(this, _$identity);

@override
Map<String, dynamic> toJson() {
  return _$DisplayVehicleToJson(this, );
}

@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is _DisplayVehicle&&(identical(other.id, id) || other.id == id)&&(identical(other.internalNumber, internalNumber) || other.internalNumber == internalNumber)&&(identical(other.make, make) || other.make == make)&&(identical(other.model, model) || other.model == model)&&(identical(other.year, year) || other.year == year)&&(identical(other.plate, plate) || other.plate == plate)&&(identical(other.mileage, mileage) || other.mileage == mileage));
}

@JsonKey(includeFromJson: false, includeToJson: false)
@override
int get hashCode => Object.hash(runtimeType,id,internalNumber,make,model,year,plate,mileage);

@override
String toString() {
  return 'DisplayVehicle(id: $id, internalNumber: $internalNumber, make: $make, model: $model, year: $year, plate: $plate, mileage: $mileage)';
}


}

/// @nodoc
abstract mixin class _$DisplayVehicleCopyWith<$Res> implements $DisplayVehicleCopyWith<$Res> {
  factory _$DisplayVehicleCopyWith(_DisplayVehicle value, $Res Function(_DisplayVehicle) _then) = __$DisplayVehicleCopyWithImpl;
@override @useResult
$Res call({
 String id, String? internalNumber, String? make, String? model, int? year, String? plate, int? mileage
});




}
/// @nodoc
class __$DisplayVehicleCopyWithImpl<$Res>
    implements _$DisplayVehicleCopyWith<$Res> {
  __$DisplayVehicleCopyWithImpl(this._self, this._then);

  final _DisplayVehicle _self;
  final $Res Function(_DisplayVehicle) _then;

/// Create a copy of DisplayVehicle
/// with the given fields replaced by the non-null parameter values.
@override @pragma('vm:prefer-inline') $Res call({Object? id = null,Object? internalNumber = freezed,Object? make = freezed,Object? model = freezed,Object? year = freezed,Object? plate = freezed,Object? mileage = freezed,}) {
  return _then(_DisplayVehicle(
id: null == id ? _self.id : id // ignore: cast_nullable_to_non_nullable
as String,internalNumber: freezed == internalNumber ? _self.internalNumber : internalNumber // ignore: cast_nullable_to_non_nullable
as String?,make: freezed == make ? _self.make : make // ignore: cast_nullable_to_non_nullable
as String?,model: freezed == model ? _self.model : model // ignore: cast_nullable_to_non_nullable
as String?,year: freezed == year ? _self.year : year // ignore: cast_nullable_to_non_nullable
as int?,plate: freezed == plate ? _self.plate : plate // ignore: cast_nullable_to_non_nullable
as String?,mileage: freezed == mileage ? _self.mileage : mileage // ignore: cast_nullable_to_non_nullable
as int?,
  ));
}


}


/// @nodoc
mixin _$TenantBranding {

 String get companyName; String get companyLogoUrl; String get companyPhone;
/// Create a copy of TenantBranding
/// with the given fields replaced by the non-null parameter values.
@JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
$TenantBrandingCopyWith<TenantBranding> get copyWith => _$TenantBrandingCopyWithImpl<TenantBranding>(this as TenantBranding, _$identity);

  /// Serializes this TenantBranding to a JSON map.
  Map<String, dynamic> toJson();


@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is TenantBranding&&(identical(other.companyName, companyName) || other.companyName == companyName)&&(identical(other.companyLogoUrl, companyLogoUrl) || other.companyLogoUrl == companyLogoUrl)&&(identical(other.companyPhone, companyPhone) || other.companyPhone == companyPhone));
}

@JsonKey(includeFromJson: false, includeToJson: false)
@override
int get hashCode => Object.hash(runtimeType,companyName,companyLogoUrl,companyPhone);

@override
String toString() {
  return 'TenantBranding(companyName: $companyName, companyLogoUrl: $companyLogoUrl, companyPhone: $companyPhone)';
}


}

/// @nodoc
abstract mixin class $TenantBrandingCopyWith<$Res>  {
  factory $TenantBrandingCopyWith(TenantBranding value, $Res Function(TenantBranding) _then) = _$TenantBrandingCopyWithImpl;
@useResult
$Res call({
 String companyName, String companyLogoUrl, String companyPhone
});




}
/// @nodoc
class _$TenantBrandingCopyWithImpl<$Res>
    implements $TenantBrandingCopyWith<$Res> {
  _$TenantBrandingCopyWithImpl(this._self, this._then);

  final TenantBranding _self;
  final $Res Function(TenantBranding) _then;

/// Create a copy of TenantBranding
/// with the given fields replaced by the non-null parameter values.
@pragma('vm:prefer-inline') @override $Res call({Object? companyName = null,Object? companyLogoUrl = null,Object? companyPhone = null,}) {
  return _then(_self.copyWith(
companyName: null == companyName ? _self.companyName : companyName // ignore: cast_nullable_to_non_nullable
as String,companyLogoUrl: null == companyLogoUrl ? _self.companyLogoUrl : companyLogoUrl // ignore: cast_nullable_to_non_nullable
as String,companyPhone: null == companyPhone ? _self.companyPhone : companyPhone // ignore: cast_nullable_to_non_nullable
as String,
  ));
}

}


/// Adds pattern-matching-related methods to [TenantBranding].
extension TenantBrandingPatterns on TenantBranding {
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

@optionalTypeArgs TResult maybeMap<TResult extends Object?>(TResult Function( _TenantBranding value)?  $default,{required TResult orElse(),}){
final _that = this;
switch (_that) {
case _TenantBranding() when $default != null:
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

@optionalTypeArgs TResult map<TResult extends Object?>(TResult Function( _TenantBranding value)  $default,){
final _that = this;
switch (_that) {
case _TenantBranding():
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

@optionalTypeArgs TResult? mapOrNull<TResult extends Object?>(TResult? Function( _TenantBranding value)?  $default,){
final _that = this;
switch (_that) {
case _TenantBranding() when $default != null:
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

@optionalTypeArgs TResult maybeWhen<TResult extends Object?>(TResult Function( String companyName,  String companyLogoUrl,  String companyPhone)?  $default,{required TResult orElse(),}) {final _that = this;
switch (_that) {
case _TenantBranding() when $default != null:
return $default(_that.companyName,_that.companyLogoUrl,_that.companyPhone);case _:
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

@optionalTypeArgs TResult when<TResult extends Object?>(TResult Function( String companyName,  String companyLogoUrl,  String companyPhone)  $default,) {final _that = this;
switch (_that) {
case _TenantBranding():
return $default(_that.companyName,_that.companyLogoUrl,_that.companyPhone);case _:
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

@optionalTypeArgs TResult? whenOrNull<TResult extends Object?>(TResult? Function( String companyName,  String companyLogoUrl,  String companyPhone)?  $default,) {final _that = this;
switch (_that) {
case _TenantBranding() when $default != null:
return $default(_that.companyName,_that.companyLogoUrl,_that.companyPhone);case _:
  return null;

}
}

}

/// @nodoc
@JsonSerializable()

class _TenantBranding extends TenantBranding {
  const _TenantBranding({this.companyName = '', this.companyLogoUrl = '', this.companyPhone = ''}): super._();
  factory _TenantBranding.fromJson(Map<String, dynamic> json) => _$TenantBrandingFromJson(json);

@override@JsonKey() final  String companyName;
@override@JsonKey() final  String companyLogoUrl;
@override@JsonKey() final  String companyPhone;

/// Create a copy of TenantBranding
/// with the given fields replaced by the non-null parameter values.
@override @JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
_$TenantBrandingCopyWith<_TenantBranding> get copyWith => __$TenantBrandingCopyWithImpl<_TenantBranding>(this, _$identity);

@override
Map<String, dynamic> toJson() {
  return _$TenantBrandingToJson(this, );
}

@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is _TenantBranding&&(identical(other.companyName, companyName) || other.companyName == companyName)&&(identical(other.companyLogoUrl, companyLogoUrl) || other.companyLogoUrl == companyLogoUrl)&&(identical(other.companyPhone, companyPhone) || other.companyPhone == companyPhone));
}

@JsonKey(includeFromJson: false, includeToJson: false)
@override
int get hashCode => Object.hash(runtimeType,companyName,companyLogoUrl,companyPhone);

@override
String toString() {
  return 'TenantBranding(companyName: $companyName, companyLogoUrl: $companyLogoUrl, companyPhone: $companyPhone)';
}


}

/// @nodoc
abstract mixin class _$TenantBrandingCopyWith<$Res> implements $TenantBrandingCopyWith<$Res> {
  factory _$TenantBrandingCopyWith(_TenantBranding value, $Res Function(_TenantBranding) _then) = __$TenantBrandingCopyWithImpl;
@override @useResult
$Res call({
 String companyName, String companyLogoUrl, String companyPhone
});




}
/// @nodoc
class __$TenantBrandingCopyWithImpl<$Res>
    implements _$TenantBrandingCopyWith<$Res> {
  __$TenantBrandingCopyWithImpl(this._self, this._then);

  final _TenantBranding _self;
  final $Res Function(_TenantBranding) _then;

/// Create a copy of TenantBranding
/// with the given fields replaced by the non-null parameter values.
@override @pragma('vm:prefer-inline') $Res call({Object? companyName = null,Object? companyLogoUrl = null,Object? companyPhone = null,}) {
  return _then(_TenantBranding(
companyName: null == companyName ? _self.companyName : companyName // ignore: cast_nullable_to_non_nullable
as String,companyLogoUrl: null == companyLogoUrl ? _self.companyLogoUrl : companyLogoUrl // ignore: cast_nullable_to_non_nullable
as String,companyPhone: null == companyPhone ? _self.companyPhone : companyPhone // ignore: cast_nullable_to_non_nullable
as String,
  ));
}


}

// dart format on
