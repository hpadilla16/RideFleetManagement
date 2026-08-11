/**
 * Payments in the ⌘K palette — DB-free.
 *
 * Hector, 2026-08-11: agents put a receipt/auth reference and the card's
 * last 4 on manual payments; the palette must find them. The trap worth a
 * test file: agreement payments MIRROR into reservation payments, and a
 * search across both tables shows the same money twice — which reads as a
 * double charge to whoever is searching.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mapPaymentResults, PAYMENT_QUERY_MIN } from './payment-search.js';

const resv = { id: 'res-1', reservationNumber: 'RES-123456', customer: { firstName: 'Ana', lastName: 'Rivera' } };
const rp = (over = {}) => ({
  id: 'rp-1', amount: 96.34, method: 'CASH', reference: '****1234 · rec 8871',
  paidAt: '2026-08-11T15:00:00Z', rentalAgreementPaymentId: null, reservation: resv, ...over,
});
const ap = (over = {}) => ({
  id: 'ap-1', amount: 96.34, method: 'CASH', reference: '****1234 · rec 8871',
  paidAt: '2026-08-11T15:00:00Z', rentalAgreement: { reservation: resv }, ...over,
});

test('a reservation payment becomes a palette row an agent can act on', () => {
  const [row] = mapPaymentResults([rp()], []);
  assert.equal(row.type, 'payment');
  assert.equal(row.title, '$96.34 · CASH');
  assert.equal(row.subtitle, '****1234 · rec 8871 · RES-123456 · Ana Rivera');
  assert.equal(row.href, '/reservations/res-1/payments');
  assert.equal('paidAt' in row, false, 'the sort key stays internal');
});

test('THE MIRROR: the same payment in both tables is ONE result', () => {
  // Recorded on the agreement, mirrored into the reservation table with
  // rentalAgreementPaymentId pointing back. Two rows on screen would read as
  // a double charge.
  const out = mapPaymentResults([rp({ rentalAgreementPaymentId: 'ap-1' })], [ap()]);
  assert.equal(out.length, 1);
  assert.equal(out[0].href, '/reservations/res-1/payments', 'the reservation-side row wins');
});

test('an agreement payment that was never mirrored still appears', () => {
  const out = mapPaymentResults([], [ap({ id: 'ap-solo', reference: 'auth Z9' })]);
  assert.equal(out.length, 1);
  assert.match(out[0].subtitle, /auth Z9/);
});

test('newest first — the payment being hunted is almost always recent', () => {
  const out = mapPaymentResults([
    rp({ id: 'old', paidAt: '2026-06-01T00:00:00Z', reference: 'old' }),
    rp({ id: 'new', paidAt: '2026-08-11T00:00:00Z', reference: 'new' }),
  ], []);
  assert.equal(out[0].subtitle.startsWith('new'), true);
});

test('AUTH_HOLD renders readable, not enum-shaped', () => {
  const [row] = mapPaymentResults([rp({ method: 'AUTH_HOLD' })], []);
  assert.equal(row.title, '$96.34 · AUTH HOLD');
});

test('a payment whose reservation is gone cannot produce a dead link', () => {
  const out = mapPaymentResults([rp({ reservation: null })], [ap({ rentalAgreement: { reservation: null } })]);
  assert.equal(out.length, 0);
});

test('missing customer or reference degrade to shorter subtitles, never "undefined"', () => {
  const [row] = mapPaymentResults([rp({ reference: null, reservation: { ...resv, customer: null } })], []);
  assert.equal(row.subtitle, 'RES-123456');
  assert.equal(row.subtitle.includes('undefined'), false);
});

test('the payment bucket needs a card-last-4-sized query', () => {
  // The palette's global minimum is 2; "12" against `reference contains`
  // matches half the table. Four is exactly a last-4.
  assert.equal(PAYMENT_QUERY_MIN, 4);
});
