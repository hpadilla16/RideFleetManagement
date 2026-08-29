import 'dart:io';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:rideops/core/outbox/photo_vault.dart';

/// Bóveda de fotos (H5): round-trip de cifrado, tolerancia a corrupción y
/// barrido de huérfanos — la promesa "Guardado local cifrado" del mockup 6E
/// tiene que ser verdad medible, no un copy.
void main() {
  late Directory tempDir;
  late PhotoVault vault;
  final key = Uint8List.fromList(List.generate(32, (i) => i * 7 % 256));

  PhotoVault vaultWith(Uint8List keyBytes) => PhotoVault(
        baseDir: () async => tempDir,
        obtainKeyBytes: () async => keyBytes,
      );

  setUp(() {
    tempDir = Directory.systemTemp.createTempSync('rideops_vault_test');
    vault = vaultWith(key);
  });

  tearDown(() {
    try {
      tempDir.deleteSync(recursive: true);
    } catch (_) {}
  });

  test('round-trip: store cifra en disco y read devuelve los bytes', () async {
    final photo = Uint8List.fromList(List.generate(5000, (i) => i % 251));
    final name = await vault.store(photo);

    // Lo que quedó en disco NO son los bytes en claro.
    final raw = File('${tempDir.path}/outbox_photos/$name').readAsBytesSync();
    expect(raw.length, greaterThan(photo.length),
        reason: 'nonce(12) + MAC(16) encima del ciphertext');
    var matches = true;
    for (var i = 0; i < photo.length; i++) {
      if (raw[12 + i] != photo[i]) {
        matches = false;
        break;
      }
    }
    expect(matches, isFalse, reason: 'el JPEG no puede estar en claro');

    final back = await vault.read(name);
    expect(back, photo);
  });

  test('read con llave equivocada devuelve null (perdido, no crash)',
      () async {
    final name = await vault.store(Uint8List.fromList([1, 2, 3, 4, 5]));
    final wrongVault =
        vaultWith(Uint8List.fromList(List.generate(32, (i) => 255 - i)));
    expect(await wrongVault.read(name), isNull);
  });

  test('read de archivo truncado/corrupto devuelve null', () async {
    final name = await vault.store(Uint8List.fromList([9, 8, 7, 6, 5, 4]));
    final file = File('${tempDir.path}/outbox_photos/$name');
    file.writeAsBytesSync(file.readAsBytesSync().sublist(0, 10));
    expect(await vault.read(name), isNull);
  });

  test('delete es idempotente y read tras delete es null', () async {
    final name = await vault.store(Uint8List.fromList([1, 1, 2, 3]));
    await vault.delete(name);
    await vault.delete(name); // segunda vez: no truena
    expect(await vault.read(name), isNull);
  });

  test('nombres sucios (separadores, ..) se tratan como perdidos, jamás '
      'como path (QA NIT-2)', () async {
    expect(await vault.read('../evil.bin'), isNull);
    expect(await vault.read('a/b.bin'), isNull);
    expect(await vault.read(r'a\b.bin'), isNull);
    // delete: no-op silencioso, sin tocar nada fuera de la bóveda.
    await vault.delete('../evil.bin');
    await vault.delete('..');
  });

  test('sweepOrphans borra SOLO lo no referenciado', () async {
    final keep = await vault.store(Uint8List.fromList([1]));
    final orphan1 = await vault.store(Uint8List.fromList([2]));
    final orphan2 = await vault.store(Uint8List.fromList([3]));

    final removed = await vault.sweepOrphans(referencedNames: {keep});
    expect(removed, 2);
    expect(await vault.read(keep), isNotNull);
    expect(await vault.read(orphan1), isNull);
    expect(await vault.read(orphan2), isNull);
  });

  test('totalBytes suma los archivos cifrados (alimenta el tope de 250 MB)',
      () async {
    expect(await vault.totalBytes(), 0);
    await vault.store(Uint8List.fromList(List.filled(1000, 1)));
    await vault.store(Uint8List.fromList(List.filled(2000, 2)));
    final total = await vault.totalBytes();
    // 2 archivos con nonce+MAC encima: > 3000 pero acotado.
    expect(total, greaterThan(3000));
    expect(total, lessThan(3200));
  });
}
