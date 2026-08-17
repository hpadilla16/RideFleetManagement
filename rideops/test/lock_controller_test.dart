import 'dart:async';
import 'dart:convert';
import 'dart:ui';

import 'package:fake_async/fake_async.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:rideops/core/api/api_providers.dart';
import 'package:rideops/core/session/biometric_auth.dart';
import 'package:rideops/core/session/lock_controller.dart';
import 'package:rideops/core/session/lock_state.dart';
import 'package:rideops/core/session/pin_store.dart';
import 'package:rideops/core/session/session_controller.dart';
import 'package:rideops/core/session/session_state.dart';
import 'package:rideops/core/session/token_store.dart';
import 'package:rideops/core/telemetry/event_logger.dart';

import 'helpers/auth_test_helpers.dart';

/// Unit tests del LockController (H2): timer de inactividad, intentos,
/// exención, background, suspend/resume (contrato para el kiosco H5) y
/// pureza del PIN en el Keystore. Todo bajo fakeAsync: los timers y el reloj
/// (package:clock) avanzan con async.elapse.
void main() {
  late InMemoryTokenStore tokenStore;
  late InMemoryPinStore pinStore;
  late FakeAuthApi api;
  late CapturingEventLogger logger;
  late FakeBiometricAuth bio;

  setUp(() {
    tokenStore = InMemoryTokenStore();
    pinStore = InMemoryPinStore();
    api = FakeAuthApi();
    logger = CapturingEventLogger();
    bio = FakeBiometricAuth();
    api.onMe = () async => authResponseFromFixture().user;
  });

  ProviderContainer makeContainer() {
    final container = ProviderContainer(
      overrides: [
        tokenStoreProvider.overrideWithValue(tokenStore),
        pinStoreProvider.overrideWithValue(pinStore),
        authApiProvider.overrideWithValue(api),
        eventLoggerProvider.overrideWithValue(logger),
        biometricAuthProvider.overrideWithValue(bio),
      ],
    );
    addTearDown(container.dispose);
    // Como en la app: el router observa sesión Y candado desde el frame 1.
    container.listen(sessionControllerProvider, (_, _) {});
    container.listen(lockControllerProvider, (_, _) {});
    return container;
  }

  String liveJwt({String sub = kFixtureUserId}) =>
      fakeJwt(exp: DateTime.now().add(const Duration(hours: 8)), sub: sub);

  /// Cold start: token en el Keystore, restore + sync del candado.
  ProviderContainer coldStart(FakeAsync async) {
    tokenStore.value = liveJwt();
    final c = makeContainer();
    async.flushMicrotasks();
    return c;
  }

  /// Login fresco desde cero (unauthenticated → authenticated).
  ProviderContainer freshLogin(FakeAsync async, {bool exempt = false}) {
    api.onLogin = (_, _) async =>
        authResponseFromFixture(token: liveJwt(), screenLockExempt: exempt);
    final c = makeContainer();
    async.flushMicrotasks(); // restore → unauthenticated
    unawaited(c
        .read(sessionControllerProvider.notifier)
        .login(email: 'a@b.c', password: 'x'));
    async.flushMicrotasks();
    return c;
  }

  LockState lockOf(ProviderContainer c) => c.read(lockControllerProvider);
  LockController ctrlOf(ProviderContainer c) =>
      c.read(lockControllerProvider.notifier);

  Map<String, Object?>? eventData(String name) {
    final matches = logger.events.where((e) => e.$1 == name).toList();
    return matches.isEmpty ? null : matches.last.$2;
  }

  group('sincronización con la sesión', () {
    test('cold start CON PIN → llega bloqueado (session.pin_lock cold_start)',
        () {
      fakeAsync((async) {
        pinStore = InMemoryPinStore.configured(userId: kFixtureUserId);
        final c = coldStart(async);
        final lock = lockOf(c);
        expect(lock.ready, isTrue);
        expect(lock.pinConfigured, isTrue);
        expect(lock.locked, isTrue);
        expect(eventData(SessionEvents.pinLock)?['reason'], 'cold_start');
      });
    });

    test('cold start SIN PIN → desbloqueado y needsSetup', () {
      fakeAsync((async) {
        final c = coldStart(async);
        final lock = lockOf(c);
        expect(lock.locked, isFalse);
        expect(lock.pinConfigured, isFalse);
        expect(
          lock.needsSetupFor(c.read(sessionControllerProvider).user),
          isTrue,
        );
      });
    });

    test('login fresco CON PIN → desbloqueado (la contraseña ya probó quién eres)',
        () {
      fakeAsync((async) {
        pinStore = InMemoryPinStore.configured(userId: kFixtureUserId);
        final c = freshLogin(async);
        expect(lockOf(c).locked, isFalse);
        expect(lockOf(c).pinConfigured, isTrue);
      });
    });

    test('cambio de cuenta: PIN de OTRO usuario se purga y fuerza setup', () {
      fakeAsync((async) {
        pinStore = InMemoryPinStore.configured(userId: 'otro-usuario');
        final c = freshLogin(async);
        expect(pinStore.value, isNull, reason: 'registro ajeno purgado');
        expect(lockOf(c).pinConfigured, isFalse);
        expect(
          lockOf(c).needsSetupFor(c.read(sessionControllerProvider).user),
          isTrue,
        );
      });
    });

    test(
        'restore degradado: bloquea por el sub del token y la exención '
        'hidratada tarde desbloquea', () {
      fakeAsync((async) {
        // /me tarda: el candado decide con el sub del JWT (user null).
        final me = Completer<void>();
        api.onMe = () async {
          await me.future;
          return authResponseFromFixture(screenLockExempt: true).user;
        };
        pinStore = InMemoryPinStore.configured(userId: kFixtureUserId);
        final c = coldStart(async);
        expect(c.read(sessionControllerProvider).user, isNull);
        expect(lockOf(c).locked, isTrue,
            reason: 'sin user, el dueño del PIN se resuelve por el token');

        // /me llega con screenLockExempt=true: el candado se abre solo.
        me.complete();
        async.flushMicrotasks();
        expect(lockOf(c).locked, isFalse);
      });
    });

    test('screenLockExempt: sin candado por timeout y sin setup', () {
      fakeAsync((async) {
        pinStore = InMemoryPinStore.configured(userId: kFixtureUserId);
        final c = freshLogin(async, exempt: true);
        expect(
          lockOf(c).needsSetupFor(c.read(sessionControllerProvider).user),
          isFalse,
        );
        async.elapse(LockController.idleTimeout * 3);
        expect(lockOf(c).locked, isFalse);
      });
    });
  });

  group('timer de inactividad', () {
    test('5 min sin interacción → lock (idle_timeout)', () {
      fakeAsync((async) {
        pinStore = InMemoryPinStore.configured(userId: kFixtureUserId);
        final c = freshLogin(async);
        async.elapse(LockController.idleTimeout);
        expect(lockOf(c).locked, isTrue);
        expect(eventData(SessionEvents.pinLock)?['reason'], 'idle_timeout');
      });
    });

    test('noteActivity reinicia la ventana', () {
      fakeAsync((async) {
        pinStore = InMemoryPinStore.configured(userId: kFixtureUserId);
        final c = freshLogin(async);
        async.elapse(const Duration(minutes: 4));
        ctrlOf(c).noteActivity();
        async.elapse(const Duration(minutes: 4));
        expect(lockOf(c).locked, isFalse, reason: 'la actividad reseteó');
        async.elapse(const Duration(minutes: 2));
        expect(lockOf(c).locked, isTrue);
      });
    });

    test('sin PIN configurado el timer no bloquea nada', () {
      fakeAsync((async) {
        final c = freshLogin(async);
        async.elapse(LockController.idleTimeout * 2);
        expect(lockOf(c).locked, isFalse);
      });
    });
  });

  group('background (ciclo de vida)', () {
    test('volver tras la gracia → lock (background)', () {
      fakeAsync((async) {
        pinStore = InMemoryPinStore.configured(userId: kFixtureUserId);
        final c = freshLogin(async);
        ctrlOf(c).onLifecycleChanged(AppLifecycleState.paused);
        async.elapse(LockController.backgroundGrace);
        ctrlOf(c).onLifecycleChanged(AppLifecycleState.resumed);
        expect(lockOf(c).locked, isTrue);
        expect(eventData(SessionEvents.pinLock)?['reason'], 'background');
      });
    });

    test('salida corta (contestar un WhatsApp) NO bloquea', () {
      fakeAsync((async) {
        pinStore = InMemoryPinStore.configured(userId: kFixtureUserId);
        final c = freshLogin(async);
        ctrlOf(c).onLifecycleChanged(AppLifecycleState.paused);
        async.elapse(const Duration(seconds: 10));
        ctrlOf(c).onLifecycleChanged(AppLifecycleState.resumed);
        expect(lockOf(c).locked, isFalse);
      });
    });
  });

  group('intentos y desbloqueo', () {
    test('PIN incorrecto descuenta intentos visibles; el correcto desbloquea',
        () {
      fakeAsync((async) {
        pinStore = InMemoryPinStore.configured(userId: kFixtureUserId);
        final c = coldStart(async);
        expect(lockOf(c).locked, isTrue);

        for (var i = 1; i <= 3; i++) {
          unawaited(ctrlOf(c).verifyPin('9999'));
          async.flushMicrotasks();
          expect(lockOf(c).attemptsLeft, LockState.maxAttempts - i);
        }
        expect(lockOf(c).locked, isTrue);

        var ok = false;
        unawaited(ctrlOf(c).verifyPin('1234').then((v) => ok = v));
        async.flushMicrotasks();
        expect(ok, isTrue);
        expect(lockOf(c).locked, isFalse);
        expect(lockOf(c).attemptsLeft, LockState.maxAttempts);
        expect(eventData(SessionEvents.pinUnlock)?['method'], 'pin');
      });
    });

    test('agotar los intentos → PIN purgado + logout limpio', () {
      fakeAsync((async) {
        pinStore = InMemoryPinStore.configured(userId: kFixtureUserId);
        final c = coldStart(async);
        for (var i = 0; i < LockState.maxAttempts; i++) {
          unawaited(ctrlOf(c).verifyPin('9999'));
          async.flushMicrotasks();
        }
        expect(pinStore.value, isNull, reason: 'PIN purgado');
        expect(tokenStore.value, isNull, reason: 'sesión cerrada');
        expect(
          c.read(sessionControllerProvider).status,
          SessionStatus.unauthenticated,
        );
        expect(logger.has(SessionEvents.pinUnlock), isFalse);
      });
    });

    test('huella: prompt ok desbloquea (method=biometric); fallo no', () {
      fakeAsync((async) {
        pinStore = InMemoryPinStore.configured(
            userId: kFixtureUserId, biometricEnabled: true);
        bio
          ..available = true
          ..authenticateResult = false;
        final c = coldStart(async);

        unawaited(ctrlOf(c).unlockWithBiometrics(reason: 'x'));
        async.flushMicrotasks();
        expect(lockOf(c).locked, isTrue, reason: 'prompt cancelado/fallido');

        bio.authenticateResult = true;
        unawaited(ctrlOf(c).unlockWithBiometrics(reason: 'x'));
        async.flushMicrotasks();
        expect(lockOf(c).locked, isFalse);
        expect(eventData(SessionEvents.pinUnlock)?['method'], 'biometric');
      });
    });

    test('forgotPinLogout: escape honesto — purga PIN y cierra sesión', () {
      fakeAsync((async) {
        pinStore = InMemoryPinStore.configured(userId: kFixtureUserId);
        final c = coldStart(async);
        unawaited(ctrlOf(c).forgotPinLogout());
        async.flushMicrotasks();
        expect(pinStore.value, isNull);
        expect(
          c.read(sessionControllerProvider).status,
          SessionStatus.unauthenticated,
        );
        expect(lockOf(c).locked, isFalse, reason: 'estado reseteado');
      });
    });
  });

  group('setup', () {
    test('completeSetup persiste hash (jamás el PIN en claro) y desbloquea',
        () {
      fakeAsync((async) {
        final c = freshLogin(async);
        unawaited(
            ctrlOf(c).completeSetup(pin: '4321', biometricEnabled: true));
        async.flushMicrotasks();

        final record = pinStore.value!;
        expect(record.userId, kFixtureUserId);
        expect(record.biometricEnabled, isTrue);
        expect(record.matches('4321'), isTrue);
        expect(record.matches('1234'), isFalse);
        expect(json.encode(record.toJson()), isNot(contains('4321')),
            reason: 'nada del PIN en claro en reposo');

        expect(lockOf(c).pinConfigured, isTrue);
        expect(lockOf(c).locked, isFalse);
        // Y el timer quedó armado: inactividad → lock.
        async.elapse(LockController.idleTimeout);
        expect(lockOf(c).locked, isTrue);
      });
    });
  });

  group('suspend/resume (contrato para el kiosco H5 — §9-6)', () {
    test('suspendido: ni timeout, ni background, ni lock() explícito', () {
      fakeAsync((async) {
        pinStore = InMemoryPinStore.configured(userId: kFixtureUserId);
        final c = freshLogin(async);
        ctrlOf(c).suspendLock();

        async.elapse(LockController.idleTimeout * 4);
        expect(lockOf(c).locked, isFalse, reason: 'timeout suspendido');

        ctrlOf(c).onLifecycleChanged(AppLifecycleState.paused);
        async.elapse(const Duration(minutes: 2));
        ctrlOf(c).onLifecycleChanged(AppLifecycleState.resumed);
        expect(lockOf(c).locked, isFalse, reason: 'background suspendido');

        ctrlOf(c).lock();
        expect(lockOf(c).locked, isFalse, reason: 'lock manual suspendido');
      });
    });

    test('re-entrante: N suspensiones exigen N reanudaciones', () {
      fakeAsync((async) {
        pinStore = InMemoryPinStore.configured(userId: kFixtureUserId);
        final c = freshLogin(async);
        ctrlOf(c)
          ..suspendLock()
          ..suspendLock()
          ..resumeLock();
        async.elapse(LockController.idleTimeout * 2);
        expect(lockOf(c).locked, isFalse, reason: 'aún queda una suspensión');
        ctrlOf(c).resumeLock();
        async.elapse(LockController.idleTimeout);
        expect(lockOf(c).locked, isTrue);
      });
    });

    test('resume reinicia la ventana COMPLETA (sin candado instantáneo)', () {
      fakeAsync((async) {
        pinStore = InMemoryPinStore.configured(userId: kFixtureUserId);
        final c = freshLogin(async);
        async.elapse(const Duration(minutes: 4));
        ctrlOf(c).suspendLock();
        async.elapse(const Duration(minutes: 30));
        ctrlOf(c).resumeLock();
        async.elapse(const Duration(minutes: 4));
        expect(lockOf(c).locked, isFalse,
            reason: 'ventana fresca desde el resume');
        async.elapse(const Duration(minutes: 2));
        expect(lockOf(c).locked, isTrue);
      });
    });

    test('checkPin es PURO: no abre el candado ni gasta intentos', () {
      fakeAsync((async) {
        pinStore = InMemoryPinStore.configured(userId: kFixtureUserId);
        final c = coldStart(async);
        var ok = false;
        unawaited(ctrlOf(c).checkPin('1234').then((v) => ok = v));
        async.flushMicrotasks();
        expect(ok, isTrue);
        expect(lockOf(c).locked, isTrue);
        unawaited(ctrlOf(c).checkPin('0000').then((v) => ok = v));
        async.flushMicrotasks();
        expect(ok, isFalse);
        expect(lockOf(c).attemptsLeft, LockState.maxAttempts);
      });
    });

    test('el logout resetea suspensiones: no sobreviven a la sesión', () {
      fakeAsync((async) {
        pinStore = InMemoryPinStore.configured(userId: kFixtureUserId);
        final c = freshLogin(async);
        ctrlOf(c).suspendLock();
        unawaited(c.read(sessionControllerProvider.notifier).logout());
        async.flushMicrotasks();

        // Nuevo login: la suspensión vieja no debe amortiguar el candado.
        unawaited(c
            .read(sessionControllerProvider.notifier)
            .login(email: 'a@b.c', password: 'x'));
        async.flushMicrotasks();
        async.elapse(LockController.idleTimeout);
        expect(lockOf(c).locked, isTrue);
      });
    });
  });
}
