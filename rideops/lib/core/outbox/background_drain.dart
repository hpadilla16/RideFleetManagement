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

/// Identidad resuelta para una corrida de background: viene ENTERA del JWT
/// (en el isolate no hay /me ni SessionUser). tenantId = claim de
/// auth.service.js:19 — su paridad con el user de /me la clava un test de
/// fixtures (INN S-3).
@immutable
class BackgroundDrainIdentity {
  const BackgroundDrainIdentity({
    required this.userId,
    required this.tenantId,
    required this.token,
  });

  final String userId;
  final String tenantId;
  final String token;
}

/// Decisión de CORTE del worker (INN S-2, extraída para testearla sin
/// Keystore ni red): null = la tarea se consume con `true` — nada drenable:
///  - sin token / Keystore roto → no hay sesión que drenar (y un Keystore
///    permanentemente roto NO debe reintentar para siempre — INN O-1);
///  - token VENCIDO → turno terminado (JWT de 12 h): el background jamás
///    re-loguea; las filas esperan cifradas al próximo foreground;
///  - sin claim `sub` → token irreconocible, no hay dueño que servir.
Future<BackgroundDrainIdentity?> resolveBackgroundIdentity({
  required Future<String?> Function() readToken,
  DateTime Function() now = DateTime.now,
}) async {
  String? token;
  try {
    token = await readToken();
  } catch (_) {
    return null; // Keystore roto: reintentar no lo va a arreglar (INN O-1)
  }
  if (token == null || token.isEmpty) return null;
  final exp = TokenRefresher.expiryOf(token);
  if (exp != null && now().toUtc().isAfter(exp)) return null;
  final userId = TokenRefresher.subjectOf(token);
  if (userId == null) return null;
  return BackgroundDrainIdentity(
    userId: userId,
    tenantId: TokenRefresher.tenantIdOf(token) ?? '',
    token: token,
  );
}

/// Una corrida del drenador con dependencias construidas a mano (sin
/// Riverpod). Devuelve `true` si no queda nada drenable (bandeja limpia,
/// sin sesión o token vencido) y `false` si quedaron pendientes que un
/// reintento con red podría sacar.
Future<bool> runBackgroundDrainOnce() async {
  // 1. Identidad: JWT del Keystore (spike M0-1a: legible desde background
  //    con encryptedSharedPreferences y sin auth de usuario).
  final identity = await resolveBackgroundIdentity(
    readToken: const SecureTokenStore().read,
  );
  if (identity == null) return true; // nada drenable — ver resolveBackgroundIdentity
  final token = identity.token;

  // 2. Bandeja cifrada: misma llave del Keystore que abre el foreground.
  const keys = SecureOutboxKeyStore();
  final db = OutboxDb(
    openEncryptedOutboxExecutor(obtainDbKeyHex: keys.obtainDbKeyHex),
  );
  try {
    final logger = kDebugMode ? const DebugEventLogger() : const NoopEventLogger();
    final owner =
        OutboxOwner(userId: identity.userId, tenantId: identity.tenantId);
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

    // Rescate ANTES de contar — la misma compuerta que congelaba fotos en el
    // foreground (ver DrainCoordinator.kick). Una fila huérfana en `inflight`
    // no está en `pending`, así que este `isEmpty` daba "bandeja limpia", el
    // worker devolvía éxito y el relevo del OS se cancelaba: la foto se
    // quedaba en el teléfono sin que NADA volviera a mirarla.
    try {
      await store.resetInflight();
    } catch (_) {
      // Sin DB legible el worker sigue con lo que haya en `pending`.
    }
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

/// Plataforma donde el relevo de background EXISTE de verdad: Android (el
/// aparato del patio) e iOS. RideOps no tiene objetivo de escritorio ni web.
///
/// Este es el MISMO predicado que decide en `bootstrap()` si registramos el
/// dispatcher (`Workmanager().initialize`). Vive aquí, en un solo lugar, para
/// que agendar y registrar no puedan divergir: agendar trabajo en una
/// plataforma donde nunca inicializamos el dispatcher no puede funcionar.
///
/// Y en Linux no es solo inútil, es DAÑINO: `workmanager` resuelve la
/// implementación por `Platform.isLinux` (workmanager_impl.dart) a
/// `workmanager_linux`, que NO es un plugin con MethodChannel — es Dart plano
/// que escribe un payload en disco y lanza `systemd-run` con `Process.run`.
/// En un widget test eso deja un temporizador VIVO (el proceso hijo) y la
/// prueba muere con "Pending timers"; en un escritorio real escribiría
/// unidades de systemd para una app que ahí no corre. Windows y macOS lo
/// disimulaban (sin implementación / MissingPlugin tragado por el catch), y
/// por eso el fallo solo salía en el CI de ubuntu.
///
/// POR QUÉ `dart:io Platform` Y NO `defaultTargetPlatform` — no lo "modernices".
/// No son el mismo oráculo. `defaultTargetPlatform` dice para qué plataforma
/// PINTAR widgets, y se puede falsear desde una prueba con
/// `debugDefaultTargetPlatformOverride`. Pero quien elige la implementación del
/// relevo es `workmanager`, y la elige leyendo `dart:io Platform`. Gatear con el
/// primero seria consultar un oraculo distinto del que toma la decision real:
/// un widget test que se declare Android sobre un runner de Linux volveria a
/// meter `Process.run` por la puerta de atras, con el mismo "Pending timers" que
/// este archivo existe para evitar — y la prueba de host no lo cazaria.
///
/// [operatingSystem] se inyecta SOLO en tests: en runtime es el host real.
bool backgroundRelayAvailable({String? operatingSystem}) {
  if (kIsWeb) return false;
  final os = operatingSystem ?? Platform.operatingSystem;
  return os == 'android' || os == 'ios';
}

/// Relevo real vía WorkManager. Se instancia SOLO donde
/// [backgroundRelayAvailable] — ver [backgroundDrainSchedulerProvider].
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

/// Escritorio y CI: no hay relevo que agendar. No-op EXPLÍCITO en vez de
/// dejar que el plugin falle y lo trague el `catch` del coordinador — porque
/// en Linux no falla: lanza un proceso de verdad (ver
/// [backgroundRelayAvailable]).
class NoopDrainScheduler implements BackgroundDrainScheduler {
  const NoopDrainScheduler();

  @override
  Future<void> ensureScheduled() async {}

  @override
  Future<void> cancel() async {}
}

/// Seam de plataforma. Es un provider (no una constante) para que los tests
/// puedan ejercer las DOS ramas del cableado de abajo sin falsear `Platform`:
/// la de Android, que es la que importa para ADR-7, y la del escritorio.
final Provider<bool> backgroundRelayAvailableProvider =
    Provider<bool>((ref) => backgroundRelayAvailable());

final Provider<BackgroundDrainScheduler> backgroundDrainSchedulerProvider =
    Provider<BackgroundDrainScheduler>(
  (ref) => ref.watch(backgroundRelayAvailableProvider)
      ? const WorkmanagerDrainScheduler()
      : const NoopDrainScheduler(),
);
