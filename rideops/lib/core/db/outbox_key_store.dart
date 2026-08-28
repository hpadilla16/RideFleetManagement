import 'dart:math';
import 'dart:typed_data';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';

/// Llaves de la bandeja cifrada (ADR-7), generadas UNA vez por instalación y
/// guardadas en Keystore/Keychain con las MISMAS AndroidOptions que el token
/// y el PIN (spike M0-1a): encryptedSharedPreferences, sin auth de usuario —
/// el drenado tiene que poder leerlas sin desbloquear nada.
///
/// Dos llaves separadas a propósito:
///  - [obtainDbKeyHex]: 32 bytes en hex para `PRAGMA key = "x'…'"` de
///    SQLCipher (forma RAW: sin KDF en cada apertura — la entropía ya viene
///    de Random.secure, derivar encima solo pagaría CPU en cada arranque).
///  - [obtainFileKeyBytes]: 32 bytes para el AES-GCM de los archivos de foto
///    (photo_vault.dart). Compartir llave entre la DB y los archivos ataría
///    la rotación de una al formato de la otra.
///
/// Las llaves NO se purgan al cambiar de cuenta: cifran el CONTENEDOR, no
/// los datos de un usuario — el aislamiento por cuenta lo hace la purga de
/// filas/archivos (OutboxService), no la rotación de llaves.
abstract class OutboxKeyStore {
  Future<String> obtainDbKeyHex();
  Future<Uint8List> obtainFileKeyBytes();
}

class SecureOutboxKeyStore implements OutboxKeyStore {
  const SecureOutboxKeyStore();

  static const _storage = FlutterSecureStorage(
    aOptions: AndroidOptions(
      encryptedSharedPreferences: true,
    ),
  );

  static const _dbKey = 'rideops.outbox.dbKey.v1';
  static const _fileKey = 'rideops.outbox.fileKey.v1';

  @override
  Future<String> obtainDbKeyHex() => _obtain(_dbKey);

  @override
  Future<Uint8List> obtainFileKeyBytes() async =>
      _hexToBytes(await _obtain(_fileKey));

  /// Lee o crea la llave. La creación no necesita candado: las dos llamadas
  /// (apertura de DB, primer store de foto) pasan por providers Riverpod que
  /// se construyen secuencialmente en el main isolate; y si una carrera
  /// exótica escribiera dos veces, la ÚLTIMA escritura gana ANTES de que
  /// exista dato cifrado con la perdedora (la DB aún no abrió).
  Future<String> _obtain(String key) async {
    final existing = await _storage.read(key: key);
    if (existing != null && existing.length == 64) return existing;
    final fresh = _randomHex(32);
    await _storage.write(key: key, value: fresh);
    return fresh;
  }

  static String _randomHex(int bytes) {
    final rng = Random.secure();
    final sb = StringBuffer();
    for (var i = 0; i < bytes; i++) {
      sb.write(rng.nextInt(256).toRadixString(16).padLeft(2, '0'));
    }
    return sb.toString();
  }

  static Uint8List _hexToBytes(String hex) {
    final out = Uint8List(hex.length ~/ 2);
    for (var i = 0; i < out.length; i++) {
      out[i] = int.parse(hex.substring(i * 2, i * 2 + 2), radix: 16);
    }
    return out;
  }
}
