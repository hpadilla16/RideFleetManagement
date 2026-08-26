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

function matchVal(val, cond) {
  const v = val ?? null;
  if (cond && typeof cond === 'object' && !(cond instanceof Date)) {
    if ('in' in cond) return cond.in.includes(v);
    if ('not' in cond) return v !== cond.not;
    if ('gt' in cond) return new Date(v).getTime() > new Date(cond.gt).getTime();
    if ('gte' in cond) return new Date(v).getTime() >= new Date(cond.gte).getTime();
    if ('lt' in cond) return new Date(v).getTime() < new Date(cond.lt).getTime();
    return true;
  }
  if (v instanceof Date || cond instanceof Date) {
    return v != null && cond != null && new Date(v).getTime() === new Date(cond).getTime();
  }
  return v === (cond ?? null);
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
    async findFirst({ where } = {}) {
      const r = rows.find((row) => matches(row, where));
      return r ? { ...r } : null;
    },
    async findMany({ where } = {}) {
      return rows.filter((row) => matches(row, where)).map((r) => ({ ...r }));
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
      unique: [['transId'], ['refId']],
    }),
    tenantSubscriptionEvent: table('tenantSubscriptionEvent', {
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
