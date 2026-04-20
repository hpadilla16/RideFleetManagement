import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { compactStartRentalResponse } from './start-rental-compact.js';

/**
 * Fixture: a "fat" agreement row with all the relations that the service
 * historically returned. These should all be stripped by compactStartRentalResponse.
 */
function makeFatAgreementRow() {
  return {
    // Core contract fields (7)
    id: 'agr-abc123',
    agreementNumber: 'AGR-001',
    reservationId: 'res-xyz789',
    status: 'STARTED',
    total: 2500.00,
    paidAmount: 500.00,
    balance: 2000.00,

    // Internal / out-of-contract fields that must NOT leak
    tenantId: 'ten-secret',
    locked: true,
    signedAt: new Date('2026-04-20T10:00:00Z'),
    finalizedAt: null,

    // Relations that historically bloated responses (must be stripped)
    charges: [
      { id: 'ch-1', description: 'Damage waiver', amount: 50.00 }
    ],
    payments: [
      { id: 'pay-1', amount: 500.00, method: 'CARD', transactionId: 'txn-abc' }
    ],
    reservation: {
      id: 'res-xyz789',
      customerName: 'John Doe',
      status: 'ACTIVE'
    },
    customer: {
      id: 'cust-1',
      firstName: 'John',
      lastName: 'Doe',
      email: 'john@example.com'
    },
    vehicle: {
      id: 'veh-1',
      make: 'Honda',
      model: 'Civic',
      vin: 'JH2RC5004LM300001'
    },
    pickupLocation: {
      id: 'loc-1',
      name: 'Downtown',
      address: '123 Main St'
    },
    dropoffLocation: {
      id: 'loc-2',
      name: 'Airport',
      address: '456 Flight Ave'
    },
    inspections: [
      { id: 'insp-1', type: 'PRE_RENTAL', passedAt: new Date() }
    ],
    drivers: [
      { id: 'drv-1', firstName: 'Jane', lastName: 'Smith' }
    ]
  };
}

describe('compactStartRentalResponse', () => {
  it('returns exactly 7 contract fields from a fat row', () => {
    const fat = makeFatAgreementRow();
    const result = compactStartRentalResponse(fat);
    const keys = Object.keys(result).sort();
    const expected = ['agreementNumber', 'balance', 'id', 'paidAmount', 'reservationId', 'status', 'total'].sort();
    assert.deepEqual(keys, expected, `Contract mismatch: got ${keys.join(', ')}, expected ${expected.join(', ')}`);
  });

  it('preserves exact values for all 7 contract fields', () => {
    const fat = makeFatAgreementRow();
    const result = compactStartRentalResponse(fat);
    assert.equal(result.id, 'agr-abc123', 'id field mismatch');
    assert.equal(result.agreementNumber, 'AGR-001', 'agreementNumber field mismatch');
    assert.equal(result.reservationId, 'res-xyz789', 'reservationId field mismatch');
    assert.equal(result.status, 'STARTED', 'status field mismatch');
    assert.equal(result.total, 2500.00, 'total field mismatch');
    assert.equal(result.paidAmount, 500.00, 'paidAmount field mismatch');
    assert.equal(result.balance, 2000.00, 'balance field mismatch');
  });

  it('does not leak relation fields (charges, payments, reservation, customer, vehicle, locations, inspections, drivers)', () => {
    const fat = makeFatAgreementRow();
    const result = compactStartRentalResponse(fat);
    const forbiddenFields = ['charges', 'payments', 'reservation', 'customer', 'vehicle', 'pickupLocation', 'dropoffLocation', 'inspections', 'drivers'];
    for (const field of forbiddenFields) {
      assert.equal(
        result[field],
        undefined,
        `Contract drift: compactStartRentalResponse leaks "${field}" — see docs/operations/checkout-perf-plan.md PR 3.2`
      );
    }
  });

  it('does not leak out-of-contract internal fields (tenantId, locked, signedAt, finalizedAt)', () => {
    const fat = makeFatAgreementRow();
    const result = compactStartRentalResponse(fat);
    const internalFields = ['tenantId', 'locked', 'signedAt', 'finalizedAt'];
    for (const field of internalFields) {
      assert.equal(
        result[field],
        undefined,
        `Contract drift: compactStartRentalResponse leaks internal field "${field}" — see docs/operations/checkout-perf-plan.md PR 3.2`
      );
    }
  });

  it('handles null/undefined/primitive values defensively without throwing', () => {
    // null input
    const nullResult = compactStartRentalResponse(null);
    assert.equal(nullResult, null, 'null input should pass through unchanged');

    // undefined input
    const undefinedResult = compactStartRentalResponse(undefined);
    assert.equal(undefinedResult, undefined, 'undefined input should pass through unchanged');

    // string input
    const stringResult = compactStartRentalResponse('not-an-object');
    assert.equal(stringResult, 'not-an-object', 'string input should pass through unchanged');

    // number input
    const numberResult = compactStartRentalResponse(42);
    assert.equal(numberResult, 42, 'number input should pass through unchanged');

    // false/0 inputs
    const falseResult = compactStartRentalResponse(false);
    assert.equal(falseResult, false, 'false input should pass through unchanged');

    const zeroResult = compactStartRentalResponse(0);
    assert.equal(zeroResult, 0, 'zero input should pass through unchanged');

    // empty string
    const emptyStringResult = compactStartRentalResponse('');
    assert.equal(emptyStringResult, '', 'empty string should pass through unchanged');
  });

  it('tolerates missing optional fields and returns them as undefined', () => {
    const sparse = {
      id: 'agr-sparse',
      agreementNumber: 'AGR-002',
      status: 'STARTED',
      // reservationId, total, paidAmount, balance intentionally omitted
    };
    const result = compactStartRentalResponse(sparse);
    assert.equal(result.id, 'agr-sparse', 'id present');
    assert.equal(result.agreementNumber, 'AGR-002', 'agreementNumber present');
    assert.equal(result.reservationId, undefined, 'missing reservationId should be undefined');
    assert.equal(result.total, undefined, 'missing total should be undefined');
    assert.equal(result.paidAmount, undefined, 'missing paidAmount should be undefined');
    assert.equal(result.balance, undefined, 'missing balance should be undefined');
  });

  it('includes finalizedAt field if present (defensive passthrough)', () => {
    const rowWithFinalized = makeFatAgreementRow();
    rowWithFinalized.finalizedAt = new Date('2026-04-20T11:00:00Z');
    const result = compactStartRentalResponse(rowWithFinalized);
    // finalizedAt should NOT be in the contract (Shape B does not include it)
    // but if it arrives, defensive passthrough should exclude it from the response
    assert.equal(result.finalizedAt, undefined, 'finalizedAt must not be returned for start-rental (different from signature/finalize contract)');
  });
});
