import 'package:flutter_test/flutter_test.dart';
import 'package:rideops/core/api/api_error.dart';
import 'package:rideops/core/api/dto/dashboard.dart';
import 'package:rideops/core/api/dto/reservation_card.dart';
import 'package:rideops/features/dashboard/domain/dashboard_queues.dart';

import 'helpers/auth_test_helpers.dart';
import 'helpers/shell_test_helpers.dart';

/// Tablas puras del dominio del dashboard (H4): mapeo de colas por programa
/// (nota 5 del mockup — omitir, no vaciar), orden vinculante de secciones,
/// honestidad de contadores (take:8 ⇒ "8+"), derivación del hero y la firma
/// del 403 de ubicación.
void main() {
  group('queueInProgram — espejo de userProgramScope (tenant-scope.js)', () {
    // (role, programScope) → ¿existen las colas loaner?
    const cases = <(String, String, bool)>[
      ('AGENT', 'BOTH', true),
      ('AGENT', 'RENTAL_ONLY', false),
      ('AGENT', 'LOANER_ONLY', true), // sin contradicción: colas genéricas muestran SUS loaners
      ('OPS', 'RENTAL_ONLY', false),
      ('ADMIN', 'RENTAL_ONLY', true), // ADMIN bypassa el scope, como el server
      ('SUPER_ADMIN', 'RENTAL_ONLY', true),
      ('AGENT', 'raro_del_futuro', true), // scope desconocido → sin filtro (espejo de :134)
    ];
    for (final (role, scope, loanerVisible) in cases) {
      test('$role/$scope → loaner ${loanerVisible ? 'existe' : 'se OMITE'}',
          () {
        final user = sessionUserFixture(role: role, programScope: scope);
        for (final q in kLoanerQueues) {
          expect(queueInProgram(q, user), loanerVisible);
        }
        // Las colas no-loaner existen SIEMPRE.
        expect(queueInProgram(DashboardQueue.checkout, user), isTrue);
        expect(queueInProgram(DashboardQueue.issueEscalations, user), isTrue);
        expect(queueInProgram(DashboardQueue.active, user), isTrue);
      });
    }

    test('sesión degradada (user null): nada se omite por especulación', () {
      for (final q in DashboardQueue.values) {
        expect(queueInProgram(q, null), isTrue);
      }
    });

    test('visibleSectionsFor conserva el orden vinculante y excluye active',
        () {
      expect(visibleSectionsFor(sessionUserFixture()), kSectionOrder);
      expect(kSectionOrder.contains(DashboardQueue.active), isFalse,
          reason: 'En renta no gana sección: su camino es el tile del bento');
      expect(
        visibleSectionsFor(
          sessionUserFixture(programScope: 'RENTAL_ONLY'),
        ),
        [
          DashboardQueue.issueEscalations,
          DashboardQueue.checkout,
          DashboardQueue.returns,
          DashboardQueue.precheckin,
        ],
      );
    });
  });

  group('contadores honestos (take:8)', () {
    test('bajo el cap → cuenta exacta; en el cap → capped', () {
      expect(queueCapped(0), isFalse);
      expect(queueCapped(7), isFalse);
      expect(queueCapped(kQueueTake), isTrue);
    });
  });

  group('deriveHero — SOLO métricas reales + salidas visibles de hoy', () {
    final now = DateTime(2026, 8, 17, 9, 0);

    ReservationCard card(DateTime pickupAt) =>
        ReservationCard.fromJson(readJsonFixture('reservation_card.json'))
            .copyWith(pickupAt: pickupAt.toUtc());

    DashboardPayload payload({
      required List<ReservationCard> checkout,
      int dueBackToday = 0,
      int issueOpen = 0,
    }) =>
        DashboardPayload(
          metrics: DashboardMetrics(
            dueBackToday: dueBackToday,
            issueOpen: issueOpen,
          ),
          queues: DashboardQueues(checkout: checkout),
        );

    test('suma salidas de HOY + dueBackToday + issueOpen', () {
      final p = payload(
        checkout: [
          card(DateTime(2026, 8, 17, 10, 30)), // hoy
          card(DateTime(2026, 8, 17, 16, 0)), // hoy
          card(DateTime(2026, 8, 18, 9, 0)), // mañana: NO cuenta
        ],
        dueBackToday: 2,
        issueOpen: 1,
      );
      final hero = deriveHero(p, now);
      expect(hero.departuresToday, 2);
      expect(hero.total, 5);
      expect(hero.capped, isFalse,
          reason: 'hay un visible que no es de hoy ⇒ hoy está completo');
    });

    test('cap tocado con puros items de hoy ⇒ capped (el desglose dirá 8+)',
        () {
      final p = payload(
        checkout: List.generate(
          kQueueTake,
          (i) => card(DateTime(2026, 8, 17, 8 + i)),
        ),
      );
      final hero = deriveHero(p, now);
      expect(hero.departuresToday, kQueueTake);
      expect(hero.capped, isTrue,
          reason: 'pudieron quedar salidas de hoy fuera del take:8');
    });
  });

  group('ApiError.isViewLocationDenied — firma completa (gap #3)', () {
    ApiError e({String? code, String? message, int status = 403}) => ApiError(
          kind: status == 403 ? ApiErrorKind.forbidden : ApiErrorKind.server,
          message: message ?? ApiError.viewLocationDeniedMessage,
          code: code,
          status: status,
        );

    test('403 + header + mensaje exacto sin code ⇒ SÍ (puente documentado)',
        () {
      expect(e().isViewLocationDenied(requestHadHeader: true), isTrue);
    });

    test('code VIEW_LOCATION_DENIED futuro ⇒ SÍ aunque cambie el copy', () {
      expect(
        e(code: 'VIEW_LOCATION_DENIED', message: 'otro copy')
            .isViewLocationDenied(requestHadHeader: true),
        isTrue,
      );
    });

    test('403 de MÓDULO (mensaje distinto, sin code) ⇒ NO — NIT de QA-H3',
        () {
      expect(
        e(message: 'The Reservations module is not enabled for your account.')
            .isViewLocationDenied(requestHadHeader: true),
        isFalse,
      );
    });

    test('request SIN header ⇒ NO, aunque el mensaje coincida', () {
      expect(e().isViewLocationDenied(requestHadHeader: false), isFalse);
    });

    test('otro code con el mismo mensaje ⇒ NO (el code manda)', () {
      expect(
        e(code: 'OTRA_COSA').isViewLocationDenied(requestHadHeader: true),
        isFalse,
      );
    });
  });
}
