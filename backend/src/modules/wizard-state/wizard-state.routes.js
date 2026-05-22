/**
 * Wizard state routes — Round 23.
 *
 * Mounted in main.js as:
 *   app.use('/api/reservations',  requireAuth, tenantRateLimit, wizardStateReservationRouter);
 *   app.use('/api/vehicles',      requireAuth, tenantRateLimit, wizardStateVehicleRouter);
 *   app.use('/api/rental-agreements', requireAuth, tenantRateLimit, wizardStateAgreementRouter);
 *
 * Routes:
 *   GET   /api/reservations/:id/checkout-wizard-state
 *   GET   /api/reservations/:id/checkin-wizard-state
 *   GET   /api/vehicles/:id/active-wizard
 *   PATCH /api/rental-agreements/:id/checkout-wizard-step
 *   PATCH /api/rental-agreements/:id/checkin-wizard-step
 *   PATCH /api/rental-agreements/:id/checkout-metrics
 *   PATCH /api/rental-agreements/:id/checkin-metrics
 *   POST  /api/rental-agreements/:id/checkout-inspection-signature
 *   POST  /api/rental-agreements/:id/checkin-inspection-signature
 */

import { Router } from 'express';
import { requireRole } from '../../middleware/auth.js';
import {
  getCheckoutWizardState,
  getCheckinWizardState,
  findActiveWizardForVehicle,
  advanceCheckoutStep,
  advanceCheckinStep,
  WizardStateError,
} from './wizard-state.service.js';

let _defaultPrisma = null;
async function resolveDefaultPrisma() {
  if (_defaultPrisma) return _defaultPrisma;
  const mod = await import('../../lib/prisma.js');
  _defaultPrisma = mod.prisma;
  return _defaultPrisma;
}

let _signingStorage = null;
async function resolveSigningStorage() {
  if (_signingStorage) return _signingStorage;
  const mod = await import('../terms/signing-storage.js');
  _signingStorage = mod;
  return _signingStorage;
}

// Round 25: removed local requireRole — replaced with canonical import from
// middleware/auth.js which adds the SUPER_ADMIN bypass. The local version
// missed the bypass which caused SUPER_ADMIN 403s during smoke test even when
// SUPER_ADMIN was in the allowed list (downstream service rejected
// req.user.tenantId=null).

function sendError(res, err) {
  if (err instanceof WizardStateError) {
    return res.status(err.status).json({ error: err.message, code: err.code || null });
  }
  console.error('[wizard-state] error', err);
  return res.status(500).json({ error: err?.message || 'Internal error' });
}

export const wizardStateReservationRouter = Router();
export const wizardStateVehicleRouter = Router();
export const wizardStateAgreementRouter = Router();

// ---------------------------------------------------------------------------
// GET /api/reservations/:id/checkout-wizard-state
// ---------------------------------------------------------------------------
wizardStateReservationRouter.get(
  '/:id/checkout-wizard-state',
  requireRole('ADMIN', 'OPS', 'AGENT', 'SUPER_ADMIN'),
  async (req, res) => {
    try {
      const out = await getCheckoutWizardState({
        reservationId: req.params.id,
        tenantId: req.user.tenantId,
      });
      res.json(out);
    } catch (err) {
      sendError(res, err);
    }
  }
);

// ---------------------------------------------------------------------------
// GET /api/reservations/:id/checkin-wizard-state
// ---------------------------------------------------------------------------
wizardStateReservationRouter.get(
  '/:id/checkin-wizard-state',
  requireRole('ADMIN', 'OPS', 'AGENT', 'SUPER_ADMIN'),
  async (req, res) => {
    try {
      const out = await getCheckinWizardState({
        reservationId: req.params.id,
        tenantId: req.user.tenantId,
      });
      res.json(out);
    } catch (err) {
      sendError(res, err);
    }
  }
);

// ---------------------------------------------------------------------------
// GET /api/vehicles/:id/active-wizard
//
// SECURITY: requires ADMIN/OPS/AGENT/SUPER_ADMIN — customer scanning the
// vehicle QR will hit the authgate first and never see this. Even an
// authenticated non-staff user gets a 403.
// ---------------------------------------------------------------------------
wizardStateVehicleRouter.get(
  '/:id/active-wizard',
  requireRole('ADMIN', 'OPS', 'AGENT', 'SUPER_ADMIN'),
  async (req, res) => {
    try {
      const out = await findActiveWizardForVehicle({
        vehicleId: req.params.id,
        tenantId: req.user.tenantId,
      });
      res.json(out);
    } catch (err) {
      sendError(res, err);
    }
  }
);

// ---------------------------------------------------------------------------
// PATCH /api/rental-agreements/:id/checkout-wizard-step
// Body: { toStep: 0..6 }
// ---------------------------------------------------------------------------
wizardStateAgreementRouter.patch(
  '/:id/checkout-wizard-step',
  requireRole('ADMIN', 'OPS', 'AGENT', 'SUPER_ADMIN'),
  async (req, res) => {
    try {
      const out = await advanceCheckoutStep({
        agreementId: req.params.id,
        tenantId: req.user.tenantId,
        toStep: Number(req.body?.toStep),
      });
      res.json(out);
    } catch (err) {
      sendError(res, err);
    }
  }
);

wizardStateAgreementRouter.patch(
  '/:id/checkin-wizard-step',
  requireRole('ADMIN', 'OPS', 'AGENT', 'SUPER_ADMIN'),
  async (req, res) => {
    try {
      const out = await advanceCheckinStep({
        agreementId: req.params.id,
        tenantId: req.user.tenantId,
        toStep: Number(req.body?.toStep),
      });
      res.json(out);
    } catch (err) {
      sendError(res, err);
    }
  }
);

// ---------------------------------------------------------------------------
// PATCH /api/rental-agreements/:id/checkout-metrics
// PATCH /api/rental-agreements/:id/checkin-metrics
// Saves fuelOut/cleanlinessOut/odometerOut (or in-equivalents) incrementally
// so a device switch mid-step doesn't lose data. Also advances the wizard
// cursor to step 4 (checkout) or step 3 (checkin) on success.
// ---------------------------------------------------------------------------
function clamp(v, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.min(Math.max(n, min), max);
}

wizardStateAgreementRouter.patch(
  '/:id/checkout-metrics',
  requireRole('ADMIN', 'OPS', 'AGENT', 'SUPER_ADMIN'),
  async (req, res) => {
    try {
      const prisma = await resolveDefaultPrisma();
      const agreement = await prisma.rentalAgreement.findFirst({
        where: { id: req.params.id, tenantId: req.user.tenantId },
        select: { id: true, checkoutWizardStep: true },
      });
      if (!agreement) return res.status(404).json({ error: 'Agreement not found' });

      const fuelOut = clamp(req.body?.fuelOut, 0, 1);
      const cleanlinessOut = clamp(req.body?.cleanlinessOut, 1, 5);
      const odometerOut = req.body?.odometerOut != null ? Math.max(0, Math.round(Number(req.body.odometerOut) || 0)) : null;
      if (fuelOut == null || cleanlinessOut == null || !Number.isFinite(odometerOut) || odometerOut <= 0) {
        return res.status(400).json({
          error: 'fuelOut (0..1), cleanlinessOut (1..5), and odometerOut (>0) are all required',
          code: 'INVALID_METRICS',
        });
      }
      const updated = await prisma.rentalAgreement.update({
        where: { id: agreement.id },
        data: {
          fuelOut,
          cleanlinessOut,
          odometerOut,
          checkoutWizardStep: Math.max(agreement.checkoutWizardStep ?? 0, 4),
        },
        select: { id: true, fuelOut: true, cleanlinessOut: true, odometerOut: true, checkoutWizardStep: true },
      });
      res.json(updated);
    } catch (err) {
      sendError(res, err);
    }
  }
);

wizardStateAgreementRouter.patch(
  '/:id/checkin-metrics',
  requireRole('ADMIN', 'OPS', 'AGENT', 'SUPER_ADMIN'),
  async (req, res) => {
    try {
      const prisma = await resolveDefaultPrisma();
      const agreement = await prisma.rentalAgreement.findFirst({
        where: { id: req.params.id, tenantId: req.user.tenantId },
        select: { id: true, checkinWizardStep: true },
      });
      if (!agreement) return res.status(404).json({ error: 'Agreement not found' });

      const fuelIn = clamp(req.body?.fuelIn, 0, 1);
      const cleanlinessIn = clamp(req.body?.cleanlinessIn, 1, 5);
      const odometerIn = req.body?.odometerIn != null ? Math.max(0, Math.round(Number(req.body.odometerIn) || 0)) : null;
      if (fuelIn == null || cleanlinessIn == null || !Number.isFinite(odometerIn) || odometerIn <= 0) {
        return res.status(400).json({
          error: 'fuelIn (0..1), cleanlinessIn (1..5), and odometerIn (>0) are all required',
          code: 'INVALID_METRICS',
        });
      }
      const updated = await prisma.rentalAgreement.update({
        where: { id: agreement.id },
        data: {
          fuelIn,
          cleanlinessIn,
          odometerIn,
          checkinWizardStep: Math.max(agreement.checkinWizardStep ?? 0, 3),
        },
        select: { id: true, fuelIn: true, cleanlinessIn: true, odometerIn: true, checkinWizardStep: true },
      });
      res.json(updated);
    } catch (err) {
      sendError(res, err);
    }
  }
);

// ---------------------------------------------------------------------------
// POST /api/rental-agreements/:id/checkout-inspection-signature
// Body: { base64Png }
// Uploads to Storage as `tenants/{tenantId}/reservations/{reservationId}/inspection-sig/checkout.png`
// Records storagePath on the agreement + advances cursor to step 5.
// ---------------------------------------------------------------------------
async function uploadInspectionSig({ phase, req }) {
  const prisma = await resolveDefaultPrisma();
  const agreement = await prisma.rentalAgreement.findFirst({
    where: { id: req.params.id, tenantId: req.user.tenantId },
    select: {
      id: true, reservationId: true, tenantId: true,
      checkoutWizardStep: true, checkinWizardStep: true,
    },
  });
  if (!agreement) {
    const err = new Error('Agreement not found');
    err.statusCode = 404;
    throw err;
  }
  const base64 = req.body?.base64Png || req.body?.signature || req.body?.body;
  if (!base64 || typeof base64 !== 'string') {
    const err = new Error('base64Png (signature PNG, base64-encoded) is required');
    err.statusCode = 400;
    throw err;
  }
  const storage = await resolveSigningStorage();
  const uploaded = await storage.uploadSignatureBlob({
    tenantId: agreement.tenantId,
    reservationId: agreement.reservationId,
    fieldKey: phase === 'CHECKOUT' ? 'INSPECTION_CHECKOUT' : 'INSPECTION_CHECKIN',
    body: base64,
    contentType: 'image/png',
    kind: phase === 'CHECKOUT' ? 'inspection-out' : 'inspection-in',
  });
  const dataPatch = phase === 'CHECKOUT'
    ? {
        checkoutInspectionSigPath: uploaded.storagePath,
        checkoutInspectionSignedAt: new Date(),
        checkoutWizardStep: Math.max(agreement.checkoutWizardStep ?? 0, 5),
      }
    : {
        checkinInspectionSigPath: uploaded.storagePath,
        checkinInspectionSignedAt: new Date(),
        checkinWizardStep: Math.max(agreement.checkinWizardStep ?? 0, 4),
      };
  await prisma.rentalAgreement.update({ where: { id: agreement.id }, data: dataPatch });
  return { storagePath: uploaded.storagePath, agreementId: agreement.id };
}

wizardStateAgreementRouter.post(
  '/:id/checkout-inspection-signature',
  requireRole('ADMIN', 'OPS', 'AGENT', 'SUPER_ADMIN'),
  async (req, res) => {
    try {
      const out = await uploadInspectionSig({ phase: 'CHECKOUT', req });
      res.status(201).json(out);
    } catch (err) {
      if (err.statusCode) return res.status(err.statusCode).json({ error: err.message });
      sendError(res, err);
    }
  }
);

wizardStateAgreementRouter.post(
  '/:id/checkin-inspection-signature',
  requireRole('ADMIN', 'OPS', 'AGENT', 'SUPER_ADMIN'),
  async (req, res) => {
    try {
      const out = await uploadInspectionSig({ phase: 'CHECKIN', req });
      res.status(201).json(out);
    } catch (err) {
      if (err.statusCode) return res.status(err.statusCode).json({ error: err.message });
      sendError(res, err);
    }
  }
);
