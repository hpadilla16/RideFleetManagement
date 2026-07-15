/**
 * Ride Kiosk — Fase B3e L2: self-service verified-name update.
 * Spec: doc/kiosk-e2e-spec-2026-07-04.md (B3e — Hector's real FL case).
 *
 * Flow: verify-id failed with NAME_MISMATCH as the ONLY blocker (server
 * marker KioskSession.nameMismatchAt — set by verifyId, never trusted from
 * eventsJson) → 6-digit possession code to the RESERVATION's email (+ SMS
 * best-effort when the tenant has the SMS channel configured), hashed at
 * rest, 10-min TTL, single-use → a correct code proves control of the
 * booking → the driver name is updated to the LICENSE-VERIFIED name (the
 * confirmed OCR fields, never free text) → full rule set re-runs and
 * idVerifiedAt is stamped with method 'SCAN_NAME_UPDATED' + AuditLog with
 * the old name preserved.
 *
 * CUSTOMER-MUTATION SAFETY (the design point Innovation scrutinizes): the
 * Customer row is SHARED identity — reservations point at it and other
 * bookings/agreements may too. Convention here:
 *   • customer has NO other reservations → update firstName/lastName in
 *     place (single-use row, same net effect as counter staff editing the
 *     customer record);
 *   • customer HAS other reservations → NEVER mutate shared history: clone
 *     the customer (contact + identity columns) with the verified name and
 *     relink ONLY this reservation to the clone. The original row and every
 *     other booking keep the old name.
 *
 * Wrong codes feed the SHARED per-device lockout (same counter as lookup +
 * staff-assist PIN; 5 misses → 15 min; admin pairing-code reissue clears).
 */

import crypto from 'node:crypto';
import { prisma } from '../../lib/prisma.js';
import logger from '../../lib/logger.js';
import { KioskError, sha256Hex } from './kiosk-device.service.js';
import {
  getSessionForDevice,
  requireInProgress,
  recordSessionTelemetry,
  registerDeviceLookupMiss,
} from './kiosk-session.service.js';
import {
  evaluateIdRules,
  validateIdPhotoOrThrow,
  persistIdPhotos,
  parseLocationConfigSafe,
} from './kiosk-checkout.service.js';
import { sendEmail } from '../../lib/mailer.js';
import { renderBrandedEmail, resolveEmailBrand } from '../../lib/email-template.js';
import { smsService } from '../sms/sms.service.js';

export const NAME_UPDATE_CODE_TTL_MIN = 10;
// B3e review M1: sendCode must never be an email/SMS cannon. Two brakes on
// top of the per-IP router guard:
//   • per-DEVICE in-memory hourly bucket (same pattern as the B3d extract
//     buckets) — a device-token holder can burn at most this many sends/hr;
//   • server-side cooldown — no resend while the outstanding code is younger
//     than NAME_UPDATE_RESEND_COOLDOWN_SEC (derived from the stored expiry,
//     no new column).
export const MAX_NAME_UPDATE_SENDS_PER_DEVICE_PER_HOUR = 6;
export const NAME_UPDATE_RESEND_COOLDOWN_SEC = 60;
const SEND_BUCKET_WINDOW_MS = 60 * 60 * 1000;

const sendBuckets = new Map();

function pruneSendBuckets(nowMs) {
  for (const [key, bucket] of sendBuckets.entries()) {
    if (!bucket || bucket.expiresAt <= nowMs) sendBuckets.delete(key);
  }
}

function deviceSendCount(deviceId, nowMs) {
  pruneSendBuckets(nowMs);
  const bucket = sendBuckets.get(deviceId);
  return bucket && bucket.expiresAt > nowMs ? bucket.count : 0;
}

function registerDeviceSend(deviceId, nowMs) {
  const bucket = sendBuckets.get(deviceId);
  if (bucket && bucket.expiresAt > nowMs) bucket.count += 1;
  else sendBuckets.set(deviceId, { count: 1, expiresAt: nowMs + SEND_BUCKET_WINDOW_MS });
}

/** Test hook — clears the in-memory per-device send buckets. */
export function resetNameUpdateSendTracking() {
  sendBuckets.clear();
}

function newCode() {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
}

export function maskEmail(email) {
  const raw = String(email || '').trim();
  const at = raw.indexOf('@');
  if (at <= 0) return null;
  return `${raw[0]}•••@${raw.slice(at + 1)}`;
}

export function maskPhone(phone) {
  const digits = String(phone || '').replace(/\D+/g, '');
  if (digits.length < 4) return null;
  return `•••${digits.slice(-4)}`;
}

async function assertDeviceNotLocked(device) {
  const row = await prisma.kioskDevice.findFirst({
    where: { id: device.id, tenantId: device.tenantId },
    select: { lookupLockedUntil: true },
  });
  if (row?.lookupLockedUntil && new Date(row.lookupLockedUntil) > new Date()) {
    throw new KioskError('Too many attempts — this kiosk is temporarily locked', 429, 'NAME_UPDATE_LOCKED');
  }
}

function loadEligibleSession(session) {
  if (!session.reservationId) throw new KioskError('Attach a reservation first', 422, 'NO_RESERVATION_ATTACHED');
  // Server-recorded marker only (M2 lesson): a forged eventsJson can never
  // open this door. R1: an already-verified session is never send-code
  // eligible — the flow is done, idVerifyMethod must not be overwritable.
  if (!session.nameMismatchAt || session.idVerifiedAt) {
    throw new KioskError(
      'Name update is only available after an ID check failed on the name alone',
      409,
      'NAME_UPDATE_NOT_ELIGIBLE',
    );
  }
}

/**
 * GET /sessions/:id/name-update/destinations — READ-ONLY preview of where
 * the possession code would go (the "someone booked it for me" bail-out
 * screen shows this BEFORE the guest burns a send). Same nameMismatchAt gate
 * as send-code; masked destinations ONLY; no send, no code mint, nothing
 * written. NOTE: `sms` here means "a phone is on file" — actual SMS delivery
 * stays best-effort/tenant-config dependent, and the send-code response
 * remains authoritative for what was really sent.
 */
async function destinations(sessionId, device) {
  const session = await getSessionForDevice(sessionId, device);
  requireInProgress(session);
  loadEligibleSession(session);

  const resv = await prisma.reservation.findFirst({
    where: { id: session.reservationId, tenantId: device.tenantId },
    select: { customer: { select: { email: true, phone: true } } },
  });
  if (!resv) throw new KioskError('Reservation not found', 404, 'RESERVATION_NOT_FOUND');

  return {
    email: maskEmail(resv.customer?.email),
    sms: maskPhone(resv.customer?.phone),
  };
}

/**
 * POST /sessions/:id/name-update/send-code — mails (and best-effort texts)
 * the possession code. Response carries ONLY masked destinations.
 */
async function sendCode(sessionId, device) {
  const session = await getSessionForDevice(sessionId, device);
  requireInProgress(session);
  loadEligibleSession(session);
  await assertDeviceNotLocked(device);

  // M1(b): server-side resend cooldown — the outstanding code must be at
  // least NAME_UPDATE_RESEND_COOLDOWN_SEC old (derived from its expiry; the
  // client's 30s timer is UX, this is the enforcement).
  const nowMs = Date.now();
  if (session.nameUpdateCodeExpiresAt) {
    const remainingMs = new Date(session.nameUpdateCodeExpiresAt).getTime() - nowMs;
    const freshThresholdMs = NAME_UPDATE_CODE_TTL_MIN * 60 * 1000 - NAME_UPDATE_RESEND_COOLDOWN_SEC * 1000;
    if (remainingMs > freshThresholdMs) {
      const retryInSeconds = Math.ceil((remainingMs - freshThresholdMs) / 1000);
      throw new KioskError('A code was just sent — wait before resending', 429, 'NAME_UPDATE_COOLDOWN', { retryInSeconds });
    }
  }
  // M1(a): per-device hourly send budget (email + tenant-paid SMS cannon guard).
  if (deviceSendCount(device.id, nowMs) >= MAX_NAME_UPDATE_SENDS_PER_DEVICE_PER_HOUR) {
    throw new KioskError('Too many codes sent from this kiosk — please see a staff member', 429, 'NAME_UPDATE_LOCKED');
  }

  const resv = await prisma.reservation.findFirst({
    where: { id: session.reservationId, tenantId: device.tenantId },
    select: {
      id: true,
      reservationNumber: true,
      customer: { select: { firstName: true, email: true, phone: true } },
    },
  });
  const emailTo = String(resv?.customer?.email || '').trim();
  if (!resv || !emailTo) {
    throw new KioskError('The reservation has no email on file — please see a staff member', 422, 'NO_CUSTOMER_EMAIL');
  }

  // Burn the send slot before dispatching — failures count too.
  registerDeviceSend(device.id, nowMs);

  const code = newCode();
  const expiresAt = new Date(Date.now() + NAME_UPDATE_CODE_TTL_MIN * 60 * 1000);
  await prisma.kioskSession.update({
    where: { id: session.id },
    data: {
      nameUpdateCodeHash: sha256Hex(code),
      nameUpdateCodeExpiresAt: expiresAt,
      lastActivityAt: new Date(),
    },
  });

  let brand;
  try { brand = await resolveEmailBrand({ tenantId: device.tenantId }); } catch { brand = undefined; }
  const text = `Hi ${resv.customer?.firstName || 'there'},\n\nYour kiosk verification code is: ${code}\n\nIt expires in ${NAME_UPDATE_CODE_TTL_MIN} minutes. Enter it on the kiosk to confirm this reservation is yours and update the driver name to match your license.\n\nIf you are not at the kiosk right now, ignore this message.\n`;
  const rendered = renderBrandedEmail({
    brand,
    heading: 'Your kiosk verification code',
    bodyHtml: `<p>Your kiosk verification code is:</p><p style="font-size:28px;font-weight:700;letter-spacing:6px">${code}</p><p style="font-size:12px;color:#666">It expires in ${NAME_UPDATE_CODE_TTL_MIN} minutes. If you are not at the kiosk right now, ignore this message.</p>`,
    bodyText: text,
    preheader: 'Kiosk verification code',
  });
  await sendEmail({
    to: emailTo,
    subject: `Your verification code${resv.reservationNumber ? ` — reservation #${resv.reservationNumber}` : ''}`,
    text: rendered.text,
    html: rendered.html,
  });

  // SMS is best-effort — only tenants with the SMS channel configured.
  let smsMasked = null;
  const phone = String(resv.customer?.phone || '').trim();
  if (phone) {
    try {
      await smsService.sendCustom({
        to: phone,
        body: `Ride kiosk verification code: ${code} (expires in ${NAME_UPDATE_CODE_TTL_MIN} min)`,
        tenantId: device.tenantId,
      });
      smsMasked = maskPhone(phone);
    } catch {
      smsMasked = null; // tenant has no SMS channel — email carries it
    }
  }

  await recordSessionTelemetry(session, { step: 'ID', event: 'NAME_UPDATE_CODE_SENT', data: { sms: !!smsMasked } });
  logger.info('[kiosk-name-update] code sent', {
    sessionId: session.id, deviceId: device.id, tenantId: device.tenantId, sms: !!smsMasked,
  });

  return {
    ok: true,
    sent: { email: maskEmail(emailTo), sms: smsMasked },
    expiresInMinutes: NAME_UPDATE_CODE_TTL_MIN,
  };
}

async function resolveCustomerForRename({ resv, device, fields }) {
  const newFirst = String(fields.firstName || '').trim().slice(0, 80);
  const newLast = String(fields.lastName || '').trim().slice(0, 80);
  if (!newFirst || !newLast) {
    throw new KioskError('firstName and lastName from the verified license are required', 422, 'NAME_REQUIRED');
  }

  const otherReservations = await prisma.reservation.count({
    where: { customerId: resv.customer.id, id: { not: resv.id } },
  });

  if (otherReservations === 0) {
    // Single-use customer row → in-place rename (counter-edit equivalent).
    const updated = await prisma.customer.update({
      where: { id: resv.customer.id },
      data: { firstName: newFirst, lastName: newLast },
    });
    return { customer: updated, relinked: false };
  }

  // Shared identity → clone-and-relink; other bookings keep the old name.
  const clone = await prisma.customer.create({
    data: {
      tenantId: device.tenantId,
      firstName: newFirst,
      lastName: newLast,
      email: resv.customer.email || null,
      phone: resv.customer.phone || '',
      address1: resv.customer.address1 || null,
      address2: resv.customer.address2 || null,
      city: resv.customer.city || null,
      state: resv.customer.state || null,
      zip: resv.customer.zip || null,
      country: resv.customer.country || null,
      locale: resv.customer.locale || null,
      notes: `Created by kiosk name update from customer ${resv.customer.id} (reservation ${resv.reservationNumber || resv.id})`,
    },
  });
  await prisma.reservation.update({ where: { id: resv.id }, data: { customerId: clone.id } });
  return { customer: clone, relinked: true };
}

/**
 * POST /sessions/:id/name-update/confirm { code, fields, licensePhoto } —
 * verifies the possession code, re-runs the FULL rule set on the confirmed
 * OCR fields, renames the driver to the license-verified name and stamps
 * idVerifiedAt with method 'SCAN_NAME_UPDATED'.
 *
 * Ordering (B3e review R2): input validation (photo REQUIRED — R3: this is
 * the only verify path that could otherwise complete with zero license
 * evidence) and the reservation fetch happen BEFORE the code is consumed —
 * a 404/422 must never burn a valid code. Consumption still happens BEFORE
 * the rules run: single-use even when the rules then reject.
 */
async function confirm(sessionId, device, { code, fields, licensePhoto } = {}) {
  const session = await getSessionForDevice(sessionId, device);
  requireInProgress(session);
  loadEligibleSession(session);
  await assertDeviceNotLocked(device);

  const cleanCode = String(code || '').trim();
  if (!session.nameUpdateCodeHash || !session.nameUpdateCodeExpiresAt) {
    throw new KioskError('Request a verification code first', 409, 'CODE_NOT_SENT');
  }
  if (new Date(session.nameUpdateCodeExpiresAt) <= new Date()) {
    throw new KioskError('The verification code expired — request a new one', 410, 'CODE_EXPIRED');
  }
  if (!/^\d{6}$/.test(cleanCode) || sha256Hex(cleanCode) !== session.nameUpdateCodeHash) {
    const attemptsRemaining = await registerDeviceLookupMiss(device);
    await recordSessionTelemetry(session, { step: 'ID', event: 'NAME_UPDATE_CODE_FAILED', data: null });
    throw new KioskError('Invalid verification code', 401, 'INVALID_CODE', { attemptsRemaining });
  }

  // R3: the license photo is the evidence of record for this verify path.
  const cleanFields = fields && typeof fields === 'object' ? fields : {};
  if (!licensePhoto) throw new KioskError('The license photo is required', 422, 'MISSING_PHOTO');
  const photoBuffer = validateIdPhotoOrThrow(licensePhoto, 'license'); // 422 on junk — code NOT consumed

  const resv = await prisma.reservation.findFirst({
    where: { id: session.reservationId, tenantId: device.tenantId },
    select: {
      id: true,
      reservationNumber: true,
      pickupAt: true,
      returnAt: true,
      pickupLocation: { select: { locationConfig: true } },
      customer: {
        select: {
          id: true, firstName: true, lastName: true, email: true, phone: true,
          address1: true, address2: true, city: true, state: true, zip: true, country: true, locale: true,
          licenseNumber: true, licenseState: true, dateOfBirth: true, idPhotoUrl: true,
        },
      },
    },
  });
  if (!resv) throw new KioskError('Reservation not found', 404, 'RESERVATION_NOT_FOUND');

  // Single-use (R2 position): consume the code AFTER the fetch (a 404 above
  // never burns it) but BEFORE the rules — rule failures don't refund it.
  await prisma.kioskSession.update({
    where: { id: session.id },
    data: { nameUpdateCodeHash: null, nameUpdateCodeExpiresAt: null, lastActivityAt: new Date() },
  });
  // Code accepted → rearm the shared device counter (same as a lookup hit).
  await prisma.kioskDevice.update({
    where: { id: device.id },
    data: { lookupMisses: 0, lookupLockedUntil: null },
  }).catch(() => {});

  // FULL rule set on the confirmed fields — possession of the booking never
  // relaxes age/expiry/DOB (underage stays a hard stop).
  const rules = evaluateIdRules({
    fields: cleanFields,
    pickupAt: resv.pickupAt,
    returnAt: resv.returnAt,
    locationConfig: parseLocationConfigSafe(resv.pickupLocation?.locationConfig),
  });
  if (!(rules.ageOk && rules.licenseNotExpired)) {
    await recordSessionTelemetry(session, {
      step: 'ID', event: 'NAME_UPDATE_REJECTED', data: { reasons: rules.failureReasons },
    });
    return {
      verified: false,
      checks: { ageOk: rules.ageOk, licenseNotExpired: rules.licenseNotExpired },
      failureReasons: rules.failureReasons,
      minimumAge: rules.minimumAge,
      maximumAge: rules.maximumAge,
    };
  }

  const oldName = `${resv.customer.firstName || ''} ${resv.customer.lastName || ''}`.trim();
  const { customer, relinked } = await resolveCustomerForRename({ resv, device, fields: cleanFields });
  const newName = `${customer.firstName} ${customer.lastName}`.trim();

  // License write-through (empty columns only) + photo, onto the (possibly
  // cloned) customer.
  const patch = {};
  if (!customer.licenseNumber && cleanFields.licenseNumber) patch.licenseNumber = String(cleanFields.licenseNumber).slice(0, 40);
  if (!customer.licenseState && cleanFields.licenseState) patch.licenseState = String(cleanFields.licenseState).slice(0, 10);
  if (!customer.dateOfBirth && cleanFields.dateOfBirth) {
    const dob = new Date(cleanFields.dateOfBirth);
    if (!Number.isNaN(dob.getTime())) patch.dateOfBirth = dob;
  }
  if (Object.keys(patch).length) {
    await prisma.customer.update({ where: { id: customer.id }, data: patch }).catch(() => {});
  }
  if (photoBuffer) {
    await persistIdPhotos({
      session,
      device,
      customer,
      photos: [{ kind: 'license', dataUrl: licensePhoto, buffer: photoBuffer, customerField: 'idPhotoUrl' }],
    });
  }

  const now = new Date();
  const updated = await prisma.kioskSession.update({
    where: { id: session.id },
    data: {
      idVerifiedAt: now,
      idVerifyMethod: 'SCAN_NAME_UPDATED',
      nameMismatchAt: null,
      lastActivityAt: now,
    },
  });
  await prisma.auditLog.create({
    data: {
      tenantId: device.tenantId,
      reservationId: resv.id,
      actorUserId: null,
      action: 'UPDATE',
      reason: 'Kiosk self-service name update (booking possession code verified)',
      metadata: JSON.stringify({
        kind: 'KIOSK_NAME_UPDATE',
        kioskSessionId: session.id,
        deviceId: device.id,
        oldName,
        newName,
        relinked,
        customerId: customer.id,
      }),
    },
  }).catch(() => {});
  await recordSessionTelemetry(updated, { step: 'ID', event: 'NAME_UPDATE_CONFIRMED', data: { relinked } });
  logger.info('[kiosk-name-update] driver name updated', {
    sessionId: session.id, deviceId: device.id, tenantId: device.tenantId,
    reservationId: resv.id, relinked,
  });

  return {
    verified: true,
    checks: { ageOk: true, licenseNotExpired: true },
    failureReasons: [],
    minimumAge: rules.minimumAge,
    maximumAge: rules.maximumAge,
    session: { id: updated.id, outcome: updated.outcome, idVerifyMethod: updated.idVerifyMethod },
  };
}

export const kioskNameUpdateService = {
  destinations,
  sendCode,
  confirm,
};
