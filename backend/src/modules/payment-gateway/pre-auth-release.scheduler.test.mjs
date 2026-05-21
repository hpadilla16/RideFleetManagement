/**
 * Tests for pre-auth-release.scheduler.js (2026-05-21).
 * Run: node --test backend/src/modules/payment-gateway/pre-auth-release.scheduler.test.mjs
 *
 * Tests the sweep logic in isolation. The scheduler timer itself is not
 * exercised (it's just setInterval — covered by integration smoke).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  runPreAuthReleaseSweep,
  _internal,
} from './pre-auth-release.scheduler.js';

function makeFakePrisma({ staleAuths = [], terminals = [] } = {}) {
  let nextId = 1;
  const transactions = [...staleAuths];
  return {
    _state: { transactions, terminals },
    $queryRaw: async (...args) => {
      // First arg in template literal calls is the strings array; for our
      // helper we just return the seeded stale rows ignoring the SQL.
      return staleAuths;
    },
    dejavooTerminal: {
      async findUnique({ where }) {
        return terminals.find((t) => t.id === where.id) || null;
      },
    },
    dejavooTransaction: {
      async create({ data }) {
        const row = { id: `vx_${nextId++}`, createdAt: new Date(), ...data };
        transactions.push(row);
        return row;
      },
      async update({ where, data }) {
        const idx = transactions.findIndex((t) => t.id === where.id);
        if (idx !== -1) transactions[idx] = { ...transactions[idx], ...data };
        return transactions[idx];
      },
    },
  };
}

function makeSpin(approve = true) {
  return {
    void: async () => ({
      GeneralResponse: {
        ResultCode: 0,
        StatusCode: approve ? '0000' : '0010',
        Message: approve ? 'OK' : 'VOID DECLINED',
      },
    }),
    normalizeResponse: (resp) => ({
      approved: resp?.GeneralResponse?.StatusCode === '0000',
      statusCode: resp?.GeneralResponse?.StatusCode || '',
      message: resp?.GeneralResponse?.Message || '',
    }),
  };
}

test('runPreAuthReleaseSweep voids each stale AUTH', async () => {
  const staleAuths = [
    { id: 'auth_old1', tenantId: 't1', terminalId: 'term1', reservationId: 'r1',
      type: 'AUTH', referenceId: 'AUTH-1', startedAt: new Date('2026-04-01') },
    { id: 'auth_old2', tenantId: 't1', terminalId: 'term1', reservationId: 'r2',
      type: 'AUTH', referenceId: 'AUTH-2', startedAt: new Date('2026-04-02') },
  ];
  const terminals = [
    { id: 'term1', tenantId: 't1', tpn: '12345', authKeyEnc: 'PLAIN', merchantNumber: 1, sandbox: true },
  ];
  const prisma = makeFakePrisma({ staleAuths, terminals });
  const result = await runPreAuthReleaseSweep({ prisma, spin: makeSpin(true) });
  assert.equal(result.processed, 2);
  assert.equal(result.voided, 2);
  assert.equal(result.failed, 0);
  // 2 child VOID transactions created
  const voids = prisma._state.transactions.filter((t) => t.type === 'VOID');
  assert.equal(voids.length, 2);
  // Each has the parent linked
  assert.equal(voids[0].parentTransactionId, 'auth_old1');
  assert.equal(voids[1].parentTransactionId, 'auth_old2');
  // Each marked approved
  assert.ok(voids.every((v) => v.approved));
});

test('runPreAuthReleaseSweep counts failures on declined void', async () => {
  const staleAuths = [
    { id: 'auth_old1', tenantId: 't1', terminalId: 'term1', reservationId: 'r1',
      type: 'AUTH', referenceId: 'AUTH-1', startedAt: new Date('2026-04-01') },
  ];
  const terminals = [
    { id: 'term1', tenantId: 't1', tpn: '12345', authKeyEnc: 'PLAIN', merchantNumber: 1 },
  ];
  const prisma = makeFakePrisma({ staleAuths, terminals });
  const result = await runPreAuthReleaseSweep({ prisma, spin: makeSpin(false) });
  assert.equal(result.processed, 1);
  assert.equal(result.voided, 0);
  assert.equal(result.failed, 1);
});

test('runPreAuthReleaseSweep skips when terminal missing', async () => {
  const staleAuths = [
    { id: 'auth_old1', tenantId: 't1', terminalId: 'term_missing', reservationId: 'r1',
      type: 'AUTH', referenceId: 'AUTH-1', startedAt: new Date('2026-04-01') },
  ];
  const prisma = makeFakePrisma({ staleAuths, terminals: [] });
  const result = await runPreAuthReleaseSweep({
    prisma,
    spin: makeSpin(true),
    // Force config resolver to return null (no terminal)
    resolveTenantConfig: async () => null,
  });
  assert.equal(result.skippedNoTerminal, 1);
  assert.equal(result.voided, 0);
});

test('runPreAuthReleaseSweep with empty candidate list is a no-op', async () => {
  const prisma = makeFakePrisma({ staleAuths: [] });
  const result = await runPreAuthReleaseSweep({ prisma, spin: makeSpin(true) });
  assert.equal(result.processed, 0);
  assert.equal(result.voided, 0);
  assert.equal(result.failed, 0);
});

test('releaseAfterDays reads PREAUTH_RELEASE_AFTER_DAYS env', () => {
  const prev = process.env.PREAUTH_RELEASE_AFTER_DAYS;
  try {
    process.env.PREAUTH_RELEASE_AFTER_DAYS = '7';
    assert.equal(_internal.releaseAfterDays(), 7);
    process.env.PREAUTH_RELEASE_AFTER_DAYS = 'not-a-number';
    assert.equal(_internal.releaseAfterDays(), 25);
    delete process.env.PREAUTH_RELEASE_AFTER_DAYS;
    assert.equal(_internal.releaseAfterDays(), 25);
  } finally {
    process.env.PREAUTH_RELEASE_AFTER_DAYS = prev;
  }
});

test('intervalMs reads PREAUTH_RELEASE_INTERVAL_HOURS env', () => {
  const prev = process.env.PREAUTH_RELEASE_INTERVAL_HOURS;
  try {
    process.env.PREAUTH_RELEASE_INTERVAL_HOURS = '12';
    assert.equal(_internal.intervalMs(), 12 * 60 * 60 * 1000);
    delete process.env.PREAUTH_RELEASE_INTERVAL_HOURS;
    assert.equal(_internal.intervalMs(), 24 * 60 * 60 * 1000);
  } finally {
    process.env.PREAUTH_RELEASE_INTERVAL_HOURS = prev;
  }
});
