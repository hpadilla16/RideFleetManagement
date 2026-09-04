/**
 * refund-rails — the row→rail truth table for View Payments refunds.
 *
 * Pins the routing that refundPayment dispatches on: rails are decided by the
 * ROW's own evidence (reference prefix / gateway column / notes), never by the
 * tenant's current gateway, and the two iPOS spellings never blur — `IPOS_`
 * (underscore, Transact CNP → gateway void) is not `IPOS:` (colon, HPP e-com →
 * bookkeeping only, we have no refund API for it).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveRefundRail, isSameLocalDay } from './refund-rails.js';

test('PAYARC: and AUTHNET: prefixes keep their existing card rails', () => {
  assert.deepEqual(
    resolveRefundRail({ reference: 'PAYARC:ch_123abc', method: 'CARD' }),
    { rail: 'PAYARC', key: 'ch_123abc' },
  );
  assert.deepEqual(
    resolveRefundRail({ reference: 'AUTHNET:120058491022', method: 'CARD' }),
    { rail: 'AUTHNET', key: '120058491022' },
  );
});

test('IPOS_ (underscore) rows route to the Transact rail, display suffix stripped', () => {
  assert.deepEqual(
    resolveRefundRail({ reference: 'IPOS_COF:A8K2X9 ****4821', method: 'CARD', gateway: 'SPIN' }),
    { rail: 'TRANSACT', key: 'A8K2X9' },
  );
  assert.equal(resolveRefundRail({ reference: 'IPOS_REAUTH:RRN9912' }).rail, 'TRANSACT');
});

test('IPOS: (colon, HPP) is NOT the Transact rail — bookkeeping only', () => {
  assert.deepEqual(
    resolveRefundRail({ reference: 'IPOS:K1a2b3c4d5e6f7g8', method: 'CARD' }),
    { rail: 'RECORD', key: null },
  );
});

test('SPIn terminal sale: gateway SPIN + CARD, ReferenceId taken from the notes', () => {
  assert.deepEqual(
    resolveRefundRail({
      reference: 'A8K2X9', // AuthCode — NOT the void/return key
      method: 'CARD',
      gateway: 'SPIN',
      notes: 'Spin Sale · RFM-RES-1-1756224061',
    }),
    { rail: 'SPIN', key: 'RFM-RES-1-1756224061' },
  );
});

test('SPIn row with no sale note falls back to the reference field', () => {
  assert.deepEqual(
    resolveRefundRail({ reference: 'RFM-RES-2-99', method: 'CARD', gateway: 'SPIN', notes: '' }),
    { rail: 'SPIN', key: 'RFM-RES-2-99' },
  );
});

test('SPIn gateway with a non-CARD method is not a card rail', () => {
  assert.equal(resolveRefundRail({ reference: 'X', method: 'CASH', gateway: 'SPIN' }).rail, 'RECORD');
});

test('manual rows (cash / check / hand-typed card refs) are bookkeeping only', () => {
  assert.equal(resolveRefundRail({ reference: 'OTC-1756224061', method: 'CASH' }).rail, 'RECORD');
  assert.equal(resolveRefundRail({ reference: '****1234 · auth A8K2X9', method: 'CARD' }).rail, 'RECORD');
  assert.equal(resolveRefundRail({}).rail, 'RECORD');
});

test('isSameLocalDay — calendar day boundary, invalid dates are never "today"', () => {
  const noonToday = new Date();
  noonToday.setHours(12, 0, 0, 0);
  assert.equal(isSameLocalDay(noonToday, noonToday), true);
  const yesterday = new Date(noonToday.getTime() - 24 * 60 * 60 * 1000);
  assert.equal(isSameLocalDay(yesterday, noonToday), false);
  assert.equal(isSameLocalDay('not-a-date', noonToday), false);
  assert.equal(isSameLocalDay(null, noonToday), false);
});
