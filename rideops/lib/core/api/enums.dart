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
