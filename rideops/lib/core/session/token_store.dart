import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

/// Persistencia del JWT de staff (ADR-3). Abstracto para que los tests usen
/// una implementación en memoria sin tocar el Keystore.
abstract class TokenStore {
  Future<String?> read();
  Future<void> write(String token);
  Future<void> clear();
}

/// Keystore/Keychain vía flutter_secure_storage, con las MISMAS AndroidOptions
/// que aprobó el spike M0-1a (token_probe, retirado en H6):
/// encryptedSharedPreferences y sin auth de usuario requerida — el drenador de
/// la bandeja necesita leer el token con el teléfono en el bolsillo.
class SecureTokenStore implements TokenStore {
  const SecureTokenStore();

  static const _storage = FlutterSecureStorage(
    aOptions: AndroidOptions(
      encryptedSharedPreferences: true,
    ),
  );

  /// Namespaced para no chocar con llaves del spike ni futuras (PIN H2).
  static const _tokenKey = 'rideops.session.jwt';

  @override
  Future<String?> read() => _storage.read(key: _tokenKey);

  @override
  Future<void> write(String token) => _storage.write(key: _tokenKey, value: token);

  @override
  Future<void> clear() => _storage.delete(key: _tokenKey);
}

final tokenStoreProvider = Provider<TokenStore>((ref) => const SecureTokenStore());
