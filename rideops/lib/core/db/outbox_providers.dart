import 'dart:io';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:path_provider/path_provider.dart';

import '../api/api_providers.dart';
import '../outbox/drain_coordinator.dart';
import '../outbox/drainer.dart';
import '../outbox/outbox_ops_impl.dart';
import '../outbox/outbox_service.dart';
import '../outbox/photo_vault.dart';
import '../session/active_location.dart';
import '../session/session_controller.dart';
import '../telemetry/event_logger.dart';
import 'outbox_db.dart';
import 'outbox_key_store.dart';
import 'outbox_open.dart';

/// Cableado Riverpod de la bandeja de salida — abierta DE VERDAD desde H5
/// (SQLCipher + llaves en Keystore, ADR-7). El costo real (llave, archivo,
/// migración) se difiere a la primera consulta vía LazyDatabase.

final outboxKeyStoreProvider = Provider<OutboxKeyStore>(
  (ref) => const SecureOutboxKeyStore(),
);

final Provider<OutboxDb> outboxDbProvider = Provider<OutboxDb>((ref) {
  final keys = ref.watch(outboxKeyStoreProvider);
  final db = OutboxDb(
    openEncryptedOutboxExecutor(obtainDbKeyHex: keys.obtainDbKeyHex),
  );
  ref.onDispose(db.close);
  return db;
});

/// Bóveda de fotos cifradas (los binarios NUNCA viven en la fila — el
/// payload lleva el nombre y la bóveda resuelve/cifra/descifra).
final Provider<PhotoVault> photoVaultProvider = Provider<PhotoVault>((ref) {
  final keys = ref.watch(outboxKeyStoreProvider);
  return PhotoVault(
    baseDir: () async => Directory(
      (await getApplicationSupportDirectory()).path,
    ),
    obtainKeyBytes: keys.obtainFileKeyBytes,
  );
});

/// Dueño para ENCOLAR: sella userId + tenantId de la sesión y el locationId
/// de la sede activa AL MOMENTO de la escritura (criterio registrado H5).
/// Lectura perezosa por llamada — nunca capturada al construir.
final Provider<OutboxOwner? Function()> outboxEnqueueOwnerProvider =
    Provider<OutboxOwner? Function()>((ref) {
  return () {
    final session = ref.read(sessionControllerProvider);
    final user = session.user;
    if (!session.isAuthenticated || user == null) return null;
    final active = ref.read(activeLocationProvider);
    return OutboxOwner(
      userId: user.id,
      tenantId: user.tenantId ?? '',
      // Con la preferencia aún hidratando no se adivina: null = sin
      // override (en la práctica la carga online del flujo de inspección
      // siempre llega después de la hidratación del selector).
      locationId: active.hydrated ? active.locationId : null,
    );
  };
});

final Provider<OutboxService> outboxServiceProvider =
    Provider<OutboxService>((ref) {
  return OutboxService(
    db: ref.watch(outboxDbProvider),
    vault: ref.watch(photoVaultProvider),
    logger: ref.watch(eventLoggerProvider),
    ownerOf: ref.watch(outboxEnqueueOwnerProvider),
  );
});

/// Store del drenador con el dueño leído al momento de cada corrida y la
/// telemetría de drained_ok/entry_dead colgada de los marks.
final Provider<DbOutboxStore> outboxStoreProvider =
    Provider<DbOutboxStore>((ref) {
  return DbOutboxStore(
    db: ref.watch(outboxDbProvider),
    ownerOf: () => sessionOwnerOf(ref),
    logger: ref.watch(eventLoggerProvider),
    onDrained: () =>
        ref.read(drainCoordinatorProvider.notifier).noteRowDone(),
  );
});

final Provider<OutboxDrainer> outboxDrainerProvider =
    Provider<OutboxDrainer>((ref) {
  return OutboxDrainer(
    store: ref.watch(outboxStoreProvider),
    ops: ApiOutboxOps(
      api: ref.watch(checkoutApiProvider),
      vault: ref.watch(photoVaultProvider),
      logger: ref.watch(eventLoggerProvider),
    ),
  );
});

/// TODAS las filas del dueño actual (pending/inflight/dead) como stream —
/// la bandeja UI y el badge del shell viven de esto y se repintan solos.
final StreamProvider<List<OutboxEntry>> outboxRowsProvider =
    StreamProvider<List<OutboxEntry>>((ref) {
  // watch (no read): un cambio de usuario debe recrear el stream con el
  // dueño nuevo — si no, el badge mostraría filas ajenas hasta un reload.
  final userId = ref.watch(
    sessionControllerProvider.select((s) => s.user?.id),
  );
  final tenantId = ref.watch(
    sessionControllerProvider.select((s) => s.user?.tenantId),
  );
  if (userId == null) return Stream.value(const []);
  return ref
      .watch(outboxDbProvider)
      .watchAllFor(userId: userId, tenantId: tenantId ?? '');
});

/// ¿El binario de esta foto sigue en la bóveda? Family por NOMBRE de archivo
/// (lo que guarda el payload), no por fila: dos filas jamás comparten
/// archivo, y así el cache se reusa si la lista se repinta.
///
/// Lo consume la bandeja para no ofrecer "Reintentar" sobre un dead-letter de
/// foto cuyo binario ya no está — ese botón solo puede volver a morir con
/// PHOTO_LOST. `autoDispose`: la respuesta caduca al salir de la pantalla, y
/// al volver se vuelve a preguntar (el archivo pudo borrarse mientras tanto).
///
/// **En error se responde `true` a propósito.** Sin bóveda legible (Keystore
/// caído, plugin ausente en tests) no se puede AFIRMAR que el archivo no
/// está, y retirar la única acción recuperable por una duda sería el error
/// contrario. La ausencia solo se declara cuando se comprobó.
final outboxPhotoPresentProvider =
    FutureProvider.autoDispose.family<bool, String>((ref, name) async {
  try {
    return await ref.watch(photoVaultProvider).exists(name);
  } catch (_) {
    return true;
  }
});

/// Badge de la tab Bandeja (mockup 7, decisión del PM): cuenta pendientes +
/// muertos; el COLOR distingue — ámbar oscuro (--badge-warn #8a5606) =
/// esperando red, rojo = dead-letter que necesita decisión.
typedef OutboxBadge = ({int waiting, int dead});

final Provider<OutboxBadge> outboxBadgeProvider = Provider<OutboxBadge>((ref) {
  final rows = ref.watch(outboxRowsProvider).value ?? const [];
  var waiting = 0;
  var dead = 0;
  for (final row in rows) {
    if (row.status == 'dead') {
      dead++;
    } else {
      waiting++;
    }
  }
  return (waiting: waiting, dead: dead);
});
