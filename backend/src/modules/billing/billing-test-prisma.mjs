/**
 * DB-free Prisma stand-in for the billing suites.
 *
 * Same shape as the in-memory table in shuttle-driver-service.test.mjs — the
 * billing suites must stay runnable on a laptop with no Postgres, because the
 * `npm test` chain has to (see the KNOWN_OUT reasons in npm-test-chain.test.mjs
 * for what happens to a DB-backed suite otherwise).
 *
 * Deliberately NOT a general Prisma emulator. It implements exactly the query
 * shapes this module uses, so a service that starts using a shape this fake does
 * not support fails loudly here rather than passing on a fiction.
 */

let seq = 0;

/**
 * Comparable form of a value.
 *
 * Numbers stay numbers and strings stay strings; only Dates (and things that
 * parse as one) become epoch millis. The original coerced EVERYTHING through
 * `new Date()`, which happened to work for `attempts: { lt: 10 }` only because
 * `new Date(10)` is 10ms past the epoch. Phase 2 compares attempt counts and
 * VARCHAR(10) calendar dates in the same predicate, so the coercion is made
 * explicit rather than left as a coincidence that holds until it does not.
 *
 * Calendar dates ('YYYY-MM-DD') compare correctly as PLAIN STRINGS — that is a
 * designed property of the format (billing-dates.js), and it is what the real
 * Postgres VARCHAR comparison does too, so the fake matches production here.
 */
function cmpVal(v) {
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    // An ISO instant is a Date in disguise; a calendar date is not.
    if (/^\d{4}-\d{2}-\d{2}T/.test(v)) return new Date(v).getTime();
    return v;
  }
  return v;
}

function compare(a, b) {
  const x = cmpVal(a);
  const y = cmpVal(b);
  if (x == null && y == null) return 0;
  if (x == null) return -1;
  if (y == null) return 1;
  if (typeof x === 'string' || typeof y === 'string') {
    return String(x) < String(y) ? -1 : String(x) > String(y) ? 1 : 0;
  }
  return x < y ? -1 : x > y ? 1 : 0;
}

function matchVal(val, cond) {
  const v = val ?? null;
  if (cond && typeof cond === 'object' && !(cond instanceof Date)) {
    // EVERY operator present must hold — Prisma ANDs them (2026-08-28, Phase 5).
    //
    // This used to `return` on the first operator it recognised, so a compound
    // filter like `{ not: null, lte: cutoff }` silently degraded to `not: null`
    // and the fake answered a question nobody asked. Found by the dunning suite,
    // where it made a tenant five days into a six-day grace window look overdue.
    // A fake that quietly widens a predicate is worse than no fake: the suite
    // goes green on a filter production would have narrowed.
    let ok = true;
    if ('in' in cond) ok = ok && cond.in.includes(v);
    if ('not' in cond) ok = ok && v !== cond.not;
    if ('gt' in cond) ok = ok && v != null && compare(v, cond.gt) > 0;
    if ('gte' in cond) ok = ok && v != null && compare(v, cond.gte) >= 0;
    if ('lt' in cond) ok = ok && v != null && compare(v, cond.lt) < 0;
    if ('lte' in cond) ok = ok && v != null && compare(v, cond.lte) <= 0;
    // The heartbeat separates real Authorize.Net deliveries (`net.authorize.*`)
    // from the reconciler's own synthetic rows (`reconcile.*`) with a prefix
    // match. Modelled rather than approximated, because counting a synthetic row
    // as a delivery is precisely the bug that filter exists to prevent.
    if ('startsWith' in cond) ok = ok && typeof v === 'string' && v.startsWith(cond.startsWith);
    return ok;
  }
  if (v instanceof Date || cond instanceof Date) {
    return v != null && cond != null && new Date(v).getTime() === new Date(cond).getTime();
  }
  return v === (cond ?? null);
}

/**
 * Sort like Prisma-on-Postgres, INCLUDING ITS NULL HANDLING.
 *
 * Postgres puts NULLs FIRST on `ORDER BY x DESC`. That is not a detail here: the
 * webhook ordering watermark is a `findFirst({ orderBy: { eventDate: 'desc' } })`,
 * and an undated event sorting to the top would make the watermark read back as
 * null and silently switch the out-of-order guard off. The fake reproduces the
 * behaviour so a test can prove the production query excludes undated rows,
 * rather than passing because the fake happened to sort NULLs last.
 */
function applyOrderBy(rows, orderBy) {
  if (!orderBy) return rows;
  const [field, dir] = Object.entries(orderBy)[0] || [];
  if (!field) return rows;
  const desc = String(dir).toLowerCase() === 'desc';
  return [...rows].sort((a, b) => {
    const av = a[field] ?? null;
    const bv = b[field] ?? null;
    if (av == null && bv == null) return 0;
    if (av == null) return desc ? -1 : 1; // NULLS FIRST on DESC, LAST on ASC
    if (bv == null) return desc ? 1 : -1;
    return desc ? -compare(av, bv) : compare(av, bv);
  });
}

const matches = (row, where = {}) => Object.entries(where).every(([k, c]) => matchVal(row[k], c));

function applyData(row, data) {
  for (const [k, v] of Object.entries(data)) {
    if (v && typeof v === 'object' && !(v instanceof Date) && 'increment' in v) {
      row[k] = Number(row[k] || 0) + Number(v.increment);
    } else {
      row[k] = v;
    }
  }
  row.updatedAt = new Date();
  return row;
}

/**
 * `uniqueBy` is a list of column-name groups that must stay unique. It is what
 * lets a test prove the one-live-subscription-per-tenant guard fires — the real
 * thing is a PARTIAL unique index in raw SQL, which Prisma cannot express and
 * this fake models with a predicate.
 */
export function table(name, { defaults = {}, unique = [], partialUnique = [] } = {}) {
  const rows = [];
  return {
    name,
    rows,
    async create({ data }) {
      for (const keys of unique) {
        if (keys.every((k) => data[k] != null)
          && rows.some((r) => keys.every((k) => r[k] === data[k]))) {
          const e = new Error(`Unique constraint failed on ${name}.${keys.join('_')}`);
          e.code = 'P2002';
          throw e;
        }
      }
      for (const { keys, where } of partialUnique) {
        const candidate = { ...defaults, ...data };
        if (where(candidate) && rows.some((r) => where(r) && keys.every((k) => r[k] === data[k]))) {
          const e = new Error(`Unique constraint failed on ${name} partial index`);
          e.code = 'P2002';
          throw e;
        }
      }
      const row = {
        id: data.id || `${name}_${++seq}`,
        createdAt: new Date(),
        updatedAt: new Date(),
        // TenantSubscriptionEvent.receivedAt is `@default(now())` in the schema,
        // and the webhook path relies on the database filling it in. It cannot
        // live in `defaults` — that object is spread, so every row would share
        // one frozen timestamp and both `orderBy: { receivedAt }` and the
        // 72-hour heartbeat window would stop meaning anything.
        receivedAt: new Date(),
        ...defaults,
        ...data,
      };
      rows.push(row);
      return { ...row };
    },
    async findUnique({ where }) {
      const r = rows.find((row) => matches(row, where));
      return r ? { ...r } : null;
    },
    async findFirst({ where, orderBy } = {}) {
      const hit = applyOrderBy(rows.filter((row) => matches(row, where)), orderBy);
      return hit.length ? { ...hit[0] } : null;
    },
    async findMany({ where, orderBy, take } = {}) {
      const hit = applyOrderBy(rows.filter((row) => matches(row, where)), orderBy);
      return (take == null ? hit : hit.slice(0, take)).map((r) => ({ ...r }));
    },
    async count({ where } = {}) {
      return rows.filter((row) => matches(row, where)).length;
    },
    async update({ where, data }) {
      const r = rows.find((row) => matches(row, where));
      if (!r) {
        const e = new Error('Record to update not found');
        e.code = 'P2025';
        throw e;
      }
      return { ...applyData(r, data) };
    },
    async updateMany({ where, data }) {
      const hit = rows.filter((row) => matches(row, where));
      hit.forEach((r) => applyData(r, data));
      return { count: hit.length };
    },
    /**
     * Upsert on a unique key. This is the SECOND idempotency layer of the money
     * path — `transId @unique` on the charge ledger — so it is modelled rather
     * than faked with a find-then-create, which would race in a way the real
     * upsert does not and would let a suite pass that production would not.
     */
    async upsert({ where, create, update }) {
      const existing = rows.find((row) => matches(row, where));
      if (existing) return { ...applyData(existing, update) };
      return this.create({ data: { ...where, ...create } });
    },
  };
}

export function makePrisma() {
  const db = {
    tenant: table('tenant'),
    appSetting: table('appSetting', { unique: [['key']] }),
    autopayInvite: table('autopayInvite', {
      defaults: {
        usedAt: null,
        revokedAt: null,
        openedAt: null,
        attempts: 0,
        cardBrand: null,
        cardLast4: null,
        arbSubscriptionId: null,
        customerProfileId: null,
        customerPaymentProfileId: null,
      },
      unique: [['tokenHash']],
    }),
    tenantSubscription: table('tenantSubscription', {
      defaults: {
        status: 'PENDING_AUTHORIZATION',
        currency: 'USD',
        arbSubscriptionId: null,
        customerProfileId: null,
        customerPaymentProfileId: null,
        cardBrand: null,
        cardLast4: null,
        trialEndsAt: null,
        failedAttempts: 0,
      },
      unique: [['arbSubscriptionId']],
      partialUnique: [{
        keys: ['tenantId'],
        // Mirrors the migration's WHERE clause exactly.
        where: (r) => !['CANCELLED', 'SUPERSEDED', 'EXPIRED'].includes(r.status),
      }],
    }),
    tenantSubscriptionCharge: table('tenantSubscriptionCharge', {
      // No `defaults` here on purpose. The nullable columns are all supplied
      // explicitly by their writers, and filling them in would change what an
      // unset column reads back as — which billing-enrollment.test.mjs asserts
      // on directly ("a transId before any transaction would be a fiction").
      unique: [['transId'], ['refId']],
    }),
    tenantSubscriptionEvent: table('tenantSubscriptionEvent', {
      defaults: {
        eventDate: null,
        arbSubscriptionId: null,
        transId: null,
        subscriptionId: null,
        signatureOk: true,
        processedAt: null,
        processingError: null,
        attempts: 0,
      },
      unique: [['notificationId']],
    }),
    // The service passes an ARRAY of already-started promises, exactly as the
    // real client accepts. This fake cannot roll back; the suites that care
    // about atomicity assert on the guards, not on the rollback.
    async $transaction(ops) {
      return Promise.all(ops);
    },
  };
  // appSetting.upsert, used by saveTenantPlanCatalog.
  db.appSetting.upsert = async ({ where, create, update }) => {
    const existing = db.appSetting.rows.find((r) => matches(r, where));
    if (existing) return { ...applyData(existing, update) };
    return db.appSetting.create({ data: create });
  };
  return db;
}

/** Audit recorder that captures rows so a suite can assert on what was logged. */
export function makeAuditSpy() {
  const rows = [];
  const recordAudit = async (entry) => { rows.push(entry); };
  return { rows, recordAudit };
}

export const silentLogger = {
  info() {}, warn() {}, error() {}, debug() {},
};
