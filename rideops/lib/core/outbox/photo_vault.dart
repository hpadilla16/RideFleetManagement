import 'dart:io';
import 'dart:math';
import 'dart:typed_data';

import 'package:cryptography/cryptography.dart';

/// Bóveda de fotos de la bandeja (H5, ADR-7): los binarios NO viven en la
/// fila del outbox — el payload lleva un NOMBRE de archivo y la bóveda lo
/// resuelve dentro de su directorio. Cada archivo va cifrado con AES-GCM 256
/// (llave en Keystore vía OutboxKeyStore): "Guardado local cifrado" del
/// mockup 6E es una promesa, no un adorno.
///
/// Formato en disco: nonce(12) ‖ ciphertext ‖ MAC(16). Una foto comprimida
/// pesa ~300-600 KB — el cifrado va en una pasada (el troceo por chunks solo
/// pagaría complejidad; si algún día entran videos, se agrega aquí).
///
/// El payload guarda el NOMBRE relativo (no el path absoluto): el directorio
/// de la app puede cambiar entre reinstalaciones/backups de Android y un
/// path absoluto envejecido daría PHOTO_LOST falsos.
///
/// El I/O de archivo es SÍNCRONO a propósito: (1) son ≤600 KB — milisegundos;
/// (2) el dart:io asíncrono jamás resuelve dentro del fake-async de los
/// widget tests, y la bóveda corre dentro de flujos de UI testeados. Si la
/// medición en aparato real (H6) mostrara jank, el candidato es mover la
/// bóveda completa a un isolate, no volver a async a medias.
class PhotoVault {
  PhotoVault({
    required Future<Directory> Function() baseDir,
    required Future<Uint8List> Function() obtainKeyBytes,
  })  : _baseDir = baseDir,
        _obtainKeyBytes = obtainKeyBytes;

  final Future<Directory> Function() _baseDir;
  final Future<Uint8List> Function() _obtainKeyBytes;

  static const _nonceLength = 12;
  static const _macLength = 16;

  final _cipher = AesGcm.with256bits();
  SecretKey? _key;

  Future<SecretKey> _secretKey() async =>
      _key ??= SecretKey(await _obtainKeyBytes());

  Future<Directory> _dir() async {
    final base = await _baseDir();
    final dir = Directory('${base.path}${Platform.pathSeparator}outbox_photos');
    if (!dir.existsSync()) dir.createSync(recursive: true);
    return dir;
  }

  Future<File> _fileFor(String name) async {
    final dir = await _dir();
    return File('${dir.path}${Platform.pathSeparator}$name');
  }

  /// Cifra y persiste [bytes]; devuelve el nombre para el payload de la fila.
  Future<String> store(Uint8List bytes) async {
    final key = await _secretKey();
    final box = await _cipher.encrypt(bytes, secretKey: key);
    final name = 'ph_${_randomHex(12)}.bin';
    final file = await _fileFor(name);
    final out = BytesBuilder(copy: false)
      ..add(box.nonce)
      ..add(box.cipherText)
      ..add(box.mac.bytes);
    file.writeAsBytesSync(out.takeBytes(), flush: true);
    return name;
  }

  /// Descifra el archivo [name] o null si ya no existe / está corrupto (el
  /// drenador lo convierte en PHOTO_LOST — dead-letter visible, no crash).
  Future<Uint8List?> read(String name) async {
    final file = await _fileFor(name);
    if (!file.existsSync()) return null;
    final raw = file.readAsBytesSync();
    if (raw.length <= _nonceLength + _macLength) return null;
    try {
      final box = SecretBox(
        raw.sublist(_nonceLength, raw.length - _macLength),
        nonce: raw.sublist(0, _nonceLength),
        mac: Mac(raw.sublist(raw.length - _macLength)),
      );
      final clear = await _cipher.decrypt(box, secretKey: await _secretKey());
      return Uint8List.fromList(clear);
    } catch (_) {
      // MAC inválida (archivo truncado, llave rotada): tratar como perdido.
      return null;
    }
  }

  /// Borra el archivo. Best-effort e idempotente: si ya no existe NO es
  /// error (contrato de OutboxOps.deletePhotoFile).
  Future<void> delete(String name) async {
    try {
      final file = await _fileFor(name);
      if (file.existsSync()) file.deleteSync();
    } catch (_) {
      // El barrido de huérfanos lo recoge después.
    }
  }

  /// Bytes totales en la bóveda — alimenta el tope de ~250 MB (mockup 7D).
  Future<int> totalBytes() async {
    var total = 0;
    for (final entity in (await _dir()).listSync()) {
      if (entity is File) total += entity.lengthSync();
    }
    return total;
  }

  /// Barrido de arranque (historia M1): borra archivos SIN fila que los
  /// referencie — el residuo de un crash entre "borrar fila" y "borrar
  /// archivo". Devuelve cuántos borró (telemetría/tests).
  Future<int> sweepOrphans({required Set<String> referencedNames}) async {
    var removed = 0;
    for (final entity in (await _dir()).listSync()) {
      if (entity is! File) continue;
      final name = entity.uri.pathSegments.last;
      if (referencedNames.contains(name)) continue;
      try {
        entity.deleteSync();
        removed++;
      } catch (_) {
        // Se reintenta en el próximo arranque.
      }
    }
    return removed;
  }

  static String _randomHex(int bytes) {
    final rng = Random.secure();
    final sb = StringBuffer();
    for (var i = 0; i < bytes; i++) {
      sb.write(rng.nextInt(256).toRadixString(16).padLeft(2, '0'));
    }
    return sb.toString();
  }
}
