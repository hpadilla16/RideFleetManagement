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
 */

export const TOUR_TRACKS = Object.freeze({
  ONBOARDING: 'ONBOARDING',   // first login, role-filtered, on their own tenant
  SHOWCASE: 'SHOWCASE',       // conventions and demos, presenter-driven
  MODULE: 'MODULE',           // one training module, launched from Ride University
});

/** Verification kinds the backend knows how to check against real records. */
export const VERIFY = Object.freeze({
  RESERVATION_CREATED: 'RESERVATION_CREATED',
  RESERVATION_CHECKED_OUT: 'RESERVATION_CHECKED_OUT',
  RESERVATION_CHECKED_IN: 'RESERVATION_CHECKED_IN',
  PAYMENT_RECORDED: 'PAYMENT_RECORDED',
  RESERVATION_EXTENDED: 'RESERVATION_EXTENDED',
});

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
            route: '/dashboard',
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
        kind: 'ON_DEMAND',
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
            anchor: 'checkout-photos',
            title: 'Eight angles, every time',
            body: 'Front, rear, both sides, both seats, dashboard, trunk. Ninety seconds now settles an argument weeks later.',
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
        kind: 'ON_DEMAND',
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
            route: '/dashboard',
            title: 'Overdue, at a glance',
            body: 'Click through to the list. A rental is overdue the moment its return time passes.',
          },
          {
            anchor: 'overdue-alerts',
            title: 'Where the car actually is',
            body: 'With GPS connected, anything overdue and outside every one of your branches raises an alert here, with the distance and a map link.',
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
        roles: ['ADMIN', 'SUPER_ADMIN'],
        gate: 'settings',
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
            anchor: 'view-location-switcher',
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
            anchor: 'pending-imports',
            title: 'The review tray',
            body: 'Anything that did not match cleanly waits here with what the system found, for a person to decide.',
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
            anchor: 'market-strategy',
            title: 'Set a strategy',
            body: 'Choose where you want to sit — second cheapest, for instance — and how far a price may move on its own. Anything bigger waits for you.',
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

/** The steps of one module, for the guided-practice launcher. */
export function stepsForModule(key) {
  const m = findModule(key);
  if (!m) return [];
  return (m.steps || []).map((s) => ({ ...s, moduleKey: m.key, moduleTitle: m.title }));
}
