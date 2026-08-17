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

    /// Versión optimista de la fila (M2 P2). Se lee para FENCING de
    /// respuestas: una lectura que llega tarde con versión MENOR que la ya
    /// aplicada es un fantasma del pasado y se descarta (INN MC-2). No se
    /// ENVÍA `expectedVersion` todavía — eso es opt-in y aterriza con M2-H6.
    ///
    /// Null con backend viejo (columna inexistente) ⇒ el fence cae al
    /// contador local de escrituras, que no depende del servidor.
    int? stateVersion,

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

/// Respuesta de `POST /api/checkout-sessions/:id/vehicle`
/// (`vehicle-swap.service.js:139-144`): el swap es ATÓMICO sobre
/// `Reservation.vehicleId` **y** `RentalAgreement.vehicleId` (se separaron una
/// vez y produjeron contratos con otro coche), y devuelve la sesión ya
/// actualizada dentro de [session].
///
/// La sesión que viene aquí es la fila cruda de la transacción: NO pasa por
/// `withPresence()`, así que llega sin `presence` — el controller la aplica
/// con la misma regla que las demás escrituras (la presencia previa sobrevive).
@freezed
abstract class VehicleSwapResult with _$VehicleSwapResult {
  const factory VehicleSwapResult({
    required String sessionId,
    String? fromVehicleId,
    String? toVehicleId,
    required CheckoutSessionDto session,
  }) = _VehicleSwapResult;

  factory VehicleSwapResult.fromJson(Map<String, dynamic> json) =>
      _$VehicleSwapResultFromJson(json);
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

    /// Quién late. **El serializer de P1 NO lo emite todavía**
    /// (`activePresence()` mapea solo `{surface, displayName, lastSeenAt}`):
    /// aquí queda mapeado y el filtro de "no me listes a mí mismo" ya está
    /// escrito en `pickPresenceChip`, inerte mientras el campo llegue null.
    ///
    /// **Pedido para H6, ANTES de que RideOps empiece a latir**: sin este id
    /// el agente se vería a sí mismo en el chip de acompañantes en cuanto la
    /// app haga su propio heartbeat — y "María G. está en esta sesión" cuando
    /// María G. eres tú destruye la única señal que el chip aporta.
    String? actorUserId,
  }) = _CheckoutPresenceDto;

  factory CheckoutPresenceDto.fromJson(Map<String, dynamic> json) =>
      _$CheckoutPresenceDtoFromJson(json);
}
