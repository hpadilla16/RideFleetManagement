import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  mintHppSession,
  verifyHppPayment,
  verifyAndRecordHppReturn,
  hppNotConfiguredMessage,
} from './ipos-hpp-payment.service.js';

// gitleaks: obvious dummies only.
const DUMMY_TPN = '000011112222';

beforeEach(() => {
  delete process.env.IPOS_HPP_DRY_RUN;
  delete process.env.SPIN_DRY_RUN;
});
afterEach(() => {
  delete process.env.IPOS_HPP_DRY_RUN;
  delete process.env.SPIN_DRY_RUN;
});

function memoryPrisma() {
  const auditRows = [];
  const paymentRows = [];
  const reservationUpdates = [];
  return {
    auditRows,
    paymentRows,
    reservationUpdates,
    auditLog: {
      async create({ data }) {
        auditRows.push({ id: `a${auditRows.length + 1}`, ...data });
        return auditRows[auditRows.length - 1];
      },
      async findFirst({ where }) {
        return auditRows.find(
          (row) => row.reservationId === where.reservationId
            && String(row.metadata || '').includes(where.metadata.contains),
        ) || null;
      },
    },
    reservationPayment: {
      async findFirst({ where }) {
        return paymentRows.find(
          (row) => row.reservationId === where.reservationId && row.reference === where.reference,
        ) || null;
      },
      async create({ data }) {
        paymentRows.push({ id: `p${paymentRows.length + 1}`, ...data });
        return paymentRows[paymentRows.length - 1];
      },
    },
    reservation: {
      async update({ where, data }) {
        reservationUpdates.push({ where, data });
        return { id: where.id, ...data };
      },
    },
  };
}

const reservation = {
  id: 'res-1',
  tenantId: 'tenant-1',
  reservationNumber: 'RES20260001',
};

function configuredResolve() {
  return async () => ({
    source: 'TENANT', reason: 'TENANT_CONFIG', tenantId: 'tenant-1',
    environment: 'sandbox', tpn: DUMMY_TPN, hppToken: 'dummy-hpp-token-not-real',
    expiryDays: 3, enabled: true, maskedTpn: '0000****2222',
  });
}
function unconfiguredResolve(reason = 'NOT_CONFIGURED') {
  return async () => ({ source: 'NONE', reason, tpn: '', hppToken: '' });
}

describe('ipos-hpp-payment: mintHppSession', () => {
  it('mints, binds the reference to the reservation via AuditLog, and builds the return URL from the reference', async () => {
    const db = memoryPrisma();
    let mintedArgs = null;
    const out = await mintHppSession({
      reservation,
      amount: 120.5,
      buildReturnUrl: (ref) => `https://api.example.com/return?iposRef=${ref}`,
      cancelUrl: 'https://api.example.com/cancel',
      origin: 'PORTAL',
    }, {
      prisma: db,
      resolveConfig: configuredResolve(),
      mint: async (args) => { mintedArgs = args; return { url: 'https://payment.ipospays.tech/pay?t=x', transactionReferenceId: args.transactionReferenceId }; },
    });

    assert.equal(out.url, 'https://payment.ipospays.tech/pay?t=x');
    assert.match(out.referenceId, /^[A-Za-z0-9]{1,20}$/);
    assert.equal(mintedArgs.returnUrl, `https://api.example.com/return?iposRef=${out.referenceId}`);
    assert.equal(db.auditRows.length, 1);
    assert.equal(db.auditRows[0].reservationId, 'res-1');
    assert.equal(db.auditRows[0].tenantId, 'tenant-1');
    assert.ok(String(db.auditRows[0].metadata).includes(`"iposHppRef":"${out.referenceId}"`));
  });

  it('FAILS CLOSED when the tenant HPP config is missing — refusal, never an Auth.Net fallback', async () => {
    const db = memoryPrisma();
    let minted = false;
    await assert.rejects(
      () => mintHppSession({
        reservation, amount: 100,
        buildReturnUrl: () => 'https://x.example/r',
      }, {
        prisma: db,
        resolveConfig: unconfiguredResolve(),
        mint: async () => { minted = true; return { url: 'x' }; },
      }),
      (err) => err.code === 'GATEWAY_NOT_CONFIGURED'
        && /Settings/.test(err.message)
        && /NOT falling back to Authorize\.Net/i.test(err.message),
    );
    assert.equal(minted, false, 'must not mint anything');
    assert.equal(db.auditRows.length, 0);
  });

  it('the operator-facing message distinguishes an incomplete setup', () => {
    assert.match(hppNotConfiguredMessage({ reason: 'INCOMPLETE_CONFIG' }), /incomplete/i);
    assert.match(hppNotConfiguredMessage({ reason: 'NOT_CONFIGURED' }), /not configured/i);
  });

  it('refuses a zero/negative amount as ALREADY_PAID', async () => {
    await assert.rejects(
      () => mintHppSession({
        reservation, amount: 0, buildReturnUrl: () => 'https://x.example/r',
      }, { prisma: memoryPrisma(), resolveConfig: configuredResolve(), mint: async () => ({ url: 'x' }) }),
      (err) => err.code === 'ALREADY_PAID',
    );
  });
});

describe('ipos-hpp-payment: verifyHppPayment', () => {
  async function mintedSetup({ queryResponse } = {}) {
    const db = memoryPrisma();
    const { referenceId } = await mintHppSession({
      reservation, amount: 120.5,
      buildReturnUrl: (ref) => `https://x.example/r?iposRef=${ref}`,
    }, {
      prisma: db,
      resolveConfig: configuredResolve(),
      mint: async (args) => ({ url: 'https://x', transactionReferenceId: args.transactionReferenceId }),
    });
    const deps = {
      prisma: db,
      resolveConfig: configuredResolve(),
      query: async () => queryResponse || {
        found: true, approved: true, responseCode: 200, responseMessage: 'Successful',
        errMessage: '', transactionId: 'tx123abc', amount: 120.5,
        cardType: 'VISA', cardLast4: '1111',
      },
    };
    return { db, referenceId, deps };
  }

  it('verifies an approved payment via queryPaymentStatus and returns the IPOS reference', async () => {
    const { referenceId, deps } = await mintedSetup();
    const verdict = await verifyHppPayment({ reservation, iposRef: referenceId }, deps);
    assert.equal(verdict.approved, true);
    assert.equal(verdict.amount, 120.5);
    assert.equal(verdict.reference, 'IPOS:tx123abc');
    assert.equal(verdict.duplicate, false);
  });

  it('a CENTS echo reconciles against the minted amount — the first live charge booked 100x', async () => {
    // 2026-08-30: the live rail echoed 112 (cents) for a $1.12 mint and the
    // recording booked $112.00. Units are decided by agreement with the mint.
    const { referenceId, deps } = await mintedSetup({
      queryResponse: {
        found: true, approved: true, responseCode: 0, responseMessage: 'APPROVED',
        errMessage: '', transactionId: 'tx123abc', amount: 12050, // cents for $120.50
        cardType: 'VISA', cardLast4: '1111',
      },
    });
    const verdict = await verifyHppPayment({ reservation, iposRef: referenceId }, deps);
    assert.equal(verdict.amount, 120.5, 'cents echo must record as dollars');
  });

  it('an echo matching NEITHER dollars nor cents is refused, never recorded', async () => {
    const { referenceId, deps } = await mintedSetup({
      queryResponse: {
        found: true, approved: true, responseCode: 200, responseMessage: 'APPROVED',
        errMessage: '', transactionId: 'tx123abc', amount: 999.99,
        cardType: 'VISA', cardLast4: '1111',
      },
    });
    await assert.rejects(
      () => verifyHppPayment({ reservation, iposRef: referenceId }, deps),
      (err) => err.code === 'AMOUNT_MISMATCH',
    );
  });

  it('a DECORATED reference from the gateway redirect still verifies (live bug, twice)', async () => {
    const { referenceId, deps } = await mintedSetup();
    const verdict = await verifyHppPayment(
      { reservation, iposRef: `${referenceId}?TransactionId=999&code=200` },
      deps,
    );
    assert.equal(verdict.approved, true);
    assert.equal(verdict.amount, 120.5);
  });

  it('refuses a reference that was never minted for this reservation (replay guard)', async () => {
    const { deps } = await mintedSetup();
    await assert.rejects(
      () => verifyHppPayment({ reservation, iposRef: 'PLSOMEBODYELSE1' }, deps),
      (err) => err.code === 'UNKNOWN_REFERENCE',
    );
  });

  it('refuses a reference minted for a DIFFERENT reservation', async () => {
    const { referenceId, deps } = await mintedSetup();
    await assert.rejects(
      () => verifyHppPayment({ reservation: { ...reservation, id: 'res-OTHER' }, iposRef: referenceId }, deps),
      (err) => err.code === 'UNKNOWN_REFERENCE',
    );
  });

  it('a non-approved gateway status never verifies (redirect is not trusted)', async () => {
    const { referenceId, deps } = await mintedSetup({
      queryResponse: {
        found: true, approved: false, responseCode: 400,
        responseMessage: 'Declined', errMessage: 'Declined', amount: 120.5, transactionId: 'tx1',
      },
    });
    await assert.rejects(
      () => verifyHppPayment({ reservation, iposRef: referenceId }, deps),
      (err) => err.code === 'PAYMENT_NOT_COMPLETED',
    );
  });

  it('an approved status with a missing amount never verifies', async () => {
    const { referenceId, deps } = await mintedSetup({
      queryResponse: { found: true, approved: true, responseCode: 200, amount: 0, transactionId: 'tx1' },
    });
    await assert.rejects(
      () => verifyHppPayment({ reservation, iposRef: referenceId }, deps),
      (err) => err.code === 'PAYMENT_NOT_COMPLETED',
    );
  });

  it('flags a duplicate when the IPOS reference is already recorded', async () => {
    const { db, referenceId, deps } = await mintedSetup();
    await db.reservationPayment.create({
      data: { reservationId: 'res-1', reference: 'IPOS:tx123abc', amount: 120.5 },
    });
    const verdict = await verifyHppPayment({ reservation, iposRef: referenceId }, deps);
    assert.equal(verdict.duplicate, true);
    assert.equal(verdict.existingAmount, 120.5);
  });
});

describe('ipos-hpp-payment: verifyAndRecordHppReturn (website checkout)', () => {
  async function setup() {
    const db = memoryPrisma();
    const { referenceId } = await mintHppSession({
      reservation, amount: 99,
      buildReturnUrl: (ref) => `https://x.example/r?iposRef=${ref}`,
      origin: 'PUBLIC',
    }, {
      prisma: db,
      resolveConfig: configuredResolve(),
      mint: async (args) => ({ url: 'https://x', transactionReferenceId: args.transactionReferenceId }),
    });
    const deps = {
      prisma: db,
      resolveConfig: configuredResolve(),
      query: async () => ({
        found: true, approved: true, responseCode: 200,
        transactionId: 'txweb1', amount: 99, cardType: 'VISA', cardLast4: '1111',
      }),
    };
    return { db, referenceId, deps };
  }

  it('records the verified payment once and nudges paymentStatus to PAID', async () => {
    const { db, referenceId, deps } = await setup();
    const out = await verifyAndRecordHppReturn({ reservation, iposRef: referenceId }, deps);
    assert.equal(out.ok, true);
    assert.equal(out.duplicate, false);
    assert.equal(out.amount, 99);
    assert.equal(db.paymentRows.length, 1);
    assert.equal(db.paymentRows[0].reference, 'IPOS:txweb1');
    assert.equal(db.paymentRows[0].status, 'PAID');
    assert.equal(db.paymentRows[0].amount, 99);
    assert.equal(db.reservationUpdates.length, 1);
    assert.equal(db.reservationUpdates[0].data.paymentStatus, 'PAID');
  });

  it('a re-visited return URL does NOT double-record', async () => {
    const { db, referenceId, deps } = await setup();
    await verifyAndRecordHppReturn({ reservation, iposRef: referenceId }, deps);
    const second = await verifyAndRecordHppReturn({ reservation, iposRef: referenceId }, deps);
    assert.equal(second.duplicate, true);
    assert.equal(db.paymentRows.length, 1, 'exactly one payment row after two returns');
    assert.equal(db.reservationUpdates.length, 1, 'PAID nudge happens once');
  });
});
