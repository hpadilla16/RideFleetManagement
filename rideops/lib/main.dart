import 'dart:async';
import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:sentry_flutter/sentry_flutter.dart';
import 'package:workmanager/workmanager.dart';

import 'app.dart';
import 'core/config/app_config.dart';
import 'core/outbox/background_drain.dart';
import 'core/telemetry/sentry_setup.dart';

/// Entry point único. Los flavors NO tienen entrypoint propio: el flavor de
/// Android decide el applicationId y los `--dart-define` (RIDEOPS_ENV,
/// RIDEOPS_API_BASE, RIDEOPS_SENTRY_DSN) deciden a qué API habla y si
/// reporta — ver [AppConfig] y el job android-build de rideops-ci.yml.
Future<void> main() => bootstrap();

Future<void> bootstrap() async {
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

  // Observabilidad (M0-4). Con DSN, Sentry envuelve el runApp para capturar
  // también los errores de arranque; sin DSN arrancamos directo — un dev sin
  // secretos corre la app idéntica, solo que muda.
  final config = AppConfig.current;
  if (config.sentryEnabled) {
    await SentryFlutter.init(
      (options) => configureSentryOptions(options, config),
      appRunner: _runApp,
    );
  } else {
    _runApp();
  }
}

void _runApp() => runApp(const ProviderScope(child: RideOpsApp()));
