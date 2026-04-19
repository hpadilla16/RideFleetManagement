import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { applyFinalizeWritesTx, applyChargesSyncTx } from './rental-agreements.service.js';

// Build a fake `tx` that records every method called and lets us inject
// failures on specific operations. Mirrors the subset of the Prisma client
// used inside the transaction callbacks — if the production code ever
// reaches for a model not listed here, the test breaks loudly (which is
// what we want — every model used inside the tx must be on `tx`, never on
// the global prisma).
function fakeTx({ failOn } = {}) {
  const calls = [];
  const make = (model) => ({
    update: async (args) => {
      calls.push({ model, op: 'update', args });
      if (failOn === `${model}.update`) throw new Error(`forced failure on ${model}.update`);
      // Mirror what real prisma.update returns for the agreement (other tests
      // depend on the reservationId field).
      if (model === 'rentalAgreement') return { id: args.where?.id, reservationId: 'res-from-update' };
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
    rentalAgreementPayment: make('rentalAgreementPayment'),
    rentalAgreementCharge: make('rentalAgreementCharge'),
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
  creditNoteForCustomer: null
};

describe('applyFinalizeWritesTx', () => {
  it('writes agreement → reservation → payment in order on the tx client', async () => {
    const tx = fakeTx();
    const result = await applyFinalizeWritesTx(tx, baseFinalizeCtx);
    const order = tx.__calls.map((c) => `${c.model}.${c.op}`);
    assert.deepEqual(order, [
      'rentalAgreement.update',
      'reservation.update',
      'rentalAgreementPayment.create'
    ]);
    assert.equal(result.id, 'agr-1');
  });

  it('applies the customer credit deduction BEFORE updating the agreement', async () => {
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
      'customer.update',
      'rentalAgreement.update',
      'reservation.update',
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
    assert.deepEqual(ops, ['rentalAgreement.update', 'reservation.update']);
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
    // The agreement update DID happen against the tx (which is correct —
    // the rollback is Prisma's job, not ours). The point is no payment.create
    // ever ran, because we threw mid-flight.
    const ops = tx.__calls.map((c) => `${c.model}.${c.op}`);
    assert.deepEqual(ops, ['rentalAgreement.update', 'reservation.update']);
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
      'customer.update',
      'rentalAgreement.update',
      'reservation.update',
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
    const agreementUpdate = tx.__calls.find((c) => c.model === 'rentalAgreement' && c.op === 'update');
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
