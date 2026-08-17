import 'dart:convert';

/// Drenador de la bandeja de salida (M0-7), en Dart plano.
///
/// Corre igual en primer plano que en un isolate de background — por eso NO
/// toca Riverpod ni Drift directamente: todo entra por funciones. El plan lo
/// exige ("el isolate de background no ve el ProviderContainer") y el spike 1
/// decidirá si el background puede leer el token; el drenador es el mismo en
/// ambos casos.
///
/// Orden y reglas (spike 2, ops-app-plan/spikes/spike-2-handoff-token-redrain.md):
///  1. Respeta dependencias ([OutboxRow.dependsOn]) — fotos antes del
///     complete.
///  2. Para kinds de inspección, re-emite el handoff token AL DRENAR (staff
///     JWT) — la captura pudo ser horas atrás y el TTL es 15 min. El mint del
///     backend es idempotente >2 min, así que re-pedirlo es gratis.
///  3. `inspection_complete` verifica primero contra el servidor que la
///     inspección no la haya completado otra superficie; si ya está,
///     descarta la fila como éxito (no pisa timestamps de una sesión CLOSED).
///  4. 410 TOKEN_* → re-mint UNA vez y reintento; si persiste → dead-letter.
///  5. Errores permanentes (400/403/404/409 de negocio) → dead-letter visible
///     con el code del backend. Errores de red → la fila queda pending.
///  6. El dinero jamás pasa por aquí (ADR-5): kind desconocido → dead-letter
///     inmediato, no un "por si acaso".
class OutboxRow {
  const OutboxRow({
    required this.id,
    required this.kind,
    required this.payload,
    this.dependsOn,
    this.attempts = 0,
  });

  final String id;
  final String kind;
  final String payload;
  final String? dependsOn;
  final int attempts;

  Map<String, dynamic> get payloadMap =>
      json.decode(payload) as Map<String, dynamic>;
}

/// Resultado de una operación remota del drenador.
sealed class DrainOutcome {
  const DrainOutcome();
}

class DrainOk extends DrainOutcome {
  const DrainOk();
}

/// El servidor rechazó de forma PERMANENTE (code del backend adjunto).
class DrainReject extends DrainOutcome {
  const DrainReject(this.code, this.message);
  final String? code;
  final String message;
}

/// Fallo transitorio (red, 5xx) — reintentar en el próximo drenado.
class DrainTransient extends DrainOutcome {
  const DrainTransient(this.message);
  final String message;
}

/// Operaciones remotas + de disco que el drenador necesita.
///
/// Decisión sobre `x-view-location` en el drenado: el Dio del drenador NO
/// manda el header de la ubicación activa ACTUAL. Los endpoints del drenado
/// (mint del handoff token + rutas públicas /api/mobile-inspection/:token/*)
/// son tenant-scoped y no dependen del selector; mandar una ubicación
/// distinta a la de captura (la fila guarda su locationId solo como dato de
/// propiedad) podría romper con endurecimientos futuros del backend. Si el
/// backend algún día exige ubicación aquí, deberá salir del locationId de la
/// FILA, nunca del selector vivo.
abstract class OutboxOps {
  /// POST /api/checkout-sessions/:id/handoff-token con el staff JWT.
  /// Devuelve el token o null si la sesión ya no existe.
  Future<String?> mintInspectionToken(String checkoutSessionId);

  /// POST /api/mobile-inspection/:token/photo (Dio limpio).
  Future<DrainOutcome> uploadPhoto({
    required String token,
    required String angleKey,
    required String photoDataUrl,
    String? notes,
  });

  /// GET by-reservation → ¿inspectionCompletedAt ya estampado?
  Future<bool> inspectionAlreadyCompleted(String reservationId);

  /// POST /api/mobile-inspection/:token/complete.
  Future<DrainOutcome> completeInspection({
    required String token,
    required Map<String, dynamic> payload,
  });

  /// Lee el dataURL de la foto cifrada en disco.
  Future<String?> readPhotoData(String path);

  /// Borra el archivo de foto cifrado en disco. Best-effort e idempotente:
  /// si el archivo ya no existe NO es error. El drenador lo llama cuando la
  /// fila `inspection_photo` sale de la bandeja (DrainOk o dead-letter) —
  /// la fila se va, el binario (PII) no puede quedarse huérfano en disco.
  Future<void> deletePhotoFile(String path);
}

abstract class OutboxStore {
  Future<List<OutboxRow>> pending();

  /// Regresa a 'pending' las filas que quedaron en 'inflight' (proceso
  /// muerto entre markInflight y el outcome). Sin esto, [pending] jamás las
  /// volvería a servir y se perderían en silencio.
  Future<void> resetInflight();
  Future<void> markInflight(String id);
  Future<void> markDrained(String id);
  Future<void> markFailed(String id,
      {required String error, String? code, required bool dead});
}

class OutboxDrainer {
  OutboxDrainer({
    required this.store,
    required this.ops,
    this.maxAttemptsBeforeDead = 8,
  });

  final OutboxStore store;
  final OutboxOps ops;

  /// Tope de reintentos TRANSITORIOS. Un rechazo permanente va a dead al
  /// primer golpe; esto solo evita que una fila con red eternamente mala
  /// viva para siempre.
  final int maxAttemptsBeforeDead;

  /// Tokens re-emitidos en ESTE drenado, por sesión — un lote de 8 fotos no
  /// pide 8 tokens (y el mint del backend reusa el vivo de todos modos).
  final _tokens = <String, String>{};

  /// Corrida en vuelo (single-flight). Dos disparos concurrentes (p.ej.
  /// connectivity_plus + timer periódico) comparten UNA corrida: el segundo
  /// recibe el Future de la primera en vez de drenar en paralelo y pelearse
  /// por las mismas filas.
  Future<void>? _running;

  Future<void> drain() {
    return _running ??= _drain().whenComplete(() => _running = null);
  }

  Future<void> _drain() async {
    _tokens.clear();
    // Filas huérfanas en 'inflight' (el proceso murió entre markInflight y
    // el outcome) vuelven a 'pending' ANTES de leer la cola — re-enviar es
    // inocuo: el backend upserta fotos por angleKey y el complete
    // re-verifica contra el servidor antes de mandar.
    await store.resetInflight();
    final rows = await store.pending();
    final drained = <String>{};
    final failedThisRun = <String>{};

    for (final row in _inDependencyOrder(rows)) {
      final dep = row.dependsOn;
      if (dep != null && !drained.contains(dep)) {
        // Su dependencia no drenó (aún pending de otro run, o falló ahora):
        // esta fila espera — no es error.
        if (failedThisRun.contains(dep)) continue;
        final depStillPending = rows.any((r) => r.id == dep);
        if (depStillPending) continue;
        // La dependencia ya no existe (drenó en un run anterior) — seguir.
      }

      await store.markInflight(row.id);
      final outcome = await _drainRow(row);
      switch (outcome) {
        case DrainOk():
          drained.add(row.id);
          await store.markDrained(row.id);
          await _deletePhotoFileIfAny(row);
        case DrainReject(:final code, :final message):
          failedThisRun.add(row.id);
          await store.markFailed(row.id,
              error: message, code: code, dead: true);
          // La fila muere pero es visible en dead-letter; el archivo de foto
          // ya no se va a subir jamás → se borra (PII fuera de disco).
          await _deletePhotoFileIfAny(row);
        case DrainTransient(:final message):
          failedThisRun.add(row.id);
          final goesDead = row.attempts + 1 >= maxAttemptsBeforeDead;
          await store.markFailed(row.id,
              error: message, code: null, dead: goesDead);
          if (goesDead) await _deletePhotoFileIfAny(row);
      }
    }
  }

  /// Borra el binario de una fila `inspection_photo` que sale de la bandeja
  /// (drenó OK o murió). Best-effort: un fallo al borrar no debe tirar el
  /// drenado — el barrido de huérfanos de arranque (historia M1) lo recoge.
  Future<void> _deletePhotoFileIfAny(OutboxRow row) async {
    if (row.kind != 'inspection_photo') return;
    final path = row.payloadMap['photoPath'] as String?;
    if (path == null) return;
    try {
      await ops.deletePhotoFile(path);
    } catch (_) {
      // Inocuo: la fila ya salió de la bandeja; M1 barre huérfanos.
    }
  }

  Future<DrainOutcome> _drainRow(OutboxRow row) async {
    switch (row.kind) {
      case 'inspection_photo':
        return _drainPhoto(row);
      case 'inspection_complete':
        return _drainComplete(row);
      default:
        // ADR-5: aquí no existe el dinero. Un kind desconocido es un bug de
        // encolado, no algo que se reintenta en silencio.
        return DrainReject('UNKNOWN_KIND', 'kind no soportado: ${row.kind}');
    }
  }

  Future<DrainOutcome> _drainPhoto(OutboxRow row) async {
    final p = row.payloadMap;
    final sessionId = p['checkoutSessionId'] as String;
    final photoData = await ops.readPhotoData(p['photoPath'] as String);
    if (photoData == null) {
      return const DrainReject('PHOTO_LOST', 'la foto ya no está en disco');
    }

    final token = await _tokenFor(sessionId);
    if (token == null) {
      return const DrainReject('SESSION_GONE', 'la sesión de checkout ya no existe');
    }

    var outcome = await ops.uploadPhoto(
      token: token,
      angleKey: p['angleKey'] as String,
      photoDataUrl: photoData,
      notes: p['notes'] as String?,
    );

    // 410 TOKEN_* — un complete ajeno consumió el token, o venció a media
    // subida (drenado largo). Re-mint UNA vez y reintenta.
    if (outcome is DrainReject && (outcome.code?.startsWith('TOKEN_') ?? false)) {
      _tokens.remove(sessionId);
      final fresh = await _tokenFor(sessionId);
      if (fresh != null) {
        outcome = await ops.uploadPhoto(
          token: fresh,
          angleKey: p['angleKey'] as String,
          photoDataUrl: photoData,
          notes: p['notes'] as String?,
        );
      }
    }
    return outcome;
  }

  Future<DrainOutcome> _drainComplete(OutboxRow row) async {
    final p = row.payloadMap;
    final sessionId = p['checkoutSessionId'] as String;
    final reservationId = p['reservationId'] as String;

    // Spike 2, regla 3: si otra superficie ya completó la inspección, este
    // complete se descarta COMO ÉXITO — el servidor no guarda contra
    // re-estampado y pisaría timestamps de una sesión posiblemente cerrada.
    if (await ops.inspectionAlreadyCompleted(reservationId)) {
      return const DrainOk();
    }

    final token = await _tokenFor(sessionId);
    if (token == null) {
      return const DrainReject('SESSION_GONE', 'la sesión de checkout ya no existe');
    }
    var outcome = await ops.completeInspection(
      token: token,
      payload: p['body'] as Map<String, dynamic>? ?? const {},
    );
    if (outcome is DrainReject && (outcome.code?.startsWith('TOKEN_') ?? false)) {
      _tokens.remove(sessionId);
      // TOKEN_CONSUMED casi siempre significa que OTRA superficie completó
      // la inspección mientras esta fila esperaba. Re-verificar ANTES de
      // re-mint: re-mandar el complete re-estamparía inspectionCompletedAt
      // sobre una sesión posiblemente ya CLOSED.
      if (await ops.inspectionAlreadyCompleted(reservationId)) {
        return const DrainOk();
      }
      final fresh = await _tokenFor(sessionId);
      if (fresh != null) {
        outcome = await ops.completeInspection(
          token: fresh,
          payload: p['body'] as Map<String, dynamic>? ?? const {},
        );
      }
    }
    return outcome;
  }

  Future<String?> _tokenFor(String sessionId) async {
    final cached = _tokens[sessionId];
    if (cached != null) return cached;
    final minted = await ops.mintInspectionToken(sessionId);
    if (minted != null) _tokens[sessionId] = minted;
    return minted;
  }

  /// Orden estable: primero por createdAt (el store ya ordena así), pero una
  /// fila nunca antes de su dependencia.
  List<OutboxRow> _inDependencyOrder(List<OutboxRow> rows) {
    final byId = {for (final r in rows) r.id: r};
    final visited = <String>{};
    final out = <OutboxRow>[];

    void visit(OutboxRow row, [Set<String>? stack]) {
      if (visited.contains(row.id)) return;
      final s = stack ?? <String>{};
      if (s.contains(row.id)) return; // ciclo: conserva orden de llegada
      s.add(row.id);
      final dep = row.dependsOn == null ? null : byId[row.dependsOn];
      if (dep != null) visit(dep, s);
      visited.add(row.id);
      out.add(row);
    }

    for (final r in rows) {
      visit(r);
    }
    return out;
  }
}
