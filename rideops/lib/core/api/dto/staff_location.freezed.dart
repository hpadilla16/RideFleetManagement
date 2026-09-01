// GENERATED CODE - DO NOT MODIFY BY HAND
// coverage:ignore-file
// ignore_for_file: type=lint
// ignore_for_file: unused_element, deprecated_member_use, deprecated_member_use_from_same_package, use_function_type_syntax_for_parameters, unnecessary_const, avoid_init_to_null, invalid_override_different_default_values_named, prefer_expression_function_bodies, annotate_overrides, invalid_annotation_target, unnecessary_question_mark

part of 'staff_location.dart';

// **************************************************************************
// FreezedGenerator
// **************************************************************************

// dart format off
T _$identity<T>(T value) => value;

/// @nodoc
mixin _$StaffLocation {

 String get id; String? get code; String get name; String? get city; String? get state;
/// Create a copy of StaffLocation
/// with the given fields replaced by the non-null parameter values.
@JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
$StaffLocationCopyWith<StaffLocation> get copyWith => _$StaffLocationCopyWithImpl<StaffLocation>(this as StaffLocation, _$identity);

  /// Serializes this StaffLocation to a JSON map.
  Map<String, dynamic> toJson();


@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is StaffLocation&&(identical(other.id, id) || other.id == id)&&(identical(other.code, code) || other.code == code)&&(identical(other.name, name) || other.name == name)&&(identical(other.city, city) || other.city == city)&&(identical(other.state, state) || other.state == state));
}

@JsonKey(includeFromJson: false, includeToJson: false)
@override
int get hashCode => Object.hash(runtimeType,id,code,name,city,state);

@override
String toString() {
  return 'StaffLocation(id: $id, code: $code, name: $name, city: $city, state: $state)';
}


}

/// @nodoc
abstract mixin class $StaffLocationCopyWith<$Res>  {
  factory $StaffLocationCopyWith(StaffLocation value, $Res Function(StaffLocation) _then) = _$StaffLocationCopyWithImpl;
@useResult
$Res call({
 String id, String? code, String name, String? city, String? state
});




}
/// @nodoc
class _$StaffLocationCopyWithImpl<$Res>
    implements $StaffLocationCopyWith<$Res> {
  _$StaffLocationCopyWithImpl(this._self, this._then);

  final StaffLocation _self;
  final $Res Function(StaffLocation) _then;

/// Create a copy of StaffLocation
/// with the given fields replaced by the non-null parameter values.
@pragma('vm:prefer-inline') @override $Res call({Object? id = null,Object? code = freezed,Object? name = null,Object? city = freezed,Object? state = freezed,}) {
  return _then(_self.copyWith(
id: null == id ? _self.id : id // ignore: cast_nullable_to_non_nullable
as String,code: freezed == code ? _self.code : code // ignore: cast_nullable_to_non_nullable
as String?,name: null == name ? _self.name : name // ignore: cast_nullable_to_non_nullable
as String,city: freezed == city ? _self.city : city // ignore: cast_nullable_to_non_nullable
as String?,state: freezed == state ? _self.state : state // ignore: cast_nullable_to_non_nullable
as String?,
  ));
}

}


/// Adds pattern-matching-related methods to [StaffLocation].
extension StaffLocationPatterns on StaffLocation {
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

@optionalTypeArgs TResult maybeMap<TResult extends Object?>(TResult Function( _StaffLocation value)?  $default,{required TResult orElse(),}){
final _that = this;
switch (_that) {
case _StaffLocation() when $default != null:
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

@optionalTypeArgs TResult map<TResult extends Object?>(TResult Function( _StaffLocation value)  $default,){
final _that = this;
switch (_that) {
case _StaffLocation():
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

@optionalTypeArgs TResult? mapOrNull<TResult extends Object?>(TResult? Function( _StaffLocation value)?  $default,){
final _that = this;
switch (_that) {
case _StaffLocation() when $default != null:
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

@optionalTypeArgs TResult maybeWhen<TResult extends Object?>(TResult Function( String id,  String? code,  String name,  String? city,  String? state)?  $default,{required TResult orElse(),}) {final _that = this;
switch (_that) {
case _StaffLocation() when $default != null:
return $default(_that.id,_that.code,_that.name,_that.city,_that.state);case _:
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

@optionalTypeArgs TResult when<TResult extends Object?>(TResult Function( String id,  String? code,  String name,  String? city,  String? state)  $default,) {final _that = this;
switch (_that) {
case _StaffLocation():
return $default(_that.id,_that.code,_that.name,_that.city,_that.state);case _:
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

@optionalTypeArgs TResult? whenOrNull<TResult extends Object?>(TResult? Function( String id,  String? code,  String name,  String? city,  String? state)?  $default,) {final _that = this;
switch (_that) {
case _StaffLocation() when $default != null:
return $default(_that.id,_that.code,_that.name,_that.city,_that.state);case _:
  return null;

}
}

}

/// @nodoc
@JsonSerializable()

class _StaffLocation implements StaffLocation {
  const _StaffLocation({required this.id, this.code, required this.name, this.city, this.state});
  factory _StaffLocation.fromJson(Map<String, dynamic> json) => _$StaffLocationFromJson(json);

@override final  String id;
@override final  String? code;
@override final  String name;
@override final  String? city;
@override final  String? state;

/// Create a copy of StaffLocation
/// with the given fields replaced by the non-null parameter values.
@override @JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
_$StaffLocationCopyWith<_StaffLocation> get copyWith => __$StaffLocationCopyWithImpl<_StaffLocation>(this, _$identity);

@override
Map<String, dynamic> toJson() {
  return _$StaffLocationToJson(this, );
}

@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is _StaffLocation&&(identical(other.id, id) || other.id == id)&&(identical(other.code, code) || other.code == code)&&(identical(other.name, name) || other.name == name)&&(identical(other.city, city) || other.city == city)&&(identical(other.state, state) || other.state == state));
}

@JsonKey(includeFromJson: false, includeToJson: false)
@override
int get hashCode => Object.hash(runtimeType,id,code,name,city,state);

@override
String toString() {
  return 'StaffLocation(id: $id, code: $code, name: $name, city: $city, state: $state)';
}


}

/// @nodoc
abstract mixin class _$StaffLocationCopyWith<$Res> implements $StaffLocationCopyWith<$Res> {
  factory _$StaffLocationCopyWith(_StaffLocation value, $Res Function(_StaffLocation) _then) = __$StaffLocationCopyWithImpl;
@override @useResult
$Res call({
 String id, String? code, String name, String? city, String? state
});




}
/// @nodoc
class __$StaffLocationCopyWithImpl<$Res>
    implements _$StaffLocationCopyWith<$Res> {
  __$StaffLocationCopyWithImpl(this._self, this._then);

  final _StaffLocation _self;
  final $Res Function(_StaffLocation) _then;

/// Create a copy of StaffLocation
/// with the given fields replaced by the non-null parameter values.
@override @pragma('vm:prefer-inline') $Res call({Object? id = null,Object? code = freezed,Object? name = null,Object? city = freezed,Object? state = freezed,}) {
  return _then(_StaffLocation(
id: null == id ? _self.id : id // ignore: cast_nullable_to_non_nullable
as String,code: freezed == code ? _self.code : code // ignore: cast_nullable_to_non_nullable
as String?,name: null == name ? _self.name : name // ignore: cast_nullable_to_non_nullable
as String,city: freezed == city ? _self.city : city // ignore: cast_nullable_to_non_nullable
as String?,state: freezed == state ? _self.state : state // ignore: cast_nullable_to_non_nullable
as String?,
  ));
}


}

// dart format on
