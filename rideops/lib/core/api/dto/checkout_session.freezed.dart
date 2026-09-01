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
 String? get events;@IsoDateTimeConverter() DateTime? get tcCompletedAt;@IsoDateTimeConverter() DateTime? get paymentCompletedAt;@IsoDateTimeConverter() DateTime? get inspectionCompletedAt;@IsoDateTimeConverter() DateTime? get customerSignedAt;@IsoDateTimeConverter() DateTime? get startedAt;@IsoDateTimeConverter() DateTime? get finishedAt;@IsoDateTimeConverter() DateTime? get abandonedAt; String? get abandonedReason;@IsoDateTimeConverter() DateTime? get autoEmailedAt; String? get startedByUserId;/// Versión optimista de la fila (M2 P2). Se lee para FENCING de
/// respuestas: una lectura que llega tarde con versión MENOR que la ya
/// aplicada es un fantasma del pasado y se descarta (INN MC-2). No se
/// ENVÍA `expectedVersion` todavía — eso es opt-in y aterriza con M2-H6.
///
/// Null con backend viejo (columna inexistente) ⇒ el fence cae al
/// contador local de escrituras, que no depende del servidor.
 int? get stateVersion;/// Presencia suave de las otras superficies (M2 P1 —
/// `checkout-presence.service.js` `withPresence()`, adjunta el campo en
/// `GET /:id` y `GET /by-reservation/:rid`).
///
/// **La presencia solo puede afirmar PRESENCIA, jamás SOLEDAD.** Tres
/// estados, dos de ellos indistinguibles a propósito:
///  - `null`: este backend no emite el campo (P1 sin desplegar), o la
///    respuesta no pasó por `withPresence()` — los POST de transición y
///    abandon NO pasan.
///  - `[]`: el campo vino vacío… lo que puede significar "nadie dentro
///    del TTL de 45 s" **o** que la lectura de presencia falló y
///    `withPresence()` degradó a `[]` (es best-effort por contrato).
///  - lista con filas: lo ÚNICO que la app puede afirmar.
/// Por eso el campo es opcional, jamás tiene default, y la UI nunca dice
/// "estás solo en esta sesión".
 List<CheckoutPresenceDto>? get presence;
/// Create a copy of CheckoutSessionDto
/// with the given fields replaced by the non-null parameter values.
@JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
$CheckoutSessionDtoCopyWith<CheckoutSessionDto> get copyWith => _$CheckoutSessionDtoCopyWithImpl<CheckoutSessionDto>(this as CheckoutSessionDto, _$identity);

  /// Serializes this CheckoutSessionDto to a JSON map.
  Map<String, dynamic> toJson();


@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is CheckoutSessionDto&&(identical(other.id, id) || other.id == id)&&(identical(other.reservationId, reservationId) || other.reservationId == reservationId)&&(identical(other.agreementId, agreementId) || other.agreementId == agreementId)&&(identical(other.tenantId, tenantId) || other.tenantId == tenantId)&&(identical(other.currentStep, currentStep) || other.currentStep == currentStep)&&(identical(other.events, events) || other.events == events)&&(identical(other.tcCompletedAt, tcCompletedAt) || other.tcCompletedAt == tcCompletedAt)&&(identical(other.paymentCompletedAt, paymentCompletedAt) || other.paymentCompletedAt == paymentCompletedAt)&&(identical(other.inspectionCompletedAt, inspectionCompletedAt) || other.inspectionCompletedAt == inspectionCompletedAt)&&(identical(other.customerSignedAt, customerSignedAt) || other.customerSignedAt == customerSignedAt)&&(identical(other.startedAt, startedAt) || other.startedAt == startedAt)&&(identical(other.finishedAt, finishedAt) || other.finishedAt == finishedAt)&&(identical(other.abandonedAt, abandonedAt) || other.abandonedAt == abandonedAt)&&(identical(other.abandonedReason, abandonedReason) || other.abandonedReason == abandonedReason)&&(identical(other.autoEmailedAt, autoEmailedAt) || other.autoEmailedAt == autoEmailedAt)&&(identical(other.startedByUserId, startedByUserId) || other.startedByUserId == startedByUserId)&&(identical(other.stateVersion, stateVersion) || other.stateVersion == stateVersion)&&const DeepCollectionEquality().equals(other.presence, presence));
}

@JsonKey(includeFromJson: false, includeToJson: false)
@override
int get hashCode => Object.hash(runtimeType,id,reservationId,agreementId,tenantId,currentStep,events,tcCompletedAt,paymentCompletedAt,inspectionCompletedAt,customerSignedAt,startedAt,finishedAt,abandonedAt,abandonedReason,autoEmailedAt,startedByUserId,stateVersion,const DeepCollectionEquality().hash(presence));

@override
String toString() {
  return 'CheckoutSessionDto(id: $id, reservationId: $reservationId, agreementId: $agreementId, tenantId: $tenantId, currentStep: $currentStep, events: $events, tcCompletedAt: $tcCompletedAt, paymentCompletedAt: $paymentCompletedAt, inspectionCompletedAt: $inspectionCompletedAt, customerSignedAt: $customerSignedAt, startedAt: $startedAt, finishedAt: $finishedAt, abandonedAt: $abandonedAt, abandonedReason: $abandonedReason, autoEmailedAt: $autoEmailedAt, startedByUserId: $startedByUserId, stateVersion: $stateVersion, presence: $presence)';
}


}

/// @nodoc
abstract mixin class $CheckoutSessionDtoCopyWith<$Res>  {
  factory $CheckoutSessionDtoCopyWith(CheckoutSessionDto value, $Res Function(CheckoutSessionDto) _then) = _$CheckoutSessionDtoCopyWithImpl;
@useResult
$Res call({
 String id, String reservationId, String? agreementId, String? tenantId, String currentStep, String? events,@IsoDateTimeConverter() DateTime? tcCompletedAt,@IsoDateTimeConverter() DateTime? paymentCompletedAt,@IsoDateTimeConverter() DateTime? inspectionCompletedAt,@IsoDateTimeConverter() DateTime? customerSignedAt,@IsoDateTimeConverter() DateTime? startedAt,@IsoDateTimeConverter() DateTime? finishedAt,@IsoDateTimeConverter() DateTime? abandonedAt, String? abandonedReason,@IsoDateTimeConverter() DateTime? autoEmailedAt, String? startedByUserId, int? stateVersion, List<CheckoutPresenceDto>? presence
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
@pragma('vm:prefer-inline') @override $Res call({Object? id = null,Object? reservationId = null,Object? agreementId = freezed,Object? tenantId = freezed,Object? currentStep = null,Object? events = freezed,Object? tcCompletedAt = freezed,Object? paymentCompletedAt = freezed,Object? inspectionCompletedAt = freezed,Object? customerSignedAt = freezed,Object? startedAt = freezed,Object? finishedAt = freezed,Object? abandonedAt = freezed,Object? abandonedReason = freezed,Object? autoEmailedAt = freezed,Object? startedByUserId = freezed,Object? stateVersion = freezed,Object? presence = freezed,}) {
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
as String?,stateVersion: freezed == stateVersion ? _self.stateVersion : stateVersion // ignore: cast_nullable_to_non_nullable
as int?,presence: freezed == presence ? _self.presence : presence // ignore: cast_nullable_to_non_nullable
as List<CheckoutPresenceDto>?,
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

@optionalTypeArgs TResult maybeWhen<TResult extends Object?>(TResult Function( String id,  String reservationId,  String? agreementId,  String? tenantId,  String currentStep,  String? events, @IsoDateTimeConverter()  DateTime? tcCompletedAt, @IsoDateTimeConverter()  DateTime? paymentCompletedAt, @IsoDateTimeConverter()  DateTime? inspectionCompletedAt, @IsoDateTimeConverter()  DateTime? customerSignedAt, @IsoDateTimeConverter()  DateTime? startedAt, @IsoDateTimeConverter()  DateTime? finishedAt, @IsoDateTimeConverter()  DateTime? abandonedAt,  String? abandonedReason, @IsoDateTimeConverter()  DateTime? autoEmailedAt,  String? startedByUserId,  int? stateVersion,  List<CheckoutPresenceDto>? presence)?  $default,{required TResult orElse(),}) {final _that = this;
switch (_that) {
case _CheckoutSessionDto() when $default != null:
return $default(_that.id,_that.reservationId,_that.agreementId,_that.tenantId,_that.currentStep,_that.events,_that.tcCompletedAt,_that.paymentCompletedAt,_that.inspectionCompletedAt,_that.customerSignedAt,_that.startedAt,_that.finishedAt,_that.abandonedAt,_that.abandonedReason,_that.autoEmailedAt,_that.startedByUserId,_that.stateVersion,_that.presence);case _:
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

@optionalTypeArgs TResult when<TResult extends Object?>(TResult Function( String id,  String reservationId,  String? agreementId,  String? tenantId,  String currentStep,  String? events, @IsoDateTimeConverter()  DateTime? tcCompletedAt, @IsoDateTimeConverter()  DateTime? paymentCompletedAt, @IsoDateTimeConverter()  DateTime? inspectionCompletedAt, @IsoDateTimeConverter()  DateTime? customerSignedAt, @IsoDateTimeConverter()  DateTime? startedAt, @IsoDateTimeConverter()  DateTime? finishedAt, @IsoDateTimeConverter()  DateTime? abandonedAt,  String? abandonedReason, @IsoDateTimeConverter()  DateTime? autoEmailedAt,  String? startedByUserId,  int? stateVersion,  List<CheckoutPresenceDto>? presence)  $default,) {final _that = this;
switch (_that) {
case _CheckoutSessionDto():
return $default(_that.id,_that.reservationId,_that.agreementId,_that.tenantId,_that.currentStep,_that.events,_that.tcCompletedAt,_that.paymentCompletedAt,_that.inspectionCompletedAt,_that.customerSignedAt,_that.startedAt,_that.finishedAt,_that.abandonedAt,_that.abandonedReason,_that.autoEmailedAt,_that.startedByUserId,_that.stateVersion,_that.presence);case _:
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

@optionalTypeArgs TResult? whenOrNull<TResult extends Object?>(TResult? Function( String id,  String reservationId,  String? agreementId,  String? tenantId,  String currentStep,  String? events, @IsoDateTimeConverter()  DateTime? tcCompletedAt, @IsoDateTimeConverter()  DateTime? paymentCompletedAt, @IsoDateTimeConverter()  DateTime? inspectionCompletedAt, @IsoDateTimeConverter()  DateTime? customerSignedAt, @IsoDateTimeConverter()  DateTime? startedAt, @IsoDateTimeConverter()  DateTime? finishedAt, @IsoDateTimeConverter()  DateTime? abandonedAt,  String? abandonedReason, @IsoDateTimeConverter()  DateTime? autoEmailedAt,  String? startedByUserId,  int? stateVersion,  List<CheckoutPresenceDto>? presence)?  $default,) {final _that = this;
switch (_that) {
case _CheckoutSessionDto() when $default != null:
return $default(_that.id,_that.reservationId,_that.agreementId,_that.tenantId,_that.currentStep,_that.events,_that.tcCompletedAt,_that.paymentCompletedAt,_that.inspectionCompletedAt,_that.customerSignedAt,_that.startedAt,_that.finishedAt,_that.abandonedAt,_that.abandonedReason,_that.autoEmailedAt,_that.startedByUserId,_that.stateVersion,_that.presence);case _:
  return null;

}
}

}

/// @nodoc
@JsonSerializable()

class _CheckoutSessionDto extends CheckoutSessionDto {
  const _CheckoutSessionDto({required this.id, required this.reservationId, this.agreementId, this.tenantId, required this.currentStep, this.events, @IsoDateTimeConverter() this.tcCompletedAt, @IsoDateTimeConverter() this.paymentCompletedAt, @IsoDateTimeConverter() this.inspectionCompletedAt, @IsoDateTimeConverter() this.customerSignedAt, @IsoDateTimeConverter() this.startedAt, @IsoDateTimeConverter() this.finishedAt, @IsoDateTimeConverter() this.abandonedAt, this.abandonedReason, @IsoDateTimeConverter() this.autoEmailedAt, this.startedByUserId, this.stateVersion, final  List<CheckoutPresenceDto>? presence}): _presence = presence,super._();
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
/// Versión optimista de la fila (M2 P2). Se lee para FENCING de
/// respuestas: una lectura que llega tarde con versión MENOR que la ya
/// aplicada es un fantasma del pasado y se descarta (INN MC-2). No se
/// ENVÍA `expectedVersion` todavía — eso es opt-in y aterriza con M2-H6.
///
/// Null con backend viejo (columna inexistente) ⇒ el fence cae al
/// contador local de escrituras, que no depende del servidor.
@override final  int? stateVersion;
/// Presencia suave de las otras superficies (M2 P1 —
/// `checkout-presence.service.js` `withPresence()`, adjunta el campo en
/// `GET /:id` y `GET /by-reservation/:rid`).
///
/// **La presencia solo puede afirmar PRESENCIA, jamás SOLEDAD.** Tres
/// estados, dos de ellos indistinguibles a propósito:
///  - `null`: este backend no emite el campo (P1 sin desplegar), o la
///    respuesta no pasó por `withPresence()` — los POST de transición y
///    abandon NO pasan.
///  - `[]`: el campo vino vacío… lo que puede significar "nadie dentro
///    del TTL de 45 s" **o** que la lectura de presencia falló y
///    `withPresence()` degradó a `[]` (es best-effort por contrato).
///  - lista con filas: lo ÚNICO que la app puede afirmar.
/// Por eso el campo es opcional, jamás tiene default, y la UI nunca dice
/// "estás solo en esta sesión".
 final  List<CheckoutPresenceDto>? _presence;
/// Presencia suave de las otras superficies (M2 P1 —
/// `checkout-presence.service.js` `withPresence()`, adjunta el campo en
/// `GET /:id` y `GET /by-reservation/:rid`).
///
/// **La presencia solo puede afirmar PRESENCIA, jamás SOLEDAD.** Tres
/// estados, dos de ellos indistinguibles a propósito:
///  - `null`: este backend no emite el campo (P1 sin desplegar), o la
///    respuesta no pasó por `withPresence()` — los POST de transición y
///    abandon NO pasan.
///  - `[]`: el campo vino vacío… lo que puede significar "nadie dentro
///    del TTL de 45 s" **o** que la lectura de presencia falló y
///    `withPresence()` degradó a `[]` (es best-effort por contrato).
///  - lista con filas: lo ÚNICO que la app puede afirmar.
/// Por eso el campo es opcional, jamás tiene default, y la UI nunca dice
/// "estás solo en esta sesión".
@override List<CheckoutPresenceDto>? get presence {
  final value = _presence;
  if (value == null) return null;
  if (_presence is EqualUnmodifiableListView) return _presence;
  // ignore: implicit_dynamic_type
  return EqualUnmodifiableListView(value);
}


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
  return identical(this, other) || (other.runtimeType == runtimeType&&other is _CheckoutSessionDto&&(identical(other.id, id) || other.id == id)&&(identical(other.reservationId, reservationId) || other.reservationId == reservationId)&&(identical(other.agreementId, agreementId) || other.agreementId == agreementId)&&(identical(other.tenantId, tenantId) || other.tenantId == tenantId)&&(identical(other.currentStep, currentStep) || other.currentStep == currentStep)&&(identical(other.events, events) || other.events == events)&&(identical(other.tcCompletedAt, tcCompletedAt) || other.tcCompletedAt == tcCompletedAt)&&(identical(other.paymentCompletedAt, paymentCompletedAt) || other.paymentCompletedAt == paymentCompletedAt)&&(identical(other.inspectionCompletedAt, inspectionCompletedAt) || other.inspectionCompletedAt == inspectionCompletedAt)&&(identical(other.customerSignedAt, customerSignedAt) || other.customerSignedAt == customerSignedAt)&&(identical(other.startedAt, startedAt) || other.startedAt == startedAt)&&(identical(other.finishedAt, finishedAt) || other.finishedAt == finishedAt)&&(identical(other.abandonedAt, abandonedAt) || other.abandonedAt == abandonedAt)&&(identical(other.abandonedReason, abandonedReason) || other.abandonedReason == abandonedReason)&&(identical(other.autoEmailedAt, autoEmailedAt) || other.autoEmailedAt == autoEmailedAt)&&(identical(other.startedByUserId, startedByUserId) || other.startedByUserId == startedByUserId)&&(identical(other.stateVersion, stateVersion) || other.stateVersion == stateVersion)&&const DeepCollectionEquality().equals(other._presence, _presence));
}

@JsonKey(includeFromJson: false, includeToJson: false)
@override
int get hashCode => Object.hash(runtimeType,id,reservationId,agreementId,tenantId,currentStep,events,tcCompletedAt,paymentCompletedAt,inspectionCompletedAt,customerSignedAt,startedAt,finishedAt,abandonedAt,abandonedReason,autoEmailedAt,startedByUserId,stateVersion,const DeepCollectionEquality().hash(_presence));

@override
String toString() {
  return 'CheckoutSessionDto(id: $id, reservationId: $reservationId, agreementId: $agreementId, tenantId: $tenantId, currentStep: $currentStep, events: $events, tcCompletedAt: $tcCompletedAt, paymentCompletedAt: $paymentCompletedAt, inspectionCompletedAt: $inspectionCompletedAt, customerSignedAt: $customerSignedAt, startedAt: $startedAt, finishedAt: $finishedAt, abandonedAt: $abandonedAt, abandonedReason: $abandonedReason, autoEmailedAt: $autoEmailedAt, startedByUserId: $startedByUserId, stateVersion: $stateVersion, presence: $presence)';
}


}

/// @nodoc
abstract mixin class _$CheckoutSessionDtoCopyWith<$Res> implements $CheckoutSessionDtoCopyWith<$Res> {
  factory _$CheckoutSessionDtoCopyWith(_CheckoutSessionDto value, $Res Function(_CheckoutSessionDto) _then) = __$CheckoutSessionDtoCopyWithImpl;
@override @useResult
$Res call({
 String id, String reservationId, String? agreementId, String? tenantId, String currentStep, String? events,@IsoDateTimeConverter() DateTime? tcCompletedAt,@IsoDateTimeConverter() DateTime? paymentCompletedAt,@IsoDateTimeConverter() DateTime? inspectionCompletedAt,@IsoDateTimeConverter() DateTime? customerSignedAt,@IsoDateTimeConverter() DateTime? startedAt,@IsoDateTimeConverter() DateTime? finishedAt,@IsoDateTimeConverter() DateTime? abandonedAt, String? abandonedReason,@IsoDateTimeConverter() DateTime? autoEmailedAt, String? startedByUserId, int? stateVersion, List<CheckoutPresenceDto>? presence
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
@override @pragma('vm:prefer-inline') $Res call({Object? id = null,Object? reservationId = null,Object? agreementId = freezed,Object? tenantId = freezed,Object? currentStep = null,Object? events = freezed,Object? tcCompletedAt = freezed,Object? paymentCompletedAt = freezed,Object? inspectionCompletedAt = freezed,Object? customerSignedAt = freezed,Object? startedAt = freezed,Object? finishedAt = freezed,Object? abandonedAt = freezed,Object? abandonedReason = freezed,Object? autoEmailedAt = freezed,Object? startedByUserId = freezed,Object? stateVersion = freezed,Object? presence = freezed,}) {
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
as String?,stateVersion: freezed == stateVersion ? _self.stateVersion : stateVersion // ignore: cast_nullable_to_non_nullable
as int?,presence: freezed == presence ? _self._presence : presence // ignore: cast_nullable_to_non_nullable
as List<CheckoutPresenceDto>?,
  ));
}


}


/// @nodoc
mixin _$VehicleSwapResult {

 String get sessionId; String? get fromVehicleId; String? get toVehicleId; CheckoutSessionDto get session;
/// Create a copy of VehicleSwapResult
/// with the given fields replaced by the non-null parameter values.
@JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
$VehicleSwapResultCopyWith<VehicleSwapResult> get copyWith => _$VehicleSwapResultCopyWithImpl<VehicleSwapResult>(this as VehicleSwapResult, _$identity);

  /// Serializes this VehicleSwapResult to a JSON map.
  Map<String, dynamic> toJson();


@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is VehicleSwapResult&&(identical(other.sessionId, sessionId) || other.sessionId == sessionId)&&(identical(other.fromVehicleId, fromVehicleId) || other.fromVehicleId == fromVehicleId)&&(identical(other.toVehicleId, toVehicleId) || other.toVehicleId == toVehicleId)&&(identical(other.session, session) || other.session == session));
}

@JsonKey(includeFromJson: false, includeToJson: false)
@override
int get hashCode => Object.hash(runtimeType,sessionId,fromVehicleId,toVehicleId,session);

@override
String toString() {
  return 'VehicleSwapResult(sessionId: $sessionId, fromVehicleId: $fromVehicleId, toVehicleId: $toVehicleId, session: $session)';
}


}

/// @nodoc
abstract mixin class $VehicleSwapResultCopyWith<$Res>  {
  factory $VehicleSwapResultCopyWith(VehicleSwapResult value, $Res Function(VehicleSwapResult) _then) = _$VehicleSwapResultCopyWithImpl;
@useResult
$Res call({
 String sessionId, String? fromVehicleId, String? toVehicleId, CheckoutSessionDto session
});


$CheckoutSessionDtoCopyWith<$Res> get session;

}
/// @nodoc
class _$VehicleSwapResultCopyWithImpl<$Res>
    implements $VehicleSwapResultCopyWith<$Res> {
  _$VehicleSwapResultCopyWithImpl(this._self, this._then);

  final VehicleSwapResult _self;
  final $Res Function(VehicleSwapResult) _then;

/// Create a copy of VehicleSwapResult
/// with the given fields replaced by the non-null parameter values.
@pragma('vm:prefer-inline') @override $Res call({Object? sessionId = null,Object? fromVehicleId = freezed,Object? toVehicleId = freezed,Object? session = null,}) {
  return _then(_self.copyWith(
sessionId: null == sessionId ? _self.sessionId : sessionId // ignore: cast_nullable_to_non_nullable
as String,fromVehicleId: freezed == fromVehicleId ? _self.fromVehicleId : fromVehicleId // ignore: cast_nullable_to_non_nullable
as String?,toVehicleId: freezed == toVehicleId ? _self.toVehicleId : toVehicleId // ignore: cast_nullable_to_non_nullable
as String?,session: null == session ? _self.session : session // ignore: cast_nullable_to_non_nullable
as CheckoutSessionDto,
  ));
}
/// Create a copy of VehicleSwapResult
/// with the given fields replaced by the non-null parameter values.
@override
@pragma('vm:prefer-inline')
$CheckoutSessionDtoCopyWith<$Res> get session {
  
  return $CheckoutSessionDtoCopyWith<$Res>(_self.session, (value) {
    return _then(_self.copyWith(session: value));
  });
}
}


/// Adds pattern-matching-related methods to [VehicleSwapResult].
extension VehicleSwapResultPatterns on VehicleSwapResult {
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

@optionalTypeArgs TResult maybeMap<TResult extends Object?>(TResult Function( _VehicleSwapResult value)?  $default,{required TResult orElse(),}){
final _that = this;
switch (_that) {
case _VehicleSwapResult() when $default != null:
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

@optionalTypeArgs TResult map<TResult extends Object?>(TResult Function( _VehicleSwapResult value)  $default,){
final _that = this;
switch (_that) {
case _VehicleSwapResult():
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

@optionalTypeArgs TResult? mapOrNull<TResult extends Object?>(TResult? Function( _VehicleSwapResult value)?  $default,){
final _that = this;
switch (_that) {
case _VehicleSwapResult() when $default != null:
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

@optionalTypeArgs TResult maybeWhen<TResult extends Object?>(TResult Function( String sessionId,  String? fromVehicleId,  String? toVehicleId,  CheckoutSessionDto session)?  $default,{required TResult orElse(),}) {final _that = this;
switch (_that) {
case _VehicleSwapResult() when $default != null:
return $default(_that.sessionId,_that.fromVehicleId,_that.toVehicleId,_that.session);case _:
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

@optionalTypeArgs TResult when<TResult extends Object?>(TResult Function( String sessionId,  String? fromVehicleId,  String? toVehicleId,  CheckoutSessionDto session)  $default,) {final _that = this;
switch (_that) {
case _VehicleSwapResult():
return $default(_that.sessionId,_that.fromVehicleId,_that.toVehicleId,_that.session);case _:
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

@optionalTypeArgs TResult? whenOrNull<TResult extends Object?>(TResult? Function( String sessionId,  String? fromVehicleId,  String? toVehicleId,  CheckoutSessionDto session)?  $default,) {final _that = this;
switch (_that) {
case _VehicleSwapResult() when $default != null:
return $default(_that.sessionId,_that.fromVehicleId,_that.toVehicleId,_that.session);case _:
  return null;

}
}

}

/// @nodoc
@JsonSerializable()

class _VehicleSwapResult implements VehicleSwapResult {
  const _VehicleSwapResult({required this.sessionId, this.fromVehicleId, this.toVehicleId, required this.session});
  factory _VehicleSwapResult.fromJson(Map<String, dynamic> json) => _$VehicleSwapResultFromJson(json);

@override final  String sessionId;
@override final  String? fromVehicleId;
@override final  String? toVehicleId;
@override final  CheckoutSessionDto session;

/// Create a copy of VehicleSwapResult
/// with the given fields replaced by the non-null parameter values.
@override @JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
_$VehicleSwapResultCopyWith<_VehicleSwapResult> get copyWith => __$VehicleSwapResultCopyWithImpl<_VehicleSwapResult>(this, _$identity);

@override
Map<String, dynamic> toJson() {
  return _$VehicleSwapResultToJson(this, );
}

@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is _VehicleSwapResult&&(identical(other.sessionId, sessionId) || other.sessionId == sessionId)&&(identical(other.fromVehicleId, fromVehicleId) || other.fromVehicleId == fromVehicleId)&&(identical(other.toVehicleId, toVehicleId) || other.toVehicleId == toVehicleId)&&(identical(other.session, session) || other.session == session));
}

@JsonKey(includeFromJson: false, includeToJson: false)
@override
int get hashCode => Object.hash(runtimeType,sessionId,fromVehicleId,toVehicleId,session);

@override
String toString() {
  return 'VehicleSwapResult(sessionId: $sessionId, fromVehicleId: $fromVehicleId, toVehicleId: $toVehicleId, session: $session)';
}


}

/// @nodoc
abstract mixin class _$VehicleSwapResultCopyWith<$Res> implements $VehicleSwapResultCopyWith<$Res> {
  factory _$VehicleSwapResultCopyWith(_VehicleSwapResult value, $Res Function(_VehicleSwapResult) _then) = __$VehicleSwapResultCopyWithImpl;
@override @useResult
$Res call({
 String sessionId, String? fromVehicleId, String? toVehicleId, CheckoutSessionDto session
});


@override $CheckoutSessionDtoCopyWith<$Res> get session;

}
/// @nodoc
class __$VehicleSwapResultCopyWithImpl<$Res>
    implements _$VehicleSwapResultCopyWith<$Res> {
  __$VehicleSwapResultCopyWithImpl(this._self, this._then);

  final _VehicleSwapResult _self;
  final $Res Function(_VehicleSwapResult) _then;

/// Create a copy of VehicleSwapResult
/// with the given fields replaced by the non-null parameter values.
@override @pragma('vm:prefer-inline') $Res call({Object? sessionId = null,Object? fromVehicleId = freezed,Object? toVehicleId = freezed,Object? session = null,}) {
  return _then(_VehicleSwapResult(
sessionId: null == sessionId ? _self.sessionId : sessionId // ignore: cast_nullable_to_non_nullable
as String,fromVehicleId: freezed == fromVehicleId ? _self.fromVehicleId : fromVehicleId // ignore: cast_nullable_to_non_nullable
as String?,toVehicleId: freezed == toVehicleId ? _self.toVehicleId : toVehicleId // ignore: cast_nullable_to_non_nullable
as String?,session: null == session ? _self.session : session // ignore: cast_nullable_to_non_nullable
as CheckoutSessionDto,
  ));
}

/// Create a copy of VehicleSwapResult
/// with the given fields replaced by the non-null parameter values.
@override
@pragma('vm:prefer-inline')
$CheckoutSessionDtoCopyWith<$Res> get session {
  
  return $CheckoutSessionDtoCopyWith<$Res>(_self.session, (value) {
    return _then(_self.copyWith(session: value));
  });
}
}


/// @nodoc
mixin _$CheckoutPresenceDto {

/// RIDEOPS | COUNTER | KIOSK | CUSTOMER (nunca null en el serializer;
/// el default vacío es cinturón, no expectativa).
 String get surface;/// El servidor ya resolvió label → fullName del staff → etiqueta genérica
/// de la superficie, así que nunca llega vacío por el camino feliz.
 String get displayName;@IsoDateTimeConverter() DateTime? get lastSeenAt;/// Quién late. Lo emite `activePresence()`
/// (checkout-presence.service.js:184) desde el PR que aterrizó justo antes
/// de H6, y es lo que sostiene dos cosas:
///
///  1. el filtro "no me listes a mí mismo" de `pickPresenceChip` — sin él,
///     en cuanto RideOps late el agente se ve a sí mismo, y "María G. está
///     en esta sesión" cuando María G. eres tú destruye la única señal que
///     el chip aporta;
///  2. la atribución con nombre del avance ajeno
///     (`checkout_attribution.dart`, único punto de consumo).
///
/// **Null es un valor legítimo, no un fallo**: el kiosco (aparato) y el
/// teléfono del cliente (token) laten sin usuario a propósito, y el
/// servidor les resuelve el nombre con la etiqueta genérica de la
/// superficie. Ese null es justo lo que distingue una persona de un mueble
/// en la hoja 20B.
 String? get actorUserId;
/// Create a copy of CheckoutPresenceDto
/// with the given fields replaced by the non-null parameter values.
@JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
$CheckoutPresenceDtoCopyWith<CheckoutPresenceDto> get copyWith => _$CheckoutPresenceDtoCopyWithImpl<CheckoutPresenceDto>(this as CheckoutPresenceDto, _$identity);

  /// Serializes this CheckoutPresenceDto to a JSON map.
  Map<String, dynamic> toJson();


@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is CheckoutPresenceDto&&(identical(other.surface, surface) || other.surface == surface)&&(identical(other.displayName, displayName) || other.displayName == displayName)&&(identical(other.lastSeenAt, lastSeenAt) || other.lastSeenAt == lastSeenAt)&&(identical(other.actorUserId, actorUserId) || other.actorUserId == actorUserId));
}

@JsonKey(includeFromJson: false, includeToJson: false)
@override
int get hashCode => Object.hash(runtimeType,surface,displayName,lastSeenAt,actorUserId);

@override
String toString() {
  return 'CheckoutPresenceDto(surface: $surface, displayName: $displayName, lastSeenAt: $lastSeenAt, actorUserId: $actorUserId)';
}


}

/// @nodoc
abstract mixin class $CheckoutPresenceDtoCopyWith<$Res>  {
  factory $CheckoutPresenceDtoCopyWith(CheckoutPresenceDto value, $Res Function(CheckoutPresenceDto) _then) = _$CheckoutPresenceDtoCopyWithImpl;
@useResult
$Res call({
 String surface, String displayName,@IsoDateTimeConverter() DateTime? lastSeenAt, String? actorUserId
});




}
/// @nodoc
class _$CheckoutPresenceDtoCopyWithImpl<$Res>
    implements $CheckoutPresenceDtoCopyWith<$Res> {
  _$CheckoutPresenceDtoCopyWithImpl(this._self, this._then);

  final CheckoutPresenceDto _self;
  final $Res Function(CheckoutPresenceDto) _then;

/// Create a copy of CheckoutPresenceDto
/// with the given fields replaced by the non-null parameter values.
@pragma('vm:prefer-inline') @override $Res call({Object? surface = null,Object? displayName = null,Object? lastSeenAt = freezed,Object? actorUserId = freezed,}) {
  return _then(_self.copyWith(
surface: null == surface ? _self.surface : surface // ignore: cast_nullable_to_non_nullable
as String,displayName: null == displayName ? _self.displayName : displayName // ignore: cast_nullable_to_non_nullable
as String,lastSeenAt: freezed == lastSeenAt ? _self.lastSeenAt : lastSeenAt // ignore: cast_nullable_to_non_nullable
as DateTime?,actorUserId: freezed == actorUserId ? _self.actorUserId : actorUserId // ignore: cast_nullable_to_non_nullable
as String?,
  ));
}

}


/// Adds pattern-matching-related methods to [CheckoutPresenceDto].
extension CheckoutPresenceDtoPatterns on CheckoutPresenceDto {
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

@optionalTypeArgs TResult maybeMap<TResult extends Object?>(TResult Function( _CheckoutPresenceDto value)?  $default,{required TResult orElse(),}){
final _that = this;
switch (_that) {
case _CheckoutPresenceDto() when $default != null:
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

@optionalTypeArgs TResult map<TResult extends Object?>(TResult Function( _CheckoutPresenceDto value)  $default,){
final _that = this;
switch (_that) {
case _CheckoutPresenceDto():
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

@optionalTypeArgs TResult? mapOrNull<TResult extends Object?>(TResult? Function( _CheckoutPresenceDto value)?  $default,){
final _that = this;
switch (_that) {
case _CheckoutPresenceDto() when $default != null:
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

@optionalTypeArgs TResult maybeWhen<TResult extends Object?>(TResult Function( String surface,  String displayName, @IsoDateTimeConverter()  DateTime? lastSeenAt,  String? actorUserId)?  $default,{required TResult orElse(),}) {final _that = this;
switch (_that) {
case _CheckoutPresenceDto() when $default != null:
return $default(_that.surface,_that.displayName,_that.lastSeenAt,_that.actorUserId);case _:
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

@optionalTypeArgs TResult when<TResult extends Object?>(TResult Function( String surface,  String displayName, @IsoDateTimeConverter()  DateTime? lastSeenAt,  String? actorUserId)  $default,) {final _that = this;
switch (_that) {
case _CheckoutPresenceDto():
return $default(_that.surface,_that.displayName,_that.lastSeenAt,_that.actorUserId);case _:
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

@optionalTypeArgs TResult? whenOrNull<TResult extends Object?>(TResult? Function( String surface,  String displayName, @IsoDateTimeConverter()  DateTime? lastSeenAt,  String? actorUserId)?  $default,) {final _that = this;
switch (_that) {
case _CheckoutPresenceDto() when $default != null:
return $default(_that.surface,_that.displayName,_that.lastSeenAt,_that.actorUserId);case _:
  return null;

}
}

}

/// @nodoc
@JsonSerializable()

class _CheckoutPresenceDto extends CheckoutPresenceDto {
  const _CheckoutPresenceDto({this.surface = '', this.displayName = '', @IsoDateTimeConverter() this.lastSeenAt, this.actorUserId}): super._();
  factory _CheckoutPresenceDto.fromJson(Map<String, dynamic> json) => _$CheckoutPresenceDtoFromJson(json);

/// RIDEOPS | COUNTER | KIOSK | CUSTOMER (nunca null en el serializer;
/// el default vacío es cinturón, no expectativa).
@override@JsonKey() final  String surface;
/// El servidor ya resolvió label → fullName del staff → etiqueta genérica
/// de la superficie, así que nunca llega vacío por el camino feliz.
@override@JsonKey() final  String displayName;
@override@IsoDateTimeConverter() final  DateTime? lastSeenAt;
/// Quién late. Lo emite `activePresence()`
/// (checkout-presence.service.js:184) desde el PR que aterrizó justo antes
/// de H6, y es lo que sostiene dos cosas:
///
///  1. el filtro "no me listes a mí mismo" de `pickPresenceChip` — sin él,
///     en cuanto RideOps late el agente se ve a sí mismo, y "María G. está
///     en esta sesión" cuando María G. eres tú destruye la única señal que
///     el chip aporta;
///  2. la atribución con nombre del avance ajeno
///     (`checkout_attribution.dart`, único punto de consumo).
///
/// **Null es un valor legítimo, no un fallo**: el kiosco (aparato) y el
/// teléfono del cliente (token) laten sin usuario a propósito, y el
/// servidor les resuelve el nombre con la etiqueta genérica de la
/// superficie. Ese null es justo lo que distingue una persona de un mueble
/// en la hoja 20B.
@override final  String? actorUserId;

/// Create a copy of CheckoutPresenceDto
/// with the given fields replaced by the non-null parameter values.
@override @JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
_$CheckoutPresenceDtoCopyWith<_CheckoutPresenceDto> get copyWith => __$CheckoutPresenceDtoCopyWithImpl<_CheckoutPresenceDto>(this, _$identity);

@override
Map<String, dynamic> toJson() {
  return _$CheckoutPresenceDtoToJson(this, );
}

@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is _CheckoutPresenceDto&&(identical(other.surface, surface) || other.surface == surface)&&(identical(other.displayName, displayName) || other.displayName == displayName)&&(identical(other.lastSeenAt, lastSeenAt) || other.lastSeenAt == lastSeenAt)&&(identical(other.actorUserId, actorUserId) || other.actorUserId == actorUserId));
}

@JsonKey(includeFromJson: false, includeToJson: false)
@override
int get hashCode => Object.hash(runtimeType,surface,displayName,lastSeenAt,actorUserId);

@override
String toString() {
  return 'CheckoutPresenceDto(surface: $surface, displayName: $displayName, lastSeenAt: $lastSeenAt, actorUserId: $actorUserId)';
}


}

/// @nodoc
abstract mixin class _$CheckoutPresenceDtoCopyWith<$Res> implements $CheckoutPresenceDtoCopyWith<$Res> {
  factory _$CheckoutPresenceDtoCopyWith(_CheckoutPresenceDto value, $Res Function(_CheckoutPresenceDto) _then) = __$CheckoutPresenceDtoCopyWithImpl;
@override @useResult
$Res call({
 String surface, String displayName,@IsoDateTimeConverter() DateTime? lastSeenAt, String? actorUserId
});




}
/// @nodoc
class __$CheckoutPresenceDtoCopyWithImpl<$Res>
    implements _$CheckoutPresenceDtoCopyWith<$Res> {
  __$CheckoutPresenceDtoCopyWithImpl(this._self, this._then);

  final _CheckoutPresenceDto _self;
  final $Res Function(_CheckoutPresenceDto) _then;

/// Create a copy of CheckoutPresenceDto
/// with the given fields replaced by the non-null parameter values.
@override @pragma('vm:prefer-inline') $Res call({Object? surface = null,Object? displayName = null,Object? lastSeenAt = freezed,Object? actorUserId = freezed,}) {
  return _then(_CheckoutPresenceDto(
surface: null == surface ? _self.surface : surface // ignore: cast_nullable_to_non_nullable
as String,displayName: null == displayName ? _self.displayName : displayName // ignore: cast_nullable_to_non_nullable
as String,lastSeenAt: freezed == lastSeenAt ? _self.lastSeenAt : lastSeenAt // ignore: cast_nullable_to_non_nullable
as DateTime?,actorUserId: freezed == actorUserId ? _self.actorUserId : actorUserId // ignore: cast_nullable_to_non_nullable
as String?,
  ));
}


}

// dart format on
