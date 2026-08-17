import 'package:freezed_annotation/freezed_annotation.dart';

import '../enums.dart';
import 'json_converters.dart';

part 'checkout_session.freezed.dart';
part 'checkout_session.g.dart';

/// Fila cruda del modelo `CheckoutSession` (schema.prisma:5067-5111) — lo que
/// devuelven `GET /api/checkout-sessions/:id` y `/by-reservation/:rid`.
///
/// ADR-4: la app renderiza DESDE [currentStep]; jamás mantiene una copia de
/// la máquina. [step] parsea con tolerancia: un paso nuevo del backend llega
/// como null tipado pero [currentStep] crudo sigue disponible para mostrar.
@freezed
abstract class CheckoutSessionDto with _$CheckoutSessionDto {
  const CheckoutSessionDto._();

  const factory CheckoutSessionDto({
    required String id,
    required String reservationId,
    String? agreementId,
    String? tenantId,
    required String currentStep,

    /// JSON string del log de transiciones — se muestra en soporte, no se
    /// parsea en caliente.
    String? events,
    @IsoDateTimeConverter() DateTime? tcCompletedAt,
    @IsoDateTimeConverter() DateTime? paymentCompletedAt,
    @IsoDateTimeConverter() DateTime? inspectionCompletedAt,
    @IsoDateTimeConverter() DateTime? customerSignedAt,
    @IsoDateTimeConverter() DateTime? startedAt,
    @IsoDateTimeConverter() DateTime? finishedAt,
    @IsoDateTimeConverter() DateTime? abandonedAt,
    String? abandonedReason,
    @IsoDateTimeConverter() DateTime? autoEmailedAt,
    String? startedByUserId,

    /// Presencia suave de las otras superficies (M2 P1 —
    /// `checkout-presence.service.js` `withPresence()`, adjunta el campo en
    /// `GET /:id` y `GET /by-reservation/:rid`).
    ///
    /// NULO ≠ VACÍO, y la diferencia importa: `null` = este backend todavía
    /// no emite el campo (el PR-tren P1-P3 no está desplegado) ⇒ la app NO
    /// puede afirmar nada sobre quién más está en la sesión; `[]` = el
    /// backend SÍ lo emite y no hay nadie fresco dentro del TTL de 45 s.
    /// Ambas pintan igual (sin chip), pero solo la segunda es una
    /// afirmación — por eso el campo es opcional y jamás tiene default.
    List<CheckoutPresenceDto>? presence,
  }) = _CheckoutSessionDto;

  factory CheckoutSessionDto.fromJson(Map<String, dynamic> json) =>
      _$CheckoutSessionDtoFromJson(json);

  CheckoutStep? get step => CheckoutStep.tryParse(currentStep);

  bool get isTerminal => step?.isTerminal ?? false;

  /// Los 4 sellos de side-effect (state-machine.js:77-82). El poll del wizard
  /// diffea ESTO además de [currentStep]: un stamp puede cambiar sin que el
  /// paso se mueva (el cliente firmó T&C mientras el agente mira el paso), y
  /// eso también abre/cierra guards de entrada.
  ({
    DateTime? tc,
    DateTime? payment,
    DateTime? inspection,
    DateTime? signature,
  }) get stamps => (
        tc: tcCompletedAt,
        payment: paymentCompletedAt,
        inspection: inspectionCompletedAt,
        signature: customerSignedAt,
      );
}

/// Fila de presencia del serializer de P1 (`activePresence()`:
/// `{ surface, displayName, lastSeenAt }`, ya filtrada por el TTL lógico de
/// 45 s en el servidor).
///
/// [surface] queda como STRING crudo a propósito: el enum `CheckoutSurface`
/// de Prisma NO se espeja todavía en `enums.dart` (decisión registrada en el
/// propio schema del PR P1 — el espejo Dart aterriza con M2-H6). Una
/// superficie desconocida se muestra con la etiqueta genérica y la app sigue
/// viva.
@freezed
abstract class CheckoutPresenceDto with _$CheckoutPresenceDto {
  const CheckoutPresenceDto._();

  const factory CheckoutPresenceDto({
    /// RIDEOPS | COUNTER | KIOSK | CUSTOMER (nunca null en el serializer;
    /// el default vacío es cinturón, no expectativa).
    @Default('') String surface,

    /// El servidor ya resolvió label → fullName del staff → etiqueta genérica
    /// de la superficie, así que nunca llega vacío por el camino feliz.
    @Default('') String displayName,
    @IsoDateTimeConverter() DateTime? lastSeenAt,
  }) = _CheckoutPresenceDto;

  factory CheckoutPresenceDto.fromJson(Map<String, dynamic> json) =>
      _$CheckoutPresenceDtoFromJson(json);
}
