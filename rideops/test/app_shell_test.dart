import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:rideops/app.dart';
import 'package:rideops/core/api/api_error.dart';
import 'package:rideops/core/api/api_providers.dart';
import 'package:rideops/core/api/dto/session_user.dart';
import 'package:rideops/core/db/outbox_providers.dart';
import 'package:rideops/core/session/active_location.dart';
import 'package:rideops/core/session/token_store.dart';
import 'package:rideops/core/telemetry/event_logger.dart';
import 'package:rideops/features/dashboard/presentation/home_skeleton.dart';

import 'helpers/auth_test_helpers.dart';
import 'helpers/shell_test_helpers.dart';

/// Tests del shell montando la app COMPLETA (router + sesión real): sesión
/// degradada → skeleton 4E + tabs mínimas, /me recuperado → tabs RBAC, y el
/// re-intento de /me al reanudar la app (lifecycle resume).
///
/// OJO: el skeleton tiene shimmer infinito — aquí se bombea con pump(duración)
/// explícita, jamás pumpAndSettle mientras el skeleton esté en pantalla.
void main() {
  const uid = 'cmdusr001fixture0000000001';

  late InMemoryTokenStore tokenStore;
  late InMemoryActiveLocationStore locationStore;
  late FakeAuthApi api;

  setUp(() {
    tokenStore = InMemoryTokenStore()
      ..value = fakeJwt(
        exp: DateTime.now().add(const Duration(hours: 8)),
        sub: uid,
      );
    locationStore = InMemoryActiveLocationStore();
    api = FakeAuthApi();
  });

  Widget app() => ProviderScope(
        overrides: [
          tokenStoreProvider.overrideWithValue(tokenStore),
          activeLocationStoreProvider.overrideWithValue(locationStore),
          authApiProvider.overrideWithValue(api),
          eventLoggerProvider.overrideWithValue(CapturingEventLogger()),
        ],
        child: const RideOpsApp(),
      );

  testWidgets(
      'sesión degradada: shell CON chrome (chip + 4 tabs mínimas) y '
      'skeleton 4E; al llegar /me de un ADMIN aparecen las 5 tabs',
      (tester) async {
    final me = Completer<SessionUser>();
    api.onMe = () => me.future;

    await tester.pumpWidget(app());
    // restore() → authenticated sin user → redirect a /home con /me en vuelo.
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 100));

    expect(find.byType(HomeSkeleton), findsOneWidget,
        reason: 'user null ⇒ skeleton, jamás pantalla a medias');
    expect(find.text('Home'), findsOneWidget);
    expect(find.text('Search'), findsOneWidget);
    expect(find.text('Outbox'), findsOneWidget);
    expect(find.text('Profile'), findsOneWidget);
    expect(find.text('Incidents'), findsNothing,
        reason: 'degradado = tabs mínimas de AGENT');
    expect(find.text('All'), findsOneWidget,
        reason: 'chip de ubicación SIEMPRE visible, incluso degradado');

    me.complete(sessionUserFixture(role: 'ADMIN'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 100));

    expect(find.byType(HomeSkeleton), findsNothing);
    expect(find.text('Incidents'), findsOneWidget,
        reason: 'ADMIN + issueCenter ⇒ 5ª tab');
  });

  testWidgets('AGENT con issueCenter: 4 tabs (Incidentes es de ADMIN/OPS)',
      (tester) async {
    api.onMe = () async => sessionUserFixture(issueCenter: true);
    await tester.pumpWidget(app());
    await tester.pumpAndSettle();
    expect(find.text('Incidents'), findsNothing);
    expect(find.text('Outbox'), findsOneWidget);
  });

  testWidgets('tabs navegan: Buscar muestra su placeholder dentro del shell',
      (tester) async {
    api.onMe = () async => sessionUserFixture();
    await tester.pumpWidget(app());
    await tester.pumpAndSettle();

    await tester.tap(find.text('Search'));
    await tester.pumpAndSettle();
    expect(find.text('This section arrives in a later story.'), findsOneWidget);
    expect(find.text('All'), findsOneWidget, reason: 'el chrome persiste');
  });

  testWidgets(
      'lifecycle resume re-intenta /me cuando la sesión quedó degradada',
      (tester) async {
    var meCalls = 0;
    api.onMe = () async {
      meCalls++;
      if (meCalls == 1) {
        throw apiError(ApiErrorKind.network);
      }
      return sessionUserFixture();
    };

    await tester.pumpWidget(app());
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 100));
    expect(find.byType(HomeSkeleton), findsOneWidget);
    expect(meCalls, 1);

    // Volver de background: inactive → resumed.
    tester.binding
        .handleAppLifecycleStateChanged(AppLifecycleState.inactive);
    tester.binding
        .handleAppLifecycleStateChanged(AppLifecycleState.resumed);
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 100));

    expect(meCalls, 2, reason: 'rehydrateUserIfMissing al reanudar');
    expect(find.byType(HomeSkeleton), findsNothing);
    expect(find.text('Signed in'), findsOneWidget);
  });

  testWidgets('badge de Bandeja con pendientes > 0 (rama real del contador)',
      (tester) async {
    api.onMe = () async => sessionUserFixture();
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          tokenStoreProvider.overrideWithValue(tokenStore),
          activeLocationStoreProvider.overrideWithValue(locationStore),
          authApiProvider.overrideWithValue(api),
          eventLoggerProvider.overrideWithValue(CapturingEventLogger()),
          // H5 abrirá la DB real; aquí se simula una bandeja con 3 filas.
          outboxPendingCountProvider.overrideWith((ref) async => 3),
        ],
        child: const RideOpsApp(),
      ),
    );
    await tester.pumpAndSettle();
    expect(find.text('3'), findsOneWidget, reason: 'badge visible');
    expect(
      find.bySemanticsLabel(RegExp(r'Outbox\. 3 pending to send')),
      findsOneWidget,
      reason: 'el lector de pantalla anuncia la cuenta, no solo el color',
    );
  });

  testWidgets('chip pinta el nombre persistido sin red (offline honesto)',
      (tester) async {
    locationStore.raw =
        '{"userId":"$uid","locationId":"cmdloc001fixture0000000001",'
        '"locationName":"Patio Centro"}';
    api.onMe = () async => sessionUserFixture();
    await tester.pumpWidget(app());
    await tester.pumpAndSettle();
    expect(find.text('Patio Centro'), findsOneWidget);
    expect(find.text('All'), findsNothing);
  });
}
