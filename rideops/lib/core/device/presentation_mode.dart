import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:screen_brightness/screen_brightness.dart';
import 'package:wakelock_plus/wakelock_plus.dart';

import '../telemetry/event_logger.dart';

/// Pantalla en MODO PRESENTACIÓN (mockup 10B, review GD-MC-2).
///
/// Dos cosas que el mockup dejó escritas como requisito de build y que ninguna
/// API de Dart puro puede hacer:
///  1. **Brillo al máximo** mientras el QR está a la vista. El escaneo ocurre a
///     un brazo de distancia, con guantes y con el sol de frente: a brillo
///     automático el patio devuelve un código que la cámara del cliente no
///     engancha.
///  2. **Pantalla despierta**. Sin wakelock el teléfono se atenúa y **se
///     bloquea a los ~30 s** — justo mientras el cliente está leyendo el
///     código. El agente tendría que desbloquear su teléfono en la cara del
///     cliente, que es exactamente lo que 10B existe para evitar.
///
/// Se encapsula detrás de esta interfaz (y no se llama al plugin desde el
/// widget) por dos razones: los widget tests no tienen canales de plataforma —
/// un `MissingPluginException` no puede tumbar el paso de firma — y así el
/// PAR entrar/salir es testeable sin emulador.
///
/// ## ¿La restauración está garantizada?
/// **En Android, sí, y por partida doble.** Ninguno de los dos plugins toca
/// estado GLOBAL del dispositivo: los dos escriben sobre la ventana de la
/// actividad —`WindowManager.LayoutParams.screenBrightness`
/// (`ScreenBrightnessAndroidPlugin.kt:373-375`) y `FLAG_KEEP_SCREEN_ON`
/// (`wakelock_plus/Wakelock.kt:24-26`, que además por eso NO necesita el
/// permiso WAKE_LOCK)—. Ese override vive y muere con la ventana: aunque el
/// proceso se caiga con la pantalla volteada al cliente, el sistema recupera
/// brillo y apagado solo. Nuestro [exit] es la ruta normal, no la única red.
///
/// **En iOS, el brillo no del todo**, y por dos motivos distintos:
///  - Ahí el plugin escribe `UIScreen.main.brightness`, que es global del
///    dispositivo: si el proceso muere sin pasar por [exit], el teléfono se
///    queda al 100% hasta que el usuario lo baje. El plugin ofrece un
///    `setAutoReset` (iOS-only) que restaura al cambiar el ciclo de vida, pero
///    **no cubre un kill duro**.
///  - Y `resetApplicationScreenBrightness` **no lee el brillo vivo**: reescribe
///    el valor que el plugin MEMORIZÓ al registrarse
///    (`ScreenBrightnessIosPlugin.swift:29`), que solo se refresca al volver a
///    primer plano — el observador de `brightnessDidChangeNotification` se
///    instala al resignar (`:204`) y se quita al re-activarse (`:212`). O sea:
///    si el agente bajó el brillo A MANO con la app en primer plano, salir del
///    modo presentación se lo pisa con el brillo de arranque en vez de
///    devolverle el suyo.
///
/// Se deja dicho en vez de fingirlo; esta máquina no compila iOS (sin Mac) y
/// cuando M4 abra esa plataforma hay que re-evaluarlo.
abstract class PresentationScreen {
  /// Brillo al máximo + pantalla despierta. Best-effort: lo que falle se
  /// reporta a telemetría y el modo presentación sigue — un QR que no se puede
  /// enseñar porque un plugin no respondió sería peor que un QR con brillo
  /// automático.
  Future<void> enter();

  /// Deshace [enter]. Se llama SIEMPRE al salir, incluido el camino de
  /// excepción (ver `present_mode_screen.dart`).
  Future<void> exit();
}

/// Implementación real. Cada operación va por su cuenta: que el wakelock falle
/// no puede impedir que el brillo se restaure, ni al revés.
class PluginPresentationScreen implements PresentationScreen {
  const PluginPresentationScreen(this._logger);

  final EventLogger _logger;

  @override
  Future<void> enter() async {
    await _guard('brightness', 'enter', () async {
      await ScreenBrightness.instance.setApplicationScreenBrightness(1);
    });
    await _guard('wakelock', 'enter', () => WakelockPlus.enable());
  }

  @override
  Future<void> exit() async {
    // Orden inverso al de [enter], y los dos SIEMPRE se intentan: un `await`
    // que tirara excepción aquí se llevaría por delante la restauración
    // siguiente. Por eso cada uno va dentro de su propio guard.
    await _guard('wakelock', 'exit', () => WakelockPlus.disable());
    await _guard('brightness', 'exit', () async {
      await ScreenBrightness.instance.resetApplicationScreenBrightness();
    });
  }

  Future<void> _guard(
    String what,
    String phase,
    Future<void> Function() action,
  ) async {
    try {
      await action();
    } catch (_) {
      // Se cuenta, no se muestra: el cliente está mirando esta pantalla y un
      // error de plugin no es asunto suyo. Un `exit` fallido en iOS es lo que
      // deja el teléfono al 100% — por eso se distingue la fase.
      _logger.log(
        CheckoutEvents.presentModeScreenDegraded,
        data: {'what': what, 'phase': phase},
      );
    }
  }
}

/// No-op para tests y para plataformas donde no hay nada que ajustar. Cuenta
/// las llamadas para que el par entrar/salir sea verificable.
class NoopPresentationScreen implements PresentationScreen {
  int enters = 0;
  int exits = 0;

  @override
  Future<void> enter() async => enters++;

  @override
  Future<void> exit() async => exits++;
}

final presentationScreenProvider = Provider<PresentationScreen>(
  (ref) => PluginPresentationScreen(ref.read(eventLoggerProvider)),
);
