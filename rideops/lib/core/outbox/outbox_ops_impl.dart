import 'dart:convert';

import '../api/api_error.dart';
import '../api/checkout_api.dart';
import '../telemetry/event_logger.dart';
import 'drainer.dart';
import 'photo_vault.dart';

/// OutboxOps REAL (H5): las operaciones remotas del drenador contra el
/// backend vivo, con la separación de Dio que exige el spike 2:
///  - mint del handoff token → Dio AUTENTICADO, SIN `x-view-location`
///    (CheckoutApi.mintHandoffToken ya manda el skip; decisión documentada
///    en drainer.dart).
///  - upload/complete → Dio LIMPIO contra /api/mobile-inspection/:token/*
///    (el token ES la auth).
///
/// Mapeo ApiError → DrainOutcome:
///  - red / 5xx / 429 → [DrainTransient] (la fila queda pending).
///  - 410 TOKEN_* → [DrainReject] con code (el drenador re-mintea UNA vez).
///  - 400/403/404/409 de negocio → [DrainReject] permanente con el code del
///    backend (dead-letter visible).
///
/// Contrato de errores del MINT y del pre-check: aquí un fallo transitorio
/// LANZA (no devuelve null) — null significa "la sesión ya no existe" y el
/// drenador lo convierte en SESSION_GONE permanente. Un mint caído por red
/// no puede matar la fila: la excepción tumba la corrida, el coordinador la
/// atrapa y las filas inflight vuelven a pending en la siguiente
/// (resetInflight).
class ApiOutboxOps implements OutboxOps {
  ApiOutboxOps({
    required this.api,
    required this.vault,
    required this.logger,
  });

  final CheckoutApi api;
  final PhotoVault vault;
  final EventLogger logger;

  @override
  Future<String?> mintInspectionToken(String checkoutSessionId) async {
    try {
      final token = await api.mintHandoffToken(checkoutSessionId);
      logger.log(OutboxEvents.remintToken, data: {'reused': token.reused});
      return token.token;
    } on ApiError catch (e) {
      // 404 = la sesión ya no existe → null (SESSION_GONE aguas arriba).
      if (e.status == 404) return null;
      rethrow;
    }
  }

  @override
  Future<DrainOutcome> uploadPhoto({
    required String token,
    required String angleKey,
    required String photoDataUrl,
    String? notes,
  }) async {
    try {
      await api.uploadInspectionPhoto(
        token: token,
        angleKey: angleKey,
        photoDataUrl: photoDataUrl,
        notes: notes,
      );
      return const DrainOk();
    } on ApiError catch (e) {
      return _outcomeOf(e);
    }
  }

  @override
  Future<bool> inspectionAlreadyCompleted(String reservationId) async {
    // skipViewLocation: la fila pudo capturarse con OTRA sede activa; el
    // pre-check del complete no puede depender del selector vivo.
    final session =
        await api.getByReservation(reservationId, skipViewLocation: true);
    return session?.inspectionCompletedAt != null;
  }

  @override
  Future<DrainOutcome> completeInspection({
    required String token,
    required Map<String, dynamic> payload,
  }) async {
    try {
      await api.completeInspection(token: token, body: payload);
      return const DrainOk();
    } on ApiError catch (e) {
      return _outcomeOf(e);
    }
  }

  @override
  Future<String?> readPhotoData(String path) async {
    final bytes = await vault.read(path);
    if (bytes == null) return null;
    // El backend espera dataURL JSON (mobile-inspection.routes.js:21, límite
    // 15 MB) — la compresión al capturar garantiza que cabemos de sobra.
    return 'data:image/jpeg;base64,${base64.encode(bytes)}';
  }

  @override
  Future<void> deletePhotoFile(String path) => vault.delete(path);

  static DrainOutcome _outcomeOf(ApiError e) {
    switch (e.kind) {
      case ApiErrorKind.network:
      case ApiErrorKind.server:
      case ApiErrorKind.rateLimited:
        return DrainTransient(e.message);
      case ApiErrorKind.gone:
        // 410 sin code no debería existir (loadToken siempre manda uno);
        // si pasara, TOKEN_INVALID dispara el re-mint único igual.
        return DrainReject(e.code ?? 'TOKEN_INVALID', e.message);
      case ApiErrorKind.unauthorized:
      case ApiErrorKind.passwordChangeRequired:
      case ApiErrorKind.forbidden:
      case ApiErrorKind.conflict:
      case ApiErrorKind.badRequest:
        return DrainReject(e.code, e.message);
    }
  }
}
