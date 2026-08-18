import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyFinalizeWritesTx,
  applyChargesSyncTx,
  isFinalizeAlreadyDone,
  finalizeReplayDivergence,
  FINALIZABLE_AGREEMENT_STATUSES
} from './rental-agreements.service.js';
import { $Enums } from '@prisma/client';

// Build a fake `tx` that records every method called and lets us inject
// failures on specific operations. Mirrors the subset of the Prisma client
// used inside the transaction callbacks — if the production code ever
// reaches for a model not listed here, the test breaks loudly (which is
// what we want — every model used inside the tx must be on `tx`, never on
// the global prisma).
function fakeTx({ failOn, claimCount = 1 } = {}) {
  const calls = [];
  const make = (model) => ({
    findUnique: async (args) => {
      calls.push({ model, op: 'findUnique', args });
      if (failOn === `${model}.findUnique`) throw new Error(`forced failure on ${model}.findUnique`);
      // Stubs for the bug #44 vehicle-status sync that now runs inside the
      // finalize tx. The vehicle starts AVAILABLE so checkout flips it ON_RENT.
      if (model === 'vehicle') return { id: args.where?.id, status: 'AVAILABLE', internalNumber: 'UNIT-1', plate: 'AAA111' };
      if (model === 'reservation') return { vehicleId: 'veh-1' };
      // The finalize claim is an updateMany (which returns a count, not a row),
      // so the helper re-reads the agreement inside the tx.
      if (model === 'rentalAgreement') return { id: args.where?.id, reservationId: 'res-from-update', vehicleId: 'veh-1' };
      return null;
    },
    update: async (args) => {
      calls.push({ model, op: 'update', args });
      if (failOn === `${model}.update`) throw new Error(`forced failure on ${model}.update`);
      // Mirror what real prisma.update returns for the agreement (other tests
      // depend on the reservationId field; the vehicleId feeds the vehicle sync).
      if (model === 'rentalAgreement') return { id: args.where?.id, reservationId: 'res-from-update', vehicleId: 'veh-1' };
      return {};
    },
    create: async (args) => {
      calls.push({ model, op: 'create', args });
      if (failOn === `${model}.create`) throw new Error(`forced failure on ${model}.create`);
      return {};
    },
    deleteMany: async (args) => {
      calls.push({ model, op: 'deleteMany', args });
      if (failOn === `${model}.deleteMany`) throw new Error(`forced failure on ${model}.deleteMany`);
      return { count: 0 };
    },
    updateMany: async (args) => {
      calls.push({ model, op: 'updateMany', args });
      if (failOn === `${model}.updateMany`) throw new Error(`forced failure on ${model}.updateMany`);
      // rentalAgreement.updateMany is the finalize CLAIM. claimCount: 0 simulates
      // losing the race to a concurrent finalize.
      if (model === 'rentalAgreement') return { count: claimCount };
      return { count: 1 };
    },
    createMany: async (args) => {
      calls.push({ model, op: 'createMany', args });
      if (failOn === `${model}.createMany`) throw new Error(`forced failure on ${model}.createMany`);
      return { count: args?.data?.length || 0 };
    }
  });
  return {
    customer: make('customer'),
    rentalAgreement: make('rentalAgreement'),
    reservation: make('reservation'),
    vehicle: make('vehicle'),
    rentalAgreementPayment: make('rentalAgreementPayment'),
    rentalAgreementCharge: make('rentalAgreementCharge'),
    vehicleMileageEntry: make('vehicleMileageEntry'),
    __calls: calls
  };
}

const baseFinalizeCtx = {
  id: 'agr-1',
  paymentMethod: 'CARD',
  payload: { paymentReference: 'TXN-99' },
  priorPaymentReference: null,
  customerFirstName: 'John',
  customerLastName: 'Doe',
  licenseNumber: 'L-1',
  dateOfBirth: new Date('1990-01-01'),
  odometerOut: 12345,
  fuelOut: 8,
  paidAmount: 100,
  balance: 0,
  hasExplicitPaidAmount: true,
  creditApplied: 0,
  customerIdForCredit: null,
  nextCustomerCredit: null,
  creditNoteForCustomer: null,
  // Mileage-history provenance (2026-06-09). tenantId is non-undefined so the
  // helper skips its tenant lookup — mirrors production passing agreement.tenantId.
  vehicleId: 'veh-1',
  tenantId: null,
  reservationNumber: 'RES-1',
  actorUserId: null
};

describe('applyFinalizeWritesTx', () => {
  it('writes agreement → reservation → payment in order on the tx client', async () => {
    const tx = fakeTx();
    const result = await applyFinalizeWritesTx(tx, baseFinalizeCtx);
    const order = tx.__calls.map((c) => `${c.model}.${c.op}`);
    assert.deepEqual(order, [
      'rentalAgreement.updateMany',   // compare-and-set CLAIM (only one finalize wins)
      'rentalAgreement.findUnique',   // re-read: updateMany returns a count, not the row
      'reservation.update',
      'reservation.findUnique',        // bug #44 vehicle-status sync (reads reservation)
      'vehicle.findUnique',           // bug #44 vehicle-status sync (read)
      'vehicle.update',               // AVAILABLE → ON_RENT on checkout
      'vehicleMileageEntry.create',   // CHECKOUT mileage history entry (2026-06-09)
      'vehicle.update',               // "last entry wins" mirror onto Vehicle.mileage
      'rentalAgreementPayment.create'
    ]);
    assert.equal(result.id, 'agr-1');
  });

  it('applies the customer credit deduction inside the claimed transaction', async () => {
    const tx = fakeTx();
    await applyFinalizeWritesTx(tx, {
      ...baseFinalizeCtx,
      creditApplied: 50,
      customerIdForCredit: 'cust-1',
      nextCustomerCredit: 0,
      creditNoteForCustomer: 'auto credit'
    });
    const order = tx.__calls.map((c) => `${c.model}.${c.op}`);
    assert.deepEqual(order, [
      'rentalAgreement.updateMany',   // compare-and-set CLAIM (only one finalize wins)
      'rentalAgreement.findUnique',   // re-read: updateMany returns a count, not the row
      'customer.update',              // credit debit AFTER the claim — a loser takes no Customer lock
      'reservation.update',
      'reservation.findUnique',        // bug #44 vehicle-status sync (reads reservation)
      'vehicle.findUnique',            // bug #44 vehicle-status sync (read)
      'vehicle.update',                // AVAILABLE → ON_RENT on checkout
      'vehicleMileageEntry.create',    // CHECKOUT mileage history entry (2026-06-09)
      'vehicle.update',                // "last entry wins" mirror onto Vehicle.mileage
      'rentalAgreementPayment.create', // explicit paid amount
      'rentalAgreementPayment.create'  // credit-applied payment record
    ]);
  });

  it('skips the explicit payment record when no explicit amount was provided', async () => {
    const tx = fakeTx();
    await applyFinalizeWritesTx(tx, {
      ...baseFinalizeCtx,
      hasExplicitPaidAmount: false,
      paidAmount: 0,
      paymentMethod: null
    });
    const ops = tx.__calls.map((c) => `${c.model}.${c.op}`);
    assert.deepEqual(ops, ['rentalAgreement.updateMany', 'rentalAgreement.findUnique', 'reservation.update', 'reservation.findUnique', 'vehicle.findUnique', 'vehicle.update', 'vehicleMileageEntry.create', 'vehicle.update']);
  });

  it('rolls back contract: throws if reservation.update fails (caller is prisma.$transaction which then aborts)', async () => {
    // Real rollback semantics live in Prisma. Our contract is: when any
    // step inside the helper throws, the helper rejects, which causes
    // prisma.$transaction to abort and undo earlier writes. Verify the
    // throw behavior here.
    const tx = fakeTx({ failOn: 'reservation.update' });
    await assert.rejects(
      () => applyFinalizeWritesTx(tx, baseFinalizeCtx),
      /forced failure on reservation\.update/
    );
    // The agreement claim DID happen against the tx (which is correct —
    // the rollback is Prisma's job, not ours). The point is no payment.create
    // ever ran, because we threw mid-flight.
    const ops = tx.__calls.map((c) => `${c.model}.${c.op}`);
    assert.deepEqual(ops, ['rentalAgreement.updateMany', 'rentalAgreement.findUnique', 'reservation.update']);
  });

  it('rolls back contract: throws if the credit-paired payment.create fails', async () => {
    const tx = fakeTx({ failOn: 'rentalAgreementPayment.create' });
    await assert.rejects(
      () => applyFinalizeWritesTx(tx, {
        ...baseFinalizeCtx,
        creditApplied: 25,
        customerIdForCredit: 'cust-2',
        nextCustomerCredit: 0,
        creditNoteForCustomer: 'note'
      }),
      /forced failure on rentalAgreementPayment\.create/
    );
    // The customer credit deduction reached the tx (will be rolled back by
    // Prisma when the tx aborts — we never want to debit a customer for a
    // checkout that didn't actually finalize).
    const customerCalls = tx.__calls.filter((c) => c.model === 'customer');
    assert.equal(customerCalls.length, 1);
    assert.equal(customerCalls[0].op, 'update');
  });

  it('credit-only finalization (no explicit payment) creates ONLY the credit payment', async () => {
    // Real scenario: customer's credit balance covers the entire balance, so
    // staff completes checkout without taking any cash/card. Must record
    // exactly one payment row (the credit), not two.
    const tx = fakeTx();
    await applyFinalizeWritesTx(tx, {
      ...baseFinalizeCtx,
      hasExplicitPaidAmount: false,
      paidAmount: 0,
      paymentMethod: null,
      creditApplied: 22.30,
      customerIdForCredit: 'cust-credit-only',
      nextCustomerCredit: 5,
      creditNoteForCustomer: 'auto credit'
    });
    const ops = tx.__calls.map((c) => `${c.model}.${c.op}`);
    assert.deepEqual(ops, [
      'rentalAgreement.updateMany',   // compare-and-set CLAIM (only one finalize wins)
      'rentalAgreement.findUnique',   // re-read: updateMany returns a count, not the row
      'customer.update',              // credit debit AFTER the claim — a loser takes no Customer lock
      'reservation.update',
      'reservation.findUnique',        // bug #44 vehicle-status sync (reads reservation)
      'vehicle.findUnique',            // bug #44 vehicle-status sync (read)
      'vehicle.update',                // AVAILABLE → ON_RENT on checkout
      'vehicleMileageEntry.create',    // CHECKOUT mileage history entry (2026-06-09)
      'vehicle.update',                // "last entry wins" mirror onto Vehicle.mileage
      'rentalAgreementPayment.create' // credit-only — one create, not two
    ]);
    const payments = tx.__calls.filter((c) => c.model === 'rentalAgreementPayment');
    assert.equal(payments.length, 1, 'only the credit-paired payment must exist');
    assert.equal(payments[0].args.data.reference, 'CUSTOMER_CREDIT_AUTO_APPLIED');
  });

  it('paymentReference falls back: payload undefined → uses priorPaymentReference', async () => {
    const tx = fakeTx();
    await applyFinalizeWritesTx(tx, {
      ...baseFinalizeCtx,
      payload: {}, // no paymentReference in payload
      priorPaymentReference: 'PRIOR-REF-77'
    });
    const agreementUpdate = tx.__calls.find((c) => c.model === 'rentalAgreement' && c.op === 'updateMany');
    assert.equal(agreementUpdate.args.data.paymentReference, 'PRIOR-REF-77',
      'must fall back to priorPaymentReference when payload omits it');
    const paymentCreate = tx.__calls.find((c) => c.model === 'rentalAgreementPayment' && c.op === 'create');
    assert.equal(paymentCreate.args.data.reference, null,
      'payment.create.reference defaults to null (not undefined) when both sources are empty');
  });

  it('defensive: creditApplied > 0 with customerIdForCredit=null does NOT call customer.update', async () => {
    // This shape is theoretically impossible (the caller pairs them) but the
    // helper guards against it. If the guard regresses, a credit payment
    // could be recorded without the corresponding customer balance debit.
    const tx = fakeTx();
    await applyFinalizeWritesTx(tx, {
      ...baseFinalizeCtx,
      creditApplied: 10,
      customerIdForCredit: null, // intentionally null
      nextCustomerCredit: null,
      creditNoteForCustomer: null
    });
    const customerOps = tx.__calls.filter((c) => c.model === 'customer');
    assert.equal(customerOps.length, 0, 'customer.update must NOT fire when customerIdForCredit is null');
    // The credit payment record DOES still fire — that's a separate guard
    // we may want to tighten in a future PR. Documenting current behavior.
    const paymentOps = tx.__calls.filter((c) => c.model === 'rentalAgreementPayment');
    assert.ok(paymentOps.length >= 1, 'credit payment record fires (current behavior — see follow-up)');
  });

  it('reservation.update fail with no prior payments: ZERO payment.create attempts after the throw', async () => {
    // Variant of test 4: ensure that even in the no-payment-baseline path,
    // the throw stops execution before any payment record is touched.
    const tx = fakeTx({ failOn: 'reservation.update' });
    await assert.rejects(
      () => applyFinalizeWritesTx(tx, {
        ...baseFinalizeCtx,
        hasExplicitPaidAmount: false,
        paidAmount: 0,
        paymentMethod: null,
        creditApplied: 0
      }),
      /forced failure on reservation\.update/
    );
    const paymentOps = tx.__calls.filter((c) => c.model === 'rentalAgreementPayment');
    assert.equal(paymentOps.length, 0, 'no payment.create may run after a mid-tx throw');
  });
});

// 2026-08-17 — double-finalize. The legacy POST /:id/finalize had no
// already-FINALIZED precondition, so a retry (double-click, lost response) re-ran
// the whole write body: it rewrote finalizedAt to the day of the RETRY, losing the
// real check-out date, and appended a second CHECKOUT row to the vehicle's mileage
// timeline. The fix makes the agreement write a compare-and-set claim.
describe('applyFinalizeWritesTx — double-finalize claim', () => {
  it('claims the agreement with a status predicate, not a bare id update', async () => {
    const tx = fakeTx();
    await applyFinalizeWritesTx(tx, baseFinalizeCtx);
    const claim = tx.__calls.find((c) => c.model === 'rentalAgreement' && c.op === 'updateMany');
    assert.ok(claim, 'the agreement write must be an updateMany (compare-and-set), never a bare update');
    assert.equal(claim.args.where.id, 'agr-1');
    assert.deepEqual(claim.args.where.status, { in: FINALIZABLE_AGREEMENT_STATUSES },
      'the WHERE must carry the status predicate — that is what makes it a claim');
    assert.ok(!FINALIZABLE_AGREEMENT_STATUSES.includes('FINALIZED'),
      'FINALIZED must never be a finalizable-from status, or the claim matches itself');
    assert.equal(claim.args.data.status, 'FINALIZED');
    // No bare update may sneak back in alongside the claim.
    const bareUpdate = tx.__calls.find((c) => c.model === 'rentalAgreement' && c.op === 'update');
    assert.equal(bareUpdate, undefined);
  });

  it('losing the claim throws AGREEMENT_NOT_FINALIZABLE before ANY other write', async () => {
    // count === 0 = the agreement was no longer DRAFT/READY_FOR_CHECKOUT, i.e. a
    // concurrent finalize already claimed it. Everything after the claim must be
    // skipped so the transaction aborts with nothing written.
    const tx = fakeTx({ claimCount: 0 });
    await assert.rejects(
      () => applyFinalizeWritesTx(tx, baseFinalizeCtx),
      (err) => {
        assert.equal(err.code, 'AGREEMENT_NOT_FINALIZABLE');
        assert.equal(err.status, 409, 'must reach the client as a 409 via appErrorHandler');
        return true;
      }
    );
    const ops = tx.__calls.map((c) => `${c.model}.${c.op}`);
    assert.deepEqual(ops, ['rentalAgreement.updateMany'],
      'the claim is the only write attempted when it loses');
    // The two writes the ticket is about, spelled out: no second CHECKOUT mileage
    // row, and no reservation re-advance.
    assert.equal(tx.__calls.filter((c) => c.model === 'vehicleMileageEntry').length, 0);
    assert.equal(tx.__calls.filter((c) => c.model === 'reservation').length, 0);
  });

  it('a lost claim never debits the customer credit at all', async () => {
    // The debit runs AFTER the claim (Innovation 2026-08-18), so a caller that was
    // always going to lose neither writes the debit nor holds a row lock on
    // Customer while the winner's transaction runs.
    const tx = fakeTx({ claimCount: 0 });
    await assert.rejects(
      () => applyFinalizeWritesTx(tx, {
        ...baseFinalizeCtx,
        creditApplied: 40,
        customerIdForCredit: 'cust-race',
        nextCustomerCredit: 0,
        creditNoteForCustomer: 'auto credit'
      }),
      /already finalized/i
    );
    assert.equal(tx.__calls.filter((c) => c.model === 'customer').length, 0,
      'a lost claim must not touch Customer — no debit, no lock');
    assert.equal(tx.__calls.filter((c) => c.model === 'rentalAgreementPayment').length, 0,
      'no payment row may be written when the claim is lost');
  });
});

describe('isFinalizeAlreadyDone (finalize double-submit guard)', () => {
  it('a finalizable agreement is not already done', () => {
    for (const status of FINALIZABLE_AGREEMENT_STATUSES) {
      assert.equal(isFinalizeAlreadyDone(status), false, `${status} must still be finalizable`);
    }
  });

  it('FINALIZED reports already-done so finalize() returns the existing contract untouched', () => {
    assert.equal(isFinalizeAlreadyDone('FINALIZED'), true);
  });

  it('CLOSED / CANCELLED are mistakes, not retries — they throw a 409', () => {
    for (const status of ['CLOSED', 'CANCELLED']) {
      assert.throws(
        () => isFinalizeAlreadyDone(status),
        (err) => {
          assert.equal(err.status, 409, 'must map to 409, not an opaque 500');
          assert.match(err.message, /can no longer be checked out/);
          return true;
        }
      );
    }
  });
});

// The finalized contract a replayed POST /:id/finalize is compared against.
// Prisma returns paidAmount as a Decimal; Number() is what the comparison does.
const FINALIZED_CONTRACT = {
  id: 'agr-1',
  status: 'FINALIZED',
  odometerOut: 12345,
  fuelOut: 0.88,
  paidAmount: 100,
  paymentMethod: 'CARD',
  paymentReference: 'TXN-99'
};

describe('finalizeReplayDivergence (which fields a replay would have changed)', () => {
  it('an identical retry — the double-click — diverges on nothing', () => {
    assert.deepEqual(finalizeReplayDivergence(FINALIZED_CONTRACT, {
      odometerOut: 12345,
      fuelOut: 0.875, // 7/8 as the client sends it; 0.88 as the column stores it
      paidAmount: 100,
      paymentMethod: 'CARD',
      paymentReference: 'TXN-99'
    }), []);
  });

  it('an empty body diverges on nothing (finalize falls back to the stored values)', () => {
    assert.deepEqual(finalizeReplayDivergence(FINALIZED_CONTRACT, {}), []);
    assert.deepEqual(finalizeReplayDivergence(FINALIZED_CONTRACT), []);
  });

  it('fields the payload omits, blanks or nulls are never a divergence', () => {
    assert.deepEqual(finalizeReplayDivergence(FINALIZED_CONTRACT, {
      odometerOut: null,
      paymentMethod: '   ',
      paidAmount: undefined,
      actorUserId: 'user-7' // not a finalize field at all
    }), []);
  });

  it('a corrected odometer is a divergence — it must NOT be answered with a silent 200', () => {
    assert.deepEqual(finalizeReplayDivergence(FINALIZED_CONTRACT, { odometerOut: 12999 }), ['odometerOut']);
  });

  it('a different paid amount is a divergence (money never gets silently dropped)', () => {
    assert.deepEqual(finalizeReplayDivergence(FINALIZED_CONTRACT, { paidAmount: 250 }), ['paidAmount']);
    // ...but the same money in another shape is not: '100.00' and Decimal(100) agree.
    assert.deepEqual(finalizeReplayDivergence(FINALIZED_CONTRACT, { paidAmount: '100.00' }), []);
  });

  it('reports every diverging field, not just the first', () => {
    assert.deepEqual(
      finalizeReplayDivergence(FINALIZED_CONTRACT, {
        odometerOut: 999, fuelOut: 0.25, paidAmount: 1, paymentMethod: 'CASH', paymentReference: 'OTHER'
      }),
      ['odometerOut', 'fuelOut', 'paidAmount', 'paymentMethod', 'paymentReference']
    );
  });

  it('a value sent against a column that is empty on the contract is a divergence', () => {
    assert.deepEqual(
      finalizeReplayDivergence({ ...FINALIZED_CONTRACT, paymentReference: null }, { paymentReference: 'TXN-99' }),
      ['paymentReference']
    );
  });

  it('fuel compares at the column precision — 0.875 sent vs 0.88 stored is the SAME tank', () => {
    // fuelOut is Decimal(4,2): a client sending 7/8 as 0.875 reads back as 0.88.
    // If this ever regresses, the plain double-click starts 409-ing.
    assert.deepEqual(finalizeReplayDivergence({ ...FINALIZED_CONTRACT, fuelOut: 0.88 }, { fuelOut: 0.875 }), []);
    assert.deepEqual(finalizeReplayDivergence({ ...FINALIZED_CONTRACT, fuelOut: 0.1 + 0.2 }, { fuelOut: 0.3 }), []);
    assert.deepEqual(finalizeReplayDivergence(FINALIZED_CONTRACT, { fuelOut: 0.5 }), ['fuelOut']);
  });
});

describe('RentalAgreementStatus coverage', () => {
  it('every status is either finalizable, already-done, or an explicit 409', () => {
    // If a 6th status is added to the enum, this trips instead of the new status
    // silently taking the throw branch in production.
    const accounted = new Set([...FINALIZABLE_AGREEMENT_STATUSES, 'FINALIZED', 'CLOSED', 'CANCELLED']);
    assert.deepEqual(
      Object.keys($Enums.RentalAgreementStatus).filter((v) => !accounted.has(v)),
      [],
      'a new RentalAgreementStatus must be classified in FINALIZABLE_AGREEMENT_STATUSES / isFinalizeAlreadyDone'
    );
  });
});

describe('applyChargesSyncTx', () => {
  it('deletes existing charges and inserts the new set in the same tx', async () => {
    const tx = fakeTx();
    const rows = [
      { rentalAgreementId: 'agr-x', name: 'Daily', chargeType: 'DAILY', quantity: 1, rate: 20, total: 20, taxable: true, selected: true, sortOrder: 0 }
    ];
    await applyChargesSyncTx(tx, {
      agreementId: 'agr-x',
      normalizedRows: rows,
      agreementUpdate: { subtotal: 20, taxes: 2.3, total: 22.3, balance: 22.3 }
    });
    const ops = tx.__calls.map((c) => `${c.model}.${c.op}`);
    assert.deepEqual(ops, [
      'rentalAgreementCharge.deleteMany',
      'rentalAgreementCharge.createMany',
      'rentalAgreement.update'
    ]);
  });

  it('skips createMany when there are no rows (preserves the wipe semantics)', async () => {
    const tx = fakeTx();
    await applyChargesSyncTx(tx, {
      agreementId: 'agr-y',
      normalizedRows: [],
      agreementUpdate: { subtotal: 0, taxes: 0, total: 0, balance: 0 }
    });
    const ops = tx.__calls.map((c) => `${c.model}.${c.op}`);
    assert.deepEqual(ops, ['rentalAgreementCharge.deleteMany', 'rentalAgreement.update']);
  });

  it('rolls back contract: throws if createMany fails after deleteMany (Prisma will undo the delete)', async () => {
    const tx = fakeTx({ failOn: 'rentalAgreementCharge.createMany' });
    await assert.rejects(
      () => applyChargesSyncTx(tx, {
        agreementId: 'agr-z',
        normalizedRows: [{ rentalAgreementId: 'agr-z', name: 'X', chargeType: 'UNIT', quantity: 1, rate: 1, total: 1, taxable: false, selected: true, sortOrder: 0 }],
        agreementUpdate: { subtotal: 1, taxes: 0, total: 1, balance: 1 }
      }),
      /forced failure on rentalAgreementCharge\.createMany/
    );
    // The agreement.update never ran — we threw before reaching it.
    const updateOps = tx.__calls.filter((c) => c.model === 'rentalAgreement' && c.op === 'update');
    assert.equal(updateOps.length, 0);
  });
});
