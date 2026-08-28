import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/api/api_error.dart';
import '../../../core/config/app_config.dart';
import '../../../core/l10n/app_localizations.dart';
import '../../../core/session/session_controller.dart';
import '../../../core/session/session_state.dart';
import '../../../core/theme/ride_tokens.dart';
import 'widgets/auth_widgets.dart';

/// Pantalla 1 del mockup v2: hero aurora (solo branding) + hoja blanca opaca
/// con el formulario. Estados: loading en el botón, error de credenciales
/// (genérico, 401), sin red (banner + botón deshabilitado + reintentar).
///
/// La navegación post-login NO vive aquí: el redirect top-level del router
/// reacciona al cambio de sesión (refreshListenable) y reanuda el destino
/// preservado en ?from=.
class LoginScreen extends ConsumerStatefulWidget {
  const LoginScreen({super.key});

  @override
  ConsumerState<LoginScreen> createState() => _LoginScreenState();
}

class _LoginScreenState extends ConsumerState<LoginScreen> {
  final _email = TextEditingController();
  final _password = TextEditingController();
  var _obscure = true;
  var _submitting = false;

  /// Último error de login para pintar banner + bordes. `network` activa el
  /// modo sin-red (mockup 1C): botón deshabilitado + "Reintentar ahora".
  /// Detección simple vía ApiErrorKind.network — sin connectivity_plus
  /// todavía (TODO H4): el "se rehabilita al volver la señal" del mockup hoy
  /// es el reintento manual.
  ApiError? _error;

  @override
  void dispose() {
    _email.dispose();
    _password.dispose();
    super.dispose();
  }

  bool get _canSubmit =>
      !_submitting &&
      _error?.kind != ApiErrorKind.network &&
      _email.text.trim().isNotEmpty &&
      _password.text.isNotEmpty;

  Future<void> _submit() async {
    if (_submitting) return;
    setState(() {
      _submitting = true;
      _error = null;
    });
    try {
      await ref
          .read(sessionControllerProvider.notifier)
          .login(email: _email.text.trim(), password: _password.text);
      // Éxito: el router nos saca de /login solo (refreshListenable).
    } on ApiError catch (e) {
      if (mounted) setState(() => _error = e);
    } finally {
      if (mounted) setState(() => _submitting = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    final offline = _error?.kind == ApiErrorKind.network;
    final credsError = _error?.kind == ApiErrorKind.unauthorized;
    // GD MC-3: aterrizar aquí por una expulsión INVOLUNTARIA (401, política
    // de kiosco) sin explicación parece crash — el estado trae la razón y
    // se pinta como aviso mientras no haya un error de intento más reciente.
    final signOutReason = ref.watch(
      sessionControllerProvider.select(
        (s) => s.status == SessionStatus.unauthenticated
            ? s.signOutReason
            : null,
      ),
    );

    // Status bar en claro: los iconos del sistema viven sobre la aurora
    // oscura (GD MUST-3).
    return AnnotatedRegion<SystemUiOverlayStyle>(
      value: SystemUiOverlayStyle.light,
      child: Scaffold(
        resizeToAvoidBottomInset: true,
        body: AuroraBackdrop(
          child: Column(
            children: [
              // ── Hero aurora: SOLO branding, ningún dato ni control encima ──
              SafeArea(
                bottom: false,
                child: Padding(
                  padding: const EdgeInsets.fromLTRB(22, 26, 22, 22),
                  child: Row(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            _BrandMark(letter: l10n.appTitle.substring(0, 1)),
                            const SizedBox(height: 14),
                            Text(
                              l10n.appTitle,
                              style: const TextStyle(
                                color: Colors.white,
                                fontSize: 30,
                                fontWeight: FontWeight.w900,
                                height: 1.05,
                                letterSpacing: -0.3,
                              ),
                            ),
                            const SizedBox(height: 4),
                            Text(
                              l10n.loginSubtitle,
                              style: const TextStyle(
                                color: Color(0xE6FFFFFF),
                                fontSize: 14,
                                fontWeight: FontWeight.w600,
                              ),
                            ),
                          ],
                        ),
                      ),
                      // Chip de flavor (mockup nota 1): invisible en prod.
                      if (!AppConfig.current.isProd)
                        _FlavorChip(label: AppConfig.current.env.toUpperCase()),
                    ],
                  ),
                ),
              ),
              // ── Hoja blanca opaca: formulario, banners, CTA ──
              Expanded(
                child: Container(
                  width: double.infinity,
                  decoration: const BoxDecoration(
                    color: RideTokens.n0,
                    borderRadius: BorderRadius.vertical(
                      top: Radius.circular(28),
                    ),
                  ),
                  child: SafeArea(
                    top: false,
                    child: SingleChildScrollView(
                      padding: const EdgeInsets.fromLTRB(20, 12, 20, 20),
                      child: AutofillGroup(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.stretch,
                          children: [
                            Center(
                              child: Container(
                                width: 44,
                                height: 5,
                                decoration: BoxDecoration(
                                  color: RideTokens.n200,
                                  borderRadius: BorderRadius.circular(3),
                                ),
                              ),
                            ),
                            const SizedBox(height: 14),
                            if (_error == null && signOutReason != null)
                              RideBanner(
                                kind: RideBannerKind.warn,
                                text: switch (signOutReason) {
                                  SignOutReason.kioskRecovery =>
                                    l10n.loginKioskRelogin,
                                  SignOutReason.sessionExpired =>
                                    l10n.sessionExpired,
                                },
                              ),
                            if (credsError)
                              RideBanner(
                                kind: RideBannerKind.danger,
                                text: l10n.loginInvalidCredentials,
                              )
                            else if (offline)
                              RideBanner(
                                kind: RideBannerKind.warn,
                                text: l10n.loginOffline,
                              )
                            else if (_error?.kind == ApiErrorKind.rateLimited)
                              RideBanner(
                                kind: RideBannerKind.warn,
                                text: l10n.errorRateLimited,
                              )
                            else if (_error != null)
                              RideBanner(
                                kind: RideBannerKind.danger,
                                text: l10n.genericError,
                                detail: _error!.message,
                              ),
                            FieldLabel(l10n.loginEmailLabel),
                            RideTextField(
                              controller: _email,
                              hasError: credsError,
                              keyboardType: TextInputType.emailAddress,
                              textInputAction: TextInputAction.next,
                              autofillHints: const [AutofillHints.username],
                              onChanged: (_) => setState(() {}),
                            ),
                            FieldLabel(l10n.loginPasswordLabel),
                            RideTextField(
                              controller: _password,
                              hasError: credsError,
                              obscure: _obscure,
                              onToggleObscure: () =>
                                  setState(() => _obscure = !_obscure),
                              obscureToggleLabel: _obscure
                                  ? l10n.showPassword
                                  : l10n.hidePassword,
                              textInputAction: TextInputAction.done,
                              autofillHints: const [AutofillHints.password],
                              onChanged: (_) => setState(() {}),
                              onSubmitted: (_) {
                                if (_canSubmit) _submit();
                              },
                            ),
                            const SizedBox(height: 20),
                            RidePrimaryButton(
                              label: l10n.loginButton,
                              loading: _submitting,
                              loadingLabel: l10n.loginButtonLoading,
                              onPressed: _canSubmit ? _submit : null,
                            ),
                            if (offline) ...[
                              const SizedBox(height: 10),
                              RideGhostButton(
                                label: l10n.loginRetryNow,
                                onPressed: _submitting
                                    ? null
                                    : _retryFromOffline,
                              ),
                            ],
                            // Sin "olvidé mi contraseña" self-service: el flujo
                            // staff es reset por admin + contraseña temporal
                            // (confirmado contra auth.service.js — no existe
                            // endpoint de reset público).
                            Container(
                              constraints: const BoxConstraints(minHeight: 48),
                              alignment: Alignment.center,
                              child: Text(
                                l10n.loginHelpLine,
                                textAlign: TextAlign.center,
                                style: const TextStyle(
                                  fontSize: 13.5,
                                  fontWeight: FontWeight.w700,
                                  color: RideTokens.p700,
                                ),
                              ),
                            ),
                            const SizedBox(height: 8),
                            Center(
                              child: Text(
                                l10n.loginVersionLine(
                                  AppConfig.appVersion,
                                  AppConfig.current.env,
                                  Localizations.localeOf(context).languageCode,
                                ),
                                style: const TextStyle(
                                  fontSize: 11.5,
                                  fontWeight: FontWeight.w600,
                                  color: RideTokens.n600,
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
            ],
          ),
        ),
      ),
    );
  }

  /// "Reintentar ahora" del estado sin-red: limpia el estado offline y vuelve
  /// a intentar con las mismas credenciales.
  void _retryFromOffline() {
    setState(() => _error = null);
    if (_email.text.trim().isNotEmpty && _password.text.isNotEmpty) {
      _submit();
    }
  }
}

/// Marca "R" del hero (52 px, vidrio sobre la aurora — decorativo).
class _BrandMark extends StatelessWidget {
  const _BrandMark({required this.letter});

  final String letter;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: 52,
      height: 52,
      alignment: Alignment.center,
      decoration: BoxDecoration(
        color: const Color(0x24FFFFFF),
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: const Color(0x59FFFFFF)),
      ),
      child: Text(
        letter,
        style: const TextStyle(
          color: Colors.white,
          fontSize: 26,
          fontWeight: FontWeight.w900,
        ),
      ),
    );
  }
}

class _FlavorChip extends StatelessWidget {
  const _FlavorChip({required this.label});

  final String label;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 4),
      decoration: BoxDecoration(
        color: RideTokens.warnBg,
        borderRadius: BorderRadius.circular(8),
        border: Border.all(color: RideTokens.warnBd),
      ),
      child: Text(
        label,
        style: const TextStyle(
          fontSize: 11,
          fontWeight: FontWeight.w800,
          letterSpacing: 0.6,
          color: RideTokens.warnTx,
        ),
      ),
    );
  }
}
