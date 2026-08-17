/**
 * MC-1 against a REAL Postgres — reservationsService.getById must return
 * RentalAgreement.declinedInsurance.
 *
 * WHY THIS EXISTS ALONGSIDE THE STUB SUITE. The companion DB-free suite
 * (src/modules/checkout-session/declined-insurance-and-sign-url.test.mjs)
 * asserts that getById ASKS Prisma for the column. Only a real database
 * proves the value actually comes BACK — which is the thing that was broken
 * in production: the column was populated (the kiosk writes it and reads it
 * correctly), but the reservation detail payload the checkout wizard seeds
 * its decline switch from silently dropped it, so `!!undefined` rendered the
 * switch OFF for every reservation. An agent who toggled it to look would
 * POST `declined: false` and erase the addendum from the contract.
 *
 * Run:  npm install --no-save embedded-postgres    (once, inside backend/)
 *       npm run test:declined-insurance-embedded
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { bootEmbeddedPg } from '../../../scripts/embedded-pg-boot.mjs';

// Imported dynamically AFTER bootEmbeddedPg sets DATABASE_URL — the shared
// prisma singleton binds its URL at import time.
let prisma;
let reservationsService;
let checkoutSessionService;
let pgHandle;

let T;             // tenant id
let reservationId;
let agreementId;

describe('getById returns rentalAgreement.declinedInsurance (embedded pg)', () => {
  before(async () => {
    pgHandle = await bootEmbeddedPg();
    ({ prisma } = await import('../../lib/prisma.js'));
    ({ reservationsService } = await import('./reservations.service.js'));
    ({ checkoutSessionService } = await import('../checkout-session/checkout-session.service.js'));

    const stamp = Date.now();
    const tenant = await prisma.tenant.create({
      data: { name: 'Declined Insurance Test', slug: `di-${stamp}` },
    });
    T = tenant.id;

    const location = await prisma.location.create({
      data: { tenantId: T, code: `DI${stamp}`.slice(-8), name: 'Test Branch' },
    });
    const customer = await prisma.customer.create({
      data: { firstName: 'Ada', lastName: 'Lovelace', phone: '7875550100', tenantId: T },
    });
    const pickupAt = new Date(Date.now() + 3600_000);
    const returnAt = new Date(Date.now() + 2 * 86400_000);
    const reservation = await prisma.reservation.create({
      data: {
        tenantId: T,
        reservationNumber: `RES-DI-${stamp}`,
        customerId: customer.id,
        pickupLocationId: location.id,
        returnLocationId: location.id,
        pickupAt,
        returnAt,
      },
    });
    reservationId = reservation.id;

    const agreement = await prisma.rentalAgreement.create({
      data: {
        tenantId: T,
        agreementNumber: `RA-DI-${stamp}`,
        reservationId,
        pickupAt,
        returnAt,
        pickupLocationId: location.id,
        returnLocationId: location.id,
        customerFirstName: 'Ada',
        customerLastName: 'Lovelace',
        // The customer declined at the kiosk. This is the persisted truth the
        // wizard was failing to see.
        declinedInsurance: true,
      },
    });
    agreementId = agreement.id;
  });

  after(async () => {
    if (pgHandle) await pgHandle.stop();
  });

  it('stores declinedInsurance = true', async () => {
    const row = await prisma.rentalAgreement.findUnique({
      where: { id: agreementId },
      select: { declinedInsurance: true },
    });
    assert.equal(row.declinedInsurance, true, 'precondition: the column is set');
  });

  it('getById surfaces the stored true value (the MC-1 regression)', async () => {
    const out = await reservationsService.getById(reservationId, { tenantId: T });
    assert.ok(out?.rentalAgreement, 'agreement should be included');
    assert.equal(
      out.rentalAgreement.declinedInsurance, true,
      'getById dropped declinedInsurance — the wizard switch will render OFF for a customer who declined',
    );
    // The precise production symptom, spelled out: the wizard does
    // useState(!!reservation.rentalAgreement?.declinedInsurance).
    assert.equal(!!out.rentalAgreement.declinedInsurance, true);
  });

  it('getById also reports a stored false without inventing a value', async () => {
    await prisma.rentalAgreement.update({
      where: { id: agreementId }, data: { declinedInsurance: false },
    });
    const out = await reservationsService.getById(reservationId, { tenantId: T });
    assert.equal(out.rentalAgreement.declinedInsurance, false);
    await prisma.rentalAgreement.update({
      where: { id: agreementId }, data: { declinedInsurance: true },
    });
  });

  // -------------------------------------------------------------------------
  // The damage journey, end to end: kiosk decline -> wizard read -> agent
  // toggles the switch twice ("let me check what this does") -> the addendum
  // survives. Before MC-1 the wizard seeded OFF, so the agent's first toggle
  // went ON and the second went OFF, POSTing declined:false and wiping the
  // acknowledgement from a contract the customer expected.
  // -------------------------------------------------------------------------
  it('survives the agent toggling the switch off and back on', async () => {
    const session = await prisma.checkoutSession.create({
      data: { reservationId, agreementId, currentStep: 'CONFIRMING', events: '[]' },
    });

    const seeded = await reservationsService.getById(reservationId, { tenantId: T });
    const switchState = !!seeded.rentalAgreement?.declinedInsurance;
    assert.equal(switchState, true, 'the switch must open in the DECLINED position');

    // Agent flips it off, then back on. Both writes are legal here: nothing is
    // signed and no signing token is live.
    await checkoutSessionService.setDeclinedInsurance({ id: session.id, declined: false });
    await checkoutSessionService.setDeclinedInsurance({ id: session.id, declined: true });

    const after = await reservationsService.getById(reservationId, { tenantId: T });
    assert.equal(after.rentalAgreement.declinedInsurance, true);

    await prisma.checkoutSession.delete({ where: { id: session.id } });
  });

  // -------------------------------------------------------------------------
  // MC-2 against a real DB: the step guard refuses the two dangerous windows.
  // -------------------------------------------------------------------------
  it('refuses the write once the customer has signed (TC_ALREADY_COMPLETED)', async () => {
    const session = await prisma.checkoutSession.create({
      data: {
        reservationId, agreementId, currentStep: 'TC_PENDING', events: '[]',
        tcCompletedAt: new Date(),
      },
    });
    await assert.rejects(
      () => checkoutSessionService.setDeclinedInsurance({ id: session.id, declined: false }),
      (err) => err.status === 409 && err.code === 'TC_ALREADY_COMPLETED',
    );
    const row = await prisma.rentalAgreement.findUnique({
      where: { id: agreementId }, select: { declinedInsurance: true },
    });
    assert.equal(row.declinedInsurance, true, 'the signed flag must be untouched');
    await prisma.checkoutSession.delete({ where: { id: session.id } });
  });

  it('refuses while the customer is mid-signature (TC_SIGNING_IN_PROGRESS)', async () => {
    const session = await prisma.checkoutSession.create({
      data: { reservationId, agreementId, currentStep: 'TC_PENDING', events: '[]' },
    });
    const token = await prisma.handoffToken.create({
      data: {
        reservationId, kind: 'TERMS_SIGNING',
        token: `tok-live-${Date.now()}`,
        expiresAt: new Date(Date.now() + 15 * 60_000),
      },
    });
    // Ink is already down on at least one section.
    const initial = await prisma.agreementSectionInitial.create({
      data: {
        agreementId, sectionKey: 'rental_period', sectionLabel: 'Rental Period',
        initialDataUrl: `data:image/png;base64,${'A'.repeat(300)}`,
        signedAt: new Date(),
      },
    });

    await assert.rejects(
      () => checkoutSessionService.setDeclinedInsurance({ id: session.id, declined: false }),
      (err) => err.status === 409 && err.code === 'TC_SIGNING_IN_PROGRESS',
    );

    // ... but the same call is ALLOWED once that token is consumed: a fresh
    // loadSession would recompute the section set from the current flag, so
    // there is no stale `expected` left to desync.
    await prisma.handoffToken.update({
      where: { id: token.id }, data: { consumedAt: new Date() },
    });
    await checkoutSessionService.setDeclinedInsurance({ id: session.id, declined: false });
    const row = await prisma.rentalAgreement.findUnique({
      where: { id: agreementId }, select: { declinedInsurance: true },
    });
    assert.equal(row.declinedInsurance, false);

    await prisma.agreementSectionInitial.delete({ where: { id: initial.id } });
    await prisma.handoffToken.delete({ where: { id: token.id } });
    await prisma.checkoutSession.delete({ where: { id: session.id } });
  });

  // -------------------------------------------------------------------------
  // The customer (pre-check-in portal) writer. Its defining condition is that
  // there is usually NO CheckoutSession yet, so a guard keyed only on
  // session.tcCompletedAt would let it write straight through. Proving this
  // against a real database is the point: the row genuinely does not exist.
  // -------------------------------------------------------------------------
  it('locks the customer path off RentalAgreement.tcSignedAt with no session row', async () => {
    const { assertInsuranceSelectionEditable, INSURANCE_LOCK } =
      await import('../checkout-session/insurance-selection-gate.js');

    const orphan = await prisma.checkoutSession.findUnique({ where: { reservationId } });
    assert.equal(orphan, null, 'precondition: pre-check-in runs before any session exists');

    await prisma.rentalAgreement.update({
      where: { id: agreementId },
      data: { tcSignedAt: new Date(), declinedInsurance: false },
    });

    // How the portal calls it: reservationId only, nextValue true, customer copy.
    await assert.rejects(
      () => assertInsuranceSelectionEditable({
        reservationId, nextValue: true, audience: 'customer',
      }),
      (err) => {
        assert.equal(err.status, 409);
        assert.equal(err.code, INSURANCE_LOCK.SIGNED);
        assert.match(err.message, /counter/i, 'customer must be told what to do next');
        return true;
      },
    );

    // ...and the no-op re-submit is still let through, so a customer fixing an
    // address is not refused over a field they never changed.
    await prisma.rentalAgreement.update({
      where: { id: agreementId }, data: { declinedInsurance: true },
    });
    await assertInsuranceSelectionEditable({
      reservationId, nextValue: true, audience: 'customer',
    });

    await prisma.rentalAgreement.update({
      where: { id: agreementId }, data: { tcSignedAt: null, declinedInsurance: true },
    });
  });
});
