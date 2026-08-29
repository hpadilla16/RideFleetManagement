/// Enums espejados del backend. La paridad la vigila
/// `tool/check_enum_parity.mjs` en CI (M0-8): cada enum aquí declara qué enum
/// de Prisma espeja con el marcador `// mirrors:` y el script truena si
/// cualquiera de los dos lados agrega/quita valores.
///
/// Regla de resiliencia: TODO parseo de wire usa `tryParse(...)` → `null`, y
/// el DTO conserva además el string crudo del backend. Un valor nuevo del
/// servidor no puede crashear una app vieja en el patio: el enum sale null y
/// la UI muestra el estado como texto crudo y sigue viva. OJO: aquí NO hay
/// valores `unknown` a propósito — agregarlos rompería la paridad exacta que
/// vigila `check_enum_parity.mjs` contra los enums de Prisma.
library;

String _wire(String dartName) {
  final buf = StringBuffer();
  for (var i = 0; i < dartName.length; i++) {
    final c = dartName[i];
    final isUpper = c.toUpperCase() == c && c.toLowerCase() != c;
    if (isUpper && i > 0) buf.write('_');
    buf.write(c.toUpperCase());
  }
  return buf.toString();
}

// mirrors: CheckoutStep
enum CheckoutStep {
  confirming,
  tcPending,
  tcSigned,
  paymentPending,
  paid,
  inspectionHandoff,
  inspectionInProgress,
  customerSignPending,
  finalizing,
  closed,
  cancelled;

  String get wire => _wire(name);

  static CheckoutStep? tryParse(String? raw) {
    if (raw == null) return null;
    for (final v in CheckoutStep.values) {
      if (v.wire == raw) return v;
    }
    return null;
  }

  bool get isTerminal => this == closed || this == cancelled;
}

// mirrors: HandoffTokenKind
enum HandoffTokenKind {
  termsSigning,
  mobileInspection,
  customerInspection;

  String get wire => _wire(name);

  static HandoffTokenKind? tryParse(String? raw) {
    if (raw == null) return null;
    for (final v in HandoffTokenKind.values) {
      if (v.wire == raw) return v;
    }
    return null;
  }
}

// mirrors: UserRole
enum UserRole {
  superAdmin,
  admin,
  ops,
  agent;

  String get wire => _wire(name);

  static UserRole? tryParse(String? raw) {
    if (raw == null) return null;
    for (final v in UserRole.values) {
      if (v.wire == raw) return v;
    }
    return null;
  }
}

/// Modo de flujo de la reserva. RideOps lo necesita porque **cambia reglas de
/// producto, no solo etiquetas**: en `DEALERSHIP_LOANER` el backend prepara un
/// contrato compañero de $0 (checkout-session.service.js:245-255), así que el
/// `POST /:id/declined-insurance` responde 200 y estampa un anexo de rechazo de
/// cobertura sobre un contrato de CORTESÍA. El wizard web esconde ese switch
/// (`checkout-wizard-v2/page.js:839`) y RideOps no lo hacía (review INN-MC-3).
///
/// Está aquí, y no como string suelto, justamente para que el chequeo de
/// paridad avise si el backend agrega un modo nuevo: cada modo nuevo obliga a
/// decidir si el switch del seguro aplica o no.
// mirrors: ReservationWorkflowMode
enum ReservationWorkflowMode {
  rental,
  carSharing,
  dealershipLoaner;

  String get wire => _wire(name);

  static ReservationWorkflowMode? tryParse(String? raw) {
    if (raw == null) return null;
    for (final v in ReservationWorkflowMode.values) {
      if (v.wire == raw) return v;
    }
    return null;
  }
}

/// Superficie que late sobre una `CheckoutSession` (`CheckoutSurface`,
/// schema.prisma:5451-5456 y `CHECKOUT_SURFACES` de
/// checkout-presence.service.js:36). Cuatro superficies operan la MISMA fila.
///
/// El espejo aterriza aquí en M2-H6 porque es la historia en la que RideOps
/// deja de ser solo lector y **empieza a latir**: [rideops] es el valor que
/// la app ENVÍA en `POST /:id/presence`, y un typo ahí es un 400
/// `UNKNOWN_SURFACE` que solo se ve en el patio. Con el espejo, el parity
/// check truena en CI si el backend agrega una quinta superficie.
///
/// La LECTURA sigue tolerando lo desconocido (`tryParse` → null ⇒ etiqueta
/// genérica): una superficie nueva del servidor no puede romper el chip de
/// una app vieja.
// mirrors: CheckoutSurface
enum CheckoutSurface {
  rideops,
  counter,
  kiosk,
  customer;

  String get wire => _wire(name);

  static CheckoutSurface? tryParse(String? raw) {
    if (raw == null) return null;
    for (final v in CheckoutSurface.values) {
      if (v.wire == raw) return v;
    }
    return null;
  }

  /// ¿Detrás de esta superficie hay una PERSONA con nombre, o un mueble?
  ///
  /// No es cosmética: el kiosco del lobby y el teléfono del cliente laten con
  /// `actorUserId` null **a propósito** (el aparato no tiene usuario), y el
  /// backend resuelve su nombre con la etiqueta genérica de la superficie. A
  /// "Diego Torres · mostrador" se le grita desde la otra punta del patio; al
  /// kiosco hay que caminarle al lobby.
  bool get isDevice => this == kiosk || this == customer;
}

// mirrors: InspectionPhase
enum InspectionPhase {
  checkout,
  checkin;

  String get wire => _wire(name);

  static InspectionPhase? tryParse(String? raw) {
    if (raw == null) return null;
    for (final v in InspectionPhase.values) {
      if (v.wire == raw) return v;
    }
    return null;
  }
}

/// Estado de la RESERVA (`Reservation.status`, schema.prisma:25-34). RideOps
/// lo lee por una sola razón, y es de honestidad: **el cierre del checkout no
/// es atómico**. `transition(CLOSED)` marca la sesión como terminal ANTES de
/// correr la cascada que avanza la reserva a `CHECKED_OUT`
/// (checkout-session.service.js:417 vs :447-467), y varios tramos de esa
/// cascada se tragan su error (:526, :533, :557, :571). Consecuencia
/// verificada: un 200 puede convivir con una reserva que sigue en
/// `CONFIRMED`, y el 409/422 que sí escapa llega con la sesión ya cerrada.
///
/// Con este enum el frame 19B **verifica** en vez de solo reportar: sesión
/// terminal + reserva sin avanzar es exactamente el estado a medio cerrar.
///
/// Lleva el wire EXPLÍCITO (y no `_wire(name)` como sus hermanos) por un solo
/// valor: `NEW` es palabra reservada de Dart, así que el identificador no
/// puede llamarse igual y la derivación automática lo partiría en `N_E_W`.
// mirrors: ReservationStatus
enum ReservationStatus {
  newReservation('NEW'), // wire: NEW
  confirmed('CONFIRMED'),
  checkedOut('CHECKED_OUT'),
  checkedIn('CHECKED_IN'),
  checkedInUnpaid('CHECKED_IN_UNPAID'),
  cancelled('CANCELLED'),
  noShow('NO_SHOW'),
  pendingFranchiseImport('PENDING_FRANCHISE_IMPORT');

  const ReservationStatus(this.wire);

  final String wire;

  static ReservationStatus? tryParse(String? raw) {
    if (raw == null) return null;
    for (final v in ReservationStatus.values) {
      if (v.wire == raw) return v;
    }
    return null;
  }

  /// La reserva ya quedó entregada (o más allá). Espejo EXACTO del guard
  /// anti-downgrade de `transition()` (checkout-session.service.js:453): si el
  /// estado está en esa lista, la cascada del finalize no vuelve a tocarla.
  bool get handoverRecorded =>
      this == checkedOut || this == checkedIn || this == checkedInUnpaid;
}
