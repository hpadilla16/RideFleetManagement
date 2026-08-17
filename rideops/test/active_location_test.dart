import 'dart:convert';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:rideops/core/api/token_refresher.dart';
import 'package:rideops/core/session/active_location.dart';
import 'package:rideops/core/session/session_controller.dart';
import 'package:rideops/core/session/session_state.dart';
import 'package:rideops/core/telemetry/event_logger.dart';

import 'helpers/auth_test_helpers.dart';
import 'helpers/shell_test_helpers.dart';

/// Unit tests del provider de ubicación activa (H3): persistencia por
/// usuario, purga al cambiar de cuenta, sesión degradada (dueño por claim
/// `sub`) y telemetría del selector.
void main() {
  const uid = 'cmdusr001fixture0000000001';

  String record({
    String userId = uid,
    String locationId = 'loc-centro',
    String? name = 'Patio Centro',
  }) =>
      json.encode(
        {'userId': userId, 'locationId': locationId, 'locationName': name},
      );

  ProviderContainer container({
    required InMemoryActiveLocationStore store,
    required SessionState session,
    CapturingEventLogger? logger,
  }) {
    final c = ProviderContainer(
      overrides: [
        activeLocationStoreProvider.overrideWithValue(store),
        sessionControllerProvider.overrideWith(
          () => StubSessionController(session),
        ),
        if (logger != null) eventLoggerProvider.overrideWithValue(logger),
      ],
    );
    addTearDown(c.dispose);
    return c;
  }

  /// Los providers son perezosos: leer PRIMERO (instancia el Notifier y
  /// agenda la hidratación) y LUEGO drenar microtasks — leer solo después de
  /// pumpear nunca dispararía el build.
  Future<ActiveLocation> settle(ProviderContainer c) async {
    c.read(activeLocationProvider);
    await pumpEventQueue();
    return c.read(activeLocationProvider);
  }

  final liveToken = fakeJwt(
    exp: DateTime.now().add(const Duration(hours: 8)),
    sub: uid,
  );
  final sessionWithUser =
      SessionState.authenticated(token: liveToken, user: sessionUserFixture());

  test('hidrata la sede persistida del MISMO usuario', () async {
    final store = InMemoryActiveLocationStore(record());
    final c = container(store: store, session: sessionWithUser);
    expect(c.read(activeLocationProvider).hydrated, isFalse);
    await pumpEventQueue();
    final s = c.read(activeLocationProvider);
    expect(s.locationId, 'loc-centro');
    expect(s.locationName, 'Patio Centro');
  });

  test('sin registro persistido → Todas (sin override)', () async {
    final c = container(
      store: InMemoryActiveLocationStore(),
      session: sessionWithUser,
    );
    final s = await settle(c);
    expect(s.hydrated, isTrue);
    expect(s.isPinned, isFalse);
  });

  test('set persiste con dueño y sobrevive un "reinicio" (contenedor nuevo)',
      () async {
    final store = InMemoryActiveLocationStore();
    final c1 = container(store: store, session: sessionWithUser);
    await settle(c1);
    await c1.read(activeLocationProvider.notifier).set(
          locationId: 'loc-aero',
          locationName: 'Sucursal Aeropuerto',
        );
    expect(
      json.decode(store.raw!),
      {
        'userId': uid,
        'locationId': 'loc-aero',
        'locationName': 'Sucursal Aeropuerto',
      },
    );

    final c2 = container(store: store, session: sessionWithUser);
    expect((await settle(c2)).locationId, 'loc-aero');
  });

  test('set(null) = Todas mis ubicaciones y borra el registro', () async {
    final store = InMemoryActiveLocationStore(record());
    final c = container(store: store, session: sessionWithUser);
    await settle(c);
    await c.read(activeLocationProvider.notifier).set(locationId: null);
    expect(c.read(activeLocationProvider).isPinned, isFalse);
    expect(store.raw, isNull);
  });

  test('PURGA al cambiar de cuenta: el registro de otro usuario se borra',
      () async {
    final store = InMemoryActiveLocationStore(record(userId: 'otro-usuario'));
    final c = container(store: store, session: sessionWithUser);
    expect((await settle(c)).isPinned, isFalse,
        reason: 'la sede de un empleado jamás se hereda al siguiente (ADR-7)');
    expect(store.raw, isNull, reason: 'purga real, no solo ignorar');
  });

  test('sesión DEGRADADA (user null): el dueño sale del sub del JWT',
      () async {
    final store = InMemoryActiveLocationStore(record());
    final c = container(
      store: store,
      session: SessionState.authenticated(token: liveToken),
    );
    expect((await settle(c)).locationId, 'loc-centro');
  });

  test(
      'RESTRICTED con sede persistida fuera de su set actual: se CONSERVA — '
      'el server es la fuente de verdad y el 403 (4D) es la negativa honesta',
      () async {
    final store = InMemoryActiveLocationStore(
      record(locationId: 'loc-que-el-admin-quito', name: 'Sede Quitada'),
    );
    final c = container(store: store, session: sessionWithUser);
    // user.locationIds del fixture NO contiene 'loc-que-el-admin-quito'.
    expect((await settle(c)).locationId, 'loc-que-el-admin-quito',
        reason: 'resetear en silencio escondería la negativa como un reset');
  });

  test('sin sesión → Todas, sin tocar el registro persistido', () async {
    final store = InMemoryActiveLocationStore(record());
    final c = container(
      store: store,
      session: const SessionState.unauthenticated(),
    );
    expect((await settle(c)).isPinned, isFalse);
    expect(store.raw, isNotNull,
        reason: 'logout no purga: el mismo usuario re-entra y recupera su sede');
  });

  test('telemetría: set → session.view_location_set', () async {
    final logger = CapturingEventLogger();
    final c = container(
      store: InMemoryActiveLocationStore(),
      session: sessionWithUser,
      logger: logger,
    );
    await settle(c);
    await c
        .read(activeLocationProvider.notifier)
        .set(locationId: 'loc-x', locationName: 'X');
    expect(logger.has(SessionEvents.viewLocationSet), isTrue);
  });

  group('ownerIdOf', () {
    test('prefiere user.id; degradado usa el sub del token', () {
      expect(
        ActiveLocationController.ownerIdOf(sessionWithUser),
        uid,
      );
      expect(
        ActiveLocationController.ownerIdOf(
          SessionState.authenticated(token: liveToken),
        ),
        uid,
      );
      expect(
        ActiveLocationController.ownerIdOf(const SessionState.unauthenticated()),
        isNull,
      );
    });

    test('subjectOf decodifica el claim sub sin verificar firma', () {
      expect(TokenRefresher.subjectOf(liveToken), uid);
      expect(TokenRefresher.subjectOf('no-es-un-jwt'), isNull);
    });
  });
}
