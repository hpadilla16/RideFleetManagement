import '../../../core/api/dto/dashboard.dart';
import '../../../core/api/dto/reservation_card.dart';
import '../../../core/api/dto/session_user.dart';
import '../../../core/api/enums.dart';

/// Tabla de las 9 colas del dashboard (00-domain-workflows.md §3) como
/// FUNCIONES PURAS — el mapeo por programa, el orden de secciones y la
/// honestidad de contadores se prueban como tabla sin montar widgets.

/// Cada cola llega capada a `take: 8` en el server (employee-app.service.js).
/// Regla de contadores honestos (nota 2 del mockup 5A): al tocar el cap, el
/// contador muestra "8+" — nunca un total que el payload no trae.
const int kQueueTake = 8;

/// Las 9 colas reales. El `name` de cada valor ES la llave del JSON del
/// payload (queues.checkout, queues.issueEscalations…) — así la ruta
/// /home/queue/:key se parsea sin tabla aparte.
enum DashboardQueue {
  issueEscalations,
  checkout,
  returns,
  precheckin,
  loanerAdvisorFollowup,
  loanerReady,
  loanerBillingReview,
  loanerReturns,
  active;

  static DashboardQueue? tryParse(String? raw) {
    if (raw == null) return null;
    for (final q in values) {
      if (q.name == raw) return q;
    }
    return null;
  }
}

/// Las 4 colas que SOLO existen en el programa loaner (workflowMode
/// DEALERSHIP_LOANER en el where del server).
const Set<DashboardQueue> kLoanerQueues = {
  DashboardQueue.loanerAdvisorFollowup,
  DashboardQueue.loanerReady,
  DashboardQueue.loanerBillingReview,
  DashboardQueue.loanerReturns,
};

/// Orden VINCULANTE de secciones (nota 3 del mockup 5A): incidentes →
/// salidas → retornos → pre-checkin → las 4 loaner. `active` (En renta) NO
/// gana sección — es volumen, no acción: su camino permanente es el tile del
/// bento (tappable → lista).
const List<DashboardQueue> kSectionOrder = [
  DashboardQueue.issueEscalations,
  DashboardQueue.checkout,
  DashboardQueue.returns,
  DashboardQueue.precheckin,
  DashboardQueue.loanerAdvisorFollowup,
  DashboardQueue.loanerReady,
  DashboardQueue.loanerBillingReview,
  DashboardQueue.loanerReturns,
];

/// Espejo de `userProgramScope` (backend/src/lib/tenant-scope.js:130-136):
/// ADMIN y SUPER_ADMIN siempre bypasean; para el resto vale
/// `user.programScope` solo si es RENTAL_ONLY o LOANER_ONLY.
String? effectiveProgramScope(SessionUser? user) {
  final role = user?.roleEnum;
  if (role == UserRole.admin || role == UserRole.superAdmin) return null;
  final scope = user?.programScope.toUpperCase();
  if (scope == 'RENTAL_ONLY' || scope == 'LOANER_ONLY') return scope;
  return null;
}

/// ¿La cola EXISTE para este usuario? (nota 5 del mockup: scoping por
/// programa OMITE, no vacía).
///
/// Para RENTAL_ONLY las 4 colas loaner componen a contradicción en el server
/// (reservationProgramWhereForScope: NOT DEALERSHIP_LOANER AND
/// workflowMode = DEALERSHIP_LOANER) — llegan vacías SIEMPRE, así que la UI
/// las omite: "0" debe significar "hoy no hay", nunca "no te toca".
/// LOANER_ONLY no genera contradicciones (las colas genéricas muestran SUS
/// reservas loaner) y los incidentes no se filtran por programa: las 9 colas
/// existen. Sesión degradada (user null): todas visibles — el server ya
/// filtró el payload y omitir por especulación escondería trabajo.
bool queueInProgram(DashboardQueue queue, SessionUser? user) {
  if (effectiveProgramScope(user) == 'RENTAL_ONLY') {
    return !kLoanerQueues.contains(queue);
  }
  return true;
}

/// Secciones visibles para el usuario, en el orden vinculante.
List<DashboardQueue> visibleSectionsFor(SessionUser? user) =>
    [for (final q in kSectionOrder) if (queueInProgram(q, user)) q];

/// Items de una cola de reservas (las 8 que no son incidentes).
List<ReservationCard> reservationItemsOf(
  DashboardQueues queues,
  DashboardQueue queue,
) =>
    switch (queue) {
      DashboardQueue.checkout => queues.checkout,
      DashboardQueue.returns => queues.returns,
      DashboardQueue.precheckin => queues.precheckin,
      DashboardQueue.active => queues.active,
      DashboardQueue.loanerAdvisorFollowup => queues.loanerAdvisorFollowup,
      DashboardQueue.loanerReady => queues.loanerReady,
      DashboardQueue.loanerBillingReview => queues.loanerBillingReview,
      DashboardQueue.loanerReturns => queues.loanerReturns,
      DashboardQueue.issueEscalations => const <ReservationCard>[],
    };

/// Cuenta visible de una cola (incidentes incluidos).
int queueCountOf(DashboardQueues queues, DashboardQueue queue) =>
    queue == DashboardQueue.issueEscalations
        ? queues.issueEscalations.length
        : reservationItemsOf(queues, queue).length;

/// ¿La cola tocó el cap del server? A partir de ahí la cuenta real puede ser
/// mayor y el contador debe decir "8+".
bool queueCapped(int visibleCount) => visibleCount >= kQueueTake;

/// Hero "Para ahora" (nota 2 del mockup 5A): deriva SOLO de métricas reales
/// del payload (dueBackToday, issueOpen) + items DE HOY visibles en la cola
/// de salidas — nunca una métrica inventada. [departuresCapped] marca cuando
/// la cola de salidas llegó al cap con puros items de hoy: el total real
/// puede ser mayor y el desglose lo dice con "8+".
class HeroSummary {
  const HeroSummary({
    required this.departuresToday,
    required this.departuresCapped,
    required this.dueBackToday,
    required this.issueOpen,
  });

  final int departuresToday;
  final bool departuresCapped;
  final int dueBackToday;
  final int issueOpen;

  int get total => departuresToday + dueBackToday + issueOpen;
  bool get capped => departuresCapped;
}

HeroSummary deriveHero(DashboardPayload payload, DateTime now) {
  final today = DateTime(now.year, now.month, now.day);

  bool isToday(DateTime? dt) {
    if (dt == null) return false;
    final local = dt.toLocal();
    return local.year == today.year &&
        local.month == today.month &&
        local.day == today.day;
  }

  bool isAfterToday(DateTime? dt) {
    if (dt == null) return false;
    final local = dt.toLocal();
    return DateTime(local.year, local.month, local.day).isAfter(today);
  }

  final departures =
      payload.queues.checkout.where((r) => isToday(r.pickupAt)).length;
  // Cap del take:8 tocado SIN ningún visible POSTERIOR a hoy ⇒ la cola
  // (orden pickupAt asc) pudo dejar salidas de HOY fuera del corte y la
  // cuenta visible subestima. OJO (MAJOR de QA-H4): la señal segura es "hay
  // un visible DESPUÉS de hoy" — no "todos los visibles son de hoy". La
  // ventana del server arranca en hoy-00:00 DE SU zona horaria
  // (employee-app.service.js: startOfToday), así que un visible puede
  // leerse como de AYER en el aparato (no-show con desfase de TZ) y con el
  // orden asc va PRIMERO: [ayer 23:00, hoy×7] con item #9 = hoy 09:00 daría
  // "7 salidas" exactas junto a un header "8+" — mentira en pantalla. Solo
  // un visible de mañana-o-después garantiza que hoy está completo.
  final capped = payload.queues.checkout.length >= kQueueTake &&
      !payload.queues.checkout.any((r) => isAfterToday(r.pickupAt));
  return HeroSummary(
    departuresToday: departures,
    departuresCapped: capped,
    dueBackToday: payload.metrics.dueBackToday,
    issueOpen: payload.metrics.issueOpen,
  );
}
