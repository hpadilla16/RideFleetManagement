import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/api/api_error.dart';
import '../../../core/api/api_providers.dart';
import '../../../core/api/checkout_api.dart';
import '../../../core/api/dto/inspection.dart';
import '../../../core/config/app_config.dart';
import '../../../core/telemetry/event_logger.dart';

/// Estado del token de firma de T&C (mockup 10A-10D).
///
/// El token NO se persiste: vive mientras el paso está abierto. Re-pedirlo es
/// gratis y idempotente (el backend reusa el vigente si le quedan >2 min), así
/// que guardarlo en disco solo añadiría una copia que puede mentir.
class TermsTokenState {
  const TermsTokenState({
    this.token,
    this.minting = false,
    this.error,
    this.lastMintReused,
  });

  final HandoffToken? token;
  final bool minting;

  /// Último fallo del mint. El QR anterior (si lo hay) NO se borra: un fallo
  /// de red no invalida un código que el cliente todavía puede escanear.
  final ApiError? error;

  /// Resultado del último mint pedido POR EL AGENTE: true = el servidor
  /// devolvió el mismo token (`reused`), false = emitió uno nuevo. Null
  /// mientras el agente no haya tocado "generar código nuevo".
  ///
  /// Existe para que la copy diga la VERDAD de lo que pasó ("sigue siendo el
  /// mismo código") en vez de fingir una emisión — nota 9 del mockup.
  final bool? lastMintReused;

  bool get hasToken => token != null;

  TermsTokenState copyWith({
    HandoffToken? token,
    bool? minting,
    ApiError? error,
    bool clearError = false,
    bool? lastMintReused,
    bool clearLastMintReused = false,
  }) {
    return TermsTokenState(
      token: token ?? this.token,
      minting: minting ?? this.minting,
      error: clearError ? null : (error ?? this.error),
      lastMintReused: clearLastMintReused
          ? null
          : (lastMintReused ?? this.lastMintReused),
    );
  }
}

/// Mint del token `TERMS_SIGNING` y su re-emisión de un toque.
///
/// Deliberadamente NO sabe si el cliente firmó: eso lo reporta la sesión
/// (`tcCompletedAt`) y lo trae el poll del wizard. Este controller solo
/// responde "qué código hay que enseñar y hasta cuándo sirve".
class TermsTokenController extends Notifier<TermsTokenState> {
  TermsTokenController(this.sessionId);

  final String sessionId;

  int _generation = 0;

  /// Guard anti-doble-tap REAL (hay un POST en vuelo). Deliberadamente NO se
  /// usa `state.minting` para esto: el estado inicial ya nace en `minting`
  /// (la pantalla entra pidiendo el código), así que un guard sobre la bandera
  /// se comía justamente el mint de entrada y dejaba el paso con el spinner
  /// para siempre. La bandera es lo que se PINTA; esto es lo que se controla.
  bool _inFlight = false;

  /// Tokens cuyo vencimiento ya se contó. Sin esto, el tick de 1 Hz de la
  /// pantalla emitiría `terms_token_expired` una vez por segundo mientras el
  /// agente mira el 10D.
  final Set<String> _expiryLogged = {};

  @override
  TermsTokenState build() {
    _generation++;
    final gen = _generation;
    // Mint al ENTRAR al paso: es lo que el backend espera del wizard
    // (service:708-712 lo dice explícitamente) y es idempotente, así que
    // reabrir el paso no quema tokens.
    Future.microtask(() => mint(byUser: false, gen: gen));
    return const TermsTokenState(minting: true);
  }

  CheckoutApi get _api => ref.read(checkoutApiProvider);
  EventLogger get _logger => ref.read(eventLoggerProvider);

  /// Pide un token. [byUser] true = el agente tocó "generar código nuevo":
  /// solo entonces se guarda [TermsTokenState.lastMintReused], que es lo que
  /// enciende la copy honesta de la re-emisión.
  Future<void> mint({bool byUser = true, int? gen}) async {
    final generation = gen ?? _generation;
    if (generation != _generation || !ref.mounted) return;
    if (_inFlight) return;
    _inFlight = true;
    state = state.copyWith(
      minting: true,
      clearError: true,
      clearLastMintReused: true,
    );
    try {
      final token = await _api.mintTermsToken(sessionId);
      if (generation != _generation || !ref.mounted) return;
      state = TermsTokenState(
        token: token,
        lastMintReused: byUser ? token.reused : null,
      );
      _logger.log(
        CheckoutEvents.termsTokenMinted,
        data: {'reused': token.reused},
      );
    } on ApiError catch (e) {
      if (generation != _generation || !ref.mounted) return;
      state = state.copyWith(minting: false, error: e);
    } finally {
      if (generation == _generation) _inFlight = false;
    }
  }

  /// La pantalla vio el countdown llegar a cero. Se cuenta UNA vez por token
  /// (el tick es de 1 Hz).
  void noteExpired() {
    final token = state.token?.token;
    if (token == null || !_expiryLogged.add(token)) return;
    _logger.log(CheckoutEvents.termsTokenExpired);
  }

  /// URL que se codifica en el QR — la misma que arma el wizard web
  /// (`<origin>/sign/<token>`). Null mientras no haya token.
  ///
  /// ⚠️ **BLOQUEANTE ABIERTO — gap #11 del PROJECT_PLAN (fuga de marca en el
  /// DESTINO de este QR).** Verificado en código el 2026-08-17, sigue vivo:
  ///  - `frontend/src/app/sign/[token]/page.js:58` renderiza
  ///    `<Shell title="Terms & Conditions" …>` — inglés hardcodeado y CERO
  ///    identidad del tenant (ni nombre, ni logo, ni display-data).
  ///  - `frontend/src/app/layout.js` fija `metadata.title = 'Ride Fleet'` sin
  ///    override en `/sign`, así que la pestaña del cliente dice la marca de
  ///    la plataforma.
  ///
  /// Consecuencia del viaje real: la pantalla del agente muestra "Autos del
  /// Valle" (esta app ya lo cumple, con su centinela en tests), el cliente
  /// escanea y le abre "Ride Fleet · Terms & Conditions" en inglés. **M2-H2 no
  /// pasa QA hasta que esa página resuelva título, encabezado e idioma desde
  /// display-data del tenant, con fallback al NOMBRE del tenant en texto —
  /// nunca al de la plataforma.** Es un PR aparte de frontend web: RideOps no
  /// puede arreglarlo desde aquí, solo dejarlo escrito donde se emite el
  /// enlace.
  ///
  /// Pedido de backend asociado (ver `AppConfig.webBaseUrl`): que el mint
  /// devuelva la URL absoluta ya resuelta, para que la app no tenga que
  /// adivinar el origen web de cada tenant.
  String? get signUrl {
    final token = state.token?.token;
    return token == null ? null : AppConfig.current.signUrl(token);
  }
}

/// autoDispose (INN MC-1, misma razón que el wizard): al salir del paso el
/// controller se suelta. Familia por **sessionId** y no por reservationId
/// porque el mint es una ruta de `/checkout-sessions/:id`.
final termsTokenProvider = NotifierProvider.autoDispose
    .family<TermsTokenController, TermsTokenState, String>(
  TermsTokenController.new,
);
