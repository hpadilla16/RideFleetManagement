/// Lectura del log `events` de la fila `CheckoutSession` — el string JSON que
/// `appendEvent` (state-machine.js:111-117) va acumulando.
///
/// Es la ÚNICA fuente de atribución que existe hoy sin backend nuevo: cada
/// TRANSITION guarda `{kind, from, to, actorUserId, at, metadata}` y el kiosco
/// además sella `metadata.kiosk = true` (kiosk-checkout.service.js:773). Con
/// eso el banner de avance ajeno puede decir "en el kiosco" / "otro agente"
/// en lugar del inútil "algo cambió".
///
/// Todo aquí es defensivo por diseño: el campo es TEXT libre, escrito por 4
/// superficies y por filas viejas anteriores a que `kind` existiera. Un log
/// ilegible degrada a lista vacía — jamás tumba el poll del wizard.
library;

import 'dart:convert';

/// Quién movió el paso, hasta donde el log permite AFIRMARLO.
enum CheckoutActorKind {
  /// `metadata.kiosk == true` — el kiosco recorre transiciones con
  /// `actorUserId: null`, así que su marca es el metadata.
  kiosk,

  /// Un `actorUserId` distinto al del empleado de este teléfono.
  otherAgent,

  /// El empleado de este teléfono.
  you,

  /// Sin actor ni marca de kiosco (barridos del scheduler, superficies sin
  /// usuario): se dice "otra superficie", no se inventa un culpable.
  otherSurface,
}

class CheckoutEvent {
  const CheckoutEvent({
    this.kind,
    this.from,
    this.to,
    this.field,
    this.actorUserId,
    this.at,
    this.kiosk = false,
    this.reason,
    this.declined,
  });

  /// SESSION_STARTED | TRANSITION | ABANDONED | … (puede faltar en filas
  /// viejas: [isTransition] no depende de él).
  final String? kind;
  final String? from;
  final String? to;

  /// Columna sellada por un evento `SIDE_EFFECT` (`tcCompletedAt`,
  /// `paymentCompletedAt`, …). `stampSideEffect`
  /// (checkout-session.service.js:1042-1044) escribe `{kind, field, at}` y
  /// **nada más**: sin `actorUserId` y sin `metadata`. Por eso un sello que
  /// cae solo puede fecharse, jamás atribuirse a alguien — y el copy de 21C
  /// dice "otra superficie", que es exactamente lo que se sabe.
  final String? field;
  final String? actorUserId;
  final DateTime? at;

  /// `metadata.kiosk == true`.
  final bool kiosk;
  final String? reason;

  /// Payload del evento `DECLINED_INSURANCE` (service:841-845). Es la ÚNICA
  /// lectura server-side del switch de 9C que existe hoy: display-data no
  /// devuelve `agreement.declinedInsurance` (ver el WHY en el DTO).
  final bool? declined;

  /// Una entrada con destino ES una transición aunque no traiga `kind`
  /// (tolerancia a filas escritas antes de que `appendEvent` lo sellara).
  bool get isTransition => to != null && to!.isNotEmpty;

  /// Atribución de ESTE evento respecto del empleado del teléfono.
  /// [myUserId] null (sesión degradada sin /me) ⇒ nunca se afirma "ti".
  CheckoutActorKind actorKind(String? myUserId) {
    if (kiosk) return CheckoutActorKind.kiosk;
    if (actorUserId == null) return CheckoutActorKind.otherSurface;
    if (myUserId != null && actorUserId == myUserId) {
      return CheckoutActorKind.you;
    }
    return CheckoutActorKind.otherAgent;
  }

  static CheckoutEvent _fromMap(Map<String, dynamic> map) {
    final metadata = map['metadata'];
    return CheckoutEvent(
      kind: map['kind'] as String?,
      from: map['from'] as String?,
      to: map['to'] as String?,
      field: map['field'] as String?,
      actorUserId: map['actorUserId'] as String?,
      at: DateTime.tryParse(map['at'] as String? ?? ''),
      kiosk: metadata is Map && metadata['kiosk'] == true,
      reason: map['reason'] as String?,
      declined: map['declined'] as bool?,
    );
  }
}

/// Parsea el log completo en orden cronológico de escritura (el backend
/// hace push, así que el último elemento es el más reciente).
List<CheckoutEvent> parseCheckoutEvents(String? rawJson) {
  if (rawJson == null || rawJson.isEmpty) return const [];
  Object? decoded;
  try {
    decoded = json.decode(rawJson);
  } catch (_) {
    return const []; // log corrupto: sin atribución, pero sin caída
  }
  if (decoded is! List) return const [];
  final out = <CheckoutEvent>[];
  for (final item in decoded) {
    if (item is Map<String, dynamic>) out.add(CheckoutEvent._fromMap(item));
  }
  return out;
}

/// Última transición registrada HACIA [toStep] (wire crudo, p. ej.
/// 'PAYMENT_PENDING'). Null si el log no la tiene — pasa de verdad: el sweep
/// nocturno y algunas superficies escriben tarde o el log se truncó.
CheckoutEvent? lastTransitionTo(List<CheckoutEvent> events, String toStep) {
  for (var i = events.length - 1; i >= 0; i--) {
    final e = events[i];
    if (e.isTransition && e.to == toStep) return e;
  }
  return null;
}

/// Último evento de [kind] (`DECLINED_INSURANCE`, `VEHICLE_SWAP`,
/// `TOKEN_MINTED`…). El backend hace push, así que el último gana.
CheckoutEvent? lastEventOfKind(List<CheckoutEvent> events, String kind) {
  for (var i = events.length - 1; i >= 0; i--) {
    if (events[i].kind == kind) return events[i];
  }
  return null;
}

/// Último `SIDE_EFFECT` que selló [field] (`tcCompletedAt`, `paymentCompletedAt`,
/// `inspectionCompletedAt`, `customerSignedAt`).
///
/// Sirve para UNA cosa: fechar el sello que acaba de caer sin que el paso se
/// moviera (frame 21C, "hace 12 s"). No sirve para atribuirlo — el backend no
/// escribe actor en esos eventos, y decir "el mostrador" sin saberlo sería
/// inventar un culpable en el registro de una entrega.
CheckoutEvent? lastSideEffectFor(List<CheckoutEvent> events, String field) {
  for (var i = events.length - 1; i >= 0; i--) {
    final e = events[i];
    if (e.kind == 'SIDE_EFFECT' && e.field == field) return e;
  }
  return null;
}

/// Cómo se pausó la sesión, según `abandonedReason`.
///
/// El campo es TEXT libre y lo escriben cosas muy distintas: la app manda
/// `agent_paused` (checkout-session.service.js:1298 lo pone también como
/// default), el barrido nocturno escribe
/// `auto_flagged_stalled_at_<paso>` (scheduler:71), y una superficie puede
/// meter texto humano ("el cliente fue por su tarjeta").
///
/// Existe porque mostrarlo crudo produce «Motivo: "agent_paused"» en la cara
/// del agente, que es exactamente el pecado que la lámina prohíbe: un token de
/// máquina no se le enseña a nadie en el patio.
enum CheckoutAbandonKind {
  /// Alguien la pausó a mano desde una superficie de staff.
  agentPaused,

  /// El barrido la marcó por llevar >4 h detenida. **NADIE la pausó** — y esa
  /// diferencia importa: decir "otro agente la pausó" sería inventar un
  /// culpable de algo que hizo un cron.
  autoStalled,

  /// Texto escrito por una persona: se muestra tal cual, entre comillas.
  freeText,

  /// Un token de máquina que esta versión no conoce. Se SUPRIME: sin
  /// traducción, enseñarlo es ruido con forma de dato.
  unknownToken,
}

/// Snake_case de máquina: minúsculas, dígitos y guiones bajos, sin espacios.
/// Un motivo humano casi siempre lleva espacios o mayúsculas.
final _machineToken = RegExp(r'^[a-z0-9]+(?:_[a-z0-9]+)*$');

CheckoutAbandonKind classifyAbandonReason(String? raw) {
  final value = raw?.trim() ?? '';
  if (value.isEmpty) return CheckoutAbandonKind.unknownToken;
  if (value == 'agent_paused') return CheckoutAbandonKind.agentPaused;
  if (value.startsWith('auto_flagged_stalled_at_')) {
    return CheckoutAbandonKind.autoStalled;
  }
  if (_machineToken.hasMatch(value)) return CheckoutAbandonKind.unknownToken;
  return CheckoutAbandonKind.freeText;
}
