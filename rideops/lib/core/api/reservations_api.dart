import 'package:dio/dio.dart';

import 'api_error.dart';
import 'dto/reservation_display.dart';

/// Rutas de reservas que H5 consume. Solo display-data por ahora; el detalle
/// completo de reserva es historia futura.
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
}
