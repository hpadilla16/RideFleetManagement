/**
 * Tests for feature-flags.js (2026-05-21).
 * Run: node --test backend/src/lib/feature-flags.test.mjs
 *
 * Uses an in-memory fake Prisma so tests don't need a database.
 * Imports the real cache module — flushed between tests to avoid
 * cross-test bleed.
 */

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  getTenantFlag,
  getTenantFlags,
  setTenantFlag,
  resolveFlag,
  isFeatureOnForUser,
  listTenantAuditLog,
  FeatureFlagError,
  FLAG_STATE,
  VALID_STATES,
  AUDIT_ACTION_FLAG_CHANGED,
} from './feature-flags.js';
import { cache } from './cache.js';

// ---------------------------------------------------------------------------
// In-memory fake Prisma
// ---------------------------------------------------------------------------

function makeFakePrisma({ tenants = [], audits = [] } = {}) {
  let nextId = 1;
  return {
    _state: { tenants, audits },
    tenant: {
      async findUnique({ where, select }) {
        const t = tenants.find((x) => x.id === where.id);
        if (!t) return null;
        if (!select) return t;
        const out = {};
        for (const k of Object.keys(select)) if (select[k]) out[k] = t[k];
        return out;
      },
      async update({ where, data }) {
        const idx = tenants.findIndex((x) => x.id === where.id);
        if (idx === -1) throw new Error('Tenant not found');
        tenants[idx] = { ...tenants[idx], ...data };
        return tenants[idx];
      },
    },
    tenantAuditLog: {
      async create({ data }) {
        const row = {
          id: `tal_${nextId++}`,
          createdAt: new Date(),
          ...data,
        };
        audits.push(row);
        return row;
      },
      async findMany({ where, orderBy, take, include }) {
        let rows = audits.filter((a) => {
          if (where?.tenantId && a.tenantId !== where.tenantId) return false;
          if (where?.action && a.action !== where.action) return false;
          return true;
        });
        if (orderBy?.createdAt === 'desc') {
          rows = rows.slice().sort((a, b) => b.createdAt - a.createdAt);
        }
        if (take) rows = rows.slice(0, take);
        return rows;
      },
    },
    $transaction: async function (fn) {
      return fn(this);
    },
  };
}

// Flush the cache between tests so state from one doesn't leak into another.
beforeEach(() => {
  // Use the cache.invalidate hook to clear ALL keys cheaply.
  cache.invalidate('t:');
  cache.invalidate('global:');
});

// ---------------------------------------------------------------------------
// Constants exposure
// ---------------------------------------------------------------------------

test('FLAG_STATE exposes OFF, TEST, LIVE', () => {
  assert.deepEqual(Object.keys(FLAG_STATE).sort(), ['LIVE', 'OFF', 'TEST']);
});

test('VALID_STATES matches FLAG_STATE keys', () => {
  assert.deepEqual([...VALID_STATES].sort(), ['LIVE', 'OFF', 'TEST']);
});

test('AUDIT_ACTION_FLAG_CHANGED is the canonical action string', () => {
  assert.equal(AUDIT_ACTION_FLAG_CHANGED, 'FEATURE_FLAG_CHANGED');
});

// ---------------------------------------------------------------------------
// resolveFlag — pure function, no async
// ---------------------------------------------------------------------------

test('resolveFlag returns true for LIVE regardless of role', () => {
  assert.equal(resolveFlag('LIVE', { role: 'AGENT' }), true);
  assert.equal(resolveFlag('LIVE', { role: 'SUPER_ADMIN' }), true);
  assert.equal(resolveFlag('LIVE', null), true);
});

test('resolveFlag returns true for TEST only when role=SUPER_ADMIN', () => {
  assert.equal(resolveFlag('TEST', { role: 'SUPER_ADMIN' }), true);
  assert.equal(resolveFlag('TEST', { role: 'ADMIN' }), false);
  assert.equal(resolveFlag('TEST', { role: 'AGENT' }), false);
  assert.equal(resolveFlag('TEST', { role: 'OPS' }), false);
  assert.equal(resolveFlag('TEST', null), false);
  assert.equal(resolveFlag('TEST', undefined), false);
});

test('resolveFlag returns false for OFF regardless of role', () => {
  assert.equal(resolveFlag('OFF', { role: 'SUPER_ADMIN' }), false);
  assert.equal(resolveFlag('OFF', { role: 'AGENT' }), false);
});

test('resolveFlag returns false for unknown state (defensive)', () => {
  assert.equal(resolveFlag('SOMETHING_ELSE', { role: 'SUPER_ADMIN' }), false);
  assert.equal(resolveFlag(undefined, { role: 'SUPER_ADMIN' }), false);
});

// ---------------------------------------------------------------------------
// getTenantFlag(s) — default OFF, JSON parsing, sanitization
// ---------------------------------------------------------------------------

test('getTenantFlag returns OFF when tenant has no settings', async () => {
  const prisma = makeFakePrisma({ tenants: [{ id: 't1', settingsJson: null }] });
  assert.equal(await getTenantFlag('t1', 'anyFlag', { prisma }), 'OFF');
});

test('getTenantFlag returns OFF when tenant does not exist', async () => {
  const prisma = makeFakePrisma({ tenants: [] });
  assert.equal(await getTenantFlag('t_missing', 'anyFlag', { prisma }), 'OFF');
});

test('getTenantFlag returns OFF when flag is absent', async () => {
  const prisma = makeFakePrisma({
    tenants: [
      {
        id: 't1',
        settingsJson: { featureFlags: { otherFlag: 'LIVE' } },
      },
    ],
  });
  assert.equal(await getTenantFlag('t1', 'missingFlag', { prisma }), 'OFF');
  assert.equal(await getTenantFlag('t1', 'otherFlag', { prisma }), 'LIVE');
});

test('getTenantFlag handles settingsJson stored as a JSON string', async () => {
  const prisma = makeFakePrisma({
    tenants: [
      {
        id: 't1',
        settingsJson: JSON.stringify({ featureFlags: { dejavooCounter: 'TEST' } }),
      },
    ],
  });
  assert.equal(await getTenantFlag('t1', 'dejavooCounter', { prisma }), 'TEST');
});

test('getTenantFlags drops invalid stored states (defensive)', async () => {
  const prisma = makeFakePrisma({
    tenants: [
      {
        id: 't1',
        settingsJson: {
          featureFlags: {
            goodFlag: 'LIVE',
            badFlag: 'WHATEVER',
            anotherGood: 'TEST',
          },
        },
      },
    ],
  });
  const flags = await getTenantFlags('t1', { prisma });
  assert.deepEqual(flags, { goodFlag: 'LIVE', anotherGood: 'TEST' });
});

test('getTenantFlags caches across consecutive reads', async () => {
  let dbReads = 0;
  const prisma = makeFakePrisma({
    tenants: [{ id: 't1', settingsJson: { featureFlags: { f: 'TEST' } } }],
  });
  const origFind = prisma.tenant.findUnique;
  prisma.tenant.findUnique = async (...args) => {
    dbReads += 1;
    return origFind.apply(prisma.tenant, args);
  };
  await getTenantFlags('t1', { prisma });
  await getTenantFlags('t1', { prisma });
  await getTenantFlag('t1', 'f', { prisma });
  assert.equal(dbReads, 1, 'expected one DB read across 3 calls');
});

// ---------------------------------------------------------------------------
// setTenantFlag — validation, audit, idempotency, cache invalidation
// ---------------------------------------------------------------------------

test('setTenantFlag rejects invalid flag name', async () => {
  const prisma = makeFakePrisma({ tenants: [{ id: 't1', settingsJson: {} }] });
  await assert.rejects(
    () => setTenantFlag('t1', 'has-dashes', 'LIVE', { prisma }),
    /Invalid flag name/
  );
  await assert.rejects(
    () => setTenantFlag('t1', 'UPPERCASE_START', 'LIVE', { prisma }),
    /Invalid flag name/
  );
  await assert.rejects(
    () => setTenantFlag('t1', '', 'LIVE', { prisma }),
    /Invalid flag name/
  );
});

test('setTenantFlag rejects invalid state', async () => {
  const prisma = makeFakePrisma({ tenants: [{ id: 't1', settingsJson: {} }] });
  await assert.rejects(
    () => setTenantFlag('t1', 'goodName', 'NOPE', { prisma }),
    /Invalid flag state/
  );
});

test('setTenantFlag throws 404 when tenant missing', async () => {
  const prisma = makeFakePrisma({ tenants: [] });
  await assert.rejects(
    () => setTenantFlag('t_nope', 'goodName', 'LIVE', { prisma }),
    (err) => err instanceof FeatureFlagError && err.status === 404
  );
});

test('setTenantFlag writes the flag + audit row', async () => {
  const prisma = makeFakePrisma({ tenants: [{ id: 't1', settingsJson: {} }] });
  const result = await setTenantFlag('t1', 'dejavooCounter', 'TEST', {
    prisma,
    actorUserId: 'u_hector',
  });
  assert.equal(result.flag, 'dejavooCounter');
  assert.equal(result.from, 'OFF');
  assert.equal(result.to, 'TEST');
  assert.equal(result.noop, false);

  // Tenant was updated
  const t = prisma._state.tenants[0];
  assert.equal(t.settingsJson.featureFlags.dejavooCounter, 'TEST');

  // Audit row written
  assert.equal(prisma._state.audits.length, 1);
  const audit = prisma._state.audits[0];
  assert.equal(audit.action, 'FEATURE_FLAG_CHANGED');
  assert.equal(audit.actorUserId, 'u_hector');
  assert.equal(audit.resource, 'dejavooCounter');
  assert.equal(audit.payload.flag, 'dejavooCounter');
  assert.equal(audit.payload.from, 'OFF');
  assert.equal(audit.payload.to, 'TEST');
});

test('setTenantFlag is a no-op (but still audits) when state unchanged', async () => {
  const prisma = makeFakePrisma({
    tenants: [
      { id: 't1', settingsJson: { featureFlags: { dejavooCounter: 'LIVE' } } },
    ],
  });
  const result = await setTenantFlag('t1', 'dejavooCounter', 'LIVE', { prisma });
  assert.equal(result.noop, true);
  assert.equal(prisma._state.audits.length, 1);
  assert.equal(prisma._state.audits[0].payload.noop, true);
});

test('setTenantFlag preserves other flags + settings (only flips the named flag)', async () => {
  const prisma = makeFakePrisma({
    tenants: [
      {
        id: 't1',
        settingsJson: {
          featureFlags: { interactiveTC: 'TEST', dejavooCounter: 'OFF' },
          someOtherSetting: 'hello',
        },
      },
    ],
  });
  await setTenantFlag('t1', 'dejavooCounter', 'LIVE', { prisma });
  const settings = prisma._state.tenants[0].settingsJson;
  assert.equal(settings.featureFlags.interactiveTC, 'TEST', 'sibling flag preserved');
  assert.equal(settings.featureFlags.dejavooCounter, 'LIVE');
  assert.equal(settings.someOtherSetting, 'hello', 'non-flag settings preserved');
});

test('setTenantFlag invalidates the cache (subsequent read sees new state)', async () => {
  const prisma = makeFakePrisma({ tenants: [{ id: 't1', settingsJson: {} }] });
  // Prime cache
  assert.equal(await getTenantFlag('t1', 'dejavooCounter', { prisma }), 'OFF');
  // Flip it
  await setTenantFlag('t1', 'dejavooCounter', 'LIVE', { prisma });
  // Read again — should see LIVE, not stale OFF
  assert.equal(await getTenantFlag('t1', 'dejavooCounter', { prisma }), 'LIVE');
});

// ---------------------------------------------------------------------------
// isFeatureOnForUser — convenience combining getTenantFlag + resolveFlag
// ---------------------------------------------------------------------------

test('isFeatureOnForUser composes the two checks correctly', async () => {
  const prisma = makeFakePrisma({
    tenants: [
      {
        id: 't1',
        settingsJson: {
          featureFlags: {
            liveFlag: 'LIVE',
            testFlag: 'TEST',
            offFlag: 'OFF',
          },
        },
      },
    ],
  });
  const agent = { role: 'AGENT' };
  const admin = { role: 'SUPER_ADMIN' };

  assert.equal(await isFeatureOnForUser('t1', 'liveFlag', agent, { prisma }), true);
  assert.equal(await isFeatureOnForUser('t1', 'liveFlag', admin, { prisma }), true);

  assert.equal(await isFeatureOnForUser('t1', 'testFlag', agent, { prisma }), false);
  assert.equal(await isFeatureOnForUser('t1', 'testFlag', admin, { prisma }), true);

  assert.equal(await isFeatureOnForUser('t1', 'offFlag', agent, { prisma }), false);
  assert.equal(await isFeatureOnForUser('t1', 'offFlag', admin, { prisma }), false);

  // Unknown flag → defaults to OFF
  assert.equal(await isFeatureOnForUser('t1', 'unknownFlag', admin, { prisma }), false);
});

// ---------------------------------------------------------------------------
// listTenantAuditLog
// ---------------------------------------------------------------------------

test('listTenantAuditLog returns recent rows in desc order', async () => {
  const prisma = makeFakePrisma({ tenants: [{ id: 't1', settingsJson: {} }] });
  await setTenantFlag('t1', 'a', 'TEST', { prisma });
  // Ensure distinct timestamps (the fake uses new Date() so they're close)
  await new Promise((r) => setTimeout(r, 5));
  await setTenantFlag('t1', 'b', 'LIVE', { prisma });
  const rows = await listTenantAuditLog('t1', { prisma, limit: 10 });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].resource, 'b', 'most recent first');
  assert.equal(rows[1].resource, 'a');
});

test('listTenantAuditLog filters by action', async () => {
  const prisma = makeFakePrisma({ tenants: [{ id: 't1', settingsJson: {} }] });
  await setTenantFlag('t1', 'a', 'TEST', { prisma });
  // Add a different action via direct insert
  await prisma.tenantAuditLog.create({
    data: { tenantId: 't1', action: 'SOMETHING_ELSE', resource: 'x', payload: {} },
  });
  const flagOnly = await listTenantAuditLog('t1', {
    prisma,
    action: 'FEATURE_FLAG_CHANGED',
  });
  assert.equal(flagOnly.length, 1);
  assert.equal(flagOnly[0].resource, 'a');
});

test('listTenantAuditLog returns [] for missing tenantId', async () => {
  const prisma = makeFakePrisma({});
  const rows = await listTenantAuditLog('', { prisma });
  assert.deepEqual(rows, []);
});
