/**
 * The pre-check-in route's half of the declined-insurance gate.
 *
 * The gate module has its own unit tests; what nobody covered is the WIRING —
 * that POST /customer-info/:token actually surfaces the refusal as a 409 with a
 * `code`, instead of letting it fall through to next(e) and surface as a 500
 * with no code for the customer to act on. That mapping is three lines of
 * try/catch in a 300-line handler and is exactly the kind of thing that gets
 * refactored away silently.
 *
 * Handler-level, no DB and no app boot: pull the real handler out of the router
 * stack (same introspection pattern as reservations/open-rental-409.test.mjs)
 * and invoke it with a mock req/res while stubbing the prisma singleton. Every
 * assertion here bails before any write.
 *
 * Run: node --test --test-force-exit \
 *        src/modules/customer-portal/precheckin-insurance-gate.test.mjs
 */
import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '../../lib/prisma.js';
import { customerPortalRouter } from './customer-portal.routes.js';
import { INSURANCE_LOCK } from '../checkout-session/insurance-selection-gate.js';
import { settingsService } from '../settings/settings.service.js';

function handlerFor(method, path) {
  for (const layer of customerPortalRouter.stack || []) {
    const route = layer.route;
    if (!route || route.path !== path) continue;
    if (!route.methods?.[method]) continue;
    const handlers = (route.stack || []).map((h) => h.handle).filter((h) => typeof h === 'function');
    return handlers[handlers.length - 1];
  }
  return null;
}

function mockRes() {
  const res = { statusCode: null, body: null };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (payload) => { res.body = payload; return res; };
  return res;
}

/** A complete pre-check-in body — every required field present. */
function body(insuranceSelection) {
  return {
    firstName: 'Ada', lastName: 'Lovelace', email: 'ada@example.com', phone: '7875550100',
    dateOfBirth: '1990-01-01', licenseNumber: 'D123', licenseState: 'PR',
    address1: '1 Main St', city: 'San Juan', state: 'PR', zip: '00901', country: 'PR',
    insuranceDocumentUrl: 'data:image/png;base64,AAAA',
    insuranceSelection,
  };
}

const RESERVATION = { id: 'r1', tenantId: 't1', customerId: 'c1', customer: { id: 'c1' } };

let agreement;
let writes;
const STUBBED = [
  'reservation.findFirst', 'rentalAgreement.findUnique', 'rentalAgreement.update',
  'checkoutSession.findUnique', 'handoffToken.findFirst', 'agreementSectionInitial.findFirst',
  'customer.update', 'reservationCharge.deleteMany',
];
const realFns = {};

beforeEach(() => {
  writes = [];
  agreement = { id: 'a1', reservationId: 'r1', tcSignedAt: null, declinedInsurance: false };
  for (const key of STUBBED) {
    const [model, fn] = key.split('.');
    realFns[key] = prisma[model][fn];
  }
  prisma.reservation.findFirst = async () => RESERVATION;
  prisma.rentalAgreement.findUnique = async () => agreement;
  prisma.rentalAgreement.update = async (op) => { writes.push(['rentalAgreement.update', op]); return {}; };
  prisma.checkoutSession.findUnique = async () => null; // pre-check-in: no session yet
  prisma.handoffToken.findFirst = async () => null;
  prisma.agreementSectionInitial.findFirst = async () => null;
  prisma.customer.update = async (op) => { writes.push(['customer.update', op]); return {}; };
  prisma.reservationCharge.deleteMany = async (op) => { writes.push(['charges.deleteMany', op]); return {}; };
});

afterEach(() => {
  for (const key of Object.keys(realFns)) {
    const [model, fn] = key.split('.');
    prisma[model][fn] = realFns[key];
  }
});

async function post(reqBody) {
  const handler = handlerFor('post', '/customer-info/:token');
  assert.ok(handler, 'POST /customer-info/:token handler must exist');
  const res = mockRes();
  let nextErr;
  await handler({ params: { token: 'TOK' }, body: reqBody, ip: '1.2.3.4', headers: {} }, res, (e) => { nextErr = e; });
  return { res, nextErr };
}

test('decline after signing → 409 with a code, not a 500 via next(e)', async () => {
  agreement.tcSignedAt = new Date();
  const { res, nextErr } = await post(body({ declinedCoverage: true }));

  assert.equal(nextErr, undefined, 'must not fall through to the error middleware');
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.code, INSURANCE_LOCK.SIGNED);
  assert.match(res.body.error, /counter/i, 'customer copy must say what to do next');
  assert.deepEqual(writes, [], 'refusal must land before any mutation');
});

test('PLAN selection after a signed DECLINE is refused too', async () => {
  // The branch that had no preflight at all. A customer who declined, signed,
  // and then buys coverage here used to sail through and produce a contract
  // whose decline addendum contradicts its insurance charge, silently.
  agreement.tcSignedAt = new Date();
  agreement.declinedInsurance = true;
  const { res, nextErr } = await post(body({ selectedPlanCode: 'PREMIUM' }));

  assert.equal(nextErr, undefined);
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.code, INSURANCE_LOCK.SIGNED);
  assert.deepEqual(writes, [], 'must refuse before the charges deleteMany');
});

test('mid-signature decline → 409 TC_SIGNING_IN_PROGRESS', async () => {
  prisma.handoffToken.findFirst = async () => ({ id: 'tok' });
  prisma.agreementSectionInitial.findFirst = async () => ({ id: 'i1' });
  const { res } = await post(body({ declinedCoverage: true }));

  assert.equal(res.statusCode, 409);
  assert.equal(res.body.code, INSURANCE_LOCK.SIGNING);
  assert.deepEqual(writes, []);
});

// For the ALLOWED cases the handler runs on past the preflight into the rest of
// pre-check-in, which touches models this test deliberately does not stub — so
// it fails somewhere downstream. That is fine and is not what is under test:
// what matters is that the request got PAST the gate. The proof is
// customer.update, the first write after the preflight, having been reached.
function passedTheGate({ res, writes: w }) {
  assert.notEqual(res.statusCode, 409, `unexpected refusal: ${JSON.stringify(res.body)}`);
  assert.ok(
    w.some(([name]) => name === 'customer.update'),
    'execution should have reached the first write after the preflight',
  );
}

test('a normal plan selection on an unsigned agreement is NOT refused', async () => {
  // false-vs-false is a no-op by the gate's own rule; the common case must not
  // start 409ing just because the preflight now covers both branches.
  const { res } = await post(body({ selectedPlanCode: 'PREMIUM' }));
  passedTheGate({ res, writes });
});

test('a re-submitted decline on an unsigned agreement is NOT refused', async () => {
  agreement.declinedInsurance = true;
  const { res } = await post(body({ declinedCoverage: true }));
  passedTheGate({ res, writes });
});

// ---------------------------------------------------------------------------
// The decline-signature columns are NOT covered by the flag's no-flip rule.
// buildDeclinedInsuranceBlock prints declinedInsuranceSignatureDataUrl on the
// contract, so a re-submit after signing would swap the addendum's signature
// and re-date it to after the agreement was signed — silently, because the flag
// itself did not move and the gate rightly allowed the request through.
// ---------------------------------------------------------------------------

/** Stub the models between the preflight and the decline branch. */
function stubPathToDeclineBranch() {
  realFns['reservationPricingSnapshot.findUnique'] = prisma.reservationPricingSnapshot.findUnique;
  realFns['reservationCharge.findMany'] = prisma.reservationCharge.findMany;
  prisma.reservationPricingSnapshot.findUnique = async () => null;
  prisma.reservationCharge.findMany = async () => [];
  const realDiscount = settingsService.getPrecheckinDiscount;
  settingsService.getPrecheckinDiscount = async () => null;
  return () => { settingsService.getPrecheckinDiscount = realDiscount; };
}

const SIGNATURE = `data:image/png;base64,${'A'.repeat(400)}`;

test('a sealed contract keeps its original decline signature and date', async () => {
  const restore = stubPathToDeclineBranch();
  try {
    agreement.declinedInsurance = true;   // no flip -> gate allows the request
    agreement.tcSignedAt = new Date();    // ...but the contract is already signed
    const { res } = await post(body({ declinedCoverage: true, signatureDataUrl: SIGNATURE }));
    assert.notEqual(res.statusCode, 409, 'the no-flip re-submit must still be accepted');

    const update = writes.find(([name]) => name === 'rentalAgreement.update');
    assert.ok(update, 'the decline branch should still have run');
    const data = update[1].data;
    assert.equal(data.declinedInsurance, true);
    assert.ok(!('declinedInsuranceSignatureDataUrl' in data),
      'must not overwrite the signature printed on a signed contract');
    assert.ok(!('declinedInsuranceSignedAt' in data),
      'must not re-date the acknowledgement to after the agreement was signed');
  } finally {
    restore();
  }
});

test('an unsigned contract still records the decline signature', async () => {
  // The freeze must be conditional, not a blanket removal — pre-check-in is
  // where this signature is legitimately captured in the first place.
  const restore = stubPathToDeclineBranch();
  try {
    const { res } = await post(body({ declinedCoverage: true, signatureDataUrl: SIGNATURE }));
    assert.notEqual(res.statusCode, 409);
    const update = writes.find(([name]) => name === 'rentalAgreement.update');
    const data = update[1].data;
    assert.equal(data.declinedInsuranceSignatureDataUrl, SIGNATURE);
    assert.ok(data.declinedInsuranceSignedAt instanceof Date);
  } finally {
    restore();
  }
});

test('validation still runs before the gate', async () => {
  // The preflight sits after field validation; a body missing required fields
  // must still get the 400 rather than a confusing 409.
  const incomplete = { ...body({ declinedCoverage: true }), city: '' };
  agreement.tcSignedAt = new Date();
  const { res } = await post(incomplete);
  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /required pre-check-in items/i);
});
