/**
 * B5 Phase 1 — the P2002 idempotency collapse in the canonical payment post
 * path (reservationPricingService.postPayment). Verifies the safety net is a
 * PURE addition: identical behavior for every existing caller, and a duplicate
 * gateway reference returns the existing row instead of double-posting.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '../../lib/prisma.js';
import { reservationPricingService } from './reservation-pricing.service.js';

let db;
let createCalls;

function seed() {
  db = { payments: [], reservations: [] };
  createCalls = 0;
  db.reservations.push({
    id: 'res1', tenantId: 't1', status: 'CONFIRMED', rentalAgreement: null,
  });
  prisma.reservation.findFirst = async () => db.reservations[0];
  prisma.reservation.update = async ({ data }) => Object.assign(db.reservations[0], data);
  prisma.reservationPayment.findFirst = async ({ where }) => db.payments.find(
    (p) => p.reservationId === where.reservationId && p.reference === where.reference,
  ) || null;
  prisma.reservationPayment.findUnique = async ({ where }) => db.payments.find((p) => p.id === where.id) || null;
  prisma.reservationPayment.update = async ({ where, data }) => {
    const row = db.payments.find((p) => p.id === where.id);
    Object.assign(row, data);
    return row;
  };
  prisma.auditLog.create = async () => ({});
  prisma.rentalAgreement.findUnique = async () => null;
}

// Simulates the PARTIAL unique index: only gateway-prefixed references collide.
function installIndex() {
  prisma.reservationPayment.create = async ({ data }) => {
    createCalls += 1;
    const gateway = /^(IPOS|AUTHNET|SPIN):/.test(String(data.reference || ''));
    if (gateway && db.payments.some((p) => p.reservationId === data.reservationId && p.reference === data.reference)) {
      const err = new Error('Unique constraint failed');
      err.code = 'P2002';
      throw err;
    }
    const row = { id: `pay_${db.payments.length + 1}`, createdAt: new Date(), ...data };
    db.payments.push(row);
    return row;
  };
}

beforeEach(() => { seed(); installIndex(); });

test('P2002 on a gateway reference → returns the EXISTING row, no double post', async () => {
  const first = await reservationPricingService.postPayment('res1', {
    amount: 100, method: 'CARD', reference: 'IPOS:ABC123', status: 'PAID',
  }, { tenantId: 't1' });
  assert.equal(db.payments.length, 1);

  // the webhook and the poll both race past the caller-level dedupe
  const second = await reservationPricingService.postPayment('res1', {
    amount: 100, method: 'CARD', reference: 'IPOS:ABC123', status: 'PAID',
  }, { tenantId: 't1' });

  assert.equal(db.payments.length, 1, 'exactly one payment row survives');
  assert.equal(second.id, first.id, 'the duplicate caller gets the winner row');
  assert.equal(createCalls, 2, 'the DB constraint — not a read — is what stopped it');
});

test('manual references are UNAFFECTED — two real payments with the same typed ref both post', async () => {
  await reservationPricingService.postPayment('res1', {
    amount: 50, method: 'CASH', reference: '1234', status: 'PAID',
  }, { tenantId: 't1' });
  await reservationPricingService.postPayment('res1', {
    amount: 50, method: 'CASH', reference: '1234', status: 'PAID',
  }, { tenantId: 't1' });
  assert.equal(db.payments.length, 2, 'legitimate manual double-payment still works (prod has 72 such groups)');
});

test('non-P2002 errors still propagate unchanged', async () => {
  prisma.reservationPayment.create = async () => { throw new Error('connection lost'); };
  await assert.rejects(
    reservationPricingService.postPayment('res1', {
      amount: 10, method: 'CARD', reference: 'IPOS:X', status: 'PAID',
    }, { tenantId: 't1' }),
    /connection lost/,
  );
});
