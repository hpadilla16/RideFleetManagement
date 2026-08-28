import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

/// Flag persistente "hay un modo kiosco en curso" (H6 — política
/// kiosco-vs-exempt, decisión del PM: EL KIOSCO IGNORA LA EXENCIÓN).
///
/// Por qué existe: Flutter puro no puede bloquear home/app-switcher. Si el
/// cliente (con el teléfono volteado hacia él) mata y relanza la app, el
/// arranque debe aterrizar en el candado AUNQUE el dueño de la sesión sea
/// `screenLockExempt` — la exención protege al empleado de fricción, no al
/// teléfono en manos de un tercero. El flag se escribe al ENTRAR al modo
/// kiosco, se limpia al salir limpio, y si sobrevive a un cold start el
/// LockController fuerza el candado UNA vez (o re-login con contraseña si no
/// hay PIN) antes de limpiarlo.
abstract class KioskGuardStore {
  Future<bool> read();
  Future<void> set();
  Future<void> clear();
}

/// Mismo Keystore/AndroidOptions que el resto de secretos de sesión: legible
/// en cold start sin desbloquear nada.
class SecureKioskGuardStore implements KioskGuardStore {
  const SecureKioskGuardStore();

  static const _storage = FlutterSecureStorage(
    aOptions: AndroidOptions(
      encryptedSharedPreferences: true,
    ),
  );

  static const _key = 'rideops.kiosk_in_progress';

  @override
  Future<bool> read() async => await _storage.read(key: _key) == '1';

  @override
  Future<void> set() => _storage.write(key: _key, value: '1');

  @override
  Future<void> clear() => _storage.delete(key: _key);
}

final Provider<KioskGuardStore> kioskGuardStoreProvider =
    Provider<KioskGuardStore>((ref) => const SecureKioskGuardStore());
