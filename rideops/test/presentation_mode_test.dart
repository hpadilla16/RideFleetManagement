import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:rideops/core/device/presentation_mode.dart';
import 'package:screen_brightness/screen_brightness.dart';
import 'package:wakelock_plus/wakelock_plus.dart';

import 'helpers/auth_test_helpers.dart';

/// [PluginPresentationScreen] contra plugins que NO existen.
///
/// La fachada del modo presentación existe por una afirmación concreta: *un
/// plugin caído no puede tumbar el paso de firma*. Esa afirmación vivía sin
/// prueba — las pruebas del paso inyectan `NoopPresentationScreen`, que por
/// construcción no puede fallar, así que el `_guard` real tenía cobertura cero
/// (QA-M1).
///
/// Aquí se prueba la implementación REAL sin emulador: en la VM de test no hay
/// canales de plataforma, así que `screen_brightness` y `wakelock_plus` fallan
/// **de verdad** al primer intento. Es exactamente el modo de fallo que el
/// guard promete absorber (más benigno que el del aparato, pero del mismo tipo:
/// la llamada al canal termina en excepción).
void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  /// Canal del plugin de brillo. Se declara por NOMBRE en vez de importar
  /// `screen_brightness_platform_interface` porque esa es una dependencia
  /// transitiva; el nombre está verificado contra
  /// `constant/plugin_channel.dart` del paquete (2.1.2).
  const brightnessChannel =
      MethodChannel('github.com/aaassseee/screen_brightness');

  final messenger =
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;

  tearDown(() {
    messenger.setMockMethodCallHandler(brightnessChannel, null);
  });

  test('CENTINELA — sin canales de plataforma los dos plugins fallan de VERDAD '
      '(si algún día dejaran de fallar, las pruebas de abajo no estarían '
      'ejercitando nada)', () async {
    await expectLater(
      ScreenBrightness.instance.setApplicationScreenBrightness(1),
      throwsA(isA<MissingPluginException>()),
    );
    // wakelock_plus habla por pigeon: una respuesta nula del canal se convierte
    // en PlatformException('channel-error'), no en MissingPluginException.
    await expectLater(
      WakelockPlus.enable(),
      throwsA(isA<PlatformException>()),
    );
  });

  test('enter() con los dos plugins muertos NO tira: cuenta una degradación '
      'por operación, con su `what` y su `phase`', () async {
    final logger = CapturingEventLogger();

    // Que esto complete es LA afirmación: si el guard no atrapara, la excepción
    // subiría hasta el `unawaited(_screen.enter())` del initState y se
    // convertiría en un error no capturado durante el paso de firma.
    await expectLater(PluginPresentationScreen(logger).enter(), completes);

    expect(
      logger.events.map((e) => e.$1).toSet(),
      {'checkout.present_mode_screen_degraded'},
    );
    expect(logger.events.map((e) => e.$2).toList(), [
      {'what': 'brightness', 'phase': 'enter'},
      {'what': 'wakelock', 'phase': 'enter'},
    ]);
  });

  test('exit() tampoco tira, y el fallo de un plugin no cancela la '
      'restauración del otro: se intentan los DOS, en orden inverso', () async {
    final logger = CapturingEventLogger();

    await expectLater(PluginPresentationScreen(logger).exit(), completes);

    // Los dos eventos presentes = las dos restauraciones se intentaron. Si el
    // `await` del wakelock hubiera dejado escapar su excepción, el brillo no
    // se habría intentado siquiera y aquí habría UN solo evento.
    expect(logger.events.map((e) => e.$2).toList(), [
      {'what': 'wakelock', 'phase': 'exit'},
      {'what': 'brightness', 'phase': 'exit'},
    ]);
  });

  test('lo que SÍ funciona no se reporta: con el canal de brillo respondiendo, '
      'solo queda la degradación del wakelock', () async {
    final calls = <MethodCall>[];
    messenger.setMockMethodCallHandler(brightnessChannel, (call) async {
      calls.add(call);
      return null;
    });
    final logger = CapturingEventLogger();

    await PluginPresentationScreen(logger).enter();

    expect(calls.single.method, 'setApplicationScreenBrightness');
    expect(calls.single.arguments, {'brightness': 1.0},
        reason: 'el modo presentación pide el máximo, no un valor intermedio');
    expect(logger.events.map((e) => e.$2).toList(), [
      {'what': 'wakelock', 'phase': 'enter'},
    ]);
  });
}
