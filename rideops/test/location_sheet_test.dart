import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:rideops/core/api/api_error.dart';
import 'package:rideops/core/api/dto/staff_location.dart';
import 'package:rideops/core/session/active_location.dart';
import 'package:rideops/core/session/session_controller.dart';
import 'package:rideops/core/session/session_state.dart';
import 'package:rideops/core/telemetry/event_logger.dart';
import 'package:rideops/features/shell/location_sheet.dart';

import 'helpers/auth_test_helpers.dart';
import 'helpers/shell_test_helpers.dart';

/// Widget tests del sheet 4C (selector de ubicación). Locale del harness =
/// en → se asierta contra app_en.arb.
void main() {
  List<StaffLocation> fixtureLocations() {
    final raw = json.decode(
      File('test/fixtures/locations_selectable.json').readAsStringSync(),
    ) as List<dynamic>;
    return raw
        .map((e) => StaffLocation.fromJson(e as Map<String, dynamic>))
        .toList();
  }

  late InMemoryActiveLocationStore store;
  late CapturingEventLogger logger;

  setUp(() {
    store = InMemoryActiveLocationStore();
    logger = CapturingEventLogger();
  });

  Widget harness({
    required SessionState session,
    Future<List<StaffLocation>> Function()? locations,
  }) {
    return ProviderScope(
      overrides: [
        activeLocationStoreProvider.overrideWithValue(store),
        sessionControllerProvider.overrideWith(
          () => StubSessionController(session),
        ),
        eventLoggerProvider.overrideWithValue(logger),
        staffLocationsProvider.overrideWith(
          (ref) => (locations ?? () async => fixtureLocations())(),
        ),
      ],
      child: l10nApp(
        Scaffold(
          body: Builder(
            builder: (context) => Center(
              child: ElevatedButton(
                onPressed: () => showActiveLocationSheet(context),
                child: const Text('open'),
              ),
            ),
          ),
        ),
      ),
    );
  }

  SessionState sessionFor({bool unrestricted = false}) =>
      SessionState.authenticated(
        token: fakeJwt(
          exp: DateTime.now().add(const Duration(hours: 8)),
          sub: 'cmdusr001fixture0000000001',
        ),
        user: sessionUserFixture(unrestricted: unrestricted),
      );

  Future<void> open(WidgetTester tester, Widget app) async {
    await tester.pumpWidget(app);
    await tester.pumpAndSettle();
    await tester.tap(find.text('open'));
    await tester.pumpAndSettle();
  }

  testWidgets('lista "todas" + SOLO las sedes del set del usuario restricted',
      (tester) async {
    await open(tester, harness(session: sessionFor()));
    expect(find.text('Active location'), findsOneWidget);
    expect(find.text('All my locations'), findsOneWidget);
    // El fixture de /selectable trae exactamente el set del usuario.
    expect(find.text('Patio Centro'), findsOneWidget);
    expect(find.text('Sucursal Aeropuerto'), findsOneWidget);
  });

  testWidgets(
      'cinturón client-side: una sede FUERA del set del restricted no se '
      'ofrece aunque el endpoint la devuelva', (tester) async {
    await open(
      tester,
      harness(
        session: sessionFor(),
        locations: () async => [
          ...fixtureLocations(),
          const StaffLocation(id: 'loc-ajena', name: 'Sede Ajena'),
        ],
      ),
    );
    expect(find.text('Sede Ajena'), findsNothing);
  });

  testWidgets('UNRESTRICTED (locationIds null): ve la lista completa',
      (tester) async {
    await open(
      tester,
      harness(
        session: sessionFor(unrestricted: true),
        locations: () async => [
          ...fixtureLocations(),
          const StaffLocation(id: 'loc-tres', name: 'Patio Tres'),
        ],
      ),
    );
    expect(find.text('Patio Tres'), findsOneWidget);
  });

  testWidgets(
      'seleccionar una sede: persiste, loguea view_location_set y cierra',
      (tester) async {
    await open(tester, harness(session: sessionFor()));
    await tester.tap(find.text('Patio Centro'));
    await tester.pumpAndSettle();

    expect(find.byType(ActiveLocationSheet), findsNothing, reason: 'pop');
    expect(
      json.decode(store.raw!),
      containsPair('locationId', 'cmdloc001fixture0000000001'),
    );
    expect(logger.has(SessionEvents.viewLocationSet), isTrue);
  });

  testWidgets('"All my locations" limpia el override', (tester) async {
    store.raw = json.encode({
      'userId': 'cmdusr001fixture0000000001',
      'locationId': 'cmdloc001fixture0000000001',
      'locationName': 'Patio Centro',
    });
    await open(tester, harness(session: sessionFor()));
    // La sede persistida se marca como actual.
    expect(find.text('Current location'), findsOneWidget);

    await tester.tap(find.text('All my locations'));
    await tester.pumpAndSettle();
    expect(store.raw, isNull);
  });

  testWidgets('error de red: mensaje + reintentar, nunca lista vacía muda',
      (tester) async {
    var attempts = 0;
    await open(
      tester,
      harness(
        session: sessionFor(),
        locations: () async {
          attempts++;
          if (attempts == 1) {
            throw ApiError(kind: ApiErrorKind.network, message: 'sin red');
          }
          return fixtureLocations();
        },
      ),
    );
    expect(
      find.text(
        'Could not load your locations. Check the signal and try again.',
      ),
      findsOneWidget,
    );

    await tester.tap(find.text('Retry'));
    await tester.pumpAndSettle();
    expect(find.text('Patio Centro'), findsOneWidget);
  });

  testWidgets('Cancel cierra sin cambiar nada', (tester) async {
    await open(tester, harness(session: sessionFor()));
    await tester.tap(find.text('Cancel'));
    await tester.pumpAndSettle();
    expect(find.byType(ActiveLocationSheet), findsNothing);
    expect(store.writes, 0);
    expect(logger.has(SessionEvents.viewLocationSet), isFalse);
  });
}
