import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/api/api_error.dart';
import '../../../core/l10n/app_localizations.dart';
import '../../../core/router/app_router.dart';
import '../../../core/session/session_controller.dart';
import '../../../core/telemetry/event_logger.dart';
import '../../../core/theme/ride_tokens.dart';
import '../domain/password_policy.dart';
import 'widgets/auth_widgets.dart';

/// Pantalla 2 del mockup v2 — gate PASSWORD_CHANGE_REQUIRED (REGROUND §3).
///
/// Bloqueante DE VERDAD: sin AppBar con back y PopScope(canPop: false); el
/// redirect del router trae aquí mientras mustChangePassword sea true. El
/// checklist vivo renderiza la política REAL del backend (password_policy.dart
/// espeja validatePassword) — el CTA se habilita al cumplirla localmente,
/// pero el servidor manda igual. Al éxito el backend devuelve {token, user}
/// fresco: se intercambia el JWT y se muestra el frame de éxito SIN re-login.
class ChangePasswordScreen extends ConsumerStatefulWidget {
  const ChangePasswordScreen({super.key, this.resumeTo});

  /// Destino original preservado por el redirect (?from=) para reanudar al
  /// tocar "Continuar" tras el éxito.
  final String? resumeTo;

  @override
  ConsumerState<ChangePasswordScreen> createState() =>
      _ChangePasswordScreenState();
}

class _ChangePasswordScreenState extends ConsumerState<ChangePasswordScreen> {
  final _current = TextEditingController();
  final _next = TextEditingController();
  var _obscureCurrent = true;
  var _obscureNext = true;
  var _submitting = false;
  var _success = false;
  ApiError? _error;

  @override
  void initState() {
    super.initState();
    // Telemetría: el gate se mostró (solo cuando de verdad es el gate, no en
    // una futura visita voluntaria a la pantalla).
    if (ref.read(sessionControllerProvider).mustChangePassword) {
      ref.read(eventLoggerProvider).log(AuthEvents.passwordGateShown);
    }
  }

  @override
  void dispose() {
    _current.dispose();
    _next.dispose();
    super.dispose();
  }

  PasswordPolicyResult get _policy =>
      PasswordPolicy.evaluate(candidate: _next.text, current: _current.text);

  bool get _canSubmit =>
      !_submitting && _current.text.isNotEmpty && _policy.allMet;

  /// El backend responde 400 con mensaje para "Current password is incorrect"
  /// (auth.routes.js:86-89) — lo detectamos por mensaje porque NO trae `code`.
  bool get _isCurrentWrong =>
      _error != null &&
      _error!.kind == ApiErrorKind.badRequest &&
      _error!.message.toLowerCase().contains('current password is incorrect');

  Future<void> _submit() async {
    if (!_canSubmit) return;
    setState(() {
      _submitting = true;
      _error = null;
    });
    try {
      await ref
          .read(sessionControllerProvider.notifier)
          .changePassword(
            currentPassword: _current.text,
            newPassword: _next.text,
          );
      // El estado de sesión ya trae mustChangePassword=false y el token
      // fresco quedó en el Keystore. El redirect NO nos expulsa de esta ruta
      // (diseño del router) — mostramos el frame de éxito del mockup 2C.
      if (mounted) setState(() => _success = true);
    } on ApiError catch (e) {
      if (mounted) setState(() => _error = e);
    } finally {
      if (mounted) setState(() => _submitting = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    // Status bar en oscuro: esta pantalla es clara (n50/tonal), sin aurora
    // (GD MUST-3).
    return AnnotatedRegion<SystemUiOverlayStyle>(
      value: SystemUiOverlayStyle.dark,
      child: PopScope(
        canPop: false,
        child: Scaffold(
          backgroundColor: RideTokens.n50,
          body: _success
              // Fondo .tonal-scr del mockup 2C: tonal → n50 (GD S-4).
              ? DecoratedBox(
                  decoration: const BoxDecoration(
                    gradient: RideTokens.tonalScreenGradient,
                  ),
                  child: SafeArea(child: _buildSuccess(l10n)),
                )
              : SafeArea(child: _buildForm(l10n)),
        ),
      ),
    );
  }

  Widget _buildForm(AppLocalizations l10n) {
    final policy = _policy;
    final offline = _error?.kind == ApiErrorKind.network;
    return SingleChildScrollView(
      padding: const EdgeInsets.fromLTRB(18, 14, 18, 22),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Align(
            alignment: Alignment.centerLeft,
            child: _RequiredChip(label: l10n.changePasswordChip),
          ),
          const SizedBox(height: 10),
          Text(
            l10n.changePasswordTitle,
            style: const TextStyle(
              fontSize: 24,
              fontWeight: FontWeight.w900,
              letterSpacing: -0.2,
              color: RideTokens.n900,
            ),
          ),
          const SizedBox(height: 4),
          Text(
            l10n.changePasswordBody,
            style: const TextStyle(fontSize: 13.5, color: RideTokens.n700),
          ),
          if (_isCurrentWrong) ...[
            const SizedBox(height: 8),
            RideBanner(
              kind: RideBannerKind.danger,
              text: l10n.changePasswordCurrentWrong,
            ),
          ] else if (offline) ...[
            const SizedBox(height: 8),
            RideBanner(
              kind: RideBannerKind.warn,
              text: l10n.errorNoConnectionRetry,
            ),
          ] else if (_error != null) ...[
            const SizedBox(height: 8),
            // 400 de política del servidor u otros: título localizado,
            // mensaje crudo del backend como detalle (DoD #5 / ADR-8).
            RideBanner(
              kind: RideBannerKind.danger,
              text: l10n.genericError,
              detail: _error!.message,
            ),
          ],
          FieldLabel(l10n.currentPasswordLabel),
          RideTextField(
            controller: _current,
            hasError: _isCurrentWrong,
            obscure: _obscureCurrent,
            onToggleObscure: () =>
                setState(() => _obscureCurrent = !_obscureCurrent),
            obscureToggleLabel: _obscureCurrent
                ? l10n.showPassword
                : l10n.hidePassword,
            textInputAction: TextInputAction.next,
            onChanged: (_) => setState(() {}),
          ),
          FieldLabel(l10n.newPasswordLabel),
          RideTextField(
            controller: _next,
            obscure: _obscureNext,
            onToggleObscure: () => setState(() => _obscureNext = !_obscureNext),
            obscureToggleLabel: _obscureNext
                ? l10n.showPassword
                : l10n.hidePassword,
            textInputAction: TextInputAction.done,
            onChanged: (_) => setState(() {}),
            onSubmitted: (_) => _submit(),
          ),
          const SizedBox(height: 10),
          _PolicyCard(policy: policy, l10n: l10n),
          const SizedBox(height: 16),
          RidePrimaryButton(
            label: l10n.changePasswordButton,
            loading: _submitting,
            loadingLabel: l10n.changePasswordSaving,
            onPressed: _canSubmit ? _submit : null,
          ),
          const SizedBox(height: 14),
          Center(
            child: Text(
              l10n.changePasswordFootnote,
              textAlign: TextAlign.center,
              style: const TextStyle(
                fontSize: 11.5,
                fontWeight: FontWeight.w600,
                color: RideTokens.n600,
              ),
            ),
          ),
        ],
      ),
    );
  }

  /// Frame 2C: éxito centrado. El "siguiente paso: PIN" del mockup se omite
  /// hasta que exista el PIN (H2) — no se promete UI que no existe.
  Widget _buildSuccess(AppLocalizations l10n) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(18, 14, 18, 22),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          const Spacer(),
          Container(
            width: 76,
            height: 76,
            alignment: Alignment.center,
            decoration: const BoxDecoration(
              color: RideTokens.okBg,
              shape: BoxShape.circle,
            ),
            child: const Icon(
              Icons.check_rounded,
              size: 40,
              color: RideTokens.okTx,
            ),
          ),
          const SizedBox(height: 12),
          Text(
            l10n.changePasswordSuccessTitle,
            textAlign: TextAlign.center,
            style: const TextStyle(
              fontSize: 22,
              fontWeight: FontWeight.w900,
              color: RideTokens.n900,
            ),
          ),
          const SizedBox(height: 6),
          Text(
            l10n.changePasswordSuccessBody,
            textAlign: TextAlign.center,
            style: const TextStyle(fontSize: 14, color: RideTokens.n700),
          ),
          const Spacer(),
          RidePrimaryButton(
            label: l10n.continueButton,
            onPressed: () => context.go(widget.resumeTo ?? AppRoutes.home),
          ),
        ],
      ),
    );
  }
}

/// Chip "Paso obligatorio" (el pulso del dot del mockup se difiere: regla de
/// la casa, nada de animaciones infinitas que además cuelgan pumpAndSettle).
class _RequiredChip extends StatelessWidget {
  const _RequiredChip({required this.label});

  final String label;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 4),
      decoration: BoxDecoration(
        color: RideTokens.p50,
        borderRadius: BorderRadius.circular(8),
        border: Border.all(color: RideTokens.brandA20),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Container(
            width: 6,
            height: 6,
            decoration: const BoxDecoration(
              color: RideTokens.p800,
              shape: BoxShape.circle,
            ),
          ),
          const SizedBox(width: 6),
          Text(
            label.toUpperCase(),
            style: const TextStyle(
              fontSize: 12,
              fontWeight: FontWeight.w700,
              letterSpacing: 0.4,
              color: RideTokens.p800,
            ),
          ),
        ],
      ),
    );
  }
}

/// Checklist vivo sobre superficie tonal + medidor de fuerza segmentado
/// (mockup 2A). El medidor es decorativo; el estado legible vive en el texto.
class _PolicyCard extends StatelessWidget {
  const _PolicyCard({required this.policy, required this.l10n});

  final PasswordPolicyResult policy;
  final AppLocalizations l10n;

  @override
  Widget build(BuildContext context) {
    final rules = <(bool, String)>[
      (policy.hasMinLength, l10n.policyRuleMinLength(PasswordPolicy.minLength)),
      (policy.hasLowercase, l10n.policyRuleLowercase),
      (policy.hasUppercase, l10n.policyRuleUppercase),
      (policy.hasDigit, l10n.policyRuleDigit),
      (policy.hasSpecial, l10n.policyRuleSpecial),
      (policy.differsFromCurrent, l10n.policyRuleDifferent),
    ];
    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: RideTokens.tonal,
        borderRadius: BorderRadius.circular(18),
        border: Border.all(color: RideTokens.brandA20),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            children: [
              for (var i = 0; i < 4; i++) ...[
                if (i > 0) const SizedBox(width: 6),
                Expanded(
                  child: Container(
                    height: 6,
                    decoration: BoxDecoration(
                      color: i < policy.strengthSegments
                          ? (policy.allMet ? RideTokens.ok : RideTokens.p600)
                          : RideTokens.n200,
                      borderRadius: BorderRadius.circular(3),
                    ),
                  ),
                ),
              ],
            ],
          ),
          const SizedBox(height: 10),
          for (final (met, label) in rules)
            Padding(
              padding: const EdgeInsets.symmetric(vertical: 4),
              child: Row(
                children: [
                  Container(
                    width: 20,
                    height: 20,
                    alignment: Alignment.center,
                    decoration: BoxDecoration(
                      shape: BoxShape.circle,
                      color: met ? RideTokens.okBg : Colors.transparent,
                      border: Border.all(
                        color: met ? RideTokens.okBd : RideTokens.n400,
                        width: 1.5,
                      ),
                    ),
                    child: met
                        ? const Icon(
                            Icons.check,
                            size: 13,
                            color: RideTokens.okTx,
                          )
                        : null,
                  ),
                  const SizedBox(width: 9),
                  Expanded(
                    child: Text(
                      label,
                      style: TextStyle(
                        fontSize: 13.5,
                        fontWeight: FontWeight.w600,
                        // Cumplidas en verde ok-tx; pendientes en n-700
                        // (contraste ≥ 7:1 sobre tonal — nota del mockup).
                        color: met ? RideTokens.okTx : RideTokens.n700,
                      ),
                    ),
                  ),
                ],
              ),
            ),
        ],
      ),
    );
  }
}
