// GENERATED CODE - DO NOT MODIFY BY HAND
// coverage:ignore-file
// ignore_for_file: type=lint
// ignore_for_file: unused_element, deprecated_member_use, deprecated_member_use_from_same_package, use_function_type_syntax_for_parameters, unnecessary_const, avoid_init_to_null, invalid_override_different_default_values_named, prefer_expression_function_bodies, annotate_overrides, invalid_annotation_target, unnecessary_question_mark

part of 'session_user.dart';

// **************************************************************************
// FreezedGenerator
// **************************************************************************

// dart format off
T _$identity<T>(T value) => value;

/// @nodoc
mixin _$SessionUser {

 String get id; String get email; String? get fullName; String get role; String? get tenantId; String? get createdByUserId; String? get hostProfileId; bool get screenLockExempt;/// `null` = TODAS las ubicaciones (usuario UNRESTRICTED). El backend
/// normaliza lista vacía a null (parseLocationIds, auth.service.js:78-85).
 List<String>? get locationIds; String get programScope; bool get isServiceAccount; int get tokenVersion;/// true → la sesión solo alcanza change-password/me/refresh; todo lo
/// demás 403 PASSWORD_CHANGE_REQUIRED. La app rutea a la pantalla de
/// cambio forzado (M1).
 bool get mustChangePassword;/// Mapa booleano sobre los 21 MODULE_KEYS (lib/module-access.js:6-47).
/// `paymentActions` es el que gobierna los botones de dinero en M2.
 Map<String, bool> get moduleAccess;
/// Create a copy of SessionUser
/// with the given fields replaced by the non-null parameter values.
@JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
$SessionUserCopyWith<SessionUser> get copyWith => _$SessionUserCopyWithImpl<SessionUser>(this as SessionUser, _$identity);

  /// Serializes this SessionUser to a JSON map.
  Map<String, dynamic> toJson();


@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is SessionUser&&(identical(other.id, id) || other.id == id)&&(identical(other.email, email) || other.email == email)&&(identical(other.fullName, fullName) || other.fullName == fullName)&&(identical(other.role, role) || other.role == role)&&(identical(other.tenantId, tenantId) || other.tenantId == tenantId)&&(identical(other.createdByUserId, createdByUserId) || other.createdByUserId == createdByUserId)&&(identical(other.hostProfileId, hostProfileId) || other.hostProfileId == hostProfileId)&&(identical(other.screenLockExempt, screenLockExempt) || other.screenLockExempt == screenLockExempt)&&const DeepCollectionEquality().equals(other.locationIds, locationIds)&&(identical(other.programScope, programScope) || other.programScope == programScope)&&(identical(other.isServiceAccount, isServiceAccount) || other.isServiceAccount == isServiceAccount)&&(identical(other.tokenVersion, tokenVersion) || other.tokenVersion == tokenVersion)&&(identical(other.mustChangePassword, mustChangePassword) || other.mustChangePassword == mustChangePassword)&&const DeepCollectionEquality().equals(other.moduleAccess, moduleAccess));
}

@JsonKey(includeFromJson: false, includeToJson: false)
@override
int get hashCode => Object.hash(runtimeType,id,email,fullName,role,tenantId,createdByUserId,hostProfileId,screenLockExempt,const DeepCollectionEquality().hash(locationIds),programScope,isServiceAccount,tokenVersion,mustChangePassword,const DeepCollectionEquality().hash(moduleAccess));

@override
String toString() {
  return 'SessionUser(id: $id, email: $email, fullName: $fullName, role: $role, tenantId: $tenantId, createdByUserId: $createdByUserId, hostProfileId: $hostProfileId, screenLockExempt: $screenLockExempt, locationIds: $locationIds, programScope: $programScope, isServiceAccount: $isServiceAccount, tokenVersion: $tokenVersion, mustChangePassword: $mustChangePassword, moduleAccess: $moduleAccess)';
}


}

/// @nodoc
abstract mixin class $SessionUserCopyWith<$Res>  {
  factory $SessionUserCopyWith(SessionUser value, $Res Function(SessionUser) _then) = _$SessionUserCopyWithImpl;
@useResult
$Res call({
 String id, String email, String? fullName, String role, String? tenantId, String? createdByUserId, String? hostProfileId, bool screenLockExempt, List<String>? locationIds, String programScope, bool isServiceAccount, int tokenVersion, bool mustChangePassword, Map<String, bool> moduleAccess
});




}
/// @nodoc
class _$SessionUserCopyWithImpl<$Res>
    implements $SessionUserCopyWith<$Res> {
  _$SessionUserCopyWithImpl(this._self, this._then);

  final SessionUser _self;
  final $Res Function(SessionUser) _then;

/// Create a copy of SessionUser
/// with the given fields replaced by the non-null parameter values.
@pragma('vm:prefer-inline') @override $Res call({Object? id = null,Object? email = null,Object? fullName = freezed,Object? role = null,Object? tenantId = freezed,Object? createdByUserId = freezed,Object? hostProfileId = freezed,Object? screenLockExempt = null,Object? locationIds = freezed,Object? programScope = null,Object? isServiceAccount = null,Object? tokenVersion = null,Object? mustChangePassword = null,Object? moduleAccess = null,}) {
  return _then(_self.copyWith(
id: null == id ? _self.id : id // ignore: cast_nullable_to_non_nullable
as String,email: null == email ? _self.email : email // ignore: cast_nullable_to_non_nullable
as String,fullName: freezed == fullName ? _self.fullName : fullName // ignore: cast_nullable_to_non_nullable
as String?,role: null == role ? _self.role : role // ignore: cast_nullable_to_non_nullable
as String,tenantId: freezed == tenantId ? _self.tenantId : tenantId // ignore: cast_nullable_to_non_nullable
as String?,createdByUserId: freezed == createdByUserId ? _self.createdByUserId : createdByUserId // ignore: cast_nullable_to_non_nullable
as String?,hostProfileId: freezed == hostProfileId ? _self.hostProfileId : hostProfileId // ignore: cast_nullable_to_non_nullable
as String?,screenLockExempt: null == screenLockExempt ? _self.screenLockExempt : screenLockExempt // ignore: cast_nullable_to_non_nullable
as bool,locationIds: freezed == locationIds ? _self.locationIds : locationIds // ignore: cast_nullable_to_non_nullable
as List<String>?,programScope: null == programScope ? _self.programScope : programScope // ignore: cast_nullable_to_non_nullable
as String,isServiceAccount: null == isServiceAccount ? _self.isServiceAccount : isServiceAccount // ignore: cast_nullable_to_non_nullable
as bool,tokenVersion: null == tokenVersion ? _self.tokenVersion : tokenVersion // ignore: cast_nullable_to_non_nullable
as int,mustChangePassword: null == mustChangePassword ? _self.mustChangePassword : mustChangePassword // ignore: cast_nullable_to_non_nullable
as bool,moduleAccess: null == moduleAccess ? _self.moduleAccess : moduleAccess // ignore: cast_nullable_to_non_nullable
as Map<String, bool>,
  ));
}

}


/// Adds pattern-matching-related methods to [SessionUser].
extension SessionUserPatterns on SessionUser {
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

@optionalTypeArgs TResult maybeMap<TResult extends Object?>(TResult Function( _SessionUser value)?  $default,{required TResult orElse(),}){
final _that = this;
switch (_that) {
case _SessionUser() when $default != null:
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

@optionalTypeArgs TResult map<TResult extends Object?>(TResult Function( _SessionUser value)  $default,){
final _that = this;
switch (_that) {
case _SessionUser():
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

@optionalTypeArgs TResult? mapOrNull<TResult extends Object?>(TResult? Function( _SessionUser value)?  $default,){
final _that = this;
switch (_that) {
case _SessionUser() when $default != null:
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

@optionalTypeArgs TResult maybeWhen<TResult extends Object?>(TResult Function( String id,  String email,  String? fullName,  String role,  String? tenantId,  String? createdByUserId,  String? hostProfileId,  bool screenLockExempt,  List<String>? locationIds,  String programScope,  bool isServiceAccount,  int tokenVersion,  bool mustChangePassword,  Map<String, bool> moduleAccess)?  $default,{required TResult orElse(),}) {final _that = this;
switch (_that) {
case _SessionUser() when $default != null:
return $default(_that.id,_that.email,_that.fullName,_that.role,_that.tenantId,_that.createdByUserId,_that.hostProfileId,_that.screenLockExempt,_that.locationIds,_that.programScope,_that.isServiceAccount,_that.tokenVersion,_that.mustChangePassword,_that.moduleAccess);case _:
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

@optionalTypeArgs TResult when<TResult extends Object?>(TResult Function( String id,  String email,  String? fullName,  String role,  String? tenantId,  String? createdByUserId,  String? hostProfileId,  bool screenLockExempt,  List<String>? locationIds,  String programScope,  bool isServiceAccount,  int tokenVersion,  bool mustChangePassword,  Map<String, bool> moduleAccess)  $default,) {final _that = this;
switch (_that) {
case _SessionUser():
return $default(_that.id,_that.email,_that.fullName,_that.role,_that.tenantId,_that.createdByUserId,_that.hostProfileId,_that.screenLockExempt,_that.locationIds,_that.programScope,_that.isServiceAccount,_that.tokenVersion,_that.mustChangePassword,_that.moduleAccess);case _:
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

@optionalTypeArgs TResult? whenOrNull<TResult extends Object?>(TResult? Function( String id,  String email,  String? fullName,  String role,  String? tenantId,  String? createdByUserId,  String? hostProfileId,  bool screenLockExempt,  List<String>? locationIds,  String programScope,  bool isServiceAccount,  int tokenVersion,  bool mustChangePassword,  Map<String, bool> moduleAccess)?  $default,) {final _that = this;
switch (_that) {
case _SessionUser() when $default != null:
return $default(_that.id,_that.email,_that.fullName,_that.role,_that.tenantId,_that.createdByUserId,_that.hostProfileId,_that.screenLockExempt,_that.locationIds,_that.programScope,_that.isServiceAccount,_that.tokenVersion,_that.mustChangePassword,_that.moduleAccess);case _:
  return null;

}
}

}

/// @nodoc
@JsonSerializable()

class _SessionUser extends SessionUser {
  const _SessionUser({required this.id, required this.email, this.fullName, required this.role, this.tenantId, this.createdByUserId, this.hostProfileId, this.screenLockExempt = false, final  List<String>? locationIds, this.programScope = 'BOTH', this.isServiceAccount = false, this.tokenVersion = 0, this.mustChangePassword = false, final  Map<String, bool> moduleAccess = const <String, bool>{}}): _locationIds = locationIds,_moduleAccess = moduleAccess,super._();
  factory _SessionUser.fromJson(Map<String, dynamic> json) => _$SessionUserFromJson(json);

@override final  String id;
@override final  String email;
@override final  String? fullName;
@override final  String role;
@override final  String? tenantId;
@override final  String? createdByUserId;
@override final  String? hostProfileId;
@override@JsonKey() final  bool screenLockExempt;
/// `null` = TODAS las ubicaciones (usuario UNRESTRICTED). El backend
/// normaliza lista vacía a null (parseLocationIds, auth.service.js:78-85).
 final  List<String>? _locationIds;
/// `null` = TODAS las ubicaciones (usuario UNRESTRICTED). El backend
/// normaliza lista vacía a null (parseLocationIds, auth.service.js:78-85).
@override List<String>? get locationIds {
  final value = _locationIds;
  if (value == null) return null;
  if (_locationIds is EqualUnmodifiableListView) return _locationIds;
  // ignore: implicit_dynamic_type
  return EqualUnmodifiableListView(value);
}

@override@JsonKey() final  String programScope;
@override@JsonKey() final  bool isServiceAccount;
@override@JsonKey() final  int tokenVersion;
/// true → la sesión solo alcanza change-password/me/refresh; todo lo
/// demás 403 PASSWORD_CHANGE_REQUIRED. La app rutea a la pantalla de
/// cambio forzado (M1).
@override@JsonKey() final  bool mustChangePassword;
/// Mapa booleano sobre los 21 MODULE_KEYS (lib/module-access.js:6-47).
/// `paymentActions` es el que gobierna los botones de dinero en M2.
 final  Map<String, bool> _moduleAccess;
/// Mapa booleano sobre los 21 MODULE_KEYS (lib/module-access.js:6-47).
/// `paymentActions` es el que gobierna los botones de dinero en M2.
@override@JsonKey() Map<String, bool> get moduleAccess {
  if (_moduleAccess is EqualUnmodifiableMapView) return _moduleAccess;
  // ignore: implicit_dynamic_type
  return EqualUnmodifiableMapView(_moduleAccess);
}


/// Create a copy of SessionUser
/// with the given fields replaced by the non-null parameter values.
@override @JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
_$SessionUserCopyWith<_SessionUser> get copyWith => __$SessionUserCopyWithImpl<_SessionUser>(this, _$identity);

@override
Map<String, dynamic> toJson() {
  return _$SessionUserToJson(this, );
}

@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is _SessionUser&&(identical(other.id, id) || other.id == id)&&(identical(other.email, email) || other.email == email)&&(identical(other.fullName, fullName) || other.fullName == fullName)&&(identical(other.role, role) || other.role == role)&&(identical(other.tenantId, tenantId) || other.tenantId == tenantId)&&(identical(other.createdByUserId, createdByUserId) || other.createdByUserId == createdByUserId)&&(identical(other.hostProfileId, hostProfileId) || other.hostProfileId == hostProfileId)&&(identical(other.screenLockExempt, screenLockExempt) || other.screenLockExempt == screenLockExempt)&&const DeepCollectionEquality().equals(other._locationIds, _locationIds)&&(identical(other.programScope, programScope) || other.programScope == programScope)&&(identical(other.isServiceAccount, isServiceAccount) || other.isServiceAccount == isServiceAccount)&&(identical(other.tokenVersion, tokenVersion) || other.tokenVersion == tokenVersion)&&(identical(other.mustChangePassword, mustChangePassword) || other.mustChangePassword == mustChangePassword)&&const DeepCollectionEquality().equals(other._moduleAccess, _moduleAccess));
}

@JsonKey(includeFromJson: false, includeToJson: false)
@override
int get hashCode => Object.hash(runtimeType,id,email,fullName,role,tenantId,createdByUserId,hostProfileId,screenLockExempt,const DeepCollectionEquality().hash(_locationIds),programScope,isServiceAccount,tokenVersion,mustChangePassword,const DeepCollectionEquality().hash(_moduleAccess));

@override
String toString() {
  return 'SessionUser(id: $id, email: $email, fullName: $fullName, role: $role, tenantId: $tenantId, createdByUserId: $createdByUserId, hostProfileId: $hostProfileId, screenLockExempt: $screenLockExempt, locationIds: $locationIds, programScope: $programScope, isServiceAccount: $isServiceAccount, tokenVersion: $tokenVersion, mustChangePassword: $mustChangePassword, moduleAccess: $moduleAccess)';
}


}

/// @nodoc
abstract mixin class _$SessionUserCopyWith<$Res> implements $SessionUserCopyWith<$Res> {
  factory _$SessionUserCopyWith(_SessionUser value, $Res Function(_SessionUser) _then) = __$SessionUserCopyWithImpl;
@override @useResult
$Res call({
 String id, String email, String? fullName, String role, String? tenantId, String? createdByUserId, String? hostProfileId, bool screenLockExempt, List<String>? locationIds, String programScope, bool isServiceAccount, int tokenVersion, bool mustChangePassword, Map<String, bool> moduleAccess
});




}
/// @nodoc
class __$SessionUserCopyWithImpl<$Res>
    implements _$SessionUserCopyWith<$Res> {
  __$SessionUserCopyWithImpl(this._self, this._then);

  final _SessionUser _self;
  final $Res Function(_SessionUser) _then;

/// Create a copy of SessionUser
/// with the given fields replaced by the non-null parameter values.
@override @pragma('vm:prefer-inline') $Res call({Object? id = null,Object? email = null,Object? fullName = freezed,Object? role = null,Object? tenantId = freezed,Object? createdByUserId = freezed,Object? hostProfileId = freezed,Object? screenLockExempt = null,Object? locationIds = freezed,Object? programScope = null,Object? isServiceAccount = null,Object? tokenVersion = null,Object? mustChangePassword = null,Object? moduleAccess = null,}) {
  return _then(_SessionUser(
id: null == id ? _self.id : id // ignore: cast_nullable_to_non_nullable
as String,email: null == email ? _self.email : email // ignore: cast_nullable_to_non_nullable
as String,fullName: freezed == fullName ? _self.fullName : fullName // ignore: cast_nullable_to_non_nullable
as String?,role: null == role ? _self.role : role // ignore: cast_nullable_to_non_nullable
as String,tenantId: freezed == tenantId ? _self.tenantId : tenantId // ignore: cast_nullable_to_non_nullable
as String?,createdByUserId: freezed == createdByUserId ? _self.createdByUserId : createdByUserId // ignore: cast_nullable_to_non_nullable
as String?,hostProfileId: freezed == hostProfileId ? _self.hostProfileId : hostProfileId // ignore: cast_nullable_to_non_nullable
as String?,screenLockExempt: null == screenLockExempt ? _self.screenLockExempt : screenLockExempt // ignore: cast_nullable_to_non_nullable
as bool,locationIds: freezed == locationIds ? _self._locationIds : locationIds // ignore: cast_nullable_to_non_nullable
as List<String>?,programScope: null == programScope ? _self.programScope : programScope // ignore: cast_nullable_to_non_nullable
as String,isServiceAccount: null == isServiceAccount ? _self.isServiceAccount : isServiceAccount // ignore: cast_nullable_to_non_nullable
as bool,tokenVersion: null == tokenVersion ? _self.tokenVersion : tokenVersion // ignore: cast_nullable_to_non_nullable
as int,mustChangePassword: null == mustChangePassword ? _self.mustChangePassword : mustChangePassword // ignore: cast_nullable_to_non_nullable
as bool,moduleAccess: null == moduleAccess ? _self._moduleAccess : moduleAccess // ignore: cast_nullable_to_non_nullable
as Map<String, bool>,
  ));
}


}


/// @nodoc
mixin _$AuthResponse {

 String get token; SessionUser get user;
/// Create a copy of AuthResponse
/// with the given fields replaced by the non-null parameter values.
@JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
$AuthResponseCopyWith<AuthResponse> get copyWith => _$AuthResponseCopyWithImpl<AuthResponse>(this as AuthResponse, _$identity);

  /// Serializes this AuthResponse to a JSON map.
  Map<String, dynamic> toJson();


@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is AuthResponse&&(identical(other.token, token) || other.token == token)&&(identical(other.user, user) || other.user == user));
}

@JsonKey(includeFromJson: false, includeToJson: false)
@override
int get hashCode => Object.hash(runtimeType,token,user);

@override
String toString() {
  return 'AuthResponse(token: $token, user: $user)';
}


}

/// @nodoc
abstract mixin class $AuthResponseCopyWith<$Res>  {
  factory $AuthResponseCopyWith(AuthResponse value, $Res Function(AuthResponse) _then) = _$AuthResponseCopyWithImpl;
@useResult
$Res call({
 String token, SessionUser user
});


$SessionUserCopyWith<$Res> get user;

}
/// @nodoc
class _$AuthResponseCopyWithImpl<$Res>
    implements $AuthResponseCopyWith<$Res> {
  _$AuthResponseCopyWithImpl(this._self, this._then);

  final AuthResponse _self;
  final $Res Function(AuthResponse) _then;

/// Create a copy of AuthResponse
/// with the given fields replaced by the non-null parameter values.
@pragma('vm:prefer-inline') @override $Res call({Object? token = null,Object? user = null,}) {
  return _then(_self.copyWith(
token: null == token ? _self.token : token // ignore: cast_nullable_to_non_nullable
as String,user: null == user ? _self.user : user // ignore: cast_nullable_to_non_nullable
as SessionUser,
  ));
}
/// Create a copy of AuthResponse
/// with the given fields replaced by the non-null parameter values.
@override
@pragma('vm:prefer-inline')
$SessionUserCopyWith<$Res> get user {
  
  return $SessionUserCopyWith<$Res>(_self.user, (value) {
    return _then(_self.copyWith(user: value));
  });
}
}


/// Adds pattern-matching-related methods to [AuthResponse].
extension AuthResponsePatterns on AuthResponse {
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

@optionalTypeArgs TResult maybeMap<TResult extends Object?>(TResult Function( _AuthResponse value)?  $default,{required TResult orElse(),}){
final _that = this;
switch (_that) {
case _AuthResponse() when $default != null:
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

@optionalTypeArgs TResult map<TResult extends Object?>(TResult Function( _AuthResponse value)  $default,){
final _that = this;
switch (_that) {
case _AuthResponse():
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

@optionalTypeArgs TResult? mapOrNull<TResult extends Object?>(TResult? Function( _AuthResponse value)?  $default,){
final _that = this;
switch (_that) {
case _AuthResponse() when $default != null:
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

@optionalTypeArgs TResult maybeWhen<TResult extends Object?>(TResult Function( String token,  SessionUser user)?  $default,{required TResult orElse(),}) {final _that = this;
switch (_that) {
case _AuthResponse() when $default != null:
return $default(_that.token,_that.user);case _:
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

@optionalTypeArgs TResult when<TResult extends Object?>(TResult Function( String token,  SessionUser user)  $default,) {final _that = this;
switch (_that) {
case _AuthResponse():
return $default(_that.token,_that.user);case _:
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

@optionalTypeArgs TResult? whenOrNull<TResult extends Object?>(TResult? Function( String token,  SessionUser user)?  $default,) {final _that = this;
switch (_that) {
case _AuthResponse() when $default != null:
return $default(_that.token,_that.user);case _:
  return null;

}
}

}

/// @nodoc
@JsonSerializable()

class _AuthResponse implements AuthResponse {
  const _AuthResponse({required this.token, required this.user});
  factory _AuthResponse.fromJson(Map<String, dynamic> json) => _$AuthResponseFromJson(json);

@override final  String token;
@override final  SessionUser user;

/// Create a copy of AuthResponse
/// with the given fields replaced by the non-null parameter values.
@override @JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
_$AuthResponseCopyWith<_AuthResponse> get copyWith => __$AuthResponseCopyWithImpl<_AuthResponse>(this, _$identity);

@override
Map<String, dynamic> toJson() {
  return _$AuthResponseToJson(this, );
}

@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is _AuthResponse&&(identical(other.token, token) || other.token == token)&&(identical(other.user, user) || other.user == user));
}

@JsonKey(includeFromJson: false, includeToJson: false)
@override
int get hashCode => Object.hash(runtimeType,token,user);

@override
String toString() {
  return 'AuthResponse(token: $token, user: $user)';
}


}

/// @nodoc
abstract mixin class _$AuthResponseCopyWith<$Res> implements $AuthResponseCopyWith<$Res> {
  factory _$AuthResponseCopyWith(_AuthResponse value, $Res Function(_AuthResponse) _then) = __$AuthResponseCopyWithImpl;
@override @useResult
$Res call({
 String token, SessionUser user
});


@override $SessionUserCopyWith<$Res> get user;

}
/// @nodoc
class __$AuthResponseCopyWithImpl<$Res>
    implements _$AuthResponseCopyWith<$Res> {
  __$AuthResponseCopyWithImpl(this._self, this._then);

  final _AuthResponse _self;
  final $Res Function(_AuthResponse) _then;

/// Create a copy of AuthResponse
/// with the given fields replaced by the non-null parameter values.
@override @pragma('vm:prefer-inline') $Res call({Object? token = null,Object? user = null,}) {
  return _then(_AuthResponse(
token: null == token ? _self.token : token // ignore: cast_nullable_to_non_nullable
as String,user: null == user ? _self.user : user // ignore: cast_nullable_to_non_nullable
as SessionUser,
  ));
}

/// Create a copy of AuthResponse
/// with the given fields replaced by the non-null parameter values.
@override
@pragma('vm:prefer-inline')
$SessionUserCopyWith<$Res> get user {
  
  return $SessionUserCopyWith<$Res>(_self.user, (value) {
    return _then(_self.copyWith(user: value));
  });
}
}

// dart format on
