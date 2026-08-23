/**
 * retention.test.mjs — GDPR Wave 2 Phase C retention sweep.
 *
 * DB-FREE: drives runSweep()/computeCandidates() against a small in-memory
 * Prisma fake (the erasure-suite pattern, extended with lt/startsWith/not/create)
 * so it runs on a laptop in the npm chain.
 *
 * Proves the sacred invariants + the two-clock record-level model:
 *   - preview computes the full candidate set and mutates NOTHING
 *   - preview vs apply produce IDENTICAL candidate lists
 *   - only 5y+ agreements have identity swept + piiPurgedAt stamped; the recent
 *     one and the OPEN-incident customer are UNTOUCHED
 *   - the 11y agreement loses the accounting residual too; the 5y keeps it
 *   - old system/access logs deleted, recent kept
 *   - BATCH CAP processes only N per category per run
 *   - ABORT threshold trips a category and mutates nothing
 *   - kill-switch / flag-off does not register the scheduler
 *   - re-run is a no-op (piiPurgedAt idempotency)
 *   - the two clocks are env-configurable
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL ||= 'postgresql://user:pass@localhost:5432/db?schema=public';
process.env.NODE_ENV ||= 'test';

const {
  runSweep,
  computeCandidates,
  ACCOUNTING_REDACT_PREFIX,
} = await import('./retention.service.js');
const scheduler = await import('./retention.scheduler.js');
const { REDACTION } = await import('../customers/customer-pii-map.js');

// ---------------------------------------------------------------------------
// In-memory Prisma fake. where matchers: scalar equals/null, { in }, { lt },
// { gt }, { startsWith }, { not }, { equals, mode }, OR, AND. Plus create().
// ---------------------------------------------------------------------------
const MODELS = [
  'customer', 'reservation',
  'rentalAgreement', 'loanerAgreement',
  'rentalAgreementAddendum', 'agreementDriver', 'agreementSectionInitial',
  'rentalAgreementInspection', 'rentalAgreementVehicleSwap', 'rentalAgreementCharge',
  'rentalAgreementPayment', 'agreementCommission',
  'loanerPhoto', 'loanerDamagePoint',
  'reservationIncident', 'tripIncident', 'vehicleDamageReport',
  'moduleAccessAuditLog', 'endpointLoadObservation', 'endpointLoadObservationDaily',
  'retentionSweepRun',
];

const toTime = (v) => (v instanceof Date ? v.getTime() : (typeof v === 'string' ? Date.parse(v) : v));

function matchCond(value, cond) {
  if (cond !== null && typeof cond === 'object' && !Array.isArray(cond)) {
    if ('in' in cond) return Array.isArray(cond.in) && cond.in.includes(value);
    if ('lt' in cond) return value != null && toTime(value) < toTime(cond.lt);
    if ('gt' in cond) return value != null && toTime(value) > toTime(cond.gt);
    if ('startsWith' in cond) return String(value ?? '').startsWith(cond.startsWith);
    if ('not' in cond) return !matchCond(value, cond.not);
    if ('equals' in cond) {
      if (cond.mode === 'insensitive') return String(value ?? '').toLowerCase() === String(cond.equals ?? '').toLowerCase();
      return value === cond.equals;
    }
    return false;
  }
  return value === cond;
}

function matchWhere(row, where) {
  if (!where) return true;
  for (const [key, cond] of Object.entries(where)) {
    if (key === 'OR') {
      if (!Array.isArray(cond) || !cond.some((w) => matchWhere(row, w))) return false;
    } else if (key === 'AND') {
      if (!Array.isArray(cond) || !cond.every((w) => matchWhere(row, w))) return false;
    } else if (!matchCond(row[key], cond)) {
      return false;
    }
  }
  return true;
}

let idSeq = 0;
function makeFake(seed) {
  const store = {};
  for (const m of MODELS) store[m] = (seed[m] || []).map((r) => ({ ...r }));
  const delegate = (name) => ({
    async findMany({ where, select } = {}) {
      let rows = store[name].filter((r) => matchWhere(r, where)).map((r) => ({ ...r }));
      if (select) rows = rows.map((r) => { const o = {}; for (const k of Object.keys(select)) if (select[k]) o[k] = r[k]; return o; });
      return rows;
    },
    async findFirst({ where } = {}) { const r = store[name].find((row) => matchWhere(row, where)); return r ? { ...r } : null; },
    async count({ where } = {}) { return store[name].filter((r) => matchWhere(r, where)).length; },
    async updateMany({ where, data } = {}) {
      let count = 0;
      for (const r of store[name]) if (matchWhere(r, where)) { Object.assign(r, data); count += 1; }
      return { count };
    },
    async update({ where, data } = {}) {
      const r = store[name].find((row) => matchWhere(row, where));
      if (!r) throw new Error(`update: no ${name} for ${JSON.stringify(where)}`);
      Object.assign(r, data); return { ...r };
    },
    async deleteMany({ where } = {}) {
      const before = store[name].length;
      store[name] = store[name].filter((r) => !matchWhere(r, where));
      return { count: before - store[name].length };
    },
    async create({ data } = {}) {
      const row = { id: data.id || `gen_${++idSeq}`, ...data };
      store[name].push(row); return { ...row };
    },
  });
  const client = { _store: store };
  for (const m of MODELS) client[m] = delegate(m);
  client.$transaction = async (fn) => fn(client);
  return client;
}

// ---------------------------------------------------------------------------
// Seed. NOW is fixed; identity clock 4y, accounting 10y, logs 13mo (defaults).
// ---------------------------------------------------------------------------
const NOW = new Date('2026-08-23T00:00:00.000Z');
const yAgo = (y) => { const d = new Date(NOW); d.setUTCFullYear(d.getUTCFullYear() - y); return d; };
const mAgo = (m) => { const d = new Date(NOW); d.setUTCMonth(d.getUTCMonth() - m); return d; };

function seed() {
  return {
    customer: [
      { id: 'c_recent', doNotRent: false, firstName: 'Ra', lastName: 'Recent' },
      { id: 'c_inactive', doNotRent: false, firstName: 'Ina', lastName: 'Active' },
      { id: 'c_open', doNotRent: false, firstName: 'Op', lastName: 'Enclaim' },
      { id: 'c_erased', doNotRent: true, firstName: REDACTION, lastName: 'Gone' },
    ],
    reservation: [
      { id: 'r_recent', customerId: 'c_recent', returnAt: yAgo(1) },
      { id: 'r_old', customerId: 'c_inactive', returnAt: yAgo(5) },
      { id: 'r_open', customerId: 'c_open', returnAt: yAgo(5) },
      { id: 'r_erased', customerId: 'c_erased', returnAt: yAgo(6) },
    ],
    reservationIncident: [
      { id: 'inc_open', reservationId: 'r_open', status: 'ISSUED' }, // OPEN → blocks c_open
      { id: 'inc_closed', reservationId: 'r_old', status: 'CLOSED' }, // terminal → does not block
      // OPEN claim on a 5y+ agreement's reservation → must FREEZE its identity sweep.
      { id: 'inc_ra_open', reservationId: 'res_ra_5y_oc', status: 'DISPUTED' },
    ],
    rentalAgreement: [
      raRow('ra_3y', 'RA-3Y', yAgo(3), 100),
      raRow('ra_5y', 'RA-5Y', yAgo(5), 200),
      raRow('ra_11y', 'RA-11Y', yAgo(11), 300),
      raRow('ra_recent', 'RA-REC', yAgo(1), 400),
      // 5y+ but its reservation has an OPEN dispute → identity must be retained.
      raRow('ra_5y_oc', 'RA-5Y-OC', yAgo(5), 250),
    ],
    agreementDriver: [
      { id: 'ad_5y', rentalAgreementId: 'ra_5y', firstName: 'Jane', lastName: 'Driver', email: 'jane@x.com', licenseNumber: 'DL9' },
    ],
    loanerAgreement: [
      laRow('la_5y', 'LA-5Y', yAgo(5)),
      laRow('la_recent', 'LA-REC', yAgo(1)),
    ],
    loanerDamagePoint: [
      { id: 'ldp_5y', loanerAgreementId: 'la_5y', note: 'scratch by the door — Bob said it was there' },
    ],
    moduleAccessAuditLog: [
      { id: 'mal_old', changedAt: mAgo(14) },
      { id: 'mal_new', changedAt: mAgo(1) },
    ],
    endpointLoadObservation: [
      { id: 'elo_old', observedAt: mAgo(14) },
      { id: 'elo_new', observedAt: mAgo(1) },
    ],
    endpointLoadObservationDaily: [
      { id: 'elod_old', day: mAgo(14) },
      { id: 'elod_new', day: mAgo(1) },
    ],
  };
}

function raRow(id, num, closeDate, total) {
  return {
    id, agreementNumber: num, reservationId: `res_${id}`,
    returnedAt: closeDate, closedAt: closeDate, piiPurgedAt: null,
    customerFirstName: 'John', customerLastName: 'Doe',
    customerEmail: 'john@x.com', customerPhone: '555', dateOfBirth: yAgo(40),
    licenseNumber: 'DL123', insuranceDocumentUrl: 'customer-docs:ins.pdf',
    subtotal: total, taxes: 0, fees: 0, total, deposit: 0,
    paidAmount: total, balance: 0, securityDepositAmount: 0, paymentReference: 'PAY-1', notes: 'call John at home',
  };
}
function laRow(id, num, closeDate) {
  return {
    id, agreementNumber: num, reservationId: `res_${id}`,
    closedAt: closeDate, piiPurgedAt: null,
    customerFirstName: 'Bob', customerLastName: 'Loan',
    customerEmail: 'bob@x.com', dateOfBirth: yAgo(30),
    licenseNumber: 'DL777', licenseImagePath: 'inspection-photos:lic.jpg',
    insuranceImagePath: 'inspection-photos:ins.jpg', notes: 'Bob',
  };
}

// Deps with an eraseCustomer spy + a no-op storage deleter (never hits DB/net).
function makeDeps(store, spy) {
  const prisma = makeFake(store);
  const calls = [];
  const eraseCustomer = spy || (async (id, opts) => { calls.push({ id, opts }); return { ok: true }; });
  return {
    deps: { prisma, logger: quietLogger(), deleteObject: async () => ({ ok: true }), eraseCustomer: spy || eraseCustomer },
    prisma, calls,
  };
}
function quietLogger() {
  return { info() {}, warn() {}, error() {}, debug() {} };
}

const IDENTITY_ENV = ['RETENTION_IDENTITY_YEARS', 'RETENTION_ACCOUNTING_YEARS', 'RETENTION_LOG_MONTHS',
  'RETENTION_SWEEP_BATCH', 'RETENTION_SWEEP_MAX_PER_RUN', 'RETENTION_SWEEP_FORCE',
  'RETENTION_SWEEP_ENABLED', 'RETENTION_SWEEP_APPLY', 'GDPR_ERASURE_ENABLED'];

beforeEach(() => { for (const k of IDENTITY_ENV) delete process.env[k]; });
afterEach(() => { for (const k of IDENTITY_ENV) delete process.env[k]; });

// ---------------------------------------------------------------------------

describe('retention sweep — candidates', () => {
  it('selects only identity-expired (5y+) agreements, the inactive customer, expired accounting + old logs', async () => {
    const { deps } = makeDeps(seed());
    const cands = await computeCandidates(deps, { now: NOW });
    assert.deepEqual(cands.rentalAgreementIdentity.ids.sort(), ['ra_11y', 'ra_5y']);
    assert.deepEqual(cands.loanerAgreementIdentity.ids, ['la_5y']);
    assert.deepEqual(cands.inactiveCustomer.ids, ['c_inactive']); // c_open blocked by OPEN incident; c_erased suppressed; c_recent recent
    assert.deepEqual(cands.rentalAgreementAccounting.ids, ['ra_11y']); // only 11y past the 10y accounting clock
    assert.deepEqual(cands.moduleAccessLog.ids, ['mal_old']);
    assert.deepEqual(cands.endpointLoadObservation.ids, ['elo_old']);
    assert.deepEqual(cands.endpointLoadObservationDaily.ids, ['elod_old']);
  });
});

describe('retention sweep — preview mutates nothing', () => {
  it('preview logs candidates but changes no target rows', async () => {
    const { deps, prisma } = makeDeps(seed());
    const res = await runSweep({ apply: false, now: NOW, deps });
    assert.equal(res.mode, 'PREVIEW');
    // Every agreement untouched.
    for (const ra of prisma._store.rentalAgreement) {
      assert.equal(ra.piiPurgedAt, null);
      assert.equal(ra.customerFirstName, 'John');
    }
    assert.ok(prisma._store.rentalAgreement.find((r) => r.id === 'ra_11y').agreementNumber === 'RA-11Y');
    // Logs untouched.
    assert.equal(prisma._store.moduleAccessAuditLog.length, 2);
    assert.equal(prisma._store.endpointLoadObservation.length, 2);
    // A PREVIEW run-history row is written (operational metadata, not a purge).
    assert.equal(prisma._store.retentionSweepRun.length, 1);
    assert.equal(prisma._store.retentionSweepRun[0].mode, 'PREVIEW');
  });

  it('preview and apply compute IDENTICAL candidate lists', async () => {
    const a = makeDeps(seed());
    const b = makeDeps(seed());
    process.env.GDPR_ERASURE_ENABLED = 'true';
    const preview = await runSweep({ apply: false, now: NOW, deps: a.deps });
    const apply = await runSweep({ apply: true, now: NOW, deps: b.deps });
    const norm = (r) => Object.fromEntries(Object.entries(r.candidates).map(([k, v]) => [k, v.ids.slice().sort()]));
    assert.deepEqual(norm(preview), norm(apply));
  });
});

describe('retention sweep — identity clock (record-level)', () => {
  it('strips identity + children on 5y+ only; recent + open-incident untouched; sets piiPurgedAt', async () => {
    const { deps, prisma } = makeDeps(seed());
    process.env.GDPR_ERASURE_ENABLED = 'true';
    await runSweep({ apply: true, now: NOW, deps });
    const byId = (m, id) => prisma._store[m].find((r) => r.id === id);

    // 5y + 11y swept.
    for (const id of ['ra_5y', 'ra_11y']) {
      const ra = byId('rentalAgreement', id);
      assert.equal(ra.customerFirstName, REDACTION, `${id} first name redacted`);
      assert.equal(ra.customerEmail, null);
      assert.equal(ra.licenseNumber, null);
      assert.equal(ra.dateOfBirth, null);
      assert.equal(ra.insuranceDocumentUrl, null);
      assert.equal(ra.notes, null);
      assert.equal(ra.customerLastName, 'Doe', 'CONSERVATIVE keeps last name');
      assert.ok(ra.piiPurgedAt instanceof Date, `${id} piiPurgedAt stamped`);
    }
    // Cascade child of ra_5y stripped.
    const ad = byId('agreementDriver', 'ad_5y');
    assert.equal(ad.firstName, REDACTION);
    assert.equal(ad.email, null);
    assert.equal(ad.licenseNumber, null);

    // Loaner 5y swept + its damage-point note nulled.
    const la = byId('loanerAgreement', 'la_5y');
    assert.equal(la.customerFirstName, REDACTION);
    assert.equal(la.licenseNumber, null);
    assert.ok(la.piiPurgedAt instanceof Date);
    assert.equal(byId('loanerDamagePoint', 'ldp_5y').note, null);

    // Recent + 3y (within the 4y window) UNTOUCHED.
    for (const id of ['ra_3y', 'ra_recent']) {
      const ra = byId('rentalAgreement', id);
      assert.equal(ra.customerFirstName, 'John', `${id} untouched`);
      assert.equal(ra.piiPurgedAt, null);
    }
    assert.equal(byId('loanerAgreement', 'la_recent').customerFirstName, 'Bob');
  });

  it('does NOT strip a 5y+ agreement whose reservation has an OPEN claim (claims window freezes the clock)', async () => {
    const { deps, prisma } = makeDeps(seed());
    process.env.GDPR_ERASURE_ENABLED = 'true';
    await runSweep({ apply: true, now: NOW, deps });
    const byId = (m, id) => prisma._store[m].find((r) => r.id === id);

    // ra_5y_oc is 5 years old (past the identity clock) BUT its reservation
    // carries a DISPUTED incident — its renter identity must be retained.
    const oc = byId('rentalAgreement', 'ra_5y_oc');
    assert.equal(oc.customerFirstName, 'John', 'open-claim agreement first name retained');
    assert.equal(oc.customerEmail, 'john@x.com', 'open-claim agreement email retained');
    assert.equal(oc.licenseNumber, 'DL123', 'open-claim agreement licence retained');
    assert.equal(oc.dateOfBirth != null, true, 'open-claim agreement DOB retained');
    assert.equal(oc.piiPurgedAt, null, 'open-claim agreement NOT marked purged');

    // Control: the sibling 5y agreement with no open claim WAS swept.
    assert.equal(byId('rentalAgreement', 'ra_5y').customerFirstName, REDACTION);
    assert.ok(byId('rentalAgreement', 'ra_5y').piiPurgedAt instanceof Date);
  });

  it('re-run is a no-op (piiPurgedAt idempotency)', async () => {
    const { deps, prisma } = makeDeps(seed());
    process.env.GDPR_ERASURE_ENABLED = 'true';
    await runSweep({ apply: true, now: NOW, deps });
    const second = await runSweep({ apply: true, now: NOW, deps });
    assert.equal(second.candidates.rentalAgreementIdentity.ids.length, 0);
    assert.equal(second.candidates.loanerAgreementIdentity.ids.length, 0);
    assert.equal(second.perCategoryCounts.rentalAgreementIdentity.processed, 0);
    // deleted logs already gone.
    assert.equal(prisma._store.moduleAccessAuditLog.length, 1);
  });
});

describe('retention sweep — accounting clock', () => {
  it('the 11y agreement loses accounting; the 5y keeps it', async () => {
    const { deps, prisma } = makeDeps(seed());
    process.env.GDPR_ERASURE_ENABLED = 'true';
    await runSweep({ apply: true, now: NOW, deps });
    const ra11 = prisma._store.rentalAgreement.find((r) => r.id === 'ra_11y');
    assert.equal(ra11.total, 0, '11y money zeroed');
    assert.equal(ra11.subtotal, 0);
    assert.ok(ra11.agreementNumber.startsWith(ACCOUNTING_REDACT_PREFIX), '11y agreementNumber anonymised');
    assert.equal(ra11.paymentReference, null);

    const ra5 = prisma._store.rentalAgreement.find((r) => r.id === 'ra_5y');
    assert.equal(ra5.total, 200, '5y accounting retained (within accounting clock)');
    assert.equal(ra5.agreementNumber, 'RA-5Y');
  });
});

describe('retention sweep — log rotation', () => {
  it('deletes old system/access logs, keeps recent', async () => {
    const { deps, prisma } = makeDeps(seed());
    process.env.GDPR_ERASURE_ENABLED = 'true';
    await runSweep({ apply: true, now: NOW, deps });
    assert.deepEqual(prisma._store.moduleAccessAuditLog.map((r) => r.id), ['mal_new']);
    assert.deepEqual(prisma._store.endpointLoadObservation.map((r) => r.id), ['elo_new']);
    assert.deepEqual(prisma._store.endpointLoadObservationDaily.map((r) => r.id), ['elod_new']);
  });
});

describe('retention sweep — inactive customer (reuses Phase A eraseCustomer)', () => {
  it('calls eraseCustomer for the fully-inactive customer only, never the open-incident one', async () => {
    const calls = [];
    const spy = async (id, opts) => { calls.push({ id, opts }); return { ok: true }; };
    const { deps } = makeDeps(seed(), spy);
    process.env.GDPR_ERASURE_ENABLED = 'true';
    await runSweep({ apply: true, now: NOW, deps });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].id, 'c_inactive');
    assert.equal(calls[0].opts.dryRun, false);
    assert.equal(calls[0].opts.retentionMode, 'CONSERVATIVE');
    assert.equal(calls[0].opts.actor, 'retention-sweep');
    assert.ok(!calls.find((c) => c.id === 'c_open'));
  });

  it('with GDPR_ERASURE_ENABLED off, apply degrades the customer category to dry-run (never throws)', async () => {
    const calls = [];
    const spy = async (id, opts) => { calls.push({ id, opts }); return { ok: true }; };
    const { deps } = makeDeps(seed(), spy);
    // RETENTION apply on, but customer erasure flag OFF.
    const res = await runSweep({ apply: true, now: NOW, deps });
    assert.equal(res.ok, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].opts.dryRun, true, 'degraded to dry-run because GDPR_ERASURE_ENABLED is off');
    assert.equal(res.perCategoryCounts.inactiveCustomer.processed, 0);
  });
});

describe('retention sweep — batch cap', () => {
  it('processes only N candidates per category per run', async () => {
    const { deps, prisma } = makeDeps(seed());
    process.env.GDPR_ERASURE_ENABLED = 'true';
    const res = await runSweep({ apply: true, now: NOW, batch: 1, deps });
    assert.equal(res.perCategoryCounts.rentalAgreementIdentity.total, 2);
    assert.equal(res.perCategoryCounts.rentalAgreementIdentity.selected, 1);
    const swept = prisma._store.rentalAgreement.filter((r) => r.piiPurgedAt).map((r) => r.id);
    assert.equal(swept.length, 1, 'exactly one rental identity record swept under batch=1');
  });
});

describe('retention sweep — abort on anomaly', () => {
  it('aborts a category over the safety threshold and mutates nothing for it', async () => {
    const { deps, prisma } = makeDeps(seed());
    process.env.GDPR_ERASURE_ENABLED = 'true';
    const res = await runSweep({ apply: true, now: NOW, maxPerRun: 1, deps });
    assert.equal(res.aborted, true);
    assert.equal(res.perCategoryCounts.rentalAgreementIdentity.aborted, true);
    // Nothing in the aborted category mutated.
    for (const ra of prisma._store.rentalAgreement) {
      assert.equal(ra.piiPurgedAt, null, `${ra.id} untouched — category aborted`);
      assert.equal(ra.customerFirstName, 'John');
    }
    assert.equal(res.perCategoryCounts.rentalAgreementIdentity.processed, 0);
  });

  it('force override runs an over-threshold category', async () => {
    const { deps, prisma } = makeDeps(seed());
    process.env.GDPR_ERASURE_ENABLED = 'true';
    const res = await runSweep({ apply: true, now: NOW, maxPerRun: 1, force: true, deps });
    assert.equal(res.perCategoryCounts.rentalAgreementIdentity.aborted, false);
    assert.ok(prisma._store.rentalAgreement.some((r) => r.piiPurgedAt), 'force ran the category');
  });
});

describe('retention sweep — two clocks are env-configurable', () => {
  it('raising the identity clock past 5y drops the 5y agreement from candidates', async () => {
    const { deps } = makeDeps(seed());
    process.env.RETENTION_IDENTITY_YEARS = '6';
    const cands = await computeCandidates(deps, { now: NOW });
    assert.deepEqual(cands.rentalAgreementIdentity.ids, ['ra_11y'], 'only 11y > 6y clock');
    assert.deepEqual(cands.loanerAgreementIdentity.ids, [], 'la_5y no longer expired at 6y');
  });

  it('raising the accounting clock past 11y drops the 11y agreement from accounting candidates', async () => {
    const { deps } = makeDeps(seed());
    process.env.RETENTION_ACCOUNTING_YEARS = '12';
    const cands = await computeCandidates(deps, { now: NOW });
    assert.deepEqual(cands.rentalAgreementAccounting.ids, [], 'nothing older than the 12y accounting clock');
  });

  it('shrinking the log window sweeps more logs', async () => {
    const { deps } = makeDeps(seed());
    process.env.RETENTION_LOG_MONTHS = '0'; // everything older than NOW
    const cands = await computeCandidates(deps, { now: NOW });
    assert.deepEqual(cands.moduleAccessLog.ids.sort(), ['mal_new', 'mal_old']);
  });
});

describe('retention sweep — kill-switch / flag-off scheduler', () => {
  it('is OFF by default and only enables with the exact flag', () => {
    delete process.env.RETENTION_SWEEP_ENABLED;
    assert.equal(scheduler.enabled(), false);
    process.env.RETENTION_SWEEP_ENABLED = 'false';
    assert.equal(scheduler.enabled(), false);
    process.env.RETENTION_SWEEP_ENABLED = 'true';
    assert.equal(scheduler.enabled(), true);
  });

  it('is PREVIEW-only by default and only applies with the exact flag', () => {
    delete process.env.RETENTION_SWEEP_APPLY;
    assert.equal(scheduler.applyEnabled(), false);
    process.env.RETENTION_SWEEP_APPLY = 'true';
    assert.equal(scheduler.applyEnabled(), true);
  });

  it('start does not register a timer while disabled', () => {
    delete process.env.RETENTION_SWEEP_ENABLED;
    // Must not throw and must not leave a live timer behind.
    scheduler.startRetentionSweepScheduler();
    scheduler.stopRetentionSweepScheduler();
    assert.ok(scheduler.msUntilNextRun() > 0);
  });
});
