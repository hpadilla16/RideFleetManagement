import 'package:dio/dio.dart';

import 'api_error.dart';
import 'dto/available_vehicle.dart';
import 'dto/reservation_display.dart';

/// Rutas de reservas que la app consume: display-data (H5 + header y tarjetas
/// del wizard) y las unidades disponibles del swap (M2-H2). El detalle
/// completo de reserva sigue siendo historia futura.
class ReservationsApi {
  ReservationsApi({required this.authedDio});

  final Dio authedDio;

  /// `GET /api/reservations/:id/display-data` — branding del tenant +
  /// reserva con vehículo (ver dto/reservation_display.dart). Autenticada y
  /// scoped por sede: un 403 aquí ES una negativa y la pantalla lo dice.
  Future<ReservationDisplayData> getDisplayData(String reservationId) async {
    try {
      final res = await authedDio.get<Map<String, dynamic>>(
        '/api/reservations/$reservationId/display-data',
      );
      return ReservationDisplayData.fromJson(res.data!);
    } on DioException catch (e) {
      throw ApiError.fromDio(e);
    }
  }

  /// `GET /api/reservations/:id/available-vehicles` (routes:992) — candidatas
  /// del swap YA filtradas por el servidor (ver el WHY largo en
  /// `dto/available_vehicle.dart`). Array plano, sin envoltura.
  ///
  /// El endpoint acepta `?pickupAt&returnAt`; NO se mandan a propósito: sin
  /// ellos usa la ventana real de la reserva, que es contra la que el swap va
  /// a validar. Mandar otra ventana produciría una lista que el POST rechaza.
  Future<List<AvailableVehicle>> getAvailableVehicles(
    String reservationId,
  ) async {
    try {
      final res = await authedDio.get<List<dynamic>>(
        '/api/reservations/$reservationId/available-vehicles',
      );
      return [
        for (final row in res.data ?? const [])
          if (row is Map<String, dynamic>) AvailableVehicle.fromJson(row),
      ];
    } on DioException catch (e) {
      throw ApiError.fromDio(e);
    }
  }
}
