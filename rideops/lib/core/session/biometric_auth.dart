import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:local_auth/local_auth.dart';

/// Fachada sobre local_auth (H2): la huella es una TECLA del keypad, no un
/// flujo aparte (mockup 3B, anotación 4). Abstracta para fakear en tests y
/// para que el fallback a solo-PIN sea silencioso: cualquier fallo del
/// plugin/hardware se responde con false y la UI simplemente no muestra la
/// tecla — jamás un crash ni un modal de error por no tener sensor.
abstract class BiometricAuth {
  /// true si el aparato tiene hardware Y al menos una biometría enrolada.
  Future<bool> isAvailable();

  /// Dispara el prompt del sistema. [reason] va localizado (lo pasa la
  /// pantalla desde l10n). false = canceló, falló o el aparato no puede.
  Future<bool> authenticate({required String reason});
}

class LocalAuthBiometric implements BiometricAuth {
  LocalAuthBiometric();

  final LocalAuthentication _auth = LocalAuthentication();

  @override
  Future<bool> isAvailable() async {
    try {
      if (!await _auth.isDeviceSupported()) return false;
      return (await _auth.getAvailableBiometrics()).isNotEmpty;
    } catch (_) {
      // MissingPluginException / PlatformException (p. ej. Activity que no es
      // FragmentActivity): degradar a solo-PIN sin ruido.
      return false;
    }
  }

  @override
  Future<bool> authenticate({required String reason}) async {
    try {
      return await _auth.authenticate(
        localizedReason: reason,
        options: const AuthenticationOptions(
          // Solo biometría: el fallback a credencial del SISTEMA confundiría
          // (el PIN de RideOps no es el PIN del teléfono).
          biometricOnly: true,
          stickyAuth: true,
        ),
      );
    } catch (_) {
      return false;
    }
  }
}

final biometricAuthProvider =
    Provider<BiometricAuth>((ref) => LocalAuthBiometric());
