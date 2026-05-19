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
  prisma.feeRate.findMany = async (args) => stubs.rows.filter((r) =>
    r.tenantId === args.where.tenantId && r.locationId === args.where.locationId);
  prisma.feeRate.findFirst = async (args) => stubs.rows.find((r) =>
    r.tenantId === args.where.tenantId && r.locationId === args.where.locationId && r.feeType === args.where.feeType) || null;
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
  prisma.$transaction = async (fn) => fn(prisma);
});

afterEach(async () => {
  prisma.feeRate.findMany = stubs.orig.findMany;
  prisma.feeRate.findFirst = stubs.orig.findFirst;
  prisma.feeRate.create = stubs.orig.create;
  prisma.feeRate.update = stubs.orig.update;
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
    assert.equal(res.status, 400);
  });
});
