import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:intl/intl.dart';
import 'package:rideops/core/api/dto/checkout_session.dart';
import 'package:rideops/core/api/enums.dart';
import 'package:rideops/core/theme/ride_tokens.dart';
import 'package:rideops/core/widgets/ride_buttons.dart';
import 'package:rideops/features/checkout/presentation/widgets/terminal_view.dart';

import 'helpers/checkout_test_helpers.dart';
import 'helpers/shell_test_helpers.dart';

/// Contrato VISUAL del frame 11E (M2-H7 — la pantalla que Graphic Design pidió
/// re-dibujar tras H1: antes era un icono suelto de 34 px).
///
/// Se asierta lo que el mockup fija y no puede regresar por accidente: badge
/// circular grande, resumen del events log en orden cronológico con hora
/// tabular, dock con salida real + `why`, y CERO puertas falsas.
void main() {
  /// El DateFormat se construye DENTRO de cada test: los datos de locale los
  /// inicializa el delegate de l10n al montar el harness, no antes.
  String hm(DateTime at) => DateFormat.Hm('en').format(at);

  /// Sesión CERRADA a partir del fixture real, con el último tramo hecho en el
  /// kiosco (que es el caso que más se va a ver: 4 superficies conviviendo).
  CheckoutSessionDto closedSession({
    bool cancelled = false,
    DateTime? autoEmailedAt,
  }) {
    final raw = rawCheckoutSession();
    raw['currentStep'] =
        cancelled ? CheckoutStep.cancelled.wire : CheckoutStep.closed.wire;
    raw['autoEmailedAt'] = autoEmailedAt?.toIso8601String();
    final events = json.decode(raw['events'] as String) as List<dynamic>
      ..add({
        'kind': 'TRANSITION',
        'from': 'CUSTOMER_SIGN_PENDING',
        'to': cancelled ? 'CANCELLED' : 'CLOSED',
        'actorUserId': null,
        'metadata': {'kiosk': true},
        'at': '2026-08-16T14:14:00.000Z',
      });
    raw['events'] = json.encode(events);
    return CheckoutSessionDto.fromJson(raw);
  }

  Future<void> pumpTerminal(
    WidgetTester tester, {
    bool cancelled = false,
    DateTime? autoEmailedAt,
    VoidCallback? onExit,
  }) async {
    await tester.pumpWidget(
      l10nApp(
        Scaffold(
          body: CheckoutTerminalView(
            session: closedSession(
              cancelled: cancelled,
              autoEmailedAt: autoEmailedAt,
            ),
            myUserId: kMyUserId,
            onExit: onExit ?? () {},
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
  }

  testWidgets('11E — badge circular grande (76) en verde: es una noticia de '
      'trabajo hecho, no un error', (tester) async {
    await pumpTerminal(tester);

    final badge = tester.widget<Container>(
      find
          .ancestor(
            of: find.byIcon(Icons.check_rounded),
            matching: find.byType(Container),
          )
          .first,
    );
    final size = badge.constraints;
    expect(size?.maxWidth, 76);
    expect(size?.maxHeight, 76);
    final decoration = badge.decoration! as BoxDecoration;
    expect(decoration.shape, BoxShape.circle);
    expect(decoration.color, RideTokens.okBg);

    expect(find.text('This checkout is already closed'), findsOneWidget);
  });

  testWidgets('11E cancelado: mismo badge, tono danger y su propio título',
      (tester) async {
    await pumpTerminal(tester, cancelled: true);

    expect(find.text('This checkout was cancelled'), findsOneWidget);
    final badge = tester.widget<Container>(
      find
          .ancestor(
            of: find.byIcon(Icons.close_rounded),
            matching: find.byType(Container),
          )
          .first,
    );
    expect((badge.decoration! as BoxDecoration).color, RideTokens.dangerBg);
  });

  testWidgets('el copy dice DÓNDE y CUÁNDO terminó (atribución del events log)',
      (tester) async {
    await pumpTerminal(tester);

    final closedAt = DateTime.parse('2026-08-16T14:14:00.000Z').toLocal();
    expect(
      find.text(
        'It was completed at the kiosk at ${hm(closedAt)}. '
        'There is nothing left to do here.',
      ),
      findsOneWidget,
    );
  });

  testWidgets('events log en orden CRONOLÓGICO y con hora tabular',
      (tester) async {
    await pumpTerminal(tester);

    final tcSigned = DateTime.parse('2026-08-16T14:03:40.000Z').toLocal();
    final closed = DateTime.parse('2026-08-16T14:14:00.000Z').toLocal();
    final firstY = tester.getTopLeft(find.text(hm(tcSigned))).dy;
    final lastY = tester.getTopLeft(find.text(hm(closed))).dy;
    expect(firstY, lessThan(lastY),
        reason: 'el resumen se lee como historia, no como bandeja de avisos');

    final hour = tester.widget<Text>(find.text(hm(closed)));
    expect(
      hour.style!.fontFeatures,
      contains(const FontFeature.tabularFigures()),
    );
    // La atribución del kiosco viaja con el evento, no solo en el hero.
    expect(find.text('At the kiosk'), findsWidgets);
  });

  testWidgets('dock: salida real + why, y NINGUNA puerta falsa de reintento o '
      'reapertura', (tester) async {
    var exited = false;
    await pumpTerminal(tester, onExit: () => exited = true);

    expect(find.byType(RidePrimaryButton), findsOneWidget);
    expect(find.text('Back to the list'), findsOneWidget);
    expect(
      find.text(
        'If you think it closed by mistake, open the reservation: it cannot '
        'be reopened from here.',
      ),
      findsOneWidget,
    );
    // Terminal significa terminal (nota 8).
    expect(find.text('Retry'), findsNothing);

    await tester.tap(find.text('Back to the list'));
    expect(exited, isTrue);
  });

  testWidgets('el contrato se declara con el DATO real (autoEmailedAt), no con '
      'un botón que la app no puede cumplir', (tester) async {
    final emailedAt = DateTime.parse('2026-08-16T14:15:30.000Z');
    await pumpTerminal(tester, autoEmailedAt: emailedAt);
    // La línea vive bajo el events log: en una pantalla de test hay que
    // bajar hasta ella (el dock, en cambio, está pegado y no scrollea).
    await tester.drag(find.byType(ListView), const Offset(0, -260));
    await tester.pumpAndSettle();

    expect(
      find.text('The contract was emailed at ${hm(emailedAt.toLocal())}.'),
      findsOneWidget,
    );

    // Sin sello no se afirma nada.
    await pumpTerminal(tester);
    await tester.drag(find.byType(ListView), const Offset(0, -260));
    await tester.pumpAndSettle();
    expect(find.textContaining('The contract was emailed'), findsNothing);
  });
}
