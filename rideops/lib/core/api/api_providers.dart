import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../config/app_config.dart';
import '../session/session_controller.dart';
import '../session/token_store.dart';
import '../telemetry/event_logger.dart';
import 'auth_api.dart';
import 'dio_factory.dart';
import 'token_refresher.dart';

/// Cableado Riverpod de la capa API (M0-5 → M1-H1).
///
/// Los ciclos aparentes (refresher → authApi → authedDio → refresher) se
/// rompen con lecturas PEREZOSAS: cada closure hace `ref.read(...)` al
/// momento de ejecutarse, nunca al construirse. Ningún provider lee a otro de
/// forma eager dentro de un ciclo.

final dioFactoryProvider = Provider<DioFactory>(
  (ref) => DioFactory(baseUrl: AppConfig.current.apiBaseUrl),
);

/// Dio LIMPIO para rutas públicas de token y para el login (aún sin JWT).
final publicDioProvider = Provider<Dio>(
  (ref) => ref.watch(dioFactoryProvider).buildPublicDio(),
);

/// Refresco proactivo (ADR-3a). doRefresh usa AuthApi.refreshWithToken (Dio
/// pelón con bearer manual — ver auth_api.dart) y de paso rehidrata el user
/// de la sesión: el backend devuelve `{ token, user }` fresco, así que
/// mustChangePassword y moduleAccess nunca se quedan viejos más de un ciclo
/// de refresh.
// Tipos EXPLÍCITOS en las declaraciones de este ciclo perezoso
// (refresher ⇄ authApi ⇄ authedDio ⇄ session): sin ellos el analyzer no puede
// inferir los tipos top-level (top_level_cycle) aunque en runtime el ciclo no
// exista — todas las lecturas cruzadas son diferidas con ref.read.
final Provider<TokenRefresher> tokenRefresherProvider =
    Provider<TokenRefresher>((ref) {
  return TokenRefresher(
    readToken: () => ref.read(tokenStoreProvider).read(),
    doRefresh: (currentToken) async {
      final logger = ref.read(eventLoggerProvider);
      final exp = TokenRefresher.expiryOf(currentToken);
      final msBeforeExpiry =
          exp?.difference(DateTime.now().toUtc()).inMilliseconds;
      try {
        final fresh =
            await ref.read(authApiProvider).refreshWithToken(currentToken);
        logger.log(
          AuthEvents.tokenRefreshOk,
          data: {'ms_before_expiry': msBeforeExpiry},
        );
        ref.read(sessionControllerProvider.notifier).onRefreshed(fresh);
        return fresh.token;
      } catch (_) {
        logger.log(
          AuthEvents.tokenRefreshFail,
          data: {'ms_before_expiry': msBeforeExpiry},
        );
        rethrow;
      }
    },
    // El estado en memoria lo actualiza onRefreshed arriba; aquí solo
    // persistimos — TokenRefresher exige que el Keystore quede escrito antes
    // de soltar el token a la request en vuelo.
    storeToken: (t) => ref.read(tokenStoreProvider).write(t),
  );
});

/// Dio AUTENTICADO — stack completo (bearer proactivo, x-view-location,
/// mapeo de errores, backoff 429).
final Provider<Dio> authedDioProvider = Provider<Dio>((ref) {
  final factory = ref.watch(dioFactoryProvider);
  return factory.buildAuthedDio(
    refresher: ref.watch(tokenRefresherProvider),
    // TODO(M1-H3): conectar el selector de ubicación activa cuando exista;
    // hoy no hay override y el usuario ve su set completo.
    readViewLocation: () => null,
    onSessionExpired: () =>
        ref.read(sessionControllerProvider.notifier).onSessionExpired(),
    onPasswordChangeRequired: () => ref
        .read(sessionControllerProvider.notifier)
        .notePasswordChangeRequired(),
  );
});

final Provider<AuthApi> authApiProvider = Provider<AuthApi>((ref) {
  final factory = ref.watch(dioFactoryProvider);
  return AuthApi(
    authedDio: ref.watch(authedDioProvider),
    publicDio: ref.watch(publicDioProvider),
    // Instancia propia SIN interceptores para el refresh: no puede compartir
    // el stack autenticado (recursión del refresher) ni conviene contaminar
    // el Dio público con un bearer de staff.
    bareDio: factory.buildPublicDio(),
  );
});
