/// Lógica de dominio del paso CONFIRMING (M2-H2, mockup 9A-9E).
///
/// Todo aquí es PURO y derivado del servidor: qué datos faltan, si el seguro
/// está declinado, si el swap todavía procede. Ninguna función decide un paso
/// ni predice una transición (ADR-4) — describen el estado que el servidor ya
/// reportó para que la pantalla lo pinte y para que el bloqueo local pueda
/// nombrar SU causa.
library;

import '../../../core/api/dto/checkout_session.dart';
import '../../../core/api/dto/reservation_display.dart';
import '../../../core/api/enums.dart';
import 'checkout_event_log.dart';

/// Pasos en los que `vehicle-swap.service.js` RECHAZA el swap
/// (`STEPS_BLOCKING_SWAP`, :25-31). Espejo declarado: si el backend agrega uno,
/// esta lista se actualiza en el mismo PR.
///
/// La regla de build de la nota 2 del mockup: el enlace "Cambiar vehículo"
/// DESAPARECE a partir de `INSPECTION_IN_PROGRESS` — las fotos ya se tomaron
/// sobre el otro coche. Esconderlo cuando el servidor ya no lo acepta evita un
/// 409 evitable; el 409 se sigue manejando igual (DoD #5), porque entre el
/// render y el tap cabe una inspección ajena.
const Set<CheckoutStep> kStepsBlockingSwap = {
  CheckoutStep.inspectionInProgress,
  CheckoutStep.customerSignPending,
  CheckoutStep.finalizing,
  CheckoutStep.closed,
  CheckoutStep.cancelled,
};

/// ¿Ofrecemos el swap en este paso? [step] null = paso que esta versión no
/// conoce ⇒ **false**: sin certeza no se ofrece una acción que reescribe el
/// contrato. Es fail-closed a propósito (el agente no pierde nada: el swap
/// vive en el mostrador web y en el paso 1 de la próxima sesión).
bool swapAllowedFor(CheckoutStep? step) =>
    step != null && !kStepsBlockingSwap.contains(step);

/// Estado del switch "el cliente declina el seguro" (9A/9C).
///
/// Orden de verdad, y por qué:
///  1. `agreement.declinedInsurance` cuando el servidor lo mande — es la
///     columna que de verdad decide el anexo del T&C y del PDF. HOY llega
///     null: el `select` de display-data no la incluye (ver el DTO).
///  2. Último evento `DECLINED_INSURANCE` del log de la sesión: lo escribe
///     `setDeclinedInsurance` en la misma llamada que actualiza la columna,
///     así que es un espejo fiel de la última escritura conocida — y viaja en
///     la respuesta de nuestro propio POST, que es lo que hace que la UI se
///     re-renderice desde el servidor en vez de guardar estado local.
///  3. false: ni columna ni evento ⇒ nadie lo ha declinado nunca.
///
/// Limitación declarada: `events` es un TEXT con lost-update reconocido (lo
/// cierra M2-H8). Si dos superficies escriben la bandera a la vez, la columna
/// (que sí es atómica) puede quedar en un valor y el log en otro. Por eso el
/// pedido de backend es exponer la columna, no "arreglar" el log.
bool declinedInsuranceOf({
  required CheckoutSessionDto session,
  DisplayAgreement? agreement,
}) {
  final column = agreement?.declinedInsurance;
  if (column != null) return column;
  final event = lastEventOfKind(
    parseCheckoutEvents(session.events),
    'DECLINED_INSURANCE',
  );
  return event?.declined ?? false;
}

/// ¿El switch del seguro sigue siendo editable?
///
/// Regla de producto que el propio copy de 9C promete ("Puedes apagarlo
/// mientras no se firmen los términos") convertida en build. Verificado en el
/// backend: `setDeclinedInsurance` **no tiene guard de paso** — acepta la
/// escritura incluso después de `tcCompletedAt`, y `terms-signing.service.js`
/// calcula las secciones que el cliente firmó con el valor que había EN ESE
/// MOMENTO. Cambiarla después dejaría el documento firmado y el PDF final
/// contando historias distintas sobre la cobertura.
///
/// La app se cierra en el sello de la firma: no esconde el switch (el estado
/// tiene que seguir siendo legible), lo deshabilita nombrando la causa.
bool insuranceEditable(CheckoutSessionDto session) =>
    session.tcCompletedAt == null;

/// Datos del cliente que la entrega necesita y que 9B nombra cuando faltan.
///
/// Se limita a lo que el mockup declara (licencia y teléfono) más el nombre:
/// son los tres campos que el contrato imprime y que el agente confronta con
/// la licencia física. NO se inventan requisitos que el servidor no tiene.
enum ConfirmMissingField { customerName, license, phone }

/// Verificación del cliente lista para pintar (9A/9B).
class ConfirmCustomerCheck {
  const ConfirmCustomerCheck({
    required this.name,
    required this.license,
    required this.licenseExpiry,
    required this.phone,
    required this.missing,
  });

  final String? name;
  final String? license;
  final DateTime? licenseExpiry;
  final String? phone;

  /// En orden de lectura de la tarjeta (nombre → licencia → teléfono).
  final List<ConfirmMissingField> missing;

  bool get complete => missing.isEmpty;
}

String? _clean(String? value) {
  final v = value?.trim();
  return v == null || v.isEmpty ? null : v;
}

/// Confronta el snapshot del contrato con la ficha viva del cliente.
///
/// El snapshot GANA cuando existe: es lo que se imprime y lo que se firma. La
/// ficha del cliente es el respaldo (una reserva puede llegar al wizard antes
/// de que el contrato copie los datos del pre-checkin).
ConfirmCustomerCheck customerCheck({
  DisplayCustomer? customer,
  DisplayAgreement? agreement,
}) {
  final name = _clean(customer?.fullName);
  final license =
      _clean(agreement?.licenseNumber) ?? _clean(customer?.licenseNumber);
  final phone = _clean(agreement?.customerPhone) ?? _clean(customer?.phone);
  return ConfirmCustomerCheck(
    name: name,
    license: license,
    licenseExpiry: agreement?.licenseExpiry,
    phone: phone,
    missing: [
      if (name == null) ConfirmMissingField.customerName,
      if (license == null) ConfirmMissingField.license,
      if (phone == null) ConfirmMissingField.phone,
    ],
  );
}
