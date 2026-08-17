import 'package:dio/dio.dart';

import 'api_error.dart';
import 'dto/staff_location.dart';
import 'interceptors.dart';

/// Retrofit a mano (ADR-2) para /api/locations/* de staff.
class LocationsApi {
  LocationsApi({required Dio authedDio}) : _authed = authedDio;

  final Dio _authed;

  /// GET /api/locations/selectable → sedes visibles del usuario, con nombre.
  ///
  /// SALTA el header `x-view-location` a propósito (ver el WHY completo en
  /// [AuthInterceptor.skipViewLocation]): esta lista alimenta el SELECTOR y
  /// con el header puesto el backend la encogería a la sede activa — el
  /// usuario no podría ver sus otras sedes para salirse, justo cuando la
  /// pantalla 4D (403 de ubicación) más lo necesita.
  Future<List<StaffLocation>> selectable() async {
    try {
      final res = await _authed.get<List<dynamic>>(
        '/api/locations/selectable',
        options: Options(extra: {AuthInterceptor.skipViewLocation: true}),
      );
      return (res.data ?? const [])
          .map((e) => StaffLocation.fromJson(e as Map<String, dynamic>))
          .toList();
    } on DioException catch (e) {
      throw e.error is ApiError ? e.error! as ApiError : ApiError.fromDio(e);
    }
  }
}
