import 'dart:async';
import 'dart:math';

import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../db/outbox_db.dart';
import '../db/outbox_providers.dart';
import '../session/session_controller.dart';
import '../telemetry/event_logger.dart';
import 'drainer.dart';
import 'network_status.dart';
import 'outbox_service.dart';

/// Estado observable del drenado para la bandeja UI (mockup 7A: anillo
/// "2/5" + "Enviando…") y el "último envío" del estado feliz 7C.
@immutable
class DrainStatus {
  const DrainStatus({
    this.running = false,
    this.done = 0,
    this.total = 0,
    this.lastDrainAt,
  });

  final bool running;

  /// Filas que salieron de la bandeja en la corrida ACTUAL.
  final int done;

  /// Filas pendientes al arrancar la corrida actual.
  final int total;

  /// Última corrida que terminó con la bandeja limpia de pendientes.
  final DateTime? lastDrainAt;

  DrainStatus copyWith({
    bool? running,
    int? done,
    int? total,
    DateTime? lastDrainAt,
  }) =>
      DrainStatus(
        running: running ?? this.running,
        done: done ?? this.done,
        total: total ?? this.total,
        lastDrainAt: lastDrainAt ?? this.lastDrainAt,
      );
}

/// Adaptador OutboxStore → OutboxDb con el dueño leído AL MOMENTO de cada
/// corrida (no al construir: la sesión puede cambiar entre drenados) y la
/// telemetría de la taxonomía colgada de los marks.
class DbOutboxStore implements OutboxStore {
  DbOutboxStore({
    required this.db,
    required this.ownerOf,
    required this.logger,
    this.onDrained,
  });

  final OutboxDb db;
  final OutboxOwner? Function() ownerOf;
  final EventLogger logger;
  final void Function()? onDrained;

  /// kinds por id de la corrida en curso — para etiquetar la telemetría de
  /// markDrained/markFailed sin re-leer la fila ya borrada.
  final _kinds = <String, String>{};

  @override
  Future<List<OutboxRow>> pending() async {
    final owner = ownerOf();
    if (owner == null) return const [];
    final rows =
        await db.pendingFor(userId: owner.userId, tenantId: owner.tenantId);
    _kinds
      ..clear()
      ..addEntries(rows.map((r) => MapEntry(r.id, r.kind)));
    return [
      for (final r in rows)
        OutboxRow(
          id: r.id,
          kind: r.kind,
          payload: r.payload,
          dependsOn: r.dependsOn,
          attempts: r.attempts,
        ),
    ];
  }

  @override
  Future<void> resetInflight() async {
    final owner = ownerOf();
    if (owner == null) return;
    await db.resetInflightToPending(
        userId: owner.userId, tenantId: owner.tenantId);
  }

  @override
  Future<void> markInflight(String id) => db.markInflight(id);

  @override
  Future<void> markDrained(String id) async {
    await db.markDrained(id);
    logger.log(OutboxEvents.drainedOk, data: {
      'kind': _kinds[id],
      'queue_depth': await db.totalRows(),
    });
    onDrained?.call();
  }

  @override
  Future<void> markFailed(String id,
      {required String error, String? code, required bool dead}) async {
    await db.markFailed(id, error: error, code: code, dead: dead);
    if (dead) {
      logger.log(OutboxEvents.entryDead, data: {'code': code});
      // Un dead también "sale" de la cola drenable — cuenta para el anillo.
      onDrained?.call();
    }
  }
}

/// Orquestador del drenado en FOREGROUND (H5). Disparos:
///  - al encolar (el flujo de inspección llama [kick] tras cada enqueue),
///  - al reconectar (stream de connectivity),
///  - al reanudar la app (AppShell → [kick]),
///  - reintento programado con backoff exponencial + jitter (tope 15 min —
///    nota 3 del mockup 7B) cuando una corrida deja pendientes por fallos
///    transitorios.
///
/// El drenado en BACKGROUND (WorkManager) es historia H6: [kick] es el punto
/// de enchufe — el worker de H6 solo necesita invocar el drenador con el
/// mismo store/ops, sin tocar esta clase.
class DrainCoordinator extends Notifier<DrainStatus> {
  Timer? _retryTimer;
  int _consecutiveIncompleteRuns = 0;
  StreamSubscription<void>? _reconnectSub;
  bool _bootstrapped = false;

  /// Backoff entre corridas que dejaron pendientes: 30 s · 2^n + jitter,
  /// tope 15 min. Público para el test de la curva.
  static Duration retryDelayFor(int failedRuns, {Random? random}) {
    const baseMs = 30 * 1000;
    const capMs = 15 * 60 * 1000;
    final exp = min(failedRuns, 10);
    final backoff = min(capMs, baseMs * (1 << exp));
    final jitter = (random ?? Random()).nextInt(5000);
    return Duration(milliseconds: backoff + jitter);
  }

  @override
  DrainStatus build() {
    final network = ref.watch(networkStatusProvider);
    _reconnectSub?.cancel();
    _reconnectSub = network.onReconnected.listen(
      (_) => kick('connectivity'),
      // Plugin ausente (tests, plataformas raras): sin señal de reconexión
      // quedan los otros disparos (enqueue, resume, backoff) — jamás un
      // unhandled async error por telemetría de red.
      onError: (Object _, StackTrace _) {},
    );
    ref.onDispose(() {
      _reconnectSub?.cancel();
      _retryTimer?.cancel();
    });
    if (!_bootstrapped) {
      _bootstrapped = true;
      Future.microtask(() async {
        if (!ref.mounted) return;
        // Barrido de huérfanos (historia M1): una vez por arranque, antes
        // del primer drenado — así el disco nunca acumula PII sin fila.
        try {
          await ref.read(outboxServiceProvider).sweepOrphanFiles();
        } catch (_) {
          // Sin DB/paths (tests, primer arranque raro): el próximo arranque
          // lo reintenta.
        }
        await kick('startup');
      });
    }
    return const DrainStatus();
  }

  Future<void> kick(String reason) async {
    if (!ref.mounted || state.running) return;
    final network = ref.read(networkStatusProvider);
    try {
      if (!await network.hasNetwork()) return;
    } catch (_) {
      return; // plugin ausente (tests): sin señal no hay drenado
    }
    final store = ref.read(outboxStoreProvider);
    final drainer = ref.read(outboxDrainerProvider);
    final pendingBefore = (await store.pending()).length;
    if (!ref.mounted) return;
    if (pendingBefore == 0) return;

    state = state.copyWith(running: true, done: 0, total: pendingBefore);
    try {
      await drainer.drain();
    } catch (_) {
      // Corrida tumbada (p.ej. mint caído por red): las filas inflight
      // vuelven a pending en la siguiente vía resetInflight.
    }
    if (!ref.mounted) return;

    final pendingAfter = (await store.pending()).length;
    if (!ref.mounted) return;
    state = state.copyWith(
      running: false,
      lastDrainAt: pendingAfter == 0 ? DateTime.now() : state.lastDrainAt,
    );
    if (pendingAfter > 0) {
      _consecutiveIncompleteRuns++;
      _scheduleRetry();
    } else {
      _consecutiveIncompleteRuns = 0;
      _retryTimer?.cancel();
    }
  }

  /// El anillo 7A avanza por fila que sale (DrainOk o dead) — lo alimenta
  /// DbOutboxStore.onDrained.
  void noteRowDone() {
    if (!ref.mounted || !state.running) return;
    state = state.copyWith(done: state.done + 1);
  }

  void _scheduleRetry() {
    _retryTimer?.cancel();
    _retryTimer = Timer(
      retryDelayFor(_consecutiveIncompleteRuns),
      () => kick('backoff_retry'),
    );
  }
}

final NotifierProvider<DrainCoordinator, DrainStatus>
    drainCoordinatorProvider =
    NotifierProvider<DrainCoordinator, DrainStatus>(DrainCoordinator.new);

/// Dueño actual para las corridas del drenador y los streams de la bandeja.
/// El locationId NO va aquí: el drenado no depende del selector (las filas
/// ya lo llevan sellado).
OutboxOwner? sessionOwnerOf(Ref ref) {
  final session = ref.read(sessionControllerProvider);
  if (!session.isAuthenticated) return null;
  final userId = session.user?.id;
  if (userId == null) return null;
  return OutboxOwner(userId: userId, tenantId: session.user?.tenantId ?? '');
}
