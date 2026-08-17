import 'dart:io';

import 'package:dio/dio.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:path_provider/path_provider.dart';
import 'package:workmanager/workmanager.dart';

import '../api/checkout_api.dart';
import '../api/token_refresher.dart';
import '../config/app_config.dart';
import '../db/outbox_db.dart';
import '../db/outbox_key_store.dart';
import '../db/outbox_open.dart';
import '../session/token_store.dart';
import '../telemetry/event_logger.dart';
import 'drain_coordinator.dart';
import 'drainer.dart';
import 'outbox_ops_impl.dart';
import 'outbox_service.dart';
import 'photo_vault.dart';

/// Drenado en BACKGROUND vía WorkManager (H6) — el relevo del coordinador de
/// foreground cuando la app muere o el usuario no vuelve.
///
/// Reglas (heredadas del spike M0-1a, que validó Keystore desde el isolate):
///  - El isolate de background NO ve el ProviderContainer: el drenador se
///    construye aquí con sus dependencias DIRECTAS (Dart plano, por diseño —
///    ver drainer.dart).
///  - El JWT jamás viaja por inputData (WorkManager lo persiste en disco SIN
///    cifrar): se lee del Keystore al momento de correr, igual que en
///    foreground.
///  - El JWT de staff dura 12 h: el drenado en background queda LIMITADO al
///    turno. Con token vencido la tarea termina sin reintentos — las filas
///    esperan en la bandeja cifrada y drenan al siguiente login (foreground).
///  - Sin `x-view-location` ni refresh proactivo: los endpoints del drenado
///    no dependen del selector (decisión en drainer.dart) y el refresh es
///    asunto del foreground (ADR-3a: aquí un 401 = transitorio, no re-login).

/// Nombre único de LA tarea (una sola en cola: ExistingWorkPolicy.keep no
/// resetea el backoff si ya hay una esperando red).
const outboxDrainTaskName = 'rideops.outbox.drain';

/// Entry point del isolate de background que levanta WorkManager. Mismo
/// patrón que validó el spike 1 (token_probe, ya retirado), ahora en
/// producción.
@pragma('vm:entry-point')
void outboxBackgroundDispatcher() {
  Workmanager().executeTask((task, inputData) async {
    // `true` = tarea consumida; `false` = WorkManager reintenta con su
    // backoff (exponencial, constraint de red) — solo para pendientes
    // REALES con sesión viva.
    try {
      return await runBackgroundDrainOnce();
    } catch (_) {
      // Un crash del drenado no debe marcar la tarea como éxito: reintento.
      return false;
    }
  });
}

/// Una corrida del drenador con dependencias construidas a mano (sin
/// Riverpod). Devuelve `true` si no queda nada drenable (bandeja limpia,
/// sin sesión o token vencido) y `false` si quedaron pendientes que un
/// reintento con red podría sacar.
Future<bool> runBackgroundDrainOnce() async {
  // 1. Identidad: JWT del Keystore (spike M0-1a: legible desde background
  //    con encryptedSharedPreferences y sin auth de usuario).
  final token = await const SecureTokenStore().read();
  if (token == null || token.isEmpty) return true; // sin sesión: nada que hacer
  final exp = TokenRefresher.expiryOf(token);
  if (exp != null && DateTime.now().toUtc().isAfter(exp)) {
    // Turno terminado (JWT de 12 h): el background NO re-loguea. Las filas
    // esperan cifradas al próximo arranque en foreground.
    return true;
  }
  final userId = TokenRefresher.subjectOf(token);
  if (userId == null) return true;
  // tenantId del claim (auth.service.js:19) — el /me no está disponible aquí.
  final tenantId = TokenRefresher.tenantIdOf(token) ?? '';

  // 2. Bandeja cifrada: misma llave del Keystore que abre el foreground.
  const keys = SecureOutboxKeyStore();
  final db = OutboxDb(
    openEncryptedOutboxExecutor(obtainDbKeyHex: keys.obtainDbKeyHex),
  );
  try {
    final logger = kDebugMode ? const DebugEventLogger() : const NoopEventLogger();
    final owner = OutboxOwner(userId: userId, tenantId: tenantId);
    final store = DbOutboxStore(db: db, ownerOf: () => owner, logger: logger);

    // 3. Red: dos Dio pelones (M0-5). El "autenticado" lleva el bearer a
    //    mano — SIN interceptores: sin refresh (ADR-3a), sin x-view-location
    //    (decisión del drenado). El limpio es para /api/mobile-inspection/*.
    BaseOptions options([String? bearer]) => BaseOptions(
          baseUrl: AppConfig.current.apiBaseUrl,
          // Mismos timeouts honestos del DioFactory (patio con Wi-Fi malo).
          connectTimeout: const Duration(seconds: 10),
          receiveTimeout: const Duration(seconds: 30),
          sendTimeout: const Duration(seconds: 60),
          headers: {
            'Accept': 'application/json',
            if (bearer != null) 'Authorization': 'Bearer $bearer',
          },
        );
    final authedDio = Dio(options(token));
    final publicDio = Dio(options());

    final vault = PhotoVault(
      baseDir: () async =>
          Directory((await getApplicationSupportDirectory()).path),
      obtainKeyBytes: keys.obtainFileKeyBytes,
    );
    final drainer = OutboxDrainer(
      store: store,
      ops: ApiOutboxOps(
        api: CheckoutApi(authedDio: authedDio, publicDio: publicDio),
        vault: vault,
        logger: logger,
      ),
    );

    if ((await store.pending()).isEmpty) return true;
    try {
      await drainer.drain();
    } catch (_) {
      // Corrida tumbada (mint caído por red): inflight vuelve a pending en
      // el próximo intento vía resetInflight — reintento honesto.
    }
    return (await store.pending()).isEmpty;
  } finally {
    await db.close();
  }
}

/// Agenda/cancela el relevo de background. Abstracto para que los tests del
/// coordinador registren llamadas sin tocar el plugin.
abstract class BackgroundDrainScheduler {
  /// Garantiza UNA tarea one-off esperando red (constraint del OS: dispara
  /// aunque la app esté muerta). Idempotente: `keep` no duplica ni resetea.
  Future<void> ensureScheduled();

  /// Bandeja vacía: el relevo ya no hace falta.
  Future<void> cancel();
}

class WorkmanagerDrainScheduler implements BackgroundDrainScheduler {
  const WorkmanagerDrainScheduler();

  @override
  Future<void> ensureScheduled() => Workmanager().registerOneOffTask(
        outboxDrainTaskName,
        outboxDrainTaskName,
        constraints: Constraints(networkType: NetworkType.connected),
        existingWorkPolicy: ExistingWorkPolicy.keep,
        backoffPolicy: BackoffPolicy.exponential,
        backoffPolicyDelay: const Duration(seconds: 30),
      );

  @override
  Future<void> cancel() => Workmanager().cancelByUniqueName(outboxDrainTaskName);
}

final Provider<BackgroundDrainScheduler> backgroundDrainSchedulerProvider =
    Provider<BackgroundDrainScheduler>(
  (ref) => const WorkmanagerDrainScheduler(),
);
