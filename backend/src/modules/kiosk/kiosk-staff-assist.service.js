/**
 * Ride Kiosk — Fase B3c: Staff Assist (mockups K-S1..S3).
 * Spec: doc/kiosk-e2e-spec-2026-07-04.md (B3c entry, Hector 2026-07-06).
 *
 * Guest stuck at the ID scan escalates → a staff member authenticates AT the
 * kiosk with their EXISTING lock-PIN (authService.verifyLockPin — the same
 * bcrypt hash the screen-lock uses, never reimplemented here) → manually
 * enters the ID fields + captures license FRONT and BACK photos → audited
 * bypass of the SCAN step. The RULES are never bypassed: age/expiry/DOB
 * plausibility run through the same evaluateIdRules the guest scan uses —
 * underage stays a hard stop even with staff standing at the tablet.
 *
 * Grant model: unlock stamps KioskSession.assistUserId + assistGrantedAt
 * (10-min TTL, single session). The staff verify consumes the grant
 * (assistGrantedAt → null); complete()/session wipe also clears it.
 * assistUserId persists afterwards as the audit trail. Guest-path endpoints
 * never read the grant, so a pending grant can never block the guest flow.
 *
 * Brute force: PIN misses share the per-DEVICE counter/lock with the
 * reservation lookup (registerDeviceLookupMiss — 5 misses → 15-min device
 * lock; admin pairing-code reissue clears both), plus the router's per-IP
 * public guard.
 */

import { prisma } from '../../lib/prisma.js';
import logger from '../../lib/logger.js';
import { KioskError } from './kiosk-device.service.js';
import {
  getSessionForDevice,
  recordSessionTelemetry,
  registerDeviceLookupMiss,
} from './kiosk-session.service.js';
import {
  evaluateIdRules,
  validateIdPhotoOrThrow,
  persistIdPhotos,
  parseLocationConfigSafe,
  VERIFY_FAILS_BEFORE_ESCALATE,
} from './kiosk-checkout.service.js';
import { authService } from '../auth/auth.service.js';

export const ASSIST_GRANT_TTL_MIN = 10;
// Tenant staff roles that may assist at a kiosk. SUPER_ADMIN is excluded on
// purpose (cross-tenant persona, never listed on a lobby screen); service
// accounts are machines.
export const ASSIST_ROLES = ['ADMIN', 'OPS', 'AGENT'];

function countEvents(session, name) {
  const events = Array.isArray(session?.eventsJson) ? session.eventsJson : [];
  return events.filter((e) => e?.event === name).length;
}

/**
 * Assistable-state guard (documented decision): staff assist opens when the
 * session outcome is ESCALATED (the canonical path — guest tapped Help), OR
 * when the session already carries >= VERIFY_FAILS_BEFORE_ESCALATE
 * VERIFY_ID_FAILED events (the escalateSuggested state — lets staff step in
 * without forcing the guest through the Escalate screen first). eventsJson
 * is client-appendable, so this second door exposes NOTHING sensitive by
 * itself: the list is names-only and every privileged action still requires
 * a staff PIN.
 */
function assertAssistable(session) {
  if (session.outcome === 'ESCALATED') return;
  if (session.outcome === 'IN_PROGRESS' && countEvents(session, 'VERIFY_ID_FAILED') >= VERIFY_FAILS_BEFORE_ESCALATE) return;
  // B3e: a live server-recorded name-mismatch stamp (written by verifyId
  // when NAME_MISMATCH was the ONLY failure — a column, not forgeable
  // telemetry, per the M2 discipline) also opens staff assist: the staff
  // NAME path enters from ONE mismatch failure without an escalation.
  // Deliberate scope: this opens the whole staff surface (list + unlock →
  // grant → confirm-name AND the full manual verify-id) — the full override
  // stays safe here because it runs the identical rule set and sits behind
  // the same PIN; splitting the gate would only complicate the UI flow.
  if (session.outcome === 'IN_PROGRESS' && session.nameMismatchAt) return;
  throw new KioskError('Staff assist is only available for escalated sessions', 409, 'NOT_ASSISTABLE');
}

function grantIsLive(session, now = Date.now()) {
  if (!session.assistUserId || !session.assistGrantedAt) return false;
  const grantedAt = new Date(session.assistGrantedAt).getTime();
  return now - grantedAt <= ASSIST_GRANT_TTL_MIN * 60 * 1000;
}

async function assertDeviceNotLocked(device) {
  const row = await prisma.kioskDevice.findFirst({
    where: { id: device.id, tenantId: device.tenantId },
    select: { lookupMisses: true, lookupLockedUntil: true },
  });
  if (row?.lookupLockedUntil && new Date(row.lookupLockedUntil) > new Date()) {
    throw new KioskError('Too many attempts — this kiosk is temporarily locked', 429, 'STAFF_ASSIST_LOCKED');
  }
  return row;
}

/**
 * GET /sessions/:id/staff-assist/staff — the K-S1 picker. NAMES + ids ONLY
 * (plus hasPin so the picker can grey out staff who still need to set one).
 * No emails, no roles, nothing else from the User row reaches the lobby.
 */
async function listAssistStaff(sessionId, device) {
  const session = await getSessionForDevice(sessionId, device);
  assertAssistable(session);

  const rows = await prisma.user.findMany({
    where: {
      tenantId: device.tenantId,
      isActive: true,
      isServiceAccount: false,
      role: { in: ASSIST_ROLES },
    },
    orderBy: { fullName: 'asc' },
    select: { id: true, fullName: true, lockPinHash: true },
  });
  return {
    staff: rows.map((row) => ({ id: row.id, name: row.fullName, hasPin: !!row.lockPinHash })),
  };
}

/**
 * POST /sessions/:id/staff-assist/unlock { userId, pin } — verifies against
 * the user's EXISTING lock-PIN hash via authService.verifyLockPin and mints
 * the session-bound grant. Wrong PINs feed the shared per-device lockout.
 */
async function unlock(sessionId, device, { userId, pin } = {}) {
  const session = await getSessionForDevice(sessionId, device);
  assertAssistable(session);
  await assertDeviceNotLocked(device);
  if (!userId || !pin) throw new KioskError('userId and pin are required', 400);

  const user = await prisma.user.findFirst({
    where: {
      id: String(userId),
      tenantId: device.tenantId,
      isActive: true,
      isServiceAccount: false,
      role: { in: ASSIST_ROLES },
    },
    select: { id: true, fullName: true, lockPinHash: true },
  });
  if (!user) throw new KioskError('Staff member not found', 404, 'STAFF_NOT_FOUND');
  if (!user.lockPinHash) {
    throw new KioskError('This staff member has no lock PIN set — set it in the profile first', 409, 'NO_PIN_SET');
  }

  try {
    await authService.verifyLockPin(user.id, pin, { tenantId: device.tenantId });
  } catch (err) {
    // Dispatch on the machine-readable code authService.verifyLockPin now
    // attaches to its throws (B3c review R2); the message regex remains only
    // as a fallback for any legacy throw without a code.
    const code = err?.code || null;
    if (code === 'INVALID_PIN' || (!code && /Invalid PIN/i.test(String(err?.message)))) {
      const attemptsRemaining = await registerDeviceLookupMiss(device);
      await recordSessionTelemetry(session, { step: 'ID', event: 'STAFF_ASSIST_PIN_FAILED', data: null });
      throw new KioskError('Invalid PIN', 401, 'INVALID_PIN', { attemptsRemaining });
    }
    if (code === 'NO_PIN_SET' || (!code && /PIN not set/i.test(String(err?.message)))) {
      throw new KioskError('This staff member has no lock PIN set — set it in the profile first', 409, 'NO_PIN_SET');
    }
    throw new KioskError('Staff member not found', 404, 'STAFF_NOT_FOUND');
  }

  // PIN accepted → rearm the shared device counter (same as a lookup hit).
  await prisma.kioskDevice.update({
    where: { id: device.id },
    data: { lookupMisses: 0, lookupLockedUntil: null },
  }).catch(() => {});

  const grantedAt = new Date();
  await prisma.kioskSession.update({
    where: { id: session.id },
    data: { assistUserId: user.id, assistGrantedAt: grantedAt, lastActivityAt: grantedAt },
  });
  await prisma.auditLog.create({
    data: {
      tenantId: device.tenantId,
      reservationId: session.reservationId || null,
      actorUserId: user.id,
      action: 'ADMIN_OVERRIDE',
      reason: 'Kiosk staff assist unlock',
      metadata: JSON.stringify({
        kind: 'kiosk_staff_assist_unlock',
        kioskSessionId: session.id,
        deviceId: device.id,
      }),
    },
  }).catch(() => {});
  await recordSessionTelemetry(session, { step: 'ID', event: 'STAFF_ASSIST_UNLOCKED', data: null });
  logger.info('[kiosk-staff-assist] unlocked', {
    sessionId: session.id, deviceId: device.id, tenantId: device.tenantId, staffUserId: user.id,
  });

  return {
    ok: true,
    grant: {
      userId: user.id,
      name: user.fullName,
      expiresAt: new Date(grantedAt.getTime() + ASSIST_GRANT_TTL_MIN * 60 * 1000),
    },
  };
}

/**
 * POST /sessions/:id/staff-assist/verify-id — the audited scan bypass.
 * Requires a live grant. BOTH license photos are mandatory. Runs the SAME
 * rule set as the guest scan (evaluateIdRules); the intentional difference
 * is NO name-match check — the staff member is standing in front of the
 * guest holding the physical license (a scan/OCR name mismatch is a common
 * reason assist was needed). Failing rules → same failure shape, NO
 * idVerifiedAt, session stays ESCALATED. Passing → idVerifiedAt with method
 * STAFF_OVERRIDE + assistUserId persisted, Customer write-through, AuditLog,
 * outcome flips back to IN_PROGRESS, grant consumed.
 */
async function staffVerifyId(sessionId, device, { fields, licenseFrontPhoto, licenseBackPhoto } = {}) {
  const session = await getSessionForDevice(sessionId, device);
  if (!grantIsLive(session)) {
    throw new KioskError('A staff unlock is required (or the grant expired)', 403, 'ASSIST_GRANT_REQUIRED');
  }
  if (!session.reservationId) throw new KioskError('Attach a reservation first', 422, 'NO_RESERVATION_ATTACHED');

  // BOTH photos mandatory, validated BEFORE anything is written.
  if (!licenseFrontPhoto || !licenseBackPhoto) {
    throw new KioskError('Front and back license photos are both required', 422, 'MISSING_PHOTO');
  }
  const photos = [
    { kind: 'license-front', dataUrl: licenseFrontPhoto, buffer: validateIdPhotoOrThrow(licenseFrontPhoto, 'license-front'), customerField: 'idPhotoUrl' },
    { kind: 'license-back', dataUrl: licenseBackPhoto, buffer: validateIdPhotoOrThrow(licenseBackPhoto, 'license-back'), customerField: 'licenseBackUrl' },
  ];

  const resv = await prisma.reservation.findFirst({
    where: { id: session.reservationId, tenantId: device.tenantId },
    select: {
      id: true,
      pickupAt: true,
      returnAt: true,
      pickupLocation: { select: { locationConfig: true } },
      customer: {
        select: { id: true, licenseNumber: true, licenseState: true, dateOfBirth: true, idPhotoUrl: true, licenseBackUrl: true },
      },
    },
  });
  if (!resv) throw new KioskError('Reservation not found', 404, 'RESERVATION_NOT_FOUND');

  const cleanFields = fields && typeof fields === 'object' ? fields : {};
  // Same rules as the guest scan — the override never relaxes them.
  const rules = evaluateIdRules({
    fields: cleanFields,
    pickupAt: resv.pickupAt,
    returnAt: resv.returnAt,
    locationConfig: parseLocationConfigSafe(resv.pickupLocation?.locationConfig),
  });
  const verified = rules.ageOk && rules.licenseNotExpired;

  if (!verified) {
    await recordSessionTelemetry(session, {
      step: 'ID', event: 'STAFF_ASSIST_VERIFY_FAILED', data: { reasons: rules.failureReasons },
    });
    await prisma.auditLog.create({
      data: {
        tenantId: device.tenantId,
        reservationId: resv.id,
        actorUserId: session.assistUserId,
        action: 'ADMIN_OVERRIDE',
        reason: 'Kiosk staff assist ID verify — REJECTED by rules',
        metadata: JSON.stringify({
          kind: 'kiosk_staff_assist_verify',
          kioskSessionId: session.id,
          deviceId: device.id,
          verified: false,
          failureReasons: rules.failureReasons,
        }),
      },
    }).catch(() => {});
    // No idVerifiedAt stamp; ESCALATED sessions STAY escalated.
    return {
      verified: false,
      checks: { ageOk: rules.ageOk, licenseNotExpired: rules.licenseNotExpired },
      failureReasons: rules.failureReasons,
      minimumAge: rules.minimumAge,
      maximumAge: rules.maximumAge,
    };
  }

  // Write-through like the scan path: fill EMPTY customer columns only.
  const patch = {};
  if (!resv.customer.licenseNumber && cleanFields.licenseNumber) patch.licenseNumber = String(cleanFields.licenseNumber).slice(0, 40);
  if (!resv.customer.licenseState && cleanFields.licenseState) patch.licenseState = String(cleanFields.licenseState).slice(0, 10);
  if (!resv.customer.dateOfBirth && cleanFields.dateOfBirth) {
    const dob = new Date(cleanFields.dateOfBirth);
    if (!Number.isNaN(dob.getTime())) patch.dateOfBirth = dob;
  }
  if (Object.keys(patch).length) {
    await prisma.customer.update({ where: { id: resv.customer.id }, data: patch }).catch(() => {});
  }
  await persistIdPhotos({ session, device, customer: resv.customer, photos });

  const now = new Date();
  const updated = await prisma.kioskSession.update({
    where: { id: session.id },
    data: {
      idVerifiedAt: now,
      idVerifyMethod: 'STAFF_OVERRIDE',
      // grant consumed; assistUserId stays as the audit trail
      assistGrantedAt: null,
      // R1: a verified session must not stay name-update eligible — clear
      // the mismatch marker and any outstanding possession code.
      nameMismatchAt: null,
      nameUpdateCodeHash: null,
      nameUpdateCodeExpiresAt: null,
      // an ESCALATED session goes back to work
      outcome: 'IN_PROGRESS',
      escalatedReason: null,
      endedAt: null,
      lastActivityAt: now,
    },
  });
  await prisma.auditLog.create({
    data: {
      tenantId: device.tenantId,
      reservationId: resv.id,
      actorUserId: session.assistUserId,
      action: 'ADMIN_OVERRIDE',
      reason: 'Kiosk staff assist ID verify — scan bypassed, rules passed',
      metadata: JSON.stringify({
        kind: 'kiosk_staff_assist_verify',
        kioskSessionId: session.id,
        deviceId: device.id,
        verified: true,
      }),
    },
  }).catch(() => {});
  await recordSessionTelemetry(updated, { step: 'ID', event: 'STAFF_ASSIST_VERIFY', data: null });
  logger.info('[kiosk-staff-assist] id verified via staff override', {
    sessionId: session.id, deviceId: device.id, tenantId: device.tenantId, staffUserId: session.assistUserId,
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

/**
 * POST /sessions/:id/staff-assist/confirm-name — B3e L3, the LIGHT bypass:
 * the staff member physically checked the license and vouches ONLY for the
 * name. Requires a live B3c grant (same unlock, no new auth). Re-runs the
 * FULL rule set on this session's OCR-confirmed fields and skips ONLY the
 * name check — age/expiry/DOB stay hard stops. The reservation name is NOT
 * changed (this approves the mismatch, it doesn't rewrite identity); no
 * field re-entry, no front/back re-photos — the session's OCR fields (+ the
 * license photo, persisted here if provided and not already stored) are the
 * evidence. Stamps idVerifyMethod 'STAFF_NAME_OVERRIDE', audits, un-escalates
 * and consumes the grant.
 */
async function confirmName(sessionId, device, { fields, licensePhoto } = {}) {
  const session = await getSessionForDevice(sessionId, device);
  if (!grantIsLive(session)) {
    throw new KioskError('A staff unlock is required (or the grant expired)', 403, 'ASSIST_GRANT_REQUIRED');
  }
  if (!session.reservationId) throw new KioskError('Attach a reservation first', 422, 'NO_RESERVATION_ATTACHED');

  const photoBuffer = validateIdPhotoOrThrow(licensePhoto, 'license'); // optional; 422 on junk

  const resv = await prisma.reservation.findFirst({
    where: { id: session.reservationId, tenantId: device.tenantId },
    select: {
      id: true,
      pickupAt: true,
      returnAt: true,
      pickupLocation: { select: { locationConfig: true } },
      customer: {
        select: { id: true, licenseNumber: true, licenseState: true, dateOfBirth: true, idPhotoUrl: true },
      },
    },
  });
  if (!resv) throw new KioskError('Reservation not found', 404, 'RESERVATION_NOT_FOUND');

  const cleanFields = fields && typeof fields === 'object' ? fields : {};
  const rules = evaluateIdRules({
    fields: cleanFields,
    pickupAt: resv.pickupAt,
    returnAt: resv.returnAt,
    locationConfig: parseLocationConfigSafe(resv.pickupLocation?.locationConfig),
  });
  if (!(rules.ageOk && rules.licenseNotExpired)) {
    await recordSessionTelemetry(session, {
      step: 'ID', event: 'STAFF_ASSIST_NAME_REJECTED', data: { reasons: rules.failureReasons },
    });
    return {
      verified: false,
      checks: { ageOk: rules.ageOk, licenseNotExpired: rules.licenseNotExpired },
      failureReasons: rules.failureReasons,
      minimumAge: rules.minimumAge,
      maximumAge: rules.maximumAge,
    };
  }

  if (photoBuffer) {
    await persistIdPhotos({
      session,
      device,
      customer: resv.customer,
      photos: [{ kind: 'license', dataUrl: licensePhoto, buffer: photoBuffer, customerField: 'idPhotoUrl' }],
    });
  }

  const now = new Date();
  const updated = await prisma.kioskSession.update({
    where: { id: session.id },
    data: {
      idVerifiedAt: now,
      idVerifyMethod: 'STAFF_NAME_OVERRIDE',
      nameMismatchAt: null,
      // R1 hygiene: any outstanding possession code dies with the approval.
      nameUpdateCodeHash: null,
      nameUpdateCodeExpiresAt: null,
      assistGrantedAt: null, // grant consumed; assistUserId stays for audit
      outcome: 'IN_PROGRESS',
      escalatedReason: null,
      endedAt: null,
      lastActivityAt: now,
    },
  });
  await prisma.auditLog.create({
    data: {
      tenantId: device.tenantId,
      reservationId: resv.id,
      actorUserId: session.assistUserId,
      action: 'ADMIN_OVERRIDE',
      reason: 'Kiosk staff assist — name mismatch approved (license physically checked)',
      metadata: JSON.stringify({
        kind: 'kiosk_staff_confirm_name',
        kioskSessionId: session.id,
        deviceId: device.id,
        verified: true,
        nameChanged: false, // approval only — the reservation name stays
      }),
    },
  }).catch(() => {});
  await recordSessionTelemetry(updated, { step: 'ID', event: 'STAFF_ASSIST_NAME_CONFIRMED', data: null });
  logger.info('[kiosk-staff-assist] name mismatch approved by staff', {
    sessionId: session.id, deviceId: device.id, tenantId: device.tenantId, staffUserId: session.assistUserId,
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

export const kioskStaffAssistService = {
  listAssistStaff,
  unlock,
  staffVerifyId,
  confirmName,
};
