import 'package:dio/dio.dart';

import 'api_error.dart';
import 'dto/checkout_session.dart';
import 'dto/inspection.dart';
import 'enums.dart';
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
    bool skipRateLimitRetry = false,
  }) async {
    try {
      final res = await authedDio.get<Map<String, dynamic>>(
        '/api/checkout-sessions/by-reservation/$reservationId',
        options: Options(extra: {
          if (skipViewLocation) AuthInterceptor.skipViewLocation: true,
          if (skipRateLimitRetry) RateLimitRetryInterceptor.skipRetry: true,
        }),
      );
      return CheckoutSessionDto.fromJson(res.data!);
    } on DioException catch (e) {
      final err = ApiError.fromDio(e);
      if (err.status == 404) return null;
      throw err;
    }
  }

  /// `GET /api/checkout-sessions/:id` (routes:51) — la lectura del POLL y el
  /// re-fetch de reconciliación de todo 409 (ADR-4). LLEVA `x-view-location`:
  /// el wizard es superficie de staff VIVA (a diferencia del drenado, que
  /// manda evidencia sellada de otra sede) y si el agente ya no tiene la
  /// sede, la negativa 403 debe verse, no esquivarse.
  ///
  /// 404 aquí es un caso real: la sesión existía y el tenant ya no la ve.
  /// Se propaga como ApiError (a diferencia del `by-reservation`, donde 404
  /// significa "todavía no hay sesión" y es un estado normal de la pantalla).
  ///
  /// [skipRateLimitRetry]: el POLLER lo pone en true (misma regla adoptada en
  /// M1-H4 para el dashboard, interceptors.dart:163-169) — su timer ya trae
  /// backoff decorrelacionado y el retry por-request amplificaría hasta 4× un
  /// 429 sostenido. El re-fetch del AGENTE lo deja en false: ahí hay un humano
  /// esperando UNA respuesta.
  Future<CheckoutSessionDto> getSession(
    String id, {
    bool skipRateLimitRetry = false,
  }) async {
    try {
      final res = await authedDio.get<Map<String, dynamic>>(
        '/api/checkout-sessions/$id',
        options: skipRateLimitRetry
            ? Options(extra: {RateLimitRetryInterceptor.skipRetry: true})
            : null,
      );
      return CheckoutSessionDto.fromJson(res.data!);
    } on DioException catch (e) {
      throw ApiError.fromDio(e);
    }
  }

  /// `POST /api/checkout-sessions/:id/presence` (routes:118) — el LATIDO
  /// (M2-H6). Hasta H5 RideOps leía presencia sin emitirla: el agente veía al
  /// kiosco y al mostrador, y ellos no lo veían a él. Aquí se enciende.
  ///
  /// **No se manda `label`, y es una decisión, no un olvido** (Hector,
  /// 2026-08-28: el usuario se identifica). El servicio resuelve el nombre en
  /// cascada —etiqueta explícita → `fullName` del actor → etiqueta genérica de
  /// la superficie (checkout-presence.service.js:130-137)— y `req.user` ya
  /// trae `fullName` porque `requireAuth` hidrata la fila. Mandar una etiqueta
  /// corta desde el cliente duplicaría la fuente de verdad del nombre en
  /// cuatro superficies para no ganar nada. `displayLabel` queda reservado
  /// para superficies SIN usuario; no es asunto de RideOps.
  ///
  /// **Fire-and-forget por contrato.** La presencia es informativa y no
  /// bloquea nada (reglas duras del módulo): un latido que falla no puede
  /// convertirse en un error de pantalla ni matar el poll del que viaja
  /// colgado. Por eso devuelve `void` y el llamador se traga el fallo.
  ///
  /// LLEVA `x-view-location` como el resto del wizard: si el agente perdió la
  /// sede, que el latido también sea negado es correcto — no queremos que la
  /// app anuncie presencia sobre una sesión que ya no puede ver.
  Future<void> heartbeatPresence({
    required String id,
    CheckoutSurface surface = CheckoutSurface.rideops,
  }) async {
    try {
      await authedDio.post<Map<String, dynamic>>(
        '/api/checkout-sessions/$id/presence',
        data: {'surface': surface.wire},
        // El latido NO reintenta ante 429: es el dato más barato de perder de
        // toda la app (el siguiente poll lo vuelve a mandar 5 s después) y
        // amplificar un throttle por un chip sería exactamente al revés.
        options: Options(
          extra: {RateLimitRetryInterceptor.skipRetry: true},
        ),
      );
    } on DioException catch (e) {
      throw ApiError.fromDio(e);
    }
  }

  /// `POST /api/checkout-sessions/:id/transition` (routes:84) —
  /// `{toStep, metadata?}`. El servidor manda: valida el grafo y los entry
  /// guards y responde 409 con `code` cuando no procede. NO mandamos
  /// `expectedVersion` (P2): es opt-in y su consumo aterriza en M2-H6 junto
  /// con el resto de la reconciliación dura.
  Future<CheckoutSessionDto> transition({
    required String id,
    required String toStep,
    Map<String, Object?>? metadata,
  }) async {
    try {
      final res = await authedDio.post<Map<String, dynamic>>(
        '/api/checkout-sessions/$id/transition',
        data: {'toStep': toStep, 'metadata': ?metadata},
      );
      return CheckoutSessionDto.fromJson(res.data!);
    } on DioException catch (e) {
      throw ApiError.fromDio(e);
    }
  }

  /// `POST /api/checkout-sessions/:id/customer-signature` (routes:125) —
  /// `{signatureDataUrl, signerName?}`. Escribe la firma en el CONTRATO
  /// (`tcSignatureDataUrl` / `tcSignedAt` / `tcSignerName` / `tcCustomerIp`)
  /// y estampa `customerSignedAt` en la sesión, todo en una `$transaction`
  /// (service:664-694). Devuelve la SESIÓN actualizada.
  ///
  /// Tres cosas del servicio que mandan sobre cómo se usa esto:
  ///  1. **PISA la firma anterior sin condición** (service:668-690): no hay
  ///     guard de "ya había firma". Por eso la app solo la llama cuando el
  ///     sello no existe, o cuando el agente aceptó explícitamente el diálogo
  ///     de "esto SUSTITUYE" (18D).
  ///  2. `signerName` es opcional para el servidor, pero si no viaja el
  ///     contrato queda con firma anónima: la app lo sella desde display-data,
  ///     igual que el complete de la inspección.
  ///  3. `signatureDataUrl` < 200 chars ⇒ 400 `SIGNATURE_REQUIRED`
  ///     (service:657-659). El gate local del lienzo es "hay trazo", no "hubo
  ///     toque", justamente para no chocar con eso.
  ///
  /// **Jamás entra a la bandeja de salida**: es una escritura al contrato que
  /// solo el servidor puede confirmar (ADR-5 aplicado al cierre). Sin red se
  /// bloquea ANTES de pedirle la firma al cliente.
  Future<CheckoutSessionDto> saveCustomerSignature({
    required String id,
    required String signatureDataUrl,
    String? signerName,
  }) async {
    try {
      final res = await authedDio.post<Map<String, dynamic>>(
        '/api/checkout-sessions/$id/customer-signature',
        data: {
          'signatureDataUrl': signatureDataUrl,
          'signerName': ?signerName,
        },
      );
      return CheckoutSessionDto.fromJson(res.data!);
    } on DioException catch (e) {
      throw ApiError.fromDio(e);
    }
  }

  /// `POST /api/checkout-sessions/:id/abandon` (routes:380) — el "Guardar y
  /// pausar" del agente. NO cambia `currentStep`: sella `abandonedAt` +
  /// `abandonedReason` (service:850-868), por eso la sesión se retoma donde
  /// iba. Un 409 SIN code aquí significa "la sesión ya es terminal"
  /// (service:853-855, único 409 del módulo que viaja sin `code`).
  Future<CheckoutSessionDto> abandon({
    required String id,
    String? reason,
  }) async {
    try {
      final res = await authedDio.post<Map<String, dynamic>>(
        '/api/checkout-sessions/$id/abandon',
        data: {'reason': ?reason},
      );
      return CheckoutSessionDto.fromJson(res.data!);
    } on DioException catch (e) {
      throw ApiError.fromDio(e);
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

  /// `POST /api/checkout-sessions/:id/declined-insurance` (routes:362) —
  /// `{declined}`. Escribe `RentalAgreement.declinedInsurance` y añade un
  /// evento `DECLINED_INSURANCE` al log (service:825-848); devuelve la SESIÓN,
  /// no el contrato — por eso el estado del switch se lee del `events[]`.
  ///
  /// 409 SIN code = "no hay contrato ligado a esta sesión" (service:829-831):
  /// no es un conflicto de la máquina de estados, y el banner genérico con el
  /// mensaje del servidor es la respuesta correcta.
  Future<CheckoutSessionDto> setDeclinedInsurance({
    required String id,
    required bool declined,
  }) async {
    try {
      final res = await authedDio.post<Map<String, dynamic>>(
        '/api/checkout-sessions/$id/declined-insurance',
        data: {'declined': declined},
      );
      return CheckoutSessionDto.fromJson(res.data!);
    } on DioException catch (e) {
      throw ApiError.fromDio(e);
    }
  }

  /// `POST /api/checkout-sessions/:id/vehicle` (routes:201) —
  /// `{newVehicleId}`. Swap atómico reserva+contrato.
  ///
  /// Negativas que devuelve el servicio y que la pantalla muestra con SU
  /// mensaje (vehicle-swap.service.js): 409 `SWAP_LOCKED` (la inspección ya
  /// empezó), 409 `VEHICLE_TERMINAL` (vendida / fuera de servicio), 409
  /// `VEHICLE_DOUBLE_BOOKED` (otra reserva la tomó en la ventana), 403 de otro
  /// tenant, 404 y un 400 sin code si es la MISMA unidad.
  Future<VehicleSwapResult> swapVehicle({
    required String id,
    required String newVehicleId,
  }) async {
    try {
      final res = await authedDio.post<Map<String, dynamic>>(
        '/api/checkout-sessions/$id/vehicle',
        data: {'newVehicleId': newVehicleId},
      );
      return VehicleSwapResult.fromJson(res.data!);
    } on DioException catch (e) {
      throw ApiError.fromDio(e);
    }
  }

  /// `POST /api/checkout-sessions/:id/terms-token` (routes:144) — mint del
  /// token `TERMS_SIGNING` que el cliente escanea (TTL 15 min).
  ///
  /// **Idempotente con un piso de 2 minutos** (service:708-734): si ya hay un
  /// token vivo de este tipo para la reserva con MÁS de 2 min por delante, el
  /// backend devuelve el mismo con `reused: true` y el QR no cambia. Debajo de
  /// ese piso mintea uno nuevo — para que el cliente no reciba un código que
  /// vence mientras lo escanea. Esa frontera es la que la UI pinta en ámbar.
  ///
  /// A diferencia del mint del DRENADO (`mintHandoffToken`, que va sin
  /// `x-view-location` porque manda evidencia sellada de otra sede), este SÍ
  /// lleva el header: aquí hay un agente vivo frente al mostrador y si perdió
  /// la sede, la negativa tiene que verse (DoD #5), no esquivarse.
  Future<HandoffToken> mintTermsToken(String checkoutSessionId) async {
    try {
      final res = await authedDio.post<Map<String, dynamic>>(
        '/api/checkout-sessions/$checkoutSessionId/terms-token',
      );
      return HandoffToken.fromJson(res.data!);
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
