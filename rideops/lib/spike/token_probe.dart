import 'dart:convert';
import 'dart:io';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:path_provider/path_provider.dart';
import 'package:workmanager/workmanager.dart';

/// Spike 1 (M0-1a) — ¿puede un isolate de BACKGROUND leer el token seguro?
///
/// Protocolo: ops-app-plan/spikes/spike-1-token-background-isolate.md.
/// Solo se activa con --dart-define=RIDEOPS_SPIKE1=true (flavor dev); no
/// forma parte de la app real y se retira al cerrar el spike.
///
/// El resultado se escribe a files/spike1_result.json (legible con
/// `adb shell run-as com.ridefleet.rideops.dev cat files/spike1_result.json`).

const spike1Enabled = bool.fromEnvironment('RIDEOPS_SPIKE1');

const _storage = FlutterSecureStorage(
  aOptions: AndroidOptions(
    encryptedSharedPreferences: true,
    // Sin auth requerida: el drenador corre con el teléfono en el bolsillo.
  ),
);

const _tokenKey = 'spike1_token';
const _taskBackground = 'spike1-read-after-kill';
const _taskReboot = 'spike1-read-after-reboot';

/// Corre en el ISOLATE DE BACKGROUND que levanta WorkManager — sin Activity,
/// sin ProviderContainer, motor Flutter headless.
@pragma('vm:entry-point')
void spikeCallbackDispatcher() {
  Workmanager().executeTask((task, inputData) async {
    final result = <String, Object?>{
      'task': task,
      'at': DateTime.now().toIso8601String(),
    };
    try {
      final token = await _storage.read(key: _tokenKey);
      result['ok'] = token != null && token.isNotEmpty;
      result['tokenLen'] = token?.length ?? 0;
    } catch (e) {
      result['ok'] = false;
      result['error'] = e.toString();
    }
    await _appendResult(result);
    return true;
  });
}

Future<void> _appendResult(Map<String, Object?> result) async {
  final dir = await getApplicationSupportDirectory();
  final f = File('${dir.path}/spike1_result.json');
  final list = f.existsSync()
      ? (json.decode(f.readAsStringSync()) as List<dynamic>)
      : <dynamic>[];
  list.add(result);
  f.writeAsStringSync(json.encode(list));
}

/// Llamado desde bootstrap() en el flavor dev cuando el spike está activo:
/// siembra un token falso y agenda las dos tareas del protocolo.
Future<void> setupSpike1() async {
  await _storage.write(
    key: _tokenKey,
    value: 'spike-fake-jwt-${'x' * 180}',
  );
  await Workmanager().initialize(spikeCallbackDispatcher);
  // Caso A: la app se manda a background y se mata el proceso; la tarea
  // dispara ~15 s después con la app muerta.
  await Workmanager().registerOneOffTask(
    _taskBackground,
    _taskBackground,
    initialDelay: const Duration(seconds: 15),
    existingWorkPolicy: ExistingWorkPolicy.replace,
  );
  // Caso B: reboot — WorkManager persiste el job; esta tarea de 90 s cae
  // después del arranque si el reboot ocurre antes.
  await Workmanager().registerOneOffTask(
    _taskReboot,
    _taskReboot,
    initialDelay: const Duration(seconds: 90),
    existingWorkPolicy: ExistingWorkPolicy.replace,
  );
  await _appendResult({'task': 'setup', 'at': DateTime.now().toIso8601String(), 'ok': true});
}
