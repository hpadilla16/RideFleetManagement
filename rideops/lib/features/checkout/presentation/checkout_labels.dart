/// Traducción de lo que el servidor reporta a lenguaje de patio.
///
/// Regla del mockup (nota 6): «etiquetas humanas en l10n, una por enum del
/// servidor» — sin traducción creativa y sin que la app decida NADA sobre el
/// estado. Todo lo que no reconoce se muestra CRUDO (forward-compat de ADR-4).
library;

import '../../../core/api/enums.dart';
import '../../../core/l10n/app_localizations.dart';
import '../domain/checkout_changes.dart';
import '../domain/checkout_event_log.dart';
import '../domain/checkout_step_catalog.dart';

/// Etiqueta del paso. [rawStep] es el string del servidor: si el enum no lo
/// reconoce (paso nuevo), se muestra tal cual dentro del copy de "paso
/// desconocido" en vez de un vacío o un crash.
String stepLabel(AppLocalizations l10n, String rawStep) {
  final step = CheckoutStep.tryParse(rawStep);
  return switch (step) {
    CheckoutStep.confirming => l10n.coStepConfirming,
    CheckoutStep.tcPending => l10n.coStepTcPending,
    CheckoutStep.tcSigned => l10n.coStepTcSigned,
    CheckoutStep.paymentPending => l10n.coStepPaymentPending,
    CheckoutStep.paid => l10n.coStepPaid,
    CheckoutStep.inspectionHandoff => l10n.coStepInspectionHandoff,
    CheckoutStep.inspectionInProgress => l10n.coStepInspectionInProgress,
    CheckoutStep.customerSignPending => l10n.coStepCustomerSignPending,
    CheckoutStep.finalizing => l10n.coStepFinalizing,
    CheckoutStep.closed => l10n.coStepClosed,
    CheckoutStep.cancelled => l10n.coStepCancelled,
    null => l10n.coStepUnknown(rawStep),
  };
}

String phaseLabel(AppLocalizations l10n, CheckoutPhase phase) =>
    switch (phase) {
      CheckoutPhase.confirm => l10n.coPhaseConfirm,
      CheckoutPhase.terms => l10n.coPhaseTerms,
      CheckoutPhase.payment => l10n.coPhasePayment,
      CheckoutPhase.inspection => l10n.coPhaseInspection,
      CheckoutPhase.closing => l10n.coPhaseClosing,
    };

/// "Espera: firma de T&C del cliente" — el 409 `ENTRY_GUARD` explicado ANTES
/// de que ocurra (mockup 8B) y también cuando ya ocurrió.
String guardLabel(AppLocalizations l10n, CheckoutEntryGuard guard) =>
    switch (guard) {
      CheckoutEntryGuard.tcCompleted => l10n.coGuardTcCompleted,
      CheckoutEntryGuard.payment => l10n.coGuardPayment,
      CheckoutEntryGuard.inspection => l10n.coGuardInspection,
      CheckoutEntryGuard.signature => l10n.coGuardSignature,
    };

/// Superficie de una presencia. El enum `CheckoutSurface` NO está espejado en
/// Dart todavía (aterriza con M2-H6), así que esto compara el wire crudo y
/// cae a "otra superficie" ante cualquier valor nuevo.
String surfaceLabel(AppLocalizations l10n, String surface) =>
    switch (surface) {
      'KIOSK' => l10n.coSurfaceKiosk,
      'COUNTER' => l10n.coSurfaceCounter,
      'RIDEOPS' => l10n.coSurfaceRideops,
      'CUSTOMER' => l10n.coSurfaceCustomer,
      _ => l10n.coSurfaceOther,
    };

/// Edad corta CON segundos: el wizard mide en segundos donde la home mide en
/// minutos (un heartbeat de 8 s y uno de 40 s son cosas distintas).
String checkoutAgeLabel(AppLocalizations l10n, Duration age) {
  final seconds = age.inSeconds;
  if (seconds < 60) return l10n.ageSeconds(seconds < 0 ? 0 : seconds);
  if (age.inHours < 1) return l10n.ageMinutes(age.inMinutes);
  return l10n.ageHours(age.inHours);
}

/// Línea "Completado por …" de la lista de pasos (8B). Sin evento en el log
/// no se atribuye nada: se dice solo que está completado.
String doneLabel(
  AppLocalizations l10n, {
  required CheckoutEvent? event,
  required String? myUserId,
  required String time,
}) {
  if (event == null) return l10n.coStepDone(time);
  return switch (event.actorKind(myUserId)) {
    CheckoutActorKind.you => l10n.coStepDoneByYou(time),
    CheckoutActorKind.kiosk => l10n.coStepDoneKiosk(time),
    CheckoutActorKind.otherAgent => l10n.coStepDoneOtherAgent(time),
    CheckoutActorKind.otherSurface => l10n.coStepDone(time),
  };
}

/// Iniciales del avatar de una PERSONA (hoja 20B). Máximo dos, de las dos
/// primeras palabras: "Diego Torres" → "DT".
///
/// Deliberadamente **no** se usa para aparatos — un círculo con "KI" vestiría
/// al kiosco de persona, que es justo la confusión que 20B existe para evitar.
/// Nombre vacío ⇒ un punto: mejor un marcador neutro que una letra inventada.
String initialsOf(String name) {
  final words = name
      .trim()
      .split(RegExp(r'\s+'))
      .where((w) => w.isNotEmpty)
      .toList();
  if (words.isEmpty) return '·';
  final buf = StringBuffer();
  for (final w in words.take(2)) {
    // `characters` no hace falta aquí: se toma el primer code unit y se sube
    // a mayúscula; un nombre que empiece con emoji cae en un glifo raro, no
    // en un crash.
    buf.write(w[0].toUpperCase());
  }
  return buf.toString();
}

/// Etiqueta del sello que cayó (banner 21C y hoja 21B). Reusa las mismas
/// cuatro cadenas que la tarjeta "Lo que el servidor ya tiene": un sello es
/// un sello, se llame donde se llame.
String stampLabel(AppLocalizations l10n, CheckoutStampKind kind) =>
    switch (kind) {
      CheckoutStampKind.tc => l10n.coStampTc,
      CheckoutStampKind.payment => l10n.coStampPayment,
      CheckoutStampKind.inspection => l10n.coStampInspection,
      CheckoutStampKind.signature => l10n.coStampSignature,
    };
