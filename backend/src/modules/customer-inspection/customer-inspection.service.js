/**
 * Customer-led inspection (2026-06-11, Fase A).
 * Plan: doc/customer-inspection-plan-2026-06-11.md
 *
 * Agent side (authed):
 *   • sendCustomerInspection({ sessionId, actorUserId }) — checkout step 4
 *     "Send inspection link to customer": requires the tenant setting ON and
 *     the session at INSPECTION_HANDOFF. Creates the CustomerInspection row,
 *     mints a 24h CUSTOMER_INSPECTION token, emails the link + disclosures,
 *     stamps the delegated side-effects and walks the session all the way to
 *     CLOSED through the EXISTING state machine — so the finalize cascade
 *     (agreement FINALIZED, vehicle ON_RENT, agreement email) runs untouched.
 *
 * Customer side (public, token IS the auth — same model as mobile-inspection):
 *   • loadByToken(token)      — identity + vehicle context for step 1, and the
 *                               diagram type for step 2.
 *   • reportDamage({ ... })   — one dot: view + x/y% + photo (required) +
 *                               description. Photo goes to Supabase Storage
 *                               (inline base64 fallback, same shape as
 *                               InventoryItem.photosJson).
 *   • completeInspection()    — marks SUBMITTED, consumes the token. Reports
 *                               land in the agent's damage-approval queue
 *                               (Fase B reviews them).
 *
 * ZERO money code.
 */

import { prisma } from '../../lib/prisma.js';
import logger from '../../lib/logger.js';
import { sendEmail } from '../../lib/mailer.js';
import { settingsService } from '../settings/settings.service.js';
import { checkoutSessionService, CheckoutSessionError } from '../checkout-session/checkout-session.service.js';
import { uploadObject, safePath } from '../../lib/storage/supabase-storage.js';
import { isStorageEnabled } from '../rental-agreements/inspection-photos.js';

const PHOTOS_BUCKET = process.env.SUPABASE_STORAGE_INVENTORY_BUCKET || 'inventory-photos';
export const VEHICLE_VIEWS = Object.freeze(['FRONT', 'REAR', 'LEFT', 'RIGHT', 'INTERIOR']);

function customerBaseUrl() {
  return (process.env.CUSTOMER_PORTAL_BASE_URL || process.env.APP_BASE_URL || process.env.FRONTEND_BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
}

/**
 * Map a vehicle type name/code to one of the diagram asset families.
 * Pure — unit-tested. Default: 'sedan'.
 */
export function diagramTypeFor(vehicleTypeNameOrCode) {
  const s = String(vehicleTypeNameOrCode || '').toLowerCase();
  if (/pick\s?-?up|truck/.test(s)) return 'pickup';
  if (/mini\s?-?van|\bvan\b|carnival|pacifica|sienna|odyssey/.test(s)) return 'van';
  if (/suv|crossover|cuv|4x4|jeep/.test(s)) return 'suv';
  if (/sedan|compact|economy|midsize|mid-size|full\s?size|coupe|hatch/.test(s)) return 'sedan';
  return 'sedan';
}

// ---------------------------------------------------------------------------
// Agent side
// ---------------------------------------------------------------------------

async function sendCustomerInspection({ sessionId, actorUserId }) {
  if (!sessionId) throw new CheckoutSessionError('sessionId required', 400);
  const session = await prisma.checkoutSession.findUnique({
    where: { id: sessionId },
    include: {
      reservation: {
        include: {
          customer: { select: { id: true, firstName: true, lastName: true, email: true } },
          vehicle: { select: { id: true, year: true, make: true, model: true, plate: true, vehicleType: { select: { name: true, code: true } } } },
          rentalAgreement: { select: { id: true } },
        },
      },
    },
  });
  if (!session) throw new CheckoutSessionError('Session not found', 404);

  const cfg = await settingsService.getCustomerInspectionConfig({ tenantId: session.tenantId || undefined });
  if (!cfg?.enabled) {
    throw new CheckoutSessionError('Customer-led inspection is not enabled for this tenant', 403, 'CUSTOMER_INSPECTION_DISABLED');
  }
  if (session.currentStep !== 'INSPECTION_HANDOFF') {
    throw new CheckoutSessionError(`Session must be at INSPECTION_HANDOFF (is ${session.currentStep})`, 409);
  }
  const resv = session.reservation;
  if (!resv?.vehicle?.id) throw new CheckoutSessionError('No vehicle assigned to this reservation', 422, 'NO_VEHICLE_ASSIGNED');
  const emailTo = String(resv?.customer?.email || '').trim();
  if (!emailTo) throw new CheckoutSessionError('Customer has no email on file — use the QR fail-safe instead', 422, 'NO_CUSTOMER_EMAIL');

  const inspection = await prisma.customerInspection.create({
    data: {
      tenantId: session.tenantId || null,
      vehicleId: resv.vehicle.id,
      reservationId: resv.id,
      rentalAgreementId: resv.rentalAgreement?.id || session.agreementId || null,
      reservationNumber: resv.reservationNumber || null,
      phase: 'CHECKOUT',
      status: 'SENT',
      emailTo,
      sentByUserId: actorUserId || null,
    },
  });

  const minted = await checkoutSessionService.mintHandoffToken({
    sessionId,
    kind: 'CUSTOMER_INSPECTION',
    actorUserId,
  });
  const link = `${customerBaseUrl()}/inspect/${minted.token}`;
  const vehicleLabel = [resv.vehicle.year, resv.vehicle.make, resv.vehicle.model].filter(Boolean).join(' ');
  const customerName = [resv.customer?.firstName, resv.customer?.lastName].filter(Boolean).join(' ') || 'Customer';

  await sendEmail({
    to: emailTo,
    subject: `Vehicle inspection for your rental ${resv.reservationNumber ? `#${resv.reservationNumber}` : ''}`.trim(),
    text: `Hi ${customerName},\n\nPlease complete the vehicle inspection for your rental (${vehicleLabel}${resv.vehicle.plate ? ` · ${resv.vehicle.plate}` : ''}).\n\nOpen this link on your phone: ${link}\n\nThe link expires in 24 hours.\n\nIMPORTANT: the inspection is your responsibility. Walk around the vehicle and report any damage you see (photo + short note). Any damage we detect upon return that was not reported and pertains to your rental period will be your responsibility.\n`,
    html: `
      <div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto;color:#1d1d2c">
        <h2 style="color:#5b3df5">Vehicle inspection — action needed</h2>
        <p>Hi ${customerName},</p>
        <p>Please complete the vehicle inspection for your rental:</p>
        <p style="background:#f4f2fd;border-radius:8px;padding:12px"><strong>${vehicleLabel}</strong>${resv.vehicle.plate ? ` · Plate ${resv.vehicle.plate}` : ''}${resv.reservationNumber ? `<br/>Reservation #${resv.reservationNumber}` : ''}</p>
        <p style="text-align:center;margin:24px 0">
          <a href="${link}" style="background:#5b3df5;color:#ffffff;text-decoration:none;padding:12px 28px;border-radius:8px;display:inline-block">Start inspection</a>
        </p>
        <p style="font-size:12px;color:#666">The link expires in 24 hours. It takes about 2 minutes: confirm your vehicle, then tap the diagram wherever you see damage and add a photo.</p>
        <p style="font-size:12px;color:#666"><strong>Important:</strong> the inspection is your responsibility. Any damage we detect upon return that was not reported and pertains to your rental period will be your responsibility.</p>
      </div>`,
  });

  // Delegated flow: the walkthrough responsibility moved to the customer, so
  // the wizard finishes now (Hector's spec). inspectionCompletedAt and
  // customerSignedAt are stamped as "delegated" — the customer's agreement
  // signature is the T&C signature captured at step 2; there is no in-person
  // final signature on this path. The event log says so explicitly.
  const now = new Date();
  await checkoutSessionService.stampSideEffect({ id: sessionId, field: 'inspectionCompletedAt', value: now });
  await checkoutSessionService.stampSideEffect({ id: sessionId, field: 'customerSignedAt', value: now });

  for (const toStep of ['INSPECTION_IN_PROGRESS', 'CUSTOMER_SIGN_PENDING', 'FINALIZING', 'CLOSED']) {
    await checkoutSessionService.transition({
      id: sessionId,
      toStep,
      actorUserId,
      metadata: { delegatedToCustomer: true, customerInspectionId: inspection.id },
    });
  }

  logger.info('[customer-inspection] link sent + checkout delegated to customer', {
    sessionId, inspectionId: inspection.id, reservationId: resv.id,
  });
  return { ok: true, inspectionId: inspection.id, emailTo, expiresAt: minted.expiresAt };
}

// ---------------------------------------------------------------------------
// Customer side (token-authed)
// ---------------------------------------------------------------------------

async function loadToken(token) {
  if (!token) throw new CheckoutSessionError('token required', 400);
  const row = await prisma.handoffToken.findUnique({
    where: { token },
    include: {
      reservation: {
        include: {
          customer: { select: { firstName: true, lastName: true } },
          vehicle: { select: { id: true, year: true, make: true, model: true, plate: true, color: true, vehicleType: { select: { name: true, code: true } } } },
        },
      },
    },
  });
  if (!row) throw new CheckoutSessionError('Invalid link', 410, 'TOKEN_INVALID');
  if (row.kind !== 'CUSTOMER_INSPECTION') throw new CheckoutSessionError('Wrong link kind', 410, 'TOKEN_WRONG_KIND');
  if (row.expiresAt < new Date()) throw new CheckoutSessionError('This inspection link expired — contact the rental office to get a new one', 410, 'TOKEN_EXPIRED');
  if (row.consumedAt) throw new CheckoutSessionError('This inspection was already submitted', 410, 'TOKEN_CONSUMED');
  return row;
}

async function findInspection(reservationId) {
  const inspection = await prisma.customerInspection.findFirst({
    where: { reservationId, status: 'SENT' },
    orderBy: { sentAt: 'desc' },
  });
  if (!inspection) throw new CheckoutSessionError('No pending inspection for this link', 409);
  return inspection;
}

async function loadByToken(token) {
  const row = await loadToken(token);
  const inspection = await findInspection(row.reservationId);
  if (!inspection.openedAt) {
    await prisma.customerInspection.update({ where: { id: inspection.id }, data: { openedAt: new Date() } }).catch(() => {});
  }
  const v = row.reservation?.vehicle || {};
  const reportCount = await prisma.vehicleDamageReport.count({ where: { customerInspectionId: inspection.id } });
  return {
    customerName: [row.reservation?.customer?.firstName, row.reservation?.customer?.lastName].filter(Boolean).join(' ') || null,
    vehicle: {
      label: [v.year, v.make, v.model].filter(Boolean).join(' ') || null,
      plate: v.plate || null,
      color: v.color || null,
      type: v.vehicleType?.name || null,
    },
    diagramType: diagramTypeFor(`${v.vehicleType?.name || ''} ${v.vehicleType?.code || ''}`),
    views: VEHICLE_VIEWS,
    phase: inspection.phase,
    reportCount,
    expiresAt: row.expiresAt,
  };
}

async function persistDamagePhoto(tenantId, reportId, photoDataUrl) {
  const match = /^data:([\w/.+-]+);base64,(.+)$/s.exec(String(photoDataUrl || ''));
  if (!match) throw new CheckoutSessionError('photo must be a base64 data URL', 400);
  const body = Buffer.from(match[2], 'base64');
  if (!body.length) throw new CheckoutSessionError('photo is empty', 400);
  if (body.length > 8 * 1024 * 1024) throw new CheckoutSessionError('photo exceeds 8MB', 400);
  if (isStorageEnabled()) {
    try {
      const ext = match[1].includes('png') ? 'png' : 'jpg';
      const path = safePath('customer-damage', tenantId || 'global', reportId, `photo.${ext}`);
      await uploadObject({ bucket: PHOTOS_BUCKET, path, body, contentType: match[1], upsert: true });
      return { storage: true, bucket: PHOTOS_BUCKET, refs: [{ key: 'photo', path, contentType: match[1], size: body.length, uploadedAt: new Date().toISOString() }] };
    } catch (e) {
      logger.warn('[customer-inspection] photo upload failed, storing inline', { reportId, err: e.message });
    }
  }
  return { storage: false, photos: { photo: photoDataUrl } };
}

async function reportDamage({ token, view, xPct, yPct, description, photoDataUrl, customerIp }) {
  const row = await loadToken(token);
  const inspection = await findInspection(row.reservationId);

  const viewKey = String(view || '').toUpperCase();
  if (!VEHICLE_VIEWS.includes(viewKey)) throw new CheckoutSessionError(`Unknown view: ${view}`, 400);
  const x = Number(xPct);
  const y = Number(yPct);
  if (!Number.isFinite(x) || x < 0 || x > 100 || !Number.isFinite(y) || y < 0 || y > 100) {
    throw new CheckoutSessionError('xPct/yPct must be 0..100', 400);
  }
  if (!photoDataUrl) throw new CheckoutSessionError('A photo of the damage is required', 400, 'PHOTO_REQUIRED');

  const existing = await prisma.vehicleDamageReport.count({ where: { customerInspectionId: inspection.id } });
  if (existing >= 30) throw new CheckoutSessionError('Too many reports on this inspection', 400);

  const report = await prisma.vehicleDamageReport.create({
    data: {
      tenantId: inspection.tenantId,
      vehicleId: inspection.vehicleId,
      customerInspectionId: inspection.id,
      reservationId: inspection.reservationId,
      reservationNumber: inspection.reservationNumber,
      phase: inspection.phase,
      view: viewKey,
      xPct: x,
      yPct: y,
      description: description ? String(description).slice(0, 500) : null,
      status: 'REPORTED',
      source: 'CUSTOMER',
    },
  });
  const photoJson = await persistDamagePhoto(inspection.tenantId, report.id, photoDataUrl);
  await prisma.vehicleDamageReport.update({ where: { id: report.id }, data: { photoJson } });

  logger.info('[customer-inspection] damage reported', {
    inspectionId: inspection.id, reportId: report.id, view: viewKey, customerIp: customerIp || null,
  });
  return { id: report.id, view: viewKey };
}

async function completeInspection({ token }) {
  const row = await loadToken(token);
  const inspection = await findInspection(row.reservationId);
  const reportCount = await prisma.vehicleDamageReport.count({ where: { customerInspectionId: inspection.id } });
  const now = new Date();
  await prisma.$transaction([
    prisma.customerInspection.update({
      where: { id: inspection.id },
      data: { status: 'SUBMITTED', submittedAt: now },
    }),
    prisma.handoffToken.update({ where: { id: row.id }, data: { consumedAt: now } }),
  ]);
  logger.info('[customer-inspection] submitted', { inspectionId: inspection.id, reportCount });
  return { ok: true, reportCount };
}

export const customerInspectionService = {
  sendCustomerInspection,
  loadByToken,
  reportDamage,
  completeInspection,
};
