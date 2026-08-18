import 'package:dio/dio.dart';

import 'api_error.dart';
import 'dto/checkout_session.dart';
import 'dto/inspection.dart';
import 'interceptors.dart';

/// Rutas de checkout-session e inspección móvil que H5 necesita. Dos Dio,
/// dos mundos (M0-5):
///  - [authedDio] para las rutas de staff (`/api/checkout-sessions/*`).
///  - [publicDio] para las rutas públicas de token
///    (`/api/mobile-inspection/:token/*`) — el token ES la auth; jamás viaja
///    un bearer de staff ahí.
class CheckoutApi {
  CheckoutApi({required this.authedDio, required this.publicDio});

  final Dio authedDio;
  final Dio publicDio;

  /// `GET /api/checkout-sessions/by-reservation/:rid` (routes:66) — fuente
  /// de verdad del estado de la sesión; null si no existe todavía.
  ///
  /// [skipViewLocation]: las llamadas del DRENADO no mandan `x-view-location`
  /// (decisión documentada en drainer.dart: la sede del selector VIVO no es
  /// la de la captura; el dato de propiedad va sellado en la fila).
  Future<CheckoutSessionDto?> getByReservation(
    String reservationId, {
    bool skipViewLocation = false,
  }) async {
    try {
      final res = await authedDio.get<Map<String, dynamic>>(
        '/api/checkout-sessions/by-reservation/$reservationId',
        options: Options(extra: {
          if (skipViewLocation) AuthInterceptor.skipViewLocation: true,
        }),
      );
      return CheckoutSessionDto.fromJson(res.data!);
    } on DioException catch (e) {
      final err = ApiError.fromDio(e);
      if (err.status == 404) return null;
      throw err;
    }
  }

  /// `POST /api/checkout-sessions` (routes:33) — idempotente por
  /// reservationId. Los guards del backend (NO_VEHICLE_ASSIGNED,
  /// PRECHECKIN_REQUIRED, AGE_RULES_*) llegan como ApiError y la pantalla
  /// los muestra con el mensaje del servidor.
  Future<CheckoutSessionDto> createForReservation(String reservationId) async {
    try {
      final res = await authedDio.post<Map<String, dynamic>>(
        '/api/checkout-sessions',
        data: {'reservationId': reservationId},
      );
      return CheckoutSessionDto.fromJson(res.data!);
    } on DioException catch (e) {
      throw ApiError.fromDio(e);
    }
  }

  /// `POST /api/checkout-sessions/:id/handoff-token` (routes:161) — mint del
  /// token MOBILE_INSPECTION con el staff JWT, SIN `x-view-location`
  /// (decisión del drenado; el mint solo exige que la sesión exista —
  /// spike 2). Idempotente >2 min: re-pedirlo es gratis.
  Future<HandoffToken> mintHandoffToken(String checkoutSessionId) async {
    try {
      final res = await authedDio.post<Map<String, dynamic>>(
        '/api/checkout-sessions/$checkoutSessionId/handoff-token',
        options: Options(extra: {AuthInterceptor.skipViewLocation: true}),
      );
      return HandoffToken.fromJson(res.data!);
    } on DioException catch (e) {
      throw ApiError.fromDio(e);
    }
  }

  /// `GET /api/mobile-inspection/:token` (público) — estado de la sesión de
  /// inspección: ángulos ya capturados en el servidor + expiresAt.
  Future<MobileInspectionState> getInspectionState(String token) async {
    try {
      final res = await publicDio
          .get<Map<String, dynamic>>('/api/mobile-inspection/$token');
      return MobileInspectionState.fromJson(res.data!);
    } on DioException catch (e) {
      throw ApiError.fromDio(e);
    }
  }

  /// `POST /api/mobile-inspection/:token/photo` (público). El backend
  /// upserta por angleKey — re-subir reemplaza, no duplica.
  Future<void> uploadInspectionPhoto({
    required String token,
    required String angleKey,
    required String photoDataUrl,
    String? notes,
  }) async {
    try {
      await publicDio.post<Map<String, dynamic>>(
        '/api/mobile-inspection/$token/photo',
        data: {
          'angleKey': angleKey,
          'photoDataUrl': photoDataUrl,
          'notes': ?notes,
        },
      );
    } on DioException catch (e) {
      throw ApiError.fromDio(e);
    }
  }

  /// `POST /api/mobile-inspection/:token/complete` (público) — estampa
  /// inspectionCompletedAt (+customerSignedAt si la firma pasa de 200 chars)
  /// y CONSUME el token.
  Future<void> completeInspection({
    required String token,
    required Map<String, dynamic> body,
  }) async {
    try {
      await publicDio.post<Map<String, dynamic>>(
        '/api/mobile-inspection/$token/complete',
        data: body,
      );
    } on DioException catch (e) {
      throw ApiError.fromDio(e);
    }
  }
}
