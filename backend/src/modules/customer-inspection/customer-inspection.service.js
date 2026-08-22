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

import { randomBytes, createHmac, timingSafeEqual } from 'node:crypto';
import { prisma } from '../../lib/prisma.js';
import logger from '../../lib/logger.js';
import { sendEmail } from '../../lib/mailer.js';
import { renderBrandedEmail, resolveEmailBrand } from '../../lib/email-template.js';
import { settingsService } from '../settings/settings.service.js';
import { checkoutSessionService, CheckoutSessionError } from '../checkout-session/checkout-session.service.js';
import { uploadObject, safePath } from '../../lib/storage/supabase-storage.js';
import { isStorageEnabled } from '../rental-agreements/inspection-photos.js';

function escHtml(v) {
  return String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const PHOTOS_BUCKET = process.env.SUPABASE_STORAGE_INVENTORY_BUCKET || 'inventory-photos';
export const VEHICLE_VIEWS = Object.freeze(['FRONT', 'REAR', 'LEFT', 'RIGHT', 'INTERIOR']);

function customerBaseUrl() {
  return (process.env.CUSTOMER_PORTAL_BASE_URL || process.env.APP_BASE_URL || process.env.FRONTEND_BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
}

// Configurable link windows (2026-08-22 security redesign). All env-overridable
// so a tenant can tighten/loosen without a redeploy. Defaults are the product
// owner decision: checkout & check-in emailed links live 72h; the contract QR
// resolver lives until returnAt + a 48h grace (capped absolutely, below).
function positiveHoursEnv(name, defHours) {
  const h = Number(process.env[name]);
  return (Number.isFinite(h) && h > 0 ? h : defHours);
}
function checkoutTtlHours() { return positiveHoursEnv('CUSTOMER_INSPECTION_CHECKOUT_TTL_HOURS', 72); }
function checkinTtlHours() { return positiveHoursEnv('CUSTOMER_INSPECTION_CHECKIN_TTL_HOURS', 72); }
function resolverGraceHours() { return positiveHoursEnv('CUSTOMER_INSPECTION_RESOLVER_GRACE_HOURS', 48); }
// Absolute ceiling on a contract-QR resolver's life, measured from when the
// contract is rendered — so an accidental far-future returnAt (or a never-closed
// rental) can't mint a link that resolves for years. 30 days is comfortably past
// any real rental + grace.
const RESOLVER_MAX_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;
// Human phrase for email copy ("72 hours" / "3 days").
function describeWindow(hours) {
  if (hours % 24 === 0) {
    const d = hours / 24;
    return d === 1 ? '1 day' : `${d} days`;
  }
  return hours === 1 ? '1 hour' : `${hours} hours`;
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

// closedSession (kiosk B3a, 2026-07-05): the kiosk walks the checkout state
// machine to CLOSED itself, so its inspection link is minted AFTER the close
// instead of delegating the wizard. With { closedSession: true } the step
// guard accepts CLOSED, the delegation stamps + transition walk are skipped,
// and a per-reservation dedupe (mirror of the CHECKIN-path dedupe) makes a
// retried /complete idempotent. Default (false) behavior is byte-identical
// for the existing wizard caller.
async function sendCustomerInspection({ sessionId, actorUserId, closedSession = false }) {
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
  if (closedSession) {
    if (session.currentStep !== 'CLOSED') {
      throw new CheckoutSessionError(`Session must be CLOSED (is ${session.currentStep})`, 409);
    }
  } else if (session.currentStep !== 'INSPECTION_HANDOFF') {
    throw new CheckoutSessionError(`Session must be at INSPECTION_HANDOFF (is ${session.currentStep})`, 409);
  }
  const resv = session.reservation;
  if (!resv?.vehicle?.id) throw new CheckoutSessionError('No vehicle assigned to this reservation', 422, 'NO_VEHICLE_ASSIGNED');
  const emailTo = String(resv?.customer?.email || '').trim();
  if (!emailTo) throw new CheckoutSessionError('Customer has no email on file — use the QR fail-safe instead', 422, 'NO_CUSTOMER_EMAIL');

  // Dedupe (closedSession only): one CHECKOUT inspection per reservation —
  // a retried kiosk /complete must never re-create rows or re-email.
  if (closedSession) {
    const existing = await prisma.customerInspection.findFirst({
      where: { reservationId: resv.id, phase: 'CHECKOUT' },
      orderBy: { sentAt: 'desc' },
    });
    if (existing) {
      return { ok: true, inspectionId: existing.id, emailTo: existing.emailTo, alreadySent: true };
    }
  }

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

  const checkoutWindowText = describeWindow(checkoutTtlHours());
  const inspectText1 = `Hi ${customerName},\n\nPlease complete the vehicle inspection for your rental (${vehicleLabel}${resv.vehicle.plate ? ` · ${resv.vehicle.plate}` : ''}).\n\nOpen this link on your phone: ${link}\n\nThe link expires in ${checkoutWindowText}.\n\nIMPORTANT: the inspection is your responsibility. Walk around the vehicle and report any damage you see (photo + short note). Any damage we detect upon return that was not reported and pertains to your rental period will be your responsibility.\n`;
  let inspectBrand1;
  try { inspectBrand1 = await resolveEmailBrand({ tenantId: session.tenantId || resv.tenantId || null }); } catch { inspectBrand1 = undefined; }
  const inspectBodyHtml1 = `
        <p>Hi ${escHtml(customerName)},</p>
        <p>Please complete the vehicle inspection for your rental:</p>
        <p style="background:#f4f2fd;border-radius:8px;padding:12px"><strong>${escHtml(vehicleLabel)}</strong>${resv.vehicle.plate ? ` · Plate ${escHtml(resv.vehicle.plate)}` : ''}${resv.reservationNumber ? `<br/>Reservation #${escHtml(resv.reservationNumber)}` : ''}</p>
        <p style="font-size:12px;color:#666">The link expires in ${escHtml(checkoutWindowText)}. It takes about 2 minutes: confirm your vehicle, then tap the diagram wherever you see damage and add a photo.</p>
        <p style="font-size:12px;color:#666"><strong>Important:</strong> the inspection is your responsibility. Any damage we detect upon return that was not reported and pertains to your rental period will be your responsibility.</p>`;
  const inspectRendered1 = renderBrandedEmail({
    brand: inspectBrand1,
    heading: 'Vehicle inspection — action needed',
    bodyHtml: inspectBodyHtml1,
    bodyText: inspectText1,
    cta: { label: 'Start inspection', url: link },
    preheader: 'Complete your vehicle inspection',
  });
  await sendEmail({ tenantId: session.tenantId || resv.tenantId || undefined,
    to: emailTo,
    subject: `Vehicle inspection for your rental ${resv.reservationNumber ? `#${resv.reservationNumber}` : ''}`.trim(),
    text: inspectRendered1.text,
    html: inspectRendered1.html,
  });

  // closedSession (kiosk): the machine already reached CLOSED — nothing to
  // delegate, no stamps, no transitions. Just the link + email above. The
  // link (same 24h token the email carries) is returned so the kiosk DONE
  // screen can render it as an on-screen QR (mockup K8).
  if (closedSession) {
    logger.info('[customer-inspection] link sent for closed kiosk checkout', {
      sessionId, inspectionId: inspection.id, reservationId: resv.id,
    });
    return { ok: true, inspectionId: inspection.id, emailTo, expiresAt: minted.expiresAt, link };
  }

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
// Fase D — CHECK-IN (return) inspection. Unlike checkout, there is NO active
// checkout-session at return time, so we bind the token directly to the
// reservation and do NOT walk any state machine. Triggered by the D-1
// scheduler (the day before return) or manually ("resend"). The customer
// reports return-time damage through the SAME public /inspect/:token flow;
// the reports land in the agent's approval queue tagged CHECKIN.
// ---------------------------------------------------------------------------
async function sendCheckinInspection({ reservationId, actorUserId = null, force = false }) {
  if (!reservationId) throw new CheckoutSessionError('reservationId required', 400);
  const resv = await prisma.reservation.findUnique({
    where: { id: reservationId },
    include: {
      customer: { select: { id: true, firstName: true, lastName: true, email: true } },
      vehicle: { select: { id: true, year: true, make: true, model: true, plate: true } },
      rentalAgreement: { select: { id: true } },
    },
  });
  if (!resv) throw new CheckoutSessionError('Reservation not found', 404);

  const cfg = await settingsService.getCustomerInspectionConfig({ tenantId: resv.tenantId || undefined });
  if (!cfg?.enabled) {
    throw new CheckoutSessionError('Customer-led inspection is not enabled for this tenant', 403, 'CUSTOMER_INSPECTION_DISABLED');
  }
  if (!resv.vehicle?.id) throw new CheckoutSessionError('No vehicle assigned to this reservation', 422, 'NO_VEHICLE_ASSIGNED');
  const emailTo = String(resv.customer?.email || '').trim();
  if (!emailTo) throw new CheckoutSessionError('Customer has no email on file — use the printed QR fail-safe instead', 422, 'NO_CUSTOMER_EMAIL');

  // Dedupe: one CHECK-IN inspection per reservation unless forced (manual resend).
  if (!force) {
    const existing = await prisma.customerInspection.findFirst({
      where: { reservationId, phase: 'CHECKIN' },
      orderBy: { sentAt: 'desc' },
    });
    if (existing) {
      return { ok: true, inspectionId: existing.id, emailTo: existing.emailTo, alreadySent: true };
    }
  }

  const inspection = await prisma.customerInspection.create({
    data: {
      tenantId: resv.tenantId || null,
      vehicleId: resv.vehicle.id,
      reservationId: resv.id,
      rentalAgreementId: resv.rentalAgreement?.id || null,
      reservationNumber: resv.reservationNumber || null,
      phase: 'CHECKIN',
      status: 'SENT',
      emailTo,
      sentByUserId: actorUserId,
    },
  });

  // Mint the token directly on the reservation (no checkout-session at return time).
  // Configurable TTL (default 72h, env CUSTOMER_INSPECTION_CHECKIN_TTL_HOURS).
  const checkinHours = checkinTtlHours();
  const token = randomBytes(24).toString('hex');
  const expiresAt = new Date(Date.now() + checkinHours * 60 * 60 * 1000);
  await prisma.handoffToken.create({
    data: { reservationId: resv.id, kind: 'CUSTOMER_INSPECTION', token, expiresAt, createdByUserId: actorUserId },
  });

  const link = `${customerBaseUrl()}/inspect/${token}`;
  const vehicleLabel = [resv.vehicle.year, resv.vehicle.make, resv.vehicle.model].filter(Boolean).join(' ');
  const customerName = [resv.customer?.firstName, resv.customer?.lastName].filter(Boolean).join(' ') || 'Customer';

  const checkinWindowText = describeWindow(checkinHours);
  const inspectText2 = `Hi ${customerName},\n\nYour rental (${vehicleLabel}${resv.vehicle.plate ? ` · ${resv.vehicle.plate}` : ''}) is due back soon. Before you return it, please do a quick self-inspection so check-in is fast and there are no surprises.\n\nOpen this link on your phone: ${link}\n\nThe link expires in ${checkinWindowText}. Walk around the vehicle and report any damage (photo + short note).\n`;
  let inspectBrand2;
  try { inspectBrand2 = await resolveEmailBrand({ tenantId: resv.tenantId || null }); } catch { inspectBrand2 = undefined; }
  const inspectBodyHtml2 = `
        <p>Hi ${escHtml(customerName)},</p>
        <p>Your rental is due back soon. Do a quick self-inspection before you return it — it makes check-in faster:</p>
        <p style="background:#f4f2fd;border-radius:8px;padding:12px"><strong>${escHtml(vehicleLabel)}</strong>${resv.vehicle.plate ? ` · Plate ${escHtml(resv.vehicle.plate)}` : ''}${resv.reservationNumber ? `<br/>Reservation #${escHtml(resv.reservationNumber)}` : ''}</p>
        <p style="font-size:12px;color:#666">The link expires in ${escHtml(checkinWindowText)}. It takes about 2 minutes: confirm your vehicle, then tap the diagram wherever you see damage and add a photo.</p>
        <p style="font-size:12px;color:#666"><strong>Important:</strong> reporting existing damage protects you. Any new damage found at return that pertains to your rental period may be your responsibility.</p>`;
  const inspectRendered2 = renderBrandedEmail({
    brand: inspectBrand2,
    heading: 'Returning soon? Quick inspection',
    bodyHtml: inspectBodyHtml2,
    bodyText: inspectText2,
    cta: { label: 'Start inspection', url: link },
    preheader: 'Quick self-inspection before you return',
  });
  await sendEmail({ tenantId: resv.tenantId,
    to: emailTo,
    subject: `Before you return your rental ${resv.reservationNumber ? `#${resv.reservationNumber}` : ''} — quick inspection`.trim(),
    text: inspectRendered2.text,
    html: inspectRendered2.html,
  });

  logger.info('[customer-inspection] check-in link sent', {
    inspectionId: inspection.id, reservationId: resv.id, emailTo,
  });
  return { ok: true, inspectionId: inspection.id, emailTo, expiresAt };
}

// ---------------------------------------------------------------------------
// Fase D — PRINTED PER-VEHICLE QR (fail-safe placed inside the car). The QR is
// static and encodes a signed `vehicleId.sig` payload (HMAC over JWT_SECRET, no
// schema column needed). Scanning it resolves the vehicle's ACTIVE rental and
// mints a CHECK-IN inspection token on the spot — no email required. Bounded:
// only resolves when the vehicle has a CHECKED_OUT reservation.
// ---------------------------------------------------------------------------
function vehicleSigSecret() {
  // FAIL CLOSED (2026-08-22). This used to fall back to the literal
  // 'ride-fleet-qr' when no secret was configured — which would make every
  // vehicle QR signature forgeable and every vehicle id enumerable. There is no
  // safe default for a signing secret: if neither env var is set, refuse rather
  // than sign with a public constant. In production JWT_SECRET is always set
  // (the app hard-fails at boot without it), so this never triggers there.
  const secret = process.env.JWT_SECRET || process.env.BACKEND_INTERNAL_TOKEN;
  if (!secret) {
    throw new CheckoutSessionError('QR signing is not configured', 503, 'QR_NOT_CONFIGURED');
  }
  return secret;
}
function signVehicle(vehicleId) {
  return createHmac('sha256', vehicleSigSecret()).update(`checkin-qr:${vehicleId}`).digest('hex').slice(0, 24);
}
function verifyVehicleSig(vehicleId, sig) {
  const expected = signVehicle(vehicleId);
  const a = Buffer.from(String(sig || ''));
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

// Authed: the agent prints this for the vehicle. Returns the customer-facing URL the QR encodes.
function checkinQrUrlForVehicle(vehicleId) {
  return `${customerBaseUrl()}/inspect/v/${vehicleId}.${signVehicle(vehicleId)}`;
}

// Public: resolve a scanned `vehicleId.sig` → a CHECK-IN inspection token for the active rental.
// Reuses an existing CHECK-IN inspection + live token when present (so repeat scans don't pile up).
async function startCheckinByVehicleQr({ payload }) {
  const raw = String(payload || '');
  const dot = raw.lastIndexOf('.');
  if (dot < 0) throw new CheckoutSessionError('Invalid code', 400, 'BAD_QR');
  const vehicleId = raw.slice(0, dot);
  const sig = raw.slice(dot + 1);
  if (!vehicleId || !verifyVehicleSig(vehicleId, sig)) throw new CheckoutSessionError('Invalid code', 410, 'BAD_QR');

  const resv = await prisma.reservation.findFirst({
    where: { vehicleId, status: 'CHECKED_OUT' },
    orderBy: { returnAt: 'asc' },
    select: { id: true, tenantId: true, rentalAgreement: { select: { id: true } }, reservationNumber: true },
  });
  if (!resv) throw new CheckoutSessionError('No active rental on this vehicle right now', 409, 'NO_ACTIVE_RENTAL');

  const cfg = await settingsService.getCustomerInspectionConfig({ tenantId: resv.tenantId || undefined });
  if (!cfg?.enabled) throw new CheckoutSessionError('Customer-led inspection is not enabled', 403, 'CUSTOMER_INSPECTION_DISABLED');

  // Reuse a live token if this rental already has a CHECK-IN inspection in flight.
  const existingTok = await prisma.handoffToken.findFirst({
    where: { reservationId: resv.id, kind: 'CUSTOMER_INSPECTION', consumedAt: null, expiresAt: { gt: new Date(Date.now() + 60_000) } },
    orderBy: { expiresAt: 'desc' },
  });
  const existingInsp = await prisma.customerInspection.findFirst({
    where: { reservationId: resv.id, phase: 'CHECKIN' },
    orderBy: { sentAt: 'desc' },
  });
  if (existingTok && existingInsp) return { token: existingTok.token };

  const inspection = existingInsp || await prisma.customerInspection.create({
    data: {
      tenantId: resv.tenantId || null,
      vehicleId,
      reservationId: resv.id,
      rentalAgreementId: resv.rentalAgreement?.id || null,
      reservationNumber: resv.reservationNumber || null,
      phase: 'CHECKIN',
      status: 'SENT',
      emailTo: null,
    },
  });
  const token = randomBytes(24).toString('hex');
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
  await prisma.handoffToken.create({
    data: { reservationId: resv.id, kind: 'CUSTOMER_INSPECTION', token, expiresAt },
  });
  logger.info('[customer-inspection] check-in started via printed QR', { reservationId: resv.id, inspectionId: inspection.id });
  return { token };
}

// ---------------------------------------------------------------------------
// Fase D (2026-08-22 redesign) — RESERVATION-BOUND signed resolver. Replaces the
// static per-vehicle sticker as the primary QR (printed on the rental agreement).
// The signed payload binds to ONE reservation and carries an expiry INSIDE the
// signed message, so a photographed code stops resolving after returnAt + grace
// and can NEVER be repointed at whichever rental happens to be on the car. Same
// fail-closed secret as the vehicle sticker (vehicleSigSecret).
// ---------------------------------------------------------------------------
export function signReservation(reservationId, expMs) {
  return createHmac('sha256', vehicleSigSecret())
    .update(`checkin-qr:${reservationId}:${expMs}`)
    .digest('hex')
    .slice(0, 24);
}
export function verifyReservationSig(reservationId, expMs, sig) {
  const expected = signReservation(reservationId, expMs);
  const a = Buffer.from(String(sig || ''));
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

// Authed/print-time: the customer-facing URL the contract QR encodes. The signed
// expiry (expMs) comes from the caller (reservation.returnAt + grace) and is
// capped to an absolute ceiling so a bad returnAt can't mint a near-immortal link.
function inspectionResolverUrlForReservation(reservationId, { expiresAt } = {}) {
  const cap = Date.now() + RESOLVER_MAX_LIFETIME_MS;
  const want = expiresAt instanceof Date ? expiresAt.getTime() : Number(expiresAt);
  const expMs = Math.min(Number.isFinite(want) ? want : cap, cap);
  const sig = signReservation(reservationId, expMs);
  return `${customerBaseUrl()}/inspect/r/${reservationId}.${expMs}.${sig}`;
}

// Public: resolve a scanned `reservationId.expMs.sig` → a CHECK-IN inspection
// token for THAT reservation. Mirrors startCheckinByVehicleQr's live-token reuse
// + inspection-create, but keyed on the signed reservation id (not "first rental
// on this vehicle") and gated by the in-signature expiry.
async function startInspectionByReservationQr({ payload }) {
  const raw = String(payload || '');
  const parts = raw.split('.');
  if (parts.length !== 3) throw new CheckoutSessionError('Invalid code', 400, 'BAD_QR');
  const [reservationId, expStr, sig] = parts;
  const expMs = Number(expStr);
  if (!reservationId || !Number.isFinite(expMs) || !verifyReservationSig(reservationId, expMs, sig)) {
    throw new CheckoutSessionError('Invalid code', 410, 'BAD_QR');
  }
  if (expMs < Date.now()) {
    throw new CheckoutSessionError('This inspection code has expired — please see the rental office to get a new one', 410, 'RESOLVER_EXPIRED');
  }

  const resv = await prisma.reservation.findFirst({
    where: { id: reservationId, status: 'CHECKED_OUT' },
    select: { id: true, tenantId: true, vehicleId: true, rentalAgreement: { select: { id: true } }, reservationNumber: true },
  });
  if (!resv) throw new CheckoutSessionError('No active rental for this code right now', 409, 'NO_ACTIVE_RENTAL');

  const cfg = await settingsService.getCustomerInspectionConfig({ tenantId: resv.tenantId || undefined });
  if (!cfg?.enabled) throw new CheckoutSessionError('Customer-led inspection is not enabled', 403, 'CUSTOMER_INSPECTION_DISABLED');

  // Reuse a live token if this rental already has a CHECK-IN inspection in flight.
  const existingTok = await prisma.handoffToken.findFirst({
    where: { reservationId: resv.id, kind: 'CUSTOMER_INSPECTION', consumedAt: null, expiresAt: { gt: new Date(Date.now() + 60_000) } },
    orderBy: { expiresAt: 'desc' },
  });
  const existingInsp = await prisma.customerInspection.findFirst({
    where: { reservationId: resv.id, phase: 'CHECKIN' },
    orderBy: { sentAt: 'desc' },
  });
  if (existingTok && existingInsp) return { token: existingTok.token };

  const inspection = existingInsp || await prisma.customerInspection.create({
    data: {
      tenantId: resv.tenantId || null,
      vehicleId: resv.vehicleId,
      reservationId: resv.id,
      rentalAgreementId: resv.rentalAgreement?.id || null,
      reservationNumber: resv.reservationNumber || null,
      phase: 'CHECKIN',
      status: 'SENT',
      emailTo: null, // name stays hidden — same as the sticker path
    },
  });
  const token = randomBytes(24).toString('hex');
  const expiresAt = new Date(Date.now() + checkinTtlHours() * 60 * 60 * 1000);
  await prisma.handoffToken.create({
    data: { reservationId: resv.id, kind: 'CUSTOMER_INSPECTION', token, expiresAt },
  });
  logger.info('[customer-inspection] check-in started via reservation QR', { reservationId: resv.id, inspectionId: inspection.id });
  return { token };
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
  // Only reveal the renter's name on the EMAILED flow, where the link went to
  // the customer's own inbox (inspection.emailTo is set). The printed-QR flow
  // creates the inspection with emailTo:null and is reachable by anyone who
  // photographed the sticker — so it must not disclose who currently has the
  // car (2026-08-22). The customer confirms the vehicle by plate/colour instead.
  const nameVisible = Boolean(inspection.emailTo);
  return {
    customerName: nameVisible
      ? ([row.reservation?.customer?.firstName, row.reservation?.customer?.lastName].filter(Boolean).join(' ') || null)
      : null,
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

/**
 * Manually record an EXISTING damage from the vehicle profile (agent-entered, no
 * inspection/customer involved). Goes straight to HARD_APPROVED so it shows on the
 * vehicle's damage history (and can later be Fixed or rolled into a Repair Order).
 * Photo is required, same as a customer report. source = 'MANUAL'.
 */
async function addManualDamage(vehicleId, body = {}, scope = {}) {
  const tenantId = scope?.tenantId;
  if (!tenantId || tenantId === '__no_tenant__') throw new CheckoutSessionError('tenantId required', 400);
  const vehicle = await prisma.vehicle.findFirst({ where: { id: String(vehicleId), tenantId }, select: { id: true } });
  if (!vehicle) throw new CheckoutSessionError('Vehicle not found', 404);

  const viewKey = String(body?.view || '').toUpperCase();
  if (!['FRONT', 'REAR', 'LEFT', 'RIGHT', 'INTERIOR'].includes(viewKey)) throw new CheckoutSessionError('Invalid view', 400);
  const x = Number(body?.xPct); const y = Number(body?.yPct);
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 100 || y < 0 || y > 100) {
    throw new CheckoutSessionError('xPct/yPct must be 0..100', 400);
  }
  if (!body?.photoDataUrl) throw new CheckoutSessionError('A photo of the damage is required', 400, 'PHOTO_REQUIRED');

  // Report Damage flow (Feature 3) context — all optional. Plain vehicle-profile
  // manual damages omit these and every column stays NULL (unchanged behavior).
  const toCents = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Math.round(Number(v)));
  const rp = body.responsibleParty
    ? String(body.responsibleParty).toUpperCase()
    : null;

  const report = await prisma.vehicleDamageReport.create({
    data: {
      tenantId,
      vehicleId: String(vehicleId),
      phase: 'CHECKIN', // neutral; manual damages aren't tied to a checkout/checkin
      view: viewKey,
      xPct: x,
      yPct: y,
      description: body.description ? String(body.description).slice(0, 500) : null,
      status: 'HARD_APPROVED',
      source: 'MANUAL',
      reviewedByUserId: scope.userId || null,
      reviewedAt: new Date(),
      reservationId: body.reservationId ? String(body.reservationId) : null,
      reservationNumber: body.reservationNumber ? String(body.reservationNumber).slice(0, 60) : null,
      damageCostCents: toCents(body.damageCostCents),
      ourDeductibleCents: toCents(body.ourDeductibleCents),
      responsibleParty: rp,
    },
  });
  const photoJson = await persistDamagePhoto(tenantId, report.id, body.photoDataUrl);
  const patch = { photoJson };
  if (body.estimatePhotoDataUrl) {
    patch.estimatePhotoJson = await persistDamagePhoto(tenantId, `${report.id}-estimate`, body.estimatePhotoDataUrl);
  }
  await prisma.vehicleDamageReport.update({ where: { id: report.id }, data: patch });
  logger.info('[customer-inspection] manual damage added', { vehicleId, reportId: report.id, view: viewKey });
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
      // 0 reports → nothing for the agent to approve: auto-REVIEWED so the
      // dashboard queue only counts inspections that actually need eyes.
      data: reportCount === 0
        ? { status: 'REVIEWED', submittedAt: now, reviewedAt: now }
        : { status: 'SUBMITTED', submittedAt: now },
    }),
    prisma.handoffToken.update({ where: { id: row.id }, data: { consumedAt: now } }),
  ]);
  logger.info('[customer-inspection] submitted', { inspectionId: inspection.id, reportCount });
  return { ok: true, reportCount };
}

// ---------------------------------------------------------------------------
// Fase B — agent review queue (soft/hard approval)
// ---------------------------------------------------------------------------

function tenantWhere(scope) {
  return scope?.tenantId ? { tenantId: scope.tenantId } : {};
}

const VEHICLE_SELECT = {
  select: {
    id: true, internalNumber: true, plate: true, year: true, make: true, model: true,
    vehicleType: { select: { name: true, code: true } },
  },
};

function vehicleSummary(v) {
  if (!v) return null;
  return {
    id: v.id,
    internalNumber: v.internalNumber,
    plate: v.plate || null,
    label: [v.year, v.make, v.model].filter(Boolean).join(' ') || null,
    diagramType: diagramTypeFor(`${v.vehicleType?.name || ''} ${v.vehicleType?.code || ''}`),
  };
}

/** Photo URL for a damage report (signed Supabase URL or inline data URL). */
async function reportPhotoUrl(photoJson) {
  const pj = photoJson || null;
  if (!pj || typeof pj !== 'object') return null;
  if (pj.storage && Array.isArray(pj.refs)) {
    try {
      const { materializeStorageRefs } = await import('../rental-agreements/inspection-photos.js');
      const map = await materializeStorageRefs(pj.refs, { bucket: pj.bucket || PHOTOS_BUCKET });
      const first = map?.photo;
      return Array.isArray(first) ? first[0] || null : first || null;
    } catch {
      return null;
    }
  }
  if (pj.photos && typeof pj.photos === 'object') return pj.photos.photo || null;
  return null;
}

async function listInspections(scope = {}, { status, reservationId } = {}) {
  const where = {
    ...tenantWhere(scope),
    ...(reservationId ? { reservationId } : {}),
    ...(status ? { status: String(status).toUpperCase() } : {}),
  };
  const rows = await prisma.customerInspection.findMany({
    where,
    orderBy: { submittedAt: 'desc' },
    take: 100,
    include: {
      vehicle: VEHICLE_SELECT,
      damageReports: { select: { id: true, status: true, view: true } },
    },
  });
  return rows.map((r) => ({
    id: r.id,
    status: r.status,
    phase: r.phase,
    reservationId: r.reservationId,
    reservationNumber: r.reservationNumber,
    emailTo: r.emailTo,
    sentAt: r.sentAt,
    submittedAt: r.submittedAt,
    reviewedAt: r.reviewedAt,
    vehicle: vehicleSummary(r.vehicle),
    reportCount: r.damageReports.length,
    pendingCount: r.damageReports.filter((d) => d.status === 'REPORTED').length,
  }));
}

async function getInspection(id, scope = {}) {
  const r = await prisma.customerInspection.findFirst({
    where: { id, ...tenantWhere(scope) },
    include: {
      vehicle: VEHICLE_SELECT,
      damageReports: { orderBy: { createdAt: 'asc' } },
    },
  });
  if (!r) throw new CheckoutSessionError('Inspection not found', 404);
  const reports = [];
  for (const d of r.damageReports) {
    reports.push({
      id: d.id,
      view: d.view,
      xPct: Number(d.xPct),
      yPct: Number(d.yPct),
      description: d.description,
      status: d.status,
      reviewedAt: d.reviewedAt,
      photoUrl: await reportPhotoUrl(d.photoJson),
      createdAt: d.createdAt,
    });
  }
  return {
    id: r.id,
    status: r.status,
    phase: r.phase,
    reservationId: r.reservationId,
    reservationNumber: r.reservationNumber,
    emailTo: r.emailTo,
    sentAt: r.sentAt,
    submittedAt: r.submittedAt,
    reviewedAt: r.reviewedAt,
    vehicle: vehicleSummary(r.vehicle),
    reports,
  };
}

/**
 * Soft = acknowledged only (never hits the vehicle record).
 * Hard = goes to the vehicle's damage history (Fase C diagram) until FIXED.
 * When the last REPORTED item is decided, the inspection flips to REVIEWED.
 */
async function reviewReport({ inspectionId, reportId, action, actorUserId, scope = {} }) {
  const act = String(action || '').toLowerCase();
  if (!['soft', 'hard'].includes(act)) throw new CheckoutSessionError(`Unknown action: ${action}`, 400);
  const inspection = await prisma.customerInspection.findFirst({
    where: { id: inspectionId, ...tenantWhere(scope) },
    select: { id: true },
  });
  if (!inspection) throw new CheckoutSessionError('Inspection not found', 404);
  const report = await prisma.vehicleDamageReport.findFirst({
    where: { id: reportId, customerInspectionId: inspectionId },
    select: { id: true, status: true },
  });
  if (!report) throw new CheckoutSessionError('Report not found', 404);
  if (report.status !== 'REPORTED') throw new CheckoutSessionError(`Report already ${report.status}`, 409);

  const now = new Date();
  await prisma.vehicleDamageReport.update({
    where: { id: reportId },
    data: {
      status: act === 'hard' ? 'HARD_APPROVED' : 'SOFT_APPROVED',
      reviewedByUserId: actorUserId || null,
      reviewedAt: now,
    },
  });

  const pending = await prisma.vehicleDamageReport.count({
    where: { customerInspectionId: inspectionId, status: 'REPORTED' },
  });
  if (pending === 0) {
    await prisma.customerInspection.update({
      where: { id: inspectionId },
      data: { status: 'REVIEWED', reviewedAt: now, reviewedByUserId: actorUserId || null },
    });
  }
  logger.info('[customer-inspection] report reviewed', { inspectionId, reportId, action: act, pendingLeft: pending });
  return { ok: true, status: act === 'hard' ? 'HARD_APPROVED' : 'SOFT_APPROVED', pendingLeft: pending, inspectionReviewed: pending === 0 };
}

// ---------------------------------------------------------------------------
// Fase C — vehicle damage history + fix workflow
// ---------------------------------------------------------------------------

/**
 * Damage history for one vehicle: HARD_APPROVED (active — must be fixed to
 * clear) + FIXED (kept forever). Soft-approved reports never show here by
 * design (Hector: "we are not passing it on to be permanently recorded").
 */
async function getVehicleDamageHistory(vehicleId, scope = {}) {
  const vehicle = await prisma.vehicle.findFirst({
    where: { id: vehicleId, ...tenantWhere(scope) },
    select: VEHICLE_SELECT.select,
  });
  if (!vehicle) throw new CheckoutSessionError('Vehicle not found', 404);
  const rows = await prisma.vehicleDamageReport.findMany({
    where: { vehicleId, status: { in: ['HARD_APPROVED', 'FIXED'] } },
    orderBy: { reviewedAt: 'desc' },
    take: 200,
    // The acknowledgement signature (≤500KB data URL) and statement text are
    // never projected into this response — don't haul 200 of them from the
    // DB per vehicle-profile view (QA m4).
    omit: { customerAckSignatureDataUrl: true, customerAckStatementText: true },
  });
  const project = async (d) => ({
    id: d.id,
    view: d.view,
    xPct: Number(d.xPct),
    yPct: Number(d.yPct),
    description: d.description,
    status: d.status,
    phase: d.phase,
    reservationNumber: d.reservationNumber,
    reportedAt: d.createdAt,
    approvedAt: d.reviewedAt,
    fixedAt: d.fixedAt,
    photoUrl: await reportPhotoUrl(d.photoJson),
    fixedPhotoUrl: await reportPhotoUrl(d.fixedPhotoJson),
  });
  const active = [];
  const fixed = [];
  for (const d of rows) {
    const row = await project(d);
    if (d.status === 'HARD_APPROVED') active.push(row);
    else fixed.push(row);
  }
  return { vehicle: vehicleSummary(vehicle), active, fixed };
}

/**
 * Mark a HARD_APPROVED damage as FIXED. Repair photo is REQUIRED (Hector's
 * spec: "all they need to do is take a picture that it was fixed"). The
 * report stays in history with status FIXED; the dot leaves the diagram.
 */
async function fixDamageReport({ reportId, photoDataUrl, actorUserId, scope = {} }) {
  const report = await prisma.vehicleDamageReport.findFirst({
    where: { id: reportId, ...tenantWhere(scope) },
    select: { id: true, status: true, tenantId: true },
  });
  if (!report) throw new CheckoutSessionError('Damage report not found', 404);
  if (report.status !== 'HARD_APPROVED') {
    throw new CheckoutSessionError(`Only hard-approved damages can be fixed (is ${report.status})`, 409);
  }
  if (!photoDataUrl) throw new CheckoutSessionError('A photo of the repair is required', 400, 'PHOTO_REQUIRED');
  const fixedPhotoJson = await persistDamagePhoto(report.tenantId, `${report.id}-fixed`, photoDataUrl);
  const now = new Date();
  await prisma.vehicleDamageReport.update({
    where: { id: reportId },
    data: { status: 'FIXED', fixedAt: now, fixedByUserId: actorUserId || null, fixedPhotoJson },
  });
  logger.info('[customer-inspection] damage marked fixed', { reportId });
  return { ok: true, status: 'FIXED' };
}

export const customerInspectionService = {
  sendCustomerInspection,
  sendCheckinInspection,
  checkinQrUrlForVehicle,
  startCheckinByVehicleQr,
  inspectionResolverUrlForReservation,
  startInspectionByReservationQr,
  loadByToken,
  reportDamage,
  completeInspection,
  listInspections,
  getInspection,
  reviewReport,
  getVehicleDamageHistory,
  addManualDamage,
  fixDamageReport,
};
