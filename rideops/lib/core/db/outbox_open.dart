import 'dart:io';

import 'package:drift/drift.dart';
import 'package:drift/native.dart';
import 'package:path_provider/path_provider.dart';
import 'package:sqlcipher_flutter_libs/sqlcipher_flutter_libs.dart';
import 'package:sqlite3/open.dart';

/// Apertura REAL de la bandeja cifrada (H5, ADR-7): SQLCipher vía
/// NativeDatabase + `PRAGMA key`, con la llave del Keystore.
///
/// [LazyDatabase]: el costo (leer llave, abrir archivo, migración) se paga
/// en la PRIMERA consulta, no al construir el provider — un arranque sin
/// escrituras pendientes solo lo paga cuando el badge pregunta.
///
/// La llave viaja en forma RAW (`PRAGMA key = "x'<64 hex>'"`): sin KDF por
/// apertura, y sin problemas de escape — hex nunca contiene comillas.
QueryExecutor openEncryptedOutboxExecutor({
  required Future<String> Function() obtainDbKeyHex,
}) {
  return LazyDatabase(() async {
    // Android carga libsqlcipher en vez del sqlite3 del sistema (el del
    // sistema ignoraría PRAGMA key y dejaría el archivo EN CLARO — por eso
    // el setup verifica cipher_version y truena si no está).
    if (Platform.isAndroid) {
      await applyWorkaroundToOpenSqlCipherOnOldAndroidVersions();
      open.overrideFor(OperatingSystem.android, openCipherOnAndroid);
    }
    // iOS/macOS: el pod de sqlcipher_flutter_libs enlaza SQLCipher estático
    // y pisa los símbolos de sqlite3 — no hay override que hacer.

    final dir = await getApplicationSupportDirectory();
    final file = File('${dir.path}${Platform.pathSeparator}outbox.db');
    final keyHex = await obtainDbKeyHex();

    return NativeDatabase.createInBackground(
      file,
      setup: (db) {
        db.execute('PRAGMA key = "x\'$keyHex\'";');
        // Verificación de que REALMENTE es SQLCipher: en un sqlite3 pelón
        // cipher_version devuelve vacío y este archivo quedaría sin cifrar.
        // Mejor morir ruidosamente que prometer "guardado local cifrado"
        // (mockup 6E) sin cumplirlo.
        final version = db.select('PRAGMA cipher_version;');
        if (version.isEmpty) {
          throw StateError(
            'SQLCipher no disponible: la bandeja no puede abrir sin cifrado (ADR-7)',
          );
        }
      },
    );
  });
}
