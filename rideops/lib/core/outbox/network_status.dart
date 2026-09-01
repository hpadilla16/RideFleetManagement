import 'package:connectivity_plus/connectivity_plus.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

/// Señal de red para el drenado en foreground (H5). Abstracta para que los
/// tests inyecten red falsa sin tocar el plugin.
///
/// OJO semántico: connectivity_plus reporta INTERFAZ (hay Wi-Fi/celular), no
/// internet real — un Wi-Fi cautivo cuenta como "hay red". Está bien para lo
/// que se usa: decidir si VALE LA PENA intentar el drenado. El veredicto
/// final lo da la request (fallo → la fila queda pending).
abstract class NetworkStatus {
  Future<bool> hasNetwork();

  /// Emite cuando la conectividad pasa de nada → algo (el "al reconectar"
  /// del mockup 6E).
  Stream<void> get onReconnected;
}

class ConnectivityNetworkStatus implements NetworkStatus {
  ConnectivityNetworkStatus([Connectivity? connectivity])
      : _connectivity = connectivity ?? Connectivity();

  final Connectivity _connectivity;

  static bool _isOnline(List<ConnectivityResult> results) =>
      results.any((r) => r != ConnectivityResult.none);

  @override
  Future<bool> hasNetwork() async =>
      _isOnline(await _connectivity.checkConnectivity());

  @override
  Stream<void> get onReconnected {
    var wasOnline = true; // el primer evento offline no dispara nada
    return _connectivity.onConnectivityChanged
        .map(_isOnline)
        .where((online) {
          final fire = online && !wasOnline;
          wasOnline = online;
          return fire;
        })
        .map((_) {});
  }
}

final Provider<NetworkStatus> networkStatusProvider =
    Provider<NetworkStatus>((ref) => ConnectivityNetworkStatus());
