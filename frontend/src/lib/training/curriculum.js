/**
 * Ride University — the curriculum, and the single source the tour, the
 * training modules, the showcase track and the video scripts all read from.
 *
 * WHY ONE FILE (2026-08-14): a tour step, a knowledge-base article and a
 * training video are three renderings of the same thing — how to do one task.
 * Authored separately they drift, and the video drifts first: it is the most
 * expensive to change and the least obvious when it is wrong. So the steps
 * live here once, and each surface renders them.
 *
 * The existing /knowledge-base page already carries thirty-five hand-written
 * playbooks with routes and bullets. This file is not a replacement for that
 * reference material — it is the layer above it: the tasks a person is
 * expected to be able to DO, with the steps to walk them through it and the
 * rule that decides when they have actually done it.
 *
 * SHAPE
 *   step.anchor   — matches a `data-tour="..."` attribute on a real element.
 *                   Anchors are stable names, never coordinates, so a layout
 *                   change moves the highlight instead of breaking it.
 *   step.route    — the tour navigates here before showing the step.
 *   module.roles  — which roles see it. An agent must never be toured through
 *                   Settings.
 *   module.gate   — the tenant module it needs; matches the navigation's own
 *                   gating so a tenant without tolls is never shown tolls.
 *   module.verify — how completion is PROVED. Null means "read only" (there is
 *                   nothing to do), otherwise the backend checks the real
 *                   record. A module cannot be passed by clicking Next.
 *   module.kind   — ON_DEMAND can be done any time. OPPORTUNISTIC needs a real
 *                   car and a real customer, so it arms and completes the next
 *                   time the person genuinely does it.
 *   module.points — weighted by how expensive the task is to get wrong, not by
 *                   how long it takes.
 *   module.showcase — position in the convention track, or null to leave it out.
 *   module.needsRecord — some walkthroughs live INSIDE a record (a
 *                   reservation's own page), so their anchors cannot exist
 *                   until one is open. This names where to go find one.
 *                   Without it the tour would start, find nothing, and end
 *                   as BROKEN — which looked to the person like a dead
 *                   button (Hector, 2026-08-17).
 */

export const TOUR_TRACKS = Object.freeze({
  ONBOARDING: 'ONBOARDING',   // role-filtered full walkthrough. Launched from Ride University; the automatic first-login trigger is deliberately deferred (deploy D2.5 in the plan) because a new employee's first screen is the worst place to discover a bug.
  SHOWCASE: 'SHOWCASE',       // conventions and demos, presenter-driven
  MODULE: 'MODULE',           // one training module, launched from Ride University
});

/**
 * How completion is PROVED — each names a durable domain record, not an audit
 * row.
 *
 * The audit trail looked like the obvious substrate and is the wrong one
 * (Innovation, 2026-08-14). Two demonstrated failures, in opposite directions:
 * settling a balance with a payment writes a STATUS_CHANGE to CHECKED_IN with
 * the PAYER as actor, so taking a payment would have completed the check-in
 * module; and a genuine check-in that leaves a balance writes
 * CHECKED_IN_UNPAID, so it would have been missed. Audit rows also require a
 * reservationId, a quarter of them omit tenantId, and actorUserId is
 * unindexed.
 *
 * The domain records carry the actor already, are tenant-scoped, and mean
 * exactly one thing:
 *
 *   RESERVATION_CREATED      Reservation.createdByUserId
 *   RESERVATION_CHECKED_OUT  CheckoutSession.startedByUserId + finishedAt
 *   RESERVATION_CHECKED_IN   RentalAgreement.closedByUserId
 *   PAYMENT_RECORDED         needs ReservationPayment.recordedByUserId —
 *                            the one real gap, one additive column
 */
export const VERIFY = Object.freeze({
  RESERVATION_CREATED: 'RESERVATION_CREATED',
  RESERVATION_CHECKED_OUT: 'RESERVATION_CHECKED_OUT',
  RESERVATION_CHECKED_IN: 'RESERVATION_CHECKED_IN',
  PAYMENT_RECORDED: 'PAYMENT_RECORDED',
});

/**
 * ON_DEMAND means "do it now to pass". That is safe for reading a screen and
 * dangerous for anything that writes: a trainee creating a reservation to earn
 * points holds real inventory, and one posting a payment moves real money and
 * moves an agreement's balance.
 *
 * So the rule is: anything with a `verify` rule is OPPORTUNISTIC — it completes
 * the next time the person genuinely does that work. Training follows real
 * work; it never manufactures it. Rehearsing on demand is what the demo tenant
 * is for, and that path writes nowhere near your books.
 */
export const KINDS = Object.freeze({ ON_DEMAND: 'ON_DEMAND', OPPORTUNISTIC: 'OPPORTUNISTIC' });

export const COURSES = [
  // -------------------------------------------------------------------------
  {
    key: 'orientation',
    title: 'Getting around',
    summary: 'Where everything lives, and how to find anything fast.',
    modules: [
      {
        key: 'the-workspace',
        title: 'The workspace',
        summary: 'The dashboard, the menu, and how to search from anywhere.',
        roles: ['AGENT', 'OPS', 'ADMIN', 'SUPER_ADMIN'],
        gate: null,
        kind: 'ON_DEMAND',
        verify: null,
        points: 5,
        showcase: 1,
        gotcha: 'An unknown number shows as a dash, not a zero. A dash means the figure could not be loaded — it does not mean nothing happened.',
        steps: [
          {
            anchor: 'nav-dashboard',
            route: '/',
            // The nav item is gated on the `dashboard` tenant module while this
            // course is deliberately ungated (it also teaches search and
            // reservations, which everyone has). A tenant with the dashboard
            // switched off would otherwise hit a required anchor that is
            // correctly absent on its very first step (2026-08-28).
            optional: true,
            title: 'This is your day',
            body: 'Pickups and returns for the date you are looking at, what is overdue, and what needs attention. Every tile clicks through to the list behind it.',
          },
          {
            anchor: 'global-search',
            title: 'Find anything from here',
            body: 'Search by customer name, reservation number, plate — or a payment reference, if the agent recorded one. You never need to remember which screen something lives on.',
          },
          {
            anchor: 'nav-reservations',
            title: 'Reservations is where the work happens',
            body: 'Creating, checking out, checking in, payments and extensions all start here.',
          },
          {
            anchor: 'nav-university',
            route: '/knowledge-base',
            title: 'Ride University',
            body: 'Every module you can take, your progress, and the playbooks. You can relaunch this tour from here any time.',
          },
        ],
      },
    ],
  },

  // -------------------------------------------------------------------------
  {
    key: 'counter',
    title: 'Working the counter',
    summary: 'Everything that happens with a customer standing in front of you.',
    modules: [
      {
        key: 'find-reservation',
        title: 'Find a reservation',
        summary: 'By name, number, plate or payment reference.',
        roles: ['AGENT', 'OPS', 'ADMIN', 'SUPER_ADMIN'],
        gate: 'reservations',
        kind: 'ON_DEMAND',
        verify: null,
        points: 5,
        showcase: null,
        gotcha: 'A partial reservation number returning nothing does not mean the reservation does not exist. Search also matches the customer, the plate, and the last four of a card when it was recorded in the payment reference.',
        steps: [
          {
            anchor: 'nav-reservations',
            route: '/reservations',
            title: 'Open reservations',
            body: 'The full list, newest first.',
          },
          {
            anchor: 'reservations-filters',
            title: 'Filter to what you need',
            body: "Today's pickups, today's returns, or everything overdue. A rental counts as overdue the moment its return time passes — not at midnight.",
          },
        ],
      },

      {
        key: 'create-reservation',
        title: 'Create a reservation',
        summary: 'Book a car from scratch, start to finish.',
        roles: ['AGENT', 'OPS', 'ADMIN', 'SUPER_ADMIN'],
        gate: 'reservations',
        kind: 'OPPORTUNISTIC',
        verify: { type: VERIFY.RESERVATION_CREATED },
        points: 20,
        showcase: 3,
        gotcha: 'Minimum rental is 24 hours unless the vehicle class has an hourly rate configured. And monthly must be chosen on the first step — picking it later means attaching the plan from the reservation page afterwards.',
        steps: [
          {
            anchor: 'new-reservation-v2',
            route: '/reservations',
            title: 'Start a new reservation',
            body: 'This opens the four-step wizard, with a running quote beside you the whole way.',
          },
          {
            anchor: 'wizard-step-dates',
            route: '/reservations/new',
            title: 'Dates and locations first',
            body: 'Pickup and return, and where the car leaves from and comes back to. Choose the rate type here too — daily, or monthly for a long-term rental.',
          },
          {
            anchor: 'wizard-step-vehicle',
            title: 'Pick the class',
            body: 'The quote updates as you choose, so you can tell the customer the price before you commit to anything.',
          },
          {
            anchor: 'wizard-step-customer',
            title: 'Find or create the customer',
            body: 'Search first — most customers are already there. Creating a duplicate splits their rental history in two.',
          },
          {
            anchor: 'wizard-step-review',
            title: 'Review, then confirm',
            body: 'Now do it for real: complete this booking and the module marks itself finished.',
          },
        ],
      },

      {
        key: 'check-out',
        title: 'Check a vehicle out',
        summary: 'Agreement, terms, payment, photos, signature.',
        roles: ['AGENT', 'OPS', 'ADMIN', 'SUPER_ADMIN'],
        gate: 'reservations',
        kind: 'OPPORTUNISTIC',
        needsRecord: '/reservations',
        verify: { type: VERIFY.RESERVATION_CHECKED_OUT },
        points: 30,
        showcase: 4,
        gotcha: 'The photo step feels skippable when the lot is busy. It is the only evidence of the vehicle condition at handover — and at check-in the agent sees these exact photos beside the camera.',
        steps: [
          {
            anchor: 'reservation-checkout',
            title: 'Start the handover',
            body: 'The wizard walks the whole handover in order and will not let you skip what matters.',
          },
          {
            anchor: 'checkout-terms',
            title: 'Terms, signed by the customer',
            body: 'This is the authorization for post-rental charges — fuel, mileage, cleaning, tolls, damage. Without it those charges have no basis.',
          },
          {
            // The eight-angle grid is NOT in this wizard — the inspection is
            // handed to a phone, on a token-authed page the tour cannot reach.
            // Anchored to the handoff step instead, with copy that matches
            // what the agent is actually looking at (2026-08-14).
            anchor: 'checkout-inspection-handoff',
            title: 'Hand the inspection to a phone',
            body: 'This produces a code for the phone that walks the lot. Eight angles get captured there — front, rear, both sides, both seats, dashboard, trunk — and land back on this rental. Ninety seconds now settles an argument weeks later.',
          },
        ],
      },

      {
        key: 'check-in',
        title: 'Check a vehicle in',
        summary: 'Photos against the checkout, readings, fees, balance.',
        roles: ['AGENT', 'OPS', 'ADMIN', 'SUPER_ADMIN'],
        gate: 'reservations',
        kind: 'OPPORTUNISTIC',
        needsRecord: '/reservations',
        verify: { type: VERIFY.RESERVATION_CHECKED_IN },
        points: 30,
        showcase: 5,
        gotcha: 'When the customer returned on time but the check-in is recorded late, the late fee is computed from the moment of the check-in — unless an admin sets the actual return date, a field that only appears for admins past the grace period.',
        steps: [
          {
            anchor: 'reservation-checkin',
            title: 'Start the return',
            body: 'Same shape as the handover, in reverse.',
          },
          {
            anchor: 'checkin-photos',
            title: 'The checkout photo sits right there',
            body: 'Each angle shows how the car left the lot beside your live camera. Anything new gets noted here, while the customer is still in front of you.',
          },
          {
            anchor: 'checkin-metrics',
            title: 'Mileage, fuel, cleanliness',
            body: 'The fees compute from these as you type, so you can tell the customer the total before you charge it.',
          },
        ],
      },

      {
        key: 'take-payment',
        title: 'Take a payment',
        summary: 'Card, cash or check — and make it findable later.',
        roles: ['AGENT', 'OPS', 'ADMIN', 'SUPER_ADMIN'],
        gate: 'reservations',
        kind: 'OPPORTUNISTIC',
        needsRecord: '/reservations',
        verify: { type: VERIFY.PAYMENT_RECORDED },
        points: 15,
        showcase: null,
        gotcha: 'The reference field is what makes a payment findable months later. Fill it with the receipt or auth number and the card last four — without it, answering "who paid with the card ending 1234?" means opening reservations one at a time.',
        steps: [
          {
            anchor: 'reservation-payments',
            title: 'Open payments',
            body: 'Everything charged and collected on this rental, in one place.',
          },
          {
            anchor: 'payment-reference',
            title: 'Always fill the reference',
            body: 'Receipt or auth number, plus the card last four. This is the single habit that makes the money searchable.',
          },
        ],
      },
      {
        // The owner's flagship copilot case (design/mockups/copilot-NOTES.md
        // §3: "neither" — no article, no module; the copilot degraded to
        // Llévame). Copilot Phase 2 ships this micro-module so "te enseño"
        // fully guides it. Record-scoped: the roster lives inside one
        // reservation's own pages, so the tour parks until one is open —
        // exactly like check-out. ON_DEMAND with no verify on purpose:
        // adding a real driver to a real agreement is not something training
        // should manufacture, and no domain record names this act alone.
        key: 'additional-drivers',
        title: 'Add an additional driver',
        summary: 'Put a second driver on the agreement, license and all.',
        roles: ['AGENT', 'OPS', 'ADMIN', 'SUPER_ADMIN'],
        gate: 'reservations',
        kind: 'ON_DEMAND',
        needsRecord: '/reservations',
        verify: null,
        points: 10,
        showcase: null,
        gotcha: 'Confirm additional drivers BEFORE releasing the vehicle — a driver who is not on the agreement is not covered, and the configured fee does not charge itself after closeout.',
        steps: [
          {
            anchor: 'reservation-additional-drivers',
            title: 'Open Additional Drivers',
            body: 'Every extra driver lives inside the reservation itself. This button opens the driver roster for the rental you have open.',
          },
          {
            anchor: 'additional-driver-form',
            title: 'Add the driver, license and all',
            body: 'Name, address, date of birth, license number — and a photo of the license. Every field matters: this is who is covered behind the wheel. Add Driver puts them on the list below.',
          },
          {
            anchor: 'additional-drivers-save',
            title: 'Save before you hand over the keys',
            body: 'Nobody on the list counts until you save. Saving puts the roster on the reservation and returns you to it — do this before the vehicle leaves, never after.',
          },
        ],
      },
      {
        key: 'shuttle-tracker',
        title: 'The live shuttle tracker',
        summary: 'Customers watch the shuttle move on a live map and request it with one tap.',
        roles: ['AGENT', 'OPS', 'ADMIN', 'SUPER_ADMIN'],
        gate: 'reservations',
        kind: 'ON_DEMAND',
        verify: null,
        points: 5,
        // Still the finale; the shuttle console now runs at 8 ahead of it.
        showcase: 9,
        gotcha: 'Never screenshot or forward a tracker link — each one is personal to a single reservation and expires when the rental ends. The next customer gets their own automatically, by email and SMS. A shared link that suddenly dies at the curb is worse than no link.',
        steps: [
          {
            anchor: 'shuttle-queue',
            route: '/shuttle',
            title: 'Every request lands here',
            body: 'Customers picking up at a tracker-enabled location get a personal, expiring link by email and SMS. They watch the shuttle move on a live map, see exactly where to stand, and one tap requests the pickup — it appears on this screen for the floor team. Repeat taps and repeat calls fold into the same request: one anxious customer is one bus, not three.',
          },
        ],
      },
    ],
  },

  // -------------------------------------------------------------------------
  {
    key: 'fleet',
    title: 'Watching the fleet',
    summary: 'For whoever is minding the cars rather than the counter.',
    modules: [
      {
        key: 'overdue-returns',
        title: 'Chase an overdue return',
        summary: 'Find them, and find the car.',
        roles: ['OPS', 'ADMIN', 'SUPER_ADMIN'],
        gate: 'reservations',
        kind: 'ON_DEMAND',
        verify: null,
        points: 15,
        showcase: 6,
        gotcha: 'A car sitting on one of your own lots raises no alert. That is a missed check-in, not a missing car — two different problems with two different fixes.',
        steps: [
          {
            anchor: 'kpi-overdue',
            route: '/',
            title: 'Overdue, at a glance',
            body: 'Click through to the list. A rental is overdue the moment its return time passes.',
          },
          {
            // Renders only when there ARE alerts, which is the normal state.
            // optional:true tells the engine to skip rather than hunt for an
            // element that is correctly absent (2026-08-14).
            anchor: 'overdue-alerts',
            optional: true,
            title: 'Where the car actually is',
            body: 'With GPS connected, anything overdue and outside every one of your branches raises an alert here, with the distance and a map link. Nothing showing means nothing is missing.',
          },
        ],
      },

      {
        // The shuttle program shipped in August with a driver mode, on-demand
        // and non-stop running, zones and geofence alerts — and the curriculum
        // taught only the customer's tracker link. This is the staff side
        // (2026-08-28). Read-only on purpose: dispatching is done from the
        // live queue against real customers waiting at a curb, so there is
        // nothing here a trainee should be nudged to "do now" to earn points.
        key: 'shuttle-dispatch',
        title: 'Run the shuttle console',
        summary: 'The live map, who is driving, and the zones that raise alerts.',
        roles: ['OPS', 'ADMIN', 'SUPER_ADMIN'],
        // Shuttle has no module key of its own — it rides on `reservations`,
        // the same gate the backend routes enforce.
        gate: 'reservations',
        kind: 'ON_DEMAND',
        verify: null,
        points: 10,
        // Slots in as the last OPS beat, immediately before the tracker —
        // the deck deliberately closes on the customer-facing finale
        // (2026-08-16), so the console goes before it, not after.
        showcase: 8,
        gotcha: 'A driver link is a shift, not a person. Minting a second link for the same driver does not move them — it leaves two live shifts, and the map shows the bus twice. Revoke the old one when a shift changes hands.',
        steps: [
          {
            anchor: 'shuttle-console',
            route: '/shuttles',
            title: 'The console, in three tabs',
            body: 'The live map shows every shuttle transmitting right now, filtered to the location you pick. Positions refresh on their own roughly every twelve seconds — you never need to reload the page.',
          },
          {
            anchor: 'shuttle-drivers-tab',
            title: 'Who is driving, right now',
            body: 'Driver shifts are handed out as links, not logins: mint one, the driver opens it on their phone, and their position starts feeding the map customers watch. Revoke it and the feed stops immediately.',
          },
          {
            // ADMIN-only tab, so a non-admin ops viewer correctly has no
            // element here.
            anchor: 'shuttle-zones-tab',
            optional: true,
            title: 'Zones are what make alerts mean something',
            body: 'A zone is the area a shuttle is supposed to stay inside. Draw them once and the system tells you when a bus leaves its route or stops moving — instead of you watching a map all day.',
          },
        ],
      },

      {
        key: 'availability',
        title: 'Check availability',
        summary: 'What is free, what is out, what is down.',
        roles: ['OPS', 'ADMIN', 'SUPER_ADMIN'],
        gate: 'reports',
        kind: 'ON_DEMAND',
        verify: null,
        points: 10,
        showcase: null,
        gotcha: 'If you have switched your view to one location, exports follow that view. Switch back to all locations before exporting a fleet-wide roster.',
        steps: [
          {
            anchor: 'nav-reports',
            route: '/reports-v2/availability',
            title: 'Availability by class',
            body: 'Available, reserved, on rent, in maintenance — per vehicle class, right now.',
          },
          {
            anchor: 'report-export',
            title: 'Export the roster',
            body: 'PDF or Excel, and both now carry every vehicle with its status, not just the totals.',
          },
        ],
      },
    ],
  },

  // -------------------------------------------------------------------------
  {
    key: 'running-it',
    title: 'Running the operation',
    summary: 'Set up rarely, and expensive to get wrong.',
    modules: [
      {
        key: 'users-and-locations',
        title: 'Add a user and scope them',
        summary: 'Roles, and which branches they can see.',
        // Gated on `people`, not `settings`: the screen this walks IS /people,
        // which carries its own module key (2026-08-14).
        roles: ['ADMIN', 'SUPER_ADMIN'],
        gate: 'people',
        kind: 'ON_DEMAND',
        verify: null,
        points: 20,
        showcase: null,
        gotcha: 'A location-scoped agent sees only their own branches everywhere — including which locations they can book from. If an agent cannot create a reservation, check their location scope first.',
        steps: [
          {
            anchor: 'nav-people',
            route: '/people',
            title: 'People',
            body: 'Everyone with access, and what they can reach.',
          },
          {
            // ADMIN only, deliberately: the switcher never renders for a
            anchor: 'person-type',
            title: 'Pick what kind of person this is',
            body: 'Employee, admin, host or virtual agent. The choice sets their starting permissions, so it is the first thing to get right — changing it later means re-checking everything below it.',
          },
          {
            anchor: 'person-access-role',
            title: 'Then their access role',
            body: 'AGENT works the counter. OPS adds the operational screens. ADMIN can change settings and manage people. When in doubt give less: raising someone later is one click, undoing what they changed is an audit.',
          },
          {
            anchor: 'person-locations',
            // Rendered only when the tenant HAS locations to tick, and hidden
            // for a HOST. Both are legitimate absences, so skip rather than
            // strand the tour — the same treatment the switcher below already
            // gets (2026-08-28).
            optional: true,
            title: 'Scope them to their branch',
            body: 'Check the locations this person works at. Leaving every box UNCHECKED is not "no access" — it means they see ALL locations. That is the most common mistake on this screen.',
          },
          {
            // SUPER_ADMIN (they pick a tenant instead), so touring a super
            // admin past it would highlight nothing.
            anchor: 'view-location-switcher',
            // Renders only for someone with more than one location, so a
            // single-branch admin correctly has no element (QA, 2026-08-14).
            optional: true,
            title: 'Viewing as one branch',
            body: 'Anyone with more than one location gets this switcher. It changes what they see everywhere — including what their exports contain.',
          },
        ],
      },

      {
        key: 'incoming-bookings',
        title: 'Bookings arriving on their own',
        summary: 'Franchise and broker feeds, and the review tray.',
        roles: ['ADMIN', 'SUPER_ADMIN'],
        gate: 'settings',
        kind: 'ON_DEMAND',
        verify: null,
        points: 20,
        showcase: 2,
        gotcha: 'A booking in the review tray is not an error. It is the system refusing to guess — usually a customer it could not match with confidence.',
        steps: [
          {
            anchor: 'nav-settings',
            route: '/settings',
            title: 'Integrations',
            body: 'Each connected franchise or broker pulls reservations in on a schedule, matched to customers and checked for duplicates before anyone sees them.',
          },
          {
            // The tray lives on /reservations, not /settings — Settings only
            // links to it (2026-08-14). The tour navigates rather than
            // pointing at an element that is not on the page.
            anchor: 'pending-imports',
            route: '/reservations',
            // The tray hides itself when the queue is empty — the normal,
            // healthy state (QA, 2026-08-14).
            optional: true,
            title: 'The review tray',
            body: 'Anything that did not match cleanly waits here with what the system found, for a person to decide. It hides itself when there is nothing waiting — an empty screen is good news.',
          },
        ],
      },

      {
        key: 'market-pricing',
        title: 'Price against the market',
        summary: 'What competitors charge, beside what you charge.',
        roles: ['ADMIN', 'SUPER_ADMIN'],
        gate: 'marketIntelligence',
        kind: 'ON_DEMAND',
        verify: null,
        points: 15,
        showcase: 7,
        gotcha: 'Prices update nightly, not live. And the day filters are how far ahead the pickup is — the booking window — not how long the rental lasts.',
        steps: [
          {
            anchor: 'nav-market',
            route: '/market',
            title: 'The market, by class',
            body: 'Competitor offers collected nightly across the major booking sites, mapped to the same vehicle classes your fleet uses.',
          },
          {
            // Anchored to the Suggestions button, which is always on /market.
            // The guardrail form itself sits on step 4 of the onboarding
            // wizard — invisible on arrival, so pointing at it produced a step
            // that highlighted nothing (QA, 2026-08-14).
            anchor: 'market-strategy',
            title: 'Where the strategy pays off',
            body: 'You choose where to sit — second cheapest, for instance — and how far a price may move on its own. Anything bigger lands in this inbox for you to approve.',
          },
        ],
      },
    ],
  },
];

// ---------------------------------------------------------------------------
// Selectors — the only way surfaces should reach into the curriculum.
// ---------------------------------------------------------------------------

/** Every module, flattened, each carrying its course. */
export function allModules() {
  return COURSES.flatMap((course) =>
    (course.modules || []).map((m) => ({ ...m, courseKey: course.key, courseTitle: course.title }))
  );
}

export function findModule(key) {
  return allModules().find((m) => m.key === String(key)) || null;
}

/**
 * Modules a person can actually take.
 *
 * @param {{role: string, isModuleEnabled?: (gate: string) => boolean}} viewer
 */
export function modulesFor(viewer = {}) {
  const role = String(viewer.role || '').toUpperCase();
  const enabled = typeof viewer.isModuleEnabled === 'function' ? viewer.isModuleEnabled : () => true;
  return allModules().filter((m) => {
    if (role && Array.isArray(m.roles) && !m.roles.includes(role)) return false;
    if (m.gate && !enabled(m.gate)) return false;
    return true;
  });
}

/** Total points available to this viewer — the denominator for progress. */
export function pointsAvailable(viewer = {}) {
  return modulesFor(viewer).reduce((sum, m) => sum + (Number(m.points) || 0), 0);
}

/**
 * The steps for a track.
 *
 * ONBOARDING — role- and module-filtered, in curriculum order, one pass over
 * everything they will need. SHOWCASE — only the marked modules, ordered for
 * effect, unfiltered because it is demonstrating the whole product.
 */
export function stepsForTrack(track, viewer = {}) {
  if (track === TOUR_TRACKS.SHOWCASE) {
    return allModules()
      .filter((m) => Number.isFinite(m.showcase))
      .sort((a, b) => a.showcase - b.showcase)
      .flatMap((m) => (m.steps || []).map((s) => ({ ...s, moduleKey: m.key, moduleTitle: m.title })));
  }
  return modulesFor(viewer)
    .flatMap((m) => (m.steps || []).map((s) => ({ ...s, moduleKey: m.key, moduleTitle: m.title })));
}

/**
 * The module a STEP belongs to.
 *
 * Read the step, never the tour. A MODULE-track tour carries its own
 * moduleKey, but the ONBOARDING track carries none — it is every module in one
 * sequence — and code that asked the TOUR which module it was in got null and
 * silently skipped the record-scoped handling. That is precisely how the tour
 * came to die at step 11 of 33 (2026-08-28). Every step is stamped with its
 * moduleKey by stepsForTrack/stepsForModule, so the step always knows.
 */
export function moduleForStep(step) {
  return step?.moduleKey ? findModule(step.moduleKey) : null;
}

/**
 * The last index of the run of steps belonging to the SAME MODULE as
 * `startIndex` — the fence a parked tour may resume inside.
 *
 * It must be the module and not the whole record-scoped run (caught in the
 * browser, 2026-08-28). A reservation's own page carries the first step of
 * check-out, check-in AND payments at once. Parked on "terms", which lives one
 * screen further into the check-out wizard, a run-wide scan found check-in's
 * button sitting right there and resumed on it — silently skipping the two
 * steps that actually teach the handover.
 */
export function moduleRunEnd(steps, startIndex) {
  if (!Array.isArray(steps)) return startIndex;
  const key = steps[startIndex]?.moduleKey;
  let end = startIndex;
  for (let i = startIndex + 1; i < steps.length && steps[i]?.moduleKey === key; i++) end = i;
  return end;
}

/**
 * The last index of the run of record-scoped steps beginning at `startIndex`.
 *
 * Check-out, check-in and take-payment are consecutive and all live inside one
 * reservation's page, so a tour parked at the first of them may legitimately
 * resume at any step up to the end of that run — and must not resume beyond
 * it, or opening a reservation would jump the person past whole modules.
 * Returns startIndex - 1 when the step there is not record-scoped at all.
 */
export function recordScopedRunEnd(steps, startIndex) {
  if (!Array.isArray(steps)) return startIndex - 1;
  let end = startIndex - 1;
  for (let i = startIndex; i < steps.length; i++) {
    if (!moduleForStep(steps[i])?.needsRecord) break;
    end = i;
  }
  return end;
}

/** The steps of one module, for the guided-practice launcher. */
export function stepsForModule(key) {
  const m = findModule(key);
  if (!m) return [];
  return (m.steps || []).map((s) => ({ ...s, moduleKey: m.key, moduleTitle: m.title }));
}
