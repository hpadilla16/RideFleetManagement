import 'package:dio/dio.dart';

import 'api_error.dart';
import 'dto/available_vehicle.dart';
import 'dto/reservation_display.dart';

/// Resultado de pedirle al backend que mande el link de pre-checkin.
///
/// OJO (H7): el backend responde **200 aunque el correo NO salga**
/// (reservations.routes.js:1711-1717 devuelve `{ok:false, emailSent:false,
/// warning}` cuando el SMTP falla, porque el token SÍ quedó emitido). Un
/// cliente que solo mire el status HTTP le diría al agente "listo, ya se
/// envió" mientras el cliente nunca recibe nada — por eso este record existe y
/// la UI ramifica sobre [sent], no sobre el 200.
typedef PrecheckinLinkResult = ({bool sent, String? warning});

/// Rutas de reservas que consume la app: display-data (H5 + header y tarjetas
/// del wizard), las unidades disponibles del swap (M2-H2) y el envío del link
/// de pre-checkin (H7, salida real del guard 422 PRECHECKIN_REQUIRED). El
/// detalle completo de reserva sigue siendo historia futura.
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

  /// `POST /api/reservations/:id/send-request-email {kind:'customer-info'}`
  /// (routes:1590) — emite un token de pre-checkin nuevo y se lo manda por
  /// correo al cliente de la reserva. Es la salida REAL del frame 11B.
  ///
  /// Detalles del contrato que la UI tiene que respetar:
  ///  - 400 `No recipient email found` cuando el cliente no tiene correo: no
  ///    es un fallo de red, es un dato faltante y se dice así.
  ///  - 429 con cooldown por reserva (routes:1621): NO se reintenta solo —
  ///    reintentar un envío de correo a ciegas es spam al cliente. Además el
  ///    interceptor de backoff solo reintenta GET/HEAD, así que este POST
  ///    jamás sale dos veces por su cuenta.
  ///  - **NO va a la bandeja de salida** (ADR-5): no es evidencia de
  ///    inspección; es una acción de mostrador con un humano esperando la
  ///    confirmación.
  Future<PrecheckinLinkResult> sendPrecheckinLink(String reservationId) async {
    try {
      final res = await authedDio.post<Map<String, dynamic>>(
        '/api/reservations/$reservationId/send-request-email',
        data: {'kind': 'customer-info'},
      );
      final body = res.data ?? const <String, dynamic>{};
      // `emailSent` es el campo honesto; `ok` es el respaldo por si una
      // versión vieja del backend no lo emite.
      final sent = body['emailSent'] as bool? ?? body['ok'] as bool? ?? false;
      return (sent: sent, warning: body['warning'] as String?);
    } on DioException catch (e) {
      throw ApiError.fromDio(e);
    }
  }
}
