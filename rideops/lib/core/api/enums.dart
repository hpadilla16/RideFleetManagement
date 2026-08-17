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
