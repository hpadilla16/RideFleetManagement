/**
 * Staff-editable daily rate at quote creation (2026-08-24, owner-approved).
 *
 * The invariants these tests defend:
 *   - only ADMIN / OPS / SUPER_ADMIN may override; an AGENT gets a clean 403
 *     and NOTHING is written (not a silently-ignored field);
 *   - a reason is REQUIRED — there is no cap on the discount, so the reason is
 *     the only control;
 *   - 0 / negative / NaN are refused;
 *   - VOZIA / PORTAL sourced quotes can never override, whatever the role;
 *   - the override RECOMPUTES the whole money block through the engine, so
 *     subtotal / taxes / total line up and percentage fees move with the new
 *     subtotal — no orphan dailyRate;
 *   - engineSnapshotJson keeps the ENGINE's original row, untouched, so the
 *     pre-override price is always recoverable;
 *   - with no override in the payload the stored numbers are IDENTICAL to the
 *     engine snapshot (the regression guard on the VozIA/public path).
 *
 * Run: npm run test:quote-rate-override
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createQuotesService,
  canOverrideRate,
  hasRateOverrideIntent,
  RATE_OVERRIDE_ROLES,
  MANUAL_OVERRIDE_PRICING_SOURCE
} from './quotes.service.js';
import { composeRentalMoney } from '../../lib/rental-money.js';
import { money } from '../../lib/money.js';

const NOW = new Date('2026-08-24T12:00:00.000Z');
const SCOPE = { tenantId: 't1' };
const ADMIN = { userId: 'u-admin', role: 'ADMIN', email: 'admin@example.com' };
const OPS = { userId: 'u-ops', role: 'OPS' };
const AGENT = { userId: 'u-agent', role: 'AGENT' };

const TAX_RATE = 11.5;
// One fixed fee + one PERCENTAGE fee, so a discount that failed to re-run the
// fees would leave the percentage fee pinned to the ORIGINAL subtotal — the
// exact bug the "recompute the whole quote" requirement is about.
const FEES = [
  { total: 15, mode: 'FIXED' },
  { pct: 5, mode: 'PERCENTAGE' }
];

function feesFor(subtotal) {
  return FEES.map((f) => (f.mode === 'PERCENTAGE'
    ? { ...f, total: Number((subtotal * (f.pct / 100)).toFixed(2)) }
    : { ...f }));
}

/** The engine's row for a 5-day SUV at $45/day, priced the way searchRental does. */
function engineRow(over = {}) {
  const days = 5;
  const dailyRate = 45;
  const subtotal = money(dailyRate * days);
  const composed = composeRentalMoney({ baseTotal: subtotal, taxRate: TAX_RATE, mandatoryFees: feesFor(subtotal) });
  return {
    vehicleType: { id: 'vt-suv', code: 'SUV', name: 'SUV' },
    availability: { availableUnits: 3, available: true },
    quote: {
      days,
      dailyRate,
      subtotal: composed.subtotal,
      fees: composed.fees,
      taxes: composed.taxes,
      total: composed.total,
      source: 'GLOBAL',
      revenuePricingApplied: true
    },
    ...over
  };
}

/**
 * Engine fake. recomputeRentalQuoteMoney mirrors the REAL implementation's
 * shape (rate x days, fees re-priced against the new subtotal, then the shared
 * composeRentalMoney) — the arithmetic itself is pinned against the engine in
 * src/lib/rental-money.test.mjs.
 */
function fakeEngine(rows = [engineRow()]) {
  const calls = { search: [], recompute: [] };
  return {
    calls,
    async searchRental(input) {
      calls.search.push(input);
      return { results: rows };
    },
    async recomputeRentalQuoteMoney(input) {
      calls.recompute.push(input);
      const dayCount = Math.max(1, Number(input.days || 1));
      const subtotal = money(Number(input.dailyRate) * dayCount);
      const composed = composeRentalMoney({
        baseTotal: subtotal,
        taxRate: TAX_RATE,
        mandatoryFees: feesFor(subtotal)
      });
      return { days: dayCount, dailyRate: money(input.dailyRate), taxRate: TAX_RATE, ...composed };
    }
  };
}

function fakeDb() {
  const quotes = [];
  let seq = 0;
  return {
    quotes,
    quote: {
      async count({ where }) { return quotes.filter((q) => q.tenantId === where.tenantId).length; },
      async create({ data }) {
        const row = { id: `q${(seq += 1)}`, status: 'ACTIVE', ...data };
        quotes.push(row);
        return row;
      },
      async findFirst() { return null; },
      async findMany() { return []; },
      async update({ where, data }) {
        const row = quotes.find((q) => q.id === where.id);
        Object.assign(row, data);
        return row;
      },
      async updateMany() { return { count: 0 }; }
    },
    vehicleType: {
      async findMany() { return [{ id: 'vt-suv', code: 'SUV', name: 'SUV' }]; }
    },
    location: { async findFirst() { return { taxRate: TAX_RATE }; } },
    reservation: { async findFirst() { return null; } },
    customer: { async findFirst() { return null; }, async create({ data }) { return { id: 'cus1', ...data }; } }
  };
}

function fakeAudit() {
  const rows = [];
  return {
    rows,
    AUDIT_ACTIONS: { QUOTE_RATE_OVERRIDE: 'QUOTE_RATE_OVERRIDE' },
    async recordAudit(entry) { rows.push(entry); }
  };
}

function makeService({ rows = [engineRow()] } = {}) {
  const db = fakeDb();
  const engine = fakeEngine(rows);
  const audit = fakeAudit();
  const svc = createQuotesService({
    prisma: db,
    bookingEngine: engine,
    reservations: { async create() { return { id: 'res1' }; } },
    audit,
    now: () => NOW,
    randHex: () => 'ab12',
    resolveTz: async () => 'UTC'
  });
  return { svc, db, engine, audit };
}

const WINDOW = {
  vehicleTypeId: 'vt-suv',
  pickupLocationId: 'loc1',
  pickupAt: '2026-09-01T10:00:00Z',
  returnAt: '2026-09-06T10:00:00Z'
};

// ── helper unit tests ───────────────────────────────────────────────────────

test('RATE_OVERRIDE_ROLES is exactly ADMIN/OPS + SUPER_ADMIN, and AGENT is out', () => {
  assert.deepEqual([...RATE_OVERRIDE_ROLES].sort(), ['ADMIN', 'OPS', 'SUPER_ADMIN']);
  assert.equal(canOverrideRate('ADMIN'), true);
  assert.equal(canOverrideRate('ops'), true);        // case/whitespace tolerant
  assert.equal(canOverrideRate('  SUPER_ADMIN '), true);
  assert.equal(canOverrideRate('AGENT'), false);
  assert.equal(canOverrideRate('GUEST'), false);
  assert.equal(canOverrideRate(undefined), false);   // fails CLOSED
  assert.equal(canOverrideRate(null), false);
  assert.equal(canOverrideRate(''), false);
});

test('hasRateOverrideIntent: only an actual value counts as an override attempt', () => {
  assert.equal(hasRateOverrideIntent({}), false);
  assert.equal(hasRateOverrideIntent({ dailyRateOverride: undefined }), false);
  assert.equal(hasRateOverrideIntent({ dailyRateOverride: null }), false);
  assert.equal(hasRateOverrideIntent({ dailyRateOverride: '' }), false);
  assert.equal(hasRateOverrideIntent({ dailyRateOverride: '   ' }), false);
  // Everything else IS an attempt — including the invalid ones, which must
  // reach validation rather than being quietly dropped.
  assert.equal(hasRateOverrideIntent({ dailyRateOverride: 0 }), true);
  assert.equal(hasRateOverrideIntent({ dailyRateOverride: -5 }), true);
  assert.equal(hasRateOverrideIntent({ dailyRateOverride: 'abc' }), true);
  assert.equal(hasRateOverrideIntent({ dailyRateOverride: 39.5 }), true);
});

// ── the happy path ──────────────────────────────────────────────────────────

test('ADMIN override with a reason: recomputes the WHOLE quote, keeps the engine row', async () => {
  const { svc, db, engine, audit } = makeService();
  const original = engineRow().quote;

  const q = await svc.create(
    { ...WINDOW, dailyRateOverride: 39, rateOverrideReason: 'Corporate match — Acme' },
    SCOPE,
    ADMIN
  );

  // New rate, and every dependent number moved with it.
  const expectedSubtotal = money(39 * 5); // 195
  const expected = composeRentalMoney({
    baseTotal: expectedSubtotal,
    taxRate: TAX_RATE,
    mandatoryFees: feesFor(expectedSubtotal)
  });
  assert.equal(q.dailyRate, 39);
  assert.equal(q.subtotal, expected.subtotal);
  assert.equal(q.fees, expected.fees);
  assert.equal(q.taxes, expected.taxes);
  assert.equal(q.total, expected.total);
  // Internally consistent to the cent.
  assert.equal(money(q.subtotal + q.taxes + q.fees), q.total);
  // The percentage fee actually followed the discount (15 + 5% of 195 = 24.75),
  // instead of staying pinned to the engine's 225 subtotal (15 + 11.25 = 26.25).
  assert.equal(q.fees, 24.75);
  assert.notEqual(q.fees, original.fees);

  // Marked, attributed, and recoverable.
  assert.equal(q.pricingSource, MANUAL_OVERRIDE_PRICING_SOURCE);
  assert.equal(q.revenuePricingApplied, false);
  assert.equal(Number(q.rateOverrideOriginalDaily), 45);
  assert.equal(q.rateOverrideReason, 'Corporate match — Acme');
  assert.equal(q.rateOverrideByUserId, 'u-admin');
  assert.equal(q.rateOverrideAt.getTime(), NOW.getTime());

  // engineSnapshotJson is the ENGINE's row, untouched.
  const snap = JSON.parse(q.engineSnapshotJson);
  assert.equal(snap.dailyRate, 45);
  assert.equal(snap.subtotal, original.subtotal);
  assert.equal(snap.fees, original.fees);
  assert.equal(snap.taxes, original.taxes);
  assert.equal(snap.total, original.total);
  assert.equal(snap.pricingSource, 'GLOBAL');
  assert.equal(snap.revenuePricingApplied, true);

  // The engine did the recompute; the quotes service did not hand-roll it.
  assert.equal(engine.calls.recompute.length, 1);
  assert.deepEqual(engine.calls.recompute[0], {
    tenantId: 't1', locationId: 'loc1', days: 5, dailyRate: 39
  });

  // Audited with both rates + the reason.
  assert.equal(audit.rows.length, 1);
  const a = audit.rows[0];
  assert.equal(a.action, 'QUOTE_RATE_OVERRIDE');
  assert.equal(a.targetType, 'Quote');
  assert.equal(a.targetId, q.id);
  assert.equal(a.tenantId, 't1');
  assert.equal(a.actorUserId, 'u-admin');
  assert.equal(a.actorRole, 'ADMIN');
  assert.equal(a.metadata.originalDailyRate, 45);
  assert.equal(a.metadata.newDailyRate, 39);
  assert.equal(a.metadata.originalTotal, original.total);
  assert.equal(a.metadata.newTotal, q.total);
  assert.equal(a.metadata.reason, 'Corporate match — Acme');

  assert.equal(db.quotes.length, 1);
});

test('OPS may override too, and an INCREASE is allowed (no cap either way)', async () => {
  const { svc } = makeService();
  const q = await svc.create(
    { ...WINDOW, dailyRateOverride: 120, rateOverrideReason: 'Peak weekend, last unit' },
    SCOPE,
    OPS
  );
  assert.equal(q.dailyRate, 120);
  assert.equal(q.subtotal, 600);
  assert.equal(money(q.subtotal + q.taxes + q.fees), q.total);
  assert.equal(q.rateOverrideByUserId, 'u-ops');
});

test('the reason is trimmed, and a decimal rate is stored to the cent', async () => {
  const { svc } = makeService();
  const q = await svc.create(
    { ...WINDOW, dailyRateOverride: '39.999', rateOverrideReason: '   AAA discount   ' },
    SCOPE,
    ADMIN
  );
  assert.equal(q.rateOverrideReason, 'AAA discount');
  assert.equal(q.dailyRate, 40); // round2('39.999')
});

// ── the gates ───────────────────────────────────────────────────────────────

test('AGENT override → 403 RATE_OVERRIDE_FORBIDDEN, and NOTHING is written', async () => {
  const { svc, db, engine, audit } = makeService();
  await assert.rejects(
    svc.create({ ...WINDOW, dailyRateOverride: 1, rateOverrideReason: 'because' }, SCOPE, AGENT),
    (e) => {
      assert.equal(e.code, 'RATE_OVERRIDE_FORBIDDEN');
      assert.equal(e.status, 403);
      return true;
    }
  );
  assert.equal(db.quotes.length, 0);
  assert.equal(audit.rows.length, 0);
  // Rejected before the engine was even asked to price anything.
  assert.equal(engine.calls.search.length, 0);
  assert.equal(engine.calls.recompute.length, 0);
});

test('an actor with NO role fails closed → 403', async () => {
  const { svc, db } = makeService();
  await assert.rejects(
    svc.create({ ...WINDOW, dailyRateOverride: 30, rateOverrideReason: 'x' }, SCOPE, {}),
    (e) => e.status === 403 && e.code === 'RATE_OVERRIDE_FORBIDDEN'
  );
  assert.equal(db.quotes.length, 0);
});

test('override without a reason → 400 RATE_OVERRIDE_REASON_REQUIRED, nothing written', async () => {
  for (const reason of [undefined, null, '', '    ']) {
    const { svc, db, audit } = makeService();
    await assert.rejects(
      svc.create({ ...WINDOW, dailyRateOverride: 39, rateOverrideReason: reason }, SCOPE, ADMIN),
      (e) => {
        assert.equal(e.code, 'RATE_OVERRIDE_REASON_REQUIRED');
        assert.equal(e.status, 400);
        return true;
      }
    );
    assert.equal(db.quotes.length, 0);
    assert.equal(audit.rows.length, 0);
  }
});

test('override with 0 / negative / NaN / non-numeric → 400 RATE_OVERRIDE_INVALID', async () => {
  for (const bad of [0, '0', -1, -0.01, Number.NaN, 'abc', Infinity, -Infinity, {}, []]) {
    const { svc, db } = makeService();
    await assert.rejects(
      svc.create({ ...WINDOW, dailyRateOverride: bad, rateOverrideReason: 'valid reason' }, SCOPE, ADMIN),
      (e) => {
        assert.equal(e.code, 'RATE_OVERRIDE_INVALID', `for ${JSON.stringify(bad)}`);
        assert.equal(e.status, 400);
        return true;
      }
    );
    assert.equal(db.quotes.length, 0);
  }
});

test('the ROLE gate runs before the value gate — an AGENT never learns the price shape', async () => {
  const { svc } = makeService();
  await assert.rejects(
    svc.create({ ...WINDOW, dailyRateOverride: -5, rateOverrideReason: '' }, SCOPE, AGENT),
    (e) => e.status === 403
  );
});

test('VOZIA / PORTAL sourced quotes can never override, even as ADMIN', async () => {
  for (const source of ['VOZIA', 'PORTAL']) {
    const { svc, db, engine } = makeService();
    await assert.rejects(
      svc.create(
        { ...WINDOW, source, dailyRateOverride: 39, rateOverrideReason: 'nope' },
        SCOPE,
        ADMIN
      ),
      (e) => {
        assert.equal(e.code, 'RATE_OVERRIDE_SOURCE_FORBIDDEN');
        assert.equal(e.status, 403);
        return true;
      }
    );
    assert.equal(db.quotes.length, 0);
    assert.equal(engine.calls.search.length, 0);
  }
});

// ── the regression guard: the non-override path must not move ───────────────

test('NO override → stored numbers are IDENTICAL to the engine snapshot', async () => {
  const { svc, engine, audit } = makeService();
  const q = await svc.create({ ...WINDOW, contactName: 'Maria', contactPhone: '787' }, SCOPE, ADMIN);
  const snap = JSON.parse(q.engineSnapshotJson);

  assert.equal(q.dailyRate, snap.dailyRate);
  assert.equal(q.subtotal, snap.subtotal);
  assert.equal(q.fees, snap.fees);
  assert.equal(q.taxes, snap.taxes);
  assert.equal(q.total, snap.total);
  assert.equal(q.pricingSource, snap.pricingSource);
  assert.equal(q.revenuePricingApplied, snap.revenuePricingApplied);
  assert.equal(q.days, snap.days);

  // and the engine's own row, for good measure
  const original = engineRow().quote;
  assert.equal(q.dailyRate, original.dailyRate);
  assert.equal(q.total, original.total);
  assert.equal(q.pricingSource, 'GLOBAL');
  assert.equal(q.revenuePricingApplied, true);

  // No override columns, no recompute call, no audit row.
  assert.equal(q.rateOverrideOriginalDaily, undefined);
  assert.equal(q.rateOverrideReason, undefined);
  assert.equal(q.rateOverrideByUserId, undefined);
  assert.equal(q.rateOverrideAt, undefined);
  assert.equal(engine.calls.recompute.length, 0);
  assert.equal(audit.rows.length, 0);
});

test('an AGENT can still create an ordinary quote — the gate only bites on an override', async () => {
  const { svc, db } = makeService();
  const q = await svc.create({ ...WINDOW, source: 'VOZIA' }, SCOPE, AGENT);
  assert.equal(q.quoteNumber, 'Q-1001');
  assert.equal(q.dailyRate, 45);
  assert.equal(q.pricingSource, 'GLOBAL');
  assert.equal(db.quotes.length, 1);
});

test('a broken audit writer cannot fail a quote that is already committed', async () => {
  const db = fakeDb();
  const svc = createQuotesService({
    prisma: db,
    bookingEngine: fakeEngine(),
    audit: { AUDIT_ACTIONS: {}, async recordAudit() { throw new Error('audit table gone'); } },
    now: () => NOW,
    resolveTz: async () => 'UTC'
  });
  const q = await svc.create(
    { ...WINDOW, dailyRateOverride: 39, rateOverrideReason: 'Corporate match' },
    SCOPE,
    ADMIN
  );
  assert.equal(q.dailyRate, 39);
  assert.equal(db.quotes.length, 1);
});
