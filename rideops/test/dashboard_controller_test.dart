import 'dart:async';
import 'dart:math';

import 'package:fake_async/fake_async.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:rideops/core/api/api_error.dart';
import 'package:rideops/core/api/api_providers.dart';
import 'package:rideops/core/api/dto/dashboard.dart';
import 'package:rideops/core/lifecycle/app_visibility.dart';
import 'package:rideops/core/session/active_location.dart';
import 'package:rideops/core/session/session_controller.dart';
import 'package:rideops/core/session/session_state.dart';
import 'package:rideops/core/session/view_location_denied.dart';
import 'package:rideops/core/telemetry/event_logger.dart';
import 'package:rideops/features/dashboard/application/dashboard_controller.dart';

import 'helpers/auth_test_helpers.dart';
import 'helpers/shell_test_helpers.dart';

/// Unit tests del poller del dashboard (H4) con fakeAsync: gate de hydrated,
/// intervalo con jitter, skip con request en vuelo, pausa total en
/// background, backoff decorrelacionado con tope y la clasificación del 403
/// de ubicación (señal al chip incluida).

/// Random guionizado: nextInt devuelve [intValue] (capado) y nextDouble
/// [doubleValue] — determinismo total para jitter/backoff/sampling.
class ScriptedRandom implements Random {
  ScriptedRandom({this.intValue = 0, this.doubleValue = 1.0});

  int intValue;
  double doubleValue;

  @override
  int nextInt(int max) => intValue.clamp(0, max - 1);

  @override
  double nextDouble() => doubleValue;

  @override
  bool nextBool() => false;
}

/// ActiveLocation controlable a mano — sin Keystore ni microtasks propios.
class StubActiveLocation extends ActiveLocationController {
  StubActiveLocation(this.initial);

  final ActiveLocation initial;

  @override
  ActiveLocation build() => initial;

  void emit(ActiveLocation next) => state = next;
}

/// Sesión controlable a mano — para simular logout/login en caliente (MC-2).
class MutableSessionController extends SessionController {
  MutableSessionController(this.initial);

  final SessionState initial;

  @override
  SessionState build() => initial;

  void emit(SessionState next) => state = next;
}

void main() {
  final liveToken = fakeJwt(
    exp: DateTime.now().add(const Duration(hours: 8)),
    sub: kFixtureUserId,
  );

  DashboardPayload fixturePayload() =>
      DashboardPayload.fromJson(readJsonFixture('dashboard.json'));

  ({
    ProviderContainer container,
    FakeDashboardApi api,
    CapturingEventLogger logger,
    StubActiveLocation location,
    MutableSessionController session,
  }) harness({
    ActiveLocation initialLocation = const ActiveLocation.all(),
    bool authenticated = true,
    ScriptedRandom? random,
  }) {
    final api = FakeDashboardApi();
    final logger = CapturingEventLogger();
    final location = StubActiveLocation(initialLocation);
    final session = MutableSessionController(
      authenticated
          ? SessionState.authenticated(
              token: liveToken,
              user: sessionUserFixture(),
            )
          : const SessionState.unauthenticated(),
    );
    final container = ProviderContainer(
      overrides: [
        dashboardApiProvider.overrideWithValue(api),
        eventLoggerProvider.overrideWithValue(logger),
        activeLocationProvider.overrideWith(() => location),
        sessionControllerProvider.overrideWith(() => session),
        dashboardPollConfigProvider.overrideWithValue(
          DashboardPollConfig(random: random ?? ScriptedRandom()),
        ),
      ],
    );
    addTearDown(container.dispose);
    container.listen(dashboardControllerProvider, (_, _) {});
    return (
      container: container,
      api: api,
      logger: logger,
      location: location,
      session: session,
    );
  }

  // Con ScriptedRandom(intValue: 0): jitter mínimo ⇒ tick a 46.8 s exactos
  // (52 s − 10%). Dentro de la banda 45–60 s del mockup.
  const tick = Duration(milliseconds: 46800);

  test('GATE registrado: con la sede a medio hidratar NO hay fetch; al '
      'hidratar dispara el primero', () {
    fakeAsync((async) {
      final h = harness(initialLocation: const ActiveLocation.hydrating());
      async.flushMicrotasks();
      expect(h.api.calls, 0,
          reason: 'jamás un fetch con el override a medio hidratar');
      expect(h.container.read(dashboardControllerProvider).firstLoad, isTrue);

      h.location.emit(const ActiveLocation.all());
      // El read fuerza el rebuild perezoso del provider sucio (igual que la
      // UI en el siguiente frame) y el flush corre el fetch agendado.
      expect(
        h.container.read(dashboardControllerProvider).fetching,
        isTrue,
      );
      async.flushMicrotasks();
      expect(h.api.calls, 1);
      expect(h.container.read(dashboardControllerProvider).data, isNotNull);
    });
  });

  test('sin sesión no hay polling; los datos no sobreviven al logout', () {
    fakeAsync((async) {
      final h = harness(authenticated: false);
      async.flushMicrotasks();
      async.elapse(const Duration(minutes: 10));
      expect(h.api.calls, 0);
    });
  });

  test('MC-2a review H4: refresh() durante la hidratación NO despacha — el '
      'gate registrado aplica también a resume/pull-to-refresh', () {
    fakeAsync((async) {
      final h = harness(initialLocation: const ActiveLocation.hydrating());
      async.flushMicrotasks();
      unawaited(
        h.container.read(dashboardControllerProvider.notifier).refresh(),
      );
      async.flushMicrotasks();
      expect(h.api.calls, 0,
          reason: 'un resume a media hidratación despacharía SIN header');

      // El gate abre por el camino normal: hidratación → primer fetch.
      h.location.emit(const ActiveLocation.all());
      h.container.read(dashboardControllerProvider);
      async.flushMicrotasks();
      expect(h.api.calls, 1);
    });
  });

  test('MC-2b review H4: tras logout, un resume sobre el login NO resucita '
      'el polling (cero ticks zombie)', () {
    fakeAsync((async) {
      final h = harness();
      async.flushMicrotasks();
      expect(h.api.calls, 1);

      h.session.emit(const SessionState.unauthenticated());
      h.container.read(dashboardControllerProvider); // rebuild → pending
      async.flushMicrotasks();

      // Background + resume en la pantalla de login: el listener de
      // visibilidad dispara refresh() — debe morir en el gate.
      h.container.read(appVisibilityProvider.notifier).setVisible(false);
      async.flushMicrotasks();
      h.container.read(appVisibilityProvider.notifier).setVisible(true);
      async.flushMicrotasks();
      async.elapse(const Duration(minutes: 10));
      async.flushMicrotasks();
      expect(h.api.calls, 1,
          reason: 'sin sesión, ni el refresh de resume ni ticks cada 52 s');
    });
  });

  test('polling: intervalo dentro de 45–60 s, y el jitter mueve el tick', () {
    fakeAsync((async) {
      final h = harness();
      async.flushMicrotasks();
      expect(h.api.calls, 1);
      // El 1er tick ya quedó agendado con jitter mínimo; subir el random
      // AHORA afecta al tick que se agenda tras el 2º fetch.
      (h.container.read(dashboardPollConfigProvider).random as ScriptedRandom)
          .intValue = 1 << 30;

      // Tick mínimo (random=0 al agendar): nada a los 45 s…
      async.elapse(const Duration(seconds: 45));
      async.flushMicrotasks();
      expect(h.api.calls, 1, reason: '46.8 s aún no llegan');
      // …y a los 46.8 s exactos, fetch.
      async.elapse(const Duration(milliseconds: 1800));
      async.flushMicrotasks();
      expect(h.api.calls, 2);

      // Jitter máximo: siguiente tick a 57.2 s (52 + 10%).
      async.elapse(const Duration(seconds: 57));
      async.flushMicrotasks();
      expect(h.api.calls, 2, reason: '57.2 s aún no llegan');
      async.elapse(const Duration(milliseconds: 300));
      async.flushMicrotasks();
      expect(h.api.calls, 3);
    });
  });

  test('tick con request en vuelo: SKIP (no encima) y el reloj sigue', () {
    fakeAsync((async) {
      final h = harness();
      async.flushMicrotasks();
      expect(h.api.calls, 1);

      // Refresh manual que se queda colgado (señal mala del patio).
      final slow = Completer<DashboardPayload>();
      h.api.onFetch = (_) => slow.future;
      unawaited(
        h.container.read(dashboardControllerProvider.notifier).refresh(),
      );
      async.flushMicrotasks();
      expect(h.api.calls, 2);

      // El tick del poller cae mientras el manual sigue en vuelo: skip.
      async.elapse(tick);
      async.flushMicrotasks();
      expect(h.api.calls, 2, reason: 'jamás dos requests encimadas');

      // Se libera el manual: el siguiente tick vuelve a fetchear.
      h.api.onFetch = null;
      slow.complete(fixturePayload());
      async.flushMicrotasks();
      async.elapse(tick);
      async.flushMicrotasks();
      expect(h.api.calls, 3);
    });
  });

  test('PAUSA TOTAL en background y refresh inmediato al volver', () {
    fakeAsync((async) {
      final h = harness();
      async.flushMicrotasks();
      expect(h.api.calls, 1);

      h.container.read(appVisibilityProvider.notifier).setVisible(false);
      async.flushMicrotasks();
      async.elapse(const Duration(minutes: 30));
      expect(h.api.calls, 1, reason: 'en background el poller calla');

      h.container.read(appVisibilityProvider.notifier).setVisible(true);
      async.flushMicrotasks();
      expect(h.api.calls, 2, reason: 'al volver, refresh inmediato');
      // Y el ritmo normal se retoma.
      async.elapse(tick);
      async.flushMicrotasks();
      expect(h.api.calls, 3);
    });
  });

  test('429: backoff decorrelacionado creciente con tope de 5 min + evento '
      'net.request_429_backoff', () {
    fakeAsync((async) {
      // random=max ⇒ el backoff toma siempre su cota superior: 156 s → 300 s
      // (tope) → 300 s.
      final h = harness(random: ScriptedRandom(intValue: 1 << 30));
      h.api.onFetch =
          (_) => throw apiError(ApiErrorKind.rateLimited, message: 'slow down');
      async.flushMicrotasks();
      expect(h.api.calls, 1);
      expect(
        h.logger.events
            .where((e) => e.$1 == NetEvents.request429Backoff)
            .map((e) => e.$2['route'])
            .single,
        '/api/employee-app/dashboard',
      );

      // 1er backoff: min(3×52, 300) = 156 s.
      async.elapse(const Duration(seconds: 155));
      async.flushMicrotasks();
      expect(h.api.calls, 1);
      async.elapse(const Duration(seconds: 1));
      async.flushMicrotasks();
      expect(h.api.calls, 2);

      // 2º: min(3×156, 300) = 300 s — el TOPE.
      async.elapse(const Duration(seconds: 299));
      async.flushMicrotasks();
      expect(h.api.calls, 2);
      async.elapse(const Duration(seconds: 1));
      async.flushMicrotasks();
      expect(h.api.calls, 3);

      // 3º: sigue clavado en el tope.
      async.elapse(const Duration(seconds: 300));
      async.flushMicrotasks();
      expect(h.api.calls, 4);

      // El backend respira (éxito): el ritmo vuelve a la banda normal. Con
      // random=max el jitter es +10% ⇒ 57.2 s.
      h.api.onFetch = null;
      async.elapse(const Duration(seconds: 300));
      async.flushMicrotasks();
      expect(h.api.calls, 5);
      async.elapse(const Duration(milliseconds: 57200));
      async.flushMicrotasks();
      expect(h.api.calls, 6, reason: 'backoff reseteado tras el éxito');
    });
  });

  test('fallo de red conserva el cache y su fetchedAt (5E: se muestra, '
      'no se borra)', () {
    fakeAsync((async) {
      final h = harness();
      async.flushMicrotasks();
      final good = h.container.read(dashboardControllerProvider);
      expect(good.data, isNotNull);
      final goodAt = good.fetchedAt;

      h.api.onFetch = (_) => throw apiError(ApiErrorKind.network);
      async.elapse(tick);
      async.flushMicrotasks();
      final stale = h.container.read(dashboardControllerProvider);
      expect(stale.data, same(good.data), reason: 'el dato viejo se queda');
      expect(stale.fetchedAt, goodAt,
          reason: 'la edad visible es la del último dato BUENO');
      expect(stale.error?.kind, ApiErrorKind.network);
      expect(stale.viewLocationDenied, isFalse);
    });
  });

  test('cambio de sede: reconstruye (cache fuera) y re-consulta', () {
    fakeAsync((async) {
      final h = harness();
      async.flushMicrotasks();
      expect(h.api.calls, 1);

      h.location.emit(const ActiveLocation.pinned(
        locationId: 'loc-aero',
        locationName: 'Sucursal Aeropuerto',
      ));
      expect(h.container.read(dashboardControllerProvider).data, isNull,
          reason: 'las colas de una sede jamás se pintan como si fueran '
              'de otra');
      async.flushMicrotasks();
      expect(h.api.calls, 2);
      expect(h.container.read(dashboardControllerProvider).data, isNotNull);
    });
  });

  test('403 de ubicación (sede pinneada + mensaje exacto sin code): '
      'viewLocationDenied + señal al chip; al sanar, ambos bajan', () {
    fakeAsync((async) {
      final h = harness(
        initialLocation: const ActiveLocation.pinned(
          locationId: 'loc-quitada',
          locationName: 'Sede Quitada',
        ),
      );
      h.api.onFetch = (_) => throw ApiError(
            kind: ApiErrorKind.forbidden,
            message: ApiError.viewLocationDeniedMessage,
            status: 403,
          );
      async.flushMicrotasks();
      final s = h.container.read(dashboardControllerProvider);
      expect(s.viewLocationDenied, isTrue);
      expect(h.container.read(viewLocationDeniedSignalProvider), isTrue,
          reason: 'el chip del shell se entera (criterio registrado H4)');

      // El admin re-otorga la sede: Reintentar sana pantalla y chip.
      h.api.onFetch = null;
      unawaited(
        h.container.read(dashboardControllerProvider.notifier).refresh(),
      );
      async.flushMicrotasks();
      expect(
        h.container.read(dashboardControllerProvider).viewLocationDenied,
        isFalse,
      );
      expect(h.container.read(viewLocationDeniedSignalProvider), isFalse);
    });
  });

  test('403 de MÓDULO (sin header o mensaje distinto) NO monta la 4D — '
      'cae al error genérico (NIT QA-H3)', () {
    fakeAsync((async) {
      // Caso a: sede pinneada pero mensaje de módulo.
      final h = harness(
        initialLocation: const ActiveLocation.pinned(
          locationId: 'loc-centro',
          locationName: 'Patio Centro',
        ),
      );
      h.api.onFetch = (_) => throw ApiError(
            kind: ApiErrorKind.forbidden,
            message: 'The Employee app module is not enabled.',
            status: 403,
          );
      async.flushMicrotasks();
      expect(
        h.container.read(dashboardControllerProvider).viewLocationDenied,
        isFalse,
      );

      // Caso b: mismo mensaje de view-location pero SIN sede pinneada (la
      // request no llevó header): tampoco es la 4D.
      final h2 = harness();
      h2.api.onFetch = (_) => throw ApiError(
            kind: ApiErrorKind.forbidden,
            message: ApiError.viewLocationDeniedMessage,
            status: 403,
          );
      async.flushMicrotasks();
      expect(
        h2.container.read(dashboardControllerProvider).viewLocationDenied,
        isFalse,
      );
      expect(h2.container.read(viewLocationDeniedSignalProvider), isFalse);
    });
  });

  test('dashboard.poll_tick sale sampleado (1%), jamás por tick completo', () {
    fakeAsync((async) {
      // nextDouble = 1.0 ⇒ nunca samplea.
      final h = harness();
      async.flushMicrotasks();
      async.elapse(tick);
      async.flushMicrotasks();
      expect(h.logger.has(DashboardEvents.pollTick), isFalse);

      // nextDouble bajo el sample rate ⇒ se loguea.
      (h.container.read(dashboardPollConfigProvider).random as ScriptedRandom)
          .doubleValue = 0.005;
      async.elapse(tick);
      async.flushMicrotasks();
      expect(h.logger.has(DashboardEvents.pollTick), isTrue);
    });
  });
}
