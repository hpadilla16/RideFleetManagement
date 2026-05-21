/**
 * Tests for wizard-state.service.js (Round 23).
 * Run: node --test backend/src/modules/wizard-state/wizard-state.service.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  getCheckoutWizardState,
  getCheckinWizardState,
  findActiveWizardForVehicle,
  advanceCheckoutStep,
  advanceCheckinStep,
  WizardStateError,
  _internal,
} from './wizard-state.service.js';

function makeFakePrisma({ reservations = [], agreements = [], inspections = [], txs = [] } = {}) {
  return {
    _state: { reservations, agreements, inspections, txs },
    reservation: {
      async findFirst({ where, select }) {
        const r = reservations.find((x) => x.id === where.id && x.tenantId === where.tenantId);
        if (!r) return null;
        const out = { ...r };
        if (select?.rentalAgreement) {
          const a = agreements.find((x) => x.reservationId === r.id);
          out.rentalAgreement = a || null;
        }
        if (select?.signing) {
          out.signing = r.signing || null;
        }
        return out;
      },
    },
    rentalAgreement: {
      async findFirst({ where, select, orderBy }) {
        let rows = agreements.filter((a) => {
          if (where.tenantId && a.tenantId !== where.tenantId) return false;
          if (where.vehicleId && a.vehicleId !== where.vehicleId) return false;
          if (where.finalizedAt === null && a.finalizedAt) return false;
          if (where.finalizedAt && where.finalizedAt.not === null && !a.finalizedAt) return false;
          if (where.closedAt === null && a.closedAt) return false;
          if (where.id && a.id !== where.id) return false;
          return true;
        });
        if (orderBy?.updatedAt === 'desc') {
          rows = rows.slice().sort((a, b) => +new Date(b.updatedAt || 0) - +new Date(a.updatedAt || 0));
        }
        if (orderBy?.finalizedAt === 'desc') {
          rows = rows.slice().sort((a, b) => +new Date(b.finalizedAt || 0) - +new Date(a.finalizedAt || 0));
        }
        return rows[0] || null;
      },
      async update({ where, data }) {
        const idx = agreements.findIndex((a) => a.id === where.id);
        if (idx !== -1) agreements[idx] = { ...agreements[idx], ...data };
        return agreements[idx];
      },
    },
    rentalAgreementInspection: {
      async findFirst({ where }) {
        return inspections.find((i) =>
          i.rentalAgreementId === where.rentalAgreementId && i.phase === where.phase
        ) || null;
      },
    },
    dejavooTransaction: {
      async findFirst({ where }) {
        return txs.find((t) => {
          if (t.reservationId !== where.reservationId) return false;
          if (where.approved && !t.approved) return false;
          if (where.type?.in && !where.type.in.includes(t.type)) return false;
          return true;
        }) || null;
      },
    },
  };
}

// ---------------------------------------------------------------------------
// computeCheckoutNextStep
// ---------------------------------------------------------------------------

test('checkout: no agreement → step 0', () => {
  assert.equal(_internal.computeCheckoutNextStep({ agreement: null }), 0);
});

test('checkout: agreement exists, signing not done → step 1', () => {
  assert.equal(_internal.computeCheckoutNextStep({ agreement: { id: 'a', checkoutWizardStep: 1 } }), 1);
});

test('checkout: signing completed → step 2 (inspection photos)', () => {
  const r = _internal.computeCheckoutNextStep({
    agreement: { id: 'a', checkoutWizardStep: 2 },
    signing: { completedAt: new Date() },
  });
  assert.equal(r, 2);
});

test('checkout: metrics captured → step 4 (signature)', () => {
  const r = _internal.computeCheckoutNextStep({
    agreement: { id: 'a', checkoutWizardStep: 4, fuelOut: 1, cleanlinessOut: 5, odometerOut: 1234 },
    signing: { completedAt: new Date() },
  });
  assert.equal(r, 4);
});

test('checkout: inspection signed → step 5', () => {
  const r = _internal.computeCheckoutNextStep({
    agreement: { id: 'a', checkoutInspectionSignedAt: new Date(), fuelOut: 1, cleanlinessOut: 5, odometerOut: 1 },
  });
  assert.equal(r, 5);
});

test('checkout: finalized → step 6', () => {
  const r = _internal.computeCheckoutNextStep({ agreement: { id: 'a', finalizedAt: new Date() } });
  assert.equal(r, 6);
});

// ---------------------------------------------------------------------------
// computeCheckinNextStep
// ---------------------------------------------------------------------------

test('checkin: no agreement → step 0', () => {
  assert.equal(_internal.computeCheckinNextStep({ agreement: null }), 0);
});

test('checkin: counter return not done → step 1', () => {
  const r = _internal.computeCheckinNextStep({
    agreement: { id: 'a', checkinWizardStep: 0 },
    counterReturnDone: false,
  });
  assert.equal(r, 1);
});

test('checkin: counter return done → step 2 (inspection photos)', () => {
  const r = _internal.computeCheckinNextStep({
    agreement: { id: 'a', checkinWizardStep: 2 },
    counterReturnDone: true,
  });
  assert.equal(r, 2);
});

test('checkin: metrics captured → step 3 (signature)', () => {
  const r = _internal.computeCheckinNextStep({
    agreement: { id: 'a', checkinWizardStep: 3, fuelIn: 0.5, cleanlinessIn: 4, odometerIn: 2345 },
    counterReturnDone: true,
  });
  assert.equal(r, 3);
});

test('checkin: closed → step 5', () => {
  const r = _internal.computeCheckinNextStep({ agreement: { id: 'a', closedAt: new Date() } });
  assert.equal(r, 5);
});

// ---------------------------------------------------------------------------
// getCheckoutWizardState
// ---------------------------------------------------------------------------

test('getCheckoutWizardState: 404 when reservation not in scope', async () => {
  const prisma = makeFakePrisma();
  await assert.rejects(
    () => getCheckoutWizardState({ reservationId: 'r1', tenantId: 't1', deps: { prisma } }),
    (err) => err instanceof WizardStateError && err.status === 404,
  );
});

test('getCheckoutWizardState: returns step 2 when signing done but no metrics', async () => {
  const prisma = makeFakePrisma({
    reservations: [{ id: 'r1', tenantId: 't1', signing: { id: 's1', completedAt: new Date() } }],
    agreements: [{ id: 'a1', reservationId: 'r1', tenantId: 't1', checkoutWizardStep: 2 }],
  });
  const out = await getCheckoutWizardState({ reservationId: 'r1', tenantId: 't1', deps: { prisma } });
  assert.equal(out.nextPendingStep, 2);
  assert.equal(out.agreementId, 'a1');
  assert.equal(out.persisted.signingCompletedAt.getTime(), prisma._state.reservations[0].signing.completedAt.getTime());
  assert.equal(out.persisted.fuelOut, null);
});

test('getCheckoutWizardState: returns step 5 when metrics done but no sig yet', async () => {
  const prisma = makeFakePrisma({
    reservations: [{ id: 'r1', tenantId: 't1', signing: { id: 's1', completedAt: new Date() } }],
    agreements: [{ id: 'a1', reservationId: 'r1', tenantId: 't1', checkoutWizardStep: 4, fuelOut: 1, cleanlinessOut: 5, odometerOut: 1234 }],
  });
  const out = await getCheckoutWizardState({ reservationId: 'r1', tenantId: 't1', deps: { prisma } });
  assert.equal(out.nextPendingStep, 4);
  assert.equal(out.persisted.fuelOut, 1);
  assert.equal(out.persisted.cleanlinessOut, 5);
  assert.equal(out.persisted.odometerOut, 1234);
});

// ---------------------------------------------------------------------------
// findActiveWizardForVehicle
// ---------------------------------------------------------------------------

test('findActiveWizardForVehicle: NONE when no agreements', async () => {
  const prisma = makeFakePrisma();
  const out = await findActiveWizardForVehicle({ vehicleId: 'v1', tenantId: 't1', deps: { prisma } });
  assert.equal(out.kind, 'NONE');
});

test('findActiveWizardForVehicle: CHECKOUT_RESUME when agreement not finalized', async () => {
  const prisma = makeFakePrisma({
    agreements: [
      { id: 'a1', reservationId: 'r1', tenantId: 't1', vehicleId: 'v1', checkoutWizardStep: 3, finalizedAt: null, closedAt: null, updatedAt: new Date() },
    ],
  });
  const out = await findActiveWizardForVehicle({ vehicleId: 'v1', tenantId: 't1', deps: { prisma } });
  assert.equal(out.kind, 'CHECKOUT_RESUME');
  assert.equal(out.reservationId, 'r1');
  assert.equal(out.nextPendingStep, 3);
  assert.match(out.wizardUrl, /\/checkout-wizard$/);
});

test('findActiveWizardForVehicle: CHECKIN_START when finalized but no checkin started', async () => {
  const prisma = makeFakePrisma({
    agreements: [
      { id: 'a1', reservationId: 'r1', tenantId: 't1', vehicleId: 'v1', finalizedAt: new Date(), closedAt: null, checkinWizardStep: 0 },
    ],
  });
  const out = await findActiveWizardForVehicle({ vehicleId: 'v1', tenantId: 't1', deps: { prisma } });
  assert.equal(out.kind, 'CHECKIN_START');
  assert.equal(out.reservationId, 'r1');
  assert.match(out.wizardUrl, /\/checkin-wizard$/);
});

test('findActiveWizardForVehicle: CHECKIN_RESUME when checkin already started', async () => {
  const prisma = makeFakePrisma({
    agreements: [
      { id: 'a1', reservationId: 'r1', tenantId: 't1', vehicleId: 'v1', finalizedAt: new Date(), closedAt: null, checkinWizardStep: 2 },
    ],
  });
  const out = await findActiveWizardForVehicle({ vehicleId: 'v1', tenantId: 't1', deps: { prisma } });
  assert.equal(out.kind, 'CHECKIN_RESUME');
  assert.equal(out.nextPendingStep, 2);
});

// ---------------------------------------------------------------------------
// advanceCheckoutStep / advanceCheckinStep
// ---------------------------------------------------------------------------

test('advanceCheckoutStep: monotonically increasing', async () => {
  const prisma = makeFakePrisma({
    agreements: [{ id: 'a1', tenantId: 't1', checkoutWizardStep: 3 }],
  });
  // Try to "regress" to step 1 — should clamp to existing 3
  const out1 = await advanceCheckoutStep({ agreementId: 'a1', tenantId: 't1', toStep: 1, deps: { prisma } });
  assert.equal(out1.checkoutWizardStep, 3);
  // Advance to step 5
  const out2 = await advanceCheckoutStep({ agreementId: 'a1', tenantId: 't1', toStep: 5, deps: { prisma } });
  assert.equal(out2.checkoutWizardStep, 5);
});

test('advanceCheckoutStep: rejects invalid step', async () => {
  const prisma = makeFakePrisma({
    agreements: [{ id: 'a1', tenantId: 't1', checkoutWizardStep: 0 }],
  });
  await assert.rejects(
    () => advanceCheckoutStep({ agreementId: 'a1', tenantId: 't1', toStep: 99, deps: { prisma } }),
    (err) => err.code === 'INVALID_STEP',
  );
});

test('advanceCheckinStep: works through full range', async () => {
  const prisma = makeFakePrisma({
    agreements: [{ id: 'a1', tenantId: 't1', checkinWizardStep: 0 }],
  });
  const out = await advanceCheckinStep({ agreementId: 'a1', tenantId: 't1', toStep: 4, deps: { prisma } });
  assert.equal(out.checkinWizardStep, 4);
});

// ---------------------------------------------------------------------------
// Tenant scope enforcement
// ---------------------------------------------------------------------------

test('advance refuses to touch agreement in a different tenant', async () => {
  const prisma = makeFakePrisma({
    agreements: [{ id: 'a1', tenantId: 'tOTHER', checkoutWizardStep: 0 }],
  });
  await assert.rejects(
    () => advanceCheckoutStep({ agreementId: 'a1', tenantId: 't1', toStep: 2, deps: { prisma } }),
    (err) => err.status === 404,
  );
});
