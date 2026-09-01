import 'package:flutter/foundation.dart';

import '../../../core/api/api_error.dart';
import '../../../core/api/dto/checkout_session.dart';
import '../../../core/api/dto/reservation_display.dart';
import '../../../core/api/enums.dart';
import '../domain/checkout_changes.dart';
import '../domain/checkout_confirm.dart';
import '../domain/checkout_event_log.dart';
import '../domain/checkout_step_catalog.dart';

/// Qué clase de avance ajeno hubo. La distinción decide el COPY, y el copy
/// decide si el agente suelta lo que está haciendo (mockup 21A vs. 21C).
enum ForeignAdvanceKind {
  /// El `currentStep` se movió: el paso que el agente miraba lo cerró otro.
  stepMoved,

  /// Cayó un SELLO sin que el paso se moviera (M2-H6, frame 21C). Pasa de
  /// verdad y es el caso que más daño hace en el patio: el mostrador registra
  /// el pago mientras el agente teclea el odómetro en el paso 7. El banner
  /// dice "este paso no cambió" justamente para que **no** suelte el
  /// formulario — y por eso es aditivo y jamás reconstruye el cuerpo del paso.
  stampLanded,
}

/// Aviso NO bloqueante de que otra superficie movió la sesión (mockup 8C/21).
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
    this.kind = ForeignAdvanceKind.stepMoved,
    this.stamp,
    this.actorName,
    this.at,
  });

  /// Paso que ESTÁBAMOS viendo y que alguien más completó (crudo: puede no
  /// estar en el catálogo).
  final String completedStep;

  /// Paso al que saltó el servidor.
  final String currentStep;
  final CheckoutActorKind actor;
  final ForeignAdvanceKind kind;

  /// Solo en [ForeignAdvanceKind.stampLanded]: cuál sello cayó.
  final CheckoutStampKind? stamp;

  /// Nombre propio del agente ajeno cuando la presencia lo resuelve. Null ⇒
  /// el banner cae al copy genérico de H1 («otro agente»), que es lo que hay
  /// hoy: la degradación es a lo ya construido, no a un hueco. Ver
  /// `checkout_attribution.dart` — es el único punto que consume
  /// `presence[].actorUserId`.
  final String? actorName;

  /// Cuándo lo registró el log — alimenta el "hace 40 s" del banner.
  final DateTime? at;
}

/// Escrituras del paso que no mueven `currentStep` (M2-H2).
enum CheckoutMutation {
  /// `POST /:id/declined-insurance` — el switch de 9C.
  declinedInsurance,

  /// `POST /:id/vehicle` — el swap de 9E.
  vehicleSwap,

  /// `POST /:id/customer-signature` — la firma que el cliente acaba de dejar
  /// en el lienzo (18B). Es una escritura del PASO, no una transición: el
  /// `currentStep` no se mueve, solo cae el sello `customerSignedAt`.
  customerSignature,
}

/// Resultado de la matriz 409 (ADR-4). Nunca es un reintento a ciegas: cada
/// caso ya viene DESPUÉS del re-fetch de reconciliación.
enum CheckoutConflictKind {
  /// 409 `ILLEGAL_TRANSITION` cuya reconciliación dejó la sesión **antes** del
  /// destino: no es "ya lo hicieron", es "ese paso todavía no toca" (M2-H6,
  /// frame 22A). Hasta H6 caía en [generic], que le daba al agente un cartel
  /// sin salida; la salida real es NAVEGAR al paso que sí toca.
  ///
  /// La puerta falsa que este kind existe para NO dibujar es "Reintentar":
  /// `FORWARD` es estrictamente lineal y dirigido (state-machine.js:59-71),
  /// así que ese reintento da 409 para siempre.
  tooEarly,

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
    this.attemptedStep,
    this.currentStep,
    this.swapAvailable = false,
    this.conflictReservationRef,
  });

  final CheckoutConflictKind kind;

  /// Mensaje del backend, sin inventar (DoD #5).
  final String message;
  final String? code;

  /// Solo en [CheckoutConflictKind.entryGuard]: qué sello falta.
  final CheckoutEntryGuard? guard;

  /// Paso que el agente PIDIÓ y el servidor negó. Con él, 22A puede nombrar
  /// el callejón ("el cobro es el paso 4") sin que la app deduzca nada de la
  /// máquina de estados: los dos números salen del catálogo de presentación.
  final CheckoutStep? attemptedStep;

  /// Paso en el que la sesión quedó DESPUÉS de reconciliar. Es el destino del
  /// CTA "Ir al paso N", que es navegación local y por eso no puede fallar.
  final CheckoutStep? currentStep;

  /// Solo en [CheckoutConflictKind.vehicleConflict]: ¿el swap todavía es legal
  /// en el paso en que quedó la sesión?
  ///
  /// **La regla de las puertas falsas de esta historia vive aquí.**
  /// `vehicle-swap.service.js:46-51` cierra el swap a partir de
  /// `INSPECTION_IN_PROGRESS` (409 `SWAP_LOCKED`), así que dibujar "Elegir
  /// otro vehículo" pasado ese punto sería un botón que da 409 para siempre.
  /// Con `false` la pantalla NOMBRA el callejón (se resuelve en el mostrador)
  /// en vez de ofrecer una acción imposible.
  final bool swapAvailable;

  /// Número de la reserva que se llevó la unidad, **leído del texto** del
  /// mensaje del servidor (puente documentado; el pedido que lo cierra de
  /// verdad es `conflictReservationId` en el cuerpo del 409).
  ///
  /// Null cuando no se pudo leer ⇒ el botón "Buscar R-…" **no se dibuja** y el
  /// resto de la pantalla queda igual. La degradación es a "sin botón", jamás
  /// a un botón que busca una reserva inventada.
  final String? conflictReservationRef;
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
    this.returnAt,
    this.returnLocationName,
    this.reservationStatus,
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

  /// Cuándo y dónde vuelve el coche — las dos filas de "Antes de que se vaya"
  /// (19A) que el agente dice en voz alta con el cliente todavía enfrente. La
  /// sede es la de DEVOLUCIÓN de la reserva, no la del selector del agente:
  /// en un one-way no son la misma y equivocarla manda al cliente al patio
  /// equivocado.
  final DateTime? returnAt;
  final String? returnLocationName;

  /// `Reservation.status` crudo. Lo lee el cierre (19A/19B) para VERIFICAR si
  /// la entrega quedó registrada, porque la sesión terminal no lo prueba: la
  /// cascada del finalize corre DESPUÉS del `CLOSED` y se traga varios de sus
  /// errores (checkout-session.service.js:417, :526, :533, :557, :571).
  final String? reservationStatus;

  /// Veredicto tipado sobre [reservationStatus]. `null` = el servidor no lo
  /// dijo (o dijo algo que esta versión no conoce) ⇒ **no se afirma nada**;
  /// ni "quedó registrada" ni "no quedó".
  bool? get handoverRecorded =>
      ReservationStatus.tryParse(reservationStatus)?.handoverRecorded;

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
    this.contextVerdict = ContextVerdict.checking,
    this.contextError,
    this.contextFetchedAt,
    this.pending = false,
    this.baseline,
    this.joinAcknowledged = false,
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

  /// Qué pasó con la ÚLTIMA consulta a `display-data`.
  ///
  /// **`context == null` ya no significa "el servidor no tiene los datos"**.
  /// Antes sí lo parecía —`_loadContext` devolvía null tanto cuando la reserva
  /// venía vacía como cuando la petición se caía— y el paso CONFIRMING
  /// convertía ese null en "faltan el nombre, la licencia y el teléfono",
  /// bloqueaba la entrega y se lo decía al agente como un hecho del servidor.
  /// El veredicto de tres valores es lo que separa las dos historias, igual
  /// que `HandoverVerdict` las separa en el cierre (M2-H5).
  final ContextVerdict contextVerdict;

  /// La negativa CRUDA de la última consulta fallida, para poder citarla sin
  /// inventar diagnóstico (DoD #5). Null cuando la consulta fue bien o cuando
  /// murió sin cuerpo (red): ahí la pantalla pone su copy traducido.
  final ApiError? contextError;

  /// Momento de la última consulta EXITOSA a display-data — la EDAD del dato
  /// del cliente.
  ///
  /// Es un sello propio y no [fetchedAt]: ese mide la lectura de la SESIÓN, y
  /// las dos se caen por separado. display-data puede devolver 404/5xx con el
  /// poll de la sesión perfectamente sano, y entonces `offline` es false, el
  /// shell no pinta ninguna vejez y la tarjeta del cliente se quedaba verde
  /// con "Verificado" sobre datos de hace diez minutos — justo mientras el
  /// agente la confronta con la licencia física.
  final DateTime? contextFetchedAt;

  final bool pending;

  /// PRIMERA lectura de esta visita, congelada. Es el "desde que entraste" del
  /// diff de 21B: si se moviera con cada poll, la hoja diría "no cambió nada"
  /// treinta segundos después de que cambiara todo.
  ///
  /// Se congela una sola vez y NO se reinicia al reconciliar — reconciliar es
  /// justo lo que el agente quiere ver reflejado ahí.
  final CheckoutSessionDto? baseline;

  /// El agente ya vio la antesala de enganche (23A) y decidió continuar. Vive
  /// en el estado y no en la pantalla porque tiene que sobrevivir a un
  /// re-render del poll: una antesala que reaparece cada 5 s sería una puerta
  /// que se cierra sola en la cara.
  final bool joinAcknowledged;

  /// ¿Hay que enseñar la antesala (23A/B/C) antes de empujar al agente a
  /// trabajar?
  ///
  /// Regla del mockup (nota 25): **solo cuando hay algo que contar** — la
  /// sesión no estaba en el paso 1 al llegar, o la abrió otra persona. Una
  /// sesión que el propio agente acaba de crear entra directo, como hoy:
  /// meterle una antesala a un checkout recién abierto es un toque de más por
  /// cada salida del día.
  ///
  /// **Se decide sobre [baseline], NO sobre la lectura viva**, y esa
  /// diferencia es la historia entera. Con la sesión viva, un avance ajeno que
  /// mueve el paso de 1 a 2 mientras el agente trabaja volvería a abrir la
  /// antesala y lo sacaría de su formulario — o sea, la puerta que se cierra
  /// en la cara justo cuando H6 existe para evitarlo. La antesala responde
  /// "¿con qué me encontré al llegar?"; lo que pasa DESPUÉS es avance ajeno y
  /// se cuenta con un banner.
  ///
  /// [myUserId] null (sesión degradada sin `/me`) ⇒ no se afirma que la abrió
  /// otro; solo decide la posición.
  bool showJoinGate(String? myUserId) {
    final entry = baseline;
    if (entry == null || joinAcknowledged) return false;
    if (entry.isTerminal || isTerminal) return false;
    final startedBy = entry.startedByUserId;
    final byOther =
        myUserId != null && startedBy != null && startedBy != myUserId;
    // `position != 1` y no `step != confirming`: un paso que esta versión no
    // conoce da posición null, y ahí SÍ conviene la antesala (el agente
    // aterriza en algo que la app no sabe nombrar).
    return byOther || infoFor(entry.step)?.position != 1;
  }

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
    ContextVerdict? contextVerdict,
    ApiError? contextError,
    bool clearContextError = false,
    DateTime? contextFetchedAt,
    bool? pending,
    CheckoutSessionDto? baseline,
    bool? joinAcknowledged,
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
      contextVerdict: contextVerdict ?? this.contextVerdict,
      contextError:
          clearContextError ? null : (contextError ?? this.contextError),
      contextFetchedAt: contextFetchedAt ?? this.contextFetchedAt,
      // Se REENVÍA: sin esto, cualquier copyWith sobre un estado `.pending()`
      // lo apagaba en silencio (hoy lo enmascaran las otras condiciones de
      // [firstLoad], pero es una trampa puesta para H2-H7).
      pending: pending ?? this.pending,
      baseline: baseline ?? this.baseline,
      joinAcknowledged: joinAcknowledged ?? this.joinAcknowledged,
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

/// Intento de transición CON el cuerpo del servidor.
///
/// Existe por el cierre (M2-H5): `transitionTo` devuelve solo el veredicto, y
/// eso alcanza para un botón que avanza. No alcanza para 19B, donde la
/// pantalla tiene que CITAR la negativa del servidor ("La unidad U-112 quedó
/// tomada por otra renta abierta") y saber si vino con `code` — porque el
/// mismo POST puede fallar con 409 `VEHICLE_CONFLICT` **o** con 422
/// `NO_VEHICLE_ASSIGNED`, y los dos dejan la sesión ya cerrada.
@immutable
class CheckoutTransitionAttempt {
  const CheckoutTransitionAttempt(
    this.outcome, {
    this.message,
    this.code,
    this.network = false,
  });

  final CheckoutTransitionOutcome outcome;

  /// Mensaje del backend tal cual (DoD #5); null si no hubo negativa o si
  /// vino vacía.
  final String? message;

  /// `code` del 409/422 cuando el servidor lo manda.
  final String? code;

  /// El POST murió SIN respuesta. Es la diferencia entre "el servidor dijo
  /// que no" y "no sabemos si entró" — la única distinción que separa 19B de
  /// 19C, y la que decide si se puede reintentar o hay que consultar.
  final bool network;
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
