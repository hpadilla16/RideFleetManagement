// Quotes module tests (2026-07-17) — service against injected fakes (no postgres),
// same spirit as maintenance.service.test.mjs. Run: npm run test:quotes
// (--test-force-exit: importing the service pulls the prisma singleton).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createQuotesService, conversionReservationNumber } from './quotes.service.js';
import { isQuoteNumber, normalizeQuoteNumber, quoteNumberCandidate } from './quote-number.js';

const NOW = new Date('2026-07-17T12:00:00Z');
const SCOPE = { tenantId: 't1' };

// ── engine fixture: what bookingEngineService.searchRental returns ──
function engineRow({ id = 'vt-suv', code = 'SUV', name = 'SUV', available = true, units = 3, total = 265.88 } = {}) {
  return {
    vehicleType: { id, code, name },
    availability: { availableUnits: units, available },
    quote: {
      days: 5, dailyRate: 45, subtotal: 225, fees: 15, taxes: 25.88, total,
      source: 'GLOBAL', revenuePricingApplied: true
    }
  };
}

function fakeEngine(rows) {
  const calls = [];
  return {
    calls,
    async searchRental(input) {
      calls.push(input);
      return { results: rows };
    }
  };
}

function fakeDb({ quotes = [], customers = [], failCreateTimes = 0 } = {}) {
  let failLeft = failCreateTimes;
  let seq = 0;
  const db = {
    quotes,
    customers,
    quote: {
      async count({ where }) {
        return quotes.filter((q) => q.tenantId === where.tenantId).length;
      },
      async create({ data }) {
        if (failLeft > 0) {
          failLeft -= 1;
          const e = new Error('unique violation');
          e.code = 'P2002';
          throw e;
        }
        const row = { id: `q${(seq += 1)}`, status: 'ACTIVE', ...data };
        quotes.push(row);
        return row;
      },
      async findFirst({ where }) {
        return quotes.find((q) =>
          (!where.tenantId || q.tenantId === where.tenantId) &&
          (!where.id || q.id === where.id) &&
          (!where.quoteNumber || q.quoteNumber === where.quoteNumber)
        ) || null;
      },
      async findMany({ where, take }) {
        return quotes
          .filter((q) =>
            (!where.tenantId || q.tenantId === where.tenantId) &&
            (!where.customerId || q.customerId === where.customerId) &&
            (!where.status || q.status === where.status))
          .slice(0, take);
      },
      async update({ where, data }) {
        const row = quotes.find((q) => q.id === where.id);
        Object.assign(row, data);
        return row;
      },
      async updateMany({ where, data }) {
        for (const q of quotes) {
          if (where.id.in.includes(q.id) && q.status === where.status) Object.assign(q, data);
        }
        return { count: where.id.in.length };
      }
    },
    vehicleType: {
      async findMany({ where }) {
        const all = [
          { id: 'vt-suv', code: 'SUV', name: 'SUV' },
          { id: 'vt-eco', code: 'ECO', name: 'Economy' }
        ];
        return all.filter((t) => where.id.in.includes(t.id));
      }
    },
    reservation: {
      async findFirst({ where }) {
        return (db.reservations || []).find((r) => r.sourceRef === where.sourceRef) || null;
      }
    },
    customer: {
      async findFirst({ where }) {
        return customers.find((c) =>
          c.tenantId === where.tenantId &&
          ((where.id && c.id === where.id) ||
           (where.email && c.email === where.email) ||
           (where.phone && c.phone === where.phone))
        ) || null;
      },
      async create({ data }) {
        const row = { id: `cus${customers.length + 1}`, ...data };
        customers.push(row);
        return row;
      }
    }
  };
  return db;
}

function fakeReservations() {
  const created = [];
  return {
    created,
    async create(data, scope) {
      const row = { id: `res${created.length + 1}`, ...data, tenantId: scope.tenantId };
      created.push(row);
      return row;
    }
  };
}

function makeService({ rows = [engineRow()], db = fakeDb(), reservations = fakeReservations(), now = () => NOW } = {}) {
  const engine = fakeEngine(rows);
  const svc = createQuotesService({ prisma: db, bookingEngine: engine, reservations, now, randHex: () => 'ab12', resolveTz: async () => 'UTC' });
  return { svc, engine, db, reservations };
}

// ── quote-number helpers ──

test('isQuoteNumber / normalizeQuoteNumber / candidate', () => {
  assert.equal(isQuoteNumber('Q-1042'), true);
  assert.equal(isQuoteNumber('q-7'), true);
  assert.equal(isQuoteNumber('RES-123'), false);
  assert.equal(isQuoteNumber('cmck0001xyz'), false);
  assert.equal(normalizeQuoteNumber(' q-1042 '), 'Q-1042');
  assert.equal(quoteNumberCandidate(0), 'Q-1001');
  assert.equal(quoteNumberCandidate(41), 'Q-1042');
  assert.equal(quoteNumberCandidate(41, 2), 'Q-1044');
});

test('conversionReservationNumber mirrors the WEB- format with RES prefix', () => {
  const n = conversionReservationNumber(1752750000123, 'ab12');
  assert.match(n, /^RES-\d{8}AB12$/);
});

// ── preview ──

test('preview maps engine rows (price + availability) and filters by class', async () => {
  const { svc, engine } = makeService({
    rows: [engineRow(), engineRow({ id: 'vt-eco', code: 'ECO', name: 'Economy', available: false, units: 0 })]
  });
  const all = await svc.preview(
    { pickupLocationId: 'loc1', pickupAt: '2026-08-01T10:00:00Z', returnAt: '2026-08-06T10:00:00Z' },
    SCOPE
  );
  assert.equal(all.results.length, 2);
  assert.equal(all.results[0].total, 265.88);
  assert.equal(all.results[0].revenuePricingApplied, true);
  assert.equal(all.results[1].available, false);
  assert.equal(engine.calls[0].tenantId, 't1');

  const one = await svc.preview(
    { pickupLocationId: 'loc1', vehicleTypeId: 'vt-eco', pickupAt: '2026-08-01T10:00:00Z', returnAt: '2026-08-06T10:00:00Z' },
    SCOPE
  );
  assert.equal(one.results.length, 1);
  assert.equal(one.results[0].vehicleTypeId, 'vt-eco');
});

test('preview passes the engine insurance plans through (VozIA upsell source)', async () => {
  const rowWithPlans = {
    ...engineRow(),
    insurancePlans: [
      { code: 'CDW', name: 'Collision Protection', chargeBy: 'PER_DAY', amount: 29.99, total: 149.95 }
    ]
  };
  const { svc } = makeService({ rows: [rowWithPlans] });
  const out = await svc.preview(
    { pickupLocationId: 'loc1', pickupAt: '2026-08-01T10:00:00Z', returnAt: '2026-08-06T10:00:00Z' },
    SCOPE
  );
  assert.equal(out.results[0].insurancePlans.length, 1);
  assert.equal(out.results[0].insurancePlans[0].name, 'Collision Protection');
  assert.equal(out.results[0].insurancePlans[0].total, 149.95);
});

test('preview defaults insurancePlans to [] when the engine row carries none', async () => {
  const { svc } = makeService({ rows: [engineRow()] });
  const out = await svc.preview(
    { pickupLocationId: 'loc1', pickupAt: '2026-08-01T10:00:00Z', returnAt: '2026-08-06T10:00:00Z' },
    SCOPE
  );
  assert.deepEqual(out.results[0].insurancePlans, []);
});

test('preview requires tenant scope + required params', async () => {
  const { svc } = makeService();
  await assert.rejects(
    svc.preview({ pickupLocationId: 'loc1', pickupAt: 'x', returnAt: 'y' }, {}),
    /Tenant scope/
  );
  await assert.rejects(svc.preview({ pickupAt: 'x', returnAt: 'y' }, SCOPE), /pickupLocationId/);
});

// ── create ──

test('create snapshots the engine price and allocates Q-1001', async () => {
  const { svc } = makeService();
  const q = await svc.create(
    {
      vehicleTypeId: 'vt-suv', pickupLocationId: 'loc1',
      pickupAt: '2026-08-01T10:00:00Z', returnAt: '2026-08-06T10:00:00Z',
      contactName: 'Maria Hernandez', contactPhone: '(787) 555-1234',
      source: 'VOZIA', author: 'USR-2 Hector (via VozIA)', ticketId: 'TKT-9'
    },
    SCOPE
  );
  assert.equal(q.quoteNumber, 'Q-1001');
  assert.equal(q.total, 265.88);
  assert.equal(q.dailyRate, 45);
  assert.equal(q.source, 'VOZIA');
  assert.equal(q.status, 'ACTIVE');
  // TTL default 72h
  assert.equal(q.expiresAt.getTime() - NOW.getTime(), 72 * 3600 * 1000);
  assert.ok(JSON.parse(q.engineSnapshotJson).total === 265.88);
});

test('create rejects a sold-out class (a quote never fakes availability)', async () => {
  const { svc } = makeService({ rows: [engineRow({ available: false, units: 0 })] });
  await assert.rejects(
    svc.create(
      { vehicleTypeId: 'vt-suv', pickupLocationId: 'loc1', pickupAt: '2026-08-01T10:00:00Z', returnAt: '2026-08-06T10:00:00Z' },
      SCOPE
    ),
    (e) => e.code === 'QUOTE_UNAVAILABLE'
  );
});

test('create retries the quote number on a P2002 race', async () => {
  const { svc } = makeService({ db: fakeDb({ failCreateTimes: 2 }) });
  const q = await svc.create(
    { vehicleTypeId: 'vt-suv', pickupLocationId: 'loc1', pickupAt: '2026-08-01T10:00:00Z', returnAt: '2026-08-06T10:00:00Z' },
    SCOPE
  );
  assert.equal(q.quoteNumber, 'Q-1003'); // attempts 0,1 collided → third candidate
});

// ── getById / lazy expiry / cancel ──

test('getById resolves Q- numbers and lazy-expires stale ACTIVE quotes', async () => {
  const db = fakeDb({
    quotes: [{
      id: 'q1', tenantId: 't1', quoteNumber: 'Q-1001', status: 'ACTIVE',
      expiresAt: new Date(NOW.getTime() - 1000)
    }]
  });
  const { svc } = makeService({ db });
  const row = await svc.getById('q-1001', SCOPE);
  assert.equal(row.status, 'EXPIRED');
  assert.equal(db.quotes[0].status, 'EXPIRED'); // persisted flip
  assert.equal(await svc.getById('Q-9999', SCOPE), null);
});

test('cancel only works on ACTIVE quotes', async () => {
  const db = fakeDb({
    quotes: [{ id: 'q1', tenantId: 't1', quoteNumber: 'Q-1001', status: 'ACTIVE', expiresAt: new Date(NOW.getTime() + 1000) }]
  });
  const { svc } = makeService({ db });
  const out = await svc.cancel('Q-1001', SCOPE);
  assert.equal(out.status, 'CANCELLED');
  await assert.rejects(svc.cancel('Q-1001', SCOPE), (e) => e.code === 'QUOTE_NOT_ACTIVE');
});

// ── convert ──

function activeQuote(extra = {}) {
  return {
    id: 'q1', tenantId: 't1', quoteNumber: 'Q-1001', status: 'ACTIVE',
    expiresAt: new Date(NOW.getTime() + 3600 * 1000),
    pickupLocationId: 'loc1', returnLocationId: 'loc1', vehicleTypeId: 'vt-suv',
    pickupAt: new Date('2026-08-01T10:00:00Z'), returnAt: new Date('2026-08-06T10:00:00Z'),
    days: 5, dailyRate: 45, total: 265.88, source: 'VOZIA',
    contactName: 'Maria Hernandez', contactPhone: '(787) 555-1234', contactEmail: null,
    customerId: null, author: 'USR-2 Hector (via VozIA)',
    ...extra
  };
}

test('convert honors the SNAPSHOT price, creates the customer, marks CONVERTED', async () => {
  const db = fakeDb({ quotes: [activeQuote()] });
  const reservations = fakeReservations();
  const { svc } = makeService({ db, reservations });
  const out = await svc.convert('Q-1001', {}, SCOPE);
  assert.equal(out.alreadyConverted, false);
  assert.equal(out.quote.status, 'CONVERTED');
  assert.equal(out.quote.convertedReservationId, 'res1');
  const r = reservations.created[0];
  assert.equal(r.dailyRate, 45);            // snapshot, not re-priced
  assert.equal(r.estimatedTotal, 265.88);
  assert.equal(r.bookingChannel, 'VOZIA');
  assert.equal(r.status, 'NEW');
  assert.match(r.reservationNumber, /^RES-/);
  assert.equal(r.sourceRef, 'QUOTE:q1'); // MC-4: amarre quote→reservación
  assert.match(r.notes, /\[QUOTE Q-1001 converted by USR-2 Hector \(via VozIA\)/);
  // customer created from contact info
  assert.equal(db.customers.length, 1);
  assert.equal(db.customers[0].firstName, 'Maria');
  assert.equal(db.customers[0].lastName, 'Hernandez');
});

test('convert is idempotent once converted (VozIA retry-safe)', async () => {
  const db = fakeDb({ quotes: [activeQuote({ status: 'CONVERTED', convertedReservationId: 'res9' })] });
  const reservations = fakeReservations();
  const { svc } = makeService({ db, reservations });
  const out = await svc.convert('Q-1001', {}, SCOPE);
  assert.equal(out.alreadyConverted, true);
  assert.equal(out.reservationId, 'res9');
  assert.equal(reservations.created.length, 0);
});

test('convert rejects an expired quote with QUOTE_EXPIRED', async () => {
  const db = fakeDb({ quotes: [activeQuote({ expiresAt: new Date(NOW.getTime() - 1000) })] });
  const { svc } = makeService({ db });
  await assert.rejects(svc.convert('Q-1001', {}, SCOPE), (e) => e.code === 'QUOTE_EXPIRED');
});

test('convert re-checks availability and rejects when the class sold out', async () => {
  const db = fakeDb({ quotes: [activeQuote()] });
  const { svc } = makeService({ db, rows: [engineRow({ available: false, units: 0 })] });
  await assert.rejects(svc.convert('Q-1001', {}, SCOPE), (e) => e.code === 'QUOTE_UNAVAILABLE');
});

test('convert without customer/contact fails with CUSTOMER_REQUIRED', async () => {
  const db = fakeDb({ quotes: [activeQuote({ contactName: null, contactPhone: null })] });
  const { svc } = makeService({ db });
  await assert.rejects(svc.convert('Q-1001', {}, SCOPE), (e) => e.code === 'CUSTOMER_REQUIRED');
});

test('convert reuses an existing customer matched by phone', async () => {
  const db = fakeDb({
    quotes: [activeQuote()],
    customers: [{ id: 'cusX', tenantId: 't1', phone: '(787) 555-1234', email: 'm@x.com' }]
  });
  const reservations = fakeReservations();
  const { svc } = makeService({ db, reservations });
  await svc.convert('Q-1001', {}, SCOPE);
  assert.equal(reservations.created[0].customerId, 'cusX');
  assert.equal(db.customers.length, 1); // no duplicate created
});

// ── Innovation must-changes (2026-07-17) ──

test('MC-1: convert rejects a customerId from another tenant (CUSTOMER_NOT_FOUND)', async () => {
  const db = fakeDb({
    quotes: [activeQuote()],
    customers: [{ id: 'foreign1', tenantId: 'OTHER-TENANT', phone: '000', email: 'f@x.com' }]
  });
  const { svc } = makeService({ db });
  await assert.rejects(
    svc.convert('Q-1001', { customerId: 'foreign1' }, SCOPE),
    (e) => e.code === 'CUSTOMER_NOT_FOUND' && e.status === 422
  );
});

test('MC-1: create rejects a foreign customerId too', async () => {
  const db = fakeDb({ customers: [{ id: 'foreign1', tenantId: 'OTHER-TENANT', phone: '000' }] });
  const { svc } = makeService({ db });
  await assert.rejects(
    svc.create(
      { vehicleTypeId: 'vt-suv', pickupLocationId: 'loc1', customerId: 'foreign1',
        pickupAt: '2026-08-01T10:00:00Z', returnAt: '2026-08-06T10:00:00Z' },
      SCOPE
    ),
    (e) => e.code === 'CUSTOMER_NOT_FOUND'
  );
});

test('MC-3: naive datetime strings are rejected-safe (validation, not UTC drift)', async () => {
  const { svc } = makeService();
  // invalid garbage -> VALIDATION (no silent Invalid Date stored)
  await assert.rejects(
    svc.preview({ pickupLocationId: 'loc1', pickupAt: 'garbage', returnAt: 'more' }, SCOPE),
    (e) => e.code === 'VALIDATION'
  );
  // return before pickup -> VALIDATION
  await assert.rejects(
    svc.preview({ pickupLocationId: 'loc1', pickupAt: '2026-08-06T10:00:00Z', returnAt: '2026-08-01T10:00:00Z' }, SCOPE),
    (e) => e.code === 'VALIDATION'
  );
});

test('MC-4: crash-window self-heal — duplicate sourceRef recovers the orphan reservation', async () => {
  const db = fakeDb({ quotes: [activeQuote()] });
  db.reservations = [{ id: 'orphan1', sourceRef: 'QUOTE:q1' }];
  const reservations = {
    created: [],
    async create() { throw new Error('reservationNumber/sourceRef already exists'); }
  };
  const { svc } = makeService({ db, reservations });
  const out = await svc.convert('Q-1001', {}, SCOPE);
  assert.equal(out.alreadyConverted, true);
  assert.equal(out.reservationId, 'orphan1');
  assert.equal(db.quotes[0].status, 'CONVERTED');
  assert.equal(db.quotes[0].convertedReservationId, 'orphan1');
});

test('convert maps DO NOT RENT to a speakable 422 (DO_NOT_RENT)', async () => {
  const db = fakeDb({ quotes: [activeQuote()] });
  const reservations = {
    async create() { throw new Error('Customer is marked DO NOT RENT: unpaid balance'); }
  };
  const { svc } = makeService({ db, reservations });
  await assert.rejects(
    svc.convert('Q-1001', {}, SCOPE),
    (e) => e.code === 'DO_NOT_RENT' && e.status === 422
  );
});

test('convert dedupes the customer by digits-only phone fallback', async () => {
  const db = fakeDb({
    quotes: [activeQuote({ contactPhone: '(787) 555-1234' })],
    customers: [{ id: 'cusD', tenantId: 't1', phone: '7875551234' }] // stored digits-only
  });
  const reservations = fakeReservations();
  const { svc } = makeService({ db, reservations });
  await svc.convert('Q-1001', {}, SCOPE);
  assert.equal(reservations.created[0].customerId, 'cusD');
  assert.equal(db.customers.length, 1); // no duplicate
});

// ── Delta post-QA (Hector ronda 2, 2026-07-17): requote + minors m1/m2 ──

test('m1: list() rejects a bogus status with 400 VALIDATION (not a Prisma 500)', async () => {
  const { svc } = makeService();
  await assert.rejects(
    svc.list({ status: 'BOGUS' }, SCOPE),
    (e) => e.code === 'VALIDATION' && e.status === 400
  );
  // lowercase input normalizes fine
  const rows = await svc.list({ status: 'active' }, SCOPE);
  assert.ok(Array.isArray(rows));
});

test('m2: convert maps a vehicle-conflict race to QUOTE_UNAVAILABLE 422', async () => {
  const db = fakeDb({ quotes: [activeQuote()] });
  const reservations = {
    async create() { throw new Error('Vehicle conflict with reservation RES-999'); }
  };
  const { svc } = makeService({ db, reservations });
  await assert.rejects(
    svc.convert('Q-1001', {}, SCOPE),
    (e) => e.code === 'QUOTE_UNAVAILABLE' && e.status === 422
  );
});

test('requote duplicates an EXPIRED quote with FRESH prices and a new Q-#', async () => {
  const db = fakeDb({
    quotes: [activeQuote({ status: 'EXPIRED', dailyRate: 30, total: 180, contactName: 'Maria Hernandez', contactPhone: '(787) 555-1234' })]
  });
  // engine now returns a HIGHER fresh price than the stale snapshot
  const { svc } = makeService({ db, rows: [engineRow({ total: 300.5 })] });
  const fresh = await svc.requote('Q-1001', SCOPE);
  assert.equal(fresh.status, 'ACTIVE');
  assert.notEqual(fresh.quoteNumber, 'Q-1001');
  assert.equal(fresh.total, 300.5);           // fresh engine price, NOT the stale 180
  assert.equal(fresh.contactName, 'Maria Hernandez'); // contact carried over
  assert.equal(db.quotes[0].status, 'EXPIRED');       // original untouched
});

test('requote of a sold-out class still rejects (engine is the only truth)', async () => {
  const db = fakeDb({ quotes: [activeQuote({ status: 'EXPIRED' })] });
  const { svc } = makeService({ db, rows: [engineRow({ available: false, units: 0 })] });
  await assert.rejects(svc.requote('Q-1001', SCOPE), (e) => e.code === 'QUOTE_UNAVAILABLE');
});

test('list/getById stamp vehicleTypeName for the UI (relation-free enrichment)', async () => {
  const db = fakeDb({ quotes: [activeQuote()] });
  const { svc } = makeService({ db });
  const rows = await svc.list({}, SCOPE);
  assert.equal(rows[0].vehicleTypeName, 'SUV');
  const one = await svc.getById('Q-1001', SCOPE);
  assert.equal(one.vehicleTypeCode, 'SUV');
});
