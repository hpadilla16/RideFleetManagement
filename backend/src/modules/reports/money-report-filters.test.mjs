/**
 * Regression tests for the 2026-07-13 money-report audit fixes:
 *   - sales/taxes exclude agreements CANCELLED/DRAFT (a void keeps charges
 *     selected=true; a draft exists the moment the wizard opens)
 *   - toll reports exclude VOID transactions (void is by status, no credit row)
 *   - commission-sales-performance & agent-track-record count COLLECTED
 *     payments only (status PAID, no deposit AUTH_HOLDs) and attach each
 *     charge to ONE catalog service (first-match-wins — "Liability Insurance"
 *     used to double-count as LIABILITY + INSURANCE)
 * Run: npm run test:reports
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { _salesInternal } from './sales.report.js';
import { _taxesInternal } from './taxes.report.js';
import { _tollPerVehicleInternal } from './toll-per-vehicle.report.js';
import { _tollPerLocationInternal } from './toll-per-location.report.js';
import { _commissionInternal } from './commission-sales-performance.report.js';
import { _agentTrackInternal } from './agent-track-record.report.js';
import { COLLECTED_PAYMENT_WHERE } from './collected-payments.js';

const W = { tenantId: 't1', gte: new Date('2026-07-01T04:00:00Z'), lt: new Date('2026-07-14T04:00:00Z') };

test('sales buildChargeWhere excludes CANCELLED and DRAFT agreements', () => {
  const where = _salesInternal.buildChargeWhere(W);
  assert.deepEqual(where.rentalAgreement.status, { notIn: ['CANCELLED', 'DRAFT'] });
  assert.equal(where.selected, true);
});

test('taxes buildChargeWhere excludes CANCELLED and DRAFT agreements (in sync with sales)', () => {
  const where = _taxesInternal.buildChargeWhere(W);
  assert.deepEqual(where.rentalAgreement.status, { notIn: ['CANCELLED', 'DRAFT'] });
  assert.equal(where.selected, true);
});

test('toll-per-vehicle & toll-per-location exclude VOID transactions', () => {
  const wv = _tollPerVehicleInternal.buildTransactionWhere(W);
  const wl = _tollPerLocationInternal.buildTransactionWhere(W);
  assert.deepEqual(wv.status, { notIn: ['VOID'] });
  assert.deepEqual(wl.status, { notIn: ['VOID'] });
});

// ---------------------------------------------------------------------------
// Performance reports: collected-payments filter + first-match-wins
// ---------------------------------------------------------------------------

// Fake prisma that captures the findMany args (so we can assert the nested
// payments.where) and returns one agreement whose "Liability Insurance"
// charge used to double-match LIABILITY (/liab/) AND INSURANCE (/insurance/).
function makePerformanceFakePrisma(captured) {
  const agreement = {
    id: 'ag1',
    pickupAt: new Date('2026-07-02T14:00:00Z'),
    returnAt: new Date('2026-07-05T14:00:00Z'),
    finalizedAt: new Date('2026-07-02T14:00:00Z'),
    closedAt: null,
    salesOwnerUserId: 'u1',
    salesOwnerUser: { id: 'u1', fullName: 'Clerk One' },
    charges: [
      { code: null, name: 'Liability Insurance', total: 10, selected: true },
    ],
    // Pretend the DB applied the where — collected rows only.
    payments: [{ amount: 300 }],
    inspections: [{ actorUserId: 'u1', capturedAt: new Date('2026-07-02T14:30:00Z') }],
  };
  return {
    rentalAgreement: {
      async findMany(args) { captured.args = args; return [agreement]; },
    },
    user: { async findMany() { return [{ id: 'u1', fullName: 'Clerk One' }] } },
  };
}

test('commission-sales-performance: payments filtered to COLLECTED + single-service attach', async () => {
  const captured = {};
  const prisma = makePerformanceFakePrisma(captured);
  const out = await _commissionInternal.computeData(
    { tenantId: 't1', from: '2026-07-01', to: '2026-07-13' },
    { prisma, tenantTz: 'America/Puerto_Rico', now: new Date('2026-07-13T16:00:00Z') },
  );
  // The nested payments select must carry the canonical collected-money where.
  assert.deepEqual(captured.args.select.payments.where, { ...COLLECTED_PAYMENT_WHERE });
  const clerk = out.clerks.find((c) => c.id === 'u1');
  assert.ok(clerk, 'clerk row present');
  assert.equal(clerk.paidAtCounter, 300);
  // "Liability Insurance" attaches to LIABILITY only (first match, $2) —
  // NOT also INSURANCE ($3). Old code produced commissions=5 and two attaches.
  assert.equal(clerk.commissions, 2);
  assert.equal(clerk.attach.LIABILITY, 1);
  assert.equal(clerk.attach.INSURANCE, 0);
  assert.equal(clerk.serviceDollars.LIABILITY, 10);
  assert.equal(clerk.serviceDollars.INSURANCE, 0);
});

test('agent-track-record: payments filtered to COLLECTED + single-service attach', async () => {
  const captured = {};
  const prisma = makePerformanceFakePrisma(captured);
  const out = await _agentTrackInternal.computeData(
    { tenantId: 't1', from: '2026-07-01', to: '2026-07-13' },
    { prisma, tenantTz: 'America/Puerto_Rico', now: new Date('2026-07-13T16:00:00Z') },
  );
  assert.deepEqual(captured.args.select.payments.where, { ...COLLECTED_PAYMENT_WHERE });
  const clerk = out.clerks.find((c) => c.id === 'u1');
  assert.ok(clerk, 'clerk row present');
  // One LIABILITY attach worth $2 commission (old double-match gave $5) and
  // $300 collected at counter across the clerk's month buckets.
  assert.equal(clerk.total.counterDollars, 300);
  assert.equal(clerk.total.commissions, 2);
});
