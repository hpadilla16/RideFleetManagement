import 'package:flutter/material.dart';

import '../../../core/l10n/app_localizations.dart';
import '../../../core/theme/ride_tokens.dart';

/// Pantalla de restauración de sesión (SessionStatus.restoring): aurora +
/// wordmark, sin spinner — la hidratación tarda milisegundos (Keystore) y un
/// spinner que parpadea un frame solo mete ruido. Si /me tarda por red, la
/// sesión ya pasó a authenticated y el router nos sacó de aquí.
class SplashScreen extends StatelessWidget {
  const SplashScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    return Scaffold(
      body: Container(
        decoration: const BoxDecoration(gradient: RideTokens.aurora),
        alignment: Alignment.center,
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
    );
  }
}
