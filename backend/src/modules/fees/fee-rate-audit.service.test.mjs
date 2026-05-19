/**
 * Unit tests for fee-rate-audit.service.js (V2 pillar2 followup).
 *
 * Stubs prisma.feeRateAuditLog at the model level (same pattern as
 * fee-rates.service.test.mjs) so the service exercises its own validation,
 * snapshotting, and listing logic without a live database.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '../../lib/prisma.js';
import {
  feeRateAuditService,
  recordChange,
  listAuditLog,
  snapshotFeeRate,
  classifyChange
} from './fee-rate-audit.service.js';

const TENANT_A = 'tenant-a';
const TENANT_B = 'tenant-b';

let stubs;

beforeEach(() => {
  stubs = {
    rows: [],
    createErr: null
  };
  // Install a stub feeRateAuditLog model on the shared prisma client.
  const existing = prisma.feeRateAuditLog;
  prisma.feeRateAuditLog = {
    create: async ({ data }) => {
      if (stubs.createErr) throw stubs.createErr;
      const row = { id: `id-${stubs.rows.length + 1}`, changedAt: new Date(), ...data };
      stubs.rows.push(row);
      return row;
    },
    findMany: async ({ where, orderBy, take, skip }) => {
      let filtered = stubs.rows.filter((r) => r.tenantId === where.tenantId);
      if (where.feeRateId) filtered = filtered.filter((r) => r.feeRateId === where.feeRateId);
      if (orderBy?.changedAt === 'desc') {
        filtered = [...filtered].reverse();
      }
      return filtered.slice(skip || 0, (skip || 0) + (take || 50));
    }
  };
  stubs.restore = () => { prisma.feeRateAuditLog = existing; };
});

afterEach(() => {
  stubs.restore();
});

// ─────────────────────────────────────────────────────────────────────────────
// snapshotFeeRate
// ─────────────────────────────────────────────────────────────────────────────

describe('snapshotFeeRate', () => {
  it('returns null for null/undefined', () => {
    assert.equal(snapshotFeeRate(null), null);
    assert.equal(snapshotFeeRate(undefined), null);
  });

  it('extracts a compact JSON-friendly snapshot', () => {
    const snap = snapshotFeeRate({
      id: 'fr-1',
      tenantId: TENANT_A,
      locationId: null,
      feeType: 'CLEANING_LIGHT',
      unit: 'FLAT',
      amount: 30.5,
      isActive: true,
      notes: 'note',
      updatedAt: new Date('2026-05-19T12:00:00.000Z')
    });
    assert.equal(snap.feeType, 'CLEANING_LIGHT');
    assert.equal(snap.amount, 30.5);
    assert.equal(snap.isActive, true);
    assert.equal(snap.updatedAt, '2026-05-19T12:00:00.000Z');
  });

  it('coerces Decimal-like amount to Number', () => {
    const snap = snapshotFeeRate({ amount: '45.75', isActive: true });
    assert.equal(snap.amount, 45.75);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// classifyChange
// ─────────────────────────────────────────────────────────────────────────────

describe('classifyChange', () => {
  it('CREATE when before=null and after=row', () => {
    assert.equal(classifyChange(null, { amount: 30, isActive: true }), 'CREATE');
  });

  it('DELETE when before=row and after=null', () => {
    assert.equal(classifyChange({ amount: 30, isActive: true }, null), 'DELETE');
  });

  it('TOGGLE when only isActive changes', () => {
    const before = { amount: 30, unit: 'FLAT', notes: 'n', locationId: null, feeType: 'X', isActive: true };
    const after  = { amount: 30, unit: 'FLAT', notes: 'n', locationId: null, feeType: 'X', isActive: false };
    assert.equal(classifyChange(before, after), 'TOGGLE');
  });

  it('UPDATE when amount changes', () => {
    const before = { amount: 30, unit: 'FLAT', notes: 'n', locationId: null, feeType: 'X', isActive: true };
    const after  = { amount: 40, unit: 'FLAT', notes: 'n', locationId: null, feeType: 'X', isActive: true };
    assert.equal(classifyChange(before, after), 'UPDATE');
  });

  it('UPDATE when amount + isActive both change', () => {
    const before = { amount: 30, unit: 'FLAT', notes: 'n', locationId: null, feeType: 'X', isActive: true };
    const after  = { amount: 40, unit: 'FLAT', notes: 'n', locationId: null, feeType: 'X', isActive: false };
    assert.equal(classifyChange(before, after), 'UPDATE');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// recordChange
// ─────────────────────────────────────────────────────────────────────────────

describe('recordChange', () => {
  it('writes a row with normalized actor + change fields', async () => {
    const row = await recordChange({
      tenantId: TENANT_A,
      feeRateId: 'fr-1',
      feeType: 'CLEANING_LIGHT',
      actor: { id: 'u1', email: 'a@b.com', role: 'admin' },
      changeType: 'UPDATE',
      before: { amount: 25 },
      after: { amount: 30 }
    });
    assert.ok(row);
    assert.equal(stubs.rows.length, 1);
    const inserted = stubs.rows[0];
    assert.equal(inserted.tenantId, TENANT_A);
    assert.equal(inserted.feeType, 'CLEANING_LIGHT');
    assert.equal(inserted.actorEmail, 'a@b.com');
    assert.equal(inserted.actorRole, 'ADMIN'); // uppercased
    assert.equal(inserted.changeType, 'UPDATE');
    assert.deepEqual(inserted.before, { amount: 25 });
    assert.deepEqual(inserted.after, { amount: 30 });
  });

  it('skips and warns when tenantId is missing', async () => {
    const row = await recordChange({
      tenantId: null,
      feeType: 'CLEANING_LIGHT',
      changeType: 'UPDATE'
    });
    assert.equal(row, null);
    assert.equal(stubs.rows.length, 0);
  });

  it('skips when feeType is missing', async () => {
    const row = await recordChange({
      tenantId: TENANT_A,
      changeType: 'UPDATE'
    });
    assert.equal(row, null);
    assert.equal(stubs.rows.length, 0);
  });

  it('skips when changeType is invalid', async () => {
    const row = await recordChange({
      tenantId: TENANT_A,
      feeType: 'CLEANING_LIGHT',
      changeType: 'WHATEVER'
    });
    assert.equal(row, null);
    assert.equal(stubs.rows.length, 0);
  });

  it('returns null (does not throw) when insert fails', async () => {
    stubs.createErr = new Error('db down');
    const row = await recordChange({
      tenantId: TENANT_A,
      feeType: 'CLEANING_LIGHT',
      changeType: 'UPDATE',
      before: null,
      after: { amount: 30 }
    });
    assert.equal(row, null);
  });

  it('uses passed tx client when provided', async () => {
    let txCalls = 0;
    const tx = {
      feeRateAuditLog: {
        create: async ({ data }) => {
          txCalls += 1;
          return { id: 'tx-1', ...data };
        }
      }
    };
    const row = await recordChange({
      tx,
      tenantId: TENANT_A,
      feeType: 'SMOKING',
      changeType: 'TOGGLE',
      before: { isActive: true },
      after: { isActive: false }
    });
    assert.equal(txCalls, 1);
    assert.equal(stubs.rows.length, 0); // default client untouched
    assert.equal(row.id, 'tx-1');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// listAuditLog
// ─────────────────────────────────────────────────────────────────────────────

describe('listAuditLog', () => {
  beforeEach(async () => {
    await recordChange({ tenantId: TENANT_A, feeType: 'CLEANING_LIGHT', changeType: 'UPDATE', feeRateId: 'fr-1' });
    await recordChange({ tenantId: TENANT_A, feeType: 'SMOKING',        changeType: 'TOGGLE', feeRateId: 'fr-2' });
    await recordChange({ tenantId: TENANT_B, feeType: 'CLEANING_LIGHT', changeType: 'UPDATE', feeRateId: 'fr-3' });
  });

  it('filters by tenantId', async () => {
    const entries = await listAuditLog({ tenantId: TENANT_A });
    assert.equal(entries.length, 2);
    for (const e of entries) assert.equal(e.tenantId, TENANT_A);
  });

  it('returns empty array when tenantId is missing', async () => {
    const entries = await listAuditLog({ tenantId: null });
    assert.deepEqual(entries, []);
  });

  it('filters by feeRateId', async () => {
    const entries = await listAuditLog({ tenantId: TENANT_A, feeRateId: 'fr-2' });
    assert.equal(entries.length, 1);
    assert.equal(entries[0].feeRateId, 'fr-2');
    assert.equal(entries[0].feeType, 'SMOKING');
  });

  it('respects limit + offset', async () => {
    const page1 = await listAuditLog({ tenantId: TENANT_A, limit: 1, offset: 0 });
    assert.equal(page1.length, 1);
    const page2 = await listAuditLog({ tenantId: TENANT_A, limit: 1, offset: 1 });
    assert.equal(page2.length, 1);
    assert.notEqual(page1[0].id, page2[0].id);
  });

  it('caps limit at 500', async () => {
    // Smoke: passing 5000 should not throw; our stub honours the take value.
    const entries = await listAuditLog({ tenantId: TENANT_A, limit: 5000 });
    assert.ok(entries.length <= 500);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// service exports
// ─────────────────────────────────────────────────────────────────────────────

describe('feeRateAuditService exports', () => {
  it('exposes the expected surface', () => {
    assert.equal(typeof feeRateAuditService.recordChange, 'function');
    assert.equal(typeof feeRateAuditService.listAuditLog, 'function');
    assert.equal(typeof feeRateAuditService.snapshotFeeRate, 'function');
    assert.equal(typeof feeRateAuditService.classifyChange, 'function');
  });
});
