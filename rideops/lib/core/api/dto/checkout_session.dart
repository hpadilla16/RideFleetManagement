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
  }) = _CheckoutSessionDto;

  factory CheckoutSessionDto.fromJson(Map<String, dynamic> json) =>
      _$CheckoutSessionDtoFromJson(json);

  CheckoutStep? get step => CheckoutStep.tryParse(currentStep);

  bool get isTerminal => step?.isTerminal ?? false;
}
