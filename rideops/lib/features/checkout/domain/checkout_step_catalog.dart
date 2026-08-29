/// Catálogo de PRESENTACIÓN de los pasos del checkout.
///
/// ⚠️ Esto NO es la máquina de estados (ADR-4). No decide nada, no calcula el
/// siguiente paso y no valida transiciones: es la tabla de etiquetas, orden de
/// lectura y agrupación en fases que el mockup 8A/8B sanciona explícitamente
/// (nota 4: «el cliente conoce el ORDEN de los 10 pasos lineales solo por su
/// catálogo de etiquetas; el ESTADO siempre viene del servidor»).
///
/// Reglas que este archivo respeta y que hay que sostener al editarlo:
///  - Un `currentStep` que no esté aquí NO es un error: [infoFor] devuelve
///    null y la UI cae a un nodo genérico con el nombre crudo del servidor.
///  - Nadie fuera de aquí puede derivar "el paso que sigue". Los botones de
///    transición reciben su `toStep` de la pantalla del paso (H2–H5), que lo
///    conoce por diseño de producto, no por inferencia sobre esta lista.
///  - **10, no 11**: la cadena lineal `CONFIRMING → CLOSED` son 10 pasos.
///    `CANCELLED` es salida alterna alcanzable desde cualquier paso no
///    terminal (state-machine.js:95-101), NO el paso 11 de una fila. Con
///    denominador 11 el agente restaría mal los pasos que le faltan.
library;

import '../../../core/api/enums.dart';

/// Las 5 fases del rail (mockup 8A). Agrupación de presentación pura: 10
/// nodos de 24 px no caben legibles en 390 px con guantes.
enum CheckoutPhase { confirm, terms, payment, inspection, closing }

/// Un paso de la cadena lineal, con lo único que la UI necesita saber de él
/// SIN preguntarle al servidor: su etiqueta (vía l10n), su posición para el
/// contador honesto, su fase, y qué sello exige el backend para ENTRAR.
class CheckoutStepInfo {
  const CheckoutStepInfo({
    required this.step,
    required this.position,
    required this.phase,
    this.entryGuard,
  });

  final CheckoutStep step;

  /// 1..10 dentro de la cadena lineal.
  final int position;
  final CheckoutPhase phase;

  /// Sello que el backend exige ANTES de aceptar la entrada a este paso
  /// (`ENTRY_REQUIRES`, state-machine.js:77-82). Es lo que permite pintar el
  /// candado + "qué falta" en la lista de pasos (8B) — o sea, explicar el
  /// 409 `ENTRY_GUARD` ANTES de que ocurra.
  final CheckoutEntryGuard? entryGuard;
}

/// Los 4 guards de entrada del backend, como enum para que la UI los traduzca
/// sin comparar strings sueltos.
enum CheckoutEntryGuard {
  /// `TC_SIGNED ← tcCompletedAt`
  tcCompleted,

  /// `PAID ← paymentCompletedAt`
  payment,

  /// `CUSTOMER_SIGN_PENDING ← inspectionCompletedAt`
  inspection,

  /// `CLOSED ← customerSignedAt`
  signature,
}

/// Cadena lineal en orden de lectura (state-machine.js:41-53 menos
/// `CANCELLED`). El orden de esta lista ES el contador "Paso N de 10".
const List<CheckoutStepInfo> kCheckoutLinearSteps = [
  CheckoutStepInfo(
    step: CheckoutStep.confirming,
    position: 1,
    phase: CheckoutPhase.confirm,
  ),
  CheckoutStepInfo(
    step: CheckoutStep.tcPending,
    position: 2,
    phase: CheckoutPhase.terms,
  ),
  CheckoutStepInfo(
    step: CheckoutStep.tcSigned,
    position: 3,
    phase: CheckoutPhase.terms,
    entryGuard: CheckoutEntryGuard.tcCompleted,
  ),
  CheckoutStepInfo(
    step: CheckoutStep.paymentPending,
    position: 4,
    phase: CheckoutPhase.payment,
  ),
  CheckoutStepInfo(
    step: CheckoutStep.paid,
    position: 5,
    phase: CheckoutPhase.payment,
    entryGuard: CheckoutEntryGuard.payment,
  ),
  CheckoutStepInfo(
    step: CheckoutStep.inspectionHandoff,
    position: 6,
    phase: CheckoutPhase.inspection,
  ),
  CheckoutStepInfo(
    step: CheckoutStep.inspectionInProgress,
    position: 7,
    phase: CheckoutPhase.inspection,
  ),
  CheckoutStepInfo(
    step: CheckoutStep.customerSignPending,
    position: 8,
    phase: CheckoutPhase.closing,
    entryGuard: CheckoutEntryGuard.inspection,
  ),
  CheckoutStepInfo(
    step: CheckoutStep.finalizing,
    position: 9,
    phase: CheckoutPhase.closing,
  ),
  CheckoutStepInfo(
    step: CheckoutStep.closed,
    position: 10,
    phase: CheckoutPhase.closing,
    entryGuard: CheckoutEntryGuard.signature,
  ),
];

/// Total del contador honesto del mockup.
const int kCheckoutLinearStepCount = 10;

/// Ficha del paso, o null si el servidor reporta algo que esta versión de la
/// app no conoce (forward-compat: se dibuja genérico, jamás se "corrige").
CheckoutStepInfo? infoFor(CheckoutStep? step) {
  if (step == null) return null;
  for (final info in kCheckoutLinearSteps) {
    if (info.step == step) return info;
  }
  return null; // CANCELLED (salida alterna) y cualquier paso futuro
}

/// Fases del rail en orden.
const List<CheckoutPhase> kCheckoutPhases = CheckoutPhase.values;

/// Última posición de cada fase — con esto el rail decide "fase hecha" sin
/// inventar nada: si el servidor dice que vamos en la posición N, las fases
/// que terminan antes de N quedaron atrás. No predice ninguna futura.
int _lastPositionOf(CheckoutPhase phase) {
  var last = 0;
  for (final info in kCheckoutLinearSteps) {
    if (info.phase == phase && info.position > last) last = info.position;
  }
  return last;
}

/// Estado de un nodo del rail, derivado SOLO de la posición actual reportada
/// por el servidor. [currentPosition] null (paso desconocido o CANCELLED) ⇒
/// todo queda pendiente/inerte: sin dato del servidor no se afirma progreso.
enum PhaseNodeState { done, current, pending }

PhaseNodeState phaseStateFor(CheckoutPhase phase, int? currentPosition) {
  if (currentPosition == null) return PhaseNodeState.pending;
  final last = _lastPositionOf(phase);
  if (currentPosition > last) return PhaseNodeState.done;
  final first = kCheckoutLinearSteps
      .where((s) => s.phase == phase)
      .map((s) => s.position)
      .reduce((a, b) => a < b ? a : b);
  if (currentPosition >= first) return PhaseNodeState.current;
  return PhaseNodeState.pending;
}

/// ¿El servidor ya está EN o PASADO [target]? Es la pregunta exacta que
/// convierte un 409 `ILLEGAL_TRANSITION` en no-op silencioso (el paso ya lo
/// hizo otra superficie) en vez de un error que el agente no puede resolver.
///
/// Con cualquiera de los dos pasos fuera del catálogo devuelve false: sin
/// certeza NO se silencia un error (fail-visible).
bool isAtOrPast({required CheckoutStep? current, required CheckoutStep target}) {
  final currentInfo = infoFor(current);
  final targetInfo = infoFor(target);
  if (currentInfo == null || targetInfo == null) return false;
  return currentInfo.position >= targetInfo.position;
}

/// Cuántos pasos saltó la UI al reconciliar (tag `steps_jumped` de
/// `checkout.reconciled`). Null cuando alguno de los dos no está en el
/// catálogo — el evento viaja sin el tag antes que con un número inventado.
int? stepsJumped({CheckoutStep? from, CheckoutStep? to}) {
  final a = infoFor(from);
  final b = infoFor(to);
  if (a == null || b == null) return null;
  return b.position - a.position;
}
