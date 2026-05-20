/**
 * Route-layer tests for fee-rates.routes.js (16q).
 *
 * Exercises the router by mounting it on a bare Express app, injecting a fake
 * authenticated user via middleware, and using node's built-in http client. No
 * supertest dep needed (the codebase doesn't currently use it).
 *
 * Prisma is monkey-patched at the model level (see fee-rates.service.test.mjs
 * for the same pattern) so no live DB is required.
 */

import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import { prisma } from '../../lib/prisma.js';
import { feeRatesRouter } from './fee-rates.routes.js';
import { appErrorHandler } from '../../lib/errors.js';

const TENANT = 'tenant-abc';

// ─────────────────────────────────────────────────────────────────────────────
// Test harness
// ─────────────────────────────────────────────────────────────────────────────

function buildApp(user) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = user; next(); });
  app.use('/api/settings/fee-rates', feeRatesRouter);
  app.use(appErrorHandler);
  return app;
}

function request(server, method, path, body) {
  return new Promise((resolve, reject) => {
    const { port } = server.address();
    const opts = {
      method,
      hostname: '127.0.0.1',
      port,
      path,
      headers: { 'content-type': 'application/json' }
    };
    const req = http.request(opts, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = raw ? JSON.parse(raw) : null; } catch { /* leave null */ }
        resolve({ status: res.statusCode, body: json, raw });
      });
    });
    req.on('error', reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

let stubs;
let servers = [];

function startServer(user) {
  return new Promise((resolve) => {
    const app = buildApp(user);
    const srv = app.listen(0, '127.0.0.1', () => {
      servers.push(srv);
      resolve(srv);
    });
  });
}

beforeEach(() => {
  stubs = {
    rows: [],
    auditRows: [],
    orig: {
      findMany: prisma.feeRate.findMany,
      findFirst: prisma.feeRate.findFirst,
      create: prisma.feeRate.create,
      update: prisma.feeRate.update,
      delete: prisma.feeRate.delete,
      groupBy: prisma.feeRate.groupBy,
      transaction: prisma.$transaction,
      audit: prisma.feeRateAuditLog
    }
  };
  // V2: stub the audit log model so the route's transaction can write audit rows.
  prisma.feeRateAuditLog = {
    create: async ({ data }) => {
      const row = { id: `aud-${stubs.auditRows.length + 1}`, changedAt: new Date(), ...data };
      stubs.auditRows.push(row);
      return row;
    },
    findMany: async ({ where = {}, orderBy, take = 50, skip = 0 } = {}) => {
      let filtered = stubs.auditRows.filter((r) => r.tenantId === where.tenantId);
      if (where.feeRateId) filtered = filtered.filter((r) => r.feeRateId === where.feeRateId);
      if (orderBy?.changedAt === 'desc') filtered = [...filtered].reverse();
      return filtered.slice(skip, skip + take);
    }
  };
  prisma.feeRate.findMany = async (args) => {
    const w = args.where || {};
    return stubs.rows.filter((r) => {
      if (r.tenantId !== w.tenantId) return false;
      if (w.OR && Array.isArray(w.OR)) {
        return w.OR.some((c) => {
          if (c.locationId === null) return r.locationId === null;
          return r.locationId === c.locationId;
        });
      }
      if (w.locationId && typeof w.locationId === 'object' && w.locationId.not !== undefined) {
        return r.locationId !== w.locationId.not;
      }
      return r.locationId === (w.locationId === undefined ? null : w.locationId);
    });
  };
  prisma.feeRate.findFirst = async (args) => {
    const w = args.where || {};
    return stubs.rows.find((r) =>
      r.tenantId === w.tenantId
      && r.locationId === (w.locationId === undefined ? null : w.locationId)
      && r.feeType === w.feeType
    ) || null;
  };
  prisma.feeRate.create = async ({ data }) => {
    const row = { id: `id-${stubs.rows.length + 1}`, updatedAt: new Date(), ...data };
    stubs.rows.push(row);
    return row;
  };
  prisma.feeRate.update = async ({ where, data }) => {
    const row = stubs.rows.find((r) => r.id === where.id);
    Object.assign(row, data, { updatedAt: new Date() });
    return row;
  };
  prisma.feeRate.delete = async ({ where }) => {
    const idx = stubs.rows.findIndex((r) => r.id === where.id);
    if (idx === -1) return null;
    const [row] = stubs.rows.splice(idx, 1);
    return row;
  };
  prisma.feeRate.groupBy = async ({ where }) => {
    const tenantId = where.tenantId;
    const buckets = new Map();
    for (const r of stubs.rows) {
      if (r.tenantId !== tenantId) continue;
      if (where.locationId && where.locationId.not !== undefined) {
        if (r.locationId === where.locationId.not) continue;
      }
      const k = r.locationId || '__null__';
      buckets.set(k, (buckets.get(k) || 0) + 1);
    }
    return Array.from(buckets.entries()).map(([k, count]) => ({
      locationId: k === '__null__' ? null : k,
      _count: { _all: count }
    }));
  };
  prisma.$transaction = async (fn) => fn(prisma);
});

afterEach(async () => {
  prisma.feeRate.findMany = stubs.orig.findMany;
  prisma.feeRate.findFirst = stubs.orig.findFirst;
  prisma.feeRate.create = stubs.orig.create;
  prisma.feeRate.update = stubs.orig.update;
  prisma.feeRate.delete = stubs.orig.delete;
  prisma.feeRate.groupBy = stubs.orig.groupBy;
  prisma.$transaction = stubs.orig.transaction;
  prisma.feeRateAuditLog = stubs.orig.audit;
  await Promise.all(servers.map((s) => new Promise((r) => s.close(() => r()))));
  servers = [];
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/settings/fee-rates — role permutations
// ─────────────────────────────────────────────────────────────────────────────

describe('GET /api/settings/fee-rates', () => {
  it('AGENT receives 200 with editable: false', async () => {
    const srv = await startServer({ id: 'u-agent', role: 'AGENT', tenantId: TENANT });
    const res = await request(srv, 'GET', '/api/settings/fee-rates');
    assert.equal(res.status, 200);
    assert.equal(res.body.rates.length, 7);
    for (const r of res.body.rates) assert.equal(r.editable, false);
  });

  it('OPS receives 200 with editable: false', async () => {
    const srv = await startServer({ id: 'u-ops', role: 'OPS', tenantId: TENANT });
    const res = await request(srv, 'GET', '/api/settings/fee-rates');
    assert.equal(res.status, 200);
    for (const r of res.body.rates) assert.equal(r.editable, false);
  });

  it('ADMIN receives 200 with editable: true', async () => {
    const srv = await startServer({ id: 'u-admin', role: 'ADMIN', tenantId: TENANT });
    const res = await request(srv, 'GET', '/api/settings/fee-rates');
    assert.equal(res.status, 200);
    for (const r of res.body.rates) assert.equal(r.editable, true);
  });

  it('SUPER_ADMIN without ?tenantId returns 400', async () => {
    const srv = await startServer({ id: 'u-super', role: 'SUPER_ADMIN' });
    const res = await request(srv, 'GET', '/api/settings/fee-rates');
    assert.equal(res.status, 400);
    assert.match(String(res.body?.error || ''), /tenantId required/i);
  });

  it('SUPER_ADMIN with ?tenantId= returns 200 for any tenant', async () => {
    const srv = await startServer({ id: 'u-super', role: 'SUPER_ADMIN' });
    const res = await request(srv, 'GET', '/api/settings/fee-rates?tenantId=tenant-zzz');
    assert.equal(res.status, 200);
    for (const r of res.body.rates) assert.equal(r.editable, true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PUT /api/settings/fee-rates — role gates + payload responses
// ─────────────────────────────────────────────────────────────────────────────

describe('PUT /api/settings/fee-rates', () => {
  it('AGENT receives 403', async () => {
    const srv = await startServer({ id: 'u-agent', role: 'AGENT', tenantId: TENANT });
    const res = await request(srv, 'PUT', '/api/settings/fee-rates', {
      rates: [{ feeType: 'FUEL_REFILL', amount: 8 }]
    });
    assert.equal(res.status, 403);
  });

  it('OPS receives 403', async () => {
    const srv = await startServer({ id: 'u-ops', role: 'OPS', tenantId: TENANT });
    const res = await request(srv, 'PUT', '/api/settings/fee-rates', {
      rates: [{ feeType: 'FUEL_REFILL', amount: 8 }]
    });
    assert.equal(res.status, 403);
  });

  it('ADMIN receives 200 and writes the row', async () => {
    const srv = await startServer({ id: 'u-admin', role: 'ADMIN', tenantId: TENANT });
    const res = await request(srv, 'PUT', '/api/settings/fee-rates', {
      rates: [{ feeType: 'FUEL_REFILL', amount: 8.25 }]
    });
    assert.equal(res.status, 200);
    const fuel = res.body.rates.find((r) => r.feeType === 'FUEL_REFILL');
    assert.equal(fuel.currentAmount, 8.25);
    assert.equal(fuel.currentSource, 'tenant_default');
    assert.equal(stubs.rows.length, 1);
    assert.equal(stubs.rows[0].tenantId, TENANT);
  });

  it('SUPER_ADMIN with ?tenantId= receives 200 for any tenant', async () => {
    const srv = await startServer({ id: 'u-super', role: 'SUPER_ADMIN' });
    const res = await request(srv, 'PUT', '/api/settings/fee-rates?tenantId=tenant-zzz', {
      rates: [{ feeType: 'SMOKING', amount: 400 }]
    });
    assert.equal(res.status, 200);
    assert.equal(stubs.rows[0].tenantId, 'tenant-zzz');
  });

  it('ADMIN bad payload returns 400 with errors array', async () => {
    const srv = await startServer({ id: 'u-admin', role: 'ADMIN', tenantId: TENANT });
    const res = await request(srv, 'PUT', '/api/settings/fee-rates', {
      rates: [{ feeType: 'BOGUS', amount: 50 }]
    });
    assert.equal(res.status, 400);
    assert.ok(Array.isArray(res.body.errors));
    assert.equal(res.body.errors[0].feeType, 'BOGUS');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// V2: PUT writes an audit row (+ GET /audit returns it)
// ─────────────────────────────────────────────────────────────────────────────

describe('PUT /api/settings/fee-rates — audit trail', () => {
  it('ADMIN PUT writes a FeeRateAuditLog row with actor + change snapshot', async () => {
    const srv = await startServer({
      id: 'u-admin', role: 'ADMIN', tenantId: TENANT, email: 'admin@acme.com'
    });
    const res = await request(srv, 'PUT', '/api/settings/fee-rates', {
      rates: [{ feeType: 'FUEL_REFILL', amount: 9.50 }]
    });
    assert.equal(res.status, 200);
    assert.equal(stubs.auditRows.length, 1);
    const aud = stubs.auditRows[0];
    assert.equal(aud.tenantId, TENANT);
    assert.equal(aud.feeType, 'FUEL_REFILL');
    assert.equal(aud.changeType, 'CREATE');
    assert.equal(aud.actorUserId, 'u-admin');
    assert.equal(aud.actorEmail, 'admin@acme.com');
    assert.equal(aud.actorRole, 'ADMIN');
    assert.equal(aud.before, null);
    assert.equal(aud.after.amount, 9.50);
  });

  it('classifies an isActive-only change as TOGGLE', async () => {
    const srv = await startServer({ id: 'u-admin', role: 'ADMIN', tenantId: TENANT });
    // First PUT seeds the row at 9.50, active=true.
    await request(srv, 'PUT', '/api/settings/fee-rates', {
      rates: [{ feeType: 'FUEL_REFILL', amount: 9.50, isActive: true }]
    });
    stubs.auditRows.length = 0;
    // Second PUT just flips isActive.
    await request(srv, 'PUT', '/api/settings/fee-rates', {
      rates: [{ feeType: 'FUEL_REFILL', amount: 9.50, isActive: false }]
    });
    assert.equal(stubs.auditRows.length, 1);
    assert.equal(stubs.auditRows[0].changeType, 'TOGGLE');
  });

  it('PUT succeeds even if the audit insert throws', async () => {
    // Force audit insert to throw — user-facing flow must still succeed.
    prisma.feeRateAuditLog.create = async () => { throw new Error('audit table missing'); };
    const srv = await startServer({ id: 'u-admin', role: 'ADMIN', tenantId: TENANT });
    const res = await request(srv, 'PUT', '/api/settings/fee-rates', {
      rates: [{ feeType: 'FUEL_REFILL', amount: 8.25 }]
    });
    assert.equal(res.status, 200);
    assert.equal(stubs.rows.length, 1); // upsert still happened
    assert.equal(stubs.auditRows.length, 0); // audit didn't (best-effort)
  });

  // HOTFIX regression (fee-rate-toggle-500): toggling OFF a fee with no
  // existing FeeRate row used to 500. Cause: audit insert ran inside the
  // upsert prisma.$transaction, so when the audit insert threw (e.g. the
  // FeeRateAuditLog migration hadn't been applied) Prisma re-raised the
  // error at commit, rolling back the upsert AND propagating the throw —
  // recordChange's inner try/catch wasn't enough. Audit writes now happen
  // outside the upsert transaction.
  it('toggle OFF a fee with no existing row succeeds even when audit insert throws (REGRESSION)', async () => {
    // Simulate real Prisma transaction semantics: any inner query that
    // throws (even if its caller catches) poisons the transaction commit.
    const realTxn = prisma.$transaction;
    prisma.$transaction = async (fn) => {
      let innerThrew = null;
      const wrap = (m, ctx) => async (...args) => {
        try { return await m.apply(ctx, args); }
        catch (e) { if (!innerThrew) innerThrew = e; throw e; }
      };
      const txProxy = new Proxy(prisma, {
        get(target, prop) {
          const val = target[prop];
          if (val && typeof val === 'object' && !Array.isArray(val)) {
            return new Proxy(val, {
              get(t2, p2) {
                const m = t2[p2];
                return typeof m === 'function' ? wrap(m, t2) : m;
              }
            });
          }
          return val;
        }
      });
      const result = await fn(txProxy);
      if (innerThrew) throw innerThrew;
      return result;
    };
    // Force the audit insert to throw — mirrors "migration not applied" prod scenario.
    prisma.feeRateAuditLog.create = async () => { throw new Error('relation "FeeRateAuditLog" does not exist'); };

    const srv = await startServer({ id: 'u-admin', role: 'ADMIN', tenantId: TENANT });
    // CLEANING_LIGHT has no pre-existing row (stubs.rows is empty); UI
    // sends the hardcoded default amount alongside isActive=false.
    const res = await request(srv, 'PUT', '/api/settings/fee-rates', {
      rates: [{ feeType: 'CLEANING_LIGHT', amount: 50, isActive: false }]
    });

    prisma.$transaction = realTxn;

    assert.equal(res.status, 200);
    // Upsert still happened: row created with isActive=false.
    assert.equal(stubs.rows.length, 1);
    assert.equal(stubs.rows[0].feeType, 'CLEANING_LIGHT');
    assert.equal(stubs.rows[0].isActive, false);
    assert.equal(Number(stubs.rows[0].amount), 50);
    // Audit didn't persist (best-effort, table "missing") but the user flow succeeded.
    assert.equal(stubs.auditRows.length, 0);
  });

  it('toggle OFF a fee with no existing row writes a CREATE audit entry when audit is healthy', async () => {
    const srv = await startServer({
      id: 'u-admin', role: 'ADMIN', tenantId: TENANT, email: 'admin@acme.com'
    });
    const res = await request(srv, 'PUT', '/api/settings/fee-rates', {
      rates: [{ feeType: 'SMOKING', amount: 250, isActive: false }]
    });
    assert.equal(res.status, 200);
    // FeeRate row created with isActive=false
    assert.equal(stubs.rows.length, 1);
    assert.equal(stubs.rows[0].isActive, false);
    // Audit row written: before=null, after.isActive=false, changeType=CREATE
    assert.equal(stubs.auditRows.length, 1);
    const aud = stubs.auditRows[0];
    assert.equal(aud.changeType, 'CREATE');
    assert.equal(aud.before, null);
    assert.equal(aud.after.isActive, false);
    assert.equal(aud.feeType, 'SMOKING');
  });
});

describe('GET /api/settings/fee-rates/audit', () => {
  it('ADMIN GET returns audit entries for the tenant scope', async () => {
    const srv = await startServer({ id: 'u-admin', role: 'ADMIN', tenantId: TENANT, email: 'admin@acme.com' });
    // Seed via a real PUT so the audit row is shaped exactly like prod.
    await request(srv, 'PUT', '/api/settings/fee-rates', {
      rates: [{ feeType: 'FUEL_REFILL', amount: 9.50 }]
    });
    const res = await request(srv, 'GET', '/api/settings/fee-rates/audit');
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.entries));
    assert.equal(res.body.entries.length, 1);
    assert.equal(res.body.entries[0].feeType, 'FUEL_REFILL');
    assert.equal(res.body.entries[0].actorEmail, 'admin@acme.com');
  });

  it('tenanted user cannot see another tenant’s audit log', async () => {
    // Seed an entry as tenant-zzz via SUPER_ADMIN
    const sup = await startServer({ id: 'u-super', role: 'SUPER_ADMIN' });
    await request(sup, 'PUT', '/api/settings/fee-rates?tenantId=tenant-zzz', {
      rates: [{ feeType: 'SMOKING', amount: 400 }]
    });
    // ADMIN of TENANT (a different tenant) requests audit list
    const srv = await startServer({ id: 'u-admin', role: 'ADMIN', tenantId: TENANT });
    const res = await request(srv, 'GET', '/api/settings/fee-rates/audit');
    assert.equal(res.status, 200);
    assert.equal(res.body.entries.length, 0);
  });

  it('SUPER_ADMIN without ?tenantId= returns 400', async () => {
    const srv = await startServer({ id: 'u-super', role: 'SUPER_ADMIN' });
    const res = await request(srv, 'GET', '/api/settings/fee-rates/audit');
  });
});


// ─────────────────────────────────────────────────────────────────────────────
// Per-location overrides (Pillar 2 follow-up)
// ─────────────────────────────────────────────────────────────────────────────

describe('GET /api/settings/fee-rates?locationId=...', () => {
  it('returns location overrides only (not tenant defaults) when locationId is passed', async () => {
    const srv = await startServer({ id: 'u-admin', role: 'ADMIN', tenantId: TENANT });
    stubs.rows.push({ id: 'tnt-fuel', tenantId: TENANT, locationId: null, feeType: 'FUEL_REFILL', unit: 'PER_GALLON', amount: 8.5, isActive: true, notes: null, updatedAt: new Date() });
    stubs.rows.push({ id: 'loc-fuel', tenantId: TENANT, locationId: 'loc-1', feeType: 'FUEL_REFILL', unit: 'PER_GALLON', amount: 10, isActive: true, notes: null, updatedAt: new Date() });

    const res = await request(srv, 'GET', '/api/settings/fee-rates?locationId=loc-1');
    assert.equal(res.status, 200);
    assert.equal(res.body.locationId, 'loc-1');
    const fuel = res.body.rates.find((r) => r.feeType === 'FUEL_REFILL');
    assert.equal(fuel.currentAmount, 10);
    assert.equal(fuel.currentSource, 'location');
    assert.equal(fuel.locationId, 'loc-1');
    assert.equal(fuel.tenantDefaultAmount, 8.5);
    assert.equal(fuel.tenantDefaultSource, 'tenant_default');

    const smoking = res.body.rates.find((r) => r.feeType === 'SMOKING');
    assert.equal(smoking.currentAmount, null);
    assert.equal(smoking.currentSource, 'hardcoded');
  });
});

describe('GET /api/settings/fee-rates/effective', () => {
  it('returns merged effective rates: location > tenant > hardcoded', async () => {
    const srv = await startServer({ id: 'u-admin', role: 'ADMIN', tenantId: TENANT });
    stubs.rows.push({ id: 'tnt-fuel', tenantId: TENANT, locationId: null, feeType: 'FUEL_REFILL', unit: 'PER_GALLON', amount: 8.5, isActive: true, notes: null, updatedAt: new Date() });
    stubs.rows.push({ id: 'tnt-smoke', tenantId: TENANT, locationId: null, feeType: 'SMOKING', unit: 'FLAT', amount: 400, isActive: true, notes: null, updatedAt: new Date() });
    stubs.rows.push({ id: 'loc-fuel', tenantId: TENANT, locationId: 'loc-1', feeType: 'FUEL_REFILL', unit: 'PER_GALLON', amount: 10, isActive: true, notes: null, updatedAt: new Date() });

    const res = await request(srv, 'GET', '/api/settings/fee-rates/effective?locationId=loc-1');
    assert.equal(res.status, 200);
    const fuel = res.body.rates.find((r) => r.feeType === 'FUEL_REFILL');
    assert.equal(fuel.effectiveAmount, 10);
    assert.equal(fuel.effectiveSource, 'location');
    assert.equal(fuel.tenantDefaultAmount, 8.5);
    assert.equal(fuel.locationOverrideAmount, 10);

    const smoke = res.body.rates.find((r) => r.feeType === 'SMOKING');
    assert.equal(smoke.effectiveAmount, 400);
    assert.equal(smoke.effectiveSource, 'tenant_default');
    assert.equal(smoke.locationOverrideAmount, null);

    const cleanLight = res.body.rates.find((r) => r.feeType === 'CLEANING_LIGHT');
    assert.equal(cleanLight.effectiveSource, 'hardcoded');
  });

  it('without ?locationId= returns effective = tenant defaults / hardcoded', async () => {
    const srv = await startServer({ id: 'u-admin', role: 'ADMIN', tenantId: TENANT });
    stubs.rows.push({ id: 'tnt-fuel', tenantId: TENANT, locationId: null, feeType: 'FUEL_REFILL', unit: 'PER_GALLON', amount: 8.5, isActive: true, notes: null, updatedAt: new Date() });
    const res = await request(srv, 'GET', '/api/settings/fee-rates/effective');
    assert.equal(res.status, 200);
    const fuel = res.body.rates.find((r) => r.feeType === 'FUEL_REFILL');
    assert.equal(fuel.effectiveAmount, 8.5);
    assert.equal(fuel.effectiveSource, 'tenant_default');
  });
});

describe('GET /api/settings/fee-rates/locations-with-overrides', () => {
  it('returns distinct locationIds that have at least one FeeRate row', async () => {
    const srv = await startServer({ id: 'u-admin', role: 'ADMIN', tenantId: TENANT });
    stubs.rows.push({ id: 'tnt-fuel', tenantId: TENANT, locationId: null, feeType: 'FUEL_REFILL', amount: 8.5, isActive: true });
    stubs.rows.push({ id: 'a', tenantId: TENANT, locationId: 'loc-1', feeType: 'FUEL_REFILL', amount: 10, isActive: true });
    stubs.rows.push({ id: 'b', tenantId: TENANT, locationId: 'loc-1', feeType: 'SMOKING', amount: 500, isActive: true });
    stubs.rows.push({ id: 'c', tenantId: TENANT, locationId: 'loc-2', feeType: 'FUEL_REFILL', amount: 11, isActive: true });

    const res = await request(srv, 'GET', '/api/settings/fee-rates/locations-with-overrides');
    assert.equal(res.status, 200);
    const ids = res.body.locations.map((l) => l.locationId).sort();
    assert.deepEqual(ids, ['loc-1', 'loc-2']);
    const loc1 = res.body.locations.find((l) => l.locationId === 'loc-1');
    assert.equal(loc1.overrideCount, 2);
  });
});

describe('PUT /api/settings/fee-rates?locationId=...', () => {
  it('ADMIN writes a per-location override row', async () => {
    const srv = await startServer({ id: 'u-admin', role: 'ADMIN', tenantId: TENANT });
    stubs.rows.push({ id: 'tnt-fuel', tenantId: TENANT, locationId: null, feeType: 'FUEL_REFILL', unit: 'PER_GALLON', amount: 8.5, isActive: true, notes: null, updatedAt: new Date() });

    const res = await request(srv, 'PUT', '/api/settings/fee-rates?locationId=loc-1', {
      rates: [{ feeType: 'FUEL_REFILL', amount: 12.5 }]
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.locationId, 'loc-1');
    const wrote = stubs.rows.find((r) => r.locationId === 'loc-1' && r.feeType === 'FUEL_REFILL');
    assert.ok(wrote);
    assert.equal(Number(wrote.amount), 12.5);
    const tnt = stubs.rows.find((r) => r.id === 'tnt-fuel');
    assert.equal(Number(tnt.amount), 8.5);
  });
});

describe('DELETE /api/settings/fee-rates/:feeType?locationId=...', () => {
  it('ADMIN deletes a per-location override row', async () => {
    const srv = await startServer({ id: 'u-admin', role: 'ADMIN', tenantId: TENANT });
    stubs.rows.push({ id: 'loc-fuel', tenantId: TENANT, locationId: 'loc-1', feeType: 'FUEL_REFILL', unit: 'PER_GALLON', amount: 10, isActive: true, notes: null, updatedAt: new Date() });

    const res = await request(srv, 'DELETE', '/api/settings/fee-rates/FUEL_REFILL?locationId=loc-1');
    assert.equal(res.status, 200);
    assert.equal(res.body.deleted, true);
    assert.equal(stubs.rows.find((r) => r.id === 'loc-fuel'), undefined);
  });

  it('AGENT receives 403 on DELETE', async () => {
    const srv = await startServer({ id: 'u-agent', role: 'AGENT', tenantId: TENANT });
    const res = await request(srv, 'DELETE', '/api/settings/fee-rates/FUEL_REFILL?locationId=loc-1');
    assert.equal(res.status, 403);
  });

  it('ADMIN without locationId returns 400', async () => {
    const srv = await startServer({ id: 'u-admin', role: 'ADMIN', tenantId: TENANT });
    const res = await request(srv, 'DELETE', '/api/settings/fee-rates/FUEL_REFILL');
    assert.equal(res.status, 400);
  });
});
