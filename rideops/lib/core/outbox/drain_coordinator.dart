import 'dart:async';
import 'dart:math';

import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../db/outbox_db.dart';
import '../db/outbox_providers.dart';
import '../session/session_controller.dart';
import '../telemetry/event_logger.dart';
import 'background_drain.dart';
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

  /// Cada rescate se CUENTA (`outbox.inflight_rescued`): una fila huérfana en
  /// `inflight` es el rastro de una corrida que murió a media subida, y su
  /// frecuencia es la métrica de salud del drenado — no un detalle interno.
  @override
  Future<void> resetInflight() async {
    final owner = ownerOf();
    if (owner == null) return;
    final rescued = await db.resetInflightToPending(
        userId: owner.userId, tenantId: owner.tenantId);
    if (rescued > 0) {
      logger.log(OutboxEvents.inflightRescued, data: {'rows': rescued});
    }
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
      {required String error,
      String? code,
      int? status,
      required bool dead}) async {
    await db.markFailed(id, error: error, code: code, status: status, dead: dead);
    if (dead) {
      // `status` acompaña al `code` (taxonomía 03-observability): un dead con
      // code null era indistinguible en el tablero entre "murió sin red" y
      // "el backend lo rechazó sin mandar code" — que es justo el caso que
      // el doc llama "bug de manejo de errores, no ruido".
      logger.log(OutboxEvents.entryDead, data: {'code': code, 'status': status});
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
/// El drenado en BACKGROUND (WorkManager, H6) toma el relevo cuando este
/// coordinador no puede seguir: [kick] agenda una one-off con constraint de
/// red si hay filas y no hay red (o si una corrida dejó pendientes — un
/// proceso muerto no cancela el relevo del OS) y la cancela cuando la
/// bandeja queda limpia. El worker vive en background_drain.dart.
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
        // Mantenimiento de arranque, una vez, ANTES del primer drenado:
        //  1. TTL de la bandeja (>14 días → fuera, con rastro — INN O-1),
        //  2. retención del rastro de auditoría (90 días / 500 — INN O-2),
        //  3. barrido de archivos huérfanos (historia M1).
        // Best-effort: sin DB/paths (tests, arranque raro) se reintenta al
        // siguiente arranque.
        try {
          final service = ref.read(outboxServiceProvider);
          await service.purgeStale();
          await ref.read(outboxDbProvider).pruneAudit(
                olderThan:
                    DateTime.now().subtract(const Duration(days: 90)),
              );
          await service.sweepOrphanFiles();
        } catch (_) {}
        await kick('startup');
      });
    }
    return const DrainStatus();
  }

  Future<void> kick(String reason) async {
    if (!ref.mounted || state.running) return;
    final network = ref.read(networkStatusProvider);
    bool online;
    try {
      online = await network.hasNetwork();
    } catch (_) {
      return; // plugin ausente (tests): sin señal no hay drenado
    }
    if (!ref.mounted) return;
    final store = ref.read(outboxStoreProvider);
    final drainer = ref.read(outboxDrainerProvider);
    // RESCATE ANTES DE CONTAR. La compuerta de abajo mira `pending`, y una
    // fila que quedó en `inflight` (corrida tumbada a media subida: un 401,
    // el proceso muerto) NO está en `pending`. Contando solo pendientes, esa
    // fila daba `pendingBefore == 0`, el kick se devolvía y `drain()` —el
    // único sitio donde vive `resetInflight`— jamás llegaba a correr: la
    // foto se quedaba "SUBIENDO" para siempre, con su barra animada, y ni
    // "Enviar ahora" ni un arranque en frío la movían (verificado en el
    // aparato, corrida e2e 2). Es exactamente el daño que el contrato de
    // [OutboxStore.resetInflight] describe — "se perderían en silencio" —
    // reintroducido por la compuerta.
    //
    // Rescatar aquí (y no solo contar las inflight) es deliberado: la cuenta
    // alimenta el anillo "0/N" del 7A, y una fila que se rescata dentro de
    // `drain()` ya llega tarde para ese total. `resetInflight` es idempotente
    // y `drain()` la vuelve a llamar: dos llamadas seguidas no hacen daño.
    try {
      await store.resetInflight();
    } catch (_) {
      // Sin DB (tests, arranque raro) el drenado sigue con lo que haya en
      // `pending`: el rescate se reintenta en el próximo kick.
    }
    if (!ref.mounted) return;
    final pendingBefore = (await store.pending()).length;
    if (!ref.mounted) return;
    if (!online) {
      // Sin red con filas esperando (p. ej. encolado en modo avión): el
      // relevo pasa a WorkManager — su constraint de red dispara el drenado
      // aunque la app muera antes de reconectar (H6).
      if (pendingBefore > 0) _scheduleBackgroundRelay();
      return;
    }
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
      // El timer de backoff muere con el proceso; la one-off de WorkManager
      // no — doble red de seguridad para pendientes transitorios.
      _scheduleBackgroundRelay();
    } else {
      _consecutiveIncompleteRuns = 0;
      _retryTimer?.cancel();
      // Bandeja limpia: cancelar el relevo para no despertar el proceso en
      // balde (y no quemar la cuota de background del OS).
      _cancelBackgroundRelay();
    }
  }

  /// Best-effort ambos: en tests/plataformas sin plugin, MissingPlugin no
  /// debe tumbar el kick — el drenado foreground ya cumplió su parte.
  /// Closures async auto-invocadas (microtask), no `Future(...)`: Future()
  /// agenda un Timer y rompe el !timersPending de los widget tests.
  void _scheduleBackgroundRelay() {
    unawaited(() async {
      try {
        await ref.read(backgroundDrainSchedulerProvider).ensureScheduled();
      } catch (_) {}
    }());
  }

  void _cancelBackgroundRelay() {
    unawaited(() async {
      try {
        await ref.read(backgroundDrainSchedulerProvider).cancel();
      } catch (_) {}
    }());
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
