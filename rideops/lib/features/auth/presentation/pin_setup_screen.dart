import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/l10n/app_localizations.dart';
import '../../../core/router/app_router.dart';
import '../../../core/session/biometric_auth.dart';
import '../../../core/session/lock_controller.dart';
import '../../../core/theme/ride_tokens.dart';
import 'widgets/auth_widgets.dart';
import 'widgets/pin_widgets.dart';

enum _SetupStep { create, confirm, biometric }

/// Pantalla 3A del mockup v2 — setup del PIN al primer login, en 2 pasos
/// (crear + confirmar) y una oferta de huella al final si el aparato puede
/// (fallback silencioso a solo-PIN si no). El redirect del router trae aquí
/// mientras falte el PIN (usuarios exentos ni la ven); al terminar se navega
/// explícitamente al destino preservado — el gate no expulsa, igual que el
/// frame de éxito de change-password.
class PinSetupScreen extends ConsumerStatefulWidget {
  const PinSetupScreen({super.key, this.resumeTo});

  /// Destino original preservado por el redirect (?from=).
  final String? resumeTo;

  @override
  ConsumerState<PinSetupScreen> createState() => _PinSetupScreenState();
}

class _PinSetupScreenState extends ConsumerState<PinSetupScreen> {
  var _step = _SetupStep.create;
  var _entered = '';
  String? _first;
  var _mismatch = false;
  var _bioFailed = false;
  var _saving = false;

  void _onDigit(String d) {
    if (_saving || _entered.length >= pinLength) return;
    unawaited(HapticFeedback.lightImpact());
    setState(() {
      _entered += d;
      _mismatch = false;
    });
    if (_entered.length == pinLength) _onPinComplete();
  }

  void _onBackspace() {
    if (_saving || _entered.isEmpty) return;
    setState(() => _entered = _entered.substring(0, _entered.length - 1));
  }

  Future<void> _onPinComplete() async {
    switch (_step) {
      case _SetupStep.create:
        setState(() {
          _first = _entered;
          _entered = '';
          _step = _SetupStep.confirm;
        });
      case _SetupStep.confirm:
        if (_entered != _first) {
          // No coinciden: shake mental — de vuelta al paso 1 con aviso
          // (anotación del mockup: error visible, nunca silencioso).
          unawaited(HapticFeedback.heavyImpact());
          setState(() {
            _entered = '';
            _first = null;
            _step = _SetupStep.create;
            _mismatch = true;
          });
          return;
        }
        // PIN confirmado: ofrecer huella solo si el aparato puede — si no,
        // terminar en silencio con solo-PIN (regla H2).
        final bioAvailable =
            await ref.read(biometricAuthProvider).isAvailable();
        if (!mounted) return;
        if (bioAvailable) {
          setState(() => _step = _SetupStep.biometric);
        } else {
          await _finish(biometricEnabled: false);
        }
      case _SetupStep.biometric:
        break; // sin keypad en este paso
    }
  }

  Future<void> _enableBiometrics() async {
    final l10n = AppLocalizations.of(context)!;
    // Probar la huella AHORA: si el prompt falla o se cancela, se avisa y el
    // usuario decide reintentar o seguir con solo-PIN.
    final ok = await ref
        .read(biometricAuthProvider)
        .authenticate(reason: l10n.pinBioPrompt);
    if (!mounted) return;
    if (!ok) {
      setState(() => _bioFailed = true);
      return;
    }
    await _finish(biometricEnabled: true);
  }

  Future<void> _finish({required bool biometricEnabled}) async {
    setState(() => _saving = true);
    await ref.read(lockControllerProvider.notifier).completeSetup(
          pin: _first!,
          biometricEnabled: biometricEnabled,
        );
    if (!mounted) return;
    context.go(widget.resumeTo ?? AppRoutes.home);
  }

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
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
                padding: const EdgeInsets.fromLTRB(18, 14, 18, 22),
                child: _step == _SetupStep.biometric
                    ? _buildBiometricOffer(l10n)
                    : _buildPinStep(l10n),
              ),
            ),
          ),
        ),
      ),
    );
  }

  Widget _buildPinStep(AppLocalizations l10n) {
    final confirming = _step == _SetupStep.confirm;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        const SizedBox(height: 14),
        Text(
          confirming ? l10n.pinSetupConfirmTitle : l10n.pinSetupTitle,
          textAlign: TextAlign.center,
          style: const TextStyle(
            fontSize: 24,
            fontWeight: FontWeight.w900,
            letterSpacing: -0.2,
            color: RideTokens.n900,
          ),
        ),
        const SizedBox(height: 8),
        Text(
          confirming ? l10n.pinSetupConfirmSubtitle : l10n.pinSetupSubtitle,
          textAlign: TextAlign.center,
          style: const TextStyle(fontSize: 13.5, color: RideTokens.n700),
        ),
        const SizedBox(height: 18),
        Center(child: PinDots(filled: _entered.length, error: _mismatch)),
        const SizedBox(height: 10),
        if (_mismatch)
          Text(
            l10n.pinSetupMismatch,
            textAlign: TextAlign.center,
            style: const TextStyle(
              fontSize: 13.5,
              fontWeight: FontWeight.w700,
              color: RideTokens.dangerTx,
            ),
          )
        else
          Text(
            l10n.pinSetupStep(confirming ? 2 : 1),
            textAlign: TextAlign.center,
            style: const TextStyle(
              fontSize: 12.5,
              fontWeight: FontWeight.w700,
              color: RideTokens.n600,
            ),
          ),
        const Spacer(),
        PinKeypad(onDigit: _onDigit, onBackspace: _onBackspace),
      ],
    );
  }

  Widget _buildBiometricOffer(AppLocalizations l10n) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        const Spacer(),
        const Center(
          child: Icon(Icons.fingerprint, size: 72, color: RideTokens.p700),
        ),
        const SizedBox(height: 12),
        Text(
          l10n.pinBioOfferTitle,
          textAlign: TextAlign.center,
          style: const TextStyle(
            fontSize: 22,
            fontWeight: FontWeight.w900,
            color: RideTokens.n900,
          ),
        ),
        const SizedBox(height: 6),
        Text(
          l10n.pinBioOfferBody,
          textAlign: TextAlign.center,
          style: const TextStyle(fontSize: 14, color: RideTokens.n700),
        ),
        if (_bioFailed) ...[
          const SizedBox(height: 10),
          RideBanner(kind: RideBannerKind.warn, text: l10n.pinBioEnrollFailed),
        ],
        const Spacer(),
        RidePrimaryButton(
          label: l10n.pinBioEnable,
          loading: _saving,
          onPressed: _saving ? null : _enableBiometrics,
        ),
        const SizedBox(height: 10),
        RideGhostButton(
          label: l10n.pinBioSkip,
          onPressed: _saving ? null : () => _finish(biometricEnabled: false),
        ),
      ],
    );
  }
}
