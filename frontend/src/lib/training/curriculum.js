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
 *   step.figure   — INSTEAD of a live element: the step draws a screen the tour
 *                   cannot reach (the guest's iPad, the Valet console) from the
 *                   figure registry. Still carries a unique `anchor` so keys,
 *                   tests and progress have one identity to hold. `callouts`
 *                   number what the drawing marks.
 *   step.check    — a question the person must answer before the module
 *                   closes. Wrong answers explain themselves and cost nothing.
 *                   It is what makes a reading module more than a Next button.
 *   module.requiresFeature — a key of the viewer's `features` (from /api/auth/me)
 *                   that must be true for the module to exist for them at all.
 *                   Training a feature that is not live at someone's counter
 *                   teaches a button that does nothing; fail-closed — no
 *                   features object, no module (Hector, 2026-09-05).
 *   module.onboarding — false keeps the module OUT of the ONBOARDING track (it
 *                   stays in Ride University and the copilot). The kiosk
 *                   situations are things you look up when they happen, not a
 *                   first-day walkthrough — with them in, an admin's onboarding
 *                   grew from ~33 to ~58 steps (Innovation, 2026-09-04).
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
  // Kiosk course (2026-09-04). Both are domain records with an actor:
  //   KIOSK_ASSISTED_ID     KioskSession.assistUserId + idVerifiedAt, method STAFF_OVERRIDE
  //   KIOSK_ASSISTED_NAME   same row, method STAFF_NAME_OVERRIDE — one act, one module
  //   KIOSK_ACCESS_GRANTED  ModuleAccessAuditLog.actorUserId, changed ∋ {kiosk → true}
  // A REMOTE override is deliberately not a verify type: Valet reaches the
  // server as one service account, so the record cannot name the human.
  KIOSK_ASSISTED_ID: 'KIOSK_ASSISTED_ID',
  KIOSK_ASSISTED_NAME: 'KIOSK_ASSISTED_NAME',
  KIOSK_ACCESS_GRANTED: 'KIOSK_ACCESS_GRANTED',
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

  // -------------------------------------------------------------------------
  // The self-service kiosk (Hector, 2026-09-04): one module per SITUATION a
  // guest gets into on the iPad, walked step by step — what they see, what the
  // employee does, what happens when it goes sideways. Nearly all of it happens
  // on screens the tour cannot spotlight, so the steps are drawn (`figure`),
  // and each module closes with a check. The course also owns the button
  // glossary (`reference`), which is not a module: no points, always open.
  {
    key: 'kiosk',
    title: 'Self-service kiosk',
    summary: 'What happens on the iPad, what the guest sees, and what to do when they get stuck.',
    reference: 'kiosk-buttons',
    modules: [
      {
        key: 'kiosk-cant-scan',
        title: 'The guest cannot scan their license',
        summary: 'From “I can’t — get help” to verifying the ID yourself with your PIN.',
        roles: ['AGENT', 'OPS', 'ADMIN', 'SUPER_ADMIN'],
        gate: 'kiosk',
        onboarding: false,
        kind: 'OPPORTUNISTIC',
        verify: { type: VERIFY.KIOSK_ASSISTED_ID },
        points: 15,
        showcase: null,
        gotcha: 'Your PIN opens a ten-minute window — it does not bend a rule. Age and license validity run exactly as they do for a scan; the name check is the one thing it skips, because you are holding the physical license in front of the guest and that is what your PIN certifies. If the real date of birth fails, the kiosk is telling the truth: “End assist” and let the counter decide.',
        steps: [
          {
            anchor: 'kiosk-fig-scan-trouble', figure: 'scan-trouble',
            title: 'Two failed scans',
            body: 'The guest is on “Scan your driver’s license”, barcode side up, and the reader is not catching it. Glare, a worn card, a laminated copy — it happens. Before anyone is called, the screen already offers two ways around it.',
            callouts: [
              '“Upload barcode photo” — a still photo is often readable when the live camera is not.',
              '“Take a photo instead” reads the FRONT of the license instead, then asks the guest to confirm what it read.',
            ],
          },
          {
            anchor: 'kiosk-fig-escalated', figure: 'escalated',
            title: 'They ask for a person',
            body: 'The guest taps “I can\'t do this — get help”. The kiosk switches to “A team member is on the way” and notifies the counter. Nothing is lost: the reservation, the step, everything they entered stays in the session.',
            callouts: [
              'If they tap 🎧 Help instead, the help chat opens and a Valet agent takes over remotely — that is its own module.',
              'The small “Staff assist” button at the bottom is your door in.',
            ],
          },
          {
            anchor: 'kiosk-fig-staff-pin', figure: 'staff-pin',
            title: 'Unlock with your PIN',
            body: 'Tap “Staff assist”, pick your name and enter your PIN on the keypad. “Unlock” opens a ten-minute grant in your name — the chip shows who and how long, and it closes on its own.',
            callouts: [
              'Your name greyed out means you have no PIN yet — set one in your profile first.',
              'Wrong PINs, wrong codes and failed lookups all feed one counter for this kiosk — the screen says how many attempts are left. At zero it locks for fifteen minutes.',
              '“Cancel — back to guest” closes the panel without a grant.',
            ],
          },
          {
            anchor: 'kiosk-fig-staff-manual-id', figure: 'staff-manual-id',
            title: 'Type the license in, photograph both sides',
            body: 'Fill in first name, last name, date of birth and expiry exactly as printed. Then “Capture” or “Upload” the FRONT and the BACK of the physical license — both are required, and they are stored with the rental.',
            callouts: [
              'The photos are the evidence that a person saw the card. Without both, “Verify & continue” stays off.',
            ],
          },
          {
            anchor: 'kiosk-fig-staff-verify', figure: 'staff-verify',
            title: 'Verify and continue — two rules still run',
            body: 'Two checks, not three: the age requirement and a license valid through the return date. The name check is deliberately NOT run here — you are holding the physical license in front of the guest, and that is exactly what your PIN certifies. A typo can be corrected and verified again. A real failure cannot be talked past.',
            callouts: [
              'A red mark here is the kiosk doing its job — check the fields for a typo first.',
              '“Verify & continue” runs the two checks again with what you typed.',
              '“End assist” closes without verifying; the rental is then the counter’s call.',
            ],
          },
          {
            anchor: 'kiosk-fig-guest-notice-done', figure: 'guest-notice-done',
            title: 'What the guest sees now',
            body: '“ID verified by staff” hands control back with “Continue as guest”. From then on a green notice reads “Your ID was confirmed by Ana Rivera from our team.” — the name is your real user account, and it stays on screen for the rest of the check-in.',
            callouts: [
              'The record keeps who, when, and that it was in person — distinct from a remote override.',
            ],
          },
          {
            anchor: 'kiosk-check-cant-scan',
            title: 'Quick check',
            body: 'One question before this module closes.',
            check: {
              question: 'You typed the license in and the kiosk says the guest does not meet the minimum age. What do you do?',
              options: [
                { key: 'A', text: 'Re-enter a “corrected” date of birth so it passes', why: 'That is falsifying a rental record under your own PIN. The date of birth on the license is the date of birth.' },
                { key: 'B', text: 'Check for a typo; if the date is real, end the assistance and let the counter decide', correct: true, why: 'Nothing skips the rules — not your PIN, not a remote agent. A real failure is the kiosk doing its job.' },
                { key: 'C', text: 'Ask Valet to approve it remotely', why: 'Remote agents run the very same checks. There is no override for age or validity anywhere in the system.' },
              ],
            },
          },
        ],
      },

      {
        key: 'kiosk-name-mismatch',
        title: 'The name on the license does not match',
        summary: 'The guest’s own way out (a 6-digit code) and yours (certifying the license).',
        roles: ['AGENT', 'OPS', 'ADMIN', 'SUPER_ADMIN'],
        gate: 'kiosk',
        onboarding: false,
        kind: 'OPPORTUNISTIC',
        verify: { type: VERIFY.KIOSK_ASSISTED_NAME },
        points: 10,
        showcase: null,
        gotcha: 'When you confirm the name you are certifying, under your own account, that you looked at the physical license and it belongs to this person. When the guest can prove it themselves with the code, let them — it leaves the cleaner trail.',
        steps: [
          {
            anchor: 'kiosk-fig-name-mismatch', figure: 'name-mismatch',
            title: 'The license read fine — the name did not match',
            body: 'Age and validity pass; only the name check is red. Common causes: a maiden name, a second surname, a booking made by a spouse. The kiosk does not fail the guest here — it offers two ways to prove the reservation is theirs.',
            callouts: [
              'Two green, one red: this is a NAME problem, not an ID problem.',
              '“Send my code” — the guest proves it themselves (next step).',
              '“Connect me to a team member” — a person confirms it, in person or from Valet.',
            ],
          },
          {
            anchor: 'kiosk-fig-name-code', figure: 'name-code',
            title: 'The guest proves it with a code',
            body: 'A 6-digit code goes to the email or phone ON THE RESERVATION — never to a number the guest types now. Entering it updates the reservation to the license name and the check-in continues. It expires in ten minutes.',
            callouts: [
              '“Confirm code” — wrong codes count against the kiosk’s shared attempt counter; the screen says how many are left before it locks.',
              '“Resend code” has a cooldown so the inbox is not flooded.',
            ],
          },
          {
            anchor: 'kiosk-fig-staff-name-confirm', figure: 'staff-name-confirm',
            title: 'Or you confirm it, in person',
            body: 'Unlock with your PIN as usual. Instead of the full form the kiosk shows both names side by side. “I verified this license matches the guest” records that YOU looked at the card and vouched — the rental carries your name on that decision.',
            callouts: [
              'License name versus reservation name, exactly as each system has them.',
              'This button is a certification, not a shortcut. If you did not see the card, do not press it.',
            ],
          },
          {
            anchor: 'kiosk-check-name-mismatch',
            title: 'Quick check',
            body: 'One question before this module closes.',
            check: {
              question: 'The guest says the reservation was made by her husband, who is not here. The license is hers. What is the right path?',
              options: [
                { key: 'A', text: 'Press “I verified this license matches the guest” — it is her license', why: 'Her license is real, but the reservation is not in her name. Certifying the name does not put a driver on someone else’s booking.' },
                { key: 'B', text: 'Have the guest use “Send my code” — the code goes to the contact on the reservation', correct: true, why: 'If the husband shares the code, the booking updates to her name with his consent on record. If he cannot, the counter decides the rental.' },
                { key: 'C', text: 'Tell her to start over and search by her own name', why: 'There is no reservation under her name to find. Starting over only erases what she entered.' },
              ],
            },
          },
        ],
      },

      {
        key: 'kiosk-valet-help',
        title: 'The guest asks for help by chat and Valet takes it',
        summary: 'What the guest sees, what a remote agent can and cannot do, and why the keys are yours to hand over.',
        roles: ['AGENT', 'OPS', 'ADMIN', 'SUPER_ADMIN'],
        gate: 'kiosk',
        onboarding: false,
        kind: 'ON_DEMAND',
        verify: null,
        points: 10,
        showcase: null,
        gotcha: 'When Valet finishes, the guest still has to walk to you for the key. The green notice on their screen is your cue — have it ready.',
        steps: [
          {
            anchor: 'kiosk-fig-help-chat', figure: 'help-chat',
            title: '🎧 Help opens a chat with a Valet agent',
            body: 'The guest can tap Help on any screen. A Valet agent sees which step they are on and what has been verified — never the license photos, never card details. The chat sits over the check-in without ending it.',
            callouts: [
              'Help is always in the corner. It never ends the session.',
              'Closing the chat asks “End help chat?” — the check-in stays where it was.',
            ],
          },
          {
            anchor: 'kiosk-fig-guest-notice-now', figure: 'guest-notice-now',
            title: 'While the agent works, the guest is told',
            body: 'A violet notice reads “Ana Rivera from our team is helping you with this check-in right now.” for as long as the agent holds a grant (ten minutes, then it closes by itself). The name is the REAL user account behind the action — never a name the console typed. A service account shows “Someone from our team is helping you with this check-in right now.”.',
            callouts: [
              'Violet = happening now. It turns green (“your ID was confirmed… remotely”) once the override is applied.',
              '“✓ Your agent updated your check-in” confirms an action landed.',
              'Attempts to skip signing or paying from the chat are refused on screen.',
            ],
          },
          {
            anchor: 'kiosk-fig-remote-limits', figure: 'remote-limits',
            title: 'What a remote agent can — and cannot — do',
            body: 'Can: unlock the session, enter the license by hand from the photos already on file, confirm the name. Cannot: skip verification, sign, pay — and cannot open the car. The remote unlock goes to a lockbox that does not exist yet, so the agent tells the guest to collect the keys at the front desk.',
            callouts: [
              'Everything here runs the same rules as the kiosk itself.',
              'Signature and payment are the guest’s alone, at the kiosk.',
              'Keys: “Please see a team member at the counter to pick up your keys.” — that is you.',
            ],
          },
          {
            anchor: 'kiosk-check-valet-keys',
            title: 'Quick check',
            body: 'One question before this module closes.',
            check: {
              question: 'The guest has signed, and a Valet agent confirmed their identity remotely. Who hands over the key?',
              options: [
                { key: 'A', text: 'Valet unlocks the car remotely', why: 'There is no remote unlock. That path leads to a lockbox the location does not have yet.' },
                { key: 'B', text: 'The front desk — the agent tells the guest to come collect it', correct: true, why: 'Remote help ends at the screen. The car changes hands at the counter, with you.' },
                { key: 'C', text: 'The kiosk prints a pickup code', why: 'The kiosk prints nothing. The “All set” screen says “Please see a team member at the counter to pick up your keys.”.' },
              ],
            },
          },
        ],
      },

      {
        key: 'kiosk-payment',
        title: 'The payment fails or the kiosk does not move on',
        summary: 'The link and QR, and what to do when the screen does not advance.',
        roles: ['AGENT', 'OPS', 'ADMIN', 'SUPER_ADMIN'],
        gate: 'kiosk',
        requiresFeature: 'kioskPaymentLive',
        onboarding: false,
        kind: 'ON_DEMAND',
        verify: null,
        points: 5,
        showcase: null,
        gotcha: 'Never charge by hand what the kiosk is charging. A “stuck” screen is usually a payment that landed a few seconds ago — look in Reservations → Payments before touching the terminal. And if two payments ever land (an old QR left open on the phone), refund the extra one; never re-charge.',
        steps: [
          {
            anchor: 'kiosk-fig-pay-qr', figure: 'pay-qr',
            title: 'One link, one QR, and the kiosk waits',
            body: '“Show payment code” creates ONE payment link to the tenant’s hosted payment page and shows it as a QR. The guest scans it and pays on their phone. The kiosk shows “Waiting for payment…” and moves to the signature by itself the moment the server confirms. Pressing “Show payment code” again with the same total shows the SAME link.',
            callouts: [
              'The QR is a link to the payment page — the kiosk never sees the card.',
              '“Waiting for payment…” polls every few seconds. Give it ten to fifteen. A declined card is retried by the guest on their phone, from this same QR.',
              'What is charged today versus the refundable hold on the card.',
            ],
          },
          {
            anchor: 'kiosk-fig-pay-failed', figure: 'pay-failed',
            title: 'If the total changes',
            body: '“Change protection & extras” goes back to extras. A new total mints a NEW link and QR; the old one leaves the kiosk screen but is STILL payable if the guest left it open on their phone — there is no way to cancel it at the gateway. Have the guest close the old payment page before scanning the new code. If two payments land, both show under Reservations → Payments: refund the extra one, never re-charge.',
            callouts: [
              '“Try again” belongs to the sandbox/failed screen — it is not a link action. Same-total reuse comes from pressing “Show payment code” again.',
              '“Change protection & extras” — a new total means a new link; the old one is off the screen, not dead.',
            ],
          },
          {
            anchor: 'kiosk-check-payment',
            title: 'Quick check',
            body: 'One question before this module closes.',
            check: {
              question: 'The guest says they paid on their phone, but the kiosk still shows “Waiting for payment…”. What do you do?',
              options: [
                { key: 'A', text: 'Charge them on the counter terminal so they can move on', why: 'That is the double charge. The kiosk’s payment may have landed seconds ago — the screen just has not polled yet.' },
                { key: 'B', text: 'Wait ten to fifteen seconds, then check Reservations → Payments', correct: true, why: 'If the payment is there, the kiosk will catch up. If it is not, the guest retries on their phone from the same QR — or you press “Show payment code” again, which shows the same link for the same total.' },
                { key: 'C', text: 'Tap “Start over” and begin the check-in again', why: 'That erases the session. The payment, if it landed, stays attached to the reservation — but the guest redoes everything.' },
              ],
            },
          },
        ],
      },

      {
        key: 'kiosk-brakes',
        title: '“Still there?”, “Not my reservation”, and a locked kiosk',
        summary: 'The three ways the kiosk stops itself: inactivity, a wrong match, and fifteen minutes of lockout.',
        roles: ['AGENT', 'OPS', 'ADMIN', 'SUPER_ADMIN'],
        gate: 'kiosk',
        onboarding: false,
        kind: 'ON_DEMAND',
        verify: null,
        points: 5,
        showcase: null,
        gotcha: 'A locked kiosk is not broken. An admin clears it on the spot by issuing a new pairing code (Ride Fleet → Kiosks); with no admin at hand, finish the guest at the counter — in fifteen minutes it is back by itself. Restarting the iPad changes nothing: the lock lives on the server.',
        steps: [
          {
            anchor: 'kiosk-fig-idle', figure: 'idle',
            title: '“Are you still there?” — the privacy reset',
            body: 'After a pause with no touch, the kiosk asks. “I\'m still here — continue” keeps everything. If nobody answers, the countdown reaches zero and the session resets, clearing what was entered — a stranger walking up must never see the last guest’s reservation.',
            callouts: [
              '“I\'m still here — continue” keeps every field filled so far.',
              '“Start over” clears it all on purpose — there is no undo.',
            ],
          },
          {
            anchor: 'kiosk-fig-not-mine', figure: 'not-mine',
            title: '“This isn\'t my reservation”',
            body: 'The summary shows driver, dates and class before anything else happens. If it is the wrong one, “This isn\'t my reservation” goes back to the search without spending an attempt. Lookups by number have a limited number of tries — the search screen says how many are left — and once spent, the kiosk pauses searches for a few minutes.',
            callouts: [
              '“That\'s me — continue” is the guest confirming the match.',
              '“This isn\'t my reservation” is free — it does not count as a failed attempt.',
            ],
          },
          {
            anchor: 'kiosk-fig-locked', figure: 'locked',
            title: 'Locked for fifteen minutes',
            body: 'Too many wrong PINs, wrong codes or failed lookups, and the kiosk pauses staff unlock and searches. It is protecting the guest data on it. Two ways out: an admin issues a new pairing code from Ride Fleet → Kiosks and the lock clears immediately — or you wait it out and finish the guest at the counter.',
            callouts: [
              'There is no timer on screen — the lock simply lifts by itself after fifteen minutes.',
              'The screen itself says it: an admin can issue a new pairing code to clear it right away.',
            ],
          },
          {
            anchor: 'kiosk-check-locked',
            title: 'Quick check',
            body: 'One question before this module closes.',
            check: {
              question: 'The kiosk shows “This kiosk is temporarily locked” after a colleague ran its attempt counter down with wrong PINs. A guest is waiting and no admin is around. What do you do?',
              options: [
                { key: 'A', text: 'Keep trying PINs until one works', why: 'While locked, every attempt is refused before it is even counted — it does nothing except keep the guest standing there.' },
                { key: 'B', text: 'Finish the guest at the counter; the kiosk unlocks itself in fifteen minutes — or an admin clears it now with a new pairing code', correct: true, why: 'The lockout is protection, not a fault. The counter does everything the kiosk does, and Ride Fleet → Kiosks → new pairing code clears it instantly when an admin is available.' },
                { key: 'C', text: 'Restart the iPad', why: 'The lock lives on the server, not the tablet. A restart changes nothing and loses the guest’s session.' },
              ],
            },
          },
        ],
      },

      {
        key: 'kiosk-done-keys',
        title: 'They signed: keys, contract and the photo walk-around',
        summary: 'The “All set!” screen — where the key is, what arrived by email, and the inspection link.',
        roles: ['AGENT', 'OPS', 'ADMIN', 'SUPER_ADMIN'],
        gate: 'kiosk',
        onboarding: false,
        kind: 'ON_DEMAND',
        verify: null,
        points: 5,
        showcase: null,
        gotcha: 'The screen resets itself after a 30-second countdown. If the guest wants a printed contract, print it from the reservation — the kiosk cannot.',
        steps: [
          {
            anchor: 'kiosk-fig-done', figure: 'done',
            title: '“All set!” — three things to point at',
            body: 'Keys: “Please see a team member at the counter to pick up your keys.” Contract and receipt: already in their email. Before leaving: a QR (or emailed link) to photo-document the car’s condition — the same inspection the counter would do, done by the guest on their phone.',
            callouts: [
              'Keys are handed by you, at the counter — unless your location is set to Lockbox in Ride Fleet → Kiosks, in which case the screen sends the guest to the lockbox instead.',
              'Contract and receipt went to the email on the reservation.',
              'The inspection link is how damage disputes are settled later — encourage it.',
            ],
          },
          {
            anchor: 'kiosk-check-done',
            title: 'Quick check',
            body: 'One question before this module closes.',
            check: {
              question: 'The guest at “All set!” asks for a printed copy of the contract. What do you do?',
              options: [
                { key: 'A', text: 'Tap the screen before it resets and print from the kiosk', why: 'The kiosk has no printer and no print button. The “All set!” screen only resets.' },
                { key: 'B', text: 'Print it from the reservation on your own screen', correct: true, why: 'Every signed agreement is on the reservation. The kiosk already emailed it; you can print it.' },
                { key: 'C', text: 'Tell them it is email-only', why: 'It is in their email, but a printed copy is a normal request — and you can fulfil it in seconds.' },
              ],
            },
          },
        ],
      },

      {
        key: 'kiosk-grant-valet',
        title: 'Give Valet access to the kiosk',
        summary: 'People → the Valet service account → the Kiosk module. Without it, Valet cannot see kiosk sessions.',
        roles: ['ADMIN', 'SUPER_ADMIN'],
        gate: 'kiosk',
        onboarding: false,
        kind: 'OPPORTUNISTIC',
        needsRecord: '/people',
        needsRecordLabel: 'the Valet service account in People',
        verify: { type: VERIFY.KIOSK_ACCESS_GRANTED },
        points: 5,
        showcase: null,
        gotcha: 'Two switches, not one: the Kiosk module must be on for the company (Settings) AND ticked on the service account. Access is cached per user for a few minutes, so a change may take a moment to reach Valet.',
        steps: [
          {
            anchor: 'person-module-kiosk',
            title: 'Tick “Kiosk” on the Valet service account',
            body: 'Open the Valet service account in People, scroll to User Module Access, tick Kiosk and save. This is what lets a Valet agent see where a guest is stuck and help from the console. Every change here is recorded with your name.',
          },
          {
            anchor: 'kiosk-check-grant',
            title: 'Quick check',
            body: 'One question before this module closes.',
            check: {
              question: 'Valet reports “we cannot see the kiosk sessions” for a new location. Kiosk is ticked on the service account. What else can it be?',
              options: [
                { key: 'A', text: 'The Kiosk module is off for the company in Settings — the user tick does nothing on its own', correct: true, why: 'Tenant module settings apply on top of per-user access. Both must be on.' },
                { key: 'B', text: 'Valet needs a PIN like an employee', why: 'PINs are for in-person unlock at the kiosk. Remote access is the service account plus the module.' },
                { key: 'C', text: 'Each kiosk must be paired to Valet individually', why: 'Pairing binds an iPad to the location. Valet reads sessions through the module, not through pairing.' },
              ],
            },
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
  const hasFeature = typeof viewer.hasFeature === 'function' ? viewer.hasFeature : () => false;
  return allModules().filter((m) => {
    if (role && Array.isArray(m.roles) && !m.roles.includes(role)) return false;
    if (m.gate && !enabled(m.gate)) return false;
    // Fail-closed, unlike gates: a gate absent means "tenant has it", a feature
    // absent means "not live here".
    if (m.requiresFeature && !hasFeature(m.requiresFeature)) return false;
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
    .filter((m) => m.onboarding !== false)
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

/** Courses that carry reference material (a glossary) beside their modules. */
export function courseReference(course) {
  return course?.reference || null;
}

/** Is this step drawn or asked, rather than pointed at an element on a page? */
export function isVirtualStep(step) {
  return !!(step && (step.figure || step.check));
}

/** The steps of one module, for the guided-practice launcher. */
export function stepsForModule(key) {
  const m = findModule(key);
  if (!m) return [];
  return (m.steps || []).map((s) => ({ ...s, moduleKey: m.key, moduleTitle: m.title }));
}
