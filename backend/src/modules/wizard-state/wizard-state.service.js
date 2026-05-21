/**
 * Wizard state service — Round 23.
 *
 * Single source of truth for "where did the agent leave off?" on the
 * checkout + checkin wizards. The agent can advance the wizard on the
 * desktop at the counter, then switch to their phone/tablet at the
 * vehicle, and the wizard knows exactly where to resume.
 *
 * Step model (matches frontend wizard ordering after the round 23 reorder):
 *
 *   CHECKOUT:
 *     0 — not started (no agreement yet)
 *     1 — Confirm vehicle & customer  (RentalAgreement created)
 *     2 — Counter signing + payment + deposit  (ReservationSigning.completedAt set)
 *     3 — Inspection photos captured
 *     4 — Pickup metrics (fuelOut + cleanlinessOut + odometerOut) captured
 *     5 — Inspection signature captured  (checkoutInspectionSignedAt set)
 *     6 — Keys delivered  (RentalAgreement.finalizedAt set)
 *
 *   CHECKIN (return):
 *     0 — not started
 *     1 — Counter return signing + capture/void/sale  (counter return tx approved)
 *     2 — Return inspection photos captured
 *     3 — Return metrics (fuelIn + cleanlinessIn + odometerIn) captured
 *     4 — Inspection signature captured
 *     5 — Return finalized  (RentalAgreement.closedAt set)
 *
 * The cursor lives in RentalAgreement.checkout/checkinWizardStep and is
 * updated server-side as each step persists data. The frontend reads it on
 * mount via GET /api/reservations/:id/checkout-wizard-state and jumps to
 * `nextPendingStep`.
 *
 * IMPORTANT: this module does NOT touch fuelOut/cleanlinessOut/odometerOut
 * — those still live on RentalAgreement and are written by the existing
 * checkout finalize path. Round 23 adds an incremental PATCH so step 4
 * (pickup metrics) persists them mid-wizard too.
 */

let _defaultPrisma = null;
async function resolveDefaultPrisma() {
  if (_defaultPrisma) return _defaultPrisma;
  const mod = await import('../../lib/prisma.js');
  _defaultPrisma = mod.prisma;
  return _defaultPrisma;
}

export class WizardStateError extends Error {
  constructor(message, status = 400, code = null) {
    super(message);
    this.name = 'WizardStateError';
    this.status = status;
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Step derivation
// ---------------------------------------------------------------------------

/**
 * Compute the nextPendingStep for a checkout wizard. Reads the persisted
 * `checkoutWizardStep` cursor and reconciles it against the actual data
 * (so that if step 2 was persisted but the cursor got out-of-sync, we
 * still advance correctly).
 */
function computeCheckoutNextStep({ agreement, signing }) {
  if (!agreement) return 0;                 // not started
  if (agreement.finalizedAt) return 6;       // fully delivered
  if (agreement.checkoutInspectionSignedAt) return 5;
  if (agreement.odometerOut != null && agreement.fuelOut != null && agreement.cleanlinessOut != null) {
    // metrics done → next is signature
    return Math.max(4, agreement.checkoutWizardStep || 0);
  }
  if (signing?.completedAt) {
    // counter signing done → next is inspection photos
    return Math.max(2, agreement.checkoutWizardStep || 0);
  }
  // agreement exists but signing not done → counter signing is next
  return Math.max(1, agreement.checkoutWizardStep || 0);
}

function computeCheckinNextStep({ agreement, counterReturnDone }) {
  if (!agreement) return 0;
  if (agreement.closedAt) return 5;
  if (agreement.checkinInspectionSignedAt) return 4;
  if (agreement.odometerIn != null && agreement.fuelIn != null && agreement.cleanlinessIn != null) {
    return Math.max(3, agreement.checkinWizardStep || 0);
  }
  if (counterReturnDone) {
    return Math.max(2, agreement.checkinWizardStep || 0);
  }
  return Math.max(1, agreement.checkinWizardStep || 0);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Resolve the full wizard state for the checkout flow on a reservation.
 *
 * @param {object} args
 * @param {string} args.reservationId
 * @param {string} args.tenantId      — caller's tenant scope
 * @param {object} [args.deps]        — DI seam for tests
 * @returns {Promise<object>}
 *   {
 *     reservationId, agreementId,
 *     persistedStep, nextPendingStep, completedSteps,
 *     blockers: { noTerminal: bool, noActiveTemplate: bool, ... },
 *     persisted: {
 *       customerConfirmedAt, signingCompletedAt,
 *       inspectionPhotosCount, inspectionSignedAt, finalizedAt,
 *       fuelOut, cleanlinessOut, odometerOut,
 *     },
 *   }
 */
export async function getCheckoutWizardState({ reservationId, tenantId, deps = {} } = {}) {
  if (!reservationId) throw new WizardStateError('reservationId required', 400);
  if (!tenantId) throw new WizardStateError('tenantId required', 403);
  const prisma = deps.prisma || (await resolveDefaultPrisma());

  const reservation = await prisma.reservation.findFirst({
    where: { id: reservationId, tenantId },
    select: {
      id: true,
      tenantId: true,
      vehicleId: true,
      signingCompletedAt: true,
      rentalAgreement: {
        select: {
          id: true,
          checkoutWizardStep: true,
          checkoutInspectionSigPath: true,
          checkoutInspectionSignedAt: true,
          fuelOut: true,
          cleanlinessOut: true,
          odometerOut: true,
          finalizedAt: true,
        },
      },
      signing: {
        select: { id: true, completedAt: true, refusedAt: true },
      },
    },
  });
  if (!reservation) {
    throw new WizardStateError('Reservation not found in tenant scope', 404, 'RESERVATION_NOT_FOUND');
  }
  const agreement = reservation.rentalAgreement;
  const signing = reservation.signing;

  // Inspection photo count (legacy RentalAgreementInspection or Pillar 2
  // Inspection — whichever exists). Best-effort: fall back to 0.
  let inspectionPhotosCount = 0;
  if (agreement?.id) {
    try {
      const legacyPhotos = await prisma.rentalAgreementInspection.findFirst({
        where: { rentalAgreementId: agreement.id, phase: 'PICKUP' },
        select: { photosJson: true, photoStorageRefs: true },
      });
      if (legacyPhotos?.photoStorageRefs && Array.isArray(legacyPhotos.photoStorageRefs)) {
        inspectionPhotosCount = legacyPhotos.photoStorageRefs.length;
      } else if (legacyPhotos?.photosJson) {
        try {
          const parsed = JSON.parse(legacyPhotos.photosJson);
          if (Array.isArray(parsed)) inspectionPhotosCount = parsed.length;
        } catch { /* swallow */ }
      }
    } catch { /* model may not exist in some envs — ignore */ }
  }

  const nextPendingStep = computeCheckoutNextStep({ agreement, signing });
  const completedSteps = [];
  for (let i = 0; i < nextPendingStep; i++) completedSteps.push(i);

  return {
    flow: 'CHECKOUT',
    reservationId: reservation.id,
    agreementId: agreement?.id || null,
    persistedStep: agreement?.checkoutWizardStep ?? 0,
    nextPendingStep,
    completedSteps,
    blockers: {},
    persisted: {
      signingCompletedAt: signing?.completedAt || reservation.signingCompletedAt || null,
      signingRefusedAt: signing?.refusedAt || null,
      inspectionPhotosCount,
      inspectionSignedAt: agreement?.checkoutInspectionSignedAt || null,
      finalizedAt: agreement?.finalizedAt || null,
      fuelOut: agreement?.fuelOut ?? null,
      cleanlinessOut: agreement?.cleanlinessOut ?? null,
      odometerOut: agreement?.odometerOut ?? null,
    },
  };
}

export async function getCheckinWizardState({ reservationId, tenantId, deps = {} } = {}) {
  if (!reservationId) throw new WizardStateError('reservationId required', 400);
  if (!tenantId) throw new WizardStateError('tenantId required', 403);
  const prisma = deps.prisma || (await resolveDefaultPrisma());

  const reservation = await prisma.reservation.findFirst({
    where: { id: reservationId, tenantId },
    select: {
      id: true,
      tenantId: true,
      vehicleId: true,
      rentalAgreement: {
        select: {
          id: true,
          checkinWizardStep: true,
          checkinInspectionSigPath: true,
          checkinInspectionSignedAt: true,
          fuelIn: true,
          cleanlinessIn: true,
          odometerIn: true,
          closedAt: true,
        },
      },
    },
  });
  if (!reservation) {
    throw new WizardStateError('Reservation not found in tenant scope', 404, 'RESERVATION_NOT_FOUND');
  }
  const agreement = reservation.rentalAgreement;

  // Counter return progress: did we successfully run a CAPTURE / VOID /
  // CAPTURE+SALE (any of which closes the deposit hold)?
  let counterReturnDone = false;
  try {
    const closingTx = await prisma.dejavooTransaction.findFirst({
      where: {
        reservationId,
        approved: true,
        type: { in: ['CAPTURE', 'VOID'] },
      },
      select: { id: true },
    });
    counterReturnDone = !!closingTx;
  } catch { /* table may not exist in older envs */ }

  let inspectionPhotosCount = 0;
  if (agreement?.id) {
    try {
      const legacyPhotos = await prisma.rentalAgreementInspection.findFirst({
        where: { rentalAgreementId: agreement.id, phase: 'RETURN' },
        select: { photosJson: true, photoStorageRefs: true },
      });
      if (legacyPhotos?.photoStorageRefs && Array.isArray(legacyPhotos.photoStorageRefs)) {
        inspectionPhotosCount = legacyPhotos.photoStorageRefs.length;
      } else if (legacyPhotos?.photosJson) {
        try {
          const parsed = JSON.parse(legacyPhotos.photosJson);
          if (Array.isArray(parsed)) inspectionPhotosCount = parsed.length;
        } catch { /* swallow */ }
      }
    } catch { /* swallow */ }
  }

  const nextPendingStep = computeCheckinNextStep({ agreement, counterReturnDone });
  const completedSteps = [];
  for (let i = 0; i < nextPendingStep; i++) completedSteps.push(i);

  return {
    flow: 'CHECKIN',
    reservationId: reservation.id,
    agreementId: agreement?.id || null,
    persistedStep: agreement?.checkinWizardStep ?? 0,
    nextPendingStep,
    completedSteps,
    blockers: {},
    persisted: {
      counterReturnDone,
      inspectionPhotosCount,
      inspectionSignedAt: agreement?.checkinInspectionSignedAt || null,
      closedAt: agreement?.closedAt || null,
      fuelIn: agreement?.fuelIn ?? null,
      cleanlinessIn: agreement?.cleanlinessIn ?? null,
      odometerIn: agreement?.odometerIn ?? null,
    },
  };
}

// ---------------------------------------------------------------------------
// Vehicle → active-wizard lookup (round 23b)
// ---------------------------------------------------------------------------

/**
 * For a vehicle, find the best wizard to resume (used by the vehicle QR scan).
 * Returns one of:
 *   { kind: 'CHECKOUT_RESUME', reservationId, wizardUrl, nextPendingStep }
 *   { kind: 'CHECKIN_START',   reservationId, wizardUrl }
 *   { kind: 'CHECKIN_RESUME',  reservationId, wizardUrl, nextPendingStep }
 *   { kind: 'NONE' }
 *
 * Priority (highest first):
 *   1. An in-progress checkout for this vehicle (status DRAFT / IN_PROGRESS)
 *      → CHECKOUT_RESUME
 *   2. The vehicle is OUT on rental (RentalAgreement finalizedAt but not
 *      closedAt) and an in-progress checkin exists → CHECKIN_RESUME
 *   3. The vehicle is OUT on rental and no checkin started → CHECKIN_START
 *   4. Otherwise → NONE
 */
export async function findActiveWizardForVehicle({ vehicleId, tenantId, deps = {} } = {}) {
  if (!vehicleId) throw new WizardStateError('vehicleId required', 400);
  if (!tenantId) throw new WizardStateError('tenantId required', 403);
  const prisma = deps.prisma || (await resolveDefaultPrisma());

  // 1. In-progress checkout (agreement exists but not yet finalized).
  const inProgressCheckout = await prisma.rentalAgreement.findFirst({
    where: {
      tenantId,
      vehicleId,
      finalizedAt: null,
    },
    select: { id: true, reservationId: true, checkoutWizardStep: true },
    orderBy: { updatedAt: 'desc' },
  });
  if (inProgressCheckout) {
    return {
      kind: 'CHECKOUT_RESUME',
      reservationId: inProgressCheckout.reservationId,
      wizardUrl: `/reservations/${inProgressCheckout.reservationId}/checkout-wizard`,
      nextPendingStep: inProgressCheckout.checkoutWizardStep ?? 0,
    };
  }

  // 2. Vehicle is OUT (finalized but not closed). Possibly mid-checkin.
  const outAgreement = await prisma.rentalAgreement.findFirst({
    where: {
      tenantId,
      vehicleId,
      finalizedAt: { not: null },
      closedAt: null,
    },
    select: { id: true, reservationId: true, checkinWizardStep: true, checkinInspectionSignedAt: true, fuelIn: true },
    orderBy: { finalizedAt: 'desc' },
  });
  if (outAgreement) {
    const checkinStarted = (outAgreement.checkinWizardStep || 0) > 0
      || outAgreement.checkinInspectionSignedAt != null
      || outAgreement.fuelIn != null;
    return {
      kind: checkinStarted ? 'CHECKIN_RESUME' : 'CHECKIN_START',
      reservationId: outAgreement.reservationId,
      wizardUrl: `/reservations/${outAgreement.reservationId}/checkin-wizard`,
      nextPendingStep: outAgreement.checkinWizardStep ?? 0,
    };
  }

  return { kind: 'NONE' };
}

// ---------------------------------------------------------------------------
// Step persistence (round 23 incremental save)
// ---------------------------------------------------------------------------

/**
 * Persist the agent's progress at the current step. Idempotent — clamps the
 * step value to monotonically increasing (you can re-record the same step
 * but not regress to a lower step without a separate `force` flag).
 */
export async function advanceCheckoutStep({ agreementId, tenantId, toStep, deps = {} } = {}) {
  if (!agreementId) throw new WizardStateError('agreementId required', 400);
  if (!tenantId) throw new WizardStateError('tenantId required', 403);
  if (typeof toStep !== 'number' || toStep < 0 || toStep > 6) {
    throw new WizardStateError(`invalid step ${toStep}`, 400, 'INVALID_STEP');
  }
  const prisma = deps.prisma || (await resolveDefaultPrisma());
  const agreement = await prisma.rentalAgreement.findFirst({
    where: { id: agreementId, tenantId },
    select: { id: true, checkoutWizardStep: true },
  });
  if (!agreement) throw new WizardStateError('Agreement not in tenant scope', 404);
  const newStep = Math.max(agreement.checkoutWizardStep ?? 0, toStep);
  await prisma.rentalAgreement.update({
    where: { id: agreement.id },
    data: { checkoutWizardStep: newStep },
  });
  return { agreementId: agreement.id, checkoutWizardStep: newStep };
}

export async function advanceCheckinStep({ agreementId, tenantId, toStep, deps = {} } = {}) {
  if (!agreementId) throw new WizardStateError('agreementId required', 400);
  if (!tenantId) throw new WizardStateError('tenantId required', 403);
  if (typeof toStep !== 'number' || toStep < 0 || toStep > 5) {
    throw new WizardStateError(`invalid step ${toStep}`, 400, 'INVALID_STEP');
  }
  const prisma = deps.prisma || (await resolveDefaultPrisma());
  const agreement = await prisma.rentalAgreement.findFirst({
    where: { id: agreementId, tenantId },
    select: { id: true, checkinWizardStep: true },
  });
  if (!agreement) throw new WizardStateError('Agreement not in tenant scope', 404);
  const newStep = Math.max(agreement.checkinWizardStep ?? 0, toStep);
  await prisma.rentalAgreement.update({
    where: { id: agreement.id },
    data: { checkinWizardStep: newStep },
  });
  return { agreementId: agreement.id, checkinWizardStep: newStep };
}

// Internal for tests
export const _internal = {
  computeCheckoutNextStep,
  computeCheckinNextStep,
};
