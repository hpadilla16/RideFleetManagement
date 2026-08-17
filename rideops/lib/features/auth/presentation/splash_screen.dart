import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../../core/l10n/app_localizations.dart';
import 'widgets/auth_widgets.dart';

/// Pantalla de restauración de sesión (SessionStatus.restoring): aurora (con
/// su acento cálido, igual que el login) + wordmark, sin spinner — la
/// hidratación tarda milisegundos (Keystore) y un spinner que parpadea un
/// frame solo mete ruido. Si /me tarda por red, la sesión ya pasó a
/// authenticated y el router nos sacó de aquí.
class SplashScreen extends StatelessWidget {
  const SplashScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    // Status bar en claro sobre la aurora oscura (GD MUST-3).
    return AnnotatedRegion<SystemUiOverlayStyle>(
      value: SystemUiOverlayStyle.light,
      child: Scaffold(
        body: AuroraBackdrop(
          child: Center(
            child: Text(
              l10n.appTitle,
              style: const TextStyle(
                color: Colors.white,
                fontSize: 30,
                fontWeight: FontWeight.w900,
                letterSpacing: -0.3,
              ),
            ),
          ),
        ),
      ),
    );
  }
}
