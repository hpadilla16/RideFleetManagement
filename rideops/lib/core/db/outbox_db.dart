import 'package:drift/drift.dart';

part 'outbox_db.g.dart';

/// Bandeja de salida cifrada (ADR-7, M0-7 → abierta de verdad en M1-H5).
///
/// El archivo se abre con SQLCipher (NativeDatabase + `PRAGMA key`), con la
/// llave guardada en secure storage — este esquema guarda PII (firmas, fotos
/// de daños, nombres) en un teléfono compartido de patio. La apertura real
/// vive en outbox_open.dart; las llaves en outbox_key_store.dart.
///
/// Reglas que el esquema hace cumplir:
///  - Toda fila queda atada a QUIÉN la creó ([userId], [tenantId],
///    [locationId] activa del selector). Al cambiar de cuenta, las filas de
///    otro usuario se purgan — nunca se drenan con las credenciales de otro.
///  - [idempotencyKey] es única: encolar dos veces la misma escritura es un
///    no-op (o un reemplazo deliberado vía OutboxService).
///  - [dependsOn] ordena el drenado (las fotos antes del complete de la
///    inspección; el complete depende de la última foto).
///  - [status] = pending | inflight | dead. `dead` es visible al usuario
///    (DoD: dead-letter con mensaje claro), nunca un descarte silencioso.
class OutboxEntries extends Table {
  TextColumn get id => text()();
  TextColumn get userId => text()();
  TextColumn get tenantId => text()();

  /// Ubicación activa (`x-view-location`) al momento de crear la fila, o
  /// null si el usuario opera sin override. Criterio registrado H5: se sella
  /// AL ENCOLAR — el drenado jamás depende del selector vivo.
  TextColumn get locationId => text().nullable()();

  /// Agrupador de cadena: para inspección, el checkoutSessionId. Permite la
  /// purga selectiva de 6F ("otra superficie completó → retirar los envíos
  /// de ESA sesión") sin parsear payloads en un where.
  TextColumn get groupKey => text().nullable()();

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

/// Rastro de auditoría local de descartes (criterio del mockup 7B′): lo
/// descartado puede ser evidencia de daños y no puede evaporarse sin
/// registro — quién, qué item, motivo del dead-letter, hora.
///
/// [synced] queda en false hasta que exista el endpoint de backend que
/// reciba este rastro (hoy NO existe — pedido anotado en el reporte H5); el
/// esquema ya está listo para que el drenado futuro lo suba y marque true.
/// A diferencia del outbox, este rastro NO se purga al cambiar de cuenta:
/// es el registro de que algo se destruyó, no una escritura pendiente.
class OutboxAuditEntries extends Table {
  TextColumn get id => text()();
  TextColumn get userId => text()();
  TextColumn get tenantId => text()();
  TextColumn get locationId => text().nullable()();

  /// id de la fila de outbox descartada.
  TextColumn get rowId => text()();
  TextColumn get rowKind => text()();

  /// Resumen NO sensible del payload (reserva, ángulo) — jamás la foto/firma.
  TextColumn get summary => text()();

  /// Código del motivo: el lastErrorCode del dead-letter, o un motivo local
  /// (SESSION_COMPLETED en la purga selectiva de 6F).
  TextColumn get reasonCode => text().nullable()();
  DateTimeColumn get discardedAt => dateTime()();
  BoolColumn get synced => boolean().withDefault(const Constant(false))();

  @override
  Set<Column<Object>> get primaryKey => {id};
}

@DriftDatabase(tables: [OutboxEntries, OutboxAuditEntries])
class OutboxDb extends _$OutboxDb {
  OutboxDb(super.executor);

  // v1 sigue siendo el esquema inicial: hasta H5 el provider devolvía null y
  // la DB jamás se creó en ningún aparato — las tablas nuevas (audit,
  // groupKey) entran en el CREATE inicial, no en una migración.
  @override
  int get schemaVersion => 1;

  /// Tope de la bandeja (política H5, mockup 7D): 50 filas / ~250 MB de
  /// fotos. Con la bandeja llena se PAUSA el encolado (antes de abrir la
  /// cámara) y la UI lo dice — nada se purga solo: mejor un "no cabe,
  /// conéctate" honesto que un teléfono con 2 GB de fotos que luego se
  /// pierde.
  static const maxRows = 50;
  static const maxPhotoBytes = 250 * 1024 * 1024;

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

  /// TODAS las filas del dueño (pending/inflight/dead) para la bandeja UI
  /// (mockup 7A/7B) — como stream: el badge del shell y la lista viven de
  /// esto y se repintan solos con cada escritura.
  Stream<List<OutboxEntry>> watchAllFor({
    required String userId,
    required String tenantId,
  }) {
    return (select(outboxEntries)
          ..where(
              (t) => t.userId.equals(userId) & t.tenantId.equals(tenantId))
          ..orderBy([(t) => OrderingTerm.asc(t.createdAt)]))
        .watch();
  }

  Future<List<OutboxEntry>> allFor({
    required String userId,
    required String tenantId,
  }) {
    return (select(outboxEntries)
          ..where(
              (t) => t.userId.equals(userId) & t.tenantId.equals(tenantId))
          ..orderBy([(t) => OrderingTerm.asc(t.createdAt)]))
        .get();
  }

  /// Cuenta TOTAL de filas (todos los dueños) — alimenta el tope [maxRows]:
  /// el límite es del TELÉFONO (disco/memoria), no de la cuenta.
  Future<int> totalRows() async {
    final c = countAll();
    final q = selectOnly(outboxEntries)..addColumns([c]);
    final row = await q.getSingle();
    return row.read(c) ?? 0;
  }

  Future<OutboxEntry?> byIdempotencyKey(String key) {
    return (select(outboxEntries)..where((t) => t.idempotencyKey.equals(key)))
        .getSingleOrNull();
  }

  Future<OutboxEntry?> byId(String id) {
    return (select(outboxEntries)..where((t) => t.id.equals(id)))
        .getSingleOrNull();
  }

  /// Filas de una cadena (checkoutSessionId) — purga selectiva de 6F y
  /// restauración del estado del grid al re-entrar al flujo.
  Future<List<OutboxEntry>> byGroupKey(String groupKey) {
    return (select(outboxEntries)
          ..where((t) => t.groupKey.equals(groupKey))
          ..orderBy([(t) => OrderingTerm.asc(t.createdAt)]))
        .get();
  }

  /// Purga por cambio de cuenta (ADR-7): TODO lo que no sea del usuario
  /// entrante se borra — las filas están atadas a quien las creó y jamás se
  /// drenan con credenciales ajenas.
  ///
  /// Devuelve las filas BORRADAS: el caller debe borrar también los archivos
  /// de foto que referencian (`photoPath` en el payload) — si solo se borra
  /// la fila, el binario (PII: fotos de daños) queda huérfano en disco. El
  /// barrido de arranque (OutboxService.sweepOrphanFiles) recoge el caso de
  /// crash entre borrar fila y borrar archivo.
  Future<List<OutboxEntry>> purgeNotOwnedBy({required String userId}) {
    return (delete(outboxEntries)..where((t) => t.userId.equals(userId).not()))
        .goAndReturn();
  }

  /// Purga TOTAL al cerrar sesión (mockup 7C, nota 6): la bandeja pertenece
  /// a la cuenta y jamás sobrevive a otra. Mismo contrato que
  /// [purgeNotOwnedBy]: devuelve las filas para que el caller borre archivos.
  Future<List<OutboxEntry>> purgeAll() {
    return delete(outboxEntries).goAndReturn();
  }

  Future<void> deleteRow(String id) =>
      (delete(outboxEntries)..where((t) => t.id.equals(id))).go();

  /// Reintento manual desde dead-letter (mockup 7B, acción "Reintentar"):
  /// la fila vuelve a pending con intentos en cero — el humano ya decidió,
  /// el contador de backoff empieza de nuevo.
  Future<void> resetDeadToPending(String id) {
    return (update(outboxEntries)
          ..where((t) => t.id.equals(id) & t.status.equals('dead')))
        .write(
      OutboxEntriesCompanion(
        status: const Value('pending'),
        attempts: const Value(0),
        lastError: const Value(null),
        lastErrorCode: const Value(null),
        updatedAt: Value(DateTime.now()),
      ),
    );
  }

  Future<void> markInflight(String id) => _setStatus(id, 'inflight');

  Future<void> markDrained(String id) =>
      (delete(outboxEntries)..where((t) => t.id.equals(id))).go();

  /// Recuperación de filas huérfanas: si el proceso murió entre
  /// [markInflight] y el outcome, la fila quedó en 'inflight' y [pendingFor]
  /// (que solo selecciona 'pending') jamás la volvería a drenar. El drenador
  /// llama esto AL INICIO de cada corrida. Re-enviar es inocuo: el backend
  /// upserta fotos por angleKey y el complete re-verifica antes de mandar.
  Future<int> resetInflightToPending({
    required String userId,
    required String tenantId,
  }) {
    return (update(outboxEntries)
          ..where((t) =>
              t.status.equals('inflight') &
              t.userId.equals(userId) &
              t.tenantId.equals(tenantId)))
        .write(
      OutboxEntriesCompanion(
        status: const Value('pending'),
        updatedAt: Value(DateTime.now()),
      ),
    );
  }

  Future<void> markFailed(
    String id, {
    required String error,
    String? code,
    required bool dead,
  }) {
    // Incremento ATÓMICO en SQL (`attempts = attempts + 1`), no
    // leer-modificar-escribir: sin incrementar aquí, el tope del drenador
    // (que compara contra `attempts`) nunca se alcanzaría y una fila con
    // error de red permanente reintentaría para siempre sin llegar a
    // dead-letter.
    return (update(outboxEntries)..where((t) => t.id.equals(id))).write(
      OutboxEntriesCompanion.custom(
        status: Constant(dead ? 'dead' : 'pending'),
        lastError: Constant(error),
        lastErrorCode: Constant(code),
        attempts: outboxEntries.attempts + const Constant(1),
        updatedAt: Constant(DateTime.now()),
      ),
    );
  }

  Future<void> insertAudit(OutboxAuditEntriesCompanion row) =>
      into(outboxAuditEntries).insert(row);

  Future<List<OutboxAuditEntry>> auditRows() =>
      (select(outboxAuditEntries)
            ..orderBy([(t) => OrderingTerm.asc(t.discardedAt)]))
          .get();

  Future<void> _setStatus(String id, String status) {
    return (update(outboxEntries)..where((t) => t.id.equals(id))).write(
      OutboxEntriesCompanion(
        status: Value(status),
        updatedAt: Value(DateTime.now()),
      ),
    );
  }
}
