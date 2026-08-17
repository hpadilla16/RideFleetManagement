import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'app.dart';
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
