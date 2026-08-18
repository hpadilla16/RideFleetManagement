import 'package:flutter/foundation.dart';

import '../api/dto/session_user.dart';

/// Estado del candado por PIN (H2) — gobierna el gate `/lock` y el forzado de
/// setup `/pin-setup` en el redirect del router.
@immutable
class LockState {
  const LockState({
    required this.ready,
    required this.pinConfigured,
    required this.biometricEnabled,
    required this.locked,
    required this.attemptsLeft,
  });

  /// Antes de hidratar el registro del Keystore (o sin sesión): el router
  /// retiene en /splash mientras `ready` sea false para no flashear contenido
  /// protegido en un cold start bloqueado.
  const LockState.initial()
      : this(
          ready: false,
          pinConfigured: false,
          biometricEnabled: false,
          locked: false,
          attemptsLeft: maxAttempts,
        );

  /// 5 intentos: suficiente para dedos con guantes, corto para un curioso.
  /// Al agotarse ⇒ logout limpio + PIN purgado (nunca lockout silencioso).
  static const maxAttempts = 5;

  /// El registro de PIN de la sesión actual ya se leyó del Keystore.
  final bool ready;

  /// Hay un PIN del userId de la sesión actual.
  final bool pinConfigured;

  /// El dueño del PIN activó la huella en el setup (mockup 3A).
  final bool biometricEnabled;

  /// Gate activo: el router manda todo a /lock.
  final bool locked;

  /// Intentos restantes del episodio de bloqueo actual, visibles en la UI
  /// ("te quedan N") — regla del mockup 3B: contador visible, jamás lockout
  /// sorpresa.
  final int attemptsLeft;

  /// Falta configurar el PIN (mockup 3A). `screenLockExempt` salta TODO el
  /// gate incluido el setup; `user == null` (restore degradado sin /me) no
  /// fuerza setup por especulación — sin user no hay a quién atar el PIN.
  bool needsSetupFor(SessionUser? user) =>
      ready && !pinConfigured && user != null && !user.screenLockExempt;

  LockState copyWith({
    bool? ready,
    bool? pinConfigured,
    bool? biometricEnabled,
    bool? locked,
    int? attemptsLeft,
  }) =>
      LockState(
        ready: ready ?? this.ready,
        pinConfigured: pinConfigured ?? this.pinConfigured,
        biometricEnabled: biometricEnabled ?? this.biometricEnabled,
        locked: locked ?? this.locked,
        attemptsLeft: attemptsLeft ?? this.attemptsLeft,
      );
}
