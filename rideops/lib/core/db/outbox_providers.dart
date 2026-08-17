import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'outbox_db.dart';

/// Cableado Riverpod de la bandeja de salida — la parte que H3 necesita.
///
/// La APERTURA real de la base (SQLCipher + llave en Keystore, ADR-7) es
/// historia H5 (captura de inspección): abrirla aquí solo para contar cero
/// filas pagaría el costo de la llave y la migración en cada arranque sin
/// ninguna escritura que proteger. Hasta entonces el provider devuelve null y
/// el badge de la tab Bandeja (mockup 4A) cuenta 0 por la rama corta de
/// [outboxPendingCountProvider] — que YA llama a [OutboxDb.pendingCount]
/// cuando la DB exista, así H5 solo sobreescribe [outboxDbProvider].
final Provider<OutboxDb?> outboxDbProvider = Provider<OutboxDb?>((ref) {
  return null; // H5: abrir NativeDatabase cifrada y devolverla aquí.
});

/// Cuenta de filas 'pending' para el badge de Bandeja. FutureProvider simple
/// (no stream): con la DB cerrada no hay nada que observar; H5 lo puede
/// promover a StreamProvider de Drift cuando existan escrituras reales.
final FutureProvider<int> outboxPendingCountProvider =
    FutureProvider<int>((ref) async {
  final db = ref.watch(outboxDbProvider);
  if (db == null) return 0;
  return db.pendingCount();
});
