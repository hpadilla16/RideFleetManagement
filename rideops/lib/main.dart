import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'core/l10n/app_localizations.dart';
import 'spike/token_probe.dart';

/// Entry point neutro. Los flavors (dev/stg/prod) entran por
/// main_dev.dart / main_stg.dart / main_prod.dart, que configuran
/// [AppConfig] y Sentry antes de llamar [bootstrap].
void main() => bootstrap();

void bootstrap() {
  WidgetsFlutterBinding.ensureInitialized();
  // Spike 1 (M0-1a): solo con --dart-define=RIDEOPS_SPIKE1=true; se retira
  // al cerrar el spike.
  if (spike1Enabled) {
    unawaited(setupSpike1());
  }
  runApp(const ProviderScope(child: RideOpsApp()));
}

class RideOpsApp extends StatelessWidget {
  const RideOpsApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      onGenerateTitle: (context) => AppLocalizations.of(context)!.appTitle,
      localizationsDelegates: const [
        AppLocalizations.delegate,
        GlobalMaterialLocalizations.delegate,
        GlobalWidgetsLocalizations.delegate,
        GlobalCupertinoLocalizations.delegate,
      ],
      supportedLocales: const [Locale('es'), Locale('en')],
      theme: ThemeData(
        colorScheme: ColorScheme.fromSeed(
          // Ride theme (CLAUDE.md).
          seedColor: const Color(0xFF8752FE),
        ),
        useMaterial3: true,
      ),
      home: const _M0Placeholder(),
    );
  }
}

/// M0 no tiene pantallas (el plan lo prohíbe hasta cerrar la columna
/// vertebral) — esto solo prueba que el árbol arranca con l10n y tema.
class _M0Placeholder extends StatelessWidget {
  const _M0Placeholder();

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    return Scaffold(
      body: Center(child: Text(l10n.appTitle)),
    );
  }
}
