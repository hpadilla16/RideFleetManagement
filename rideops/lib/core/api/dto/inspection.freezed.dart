// GENERATED CODE - DO NOT MODIFY BY HAND
// coverage:ignore-file
// ignore_for_file: type=lint
// ignore_for_file: unused_element, deprecated_member_use, deprecated_member_use_from_same_package, use_function_type_syntax_for_parameters, unnecessary_const, avoid_init_to_null, invalid_override_different_default_values_named, prefer_expression_function_bodies, annotate_overrides, invalid_annotation_target, unnecessary_question_mark

part of 'inspection.dart';

// **************************************************************************
// FreezedGenerator
// **************************************************************************

// dart format off
T _$identity<T>(T value) => value;

/// @nodoc
mixin _$HandoffToken {

 String get token;@IsoDateTimeConverter() DateTime? get expiresAt; String get kind; bool get reused;/// URL ABSOLUTA que el cliente abre al escanear el QR, ya resuelta por el
/// servidor (`publicUrlForToken`, checkout-session.service.js:62-64).
///
/// Llega solo en `TERMS_SIGNING`: para `MOBILE_INSPECTION` el backend
/// manda **null** a propósito —ese token se canjea por API y no tiene
/// página pública— y adivinarle una ruta sería peor que omitirla. O sea
/// que null aquí NO es "backend viejo", puede ser "este kind no tiene
/// URL"; el fallback de la app cubre los dos casos igual.
 String? get signUrl;
/// Create a copy of HandoffToken
/// with the given fields replaced by the non-null parameter values.
@JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
$HandoffTokenCopyWith<HandoffToken> get copyWith => _$HandoffTokenCopyWithImpl<HandoffToken>(this as HandoffToken, _$identity);

  /// Serializes this HandoffToken to a JSON map.
  Map<String, dynamic> toJson();


@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is HandoffToken&&(identical(other.token, token) || other.token == token)&&(identical(other.expiresAt, expiresAt) || other.expiresAt == expiresAt)&&(identical(other.kind, kind) || other.kind == kind)&&(identical(other.reused, reused) || other.reused == reused)&&(identical(other.signUrl, signUrl) || other.signUrl == signUrl));
}

@JsonKey(includeFromJson: false, includeToJson: false)
@override
int get hashCode => Object.hash(runtimeType,token,expiresAt,kind,reused,signUrl);

@override
String toString() {
  return 'HandoffToken(token: $token, expiresAt: $expiresAt, kind: $kind, reused: $reused, signUrl: $signUrl)';
}


}

/// @nodoc
abstract mixin class $HandoffTokenCopyWith<$Res>  {
  factory $HandoffTokenCopyWith(HandoffToken value, $Res Function(HandoffToken) _then) = _$HandoffTokenCopyWithImpl;
@useResult
$Res call({
 String token,@IsoDateTimeConverter() DateTime? expiresAt, String kind, bool reused, String? signUrl
});




}
/// @nodoc
class _$HandoffTokenCopyWithImpl<$Res>
    implements $HandoffTokenCopyWith<$Res> {
  _$HandoffTokenCopyWithImpl(this._self, this._then);

  final HandoffToken _self;
  final $Res Function(HandoffToken) _then;

/// Create a copy of HandoffToken
/// with the given fields replaced by the non-null parameter values.
@pragma('vm:prefer-inline') @override $Res call({Object? token = null,Object? expiresAt = freezed,Object? kind = null,Object? reused = null,Object? signUrl = freezed,}) {
  return _then(_self.copyWith(
token: null == token ? _self.token : token // ignore: cast_nullable_to_non_nullable
as String,expiresAt: freezed == expiresAt ? _self.expiresAt : expiresAt // ignore: cast_nullable_to_non_nullable
as DateTime?,kind: null == kind ? _self.kind : kind // ignore: cast_nullable_to_non_nullable
as String,reused: null == reused ? _self.reused : reused // ignore: cast_nullable_to_non_nullable
as bool,signUrl: freezed == signUrl ? _self.signUrl : signUrl // ignore: cast_nullable_to_non_nullable
as String?,
  ));
}

}


/// Adds pattern-matching-related methods to [HandoffToken].
extension HandoffTokenPatterns on HandoffToken {
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

@optionalTypeArgs TResult maybeMap<TResult extends Object?>(TResult Function( _HandoffToken value)?  $default,{required TResult orElse(),}){
final _that = this;
switch (_that) {
case _HandoffToken() when $default != null:
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

@optionalTypeArgs TResult map<TResult extends Object?>(TResult Function( _HandoffToken value)  $default,){
final _that = this;
switch (_that) {
case _HandoffToken():
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

@optionalTypeArgs TResult? mapOrNull<TResult extends Object?>(TResult? Function( _HandoffToken value)?  $default,){
final _that = this;
switch (_that) {
case _HandoffToken() when $default != null:
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

@optionalTypeArgs TResult maybeWhen<TResult extends Object?>(TResult Function( String token, @IsoDateTimeConverter()  DateTime? expiresAt,  String kind,  bool reused,  String? signUrl)?  $default,{required TResult orElse(),}) {final _that = this;
switch (_that) {
case _HandoffToken() when $default != null:
return $default(_that.token,_that.expiresAt,_that.kind,_that.reused,_that.signUrl);case _:
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

@optionalTypeArgs TResult when<TResult extends Object?>(TResult Function( String token, @IsoDateTimeConverter()  DateTime? expiresAt,  String kind,  bool reused,  String? signUrl)  $default,) {final _that = this;
switch (_that) {
case _HandoffToken():
return $default(_that.token,_that.expiresAt,_that.kind,_that.reused,_that.signUrl);case _:
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

@optionalTypeArgs TResult? whenOrNull<TResult extends Object?>(TResult? Function( String token, @IsoDateTimeConverter()  DateTime? expiresAt,  String kind,  bool reused,  String? signUrl)?  $default,) {final _that = this;
switch (_that) {
case _HandoffToken() when $default != null:
return $default(_that.token,_that.expiresAt,_that.kind,_that.reused,_that.signUrl);case _:
  return null;

}
}

}

/// @nodoc
@JsonSerializable()

class _HandoffToken extends HandoffToken {
  const _HandoffToken({required this.token, @IsoDateTimeConverter() this.expiresAt, required this.kind, this.reused = false, this.signUrl}): super._();
  factory _HandoffToken.fromJson(Map<String, dynamic> json) => _$HandoffTokenFromJson(json);

@override final  String token;
@override@IsoDateTimeConverter() final  DateTime? expiresAt;
@override final  String kind;
@override@JsonKey() final  bool reused;
/// URL ABSOLUTA que el cliente abre al escanear el QR, ya resuelta por el
/// servidor (`publicUrlForToken`, checkout-session.service.js:62-64).
///
/// Llega solo en `TERMS_SIGNING`: para `MOBILE_INSPECTION` el backend
/// manda **null** a propósito —ese token se canjea por API y no tiene
/// página pública— y adivinarle una ruta sería peor que omitirla. O sea
/// que null aquí NO es "backend viejo", puede ser "este kind no tiene
/// URL"; el fallback de la app cubre los dos casos igual.
@override final  String? signUrl;

/// Create a copy of HandoffToken
/// with the given fields replaced by the non-null parameter values.
@override @JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
_$HandoffTokenCopyWith<_HandoffToken> get copyWith => __$HandoffTokenCopyWithImpl<_HandoffToken>(this, _$identity);

@override
Map<String, dynamic> toJson() {
  return _$HandoffTokenToJson(this, );
}

@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is _HandoffToken&&(identical(other.token, token) || other.token == token)&&(identical(other.expiresAt, expiresAt) || other.expiresAt == expiresAt)&&(identical(other.kind, kind) || other.kind == kind)&&(identical(other.reused, reused) || other.reused == reused)&&(identical(other.signUrl, signUrl) || other.signUrl == signUrl));
}

@JsonKey(includeFromJson: false, includeToJson: false)
@override
int get hashCode => Object.hash(runtimeType,token,expiresAt,kind,reused,signUrl);

@override
String toString() {
  return 'HandoffToken(token: $token, expiresAt: $expiresAt, kind: $kind, reused: $reused, signUrl: $signUrl)';
}


}

/// @nodoc
abstract mixin class _$HandoffTokenCopyWith<$Res> implements $HandoffTokenCopyWith<$Res> {
  factory _$HandoffTokenCopyWith(_HandoffToken value, $Res Function(_HandoffToken) _then) = __$HandoffTokenCopyWithImpl;
@override @useResult
$Res call({
 String token,@IsoDateTimeConverter() DateTime? expiresAt, String kind, bool reused, String? signUrl
});




}
/// @nodoc
class __$HandoffTokenCopyWithImpl<$Res>
    implements _$HandoffTokenCopyWith<$Res> {
  __$HandoffTokenCopyWithImpl(this._self, this._then);

  final _HandoffToken _self;
  final $Res Function(_HandoffToken) _then;

/// Create a copy of HandoffToken
/// with the given fields replaced by the non-null parameter values.
@override @pragma('vm:prefer-inline') $Res call({Object? token = null,Object? expiresAt = freezed,Object? kind = null,Object? reused = null,Object? signUrl = freezed,}) {
  return _then(_HandoffToken(
token: null == token ? _self.token : token // ignore: cast_nullable_to_non_nullable
as String,expiresAt: freezed == expiresAt ? _self.expiresAt : expiresAt // ignore: cast_nullable_to_non_nullable
as DateTime?,kind: null == kind ? _self.kind : kind // ignore: cast_nullable_to_non_nullable
as String,reused: null == reused ? _self.reused : reused // ignore: cast_nullable_to_non_nullable
as bool,signUrl: freezed == signUrl ? _self.signUrl : signUrl // ignore: cast_nullable_to_non_nullable
as String?,
  ));
}


}


/// @nodoc
mixin _$MobileInspectionState {

 String? get reservationNumber; String? get agreementNumber; String? get vehicle; List<InspectionAngle> get angles;@IsoDateTimeConverter() DateTime? get expiresAt;
/// Create a copy of MobileInspectionState
/// with the given fields replaced by the non-null parameter values.
@JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
$MobileInspectionStateCopyWith<MobileInspectionState> get copyWith => _$MobileInspectionStateCopyWithImpl<MobileInspectionState>(this as MobileInspectionState, _$identity);

  /// Serializes this MobileInspectionState to a JSON map.
  Map<String, dynamic> toJson();


@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is MobileInspectionState&&(identical(other.reservationNumber, reservationNumber) || other.reservationNumber == reservationNumber)&&(identical(other.agreementNumber, agreementNumber) || other.agreementNumber == agreementNumber)&&(identical(other.vehicle, vehicle) || other.vehicle == vehicle)&&const DeepCollectionEquality().equals(other.angles, angles)&&(identical(other.expiresAt, expiresAt) || other.expiresAt == expiresAt));
}

@JsonKey(includeFromJson: false, includeToJson: false)
@override
int get hashCode => Object.hash(runtimeType,reservationNumber,agreementNumber,vehicle,const DeepCollectionEquality().hash(angles),expiresAt);

@override
String toString() {
  return 'MobileInspectionState(reservationNumber: $reservationNumber, agreementNumber: $agreementNumber, vehicle: $vehicle, angles: $angles, expiresAt: $expiresAt)';
}


}

/// @nodoc
abstract mixin class $MobileInspectionStateCopyWith<$Res>  {
  factory $MobileInspectionStateCopyWith(MobileInspectionState value, $Res Function(MobileInspectionState) _then) = _$MobileInspectionStateCopyWithImpl;
@useResult
$Res call({
 String? reservationNumber, String? agreementNumber, String? vehicle, List<InspectionAngle> angles,@IsoDateTimeConverter() DateTime? expiresAt
});




}
/// @nodoc
class _$MobileInspectionStateCopyWithImpl<$Res>
    implements $MobileInspectionStateCopyWith<$Res> {
  _$MobileInspectionStateCopyWithImpl(this._self, this._then);

  final MobileInspectionState _self;
  final $Res Function(MobileInspectionState) _then;

/// Create a copy of MobileInspectionState
/// with the given fields replaced by the non-null parameter values.
@pragma('vm:prefer-inline') @override $Res call({Object? reservationNumber = freezed,Object? agreementNumber = freezed,Object? vehicle = freezed,Object? angles = null,Object? expiresAt = freezed,}) {
  return _then(_self.copyWith(
reservationNumber: freezed == reservationNumber ? _self.reservationNumber : reservationNumber // ignore: cast_nullable_to_non_nullable
as String?,agreementNumber: freezed == agreementNumber ? _self.agreementNumber : agreementNumber // ignore: cast_nullable_to_non_nullable
as String?,vehicle: freezed == vehicle ? _self.vehicle : vehicle // ignore: cast_nullable_to_non_nullable
as String?,angles: null == angles ? _self.angles : angles // ignore: cast_nullable_to_non_nullable
as List<InspectionAngle>,expiresAt: freezed == expiresAt ? _self.expiresAt : expiresAt // ignore: cast_nullable_to_non_nullable
as DateTime?,
  ));
}

}


/// Adds pattern-matching-related methods to [MobileInspectionState].
extension MobileInspectionStatePatterns on MobileInspectionState {
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

@optionalTypeArgs TResult maybeMap<TResult extends Object?>(TResult Function( _MobileInspectionState value)?  $default,{required TResult orElse(),}){
final _that = this;
switch (_that) {
case _MobileInspectionState() when $default != null:
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

@optionalTypeArgs TResult map<TResult extends Object?>(TResult Function( _MobileInspectionState value)  $default,){
final _that = this;
switch (_that) {
case _MobileInspectionState():
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

@optionalTypeArgs TResult? mapOrNull<TResult extends Object?>(TResult? Function( _MobileInspectionState value)?  $default,){
final _that = this;
switch (_that) {
case _MobileInspectionState() when $default != null:
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

@optionalTypeArgs TResult maybeWhen<TResult extends Object?>(TResult Function( String? reservationNumber,  String? agreementNumber,  String? vehicle,  List<InspectionAngle> angles, @IsoDateTimeConverter()  DateTime? expiresAt)?  $default,{required TResult orElse(),}) {final _that = this;
switch (_that) {
case _MobileInspectionState() when $default != null:
return $default(_that.reservationNumber,_that.agreementNumber,_that.vehicle,_that.angles,_that.expiresAt);case _:
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

@optionalTypeArgs TResult when<TResult extends Object?>(TResult Function( String? reservationNumber,  String? agreementNumber,  String? vehicle,  List<InspectionAngle> angles, @IsoDateTimeConverter()  DateTime? expiresAt)  $default,) {final _that = this;
switch (_that) {
case _MobileInspectionState():
return $default(_that.reservationNumber,_that.agreementNumber,_that.vehicle,_that.angles,_that.expiresAt);case _:
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

@optionalTypeArgs TResult? whenOrNull<TResult extends Object?>(TResult? Function( String? reservationNumber,  String? agreementNumber,  String? vehicle,  List<InspectionAngle> angles, @IsoDateTimeConverter()  DateTime? expiresAt)?  $default,) {final _that = this;
switch (_that) {
case _MobileInspectionState() when $default != null:
return $default(_that.reservationNumber,_that.agreementNumber,_that.vehicle,_that.angles,_that.expiresAt);case _:
  return null;

}
}

}

/// @nodoc
@JsonSerializable()

class _MobileInspectionState implements MobileInspectionState {
  const _MobileInspectionState({this.reservationNumber, this.agreementNumber, this.vehicle, final  List<InspectionAngle> angles = const <InspectionAngle>[], @IsoDateTimeConverter() this.expiresAt}): _angles = angles;
  factory _MobileInspectionState.fromJson(Map<String, dynamic> json) => _$MobileInspectionStateFromJson(json);

@override final  String? reservationNumber;
@override final  String? agreementNumber;
@override final  String? vehicle;
 final  List<InspectionAngle> _angles;
@override@JsonKey() List<InspectionAngle> get angles {
  if (_angles is EqualUnmodifiableListView) return _angles;
  // ignore: implicit_dynamic_type
  return EqualUnmodifiableListView(_angles);
}

@override@IsoDateTimeConverter() final  DateTime? expiresAt;

/// Create a copy of MobileInspectionState
/// with the given fields replaced by the non-null parameter values.
@override @JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
_$MobileInspectionStateCopyWith<_MobileInspectionState> get copyWith => __$MobileInspectionStateCopyWithImpl<_MobileInspectionState>(this, _$identity);

@override
Map<String, dynamic> toJson() {
  return _$MobileInspectionStateToJson(this, );
}

@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is _MobileInspectionState&&(identical(other.reservationNumber, reservationNumber) || other.reservationNumber == reservationNumber)&&(identical(other.agreementNumber, agreementNumber) || other.agreementNumber == agreementNumber)&&(identical(other.vehicle, vehicle) || other.vehicle == vehicle)&&const DeepCollectionEquality().equals(other._angles, _angles)&&(identical(other.expiresAt, expiresAt) || other.expiresAt == expiresAt));
}

@JsonKey(includeFromJson: false, includeToJson: false)
@override
int get hashCode => Object.hash(runtimeType,reservationNumber,agreementNumber,vehicle,const DeepCollectionEquality().hash(_angles),expiresAt);

@override
String toString() {
  return 'MobileInspectionState(reservationNumber: $reservationNumber, agreementNumber: $agreementNumber, vehicle: $vehicle, angles: $angles, expiresAt: $expiresAt)';
}


}

/// @nodoc
abstract mixin class _$MobileInspectionStateCopyWith<$Res> implements $MobileInspectionStateCopyWith<$Res> {
  factory _$MobileInspectionStateCopyWith(_MobileInspectionState value, $Res Function(_MobileInspectionState) _then) = __$MobileInspectionStateCopyWithImpl;
@override @useResult
$Res call({
 String? reservationNumber, String? agreementNumber, String? vehicle, List<InspectionAngle> angles,@IsoDateTimeConverter() DateTime? expiresAt
});




}
/// @nodoc
class __$MobileInspectionStateCopyWithImpl<$Res>
    implements _$MobileInspectionStateCopyWith<$Res> {
  __$MobileInspectionStateCopyWithImpl(this._self, this._then);

  final _MobileInspectionState _self;
  final $Res Function(_MobileInspectionState) _then;

/// Create a copy of MobileInspectionState
/// with the given fields replaced by the non-null parameter values.
@override @pragma('vm:prefer-inline') $Res call({Object? reservationNumber = freezed,Object? agreementNumber = freezed,Object? vehicle = freezed,Object? angles = null,Object? expiresAt = freezed,}) {
  return _then(_MobileInspectionState(
reservationNumber: freezed == reservationNumber ? _self.reservationNumber : reservationNumber // ignore: cast_nullable_to_non_nullable
as String?,agreementNumber: freezed == agreementNumber ? _self.agreementNumber : agreementNumber // ignore: cast_nullable_to_non_nullable
as String?,vehicle: freezed == vehicle ? _self.vehicle : vehicle // ignore: cast_nullable_to_non_nullable
as String?,angles: null == angles ? _self._angles : angles // ignore: cast_nullable_to_non_nullable
as List<InspectionAngle>,expiresAt: freezed == expiresAt ? _self.expiresAt : expiresAt // ignore: cast_nullable_to_non_nullable
as DateTime?,
  ));
}


}


/// @nodoc
mixin _$InspectionAngle {

 String get key; String get label; bool get captured;
/// Create a copy of InspectionAngle
/// with the given fields replaced by the non-null parameter values.
@JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
$InspectionAngleCopyWith<InspectionAngle> get copyWith => _$InspectionAngleCopyWithImpl<InspectionAngle>(this as InspectionAngle, _$identity);

  /// Serializes this InspectionAngle to a JSON map.
  Map<String, dynamic> toJson();


@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is InspectionAngle&&(identical(other.key, key) || other.key == key)&&(identical(other.label, label) || other.label == label)&&(identical(other.captured, captured) || other.captured == captured));
}

@JsonKey(includeFromJson: false, includeToJson: false)
@override
int get hashCode => Object.hash(runtimeType,key,label,captured);

@override
String toString() {
  return 'InspectionAngle(key: $key, label: $label, captured: $captured)';
}


}

/// @nodoc
abstract mixin class $InspectionAngleCopyWith<$Res>  {
  factory $InspectionAngleCopyWith(InspectionAngle value, $Res Function(InspectionAngle) _then) = _$InspectionAngleCopyWithImpl;
@useResult
$Res call({
 String key, String label, bool captured
});




}
/// @nodoc
class _$InspectionAngleCopyWithImpl<$Res>
    implements $InspectionAngleCopyWith<$Res> {
  _$InspectionAngleCopyWithImpl(this._self, this._then);

  final InspectionAngle _self;
  final $Res Function(InspectionAngle) _then;

/// Create a copy of InspectionAngle
/// with the given fields replaced by the non-null parameter values.
@pragma('vm:prefer-inline') @override $Res call({Object? key = null,Object? label = null,Object? captured = null,}) {
  return _then(_self.copyWith(
key: null == key ? _self.key : key // ignore: cast_nullable_to_non_nullable
as String,label: null == label ? _self.label : label // ignore: cast_nullable_to_non_nullable
as String,captured: null == captured ? _self.captured : captured // ignore: cast_nullable_to_non_nullable
as bool,
  ));
}

}


/// Adds pattern-matching-related methods to [InspectionAngle].
extension InspectionAnglePatterns on InspectionAngle {
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

@optionalTypeArgs TResult maybeMap<TResult extends Object?>(TResult Function( _InspectionAngle value)?  $default,{required TResult orElse(),}){
final _that = this;
switch (_that) {
case _InspectionAngle() when $default != null:
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

@optionalTypeArgs TResult map<TResult extends Object?>(TResult Function( _InspectionAngle value)  $default,){
final _that = this;
switch (_that) {
case _InspectionAngle():
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

@optionalTypeArgs TResult? mapOrNull<TResult extends Object?>(TResult? Function( _InspectionAngle value)?  $default,){
final _that = this;
switch (_that) {
case _InspectionAngle() when $default != null:
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

@optionalTypeArgs TResult maybeWhen<TResult extends Object?>(TResult Function( String key,  String label,  bool captured)?  $default,{required TResult orElse(),}) {final _that = this;
switch (_that) {
case _InspectionAngle() when $default != null:
return $default(_that.key,_that.label,_that.captured);case _:
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

@optionalTypeArgs TResult when<TResult extends Object?>(TResult Function( String key,  String label,  bool captured)  $default,) {final _that = this;
switch (_that) {
case _InspectionAngle():
return $default(_that.key,_that.label,_that.captured);case _:
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

@optionalTypeArgs TResult? whenOrNull<TResult extends Object?>(TResult? Function( String key,  String label,  bool captured)?  $default,) {final _that = this;
switch (_that) {
case _InspectionAngle() when $default != null:
return $default(_that.key,_that.label,_that.captured);case _:
  return null;

}
}

}

/// @nodoc
@JsonSerializable()

class _InspectionAngle implements InspectionAngle {
  const _InspectionAngle({required this.key, required this.label, this.captured = false});
  factory _InspectionAngle.fromJson(Map<String, dynamic> json) => _$InspectionAngleFromJson(json);

@override final  String key;
@override final  String label;
@override@JsonKey() final  bool captured;

/// Create a copy of InspectionAngle
/// with the given fields replaced by the non-null parameter values.
@override @JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
_$InspectionAngleCopyWith<_InspectionAngle> get copyWith => __$InspectionAngleCopyWithImpl<_InspectionAngle>(this, _$identity);

@override
Map<String, dynamic> toJson() {
  return _$InspectionAngleToJson(this, );
}

@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is _InspectionAngle&&(identical(other.key, key) || other.key == key)&&(identical(other.label, label) || other.label == label)&&(identical(other.captured, captured) || other.captured == captured));
}

@JsonKey(includeFromJson: false, includeToJson: false)
@override
int get hashCode => Object.hash(runtimeType,key,label,captured);

@override
String toString() {
  return 'InspectionAngle(key: $key, label: $label, captured: $captured)';
}


}

/// @nodoc
abstract mixin class _$InspectionAngleCopyWith<$Res> implements $InspectionAngleCopyWith<$Res> {
  factory _$InspectionAngleCopyWith(_InspectionAngle value, $Res Function(_InspectionAngle) _then) = __$InspectionAngleCopyWithImpl;
@override @useResult
$Res call({
 String key, String label, bool captured
});




}
/// @nodoc
class __$InspectionAngleCopyWithImpl<$Res>
    implements _$InspectionAngleCopyWith<$Res> {
  __$InspectionAngleCopyWithImpl(this._self, this._then);

  final _InspectionAngle _self;
  final $Res Function(_InspectionAngle) _then;

/// Create a copy of InspectionAngle
/// with the given fields replaced by the non-null parameter values.
@override @pragma('vm:prefer-inline') $Res call({Object? key = null,Object? label = null,Object? captured = null,}) {
  return _then(_InspectionAngle(
key: null == key ? _self.key : key // ignore: cast_nullable_to_non_nullable
as String,label: null == label ? _self.label : label // ignore: cast_nullable_to_non_nullable
as String,captured: null == captured ? _self.captured : captured // ignore: cast_nullable_to_non_nullable
as bool,
  ));
}


}

// dart format on
