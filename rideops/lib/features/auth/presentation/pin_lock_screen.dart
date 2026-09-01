import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/l10n/app_localizations.dart';
import '../../../core/session/biometric_auth.dart';
import '../../../core/session/lock_controller.dart';
import '../../../core/session/session_controller.dart';
import '../../../core/theme/ride_tokens.dart';
import 'widgets/pin_widgets.dart';

/// Pantalla 3B del mockup v2 — unlock por PIN con la huella como tecla del
/// keypad y contador de intentos VISIBLE ("te quedan N", nunca lockout
/// silencioso). El redirect del router trae aquí mientras el candado esté
/// puesto; al agotar los intentos el LockController purga el PIN y cierra la
/// sesión (el router lleva a /login solo).
///
/// Criterio del plan: renderiza con `session.user == null` (restore degradado
/// sin /me) — avatar y saludo solo si hay user; el candado no depende de él.
class PinLockScreen extends ConsumerStatefulWidget {
  const PinLockScreen({super.key});

  @override
  ConsumerState<PinLockScreen> createState() => _PinLockScreenState();
}

class _PinLockScreenState extends ConsumerState<PinLockScreen> {
  var _entered = '';
  var _failed = false;
  var _verifying = false;
  var _bioAvailable = false;

  @override
  void initState() {
    super.initState();
    // Fallback silencioso: sin hardware/enrolamiento la tecla de huella
    // simplemente no aparece (regla H2) — por eso el chequeo es async y el
    // default es false.
    ref.read(biometricAuthProvider).isAvailable().then((available) {
      if (mounted && available) setState(() => _bioAvailable = true);
    });
  }

  Future<void> _onDigit(String d) async {
    if (_verifying || _entered.length >= pinLength) return;
    unawaited(HapticFeedback.lightImpact());
    setState(() {
      _entered += d;
      _failed = false;
    });
    if (_entered.length < pinLength) return;
    setState(() => _verifying = true);
    final ok = await ref
        .read(lockControllerProvider.notifier)
        .verifyPin(_entered);
    if (!mounted) return;
    setState(() {
      _verifying = false;
      _entered = '';
      _failed = !ok;
    });
    if (!ok) unawaited(HapticFeedback.heavyImpact());
    // Éxito: el redirect del router nos saca solo (locked=false).
  }

  void _onBackspace() {
    if (_verifying || _entered.isEmpty) return;
    // Mismo haptic que los dígitos (GD S1): borrar también es una tecla.
    unawaited(HapticFeedback.lightImpact());
    setState(() => _entered = _entered.substring(0, _entered.length - 1));
  }

  Future<void> _onBiometric() async {
    if (_verifying) return;
    final l10n = AppLocalizations.of(context)!;
    await ref
        .read(lockControllerProvider.notifier)
        .unlockWithBiometrics(reason: l10n.pinBioPrompt);
    // Fallo/cancelación: sin mensaje — el PIN sigue disponible en pantalla.
  }

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    final lock = ref.watch(lockControllerProvider);
    final user = ref.watch(
      sessionControllerProvider.select((s) => s.user),
    );
    final displayName = _firstNameOf(user?.fullName) ?? user?.email;
    final initials = _initialsOf(user?.fullName, user?.email);
    final showBioKey = _bioAvailable && lock.biometricEnabled;

    return AnnotatedRegion<SystemUiOverlayStyle>(
      value: SystemUiOverlayStyle.dark,
      child: PopScope(
        canPop: false,
        child: Scaffold(
          backgroundColor: RideTokens.n50,
          body: DecoratedBox(
            decoration: const BoxDecoration(
              gradient: RideTokens.tonalScreenGradient,
            ),
            child: SafeArea(
              child: Padding(
                padding: const EdgeInsets.fromLTRB(18, 14, 18, 10),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    const SizedBox(height: 8),
                    if (initials != null) ...[
                      Center(child: _Avatar(initials: initials)),
                      const SizedBox(height: 10),
                    ],
                    Text(
                      displayName == null
                          ? l10n.lockTitleGeneric
                          : l10n.lockGreeting(displayName),
                      textAlign: TextAlign.center,
                      style: const TextStyle(
                        fontSize: 24,
                        fontWeight: FontWeight.w900,
                        letterSpacing: -0.2,
                        color: RideTokens.n900,
                      ),
                    ),
                    const SizedBox(height: 6),
                    Text(
                      l10n.lockSubtitle,
                      textAlign: TextAlign.center,
                      style: const TextStyle(
                        fontSize: 13.5,
                        color: RideTokens.n700,
                      ),
                    ),
                    const SizedBox(height: 18),
                    Center(
                      child: PinDots(
                        filled: _failed ? pinLength : _entered.length,
                        error: _failed,
                      ),
                    ),
                    const SizedBox(height: 10),
                    if (_failed)
                      Semantics(
                        liveRegion: true,
                        child: Text(
                          l10n.lockWrongPin(lock.attemptsLeft),
                          textAlign: TextAlign.center,
                          style: const TextStyle(
                            fontSize: 13.5,
                            fontWeight: FontWeight.w700,
                            color: RideTokens.dangerTx,
                          ),
                        ),
                      ),
                    const Spacer(),
                    PinKeypad(
                      onDigit: _onDigit,
                      onBackspace: _onBackspace,
                      onBiometric: showBioKey ? _onBiometric : null,
                    ),
                    const SizedBox(height: 6),
                    // Escape honesto (anotación 5 del mockup): target ≥ 48.
                    Center(
                      child: TextButton(
                        style: TextButton.styleFrom(
                          minimumSize: const Size(48, 48),
                        ),
                        onPressed: () => ref
                            .read(lockControllerProvider.notifier)
                            .forgotPinLogout(),
                        child: Text(
                          l10n.lockForgotPin,
                          style: const TextStyle(
                            fontSize: 13.5,
                            fontWeight: FontWeight.w700,
                            color: RideTokens.p700,
                          ),
                        ),
                      ),
                    ),
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }

  /// Primer nombre para el saludo ("Hola, Marco"); null si no hay de dónde.
  static String? _firstNameOf(String? fullName) {
    final trimmed = fullName?.trim();
    if (trimmed == null || trimmed.isEmpty) return null;
    return trimmed.split(RegExp(r'\s+')).first;
  }

  /// Iniciales del avatar del mockup ("MG"); email como respaldo; null sin
  /// user (sesión degradada) — el avatar simplemente no se pinta.
  static String? _initialsOf(String? fullName, String? email) {
    final trimmed = fullName?.trim();
    if (trimmed != null && trimmed.isNotEmpty) {
      final parts = trimmed.split(RegExp(r'\s+'));
      final first = parts.first[0];
      final second = parts.length > 1 ? parts[1][0] : '';
      return '$first$second'.toUpperCase();
    }
    if (email != null && email.isNotEmpty) return email[0].toUpperCase();
    return null;
  }
}

class _Avatar extends StatelessWidget {
  const _Avatar({required this.initials});

  final String initials;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: 60,
      height: 60,
      alignment: Alignment.center,
      decoration: const BoxDecoration(
        shape: BoxShape.circle,
        gradient: LinearGradient(
          begin: Alignment.topLeft,
          end: Alignment.bottomRight,
          colors: [RideTokens.p100, RideTokens.p200],
        ),
      ),
      child: Text(
        initials,
        style: const TextStyle(
          fontSize: 21,
          fontWeight: FontWeight.w900,
          color: RideTokens.p800,
        ),
      ),
    );
  }
}
