import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:rideops/core/api/dto/staff_location.dart';
import 'package:rideops/core/session/active_location.dart';
import 'package:rideops/core/session/session_controller.dart';
import 'package:rideops/core/session/session_state.dart';
import 'package:rideops/core/telemetry/event_logger.dart';
import 'package:rideops/features/shell/location_denied_view.dart';
import 'package:rideops/features/shell/location_sheet.dart';

import 'helpers/auth_test_helpers.dart';
import 'helpers/shell_test_helpers.dart';

/// Widget tests de la pantalla 4D (403 de ubicación): negativa VISIBLE con
/// dos salidas — jamás pantalla vacía ni "no hay datos".
void main() {
  Widget harness(Widget body) {
    return ProviderScope(
      overrides: [
        activeLocationStoreProvider
            .overrideWithValue(InMemoryActiveLocationStore()),
        sessionControllerProvider.overrideWith(
          () => StubSessionController(
            SessionState.authenticated(
              token: fakeJwt(exp: DateTime.now().add(const Duration(hours: 8))),
              user: sessionUserFixture(),
            ),
          ),
        ),
        eventLoggerProvider.overrideWithValue(CapturingEventLogger()),
        staffLocationsProvider.overrideWith(
          // id dentro del set del usuario del fixture — el cinturón del sheet
          // filtra sedes fuera de user.locationIds.
          (ref) async => const [
            StaffLocation(
              id: 'cmdloc001fixture0000000001',
              name: 'Patio Centro',
            ),
          ],
        ),
      ],
      child: l10nApp(Scaffold(body: body)),
    );
  }

  testWidgets('copy con el nombre de la sede denegada + nota al admin',
      (tester) async {
    await tester.pumpWidget(
      harness(
        LocationDeniedView(
          locationName: 'Sucursal Aeropuerto',
          onRetry: () {},
        ),
      ),
    );
    expect(find.text('No access to this location'), findsOneWidget);
    expect(
      find.text(
        'Your account no longer has access to Sucursal Aeropuerto. '
        'Pick another location to keep working.',
      ),
      findsOneWidget,
    );
    expect(
      find.text('If you think this is a mistake, tell your administrator.'),
      findsOneWidget,
    );
  });

  testWidgets('sin nombre conocido: copy genérico', (tester) async {
    await tester.pumpWidget(harness(LocationDeniedView(onRetry: () {})));
    expect(
      find.text(
        'Your account no longer has access to this location. '
        'Pick another location to keep working.',
      ),
      findsOneWidget,
    );
  });

  testWidgets('Reintentar dispara el callback de la pantalla', (tester) async {
    var retries = 0;
    await tester.pumpWidget(
      harness(LocationDeniedView(onRetry: () => retries++)),
    );
    await tester.tap(find.text('Retry'));
    expect(retries, 1);
  });

  testWidgets('"Change location" abre el sheet 4C (la vía de escape)',
      (tester) async {
    await tester.pumpWidget(harness(LocationDeniedView(onRetry: () {})));
    await tester.tap(find.text('Change location'));
    await tester.pumpAndSettle();
    expect(find.byType(ActiveLocationSheet), findsOneWidget);
    expect(find.text('Patio Centro'), findsOneWidget,
        reason: '/selectable va SIN header: la lista de escape no está '
            'envenenada por la sede denegada');
  });
}
