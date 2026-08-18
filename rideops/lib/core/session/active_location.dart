import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import '../api/token_refresher.dart';
import '../telemetry/event_logger.dart';
import 'session_controller.dart';
import 'session_state.dart';

/// Ubicación activa del selector (H3, mockup 4C) — el estado que alimenta el
/// header `x-view-location` (REGROUND §1) y, cuando el outbox tenga filas
/// reales (H5), el `locationId` de cada fila nueva.
///
/// `locationId == null` = "Todas mis ubicaciones": sin override, el usuario ve
/// su set completo (el backend no recibe header). El NOMBRE se persiste junto
/// al id para que el chip del header pinte algo honesto sin red y sin esperar
/// a `GET /api/locations/selectable`.
@immutable
class ActiveLocation {
  const ActiveLocation._({
    required this.hydrated,
    this.locationId,
    this.locationName,
  });

  /// Arranque: aún leyendo la preferencia persistida. El interceptor lee
  /// [locationId] igual (null ⇒ sin header) — la única ruta que corre tan
  /// temprano es /me, que salta el header por diseño (interceptors.dart).
  const ActiveLocation.hydrating() : this._(hydrated: false);

  /// Sin override — todas las ubicaciones del usuario.
  const ActiveLocation.all() : this._(hydrated: true);

  const ActiveLocation.pinned({required String locationId, String? locationName})
      : this._(hydrated: true, locationId: locationId, locationName: locationName);

  final bool hydrated;
  final String? locationId;
  final String? locationName;

  bool get isPinned => locationId != null;
}

/// Persistencia de la preferencia — abstracta para tests en memoria.
///
/// Decisión H3: secure storage (Keystore/Keychain) y NO shared_preferences.
/// Razones: (1) cero dependencias nuevas — flutter_secure_storage ya está y
/// con las mismas AndroidOptions que aprobó el spike M0-1a; (2) el registro
/// guarda a QUÉ usuario pertenece la preferencia, y en un teléfono compartido
/// de patio ese vínculo usuario→sede no debe quedar en un XML legible por
/// cualquier proceso con root barato; (3) mismo ciclo de vida que el token —
/// un wipe de datos limpia ambos coherentemente.
abstract class ActiveLocationStore {
  /// JSON crudo `{userId, locationId, locationName}` o null si no hay registro.
  Future<String?> read();
  Future<void> write(String raw);
  Future<void> clear();
}

class SecureActiveLocationStore implements ActiveLocationStore {
  const SecureActiveLocationStore();

  static const _storage = FlutterSecureStorage(
    aOptions: AndroidOptions(
      encryptedSharedPreferences: true,
    ),
  );

  /// UNA llave con el dueño adentro (no una llave por usuario): así el cambio
  /// de cuenta se detecta comparando `userId` y la purga es borrar un registro
  /// — no queda un residuo de preferencias de ex-empleados acumulándose.
  static const _key = 'rideops.session.activeLocation';

  @override
  Future<String?> read() => _storage.read(key: _key);

  @override
  Future<void> write(String raw) => _storage.write(key: _key, value: raw);

  @override
  Future<void> clear() => _storage.delete(key: _key);
}

/// Controller de la ubicación activa. Reglas:
///  - Persiste POR USUARIO: el registro guarda el userId dueño; si al
///    hidratar el dueño no coincide con la sesión actual (cambio de cuenta),
///    se PURGA — la sede de un empleado jamás se hereda al siguiente (ADR-7,
///    misma filosofía que el outbox).
///  - Sobrevive reinicios y sesiones degradadas: con `user == null` (restore
///    sin red) el dueño sale del claim `sub` del JWT.
///  - NO valida contra `user.locationIds` al hidratar: el servidor es la
///    fuente de verdad — si un admin quitó la sede, el 403 sin code llega y
///    la pantalla 4D ofrece salir (validar aquí escondería la negativa como
///    un reset silencioso).
class ActiveLocationController extends Notifier<ActiveLocation> {
  /// Invalida hidrataciones en vuelo cuando el dueño cambió mientras se leía
  /// el Keystore (logout + login de otro usuario en la misma ventana).
  int _generation = 0;

  @override
  ActiveLocation build() {
    // select(ownerId): el refresh proactivo cambia el token cada ciclo pero
    // el sub es el mismo — sin el select, cada refresh re-hidrataría desde
    // disco y podría pisar una selección recién hecha en memoria.
    final ownerId = ref.watch(sessionControllerProvider.select(ownerIdOf));
    _generation++;
    if (ownerId == null) return const ActiveLocation.all();
    final gen = _generation;
    Future.microtask(() => _hydrate(ownerId, gen));
    return const ActiveLocation.hydrating();
  }

  /// Identidad dueña de la preferencia: el user de /me o, degradado, el sub
  /// del JWT. Público solo para tests de la tabla de casos.
  static String? ownerIdOf(SessionState s) {
    if (!s.isAuthenticated) return null;
    final token = s.token;
    return s.user?.id ?? (token == null ? null : TokenRefresher.subjectOf(token));
  }

  ActiveLocationStore get _store => ref.read(activeLocationStoreProvider);

  Future<void> _hydrate(String ownerId, int gen) async {
    String? raw;
    try {
      raw = await _store.read();
    } catch (_) {
      // Keystore ilegible (plugin ausente en tests, teléfono raro): operar
      // sin override es el default seguro — el server sigue fail-closed.
    }
    if (!ref.mounted || gen != _generation) return;
    if (raw == null) {
      state = const ActiveLocation.all();
      return;
    }
    Map<String, dynamic>? rec;
    try {
      rec = json.decode(raw) as Map<String, dynamic>;
    } catch (_) {
      rec = null;
    }
    final owner = rec?['userId'] as String?;
    final locationId = rec?['locationId'] as String?;
    if (rec == null || owner != ownerId || locationId == null) {
      // Registro corrupto o de OTRA cuenta: purga (ADR-7 — la preferencia
      // está atada a quien la creó, jamás se hereda).
      state = const ActiveLocation.all();
      unawaited(_clearStore());
      return;
    }
    state = ActiveLocation.pinned(
      locationId: locationId,
      locationName: rec['locationName'] as String?,
    );
  }

  /// Selección del sheet 4C. `locationId == null` = "Todas mis ubicaciones".
  ///
  /// El refresh de datos al cambiar NO se orquesta aquí: todo provider de
  /// datos scoped (dashboard H4, búsqueda M3) debe `ref.watch` este provider
  /// — el cambio de estado los invalida y re-consultan con el header nuevo.
  Future<void> set({String? locationId, String? locationName}) async {
    final ownerId = ownerIdOf(ref.read(sessionControllerProvider));
    if (ownerId == null) return; // sin sesión no hay dueño que persistir
    state = locationId == null
        ? const ActiveLocation.all()
        : ActiveLocation.pinned(locationId: locationId, locationName: locationName);
    ref.read(eventLoggerProvider).log(SessionEvents.viewLocationSet);
    try {
      if (locationId == null) {
        await _store.clear();
      } else {
        await _store.write(json.encode({
          'userId': ownerId,
          'locationId': locationId,
          'locationName': locationName,
        }));
      }
    } catch (_) {
      // Persistencia fallida: la selección vive en memoria esta sesión; al
      // reiniciar cae a "Todas" — molesto, jamás incorrecto (fail-open hacia
      // el set completo del usuario, que el server valida igual).
    }
  }

  Future<void> _clearStore() async {
    try {
      await _store.clear();
    } catch (_) {
      // Igual que arriba: sin Keystore no hay nada que purgar.
    }
  }
}

/// Espera ACOTADA a que la preferencia de sede termine de hidratar.
///
/// UN solo helper (Innovation, review H7): había tres esperas incompatibles
/// —125×40 ms en la entrada al checkout, 50×`Duration.zero` en la inspección y
/// el gate declarativo del dashboard/wizard—, o sea tres respuestas distintas a
/// la MISMA pregunta ("¿ya sé qué `x-view-location` mandar?"). Los controllers
/// imperativos (los que disparan una escritura desde un toque) usan esto; los
/// que solo leen siguen con el gate declarativo de `build()`, que es más simple
/// y no necesita reloj.
///
/// Devuelve false si se agotó la espera o el provider murió mientras tanto: la
/// pantalla decide qué decir. Jamás un spin infinito.
///
/// La hidratación real es una lectura de Keystore lanzada en un microtask del
/// arranque, así que el camino normal sale en la primera vuelta; el bucle es el
/// cinturón para el teléfono lento con el Keystore frío.
Future<bool> awaitActiveLocationHydrated(
  Ref ref, {
  Duration step = const Duration(milliseconds: 20),
  int maxTries = 100,
}) async {
  if (ref.read(activeLocationProvider).hydrated) return true;
  for (var i = 0; i < maxTries; i++) {
    await Future<void>.delayed(step);
    if (!ref.mounted) return false;
    if (ref.read(activeLocationProvider).hydrated) return true;
  }
  return false;
}

final activeLocationStoreProvider = Provider<ActiveLocationStore>(
  (ref) => const SecureActiveLocationStore(),
);

final NotifierProvider<ActiveLocationController, ActiveLocation>
    activeLocationProvider =
    NotifierProvider<ActiveLocationController, ActiveLocation>(
  ActiveLocationController.new,
);
