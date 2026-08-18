import 'dart:convert';
import 'dart:math';

import 'package:crypto/crypto.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

/// PIN LOCAL al dispositivo (H2): jamás viaja al backend. Se guarda como
/// sha256(salt:pin) — nunca texto plano — atado al userId dueño: si entra
/// otra cuenta, el registro se purga y se pide un PIN nuevo.
///
/// Sobre el hash: con 4 dígitos (10 000 combinaciones) ningún KDF hace el
/// registro resistente a fuerza bruta offline — la protección real es que el
/// registro vive en el Keystore y que agotar intentos cierra la sesión (el
/// JWT exige la contraseña para volver). El hash es higiene: nada en claro
/// en reposo, ni en un dump del storage.
@immutable
class StoredPin {
  const StoredPin({
    required this.userId,
    required this.salt,
    required this.hash,
    required this.biometricEnabled,
  });

  /// Genera salt fresco (16 bytes de Random.secure) y hashea [pin].
  factory StoredPin.create({
    required String userId,
    required String pin,
    required bool biometricEnabled,
  }) {
    final rng = Random.secure();
    final salt =
        base64Url.encode(List<int>.generate(16, (_) => rng.nextInt(256)));
    return StoredPin(
      userId: userId,
      salt: salt,
      hash: hashPin(pin: pin, salt: salt),
      biometricEnabled: biometricEnabled,
    );
  }

  factory StoredPin.fromJson(Map<String, dynamic> json) => StoredPin(
        userId: json['userId'] as String,
        salt: json['salt'] as String,
        hash: json['hash'] as String,
        biometricEnabled: json['biometricEnabled'] as bool? ?? false,
      );

  final String userId;

  /// Base64 de 16 bytes aleatorios; evita que dos usuarios con el mismo PIN
  /// compartan hash.
  final String salt;

  /// Base64 de sha256('$salt:$pin').
  final String hash;

  /// La huella se ofrece al final del setup (mockup 3A, anotación 1); si el
  /// aparato no la soporta el flag simplemente queda false.
  final bool biometricEnabled;

  static String hashPin({required String pin, required String salt}) =>
      base64Url.encode(sha256.convert(utf8.encode('$salt:$pin')).bytes);

  bool matches(String pin) => hashPin(pin: pin, salt: salt) == hash;

  Map<String, dynamic> toJson() => {
        'userId': userId,
        'salt': salt,
        'hash': hash,
        'biometricEnabled': biometricEnabled,
      };
}

/// Persistencia del registro de PIN. Abstracto para que los tests usen una
/// implementación en memoria sin tocar el Keystore.
abstract class PinStore {
  Future<StoredPin?> read();
  Future<void> write(StoredPin pin);
  Future<void> clear();
}

/// Keystore/Keychain vía flutter_secure_storage con las MISMAS AndroidOptions
/// que el token (spike M0-1a): encryptedSharedPreferences, sin auth de
/// usuario — la pantalla de lock necesita leer el registro estando bloqueada.
class SecurePinStore implements PinStore {
  const SecurePinStore();

  static const _storage = FlutterSecureStorage(
    aOptions: AndroidOptions(
      encryptedSharedPreferences: true,
    ),
  );

  /// Namespaced como rideops.session.jwt; v1 por si el esquema cambia.
  static const _pinKey = 'rideops.pin.v1';

  @override
  Future<StoredPin?> read() async {
    final raw = await _storage.read(key: _pinKey);
    if (raw == null || raw.isEmpty) return null;
    try {
      return StoredPin.fromJson(json.decode(raw) as Map<String, dynamic>);
    } catch (_) {
      // Registro corrupto (migración a medias, storage dañado): purgarlo y
      // tratar como "sin PIN" — el gate de setup lo re-crea. Nunca dejar al
      // usuario frente a un candado imposible de abrir.
      await _storage.delete(key: _pinKey);
      return null;
    }
  }

  @override
  Future<void> write(StoredPin pin) =>
      _storage.write(key: _pinKey, value: json.encode(pin.toJson()));

  @override
  Future<void> clear() => _storage.delete(key: _pinKey);
}

final pinStoreProvider = Provider<PinStore>((ref) => const SecurePinStore());
