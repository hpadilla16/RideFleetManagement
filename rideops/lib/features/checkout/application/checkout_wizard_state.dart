import 'package:flutter/foundation.dart';

import '../../../core/api/api_error.dart';
import '../../../core/api/dto/checkout_session.dart';
import '../../../core/api/dto/reservation_display.dart';
import '../../../core/api/enums.dart';
import '../domain/checkout_event_log.dart';
import '../domain/checkout_step_catalog.dart';

/// Aviso NO bloqueante de que otra superficie movió el paso (mockup 8C).
///
/// Persiste hasta que el agente interactúa con el paso nuevo: con 4
/// superficies conviviendo, un modal por avance ajeno sería un bloqueo cada
/// pocos minutos.
@immutable
class ForeignAdvanceNotice {
  const ForeignAdvanceNotice({
    required this.completedStep,
    required this.currentStep,
    required this.actor,
    this.at,
  });

  /// Paso que ESTÁBAMOS viendo y que alguien más completó (crudo: puede no
  /// estar en el catálogo).
  final String completedStep;

  /// Paso al que saltó el servidor.
  final String currentStep;
  final CheckoutActorKind actor;

  /// Cuándo lo registró el log — alimenta el "hace 40 s" del banner.
  final DateTime? at;
}

/// Escrituras del paso que no mueven `currentStep` (M2-H2).
enum CheckoutMutation {
  /// `POST /:id/declined-insurance` — el switch de 9C.
  declinedInsurance,

  /// `POST /:id/vehicle` — el swap de 9E.
  vehicleSwap,
}

/// Resultado de la matriz 409 (ADR-4). Nunca es un reintento a ciegas: cada
/// caso ya viene DESPUÉS del re-fetch de reconciliación.
enum CheckoutConflictKind {
  /// 409 `ENTRY_GUARD` — falta un sello previo. Se muestra QUÉ falta.
  entryGuard,

  /// 409 `VEHICLE_CONFLICT` — el gancho de H1; la pantalla de swap es H2.
  vehicleConflict,

  /// 409 `SESSION_TERMINAL` / `CHECKOUT_TERMINAL` — o el 409 SIN code del
  /// abandon sobre una sesión terminal.
  terminal,

  /// 409 `SWAP_LOCKED` del swap (vehicle-swap.service.js:46-51). Tiene kind
  /// propio porque su cuerpo del servidor **filtra un enum crudo de base de
  /// datos** (`currentStep=INSPECTION_IN_PROGRESS`): el mensaje se sigue
  /// mostrando (DoD #5), pero encima va una línea de causa traducida — mismo
  /// tratamiento que `ENTRY_GUARD` (review INN-S-2).
  swapLocked,

  /// 409 con code desconocido: se muestra el mensaje del servidor tal cual.
  generic,
}

@immutable
class CheckoutConflict {
  const CheckoutConflict({
    required this.kind,
    required this.message,
    this.code,
    this.guard,
  });

  final CheckoutConflictKind kind;

  /// Mensaje del backend, sin inventar (DoD #5).
  final String message;
  final String? code;

  /// Solo en [CheckoutConflictKind.entryGuard]: qué sello falta.
  final CheckoutEntryGuard? guard;
}

/// Contexto de la reserva para el header de sesión (8A). Best-effort: el
/// wizard funciona sin él, solo con menos contexto — igual que la inspección.
@immutable
class CheckoutReservationContext {
  const CheckoutReservationContext({
    this.reservationNumber,
    this.customerName,
    this.vehicleLabel,
    this.plate,
    this.odometer,
    this.tenantName,
    this.pickupAt,
    this.precheckinDone = false,
    this.precheckinAt,
    this.workflowMode,
    this.customer,
    this.agreement,
    this.vehicleId,
    this.vehicleStatus,
    this.vehicleTypeId,
    this.branding,
  });

  final String? reservationNumber;
  final String? customerName;
  final String? vehicleLabel;
  final String? plate;
  final int? odometer;

  /// "Salida hoy 10:30" — la tercera respuesta del patio (mockup 8A).
  final DateTime? pickupAt;

  /// `customerInfoCompletedAt` sellado. Se muestra ANTES de que el 422
  /// PRECHECKIN_REQUIRED pueda aparecer al crear la sesión (H7).
  final bool precheckinDone;

  /// CUÁNDO se selló el pre-checkin. El controller ya leía la fecha y solo
  /// guardaba el bool; la tarjeta 9A dice "Completado 18:42" (review GD-MC-6),
  /// que es el dato con el que el agente decide si confía en la captura.
  final DateTime? precheckinAt;

  /// `Reservation.workflowMode` crudo. Decide si el switch del seguro
  /// EXISTE: un loaner recibe contrato compañero de $0 y el POST del anexo
  /// funcionaría, estampando un rechazo de cobertura sobre una cortesía
  /// (review INN-MC-3).
  final String? workflowMode;

  /// Reserva de cortesía del programa de loaners. Null (backend viejo, o
  /// display-data que no respondió) NO se trata como loaner: el default del
  /// modelo es RENTAL y esconder el switch por falta de dato sería inventar.
  bool get isLoaner =>
      ReservationWorkflowMode.tryParse(workflowMode) ==
      ReservationWorkflowMode.dealershipLoaner;

  /// Nombre del tenant para el subtítulo del wizbar. OJO: esta es superficie
  /// de STAFF — aquí sí se puede nombrar al tenant; el filtro
  /// `clientSafeCompanyName` protege las superficies volteadas al cliente.
  final String? tenantName;

  /// Filas de verificación del paso CONFIRMING (9A/9B). Se guardan crudas —
  /// no aplanadas — porque la tarjeta necesita distinguir "no vino el dato"
  /// de "el servidor dice que está vacío", y esa distinción es justamente la
  /// que decide si el CTA se bloquea.
  final DisplayCustomer? customer;
  final DisplayAgreement? agreement;

  /// Unidad asignada AHORA (para marcar la fila actual del sheet de swap).
  final String? vehicleId;

  /// `Vehicle.status` crudo de la unidad asignada.
  final String? vehicleStatus;

  /// Clase reservada: el sheet dice "mismo grupo" comparando con esto.
  final String? vehicleTypeId;

  /// Branding del tenant tal como lo devuelve display-data. Las superficies
  /// volteadas al cliente (10B) SIEMPRE lo consumen por
  /// `clientSafeCompanyName`, que neutraliza el centinela de plataforma
  /// 'Ride Fleet'; [tenantName] es la variante de staff y no vale ahí.
  final TenantBranding? branding;
}

/// Estado del wizard. El cache es EN MEMORIA y con edad visible: al perder la
/// red el dato viejo se queda en pantalla diciendo su edad (8D), nunca se
/// borra ni se disfraza de vivo.
@immutable
class CheckoutWizardState {
  const CheckoutWizardState({
    this.session,
    this.fetchedAt,
    this.fetching = false,
    this.error,
    this.notFound = false,
    this.viewLocationDenied = false,
    this.networkAvailable = true,
    this.transitionInFlight = false,
    this.pausing = false,
    this.mutating,
    this.advance,
    this.conflict,
    this.context,
    this.pending = false,
  });

  /// Esperando el gate de arranque (sesión/sede sin hidratar): no hubo fetch
  /// todavía — se muestra el skeleton 8F, no un error.
  const CheckoutWizardState.pending() : this(pending: true);

  /// Última lectura del servidor. ADR-4: TODO lo que se dibuja sale de aquí.
  final CheckoutSessionDto? session;

  /// Momento de la última lectura EXITOSA — la edad que la stepline muestra.
  final DateTime? fetchedAt;
  final bool fetching;

  /// Último error de lectura; null tras un éxito.
  final ApiError? error;

  /// 404 de `by-reservation`: la reserva no tiene sesión todavía. No es un
  /// error — la creación es M2-H7 (con su matriz de guards 422/409).
  final bool notFound;

  final bool viewLocationDenied;

  /// Señal de interfaz de red (connectivity_plus). Es solo la mitad de
  /// [offline]: un Wi-Fi cautivo dice "hay red" y el veredicto real lo da la
  /// request.
  final bool networkAvailable;

  /// Guard anti-doble-tap: hay un POST /transition en vuelo.
  final bool transitionInFlight;

  /// Hay un POST /abandon en vuelo.
  final bool pausing;

  /// Escritura del PASO en vuelo que NO es una transición (M2-H2:
  /// `declined-insurance`, `vehicle`). Se distingue de [transitionInFlight]
  /// porque no mueve `currentStep` — pero vale lo mismo para el poll: la
  /// respuesta del POST es más nueva por definición y una lectura lanzada en
  /// paralelo solo puede aterrizar tarde y vieja (INN MC-2).
  ///
  /// Guarda CUÁL escritura, no un bool: la fila que se está escribiendo es la
  /// única que puede mostrar spinner, y así dos controles distintos no se
  /// apagan juntos por una escritura ajena.
  final CheckoutMutation? mutating;

  bool get isMutating => mutating != null;

  final ForeignAdvanceNotice? advance;
  final CheckoutConflict? conflict;
  final CheckoutReservationContext? context;
  final bool pending;

  /// Primer load: sin datos y sin veredicto — skeleton 8F.
  bool get firstLoad =>
      pending || (session == null && error == null && !notFound);

  /// Offline HONESTO: o no hay interfaz, o la última lectura murió sin
  /// respuesta. Con esto se deshabilitan las transiciones NOMBRANDO la causa
  /// (nunca se esconden) y se tiñe la stepline.
  bool get offline =>
      !networkAvailable || error?.kind == ApiErrorKind.network;

  /// Paso tipado (null = paso que esta versión no conoce → nodo genérico).
  CheckoutStep? get step => session?.step;

  /// Mensaje del servidor cuando el conflicto VIVO es de vehículo (9D/9E).
  /// Null si no hay conflicto o si es de otro tipo — la unidad inerte del
  /// sheet cae entonces a su motivo genérico en vez de heredar un error ajeno.
  String? get vehicleConflictMessage =>
      conflict?.kind == CheckoutConflictKind.vehicleConflict
          ? conflict?.message
          : null;

  /// Lo último mostrable tras una escritura fallida: el 409 ya reconciliado
  /// si lo hay, y si no el error de red/servidor. Vacío ⇒ null, para que la
  /// pantalla ponga su copy traducido en vez de un hueco (DoD #5).
  String? get conflictOrErrorMessage {
    final message = conflict?.message ?? error?.message ?? '';
    return message.isEmpty ? null : message;
  }

  /// Posición en la cadena lineal, o null si el paso no está en el catálogo
  /// (desconocido o CANCELLED, que es salida alterna).
  int? get position => infoFor(step)?.position;

  bool get isTerminal => session?.isTerminal ?? false;

  /// Toda transición está bloqueada mientras haya una en vuelo, sin red, si la
  /// sesión ya es terminal, o mientras otra escritura del paso está viva
  /// (avanzar con un swap a medio aplicar dejaría al agente firmando sobre
  /// datos que aún no sabe si cambiaron).
  bool get canTransition =>
      session != null &&
      !isTerminal &&
      !offline &&
      !transitionInFlight &&
      !isMutating;

  CheckoutWizardState copyWith({
    CheckoutSessionDto? session,
    DateTime? fetchedAt,
    bool? fetching,
    ApiError? error,
    bool clearError = false,
    bool? notFound,
    bool? viewLocationDenied,
    bool? networkAvailable,
    bool? transitionInFlight,
    bool? pausing,
    CheckoutMutation? mutating,
    bool clearMutating = false,
    ForeignAdvanceNotice? advance,
    bool clearAdvance = false,
    CheckoutConflict? conflict,
    bool clearConflict = false,
    CheckoutReservationContext? context,
    bool? pending,
  }) {
    return CheckoutWizardState(
      session: session ?? this.session,
      fetchedAt: fetchedAt ?? this.fetchedAt,
      fetching: fetching ?? this.fetching,
      error: clearError ? null : (error ?? this.error),
      notFound: notFound ?? this.notFound,
      viewLocationDenied: viewLocationDenied ?? this.viewLocationDenied,
      networkAvailable: networkAvailable ?? this.networkAvailable,
      transitionInFlight: transitionInFlight ?? this.transitionInFlight,
      pausing: pausing ?? this.pausing,
      mutating: clearMutating ? null : (mutating ?? this.mutating),
      advance: clearAdvance ? null : (advance ?? this.advance),
      conflict: clearConflict ? null : (conflict ?? this.conflict),
      context: context ?? this.context,
      // Se REENVÍA: sin esto, cualquier copyWith sobre un estado `.pending()`
      // lo apagaba en silencio (hoy lo enmascaran las otras condiciones de
      // [firstLoad], pero es una trampa puesta para H2-H7).
      pending: pending ?? this.pending,
    );
  }
}

/// Qué pasó con un intento de transición — lo que la pantalla del paso
/// (H2–H5) necesita para decidir si navega, se queda o muestra algo.
enum CheckoutTransitionOutcome {
  /// El servidor aceptó y el estado ya se re-renderizó.
  ok,

  /// Otra superficie ya había hecho ese paso: no-op silencioso + re-render.
  alreadyDone,

  /// 409 con causa mostrable (guard, vehículo, terminal…): ver
  /// [CheckoutWizardState.conflict].
  conflict,

  /// El servidor movió la sesión a OTRO paso mientras el agente decidía: se
  /// abortó el POST y se re-renderizó. El agente vuelve a decidir sobre lo
  /// que hay.
  reconciled,

  /// Bloqueado antes de salir: sin red, sesión terminal, o ya había un POST
  /// en vuelo (doble tap).
  blocked,

  /// Falló por red/servidor; el mensaje está en [CheckoutWizardState.error].
  failed,
}

/// Resultado de un intento de swap, CON el mensaje del servidor.
///
/// El mensaje viaja aquí y no en `state.error` a propósito: una negativa sobre
/// la unidad ELEGIDA no puede quedar guardada como "el error del paso" —
/// acabaría atribuyéndose a la unidad ACTUAL en el sheet, que es justo el dato
/// que el agente está tratando de entender.
@immutable
class CheckoutSwapAttempt {
  const CheckoutSwapAttempt(this.outcome, {this.message, this.code});

  final CheckoutSwapOutcome outcome;

  /// Mensaje del backend tal cual (DoD #5); null si no hubo negativa.
  final String? message;

  /// `code` del 409, cuando lo hay (`VEHICLE_DOUBLE_BOOKED` /
  /// `VEHICLE_TERMINAL` / `SWAP_LOCKED`). Los tres son estables y están
  /// documentados en `vehicle-swap.service.js:46-91`, así que el sheet puede
  /// poner una línea de causa TRADUCIDA encima del cuerpo del servidor sin
  /// parsear texto en inglés (review INN-S-2).
  final String? code;
}

/// Qué pasó con un intento de swap (9E). Se separa de
/// [CheckoutTransitionOutcome] porque el swap NO mueve el paso y sus negativas
/// se resuelven en lugares distintos de la pantalla.
enum CheckoutSwapOutcome {
  /// El servidor cambió la unidad; sesión y contexto ya re-leídos.
  ok,

  /// 409 sobre la unidad ELEGIDA (`VEHICLE_DOUBLE_BOOKED` /
  /// `VEHICLE_TERMINAL`): el sheet se queda abierto, muestra el mensaje del
  /// servidor y recarga su lista.
  vehicleRejected,

  /// 409 `SWAP_LOCKED`: la sesión pasó de inspección y el swap ya no existe.
  /// El sheet se cierra y la negativa queda en el banner del paso.
  lockedStep,

  /// Bloqueado antes de salir: sin red, terminal, o ya había una escritura.
  blocked,

  /// Falló por red/servidor; el mensaje está en [CheckoutWizardState.error].
  failed,
}
