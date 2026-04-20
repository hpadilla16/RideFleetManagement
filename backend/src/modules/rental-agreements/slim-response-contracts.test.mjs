import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { compactAgreementResponse } from './rental-agreements-compact.js';
import { compactStartRentalResponse } from '../reservations/start-rental-compact.js';

// Both helpers are imported from their real modules — that is the whole point
// of this test. A contract-union test that inlined a copy of either helper
// would not catch drift in the real module (if someone adds or drops a field
// upstream, the inline copy would still say the contract is intact). Keep
// the imports. See docs/operations/checkout-perf-plan.md PR 3.2.

/**
 * Contract envelopes for the three slim-response checkout endpoints.
 * Frozen constants so any schema/refactor drift is caught by the union test below.
 */
const SIGN_AND_FINALIZE_CONTRACT = ['id', 'agreementNumber', 'status', 'total', 'balance', 'finalizedAt'];
const START_RENTAL_CONTRACT = ['id', 'agreementNumber', 'reservationId', 'status', 'total', 'paidAmount', 'balance'];

/**
 * Fixture: a "fat" agreement row with all the relations that the service
 * historically returned. These should all be stripped by both helpers.
 */
function makeFatAgreementRow() {
  return {
    // Core fields present in both or one of the contracts
    id: 'agr-contract-union-1',
    agreementNumber: 'AGR-UNION-1',
    reservationId: 'res-contract-union-1',
    status: 'STARTED',
    total: 3500.00,
    paidAmount: 750.00,
    balance: 2750.00,
    finalizedAt: new Date('2026-04-20T12:00:00Z'),

    // Internal / out-of-contract fields that must NOT leak
    tenantId: 'ten-secret',
    locked: true,
    signedAt: new Date('2026-04-20T10:00:00Z'),

    // Relations that historically bloated responses (must be stripped from both helpers)
    charges: [
      { id: 'ch-1', description: 'Damage waiver', amount: 75.00 }
    ],
    payments: [
      { id: 'pay-1', amount: 750.00, method: 'CARD', transactionId: 'txn-xyz' }
    ],
    reservation: {
      id: 'res-contract-union-1',
      customerName: 'Jane Smith',
      status: 'ACTIVE'
    },
    customer: {
      id: 'cust-2',
      firstName: 'Jane',
      lastName: 'Smith',
      email: 'jane@example.com'
    },
    vehicle: {
      id: 'veh-2',
      make: 'Tesla',
      model: 'Model 3',
      vin: '5YJ3E1EA5LF000001'
    },
    pickupLocation: {
      id: 'loc-3',
      name: 'Uptown',
      address: '789 Park Ave'
    },
    dropoffLocation: {
      id: 'loc-4',
      name: 'Station',
      address: '999 Rail Rd'
    },
    inspections: [
      { id: 'insp-2', type: 'POST_RENTAL', passedAt: new Date() }
    ],
    drivers: [
      { id: 'drv-2', firstName: 'Bob', lastName: 'Johnson' }
    ]
  };
}

describe('Slim response contracts (union + drift detection)', () => {
  it('Shape A (signature/finalize) returns exactly 6 contract fields', () => {
    const fat = makeFatAgreementRow();
    const result = compactAgreementResponse(fat);
    const keys = Object.keys(result).sort();
    const expected = SIGN_AND_FINALIZE_CONTRACT.slice().sort();
    assert.deepEqual(
      keys,
      expected,
      `Contract drift on compactAgreementResponse: got [${keys.join(', ')}], expected [${expected.join(', ')}]`
    );
  });

  it('Shape B (start-rental) returns exactly 7 contract fields', () => {
    const fat = makeFatAgreementRow();
    const result = compactStartRentalResponse(fat);
    const keys = Object.keys(result).sort();
    const expected = START_RENTAL_CONTRACT.slice().sort();
    assert.deepEqual(
      keys,
      expected,
      `Contract drift on compactStartRentalResponse: got [${keys.join(', ')}], expected [${expected.join(', ')}]`
    );
  });

  it('Intersection is precisely 5 shared fields across both envelopes', () => {
    const setA = new Set(SIGN_AND_FINALIZE_CONTRACT);
    const setB = new Set(START_RENTAL_CONTRACT);
    const intersection = [...setA].filter(f => setB.has(f)).sort();
    const expected = ['agreementNumber', 'balance', 'id', 'status', 'total'].sort();
    assert.deepEqual(
      intersection,
      expected,
      `Contract drift: intersection mismatch. Got [${intersection.join(', ')}], expected [${expected.join(', ')}]`
    );
  });

  it('Symmetric difference is precisely 3 endpoint-unique fields', () => {
    const setA = new Set(SIGN_AND_FINALIZE_CONTRACT);
    const setB = new Set(START_RENTAL_CONTRACT);

    // Compute symmetric difference: (A - B) ∪ (B - A)
    const aMinusB = [...setA].filter(f => !setB.has(f));
    const bMinusA = [...setB].filter(f => !setA.has(f));
    const symDiff = [...aMinusB, ...bMinusA].sort();
    const expected = ['finalizedAt', 'paidAmount', 'reservationId'].sort();

    assert.deepEqual(
      symDiff,
      expected,
      `Contract drift: symmetric difference mismatch. Got [${symDiff.join(', ')}], expected [${expected.join(', ')}]`
    );

    // Explicit assertions on the three fields
    assert.ok(
      setA.has('finalizedAt') && !setB.has('finalizedAt'),
      'Contract drift: finalizedAt must be in A (signature/finalize) but not in B (start-rental)'
    );
    assert.ok(
      !setA.has('reservationId') && setB.has('reservationId'),
      'Contract drift: reservationId must be in B (start-rental) but not in A (signature/finalize)'
    );
    assert.ok(
      !setA.has('paidAmount') && setB.has('paidAmount'),
      'Contract drift: paidAmount must be in B (start-rental) but not in A (signature/finalize)'
    );
  });

  it('Union size is exactly 8 distinct fields across both contracts', () => {
    const setA = new Set(SIGN_AND_FINALIZE_CONTRACT);
    const setB = new Set(START_RENTAL_CONTRACT);
    const union = new Set([...setA, ...setB]);
    const unionArray = [...union].sort();
    const expected = ['agreementNumber', 'balance', 'finalizedAt', 'id', 'paidAmount', 'reservationId', 'status', 'total'].sort();

    assert.equal(
      union.size,
      8,
      `Contract drift: union size must be exactly 8, got ${union.size}. Union: [${unionArray.join(', ')}]`
    );
    assert.deepEqual(
      unionArray,
      expected,
      `Contract drift: union mismatch. Got [${unionArray.join(', ')}], expected [${expected.join(', ')}]`
    );
  });

  it('Both helpers do not leak forbidden relations (charges, payments, reservation, customer, vehicle, locations, inspections, drivers)', () => {
    const fat = makeFatAgreementRow();
    const resultA = compactAgreementResponse(fat);
    const resultB = compactStartRentalResponse(fat);

    const forbiddenRelations = ['charges', 'payments', 'reservation', 'customer', 'vehicle', 'pickupLocation', 'dropoffLocation', 'inspections', 'drivers'];

    for (const field of forbiddenRelations) {
      assert.equal(
        resultA[field],
        undefined,
        `Contract drift: compactAgreementResponse leaks "${field}" — see docs/operations/checkout-perf-plan.md PR 3.2`
      );
      assert.equal(
        resultB[field],
        undefined,
        `Contract drift: compactStartRentalResponse leaks "${field}" — see docs/operations/checkout-perf-plan.md PR 3.2`
      );
    }
  });

  it('Both helpers do not leak internal fields (tenantId, locked, signedAt)', () => {
    const fat = makeFatAgreementRow();
    const resultA = compactAgreementResponse(fat);
    const resultB = compactStartRentalResponse(fat);

    const internalFields = ['tenantId', 'locked', 'signedAt'];

    for (const field of internalFields) {
      assert.equal(
        resultA[field],
        undefined,
        `Contract drift: compactAgreementResponse leaks internal field "${field}"`
      );
      assert.equal(
        resultB[field],
        undefined,
        `Contract drift: compactStartRentalResponse leaks internal field "${field}"`
      );
    }
  });

  it('Defensive: compactAgreementResponse preserves contract values correctly on fat row', () => {
    const fat = makeFatAgreementRow();
    const result = compactAgreementResponse(fat);

    assert.equal(result.id, 'agr-contract-union-1');
    assert.equal(result.agreementNumber, 'AGR-UNION-1');
    assert.equal(result.status, 'STARTED');
    assert.equal(result.total, 3500.00);
    assert.equal(result.balance, 2750.00);
    assert.deepEqual(result.finalizedAt, new Date('2026-04-20T12:00:00Z'));
  });

  it('Defensive: compactStartRentalResponse preserves contract values correctly on fat row', () => {
    const fat = makeFatAgreementRow();
    const result = compactStartRentalResponse(fat);

    assert.equal(result.id, 'agr-contract-union-1');
    assert.equal(result.agreementNumber, 'AGR-UNION-1');
    assert.equal(result.reservationId, 'res-contract-union-1');
    assert.equal(result.status, 'STARTED');
    assert.equal(result.total, 3500.00);
    assert.equal(result.paidAmount, 750.00);
    assert.equal(result.balance, 2750.00);
  });
});
