import 'dart:async';

import 'package:clock/clock.dart';
// Solo AppLifecycleState: widgets.dart también exporta un LockState (el de
// Shortcuts) que chocaría con el nuestro.
import 'package:flutter/widgets.dart' show AppLifecycleState;
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../api/token_refresher.dart';
import '../telemetry/event_logger.dart';
import 'biometric_auth.dart';
import 'kiosk_guard.dart';
import 'lock_state.dart';
import 'pin_store.dart';
import 'session_controller.dart';
import 'session_state.dart';

/// Candado por PIN/biometría (H2) — el `pinLockProvider` del blueprint §3.
///
/// Reglas:
///  - Cold start (restore) llega BLOQUEADO si hay PIN; login fresco llega
///    desbloqueado — acabas de probar tu contraseña, pedir el PIN es teatro.
///  - Timer de inactividad ([idleTimeout]) + volver del background tras
///    [backgroundGrace] ⇒ lock. `screenLockExempt` salta todo.
///  - Agotar [LockState.maxAttempts] ⇒ purgar PIN + logout limpio: el
///    re-login con contraseña crea un PIN nuevo (escape honesto).
///  - [suspendLock]/[resumeLock]: API para H5 (modo kiosco de la firma,
///    decisión §9-6) — aquí solo se deja lista y testeada, nadie la llama.
class LockController extends Notifier<LockState> {
  /// 5 min sin tocar la pantalla ⇒ lock (default de la historia H2).
  static const idleTimeout = Duration(minutes: 5);

  /// Ir al background y volver dentro de esta gracia NO bloquea (contestar
  /// un WhatsApp, una llamada corta); más allá, lock. Cubre también el caso
  /// de timers congelados por Android: el chequeo es por timestamp al volver.
  static const backgroundGrace = Duration(seconds: 30);

  Timer? _idleTimer;
  int _suspendCount = 0;
  DateTime? _backgroundedAt;

  /// Candado forzado por recuperación de kiosco (H6): mientras esté activo,
  /// la hidratación tardía de una exención (/me con screenLockExempt=true)
  /// NO lo abre — solo el PIN/huella del dueño. Ver [_fullSync].
  bool _kioskRecoveryLock = false;

  /// Secuencia de sincronización: invalida lecturas del Keystore en vuelo
  /// cuando la sesión cambió mientras esperábamos.
  int _syncSeq = 0;

  EventLogger get _logger => ref.read(eventLoggerProvider);
  PinStore get _pinStore => ref.read(pinStoreProvider);

  @override
  LockState build() {
    ref.onDispose(() => _idleTimer?.cancel());
    ref.listen<SessionState>(sessionControllerProvider, _onSessionChange);
    // La sesión pudo autenticarse antes de que alguien observara este
    // provider (tests, hot reload): sincronizar el estado inicial. prev=null
    // se trata como cold start — lo seguro es llegar bloqueado.
    Future.microtask(() {
      if (!ref.mounted) return;
      _onSessionChange(null, ref.read(sessionControllerProvider));
    });
    return const LockState.initial();
  }

  void _onSessionChange(SessionState? prev, SessionState next) {
    if (!next.isAuthenticated) {
      // Sesión muerta (logout, 401): nada del candado sobrevive — ni el
      // timer, ni las suspensiones del kiosco, ni los intentos.
      _idleTimer?.cancel();
      _backgroundedAt = null;
      _suspendCount = 0;
      _kioskRecoveryLock = false;
      _syncSeq++; // invalida cualquier lectura en vuelo
      state = const LockState.initial();
      return;
    }
    if (prev?.isAuthenticated ?? false) {
      // Transición DENTRO de la sesión (hidratación de /me, refresh de
      // token): no recalcular el candado — solo honrar una exención recién
      // conocida (restore degradado que hidrata screenLockExempt=true).
      if (!state.ready) return; // la sincronización inicial sigue en vuelo
      // Un candado de recuperación de kiosco NO se abre por exención (H6:
      // el kiosco ignora la exención) — solo PIN/huella.
      if (_isExempt(next) && !_kioskRecoveryLock) {
        _idleTimer?.cancel();
        if (state.locked) state = state.copyWith(locked: false);
      }
      return;
    }
    // Sesión recién autenticada: login fresco (prev unauthenticated) o cold
    // start (prev restoring / null).
    _fullSync(fromRestore: prev == null || prev.status == SessionStatus.restoring);
  }

  Future<void> _fullSync({required bool fromRestore}) async {
    final seq = ++_syncSeq;
    StoredPin? record;
    try {
      record = await _pinStore.read();
    } catch (_) {
      // Keystore ilegible: tratar como "sin PIN" (el gate de setup re-crea)
      // antes que dejar un candado imposible de abrir.
      record = null;
    }
    // Recuperación de kiosco (H6, política del PM: EL KIOSCO IGNORA LA
    // EXENCIÓN): si el flag `kiosk_in_progress` sobrevivió al arranque, el
    // proceso murió con el teléfono volteado al cliente — quien relanza la
    // app NO es necesariamente el dueño de la sesión.
    //
    // INN MC-1 (review H6): el flag se consume al CERRAR la recuperación
    // (PIN/huella correctos, re-login con contraseña, login fresco) — NUNCA
    // al leerlo. Consumirlo en la lectura regalaba el bypass kill→relaunch
    // ×2: el segundo arranque ya no veía flag y el exempt aterrizaba
    // desbloqueado.
    var kioskPending = false;
    try {
      kioskPending = await ref.read(kioskGuardStoreProvider).read();
    } catch (_) {
      // Keystore ilegible: sin flag no hay recuperación que forzar.
    }
    if (!ref.mounted || seq != _syncSeq) return;
    // Releer la sesión: /me pudo hidratar el user mientras esperábamos.
    final session = ref.read(sessionControllerProvider);
    if (!session.isAuthenticated) return; // el listener ya reseteó
    final userId = _userIdOf(session);
    if (record != null && userId != null && record.userId != userId) {
      // Cambio de cuenta: el PIN pertenece a OTRO usuario — purgarlo (regla
      // H2: cambio de cuenta = PIN nuevo) y forzar setup.
      try {
        await _pinStore.clear();
      } catch (_) {}
      if (!ref.mounted || seq != _syncSeq) return;
      record = null;
    }
    final configured = record != null;
    final exempt = _isExempt(session);
    // En un login FRESCO el flag no fuerza nada (la contraseña se acaba de
    // probar): la recuperación se cierra AQUÍ y el flag se consume.
    final kioskRecovery = kioskPending && fromRestore;
    if (kioskPending && !fromRestore) {
      _clearKioskFlag();
    }
    if (kioskRecovery && !configured) {
      // Usuario exempt sin PIN (el gate de setup lo salta): la única
      // credencial local es la contraseña — re-login forzado. La bandeja NO
      // se purga: onSessionExpired limpia sesión sin tocar filas y el mismo
      // usuario re-entra con su cola intacta.
      //
      // Orden DELIBERADO (INN MC-1): primero la expulsión, DESPUÉS el
      // clear del flag. Un crash entre ambos deja el flag puesto (peor
      // caso: otra expulsión) — al revés dejaría la sesión viva sin
      // candado ni flag.
      _logger.log(SessionEvents.pinLock, data: {'reason': 'kiosk_recovery_relogin'});
      ref
          .read(sessionControllerProvider.notifier)
          .onSessionExpired(reason: SignOutReason.kioskRecovery);
      _clearKioskFlag();
      return;
    }
    final locked = configured && fromRestore && (!exempt || kioskRecovery);
    _kioskRecoveryLock = kioskRecovery && locked;
    state = LockState(
      ready: true,
      pinConfigured: configured,
      biometricEnabled: record?.biometricEnabled ?? false,
      locked: locked,
      attemptsLeft: LockState.maxAttempts,
    );
    if (locked) {
      _logger.log(SessionEvents.pinLock, data: {
        'reason': kioskRecovery ? 'kiosk_recovery' : 'cold_start',
      });
    } else if (configured && !exempt) {
      _restartIdleTimer();
    }
  }

  /// Bloquea YA (si aplica). Ignorado si no hay PIN, el usuario está exento,
  /// el lock está suspendido (kiosco H5) o ya está bloqueado.
  void lock({String reason = 'manual'}) {
    if (state.locked || !state.ready || !state.pinConfigured) return;
    if (_suspendCount > 0) return;
    final session = ref.read(sessionControllerProvider);
    if (!session.isAuthenticated || _isExempt(session)) return;
    _idleTimer?.cancel();
    state = state.copyWith(locked: true, attemptsLeft: LockState.maxAttempts);
    _logger.log(SessionEvents.pinLock, data: {'reason': reason});
  }

  /// Intento de desbloqueo por PIN. false = incorrecto (la UI muestra los
  /// intentos restantes de [LockState.attemptsLeft]); al agotarse, purga el
  /// PIN y cierra la sesión — el router lleva a /login solo.
  Future<bool> verifyPin(String pin) async {
    if (!state.locked) return true;
    StoredPin? record;
    try {
      record = await _pinStore.read();
    } catch (_) {
      record = null;
    }
    if (!ref.mounted || !state.locked) return false;
    if (record != null && record.matches(pin)) {
      _closeKioskRecovery(); // el dueño probó su PIN — flag consumido AQUÍ
      state = state.copyWith(
        locked: false,
        attemptsLeft: LockState.maxAttempts,
      );
      _logger.log(SessionEvents.pinUnlock, data: {'method': 'pin'});
      _restartIdleTimer();
      return true;
    }
    final left = state.attemptsLeft - 1;
    if (left <= 0) {
      await _purgeAndLogout();
      return false;
    }
    state = state.copyWith(attemptsLeft: left);
    return false;
  }

  /// Desbloqueo por huella: dispara el prompt del sistema y, si pasa, abre el
  /// candado. [reason] llega localizado desde la pantalla.
  Future<bool> unlockWithBiometrics({required String reason}) async {
    if (!state.locked) return true;
    final ok =
        await ref.read(biometricAuthProvider).authenticate(reason: reason);
    if (!ref.mounted || !ok || !state.locked) return false;
    _closeKioskRecovery(); // el dueño probó su huella — flag consumido AQUÍ
    state = state.copyWith(locked: false, attemptsLeft: LockState.maxAttempts);
    _logger.log(SessionEvents.pinUnlock, data: {'method': 'biometric'});
    _restartIdleTimer();
    return true;
  }

  /// Comprobación PURA del PIN: no toca candado ni intentos. Para H5 (salida
  /// del modo kiosco: mantener 3 s + PIN) y futuros usos de confirmación.
  Future<bool> checkPin(String pin) async {
    try {
      final record = await _pinStore.read();
      return record != null && record.matches(pin);
    } catch (_) {
      return false;
    }
  }

  /// Setup completado (mockup 3A, pasos 1-2 + oferta de huella): persiste el
  /// registro atado al userId de la sesión y deja la app desbloqueada.
  Future<void> completeSetup({
    required String pin,
    required bool biometricEnabled,
  }) async {
    final session = ref.read(sessionControllerProvider);
    final userId = _userIdOf(session);
    if (userId == null) return; // sin identidad no hay a quién atar el PIN
    await _pinStore.write(StoredPin.create(
      userId: userId,
      pin: pin,
      biometricEnabled: biometricEnabled,
    ));
    if (!ref.mounted) return;
    state = LockState(
      ready: true,
      pinConfigured: true,
      biometricEnabled: biometricEnabled,
      locked: false,
      attemptsLeft: LockState.maxAttempts,
    );
    _restartIdleTimer();
  }

  /// Escape honesto del mockup 3B: "¿Olvidaste tu PIN? Cerrar sesión". Purga
  /// el PIN para que el re-login con contraseña cree uno nuevo.
  Future<void> forgotPinLogout() => _purgeAndLogout();

  /// Cada interacción del usuario reinicia la ventana de inactividad (lo
  /// llama LockObserver en cada pointer-down, para TODAS las rutas).
  void noteActivity() {
    if (state.locked || !state.pinConfigured || _suspendCount > 0) return;
    if (_isExempt(ref.read(sessionControllerProvider))) return;
    _restartIdleTimer();
  }

  /// ── API para H5 (modo kiosco de la firma — decisión §9-6) ──────────────
  ///
  /// Mientras el teléfono está volteado al cliente, el lock por inactividad
  /// NO debe saltar a mitad de firma. Contrato:
  ///  - [suspendLock] detiene el timer y hace no-op cualquier [lock] (timer,
  ///    background, manual). Re-entrante: N suspensiones requieren N
  ///    reanudaciones (por si se anidan flujos).
  ///  - [resumeLock] al llegar a cero reinicia la ventana de inactividad
  ///    COMPLETA — jamás un candado instantáneo al salir del kiosco.
  ///  - La salida deliberada del kiosco (mantener 3 s + PIN) valida con
  ///    [checkPin], que no toca el estado del candado. La UI de salida del
  ///    kiosco (H5) DEBE limitar reintentos de checkPin; checkPin no cuenta
  ///    intentos por diseño.
  ///  - Un logout/401 resetea las suspensiones: no sobreviven a la sesión.
  void suspendLock() {
    _suspendCount++;
    _idleTimer?.cancel();
  }

  void resumeLock() {
    if (_suspendCount == 0) return;
    _suspendCount--;
    if (_suspendCount == 0) noteActivity();
  }

  /// ── Recuperación de kiosco (H6) ─────────────────────────────────────────
  ///
  /// Política (decisión del PM, registrada en PROJECT_PLAN §4): EL KIOSCO
  /// IGNORA LA EXENCIÓN. Con el teléfono volteado al cliente, matar y
  /// relanzar la app debe aterrizar en el candado aunque el dueño de la
  /// sesión sea `screenLockExempt`; si el exempt no tiene PIN, el arranque
  /// fuerza re-login con CONTRASEÑA. El flag persiste en Keystore
  /// ([KioskGuardStore]) y es one-shot: [_fullSync] lo consume al arrancar.
  ///
  /// Best-effort ambos: un Keystore caído no debe impedir firmar — el costo
  /// es perder ESTA protección extra, no el flujo.
  // OJO: closures async auto-invocadas (microtask), NUNCA `Future(...)` —
  // Future() agenda un Timer y rompe el invariante !timersPending de los
  // widget tests.
  void noteKioskEntered() {
    unawaited(() async {
      try {
        await ref.read(kioskGuardStoreProvider).set();
      } catch (_) {}
    }());
  }

  void noteKioskExited() => _clearKioskFlag();

  /// Consume el flag de recuperación (best-effort). Los ÚNICOS callsites
  /// son los cierres legítimos: salida limpia del kiosco, PIN/huella
  /// correctos, re-login forzado y login fresco (INN MC-1).
  void _clearKioskFlag() {
    unawaited(() async {
      try {
        await ref.read(kioskGuardStoreProvider).clear();
      } catch (_) {}
    }());
  }

  /// Cierre de la recuperación de kiosco tras probar identidad (PIN/huella).
  void _closeKioskRecovery() {
    if (!_kioskRecoveryLock) return;
    _kioskRecoveryLock = false;
    _clearKioskFlag();
  }

  /// Ciclo de vida (lo alimenta LockObserver): al volver del background tras
  /// [backgroundGrace], lock. Por timestamp — los timers de Dart se congelan
  /// con el proceso en background, el reloj no.
  void onLifecycleChanged(AppLifecycleState lifecycle) {
    switch (lifecycle) {
      case AppLifecycleState.paused:
      case AppLifecycleState.hidden:
        _backgroundedAt ??= clock.now();
      case AppLifecycleState.resumed:
        final away = _backgroundedAt;
        _backgroundedAt = null;
        if (away != null &&
            clock.now().difference(away) >= backgroundGrace) {
          lock(reason: 'background');
        }
        noteActivity();
      case AppLifecycleState.inactive:
      case AppLifecycleState.detached:
        // inactive salta con cualquier diálogo/notificación encima: no es
        // "salir de la app". detached no vuelve — nada que hacer.
        break;
    }
  }

  Future<void> _purgeAndLogout() async {
    try {
      await _pinStore.clear();
    } catch (_) {}
    if (!ref.mounted) return;
    await ref.read(sessionControllerProvider.notifier).logout();
  }

  void _restartIdleTimer() {
    _idleTimer?.cancel();
    _idleTimer = Timer(idleTimeout, () => lock(reason: 'idle_timeout'));
  }

  bool _isExempt(SessionState session) =>
      session.user?.screenLockExempt ?? false;

  /// Identidad del dueño del PIN: el user de /me o, degradado, el `sub` del
  /// JWT (mismo valor — auth.service.js:19).
  String? _userIdOf(SessionState session) {
    final fromUser = session.user?.id;
    if (fromUser != null) return fromUser;
    final token = session.token;
    return token == null ? null : TokenRefresher.subjectOf(token);
  }
}

final NotifierProvider<LockController, LockState> lockControllerProvider =
    NotifierProvider<LockController, LockState>(LockController.new);
