// GENERATED CODE - DO NOT MODIFY BY HAND
// coverage:ignore-file
// ignore_for_file: type=lint
// ignore_for_file: unused_element, deprecated_member_use, deprecated_member_use_from_same_package, use_function_type_syntax_for_parameters, unnecessary_const, avoid_init_to_null, invalid_override_different_default_values_named, prefer_expression_function_bodies, annotate_overrides, invalid_annotation_target, unnecessary_question_mark

part of 'available_vehicle.dart';

// **************************************************************************
// FreezedGenerator
// **************************************************************************

// dart format off
T _$identity<T>(T value) => value;

/// @nodoc
mixin _$AvailableVehicle {

 String get id; String? get internalNumber; String? get plate; String? get make; String? get model; int? get year; String? get color;/// Espejo del odómetro (`Vehicle.mileage`).
 int? get mileage;/// AVAILABLE | RENTED | RESERVED | … Se muestra crudo solo cuando NO es
/// AVAILABLE: el candidato pasó el filtro del servidor, pero el agente
/// merece ver que la unidad no está en el patio ahora mismo.
 String? get status; String? get vehicleTypeId; VehicleTypeRef? get vehicleType; String? get homeLocationId; LocationRef? get homeLocation;
/// Create a copy of AvailableVehicle
/// with the given fields replaced by the non-null parameter values.
@JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
$AvailableVehicleCopyWith<AvailableVehicle> get copyWith => _$AvailableVehicleCopyWithImpl<AvailableVehicle>(this as AvailableVehicle, _$identity);

  /// Serializes this AvailableVehicle to a JSON map.
  Map<String, dynamic> toJson();


@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is AvailableVehicle&&(identical(other.id, id) || other.id == id)&&(identical(other.internalNumber, internalNumber) || other.internalNumber == internalNumber)&&(identical(other.plate, plate) || other.plate == plate)&&(identical(other.make, make) || other.make == make)&&(identical(other.model, model) || other.model == model)&&(identical(other.year, year) || other.year == year)&&(identical(other.color, color) || other.color == color)&&(identical(other.mileage, mileage) || other.mileage == mileage)&&(identical(other.status, status) || other.status == status)&&(identical(other.vehicleTypeId, vehicleTypeId) || other.vehicleTypeId == vehicleTypeId)&&(identical(other.vehicleType, vehicleType) || other.vehicleType == vehicleType)&&(identical(other.homeLocationId, homeLocationId) || other.homeLocationId == homeLocationId)&&(identical(other.homeLocation, homeLocation) || other.homeLocation == homeLocation));
}

@JsonKey(includeFromJson: false, includeToJson: false)
@override
int get hashCode => Object.hash(runtimeType,id,internalNumber,plate,make,model,year,color,mileage,status,vehicleTypeId,vehicleType,homeLocationId,homeLocation);

@override
String toString() {
  return 'AvailableVehicle(id: $id, internalNumber: $internalNumber, plate: $plate, make: $make, model: $model, year: $year, color: $color, mileage: $mileage, status: $status, vehicleTypeId: $vehicleTypeId, vehicleType: $vehicleType, homeLocationId: $homeLocationId, homeLocation: $homeLocation)';
}


}

/// @nodoc
abstract mixin class $AvailableVehicleCopyWith<$Res>  {
  factory $AvailableVehicleCopyWith(AvailableVehicle value, $Res Function(AvailableVehicle) _then) = _$AvailableVehicleCopyWithImpl;
@useResult
$Res call({
 String id, String? internalNumber, String? plate, String? make, String? model, int? year, String? color, int? mileage, String? status, String? vehicleTypeId, VehicleTypeRef? vehicleType, String? homeLocationId, LocationRef? homeLocation
});


$VehicleTypeRefCopyWith<$Res>? get vehicleType;$LocationRefCopyWith<$Res>? get homeLocation;

}
/// @nodoc
class _$AvailableVehicleCopyWithImpl<$Res>
    implements $AvailableVehicleCopyWith<$Res> {
  _$AvailableVehicleCopyWithImpl(this._self, this._then);

  final AvailableVehicle _self;
  final $Res Function(AvailableVehicle) _then;

/// Create a copy of AvailableVehicle
/// with the given fields replaced by the non-null parameter values.
@pragma('vm:prefer-inline') @override $Res call({Object? id = null,Object? internalNumber = freezed,Object? plate = freezed,Object? make = freezed,Object? model = freezed,Object? year = freezed,Object? color = freezed,Object? mileage = freezed,Object? status = freezed,Object? vehicleTypeId = freezed,Object? vehicleType = freezed,Object? homeLocationId = freezed,Object? homeLocation = freezed,}) {
  return _then(_self.copyWith(
id: null == id ? _self.id : id // ignore: cast_nullable_to_non_nullable
as String,internalNumber: freezed == internalNumber ? _self.internalNumber : internalNumber // ignore: cast_nullable_to_non_nullable
as String?,plate: freezed == plate ? _self.plate : plate // ignore: cast_nullable_to_non_nullable
as String?,make: freezed == make ? _self.make : make // ignore: cast_nullable_to_non_nullable
as String?,model: freezed == model ? _self.model : model // ignore: cast_nullable_to_non_nullable
as String?,year: freezed == year ? _self.year : year // ignore: cast_nullable_to_non_nullable
as int?,color: freezed == color ? _self.color : color // ignore: cast_nullable_to_non_nullable
as String?,mileage: freezed == mileage ? _self.mileage : mileage // ignore: cast_nullable_to_non_nullable
as int?,status: freezed == status ? _self.status : status // ignore: cast_nullable_to_non_nullable
as String?,vehicleTypeId: freezed == vehicleTypeId ? _self.vehicleTypeId : vehicleTypeId // ignore: cast_nullable_to_non_nullable
as String?,vehicleType: freezed == vehicleType ? _self.vehicleType : vehicleType // ignore: cast_nullable_to_non_nullable
as VehicleTypeRef?,homeLocationId: freezed == homeLocationId ? _self.homeLocationId : homeLocationId // ignore: cast_nullable_to_non_nullable
as String?,homeLocation: freezed == homeLocation ? _self.homeLocation : homeLocation // ignore: cast_nullable_to_non_nullable
as LocationRef?,
  ));
}
/// Create a copy of AvailableVehicle
/// with the given fields replaced by the non-null parameter values.
@override
@pragma('vm:prefer-inline')
$VehicleTypeRefCopyWith<$Res>? get vehicleType {
    if (_self.vehicleType == null) {
    return null;
  }

  return $VehicleTypeRefCopyWith<$Res>(_self.vehicleType!, (value) {
    return _then(_self.copyWith(vehicleType: value));
  });
}/// Create a copy of AvailableVehicle
/// with the given fields replaced by the non-null parameter values.
@override
@pragma('vm:prefer-inline')
$LocationRefCopyWith<$Res>? get homeLocation {
    if (_self.homeLocation == null) {
    return null;
  }

  return $LocationRefCopyWith<$Res>(_self.homeLocation!, (value) {
    return _then(_self.copyWith(homeLocation: value));
  });
}
}


/// Adds pattern-matching-related methods to [AvailableVehicle].
extension AvailableVehiclePatterns on AvailableVehicle {
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

@optionalTypeArgs TResult maybeMap<TResult extends Object?>(TResult Function( _AvailableVehicle value)?  $default,{required TResult orElse(),}){
final _that = this;
switch (_that) {
case _AvailableVehicle() when $default != null:
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

@optionalTypeArgs TResult map<TResult extends Object?>(TResult Function( _AvailableVehicle value)  $default,){
final _that = this;
switch (_that) {
case _AvailableVehicle():
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

@optionalTypeArgs TResult? mapOrNull<TResult extends Object?>(TResult? Function( _AvailableVehicle value)?  $default,){
final _that = this;
switch (_that) {
case _AvailableVehicle() when $default != null:
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

@optionalTypeArgs TResult maybeWhen<TResult extends Object?>(TResult Function( String id,  String? internalNumber,  String? plate,  String? make,  String? model,  int? year,  String? color,  int? mileage,  String? status,  String? vehicleTypeId,  VehicleTypeRef? vehicleType,  String? homeLocationId,  LocationRef? homeLocation)?  $default,{required TResult orElse(),}) {final _that = this;
switch (_that) {
case _AvailableVehicle() when $default != null:
return $default(_that.id,_that.internalNumber,_that.plate,_that.make,_that.model,_that.year,_that.color,_that.mileage,_that.status,_that.vehicleTypeId,_that.vehicleType,_that.homeLocationId,_that.homeLocation);case _:
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

@optionalTypeArgs TResult when<TResult extends Object?>(TResult Function( String id,  String? internalNumber,  String? plate,  String? make,  String? model,  int? year,  String? color,  int? mileage,  String? status,  String? vehicleTypeId,  VehicleTypeRef? vehicleType,  String? homeLocationId,  LocationRef? homeLocation)  $default,) {final _that = this;
switch (_that) {
case _AvailableVehicle():
return $default(_that.id,_that.internalNumber,_that.plate,_that.make,_that.model,_that.year,_that.color,_that.mileage,_that.status,_that.vehicleTypeId,_that.vehicleType,_that.homeLocationId,_that.homeLocation);case _:
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

@optionalTypeArgs TResult? whenOrNull<TResult extends Object?>(TResult? Function( String id,  String? internalNumber,  String? plate,  String? make,  String? model,  int? year,  String? color,  int? mileage,  String? status,  String? vehicleTypeId,  VehicleTypeRef? vehicleType,  String? homeLocationId,  LocationRef? homeLocation)?  $default,) {final _that = this;
switch (_that) {
case _AvailableVehicle() when $default != null:
return $default(_that.id,_that.internalNumber,_that.plate,_that.make,_that.model,_that.year,_that.color,_that.mileage,_that.status,_that.vehicleTypeId,_that.vehicleType,_that.homeLocationId,_that.homeLocation);case _:
  return null;

}
}

}

/// @nodoc
@JsonSerializable()

class _AvailableVehicle extends AvailableVehicle {
  const _AvailableVehicle({required this.id, this.internalNumber, this.plate, this.make, this.model, this.year, this.color, this.mileage, this.status, this.vehicleTypeId, this.vehicleType, this.homeLocationId, this.homeLocation}): super._();
  factory _AvailableVehicle.fromJson(Map<String, dynamic> json) => _$AvailableVehicleFromJson(json);

@override final  String id;
@override final  String? internalNumber;
@override final  String? plate;
@override final  String? make;
@override final  String? model;
@override final  int? year;
@override final  String? color;
/// Espejo del odómetro (`Vehicle.mileage`).
@override final  int? mileage;
/// AVAILABLE | RENTED | RESERVED | … Se muestra crudo solo cuando NO es
/// AVAILABLE: el candidato pasó el filtro del servidor, pero el agente
/// merece ver que la unidad no está en el patio ahora mismo.
@override final  String? status;
@override final  String? vehicleTypeId;
@override final  VehicleTypeRef? vehicleType;
@override final  String? homeLocationId;
@override final  LocationRef? homeLocation;

/// Create a copy of AvailableVehicle
/// with the given fields replaced by the non-null parameter values.
@override @JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
_$AvailableVehicleCopyWith<_AvailableVehicle> get copyWith => __$AvailableVehicleCopyWithImpl<_AvailableVehicle>(this, _$identity);

@override
Map<String, dynamic> toJson() {
  return _$AvailableVehicleToJson(this, );
}

@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is _AvailableVehicle&&(identical(other.id, id) || other.id == id)&&(identical(other.internalNumber, internalNumber) || other.internalNumber == internalNumber)&&(identical(other.plate, plate) || other.plate == plate)&&(identical(other.make, make) || other.make == make)&&(identical(other.model, model) || other.model == model)&&(identical(other.year, year) || other.year == year)&&(identical(other.color, color) || other.color == color)&&(identical(other.mileage, mileage) || other.mileage == mileage)&&(identical(other.status, status) || other.status == status)&&(identical(other.vehicleTypeId, vehicleTypeId) || other.vehicleTypeId == vehicleTypeId)&&(identical(other.vehicleType, vehicleType) || other.vehicleType == vehicleType)&&(identical(other.homeLocationId, homeLocationId) || other.homeLocationId == homeLocationId)&&(identical(other.homeLocation, homeLocation) || other.homeLocation == homeLocation));
}

@JsonKey(includeFromJson: false, includeToJson: false)
@override
int get hashCode => Object.hash(runtimeType,id,internalNumber,plate,make,model,year,color,mileage,status,vehicleTypeId,vehicleType,homeLocationId,homeLocation);

@override
String toString() {
  return 'AvailableVehicle(id: $id, internalNumber: $internalNumber, plate: $plate, make: $make, model: $model, year: $year, color: $color, mileage: $mileage, status: $status, vehicleTypeId: $vehicleTypeId, vehicleType: $vehicleType, homeLocationId: $homeLocationId, homeLocation: $homeLocation)';
}


}

/// @nodoc
abstract mixin class _$AvailableVehicleCopyWith<$Res> implements $AvailableVehicleCopyWith<$Res> {
  factory _$AvailableVehicleCopyWith(_AvailableVehicle value, $Res Function(_AvailableVehicle) _then) = __$AvailableVehicleCopyWithImpl;
@override @useResult
$Res call({
 String id, String? internalNumber, String? plate, String? make, String? model, int? year, String? color, int? mileage, String? status, String? vehicleTypeId, VehicleTypeRef? vehicleType, String? homeLocationId, LocationRef? homeLocation
});


@override $VehicleTypeRefCopyWith<$Res>? get vehicleType;@override $LocationRefCopyWith<$Res>? get homeLocation;

}
/// @nodoc
class __$AvailableVehicleCopyWithImpl<$Res>
    implements _$AvailableVehicleCopyWith<$Res> {
  __$AvailableVehicleCopyWithImpl(this._self, this._then);

  final _AvailableVehicle _self;
  final $Res Function(_AvailableVehicle) _then;

/// Create a copy of AvailableVehicle
/// with the given fields replaced by the non-null parameter values.
@override @pragma('vm:prefer-inline') $Res call({Object? id = null,Object? internalNumber = freezed,Object? plate = freezed,Object? make = freezed,Object? model = freezed,Object? year = freezed,Object? color = freezed,Object? mileage = freezed,Object? status = freezed,Object? vehicleTypeId = freezed,Object? vehicleType = freezed,Object? homeLocationId = freezed,Object? homeLocation = freezed,}) {
  return _then(_AvailableVehicle(
id: null == id ? _self.id : id // ignore: cast_nullable_to_non_nullable
as String,internalNumber: freezed == internalNumber ? _self.internalNumber : internalNumber // ignore: cast_nullable_to_non_nullable
as String?,plate: freezed == plate ? _self.plate : plate // ignore: cast_nullable_to_non_nullable
as String?,make: freezed == make ? _self.make : make // ignore: cast_nullable_to_non_nullable
as String?,model: freezed == model ? _self.model : model // ignore: cast_nullable_to_non_nullable
as String?,year: freezed == year ? _self.year : year // ignore: cast_nullable_to_non_nullable
as int?,color: freezed == color ? _self.color : color // ignore: cast_nullable_to_non_nullable
as String?,mileage: freezed == mileage ? _self.mileage : mileage // ignore: cast_nullable_to_non_nullable
as int?,status: freezed == status ? _self.status : status // ignore: cast_nullable_to_non_nullable
as String?,vehicleTypeId: freezed == vehicleTypeId ? _self.vehicleTypeId : vehicleTypeId // ignore: cast_nullable_to_non_nullable
as String?,vehicleType: freezed == vehicleType ? _self.vehicleType : vehicleType // ignore: cast_nullable_to_non_nullable
as VehicleTypeRef?,homeLocationId: freezed == homeLocationId ? _self.homeLocationId : homeLocationId // ignore: cast_nullable_to_non_nullable
as String?,homeLocation: freezed == homeLocation ? _self.homeLocation : homeLocation // ignore: cast_nullable_to_non_nullable
as LocationRef?,
  ));
}

/// Create a copy of AvailableVehicle
/// with the given fields replaced by the non-null parameter values.
@override
@pragma('vm:prefer-inline')
$VehicleTypeRefCopyWith<$Res>? get vehicleType {
    if (_self.vehicleType == null) {
    return null;
  }

  return $VehicleTypeRefCopyWith<$Res>(_self.vehicleType!, (value) {
    return _then(_self.copyWith(vehicleType: value));
  });
}/// Create a copy of AvailableVehicle
/// with the given fields replaced by the non-null parameter values.
@override
@pragma('vm:prefer-inline')
$LocationRefCopyWith<$Res>? get homeLocation {
    if (_self.homeLocation == null) {
    return null;
  }

  return $LocationRefCopyWith<$Res>(_self.homeLocation!, (value) {
    return _then(_self.copyWith(homeLocation: value));
  });
}
}


/// @nodoc
mixin _$VehicleTypeRef {

 String get id; String? get name;
/// Create a copy of VehicleTypeRef
/// with the given fields replaced by the non-null parameter values.
@JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
$VehicleTypeRefCopyWith<VehicleTypeRef> get copyWith => _$VehicleTypeRefCopyWithImpl<VehicleTypeRef>(this as VehicleTypeRef, _$identity);

  /// Serializes this VehicleTypeRef to a JSON map.
  Map<String, dynamic> toJson();


@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is VehicleTypeRef&&(identical(other.id, id) || other.id == id)&&(identical(other.name, name) || other.name == name));
}

@JsonKey(includeFromJson: false, includeToJson: false)
@override
int get hashCode => Object.hash(runtimeType,id,name);

@override
String toString() {
  return 'VehicleTypeRef(id: $id, name: $name)';
}


}

/// @nodoc
abstract mixin class $VehicleTypeRefCopyWith<$Res>  {
  factory $VehicleTypeRefCopyWith(VehicleTypeRef value, $Res Function(VehicleTypeRef) _then) = _$VehicleTypeRefCopyWithImpl;
@useResult
$Res call({
 String id, String? name
});




}
/// @nodoc
class _$VehicleTypeRefCopyWithImpl<$Res>
    implements $VehicleTypeRefCopyWith<$Res> {
  _$VehicleTypeRefCopyWithImpl(this._self, this._then);

  final VehicleTypeRef _self;
  final $Res Function(VehicleTypeRef) _then;

/// Create a copy of VehicleTypeRef
/// with the given fields replaced by the non-null parameter values.
@pragma('vm:prefer-inline') @override $Res call({Object? id = null,Object? name = freezed,}) {
  return _then(_self.copyWith(
id: null == id ? _self.id : id // ignore: cast_nullable_to_non_nullable
as String,name: freezed == name ? _self.name : name // ignore: cast_nullable_to_non_nullable
as String?,
  ));
}

}


/// Adds pattern-matching-related methods to [VehicleTypeRef].
extension VehicleTypeRefPatterns on VehicleTypeRef {
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

@optionalTypeArgs TResult maybeMap<TResult extends Object?>(TResult Function( _VehicleTypeRef value)?  $default,{required TResult orElse(),}){
final _that = this;
switch (_that) {
case _VehicleTypeRef() when $default != null:
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

@optionalTypeArgs TResult map<TResult extends Object?>(TResult Function( _VehicleTypeRef value)  $default,){
final _that = this;
switch (_that) {
case _VehicleTypeRef():
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

@optionalTypeArgs TResult? mapOrNull<TResult extends Object?>(TResult? Function( _VehicleTypeRef value)?  $default,){
final _that = this;
switch (_that) {
case _VehicleTypeRef() when $default != null:
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
case _VehicleTypeRef() when $default != null:
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
case _VehicleTypeRef():
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
case _VehicleTypeRef() when $default != null:
return $default(_that.id,_that.name);case _:
  return null;

}
}

}

/// @nodoc
@JsonSerializable()

class _VehicleTypeRef implements VehicleTypeRef {
  const _VehicleTypeRef({required this.id, this.name});
  factory _VehicleTypeRef.fromJson(Map<String, dynamic> json) => _$VehicleTypeRefFromJson(json);

@override final  String id;
@override final  String? name;

/// Create a copy of VehicleTypeRef
/// with the given fields replaced by the non-null parameter values.
@override @JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
_$VehicleTypeRefCopyWith<_VehicleTypeRef> get copyWith => __$VehicleTypeRefCopyWithImpl<_VehicleTypeRef>(this, _$identity);

@override
Map<String, dynamic> toJson() {
  return _$VehicleTypeRefToJson(this, );
}

@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is _VehicleTypeRef&&(identical(other.id, id) || other.id == id)&&(identical(other.name, name) || other.name == name));
}

@JsonKey(includeFromJson: false, includeToJson: false)
@override
int get hashCode => Object.hash(runtimeType,id,name);

@override
String toString() {
  return 'VehicleTypeRef(id: $id, name: $name)';
}


}

/// @nodoc
abstract mixin class _$VehicleTypeRefCopyWith<$Res> implements $VehicleTypeRefCopyWith<$Res> {
  factory _$VehicleTypeRefCopyWith(_VehicleTypeRef value, $Res Function(_VehicleTypeRef) _then) = __$VehicleTypeRefCopyWithImpl;
@override @useResult
$Res call({
 String id, String? name
});




}
/// @nodoc
class __$VehicleTypeRefCopyWithImpl<$Res>
    implements _$VehicleTypeRefCopyWith<$Res> {
  __$VehicleTypeRefCopyWithImpl(this._self, this._then);

  final _VehicleTypeRef _self;
  final $Res Function(_VehicleTypeRef) _then;

/// Create a copy of VehicleTypeRef
/// with the given fields replaced by the non-null parameter values.
@override @pragma('vm:prefer-inline') $Res call({Object? id = null,Object? name = freezed,}) {
  return _then(_VehicleTypeRef(
id: null == id ? _self.id : id // ignore: cast_nullable_to_non_nullable
as String,name: freezed == name ? _self.name : name // ignore: cast_nullable_to_non_nullable
as String?,
  ));
}


}


/// @nodoc
mixin _$LocationRef {

 String get id; String? get name;
/// Create a copy of LocationRef
/// with the given fields replaced by the non-null parameter values.
@JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
$LocationRefCopyWith<LocationRef> get copyWith => _$LocationRefCopyWithImpl<LocationRef>(this as LocationRef, _$identity);

  /// Serializes this LocationRef to a JSON map.
  Map<String, dynamic> toJson();


@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is LocationRef&&(identical(other.id, id) || other.id == id)&&(identical(other.name, name) || other.name == name));
}

@JsonKey(includeFromJson: false, includeToJson: false)
@override
int get hashCode => Object.hash(runtimeType,id,name);

@override
String toString() {
  return 'LocationRef(id: $id, name: $name)';
}


}

/// @nodoc
abstract mixin class $LocationRefCopyWith<$Res>  {
  factory $LocationRefCopyWith(LocationRef value, $Res Function(LocationRef) _then) = _$LocationRefCopyWithImpl;
@useResult
$Res call({
 String id, String? name
});




}
/// @nodoc
class _$LocationRefCopyWithImpl<$Res>
    implements $LocationRefCopyWith<$Res> {
  _$LocationRefCopyWithImpl(this._self, this._then);

  final LocationRef _self;
  final $Res Function(LocationRef) _then;

/// Create a copy of LocationRef
/// with the given fields replaced by the non-null parameter values.
@pragma('vm:prefer-inline') @override $Res call({Object? id = null,Object? name = freezed,}) {
  return _then(_self.copyWith(
id: null == id ? _self.id : id // ignore: cast_nullable_to_non_nullable
as String,name: freezed == name ? _self.name : name // ignore: cast_nullable_to_non_nullable
as String?,
  ));
}

}


/// Adds pattern-matching-related methods to [LocationRef].
extension LocationRefPatterns on LocationRef {
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

@optionalTypeArgs TResult maybeMap<TResult extends Object?>(TResult Function( _LocationRef value)?  $default,{required TResult orElse(),}){
final _that = this;
switch (_that) {
case _LocationRef() when $default != null:
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

@optionalTypeArgs TResult map<TResult extends Object?>(TResult Function( _LocationRef value)  $default,){
final _that = this;
switch (_that) {
case _LocationRef():
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

@optionalTypeArgs TResult? mapOrNull<TResult extends Object?>(TResult? Function( _LocationRef value)?  $default,){
final _that = this;
switch (_that) {
case _LocationRef() when $default != null:
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
case _LocationRef() when $default != null:
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
case _LocationRef():
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
case _LocationRef() when $default != null:
return $default(_that.id,_that.name);case _:
  return null;

}
}

}

/// @nodoc
@JsonSerializable()

class _LocationRef implements LocationRef {
  const _LocationRef({required this.id, this.name});
  factory _LocationRef.fromJson(Map<String, dynamic> json) => _$LocationRefFromJson(json);

@override final  String id;
@override final  String? name;

/// Create a copy of LocationRef
/// with the given fields replaced by the non-null parameter values.
@override @JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
_$LocationRefCopyWith<_LocationRef> get copyWith => __$LocationRefCopyWithImpl<_LocationRef>(this, _$identity);

@override
Map<String, dynamic> toJson() {
  return _$LocationRefToJson(this, );
}

@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is _LocationRef&&(identical(other.id, id) || other.id == id)&&(identical(other.name, name) || other.name == name));
}

@JsonKey(includeFromJson: false, includeToJson: false)
@override
int get hashCode => Object.hash(runtimeType,id,name);

@override
String toString() {
  return 'LocationRef(id: $id, name: $name)';
}


}

/// @nodoc
abstract mixin class _$LocationRefCopyWith<$Res> implements $LocationRefCopyWith<$Res> {
  factory _$LocationRefCopyWith(_LocationRef value, $Res Function(_LocationRef) _then) = __$LocationRefCopyWithImpl;
@override @useResult
$Res call({
 String id, String? name
});




}
/// @nodoc
class __$LocationRefCopyWithImpl<$Res>
    implements _$LocationRefCopyWith<$Res> {
  __$LocationRefCopyWithImpl(this._self, this._then);

  final _LocationRef _self;
  final $Res Function(_LocationRef) _then;

/// Create a copy of LocationRef
/// with the given fields replaced by the non-null parameter values.
@override @pragma('vm:prefer-inline') $Res call({Object? id = null,Object? name = freezed,}) {
  return _then(_LocationRef(
id: null == id ? _self.id : id // ignore: cast_nullable_to_non_nullable
as String,name: freezed == name ? _self.name : name // ignore: cast_nullable_to_non_nullable
as String?,
  ));
}


}

// dart format on
