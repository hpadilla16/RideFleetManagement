/**
 * Ride Kiosk — Fase B2 upsell engine tests (2026-07-05).
 * Run: npm run test:kiosk  (node --test --test-force-exit)
 *
 * Canonical test:fees-style cases: Expedia offers CDW+SunPass, a Priceline
 * rule with prepaidServiceIds NEVER offers the prepaid service, unknown
 * channels fall back to the '*' rule, PER_DAY × days math is exact, accept
 * writes KIOSK_UPSELL ReservationCharge rows and recomputes totals through
 * the REAL reservationPricingService.getPricing path (prisma stubbed
 * in-memory, tolls sync no-op'd), re-POST is idempotent, and unknown/prepaid
 * ids + dangling package serviceIds are rejected.
 */

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '../../lib/prisma.js';
import { KioskError } from './kiosk-device.service.js';
import {
  kioskOffersService,
  normalizeChannel,
  serviceOfferLine,
  KIOSK_UPSELL_SOURCE,
} from './kiosk-offers.service.js';
import { tollsService, tollPackageCandidateServiceIds } from '../tolls/tolls.service.js';
import { evaluateTollBillingPolicy } from '../tolls/tolls-billing-policy.service.js';

// ---------------------------------------------------------------------------
// In-memory prisma stubs (same style as kiosk.test.mjs, plus createMany /
// deleteMany / upsert for the pricing-path tables).
// ---------------------------------------------------------------------------

let db;

function condMatch(rowVal, cond) {
  for (const [op, val] of Object.entries(cond)) {
    if (op === 'mode') continue;
    if (op === 'not') {
      if (val === null ? rowVal == null : rowVal === val) return false;
    } else if (op === 'in') {
      if (!val.includes(rowVal)) return false;
    } else if (op === 'startsWith') {
      if (!String(rowVal ?? '').startsWith(val)) return false;
    } else if (op === 'equals') {
      if (String(rowVal ?? '').toLowerCase() !== String(val ?? '').toLowerCase()) return false;
    } else if (op === 'gt' || op === 'gte' || op === 'lt' || op === 'lte') {
      if (rowVal == null) return false;
      if (op === 'gt' && !(rowVal > val)) return false;
      if (op === 'gte' && !(rowVal >= val)) return false;
      if (op === 'lt' && !(rowVal < val)) return false;
      if (op === 'lte' && !(rowVal <= val)) return false;
    } else if (op === 'is') {
      if (!matches(rowVal || {}, val)) return false;
    } else {
      if (!matches(rowVal || {}, { [op]: val })) return false;
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

function applyData(row, data) {
  for (const [key, val] of Object.entries(data || {})) {
    if (val && typeof val === 'object' && !(val instanceof Date) && !Array.isArray(val) && 'increment' in val) {
      row[key] = (row[key] || 0) + val.increment;
    } else {
      row[key] = val;
    }
  }
  return row;
}

function delegateStub(rows) {
  let seq = 0;
  return {
    findFirst: async ({ where } = {}) => rows().find((r) => matches(r, where)) || null,
    findUnique: async ({ where } = {}) => rows().find((r) => matches(r, where)) || null,
    findMany: async ({ where, take } = {}) => {
      const out = rows().filter((r) => matches(r, where));
      return typeof take === 'number' ? out.slice(0, take) : out;
    },
    create: async ({ data } = {}) => {
      const row = { id: `row_${++seq}`, ...data };
      rows().push(row);
      return row;
    },
    createMany: async ({ data } = {}) => {
      const list = Array.isArray(data) ? data : [data];
      list.forEach((entry) => rows().push({ id: `row_${++seq}`, selected: true, ...entry }));
      return { count: list.length };
    },
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
    deleteMany: async ({ where } = {}) => {
      const keep = rows().filter((r) => !matches(r, where));
      const count = rows().length - keep.length;
      rows().splice(0, rows().length, ...keep);
      return { count };
    },
    groupBy: async () => [],
  };
}

function installStubs() {
  db = {
    devices: [], sessions: [], reservations: [], services: [], rules: [],
    settings: [], reservationCharges: [], locations: [],
  };
  // recomputeTaxRow falls back to the pickup location's taxRate when the
  // pricingSnapshot has none — PR-style 11.5%.
  db.locations.push({ id: 'loc1', tenantId: 't1', taxRate: 11.5 });
  Object.assign(prisma.location, delegateStub(() => db.locations));
  Object.assign(prisma.kioskDevice, delegateStub(() => db.devices));
  Object.assign(prisma.kioskSession, delegateStub(() => db.sessions));
  Object.assign(prisma.reservation, delegateStub(() => db.reservations));
  Object.assign(prisma.additionalService, delegateStub(() => db.services));
  Object.assign(prisma.reservationCharge, delegateStub(() => db.reservationCharges));

  Object.assign(prisma.upsellRule, delegateStub(() => db.rules));
  prisma.upsellRule.upsert = async ({ where, create, update }) => {
    const { tenantId, channel } = where.tenantId_channel;
    const existing = db.rules.find((r) => r.tenantId === tenantId && r.channel === channel);
    if (existing) return applyData(existing, update);
    const row = { id: `rule_${db.rules.length + 1}`, ...create };
    db.rules.push(row);
    return row;
  };

  Object.assign(prisma.appSetting, delegateStub(() => db.settings));
  prisma.appSetting.upsert = async ({ where, create, update }) => {
    const existing = db.settings.find((r) => r.key === where.key);
    if (existing) return applyData(existing, update);
    const row = { ...create };
    db.settings.push(row);
    return row;
  };

  prisma.$transaction = async (fn) => fn(prisma);

  // The real getPricing also syncs toll charges — out of scope here.
  tollsService.syncReservationCharges = async () => 0;
}

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const DEVICE = { id: 'dev1', tenantId: 't1', locationId: 'loc1', name: 'Lobby 1', walkupEnabled: true };
const SCOPE = { tenantId: 't1' };

function seedSession(overrides = {}) {
  const session = {
    id: 'ks1', tenantId: 't1', deviceId: 'dev1', kind: 'PICKUP',
    reservationId: 'res1', checkoutSessionId: null, step: 'UPSELL',
    outcome: 'IN_PROGRESS', escalatedReason: null, eventsJson: [],
    lastActivityAt: new Date(), startedAt: new Date(), endedAt: null,
    ...overrides,
  };
  db.sessions.push(session);
  return session;
}

// 3 rental days exactly (pickup +2h, return +2h+3d).
function seedReservation(overrides = {}) {
  const base = Date.now() + 2 * HOUR;
  const resv = {
    id: 'res1',
    tenantId: 't1',
    bookingChannel: 'EXPEDIA',
    pickupLocationId: 'loc1',
    pickupAt: new Date(base),
    returnAt: new Date(base + 3 * DAY),
    dailyRate: 50,
    pickupLocation: { locationFees: [] },
    pricingSnapshot: null,
    payments: [],
    rentalAgreement: null,
    get charges() { return db.reservationCharges.filter((c) => c.reservationId === this.id); },
    ...overrides,
  };
  db.reservations.push(resv);
  return resv;
}

function seedCatalog() {
  db.services.push(
    // PER_DAY services (dailyRate > 0)
    { id: 'svc-cdw', tenantId: 't1', code: 'CDW', name: 'Collision Damage Waiver', dailyRate: 12.99, rate: 0, defaultQty: 1, taxable: true, isActive: true, locationId: null, sortOrder: 1 },
    { id: 'svc-sunpass', tenantId: 't1', code: 'SUNPASS', name: 'SunPass Toll Pass', dailyRate: 9.99, rate: 0, defaultQty: 1, taxable: false, coversTolls: true, isActive: true, locationId: null, sortOrder: 2 },
    // FIXED one-time service (no dailyRate)
    { id: 'svc-booster', tenantId: 't1', code: 'BOOSTER', name: 'Booster Seat', dailyRate: null, rate: 25, defaultQty: 1, taxable: false, isActive: true, locationId: null, sortOrder: 3 },
    // inactive — must never be offered or accepted
    { id: 'svc-dead', tenantId: 't1', code: 'DEAD', name: 'Retired Service', dailyRate: 5, rate: 0, defaultQty: 1, taxable: false, isActive: false, locationId: null, sortOrder: 4 },
    // other tenant — invisible
    { id: 'svc-foreign', tenantId: 't2', code: 'CDW', name: 'Foreign CDW', dailyRate: 1, rate: 0, defaultQty: 1, taxable: false, isActive: true, locationId: null, sortOrder: 5 },
    // has a linked fee — MUST be fail-closed excluded until B3/B4 support it
    { id: 'svc-linked', tenantId: 't1', code: 'GPS', name: 'GPS w/ Linked Fee', dailyRate: 4.99, rate: 0, defaultQty: 1, taxable: false, isActive: true, locationId: null, linkedFeeId: 'fee-1', sortOrder: 6 },
  );
}

function seedExpediaRule(overrides = {}) {
  db.rules.push({
    id: 'rule-expedia', tenantId: 't1', channel: 'EXPEDIA',
    prepaidServiceIds: [], offerServiceIds: ['svc-cdw', 'svc-sunpass', 'svc-booster'],
    strategy: 'PACKAGES_3', isActive: true, ...overrides,
  });
}

async function rejects(promise, { status, code } = {}) {
  try {
    await promise;
  } catch (err) {
    assert.ok(err instanceof KioskError, `expected KioskError, got ${err?.name}: ${err?.message}`);
    if (status) assert.equal(err.status, status);
    if (code) assert.equal(err.code, code);
    return err;
  }
  throw new Error('expected rejection, promise resolved');
}

beforeEach(() => {
  installStubs();
});

// ---------------------------------------------------------------------------
// Channel normalization
// ---------------------------------------------------------------------------

test('normalizeChannel: case/alias normalization ONLY — channels keep their identity', () => {
  assert.equal(normalizeChannel('EXPEDIA'), 'EXPEDIA');
  assert.equal(normalizeChannel('Expedia.com'), 'EXPEDIA');
  assert.equal(normalizeChannel('priceline'), 'PRICELINE');
  // identity preserved (B2 review): no collapsing into DIRECT — per-channel
  // rules stay possible; the '*' fallback covers rule-less channels.
  assert.equal(normalizeChannel('STAFF'), 'STAFF');
  assert.equal(normalizeChannel('WEBSITE'), 'WEBSITE');
  assert.equal(normalizeChannel('KIOSK_WALKUP'), 'KIOSK_WALKUP');
  assert.equal(normalizeChannel('SOME_OTA'), 'SOME_OTA');
  assert.equal(normalizeChannel(''), '*');
  assert.equal(normalizeChannel(null), '*');
});

// ---------------------------------------------------------------------------
// PER_DAY × days / FIXED math (mirrors booking-engine computeAdditionalServiceLine)
// ---------------------------------------------------------------------------

test('serviceOfferLine: PER_DAY 12.99 × 3 days = 38.97 exact; FIXED stays one-time', () => {
  const cdw = serviceOfferLine({ id: 's1', name: 'CDW', dailyRate: 12.99, rate: 0, defaultQty: 1 }, 3);
  assert.equal(cdw.pricingMode, 'PER_DAY');
  assert.equal(cdw.rate, 12.99);
  assert.equal(cdw.total, 38.97);

  const booster = serviceOfferLine({ id: 's2', name: 'Booster', dailyRate: null, rate: 25, defaultQty: 1 }, 3);
  assert.equal(booster.pricingMode, 'FIXED');
  assert.equal(booster.total, 25);

  // defaultQty multiplies like the counter/website path
  const twoBoosters = serviceOfferLine({ id: 's3', name: 'Boosters', dailyRate: null, rate: 25, defaultQty: 2 }, 3);
  assert.equal(twoBoosters.total, 50);
});

// ---------------------------------------------------------------------------
// computeOffers
// ---------------------------------------------------------------------------

test('Expedia channel: offers CDW + SunPass + Booster in rule order with server-side prices', async () => {
  seedSession();
  seedReservation();
  seedCatalog();
  seedExpediaRule();

  const offers = await kioskOffersService.computeOffers('ks1', DEVICE);

  assert.equal(offers.channel, 'EXPEDIA');
  assert.equal(offers.days, 3);
  assert.equal(offers.strategy, 'PACKAGES_3');
  assert.deepEqual(offers.addons.map((a) => a.serviceId), ['svc-cdw', 'svc-sunpass', 'svc-booster']);
  assert.deepEqual(offers.addons.map((a) => a.total), [38.97, 29.97, 25]);

  // telemetry: OFFERS_SHOWN appended server-side
  const events = db.sessions[0].eventsJson;
  assert.equal(events.at(-1).event, 'OFFERS_SHOWN');
  assert.equal(events.at(-1).step, 'UPSELL');
});

test('Priceline rule: prepaidServiceIds are NEVER offered — not as addons, not inside packages', async () => {
  seedSession();
  seedReservation({ bookingChannel: 'PRICELINE' });
  seedCatalog();
  db.rules.push({
    id: 'rule-priceline', tenantId: 't1', channel: 'PRICELINE',
    prepaidServiceIds: ['svc-cdw'], // broker already charged CDW
    offerServiceIds: ['svc-cdw', 'svc-sunpass'], // even though it's listed here
    strategy: 'PACKAGES_3', isActive: true,
  });
  db.settings.push({
    key: 'tenant:t1:kioskPackagesConfig',
    value: JSON.stringify([{ key: 'PREMIUM', name: 'Premium', serviceIds: ['svc-cdw', 'svc-sunpass', 'svc-booster'] }]),
  });

  const offers = await kioskOffersService.computeOffers('ks1', DEVICE);

  assert.deepEqual(offers.addons.map((a) => a.serviceId), ['svc-sunpass']);
  assert.equal(offers.packages.length, 1);
  assert.deepEqual(offers.packages[0].serviceIds, ['svc-sunpass', 'svc-booster']);
  assert.equal(offers.packages[0].total, 54.97); // 9.99×3 + 25
  assert.equal(offers.packages[0].perDay, 18.32);
});

test('unknown / walk-up channels fall back to the * rule', async () => {
  seedSession();
  seedReservation({ bookingChannel: 'KIOSK_WALKUP' });
  seedCatalog();
  db.rules.push({
    id: 'rule-default', tenantId: 't1', channel: '*',
    prepaidServiceIds: [], offerServiceIds: ['svc-booster'],
    strategy: 'UPGRADE_FIRST', isActive: true,
  });

  const offers = await kioskOffersService.computeOffers('ks1', DEVICE);
  assert.equal(offers.channel, 'KIOSK_WALKUP'); // identity kept; no rule → '*'
  assert.equal(offers.strategy, 'UPGRADE_FIRST');
  assert.deepEqual(offers.addons.map((a) => a.serviceId), ['svc-booster']);
});

test('per-reservation prepaid hook: a selected non-kiosk charge for the same service excludes it', async () => {
  seedSession();
  seedReservation();
  seedCatalog();
  seedExpediaRule();
  db.reservationCharges.push({
    id: 'rc-broker', reservationId: 'res1', name: 'SunPass (broker)', chargeType: 'DAILY',
    quantity: 3, rate: 9.99, total: 29.97, taxable: false, selected: true,
    source: 'BROKER_IMPORT', sourceRefId: 'svc-sunpass',
  });

  const offers = await kioskOffersService.computeOffers('ks1', DEVICE);
  assert.deepEqual(offers.addons.map((a) => a.serviceId), ['svc-cdw', 'svc-booster']);
});

// ---------------------------------------------------------------------------
// acceptOffers — real pricing path
// ---------------------------------------------------------------------------

test('accept writes KIOSK_UPSELL charges and totals flow through the real getPricing path', async () => {
  seedSession();
  const resv = seedReservation();
  seedCatalog();
  seedExpediaRule();

  const result = await kioskOffersService.acceptOffers('ks1', DEVICE, {
    acceptedServiceIds: ['svc-cdw', 'svc-booster'],
  });

  const rows = db.reservationCharges.filter((c) => c.source === KIOSK_UPSELL_SOURCE);
  assert.equal(rows.length, 2);

  const cdw = rows.find((c) => c.sourceRefId === 'svc-cdw');
  assert.equal(cdw.chargeType, 'DAILY');
  assert.equal(cdw.quantity, 3); // quantity = days
  assert.equal(cdw.rate, 12.99);
  assert.equal(cdw.total, 38.97);
  assert.equal(cdw.taxable, true);
  assert.equal(cdw.selected, true);

  const booster = rows.find((c) => c.sourceRefId === 'svc-booster');
  assert.equal(booster.chargeType, 'UNIT');
  assert.equal(booster.total, 25);

  // TAX (B2 review): recomputeTaxRow ran — 11.5% (pickup location) on the
  // 38.97 taxable CDW portion only = 4.48; booster (non-taxable) untouched.
  const taxRows = db.reservationCharges.filter((c) => c.chargeType === 'TAX');
  assert.equal(taxRows.length, 1);
  assert.equal(taxRows[0].source, 'TAX_RECALC');
  assert.equal(taxRows[0].total, 4.48); // round2(38.97 × 0.115)
  assert.equal(taxRows[0].name, 'Sales Tax (11.50%)');

  // totals came from reservationPricingService.getPricing (no kiosk math):
  // subtotal 63.97 + taxes 4.48 = 68.45
  assert.equal(result.totals.subtotal, 63.97);
  assert.equal(result.totals.taxes, 4.48);
  assert.equal(result.totals.total, 68.45);
  // ...and the counter path also refreshed reservation.estimatedTotal
  assert.equal(resv.estimatedTotal, 68.45);

  const events = db.sessions[0].eventsJson;
  assert.equal(events.at(-1).event, 'OFFERS_ACCEPTED');
  assert.deepEqual(events.at(-1).data.serviceIds, ['svc-cdw', 'svc-booster']);
});

test('re-POST is idempotent: replaces prior KIOSK_UPSELL selection, never duplicates', async () => {
  seedSession();
  const resv = seedReservation();
  seedCatalog();
  seedExpediaRule();

  // first selection is taxable CDW → a TAX row appears
  await kioskOffersService.acceptOffers('ks1', DEVICE, { acceptedServiceIds: ['svc-cdw'] });
  assert.equal(db.reservationCharges.filter((c) => c.chargeType === 'TAX').length, 1);

  // swap to non-taxable SunPass → prior selection AND its tax row are replaced
  await kioskOffersService.acceptOffers('ks1', DEVICE, { acceptedServiceIds: ['svc-sunpass'] });

  const rows = db.reservationCharges.filter((c) => c.source === KIOSK_UPSELL_SOURCE);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].sourceRefId, 'svc-sunpass');
  assert.equal(db.reservationCharges.filter((c) => c.chargeType === 'TAX').length, 0, 'stale tax row cleaned up');
  assert.equal(resv.estimatedTotal, 29.97);

  // declining everything clears the selection and records OFFERS_DECLINED
  const declined = await kioskOffersService.acceptOffers('ks1', DEVICE, { acceptedServiceIds: [] });
  assert.equal(db.reservationCharges.filter((c) => c.source === KIOSK_UPSELL_SOURCE).length, 0);
  assert.equal(declined.totals.total, 0);
  assert.equal(db.sessions[0].eventsJson.at(-1).event, 'OFFERS_DECLINED');
});

test('accept rejects unknown, inactive and prepaid service ids with 422', async () => {
  seedSession();
  seedReservation({ bookingChannel: 'PRICELINE' });
  seedCatalog();
  db.rules.push({
    id: 'rule-priceline', tenantId: 't1', channel: 'PRICELINE',
    prepaidServiceIds: ['svc-cdw'], offerServiceIds: ['svc-cdw', 'svc-sunpass'],
    strategy: 'PACKAGES_3', isActive: true,
  });

  // unknown id
  await rejects(
    kioskOffersService.acceptOffers('ks1', DEVICE, { acceptedServiceIds: ['svc-nope'] }),
    { status: 422, code: 'SERVICE_NOT_OFFERABLE' },
  );
  // inactive id
  await rejects(
    kioskOffersService.acceptOffers('ks1', DEVICE, { acceptedServiceIds: ['svc-dead'] }),
    { status: 422, code: 'SERVICE_NOT_OFFERABLE' },
  );
  // PREPAID id — the broker already charged it
  await rejects(
    kioskOffersService.acceptOffers('ks1', DEVICE, { acceptedServiceIds: ['svc-cdw'] }),
    { status: 422, code: 'SERVICE_NOT_OFFERABLE' },
  );
  assert.equal(db.reservationCharges.length, 0, 'nothing was written');
});

test('linked-fee services are fail-closed excluded from offers/packages; accepting one → 422', async () => {
  seedSession();
  seedReservation();
  seedCatalog(); // includes svc-linked (linkedFeeId: 'fee-1')
  seedExpediaRule({ offerServiceIds: ['svc-cdw', 'svc-linked'] });
  db.settings.push({
    key: 'tenant:t1:kioskPackagesConfig',
    value: JSON.stringify([{ key: 'BASIC', name: 'Básico', serviceIds: ['svc-linked', 'svc-booster'] }]),
  });

  const offers = await kioskOffersService.computeOffers('ks1', DEVICE);
  // the website auto-adds SERVICE_LINKED_FEE for these; the kiosk doesn't
  // yet, so offering them would undercharge — never shown anywhere.
  assert.deepEqual(offers.addons.map((a) => a.serviceId), ['svc-cdw']);
  assert.deepEqual(offers.packages[0].serviceIds, ['svc-booster']);

  await rejects(
    kioskOffersService.acceptOffers('ks1', DEVICE, { acceptedServiceIds: ['svc-linked'] }),
    { status: 422, code: 'SERVICE_NOT_OFFERABLE' },
  );
  assert.equal(db.reservationCharges.length, 0);
});

test('kiosk-sold coversTolls package counts as toll coverage (no per-toll double-billing)', async () => {
  seedSession();
  seedReservation();
  seedCatalog(); // svc-sunpass has coversTolls: true
  seedExpediaRule();

  await kioskOffersService.acceptOffers('ks1', DEVICE, { acceptedServiceIds: ['svc-sunpass'] });

  // tolls.service's candidate filter (used by syncReservationTollCharges)
  // must see the KIOSK_UPSELL row exactly like a counter-sold service...
  const candidateIds = tollPackageCandidateServiceIds(db.reservationCharges);
  assert.deepEqual(candidateIds, ['svc-sunpass']);

  // ...legacy sources still count, junk/unselected never do
  assert.deepEqual(
    tollPackageCandidateServiceIds([
      { selected: true, source: 'ADDITIONAL_SERVICE', sourceRefId: 'a' },
      { selected: true, source: 'SERVICE', sourceRefId: 'b' },
      { selected: true, source: 'KIOSK_UPSELL', sourceRefId: 'c' },
      { selected: false, source: 'KIOSK_UPSELL', sourceRefId: 'd' }, // voided
      { selected: true, source: 'MANDATORY_FEE', sourceRefId: 'e' },
      { selected: true, source: 'KIOSK_UPSELL', sourceRefId: null },
    ]),
    ['a', 'b', 'c'],
  );

  // and the billing policy declares the reservation COVERED (usage-only)
  const prepaidTollServiceCount = db.services.filter(
    (s) => s.tenantId === 't1' && s.isActive && s.coversTolls && candidateIds.includes(s.id),
  ).length;
  assert.equal(prepaidTollServiceCount, 1);
  const decision = evaluateTollBillingPolicy({ prepaidTollServiceCount, transactions: [{}, {}] });
  assert.equal(decision.coveredByTollPackage, true);
  assert.equal(decision.shouldCreateChargeRows, false);
  assert.equal(decision.usageOnlyCount, 2);
});

test('offers/accept without a reservation attached → 422 NO_RESERVATION_ATTACHED', async () => {
  seedSession({ reservationId: null });
  seedCatalog();

  await rejects(
    kioskOffersService.computeOffers('ks1', DEVICE),
    { status: 422, code: 'NO_RESERVATION_ATTACHED' },
  );
  await rejects(
    kioskOffersService.acceptOffers('ks1', DEVICE, { acceptedServiceIds: [] }),
    { status: 422, code: 'NO_RESERVATION_ATTACHED' },
  );
});

test('offers endpoints enforce the session-device binding (device B → 404)', async () => {
  seedSession();
  seedReservation();
  seedCatalog();
  seedExpediaRule();
  const deviceB = { ...DEVICE, id: 'dev2' };
  await rejects(kioskOffersService.computeOffers('ks1', deviceB), { status: 404, code: 'SESSION_NOT_FOUND' });
  await rejects(
    kioskOffersService.acceptOffers('ks1', deviceB, { acceptedServiceIds: [] }),
    { status: 404, code: 'SESSION_NOT_FOUND' },
  );
});

// ---------------------------------------------------------------------------
// Admin: packages config + upsell rules validation
// ---------------------------------------------------------------------------

test('updatePackagesConfig: validates keys and serviceIds against the ACTIVE catalog', async () => {
  seedCatalog();

  // dangling id → 422
  await rejects(
    kioskOffersService.updatePackagesConfig({
      packages: [{ key: 'BASIC', name: 'Básico', serviceIds: ['svc-cdw', 'svc-ghost'] }],
    }, SCOPE),
    { status: 422, code: 'UNKNOWN_SERVICE_IDS' },
  );
  // inactive id → 422
  await rejects(
    kioskOffersService.updatePackagesConfig({
      packages: [{ key: 'BASIC', name: 'Básico', serviceIds: ['svc-dead'] }],
    }, SCOPE),
    { status: 422, code: 'UNKNOWN_SERVICE_IDS' },
  );
  // other tenant's id → 422
  await rejects(
    kioskOffersService.updatePackagesConfig({
      packages: [{ key: 'BASIC', name: 'Básico', serviceIds: ['svc-foreign'] }],
    }, SCOPE),
    { status: 422, code: 'UNKNOWN_SERVICE_IDS' },
  );
  // bad key → 400
  await rejects(
    kioskOffersService.updatePackagesConfig({
      packages: [{ key: 'MEGA', name: 'Mega', serviceIds: ['svc-cdw'] }],
    }, SCOPE),
    { status: 400 },
  );

  // valid save persists and round-trips
  const saved = await kioskOffersService.updatePackagesConfig({
    packages: [
      { key: 'BASIC', name: 'Básico', serviceIds: ['svc-sunpass'] },
      { key: 'PREMIUM', name: 'Premium', serviceIds: ['svc-cdw', 'svc-sunpass'] },
    ],
  }, SCOPE);
  assert.equal(saved.packages.length, 2);
  const readBack = await kioskOffersService.getPackagesConfig(SCOPE);
  assert.deepEqual(readBack.packages.map((p) => p.key), ['BASIC', 'PREMIUM']);

  // and computeOffers prices the saved packages server-side
  seedSession();
  seedReservation();
  seedExpediaRule();
  const offers = await kioskOffersService.computeOffers('ks1', DEVICE);
  const premium = offers.packages.find((p) => p.key === 'PREMIUM');
  assert.equal(premium.total, 68.94); // (12.99 + 9.99) × 3
  assert.equal(premium.perDay, 22.98);
});

test('upsertUpsellRule: validates strategy + serviceIds, upserts per (tenant, channel)', async () => {
  seedCatalog();

  await rejects(
    kioskOffersService.upsertUpsellRule({ channel: 'EXPEDIA', strategy: 'YOLO' }, SCOPE),
    { status: 400 },
  );
  await rejects(
    kioskOffersService.upsertUpsellRule({ channel: 'EXPEDIA', offerServiceIds: ['svc-ghost'] }, SCOPE),
    { status: 422, code: 'UNKNOWN_SERVICE_IDS' },
  );
  await rejects(kioskOffersService.upsertUpsellRule({}, SCOPE), { status: 400 });

  const created = await kioskOffersService.upsertUpsellRule({
    channel: 'expedia',
    prepaidServiceIds: ['svc-cdw'],
    offerServiceIds: ['svc-sunpass', 'svc-booster'],
    strategy: 'PACKAGES_3',
  }, SCOPE);
  assert.equal(created.channel, 'EXPEDIA');
  assert.deepEqual(created.prepaidServiceIds, ['svc-cdw']);

  // upsert (same channel) updates in place — no duplicate rows
  await kioskOffersService.upsertUpsellRule({
    channel: 'EXPEDIA', offerServiceIds: ['svc-booster'], strategy: 'UPGRADE_FIRST',
  }, SCOPE);
  assert.equal(db.rules.filter((r) => r.channel === 'EXPEDIA').length, 1);
  assert.equal(db.rules[0].strategy, 'UPGRADE_FIRST');

  const listed = await kioskOffersService.listUpsellRules(SCOPE);
  assert.equal(listed.length, 1);
});
