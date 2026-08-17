import 'package:drift/drift.dart';

part 'outbox_db.g.dart';

/// Bandeja de salida cifrada (ADR-7, M0-7).
///
/// El archivo se abre con SQLCipher (NativeDatabase + `PRAGMA key`), con la
/// llave guardada en secure storage — este esquema guarda PII (firmas, fotos
/// de daños, nombres) en un teléfono compartido de patio.
///
/// Reglas que el esquema hace cumplir:
///  - Toda fila queda atada a QUIÉN la creó ([userId], [tenantId],
///    [locationId] activa del selector). Al cambiar de cuenta, las filas de
///    otro usuario se purgan — nunca se drenan con las credenciales de otro.
///  - [idempotencyKey] es única: encolar dos veces la misma escritura es un
///    no-op.
///  - [dependsOn] ordena el drenado (las fotos antes del complete de la
///    inspección; el complete depende de la última foto).
///  - [status] = pending | inflight | dead. `dead` es visible al usuario
///    (DoD: dead-letter con mensaje claro), nunca un descarte silencioso.
class OutboxEntries extends Table {
  TextColumn get id => text()();
  TextColumn get userId => text()();
  TextColumn get tenantId => text()();

  /// Ubicación activa (`x-view-location`) al momento de crear la fila, o
  /// null si el usuario opera sin override.
  TextColumn get locationId => text().nullable()();

  /// Tipo de operación: inspection_photo | inspection_complete | ...
  /// El dinero NUNCA aparece aquí (ADR-5) — el drenador rechaza kinds
  /// desconocidos y no existe kind de pago.
  TextColumn get kind => text()();

  /// Payload JSON de la operación (para fotos: path del archivo cifrado en
  /// disco + angleKey + sessionId/reservationId — el binario no vive en la
  /// fila para que la DB no explote).
  TextColumn get payload => text()();

  /// id de otra fila que debe drenar ANTES que esta, o null.
  TextColumn get dependsOn => text().nullable()();

  TextColumn get idempotencyKey => text().unique()();
  IntColumn get attempts => integer().withDefault(const Constant(0))();
  TextColumn get lastError => text().nullable()();
  TextColumn get lastErrorCode => text().nullable()();
  TextColumn get status => text().withDefault(const Constant('pending'))();
  DateTimeColumn get createdAt => dateTime()();
  DateTimeColumn get updatedAt => dateTime()();

  @override
  Set<Column<Object>> get primaryKey => {id};
}

@DriftDatabase(tables: [OutboxEntries])
class OutboxDb extends _$OutboxDb {
  OutboxDb(super.executor);

  @override
  int get schemaVersion => 1;

  /// Tope de tamaño (M0-7): con la bandeja llena se rechaza encolar y la UI
  /// lo dice — mejor un "no cabe, conéctate" honesto que un teléfono con 2 GB
  /// de fotos sin subir que luego se pierde.
  static const maxRows = 500;

  Future<int> pendingCount() async {
    final c = countAll();
    final q = selectOnly(outboxEntries)
      ..addColumns([c])
      ..where(outboxEntries.status.equals('pending'));
    final row = await q.getSingle();
    return row.read(c) ?? 0;
  }

  /// Filas drenables del usuario/tenant actual, en orden de creación. El
  /// drenador resuelve [OutboxEntries.dependsOn] encima de esto.
  Future<List<OutboxEntry>> pendingFor({
    required String userId,
    required String tenantId,
  }) {
    return (select(outboxEntries)
          ..where((t) =>
              t.status.equals('pending') &
              t.userId.equals(userId) &
              t.tenantId.equals(tenantId))
          ..orderBy([(t) => OrderingTerm.asc(t.createdAt)]))
        .get();
  }

  /// Purga por cambio de cuenta (ADR-7): TODO lo que no sea del usuario
  /// entrante se borra — las filas están atadas a quien las creó y jamás se
  /// drenan con credenciales ajenas.
  Future<int> purgeNotOwnedBy({required String userId}) {
    return (delete(outboxEntries)..where((t) => t.userId.equals(userId).not()))
        .go();
  }

  Future<void> markInflight(String id) => _setStatus(id, 'inflight');

  Future<void> markDrained(String id) =>
      (delete(outboxEntries)..where((t) => t.id.equals(id))).go();

  Future<void> markFailed(
    String id, {
    required String error,
    String? code,
    required bool dead,
  }) {
    return (update(outboxEntries)..where((t) => t.id.equals(id))).write(
      OutboxEntriesCompanion(
        status: Value(dead ? 'dead' : 'pending'),
        lastError: Value(error),
        lastErrorCode: Value(code),
        attempts: Value.absent(),
        updatedAt: Value(DateTime.now()),
      ),
    );
  }

  Future<void> _setStatus(String id, String status) {
    return (update(outboxEntries)..where((t) => t.id.equals(id))).write(
      OutboxEntriesCompanion(
        status: Value(status),
        updatedAt: Value(DateTime.now()),
      ),
    );
  }
}
