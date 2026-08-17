import 'dart:async';
import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:workmanager/workmanager.dart';

import 'app.dart';
import 'core/config/app_config.dart';
import 'core/outbox/background_drain.dart';

/// Entry point neutro. Los flavors (dev/stg/prod) entran por
/// main_dev.dart / main_stg.dart / main_prod.dart, que configuran
/// [AppConfig] y Sentry antes de llamar [bootstrap].
void main() => bootstrap();

void bootstrap() {
  WidgetsFlutterBinding.ensureInitialized();
  // INN S-4 (review H6): el footgun declarado en el reporte del pase — sin
  // RIDEOPS_API_BASE el default compilado es el localhost de dev. Un build
  // PROD apuntando a http:// (o al default) no debe llegar ni al login:
  // morir ruidoso en el primer frame es más barato que un release espía.
  if (AppConfig.current.isProd &&
      AppConfig.current.apiBaseUrl.startsWith('http://')) {
    throw StateError(
      'RideOps prod exige una API https:// — apiBaseUrl actual: '
      '${AppConfig.current.apiBaseUrl}. Pasa --dart-define=RIDEOPS_API_BASE.',
    );
  }
  // Drenado en background (H6): registrar el dispatcher UNA vez al arrancar.
  // Solo móvil — en desktop/web no hay WorkManager (y los tests no pasan por
  // bootstrap). El spike M0-1a (token_probe) cerró y se retiró: este es su
  // sucesor de producción.
  if (!kIsWeb && (Platform.isAndroid || Platform.isIOS)) {
    unawaited(
      Workmanager()
          .initialize(outboxBackgroundDispatcher)
          .catchError((Object _) {}),
    );
  }
  runApp(const ProviderScope(child: RideOpsApp()));
}
