import 'package:flutter/foundation.dart';

import '../../../core/api/api_error.dart';
import '../../../core/api/dto/checkout_session.dart';
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

  /// Nombre del tenant para el subtítulo del wizbar. OJO: esta es superficie
  /// de STAFF — aquí sí se puede nombrar al tenant; el filtro
  /// `clientSafeCompanyName` protege las superficies volteadas al cliente.
  final String? tenantName;
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

  /// Posición en la cadena lineal, o null si el paso no está en el catálogo
  /// (desconocido o CANCELLED, que es salida alterna).
  int? get position => infoFor(step)?.position;

  bool get isTerminal => session?.isTerminal ?? false;

  /// Toda transición está bloqueada mientras haya una en vuelo, sin red, o si
  /// la sesión ya es terminal.
  bool get canTransition =>
      session != null && !isTerminal && !offline && !transitionInFlight;

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
    ForeignAdvanceNotice? advance,
    bool clearAdvance = false,
    CheckoutConflict? conflict,
    bool clearConflict = false,
    CheckoutReservationContext? context,
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
      advance: clearAdvance ? null : (advance ?? this.advance),
      conflict: clearConflict ? null : (conflict ?? this.conflict),
      context: context ?? this.context,
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
