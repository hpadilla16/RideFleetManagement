import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { compactAgreementResponse } from './rental-agreements-compact.js';

// PR 3 — Trim response payloads. Verifies the compact envelope returned by the
// hot-path checkout handlers (POST /:id/signature, POST /:id/finalize) includes
// only the fields the checkout UI or mobile client need, and strips everything
// else (charges, payments, reservation, customer, vehicle, locations, …). See
// docs/operations/checkout-perf-plan.md PR 3.
const EXPECTED_KEYS = ['id', 'agreementNumber', 'status', 'total', 'balance', 'finalizedAt'];

// A realistic-enough "fat" agreement row shape — includes everything the
// service historically returned via its `findUnique` with 6+ relations included.
function makeFatAgreementRow(overrides = {}) {
  return {
    id: 'agr-123',
    agreementNumber: 'AGR-2026-0042',
    reservationId: 'res-77',
    status: 'SIGNED',
    total: 1234.56,
    paidAmount: 500,
    balance: 734.56,
    signedAt: '2026-04-19T18:00:00.000Z',
    finalizedAt: null,
    tenantId: 'ten-1',
    locked: false,
    charges: [
      { id: 'c1', label: 'Daily rate', amount: 80 },
      { id: 'c2', label: 'Insurance', amount: 20 }
    ],
    payments: [{ id: 'p1', amount: 500, method: 'CASH' }],
    reservation: { id: 'res-77', reservationNumber: 'RES-0001' },
    customer: { id: 'cus-1', firstName: 'Jane', lastName: 'Doe', email: 'jane@example.com' },
    vehicle: { id: 'veh-1', make: 'Toyota', model: 'Corolla' },
    pickupLocation: { id: 'loc-1', name: 'Main' },
    dropoffLocation: { id: 'loc-2', name: 'Airport' },
    inspections: [{ id: 'ins-1' }],
    drivers: [{ id: 'dr-1' }],
    ...overrides
  };
}

describe('compactAgreementResponse (PR 3 trim)', () => {
  it('returns only the six contract-fixed keys, no matter how fat the input', () => {
    const compact = compactAgreementResponse(makeFatAgreementRow());
    assert.deepEqual(Object.keys(compact).sort(), [...EXPECTED_KEYS].sort());
  });

  it('preserves exact values for the six kept fields', () => {
    const row = makeFatAgreementRow({
      status: 'FINALIZED',
      finalizedAt: '2026-04-19T19:30:00.000Z'
    });
    const compact = compactAgreementResponse(row);
    assert.equal(compact.id, 'agr-123');
    assert.equal(compact.agreementNumber, 'AGR-2026-0042');
    assert.equal(compact.status, 'FINALIZED');
    assert.equal(compact.total, 1234.56);
    assert.equal(compact.balance, 734.56);
    assert.equal(compact.finalizedAt, '2026-04-19T19:30:00.000Z');
  });

  it('does not leak relations that historically bloated responses to ~475 KB', () => {
    const compact = compactAgreementResponse(makeFatAgreementRow());
    for (const banned of ['charges', 'payments', 'reservation', 'customer', 'vehicle', 'pickupLocation', 'dropoffLocation', 'inspections', 'drivers']) {
      assert.equal(compact[banned], undefined, `compact response must not include \`${banned}\``);
    }
  });

  it('does not leak defense-in-depth fields that are not in the public contract', () => {
    // `tenantId`, `locked`, `paidAmount`, `signedAt`, `reservationId` are NOT
    // in the plan's 6-field contract. If a future refactor adds them to the
    // compact shape, the contract should be revisited explicitly — we don't
    // want silent drift.
    const compact = compactAgreementResponse(makeFatAgreementRow());
    for (const banned of ['tenantId', 'locked', 'paidAmount', 'signedAt', 'reservationId']) {
      assert.equal(compact[banned], undefined, `\`${banned}\` is outside the PR 3 compact contract`);
    }
  });

  it('returns null/undefined/primitive inputs unchanged (defensive passthrough)', () => {
    assert.equal(compactAgreementResponse(null), null);
    assert.equal(compactAgreementResponse(undefined), undefined);
    assert.equal(compactAgreementResponse(''), '');
    assert.equal(compactAgreementResponse(0), 0);
    assert.equal(compactAgreementResponse(false), false);
  });

  it('handles rows missing optional fields without throwing', () => {
    const compact = compactAgreementResponse({ id: 'agr-x', agreementNumber: 'AGR-1', status: 'DRAFT' });
    assert.equal(compact.id, 'agr-x');
    assert.equal(compact.total, undefined);
    assert.equal(compact.balance, undefined);
    assert.equal(compact.finalizedAt, undefined);
    // keys still exist, just undefined
    assert.deepEqual(Object.keys(compact).sort(), [...EXPECTED_KEYS].sort());
  });
});
