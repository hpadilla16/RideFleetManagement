import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:rideops/core/api/api_error.dart';
import 'package:rideops/core/api/api_providers.dart';
import 'package:rideops/core/api/dto/session_user.dart';
import 'package:rideops/core/session/session_controller.dart';
import 'package:rideops/core/session/session_state.dart';
import 'package:rideops/core/session/token_store.dart';
import 'package:rideops/core/telemetry/event_logger.dart';

import 'helpers/auth_test_helpers.dart';

/// Unit tests del estado de sesión (H1): hidratación al arrancar, login,
/// cambio de contraseña con intercambio de token, expiración y gate.
void main() {
  late InMemoryTokenStore store;
  late FakeAuthApi api;
  late CapturingEventLogger logger;

  ProviderContainer makeContainer() {
    final container = ProviderContainer(
      overrides: [
        tokenStoreProvider.overrideWithValue(store),
        authApiProvider.overrideWithValue(api),
        eventLoggerProvider.overrideWithValue(logger),
      ],
    );
    addTearDown(container.dispose);
    // El provider es perezoso: sin un listener, build() (y por tanto
    // restore()) no corre — en la app el router lo observa desde el frame 1.
    container.listen(sessionControllerProvider, (_, _) {});
    return container;
  }

  setUp(() {
    store = InMemoryTokenStore();
    api = FakeAuthApi();
    logger = CapturingEventLogger();
  });

  Future<void> settle() => Future<void>.delayed(Duration.zero);

  test('sin token en el Keystore → unauthenticated', () async {
    final c = makeContainer();
    expect(c.read(sessionControllerProvider).status, SessionStatus.restoring);
    await settle();
    expect(
      c.read(sessionControllerProvider).status,
      SessionStatus.unauthenticated,
    );
  });

  test('token vivo → authenticated e hidrata /me', () async {
    store.value = fakeJwt(exp: DateTime.now().add(const Duration(hours: 8)));
    api.onMe = () async => authResponseFromFixture().user;
    final c = makeContainer();
    await settle();
    final s = c.read(sessionControllerProvider);
    expect(s.status, SessionStatus.authenticated);
    expect(s.user?.email, 'agente@ridefleet.example');
    expect(s.mustChangePassword, isFalse);
  });

  test('token VENCIDO se descarta sin red → unauthenticated + store limpio',
      () async {
    store.value =
        fakeJwt(exp: DateTime.now().subtract(const Duration(minutes: 5)));
    var meCalls = 0;
    api.onMe = () async {
      meCalls++;
      return authResponseFromFixture().user;
    };
    final c = makeContainer();
    await settle();
    expect(
      c.read(sessionControllerProvider).status,
      SessionStatus.unauthenticated,
    );
    expect(store.value, isNull);
    expect(meCalls, 0, reason: 'ADR-3a: JWT muerto no toca la red');
  });

  test('/me falla por RED → sigue authenticated con user null', () async {
    store.value = fakeJwt(exp: DateTime.now().add(const Duration(hours: 8)));
    api.onMe = () async => throw apiError(ApiErrorKind.network);
    final c = makeContainer();
    await settle();
    final s = c.read(sessionControllerProvider);
    expect(s.status, SessionStatus.authenticated);
    expect(s.user, isNull);
    expect(s.mustChangePassword, isFalse, reason: 'no bloquear por especular');
  });

  test('login ok persiste token, publica user y loguea auth.login_ok',
      () async {
    final token = fakeJwt(exp: DateTime.now().add(const Duration(hours: 8)));
    api.onLogin =
        (email, pass) async => authResponseFromFixture(token: token);
    final c = makeContainer();
    await settle();
    await c
        .read(sessionControllerProvider.notifier)
        .login(email: 'a@b.c', password: 'x');
    final s = c.read(sessionControllerProvider);
    expect(s.status, SessionStatus.authenticated);
    expect(s.token, token);
    expect(store.value, token);
    expect(logger.has(AuthEvents.loginOk), isTrue);
  });

  test('login inválido relanza ApiError y loguea fail_reason=invalid',
      () async {
    api.onLogin = (_, _) async =>
        throw apiError(ApiErrorKind.unauthorized, message: 'Invalid credentials');
    final c = makeContainer();
    await settle();
    await expectLater(
      c
          .read(sessionControllerProvider.notifier)
          .login(email: 'a@b.c', password: 'mala'),
      throwsA(isA<ApiError>()),
    );
    expect(c.read(sessionControllerProvider).status,
        SessionStatus.unauthenticated);
    expect(store.value, isNull);
    final fail =
        logger.events.singleWhere((e) => e.$1 == AuthEvents.loginFail);
    expect(fail.$2['fail_reason'], 'invalid');
  });

  test('changePassword intercambia el token SIN re-login y limpia el gate',
      () async {
    final oldToken =
        fakeJwt(exp: DateTime.now().add(const Duration(hours: 8)));
    final freshToken =
        fakeJwt(exp: DateTime.now().add(const Duration(hours: 12)), sub: 'u2');
    store.value = oldToken;
    api.onMe = () async =>
        authResponseFromFixture(mustChangePassword: true).user;
    api.onChangePassword = (current, next) async =>
        authResponseFromFixture(token: freshToken);
    final c = makeContainer();
    await settle();
    expect(c.read(sessionControllerProvider).mustChangePassword, isTrue);

    await c.read(sessionControllerProvider.notifier).changePassword(
        currentPassword: 'temporal', newPassword: 'NuevaClave#2026x');
    final s = c.read(sessionControllerProvider);
    expect(s.status, SessionStatus.authenticated, reason: 'sin re-login');
    expect(s.token, freshToken);
    expect(store.value, freshToken);
    expect(s.mustChangePassword, isFalse);
    expect(logger.has(AuthEvents.passwordChanged), isTrue);
  });

  test('onSessionExpired limpia sesión y loguea UNA sola vez', () async {
    store.value = fakeJwt(exp: DateTime.now().add(const Duration(hours: 8)));
    api.onMe = () async => authResponseFromFixture().user;
    final c = makeContainer();
    await settle();
    final ctrl = c.read(sessionControllerProvider.notifier);
    ctrl.onSessionExpired();
    ctrl.onSessionExpired(); // ráfaga de 401s concurrentes
    await settle();
    expect(c.read(sessionControllerProvider).status,
        SessionStatus.unauthenticated);
    expect(store.value, isNull);
    expect(
      logger.events
          .where((e) => e.$1 == AuthEvents.sessionExpiredRelogin)
          .length,
      1,
    );
  });

  test('notePasswordChangeRequired levanta el flag local (403 observado)',
      () async {
    store.value = fakeJwt(exp: DateTime.now().add(const Duration(hours: 8)));
    api.onMe = () async => authResponseFromFixture().user;
    final c = makeContainer();
    await settle();
    expect(c.read(sessionControllerProvider).mustChangePassword, isFalse);
    c.read(sessionControllerProvider.notifier).notePasswordChangeRequired();
    expect(c.read(sessionControllerProvider).mustChangePassword, isTrue);
  });

  test(
      'MUST-1 review H1: 403 del gate con user NULL también bloquea, y '
      'changePassword lo limpia', () async {
    // Escenario exacto del bug: restore sin red deja user null; vuelve la
    // señal y la primera llamada autenticada responde 403
    // PASSWORD_CHANGE_REQUIRED → el flag debe levantarse SIN user.
    store.value = fakeJwt(exp: DateTime.now().add(const Duration(hours: 8)));
    api.onMe = () async => throw apiError(ApiErrorKind.network);
    final c = makeContainer();
    await settle();
    expect(c.read(sessionControllerProvider).user, isNull);

    c.read(sessionControllerProvider.notifier).notePasswordChangeRequired();
    expect(c.read(sessionControllerProvider).mustChangePassword, isTrue,
        reason: 'el flag vive en el estado, no en el user');

    // El único camino que limpia el gate: change-password exitoso.
    final fresh =
        fakeJwt(exp: DateTime.now().add(const Duration(hours: 12)), sub: 'u2');
    api.onChangePassword =
        (current, next) async => authResponseFromFixture(token: fresh);
    await c.read(sessionControllerProvider.notifier).changePassword(
        currentPassword: 'temporal', newPassword: 'NuevaClave#2026x');
    final s = c.read(sessionControllerProvider);
    expect(s.mustChangePassword, isFalse);
    expect(s.token, fresh);
  });

  test('restore con /me devolviendo basura no-JSON degrada a user null',
      () async {
    // Portal cautivo de Wi-Fi: 200 con HTML → error de parseo en fromJson.
    // Jamás un unhandled async error al arrancar (Innovation S-4).
    store.value = fakeJwt(exp: DateTime.now().add(const Duration(hours: 8)));
    api.onMe = () async => throw const FormatException('<html>portal</html>');
    final c = makeContainer();
    await settle();
    final s = c.read(sessionControllerProvider);
    expect(s.status, SessionStatus.authenticated);
    expect(s.user, isNull);
  });

  test(
      'herencia QA-H3: un /me EN VUELO de la identidad anterior no pisa al '
      'usuario nuevo (guard de generación en _hydrateUser)', () async {
    // Escenario exacto: restore del usuario A con /me lento → logout →
    // login del usuario B → la respuesta VIEJA de /me llega al final. Sin el
    // guard, `state.isAuthenticated` es true (la sesión de B) y el user de A
    // sobreescribiría al de B.
    final meOfUserA = Completer<SessionUser>();
    store.value = fakeJwt(
      exp: DateTime.now().add(const Duration(hours: 8)),
      sub: 'user-a',
    );
    api.onMe = () => meOfUserA.future;
    final c = makeContainer();
    await settle();
    expect(c.read(sessionControllerProvider).user, isNull,
        reason: '/me de A sigue en vuelo');

    await c.read(sessionControllerProvider.notifier).logout();
    final tokenB = fakeJwt(
      exp: DateTime.now().add(const Duration(hours: 8)),
      sub: 'user-b',
    );
    api.onLogin = (_, _) async {
      final raw = readAuthFixture();
      (raw['user'] as Map<String, dynamic>)['id'] = 'user-b';
      raw['token'] = tokenB;
      return AuthResponse.fromJson(raw);
    };
    await c
        .read(sessionControllerProvider.notifier)
        .login(email: 'b@ridefleet.example', password: 'x');
    expect(c.read(sessionControllerProvider).user?.id, 'user-b');

    // Llega la respuesta rezagada de A: se DESCARTA.
    final userA = authResponseFromFixture().user; // id del fixture ≠ user-b
    meOfUserA.complete(userA);
    await settle();
    expect(c.read(sessionControllerProvider).user?.id, 'user-b',
        reason: 'la identidad vieja jamás resucita sobre la nueva');
  });

  test('logout limpia token y estado', () async {
    store.value = fakeJwt(exp: DateTime.now().add(const Duration(hours: 8)));
    api.onMe = () async => authResponseFromFixture().user;
    final c = makeContainer();
    await settle();
    await c.read(sessionControllerProvider.notifier).logout();
    expect(c.read(sessionControllerProvider).status,
        SessionStatus.unauthenticated);
    expect(store.value, isNull);
  });
}
