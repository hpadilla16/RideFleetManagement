/// "Qué cambió desde que entraste" (M2-H6, frame 21B) — el destino real del
/// botón que H1 dejó apuntando a la lista de pasos.
///
/// Se construye con lo que YA llega, sin backend nuevo (nota 10): los cuatro
/// sellos de side-effect de la fila contra los que se tenían al entrar, y
/// `events[]` para el quién y el cuándo.
///
/// Dos decisiones que gobiernan este archivo:
///
///  1. **El diff se escribe en sellos y personas, no en columnas.**
///     `currentStep: TC_SIGNED → PAYMENT_PENDING` es cierto e inútil para el
///     agente. Lo que responde su pregunta es "la firma de T&C cayó, la puso
///     el kiosco a las 10:27".
///  2. **Nada aquí decide nada de la máquina de estados** (ADR-4). Es una
///     COMPARACIÓN de dos lecturas del servidor: no infiere el paso siguiente,
///     no valida transiciones y no corrige al servidor.
library;

import '../../../core/api/dto/checkout_session.dart';
import '../../../core/api/enums.dart';
import 'checkout_attribution.dart';
import 'checkout_event_log.dart';
import 'checkout_step_catalog.dart';

/// Los cuatro sellos de `state-machine.js:77-82`, como enum para que la UI los
/// traduzca sin comparar nombres de columna sueltos. Reusa el mismo eje que
/// [CheckoutEntryGuard] a propósito: son la misma cosa vista desde los dos
/// lados (el sello que cae / el guard que se abre).
enum CheckoutStampKind { tc, payment, inspection, signature }

/// Paso cuya ENTRADA exige [kind]. Es de dónde sale la atribución: el evento
/// `TRANSITION` hacia ese paso es la prueba de qué superficie cruzó la puerta
/// que ese sello abre.
///
/// Es indirecto y se declara así de frente: el sello lo estampa un handler de
/// side-effect (la ruta pública de T&C, el webhook de Spin, el finalize de la
/// inspección) y ese handler **no escribe en `events[]`**. Sin transición
/// registrada no se atribuye a nadie — se dice "completado" a secas, que es
/// todo lo que se puede afirmar.
CheckoutStep guardedStepOf(CheckoutStampKind kind) => switch (kind) {
      CheckoutStampKind.tc => CheckoutStep.tcSigned,
      CheckoutStampKind.payment => CheckoutStep.paid,
      CheckoutStampKind.inspection => CheckoutStep.customerSignPending,
      CheckoutStampKind.signature => CheckoutStep.closed,
    };

String _guardedStepWire(CheckoutStampKind kind) => guardedStepOf(kind).wire;

/// ¿Este sello es ASUNTO DEL PASO en el que está la sesión?
///
/// Sirve para una sola decisión, y es la que separa el frame 21C de puro
/// ruido: **cuándo un sello que cae merece un banner de avance ajeno**.
///
/// Un sello es asunto propio cuando abre un paso que todavía está POR DELANTE:
/// en `TC_PENDING` el agente enseña el QR precisamente para que caiga
/// `tcCompletedAt`, y anunciárselo como "se registró en otra superficie"
/// sería contarle como noticia ajena el resultado esperado de lo que está
/// haciendo — la forma más rápida de enseñarle a ignorar los banners. Ese paso
/// ya tiene su propio estado de éxito.
///
/// Es noticia AJENA cuando el sello abre un paso que la sesión ya dejó atrás
/// (o donde ya está): el mostrador registrando el pago mientras el agente
/// teclea el odómetro en el paso 7. Eso es exactamente 21C.
///
/// Con cualquiera de los dos pasos fuera del catálogo devuelve **true**
/// (asunto propio ⇒ no se dibuja banner): sin certeza no se le mete un aviso
/// más a alguien que está capturando.
bool stampIsCurrentStepBusiness({
  required CheckoutStampKind kind,
  required CheckoutStep? currentStep,
}) {
  final current = infoFor(currentStep);
  final guarded = infoFor(guardedStepOf(kind));
  if (current == null || guarded == null) return true;
  return guarded.position > current.position;
}

/// Qué le pasó a un sello entre la entrada del agente y ahora.
enum CheckoutStampStatus {
  /// Cayó MIENTRAS el agente estaba dentro. Es la fila que el banner de
  /// avance ajeno vino a explicar.
  landed,

  /// Ya estaba puesto al entrar. Se muestra igual —"lo hiciste tú · sin
  /// cambios"— porque la pregunta que el agente trae es "¿perdí algo?", y
  /// enseñarle su propio trabajo intacto es la respuesta.
  wasAlreadyDone,

  /// Sigue sin sello. "Pendiente · no lo ha tocado nadie".
  pending,
}

class CheckoutStampChange {
  const CheckoutStampChange({
    required this.kind,
    required this.status,
    this.at,
    this.actor,
    this.actorName,
  });

  final CheckoutStampKind kind;
  final CheckoutStampStatus status;

  /// Cuándo lo estampó el servidor (null en [CheckoutStampStatus.pending]).
  final DateTime? at;

  /// Quién, hasta donde el log permite afirmarlo. Null cuando no hay
  /// transición registrada hacia el paso que este sello guarda.
  final CheckoutActorKind? actor;

  /// Nombre propio del agente ajeno, cuando la presencia lo resuelve. Null
  /// mientras el backend no emita `presence[].actorUserId` — ver
  /// `checkout_attribution.dart`. Degrada a "otro agente", nunca a un hueco.
  final String? actorName;
}

/// Diferencia entre la lectura con la que el agente ENTRÓ y la de ahora.
class CheckoutChangeSet {
  const CheckoutChangeSet({
    required this.stamps,
    required this.stepFrom,
    required this.stepTo,
    required this.observedAt,
  });

  /// Siempre las cuatro, en orden de la cadena: la hoja es un inventario, no
  /// una bandeja de novedades. Omitir las pendientes dejaría al agente sin la
  /// mitad de la respuesta ("¿y el pago?").
  final List<CheckoutStampChange> stamps;

  /// Movimiento del paso, en wire crudo. Null si no se movió — que es el caso
  /// del frame 21C: cayó un sello sin que el paso cambiara.
  final String? stepFrom;
  final String? stepTo;

  /// De cuándo es esta comparación (la última lectura aplicada).
  final DateTime observedAt;

  bool get stepMoved => stepFrom != null && stepTo != null;

  /// ¿Se movió algo desde que entró? Con `false` la hoja sigue teniendo
  /// sentido —dice "nadie ha tocado nada"— pero el banner no debería haber
  /// aparecido.
  bool get hasChanges =>
      stepMoved ||
      stamps.any((s) => s.status == CheckoutStampStatus.landed);

  /// Sellos que el agente puso ÉL MISMO antes de que llegara el avance ajeno.
  /// Es la evidencia detrás de "nada de lo que hiciste se perdió".
  Iterable<CheckoutStampChange> get mine => stamps.where(
        (s) =>
            s.actor == CheckoutActorKind.you &&
            s.status != CheckoutStampStatus.pending,
      );
}

DateTime? _stampAt(CheckoutSessionDto s, CheckoutStampKind kind) =>
    switch (kind) {
      CheckoutStampKind.tc => s.tcCompletedAt,
      CheckoutStampKind.payment => s.paymentCompletedAt,
      CheckoutStampKind.inspection => s.inspectionCompletedAt,
      CheckoutStampKind.signature => s.customerSignedAt,
    };

/// Construye el diff. [baseline] es la PRIMERA lectura de esta visita: el
/// controller la congela al entrar y no la vuelve a tocar, porque "desde que
/// entraste" tiene que seguir significando lo mismo diez minutos después.
///
/// [namesById] viene de `presenceNamesById`; vacío ⇒ sin nombres propios y el
/// copy cae al genérico de H1.
CheckoutChangeSet buildChangeSet({
  required CheckoutSessionDto? baseline,
  required CheckoutSessionDto current,
  required DateTime observedAt,
  String? myUserId,
  Map<String, String> namesById = const {},
}) {
  final events = parseCheckoutEvents(current.events);
  final stamps = <CheckoutStampChange>[];
  for (final kind in CheckoutStampKind.values) {
    final now = _stampAt(current, kind);
    if (now == null) {
      stamps.add(CheckoutStampChange(
        kind: kind,
        status: CheckoutStampStatus.pending,
      ));
      continue;
    }
    final before = baseline == null ? null : _stampAt(baseline, kind);
    final event = lastTransitionTo(events, _guardedStepWire(kind));
    stamps.add(CheckoutStampChange(
      kind: kind,
      // Sin baseline (entramos con la sesión ya en marcha y sin lectura
      // previa) no se puede afirmar que algo cayó MIENTRAS mirábamos: se dice
      // lo conservador, que ya estaba.
      status: before == null && baseline != null
          ? CheckoutStampStatus.landed
          : CheckoutStampStatus.wasAlreadyDone,
      at: now,
      actor: event?.actorKind(myUserId),
      actorName: resolveActorName(
        event,
        namesById: namesById,
        myUserId: myUserId,
      ),
    ));
  }

  final moved =
      baseline != null && baseline.currentStep != current.currentStep;
  return CheckoutChangeSet(
    stamps: stamps,
    stepFrom: moved ? baseline.currentStep : null,
    stepTo: moved ? current.currentStep : null,
    observedAt: observedAt,
  );
}

/// Fases ya cerradas / totales para el pill "3 de 5 fases" de la antesala
/// (23A). Sale del catálogo de PRESENTACIÓN y de la posición que reporta el
/// servidor — no predice ninguna fase futura.
({int done, int total}) phaseProgress(int? currentPosition) {
  var done = 0;
  for (final phase in kCheckoutPhases) {
    if (phaseStateFor(phase, currentPosition) == PhaseNodeState.done) done++;
  }
  return (done: done, total: kCheckoutPhases.length);
}
