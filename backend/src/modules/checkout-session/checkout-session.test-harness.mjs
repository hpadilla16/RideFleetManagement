/**
 * DB-free world for the checkout-session transition tests (in-memory prisma
 * stubs, dummy DATABASE_URL convention from beta-ci.yml).
 *
 * Extracted from checkout-cas-transition.test.mjs on 2026-08-17, when the
 * finalize-truth suite needed the same fixtures. Nothing here is new — it is
 * that file's harness, moved verbatim so two suites cannot drift into two
 * subtly different fake databases and disagree about what the service does.
 *
 * Usage:
 *
 *   let db;
 *   beforeEach(() => { db = installWorld(); });
 *   afterEach(restoreWorld);
 *
 * `installWorld()` returns the world object, so callers keep writing `db.…`
 * exactly as they did when it was a local.
 */
import { prisma } from '../../lib/prisma.js';
import { checkoutSessionService } from './checkout-session.service.js';

let db = null;
let restore = [];

function applyData(row, data) {
  for (const [key, val] of Object.entries(data || {})) {
    if (val && typeof val === 'object' && !(val instanceof Date) && 'increment' in val) {
      row[key] = (row[key] || 0) + val.increment;
    } else {
      row[key] = val;
    }
  }
  return row;
}

// Operator support is NOT optional here (kiosk-checkout.test.mjs shape). The
// CLOSED cascade runs ensureNoVehicleConflict, whose where clauses are built
// out of `not` / `in` / date ranges. A matcher that waves operator objects
// through as `true` makes the reservation conflict with ITSELF and the
// cascade dies on a VEHICLE_CONFLICT that no real database would produce.
function condMatch(rowVal, cond) {
  for (const [op, val] of Object.entries(cond)) {
    if (op === 'mode') continue;
    if (op === 'not') {
      if (val === null ? rowVal == null : rowVal === val) return false;
    } else if (op === 'in') {
      if (!val.includes(rowVal)) return false;
    } else if (op === 'notIn') {
      if (val.includes(rowVal)) return false;
    } else if (op === 'gt' || op === 'gte' || op === 'lt' || op === 'lte') {
      if (rowVal == null) return false;
      if (op === 'gt' && !(rowVal > val)) return false;
      if (op === 'gte' && !(rowVal >= val)) return false;
      if (op === 'lt' && !(rowVal < val)) return false;
      if (op === 'lte' && !(rowVal <= val)) return false;
    } else if (op === 'equals') {
      if (rowVal !== val) return false;
    }
  }
  return true;
}

function matches(row, where) {
  return Object.entries(where || {}).every(([key, val]) => {
    if (val === undefined) return true;
    if (key === 'OR') return val.some((clause) => matches(row, clause));
    if (key === 'AND') return val.every((clause) => matches(row, clause));
    if (key === 'NOT') return !matches(row, val);
    if (val === null) return row[key] == null;
    if (val instanceof Date || typeof val !== 'object') return row[key] === val;
    return condMatch(row[key], val);
  });
}

let seq = 0;

function stub(rows) {
  return {
    // `create` matters more than it looks: the cascade's auditLog and mileage
    // writes are wrapped in .catch(() => {}), so a stub missing this method
    // fails SILENTLY and the "exactly one audit line" assertions would pass
    // against zero of them.
    create: async ({ data } = {}) => {
      const row = { id: `row_${++seq}`, ...data };
      rows().push(row);
      return row;
    },
    count: async ({ where } = {}) => rows().filter((r) => matches(r, where)).length,
    findFirst: async ({ where } = {}) => rows().find((r) => matches(r, where)) || null,
    findUnique: async ({ where } = {}) => rows().find((r) => matches(r, where)) || null,
    findMany: async ({ where } = {}) => rows().filter((r) => matches(r, where)),
    update: async ({ where, data } = {}) => {
      const row = rows().find((r) => matches(r, where));
      if (!row) throw new Error('stub update: no match');
      return applyData(row, data);
    },
    updateMany: async ({ where, data } = {}) => {
      const hits = rows().filter((r) => matches(r, where));
      hits.forEach((r) => applyData(r, data));
      return { count: hits.length };
    },
  };
}

/** Fresh world + prisma stubs. Call from beforeEach; returns the world. */
export function installWorld() {
  db = {
    checkoutSessions: [], agreements: [], reservations: [], vehicles: [],
    inspections: [], loanerAgreements: [], auditLogs: [], mileageEntries: [],
  };
  Object.assign(prisma.checkoutSession, stub(() => db.checkoutSessions));
  Object.assign(prisma.rentalAgreement, stub(() => db.agreements));
  Object.assign(prisma.reservation, stub(() => db.reservations));
  // Only the CLOSED-cascade tests reach these; the rest never touch them.
  Object.assign(prisma.vehicle, stub(() => db.vehicles));
  Object.assign(prisma.rentalAgreementInspection, stub(() => db.inspections));
  Object.assign(prisma.loanerAgreement, stub(() => db.loanerAgreements));
  Object.assign(prisma.auditLog, stub(() => db.auditLogs));
  Object.assign(prisma.vehicleMileageEntry, stub(() => db.mileageEntries));
  prisma.$transaction = async (arg) => (Array.isArray(arg) ? Promise.all(arg) : arg(prisma));
  restore = [];
  return db;
}

/** Undo every monkeypatch a test registered. Call from afterEach. */
export function restoreWorld() {
  restore.forEach((fn) => fn());
  restore = [];
}

/** Register an undo for a monkeypatch, so tests can patch without leaking. */
export function onRestore(fn) {
  restore.push(fn);
}

export function seedSession(overrides = {}) {
  const row = {
    id: 'cs1', reservationId: 'res1', agreementId: null, tenantId: 't1',
    currentStep: 'CONFIRMING', events: '[]', stateVersion: 0,
    tcCompletedAt: null, paymentCompletedAt: null, inspectionCompletedAt: null,
    customerSignedAt: null, finishedAt: null, autoEmailedAt: null,
    ...overrides,
  };
  db.checkoutSessions.push(row);
  return row;
}

/**
 * Seeds a session one hop from CLOSED plus the world its finalize cascade
 * touches.
 *
 * `autoEmailedAt` used to default to a stamped date, which QA correctly called
 * out: maybeSendFinalizeEmail returns at its first line when it is set, so the
 * whole email arm was invisible to every test here — including the one titled
 * "ZERO writes to the world", which therefore asserted less than its name
 * claimed. Default is now null, so the arm is LIVE.
 *
 * Tests that drive a legitimate WINNER finalize used to pass a stamp
 * explicitly to stay out of the way of a real defect: past the autoEmailedAt
 * CAS the code reached `scheduleEmailDelivery(...)` with no await and no
 * .catch, so its rejection ("Customer email is required" for a customer-less
 * fixture) was an unhandled rejection that killed the whole test process. That
 * defect is fixed (checkout-finalize-truth.test.mjs pins it), so the stamp is
 * now an ordinary fixture choice rather than a workaround — but the existing
 * CAS tests keep passing it, because what they assert is about the cascade and
 * a live email arm would only add noise.
 */
export function seedFinalizeWorld({ reservationStatus = 'CONFIRMED', autoEmailedAt = null } = {}) {
  const row = seedSession({
    currentStep: 'FINALIZING', customerSignedAt: new Date(),
    agreementId: 'ra1', autoEmailedAt,
  });
  db.agreements.push({
    id: 'ra1', reservationId: 'res1', status: 'DRAFT',
    odometerOut: null, fuelOut: null, agreementNumber: 'AG-1',
  });
  db.reservations.push({
    id: 'res1', tenantId: 't1', status: reservationStatus, vehicleId: 'veh1',
    reservationNumber: 'R-1',
    pickupAt: new Date('2026-08-17T10:00:00Z'), returnAt: new Date('2026-08-20T10:00:00Z'),
    customerInfoCompletedAt: new Date(), customer: null, pickupLocation: null,
  });
  db.vehicles.push({ id: 'veh1', status: 'AVAILABLE', mileage: 1000 });
  // A real finalize has a CHECKOUT inspection to copy odometer/fuel from —
  // without it `checkoutOdometer` is null and the cascade legitimately writes
  // no mileage entry, which would make the "exactly one" assertions vacuous.
  db.inspections.push({
    id: 'insp1', rentalAgreementId: 'ra1', phase: 'CHECKOUT',
    odometer: 45000, fuelLevel: 'HALF',
  });
  return row;
}

/**
 * The race, made deterministic. The next read of a row sitting on
 * `triggerStep` returns the SNAPSHOT that read would have seen — and `foreign`
 * (the other surface) commits in between. That is exactly the read-then-write
 * window: our caller now holds a row the database has already moved past.
 */
export function armRace(triggerStep, foreign) {
  const orig = prisma.checkoutSession.findUnique;
  let fired = false;
  prisma.checkoutSession.findUnique = async (args) => {
    const row = await orig(args);
    if (!fired && row && row.currentStep === triggerStep) {
      fired = true;
      const snapshot = { ...row }; // detached, like a real read
      await foreign();
      return snapshot;
    }
    return row;
  };
  restore.push(() => { prisma.checkoutSession.findUnique = orig; });
  return () => fired;
}

/**
 * armRace's sibling for the reservation row. The finalize cascade reads the
 * reservation, runs its guards against that snapshot and only then writes, so
 * the window the CLAIM closes is on THIS row rather than on the session. The
 * next read of a reservation sitting on `triggerStatus` returns the snapshot
 * that read would have seen, and `foreign` commits in between.
 *
 * Only the FIRST matching read fires: the cascade reads the reservation twice
 * (once for the ownership/status guards, once for the double-booking re-check)
 * and it is the first one the claim is compared against.
 */
export function armReservationRace(triggerStatus, foreign) {
  const orig = prisma.reservation.findUnique;
  let fired = false;
  prisma.reservation.findUnique = async (args) => {
    const row = await orig(args);
    if (!fired && row && row.status === triggerStatus) {
      fired = true;
      const snapshot = { ...row }; // detached, like a real read
      await foreign();
      return snapshot;
    }
    return row;
  };
  restore.push(() => { prisma.reservation.findUnique = orig; });
  return () => fired;
}

/**
 * armReservationRace's sibling for the AGREEMENT row, added 2026-08-18 with
 * the guard on the FINALIZED flip.
 *
 * The other two races are not substitutes for it. The repair path — a
 * reservation that reached CHECKED_OUT with its contract still DRAFT — has no
 * reservation claim to lose, because the row it would claim is already
 * CHECKED_OUT. Race it on the session or the reservation and the second caller
 * simply re-reads an agreement the first has already finalized and declines
 * before reaching the flip, which pins nothing about the flip. Firing on THIS
 * row is what puts two callers on the write itself: ours is left holding a
 * DRAFT snapshot the database has already moved past.
 *
 * Only the FIRST matching read fires — the repair reads the agreement twice
 * (the branch's own status check, then the metrics read inside the finalize
 * helper) and it is the first one the flip is compared against.
 */
export function armAgreementRace(triggerStatus, foreign) {
  const orig = prisma.rentalAgreement.findUnique;
  let fired = false;
  prisma.rentalAgreement.findUnique = async (args) => {
    const row = await orig(args);
    if (!fired && row && row.status === triggerStatus) {
      fired = true;
      const snapshot = { ...row }; // detached, like a real read
      await foreign();
      return snapshot;
    }
    return row;
  };
  restore.push(() => { prisma.rentalAgreement.findUnique = orig; });
  return () => fired;
}

/**
 * The half-finished finalize this ticket exists to repair, as a fixture:
 * a session that committed CLOSED, a reservation that reached CHECKED_OUT, and
 * a contract still sitting in DRAFT behind it.
 *
 * Seeded rather than driven, so the email arm is LIVE (autoEmailedAt null)
 * without a winner call having fired a real send first. The reachability of
 * this state from a real broken finalize is proved separately, by driving one.
 */
export function seedStrandedStrand() {
  const row = seedFinalizeWorld({ reservationStatus: 'CHECKED_OUT' });
  row.currentStep = 'CLOSED';
  row.finishedAt = new Date('2026-08-17T12:00:00Z');
  return row;
}

// ── the REAL payloads, not invented ones ───────────────────────────────────
//
// frontend/src/lib/checkout-session.js#transition puts exactly
// `JSON.stringify({ toStep, metadata })` on the wire, and
// checkout-session.routes.js:97 destructures `{ toStep, metadata,
// expectedVersion }` out of it. With metadata omitted, JSON.stringify DROPS
// the key, so the service is called with metadata AND expectedVersion
// undefined. Round-tripping through JSON here is the point: a hand-written
// `{ expectedVersion: undefined }` would be the payload we imagined.

export function viaWebWizard({ id, toStep, metadata, actorUserId = 'agent-1' }) {
  const body = JSON.parse(JSON.stringify({ toStep, metadata }));
  const { toStep: t, metadata: m, expectedVersion } = body || {};
  return checkoutSessionService.transition({ id, toStep: t, actorUserId, metadata: m, expectedVersion });
}

// kiosk-checkout.service.js:841 — no expectedVersion key at all, actorUserId null.
export function viaKiosk({ id, toStep }) {
  return checkoutSessionService.transition({
    id, toStep, actorUserId: null,
    metadata: { kiosk: true, kioskSessionId: 'ks1', deviceId: 'dev1' },
  });
}
