/**
 * Ride Kiosk — Fase B3a: ID verify + T&C sign + sandbox payment + complete.
 * Spec: doc/kiosk-e2e-spec-2026-07-04.md (API contract + "Integración con la
 * state machine" section).
 *
 * Everything here DRIVES THE REAL checkout-session state machine
 * (checkoutSessionService.transition / stampSideEffect /
 * saveCustomerSignature) — the kiosk never grows a second state machine.
 * T&C = per-section initials rendered at the kiosk (Hector decision #6,
 * NO pre-stamp). The CLOSED transition's existing cascade (anti-beta.152)
 * does FINALIZED + CHECKED_OUT + vehicle sync + recordMileageEntrySafe +
 * the contract auto-email; the kiosk's job is to stamp odometer/fuel on the
 * agreement BEFORE closing so that cascade never records "-" metrics.
 *
 * AUTHORIZATION NOTE (B3a review M2): /sign gates on the SERVER-recorded
 * KioskSession.idVerifiedAt column — never on eventsJson, which is
 * client-fed telemetry and therefore forgeable.
 *
 * MONEY: there is NO real payment code here. sandboxPayment is a demo-only
 * stamp behind KIOSK_PAYMENT_SANDBOX (fail-closed in production) and is
 * replaced wholesale by Fase B5's payment-link + server-side verification.
 */

import { prisma } from '../../lib/prisma.js';
import logger from '../../lib/logger.js';
import { KioskError } from './kiosk-device.service.js';
import { getSessionForDevice, requireInProgress, recordSessionTelemetry, maskCustomerName } from './kiosk-session.service.js';
import { checkoutSessionService, CheckoutSessionError } from '../checkout-session/checkout-session.service.js';
import { sectionsForAgreement } from '../checkout-session/terms-content.js';
import { CHECKOUT_STEPS, isTerminal } from '../checkout-session/state-machine.js';
import { looksLikeImage, MAX_PHOTO_BYTES, isStorageEnabled } from '../rental-agreements/inspection-photos.js';
import { uploadObject, safePath } from '../../lib/storage/supabase-storage.js';
import { customerInspectionService } from '../customer-inspection/customer-inspection.service.js';
import { scopedSettingKey } from '../../lib/module-access.js';

// Default minimum rental age when the pickup location's config doesn't set
// chargeAgeMin (same source the counter finalize uses). Config hook via env.
export const KIOSK_DEFAULT_MIN_RENTAL_AGE = Number(process.env.KIOSK_MIN_RENTAL_AGE || 21);
export const VERIFY_FAILS_BEFORE_ESCALATE = 2;
export const KEY_HANDOFF_MODES = ['LOCKBOX', 'STAFF'];
// Ages beyond this are a garbage DOB (scan glitch / year-0959 imports), not
// a very old renter — mirrors the isImplausibleAge guard in the counter
// finalize (rental-agreements.service.js).
const IMPLAUSIBLE_AGE = 110;

const PHOTOS_BUCKET = process.env.SUPABASE_STORAGE_INVENTORY_BUCKET || 'inventory-photos';

// ── verify-id helpers (pure, exported for tests) ────────────────────────────

export function normalizeNamePart(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // strip accents
    .toLowerCase()
    .replace(/[^a-z\s-]/g, ' ')
    .replace(/[\s-]+/g, ' ')
    .trim();
}

/**
 * Tolerant person-name match: case/accents-insensitive; middle names and
 * compound last names tolerated (token containment both ways on the LAST
 * name). First name matches on first token, or when the SCANNED first token
 * (>= 3 chars) is a prefix of the stored one — a license "WILL" matches a
 * stored "William", but a stored "Jose" never accepts a scanned "Josefina"
 * (scanned→stored direction ONLY; B3a review S2).
 */
export function namesMatch({ scannedFirst, scannedLast, storedFirst, storedLast }) {
  const sf = normalizeNamePart(scannedFirst);
  const sl = normalizeNamePart(scannedLast);
  const cf = normalizeNamePart(storedFirst);
  const cl = normalizeNamePart(storedLast);
  if (!sf || !sl || !cf || !cl) return false;

  const lastOk = sl === cl
    || sl.split(' ').includes(cl)
    || cl.split(' ').includes(sl)
    || sl.replace(/\s/g, '') === cl.replace(/\s/g, '');
  if (!lastOk) return false;

  const sfTok = sf.split(' ')[0];
  const cfTok = cf.split(' ')[0];
  return sfTok === cfTok
    || (sfTok.length >= 3 && cfTok.startsWith(sfTok));
}

export function ageOnDate(dob, onDate) {
  const birth = dob ? new Date(dob) : null;
  const ref = onDate ? new Date(onDate) : null;
  if (!birth || !ref || Number.isNaN(birth.getTime()) || Number.isNaN(ref.getTime())) return null;
  let age = ref.getFullYear() - birth.getFullYear();
  const m = ref.getMonth() - birth.getMonth();
  if (m < 0 || (m === 0 && ref.getDate() < birth.getDate())) age -= 1;
  return age;
}

function parseLocationConfigSafe(raw) {
  if (!raw) return {};
  try {
    return typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    return {};
  }
}

function countEvents(session, name) {
  const events = Array.isArray(session?.eventsJson) ? session.eventsJson : [];
  return events.filter((e) => e?.event === name).length;
}

function dataUrlToBuffer(dataUrl) {
  const raw = String(dataUrl || '');
  const base64 = raw.includes(',') ? raw.slice(raw.indexOf(',') + 1) : raw;
  try {
    return Buffer.from(base64, 'base64');
  } catch {
    return null;
  }
}

export function sniffImageContentType(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4) return null;
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer[0] === 0x89 && buffer[1] === 0x50) return 'image/png';
  if (buffer.subarray(0, 4).toString('ascii') === 'RIFF') return 'image/webp';
  if (buffer.subarray(0, 3).toString('ascii') === 'GIF') return 'image/gif';
  if (buffer.length >= 12 && buffer.subarray(4, 8).toString('ascii') === 'ftyp') return 'image/heic';
  return 'image/jpeg'; // looksLikeImage already accepted it (e.g. BMP) — safe default
}

const CONTENT_TYPE_EXT = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'image/heic': 'heic',
};

/**
 * B3a review M4: BOTH photo paths (storage + base64 fallback) validate the
 * payload before anything is written — parity with the storage-path guards.
 * Returns the decoded buffer, throws 422 INVALID_PHOTO on junk/oversized.
 */
function validateIdPhotoOrThrow(dataUrl, kind) {
  if (!dataUrl) return null;
  const buffer = dataUrlToBuffer(dataUrl);
  if (!buffer || !looksLikeImage(buffer) || buffer.length > MAX_PHOTO_BYTES) {
    throw new KioskError(`${kind} photo must be a valid image under ${Math.round(MAX_PHOTO_BYTES / (1024 * 1024))}MB`, 422, 'INVALID_PHOTO');
  }
  return buffer;
}

/**
 * ID photos → Supabase Storage (inspection-photos pattern: flag-gated,
 * base64 fallback). Buffers arrive PRE-VALIDATED (validateIdPhotoOrThrow).
 * RETENTION NOTE: license + selfie are retained ONLY as identity-verification
 * evidence for this rental; the kiosk UI shows the disclosure (B3b) and
 * face-match is explicitly v2 per the spec. A retention sweep/expiry policy
 * rides with the B5+ compliance pass — until then these live alongside the
 * agreement's inspection photos in the same bucket.
 * Best-effort by design: photo persistence must never fail the verify.
 */
async function persistIdPhotos({ session, device, customer, photos }) {
  try {
    const provided = photos.filter((p) => p.dataUrl && p.buffer);
    if (!provided.length) return;

    if (!isStorageEnabled()) {
      // base64 fallback (legacy in-DB pattern): the VALIDATED license goes to
      // the customer's idPhotoUrl slot only when empty (counter/precheckin
      // wins). The selfie has no legacy column — skipped in fallback mode.
      const license = provided.find((p) => p.kind === 'license');
      if (license && customer && !customer.idPhotoUrl) {
        await prisma.customer.update({ where: { id: customer.id }, data: { idPhotoUrl: String(license.dataUrl) } }).catch(() => {});
      }
      logger.warn('[kiosk-checkout] photo storage disabled — license kept as base64 fallback, selfie not persisted', {
        sessionId: session.id, tenantId: device.tenantId,
      });
      await recordSessionTelemetry(session, {
        step: 'ID', event: 'ID_PHOTOS_STORED', data: { storage: false, kinds: provided.map((p) => p.kind) },
      });
      return;
    }

    const refs = [];
    for (const photo of provided) {
      const contentType = sniffImageContentType(photo.buffer) || 'image/jpeg';
      const ext = CONTENT_TYPE_EXT[contentType] || 'jpg';
      const path = safePath('kiosk-id', session.id, `${photo.kind}.${ext}`);
      await uploadObject({ bucket: PHOTOS_BUCKET, path, body: photo.buffer, contentType, upsert: true });
      refs.push({ kind: photo.kind, bucket: PHOTOS_BUCKET, path });
    }
    if (refs.length) {
      const licenseRef = refs.find((r) => r.kind === 'license');
      if (licenseRef && customer && !customer.idPhotoUrl) {
        // "bucket:path" convention (same as registration documents).
        await prisma.customer.update({
          where: { id: customer.id },
          data: { idPhotoUrl: `${licenseRef.bucket}:${licenseRef.path}` },
        }).catch(() => {});
      }
      await recordSessionTelemetry(session, {
        step: 'ID', event: 'ID_PHOTOS_STORED', data: { storage: true, refs },
      });
    }
  } catch (err) {
    logger.warn('[kiosk-checkout] id photo persistence failed (non-fatal)', {
      sessionId: session.id, message: err?.message,
    });
  }
}

/**
 * POST /sessions/:id/verify-id — match the scanned AAMVA fields against the
 * attached reservation's customer. Response carries BOOLEANS + reason codes
 * ONLY — the stored DOB/license/full name are never echoed to a lobby
 * screen. On pass: stamps KioskSession.idVerifiedAt (the /sign gate) and
 * writes the scan through to the Customer record the way the counter/
 * pre-checkin flows do (only filling empty columns).
 */
async function verifyId(sessionId, device, { aamvaFields, licensePhoto, selfiePhoto } = {}) {
  const session = await getSessionForDevice(sessionId, device);
  requireInProgress(session);
  if (!session.reservationId) throw new KioskError('Attach a reservation first', 422, 'NO_RESERVATION_ATTACHED');

  // M4: reject junk/oversized photos up front — nothing is written on 422.
  const photos = [
    { kind: 'license', dataUrl: licensePhoto, buffer: validateIdPhotoOrThrow(licensePhoto, 'license') },
    { kind: 'selfie', dataUrl: selfiePhoto, buffer: validateIdPhotoOrThrow(selfiePhoto, 'selfie') },
  ];

  const resv = await prisma.reservation.findFirst({
    where: { id: session.reservationId, tenantId: device.tenantId },
    select: {
      id: true,
      pickupAt: true,
      returnAt: true,
      pickupLocation: { select: { locationConfig: true } },
      customer: {
        select: { id: true, firstName: true, lastName: true, licenseNumber: true, licenseState: true, dateOfBirth: true, idPhotoUrl: true },
      },
    },
  });
  if (!resv) throw new KioskError('Reservation not found', 404, 'RESERVATION_NOT_FOUND');

  const fields = aamvaFields && typeof aamvaFields === 'object' ? aamvaFields : {};
  const failureReasons = [];

  // 1) Name — scanned license vs the reservation's customer.
  const nameMatches = namesMatch({
    scannedFirst: fields.firstName,
    scannedLast: fields.lastName,
    storedFirst: resv.customer?.firstName,
    storedLast: resv.customer?.lastName,
  });
  if (!nameMatches) failureReasons.push('NAME_MISMATCH');

  // 2) Age — same config source as the counter finalize (location
  // chargeAgeMin/chargeAgeMax), defaulting to KIOSK_DEFAULT_MIN_RENTAL_AGE.
  const locationConfig = parseLocationConfigSafe(resv.pickupLocation?.locationConfig);
  const minimumAge = Number(locationConfig?.chargeAgeMin || 0) > 0
    ? Number(locationConfig.chargeAgeMin)
    : KIOSK_DEFAULT_MIN_RENTAL_AGE;
  const maximumAge = Number(locationConfig?.chargeAgeMax || 0) > 0
    ? Number(locationConfig.chargeAgeMax)
    : null;
  const age = ageOnDate(fields.dateOfBirth, resv.pickupAt);
  let ageOk = false;
  if (age === null) {
    failureReasons.push('DOB_UNREADABLE');
  } else if (age < 0 || age > IMPLAUSIBLE_AGE) {
    failureReasons.push('DOB_IMPLAUSIBLE');
  } else if (age < minimumAge) {
    failureReasons.push('UNDERAGE');
  } else if (maximumAge && age > maximumAge) {
    failureReasons.push('AGE_ABOVE_MAX');
  } else {
    ageOk = true;
  }

  // 3) License must not expire before the scheduled return.
  const expiry = fields.licenseExpiry ? new Date(fields.licenseExpiry) : null;
  let licenseNotExpired = false;
  if (!expiry || Number.isNaN(expiry.getTime())) {
    failureReasons.push('LICENSE_EXPIRY_UNREADABLE');
  } else if (expiry <= new Date(resv.returnAt)) {
    failureReasons.push('LICENSE_EXPIRES_BEFORE_RETURN');
  } else {
    licenseNotExpired = true;
  }

  const verified = nameMatches && ageOk && licenseNotExpired;
  // Count PRIOR failures before recording this one (the telemetry write
  // below mutates the session's event list).
  const priorFails = countEvents(session, 'VERIFY_ID_FAILED');

  if (verified) {
    // M2: the SERVER-side stamp /sign gates on (eventsJson is forgeable).
    await prisma.kioskSession.update({
      where: { id: session.id },
      data: { idVerifiedAt: new Date(), lastActivityAt: new Date() },
    });
    // Write-through like the counter flows: fill EMPTY customer columns from
    // the scan, never clobber staff-entered data.
    const patch = {};
    if (!resv.customer.licenseNumber && fields.licenseNumber) patch.licenseNumber = String(fields.licenseNumber).slice(0, 40);
    if (!resv.customer.licenseState && fields.licenseState) patch.licenseState = String(fields.licenseState).slice(0, 10);
    if (!resv.customer.dateOfBirth && fields.dateOfBirth) {
      const dob = new Date(fields.dateOfBirth);
      if (!Number.isNaN(dob.getTime())) patch.dateOfBirth = dob;
    }
    if (Object.keys(patch).length) {
      await prisma.customer.update({ where: { id: resv.customer.id }, data: patch }).catch(() => {});
    }
    await persistIdPhotos({ session, device, customer: resv.customer, photos });
    await recordSessionTelemetry(session, { step: 'ID', event: 'VERIFY_ID_PASSED', data: null });
  } else {
    await recordSessionTelemetry(session, { step: 'ID', event: 'VERIFY_ID_FAILED', data: { reasons: failureReasons } });
  }

  const failedCount = priorFails + (verified ? 0 : 1);
  return {
    verified,
    checks: { nameMatches, ageOk, licenseNotExpired },
    failureReasons,
    minimumAge,
    maximumAge,
    escalateSuggested: !verified && failedCount >= VERIFY_FAILS_BEFORE_ESCALATE,
  };
}

// ── T&C + sign ───────────────────────────────────────────────────────────────

async function loadCheckoutSessionFor(session, device) {
  if (!session.checkoutSessionId) {
    throw new KioskError('Assign a vehicle first — checkout has not started', 422, 'CHECKOUT_NOT_STARTED');
  }
  const cs = await prisma.checkoutSession.findUnique({ where: { id: session.checkoutSessionId } });
  if (!cs || (cs.tenantId && cs.tenantId !== device.tenantId)) {
    throw new KioskError('Checkout session not found', 404, 'CHECKOUT_NOT_FOUND');
  }
  return cs;
}

/**
 * GET /sessions/:id/agreement — the K7 "key terms + initials" screen data:
 * per-section T&C bodies (with signed flags), the agreement money summary
 * and the masked customer/vehicle context. Prices/terms always from the
 * server.
 */
async function getAgreement(sessionId, device) {
  const session = await getSessionForDevice(sessionId, device);
  const cs = await loadCheckoutSessionFor(session, device);
  if (!cs.agreementId) throw new KioskError('No agreement linked to this checkout', 409, 'NO_AGREEMENT');

  const [agreement, resv, initials] = await Promise.all([
    prisma.rentalAgreement.findUnique({
      where: { id: cs.agreementId },
      select: {
        id: true, agreementNumber: true, declinedInsurance: true,
        subtotal: true, taxes: true, fees: true, total: true, securityDepositAmount: true,
      },
    }),
    prisma.reservation.findFirst({
      where: { id: session.reservationId, tenantId: device.tenantId },
      select: {
        pickupAt: true, returnAt: true,
        customer: { select: { firstName: true, lastName: true } },
        vehicleType: { select: { name: true } },
        vehicle: { select: { make: true, model: true, year: true, color: true, plate: true, internalNumber: true } },
      },
    }),
    prisma.agreementSectionInitial.findMany({
      where: { agreementId: cs.agreementId },
      select: { sectionKey: true },
    }),
  ]);
  if (!agreement || !resv) throw new KioskError('Agreement not found', 404, 'NO_AGREEMENT');

  const signedKeys = new Set(initials.map((i) => i.sectionKey));
  const sections = sectionsForAgreement({ declinedInsurance: !!agreement.declinedInsurance })
    .map((s) => ({ key: s.key, label: s.label, body: s.body, signed: signedKeys.has(s.key) }));

  return {
    checkoutSession: {
      id: cs.id,
      currentStep: cs.currentStep,
      stamps: {
        tcCompletedAt: cs.tcCompletedAt,
        paymentCompletedAt: cs.paymentCompletedAt,
        inspectionCompletedAt: cs.inspectionCompletedAt,
        customerSignedAt: cs.customerSignedAt,
      },
    },
    agreement: {
      agreementNumber: agreement.agreementNumber,
      subtotal: Number(agreement.subtotal || 0),
      taxes: Number(agreement.taxes || 0),
      fees: Number(agreement.fees || 0),
      total: Number(agreement.total || 0),
      securityDepositAmount: Number(agreement.securityDepositAmount || 0),
    },
    summary: {
      maskedName: maskCustomerName(resv.customer?.firstName, resv.customer?.lastName),
      pickupWindow: { pickupAt: resv.pickupAt, returnAt: resv.returnAt },
      vehicleClassName: resv.vehicleType?.name || null,
      vehicle: resv.vehicle ? {
        make: resv.vehicle.make, model: resv.vehicle.model, year: resv.vehicle.year,
        color: resv.vehicle.color, plate: resv.vehicle.plate, internalNumber: resv.vehicle.internalNumber,
      } : null,
    },
    sections,
  };
}

/**
 * ANTI-beta.152 (spec-mandated): the kiosk has NO inspection step, so before
 * closing we stamp odometer/fuel onto the agreement from Vehicle.mileage +
 * any staff-staged agreement values (agreement column wins when already
 * set). With odometerOut populated, the CLOSED cascade's
 * `checkoutOdometer = agRow.odometerOut ?? …` is non-null and it ALWAYS
 * calls recordMileageEntrySafe — contracts never print "-" and the mileage
 * history never silently skips a kiosk checkout.
 */
async function stampKioskCheckoutMetrics({ cs, device }) {
  if (!cs.agreementId) return;
  const [agreement, resv] = await Promise.all([
    prisma.rentalAgreement.findUnique({
      where: { id: cs.agreementId },
      select: { id: true, odometerOut: true, fuelOut: true },
    }),
    prisma.reservation.findFirst({
      where: { id: cs.reservationId, tenantId: device.tenantId },
      select: { vehicleId: true },
    }),
  ]);
  if (!agreement) return;

  const patch = {};
  if (agreement.odometerOut == null && resv?.vehicleId) {
    const vehicle = await prisma.vehicle.findFirst({
      where: { id: resv.vehicleId, tenantId: device.tenantId },
      select: { mileage: true },
    });
    if (vehicle?.mileage != null) patch.odometerOut = vehicle.mileage;
  }
  if (agreement.fuelOut == null && resv?.vehicleId) {
    // Latest staff/telematics fuel reading, when one exists (best-effort).
    const reading = await prisma.vehicleFuelReading.findFirst({
      where: { vehicleId: resv.vehicleId },
      orderBy: [{ recordedAt: 'desc' }, { createdAt: 'desc' }],
      select: { fuelFraction: true },
    }).catch(() => null);
    if (reading?.fuelFraction != null) patch.fuelOut = reading.fuelFraction;
  }
  if (Object.keys(patch).length) {
    await prisma.rentalAgreement.update({ where: { id: agreement.id }, data: patch });
  }
}

function mapCheckoutError(err) {
  if (err instanceof CheckoutSessionError) return new KioskError(err.message, err.status, err.code);
  return err;
}

/**
 * POST /sessions/:id/sign — per-section initials + final signature, then
 * drive the REAL state machine to CLOSED. Requires the server-recorded ID
 * verify stamp (M2) and paymentCompletedAt (sandbox in B3, payment-link in
 * B5). Order: initials → tcCompletedAt → kiosk metrics stamp →
 * inspectionCompletedAt → signature (customerSignedAt) → forward
 * transitions to CLOSED (whose cascade finalizes agreement + reservation +
 * mileage + auto-email).
 */
async function sign(sessionId, device, { sectionInitials, signature, signerName, customerIp } = {}) {
  const session = await getSessionForDevice(sessionId, device);
  requireInProgress(session);
  // M2: gate on the SERVER-side verify stamp — never on eventsJson.
  if (!session.idVerifiedAt) {
    throw new KioskError('ID verification is required before signing', 409, 'ID_VERIFY_REQUIRED');
  }
  const cs = await loadCheckoutSessionFor(session, device);
  if (isTerminal(cs.currentStep)) {
    throw new KioskError(`Checkout is already ${cs.currentStep.toLowerCase()}`, 409, 'CHECKOUT_TERMINAL');
  }
  if (!cs.agreementId) throw new KioskError('No agreement linked to this checkout', 409, 'NO_AGREEMENT');
  if (!cs.paymentCompletedAt) {
    throw new KioskError('Payment must be completed before signing', 409, 'PAYMENT_REQUIRED');
  }
  if (!signature || String(signature).length < 200) {
    throw new KioskError('A signature is required', 400, 'SIGNATURE_REQUIRED');
  }

  const agreement = await prisma.rentalAgreement.findUnique({
    where: { id: cs.agreementId },
    select: { id: true, declinedInsurance: true, agreementNumber: true },
  });
  if (!agreement) throw new KioskError('Agreement not found', 404, 'NO_AGREEMENT');

  // 1) Per-section initials — same rules as the phone signing flow
  // (terms-signing.service.js): every expected section must carry an initial.
  const expected = sectionsForAgreement({ declinedInsurance: !!agreement.declinedInsurance });
  const provided = new Map(
    (Array.isArray(sectionInitials) ? sectionInitials : [])
      .filter((s) => s?.sectionKey && s?.initialDataUrl && String(s.initialDataUrl).length >= 200)
      .map((s) => [String(s.sectionKey), String(s.initialDataUrl)]),
  );
  const missing = expected.map((s) => s.key).filter((key) => !provided.has(key));
  if (missing.length) {
    throw new KioskError(`Missing initials for: ${missing.join(', ')}`, 400, 'INITIALS_INCOMPLETE');
  }
  const ip = customerIp ? String(customerIp).slice(0, 64) : null;
  for (const section of expected) {
    await prisma.agreementSectionInitial.upsert({
      where: { agreementId_sectionKey: { agreementId: agreement.id, sectionKey: section.key } },
      create: {
        agreementId: agreement.id,
        sectionKey: section.key,
        sectionLabel: section.label,
        initialDataUrl: provided.get(section.key),
        signedAt: new Date(),
        customerIp: ip,
      },
      update: { initialDataUrl: provided.get(section.key), signedAt: new Date(), customerIp: ip },
    });
  }

  try {
    // 2) T&C completed + kiosk checkout metrics + inspection stamp + signature.
    if (!cs.tcCompletedAt) {
      await checkoutSessionService.stampSideEffect({ id: cs.id, field: 'tcCompletedAt' });
    }
    await stampKioskCheckoutMetrics({ cs, device });
    if (!cs.inspectionCompletedAt) {
      await checkoutSessionService.stampSideEffect({ id: cs.id, field: 'inspectionCompletedAt' });
    }
    await checkoutSessionService.saveCustomerSignature({
      id: cs.id,
      signatureDataUrl: String(signature),
      signerName: signerName || null,
      customerIp: ip,
    });

    // 3) Walk the REAL state machine forward to CLOSED (same loop shape as
    // the customer-inspection delegation path). The CLOSED cascade handles
    // FINALIZED + CHECKED_OUT + vehicle sync + mileage entry + auto-email.
    const startIdx = CHECKOUT_STEPS.indexOf(cs.currentStep);
    const remaining = CHECKOUT_STEPS
      .slice(startIdx + 1, CHECKOUT_STEPS.indexOf('CLOSED') + 1)
      .filter((step) => step !== 'CANCELLED');
    for (const toStep of remaining) {
      await checkoutSessionService.transition({
        id: cs.id,
        toStep,
        actorUserId: null,
        metadata: { kiosk: true, kioskSessionId: session.id, deviceId: device.id },
      });
    }
  } catch (err) {
    throw mapCheckoutError(err);
  }

  await recordSessionTelemetry(session, { step: 'SIGN', event: 'SIGN_COMPLETED', data: { agreementNumber: agreement.agreementNumber } });
  logger.info('[kiosk-checkout] signed + closed', {
    sessionId: session.id, deviceId: device.id, tenantId: device.tenantId,
    checkoutSessionId: cs.id, agreementId: agreement.id,
  });

  return {
    ok: true,
    agreementNumber: agreement.agreementNumber,
    checkoutSession: { id: cs.id, currentStep: 'CLOSED' },
  };
}

// ── Sandbox payment (B3 demo ONLY — replaced by B5) ─────────────────────────

/**
 * POST /sessions/:id/sandbox-payment — DEMO-ONLY stamp so the B3 pilot can
 * walk the wizard end-to-end without money. Gates (fail-closed, M1):
 *   • KIOSK_PAYMENT_SANDBOX must be exactly 'true' (403 otherwise), AND
 *   • in production it ALSO requires the explicit double key
 *     KIOSK_PAYMENT_SANDBOX_ALLOW_PROD='true'.
 * Both keys stay OUT of .env.example on purpose — enabling this is always a
 * deliberate act. Every exercised call logs a warn. Touches NO payment
 * gateway, creates NO payment rows — it only stamps paymentCompletedAt.
 * Fase B5 replaces this endpoint with the real payment-link (iPOS HPP) flow
 * + server-side verification, per the spec's MONEY rules.
 */
async function sandboxPayment(sessionId, device) {
  const enabled = String(process.env.KIOSK_PAYMENT_SANDBOX || '') === 'true';
  const prodAllowed = String(process.env.KIOSK_PAYMENT_SANDBOX_ALLOW_PROD || '') === 'true';
  const isProd = process.env.NODE_ENV === 'production';
  if (!enabled || (isProd && !prodAllowed)) {
    logger.warn('[kiosk-checkout] sandbox payment attempted while disabled', {
      sessionId, deviceId: device?.id, tenantId: device?.tenantId, isProd, enabled,
    });
    throw new KioskError('Sandbox payment is disabled', 403, 'SANDBOX_DISABLED');
  }
  logger.warn('[kiosk-checkout] SANDBOX payment exercised — demo only, no money moved', {
    sessionId, deviceId: device?.id, tenantId: device?.tenantId, isProd,
  });

  const session = await getSessionForDevice(sessionId, device);
  requireInProgress(session);
  const cs = await loadCheckoutSessionFor(session, device);
  if (isTerminal(cs.currentStep)) {
    throw new KioskError(`Checkout is already ${cs.currentStep.toLowerCase()}`, 409, 'CHECKOUT_TERMINAL');
  }

  try {
    await checkoutSessionService.stampSideEffect({ id: cs.id, field: 'paymentCompletedAt' });
  } catch (err) {
    throw mapCheckoutError(err);
  }
  await recordSessionTelemetry(session, { step: 'PAYMENT', event: 'SANDBOX_PAYMENT_STAMPED', data: null });
  return { ok: true, sandbox: true };
}

// ── Key handoff config (admin) + complete ───────────────────────────────────

function keyHandoffEntry(entry = {}) {
  const mode = String(entry?.mode || 'STAFF').toUpperCase() === 'LOCKBOX' ? 'LOCKBOX' : 'STAFF';
  return {
    mode,
    lockboxNote: mode === 'LOCKBOX' ? (entry?.lockboxNote ? String(entry.lockboxNote).slice(0, 500) : null) : null,
  };
}

async function readKeyHandoffConfig(tenantId) {
  const row = await prisma.appSetting.findUnique({
    where: { key: scopedSettingKey('kioskKeyHandoffConfig', { tenantId }) },
  }).catch(() => null);
  try {
    const parsed = row?.value ? JSON.parse(row.value) : {};
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

async function keyHandoffConfigFor(tenantId, locationId) {
  const parsed = await readKeyHandoffConfig(tenantId);
  return keyHandoffEntry(parsed?.[locationId] || parsed?.default || {});
}

function requireTenantId(scope = {}) {
  if (!scope?.tenantId) {
    throw new KioskError('A tenant scope is required (super-admins pass ?tenantId=)', 400, 'TENANT_SCOPE_REQUIRED');
  }
  return scope.tenantId;
}

/** Admin GET /api/kiosk/key-handoff — the raw per-location map. */
async function getKeyHandoffSettings(scope = {}) {
  const tenantId = requireTenantId(scope);
  return { config: await readKeyHandoffConfig(tenantId) };
}

/**
 * Admin PUT /api/kiosk/key-handoff — { config: { "<locationId>": {mode,
 * lockboxNote}, "default": {...} } }. mode must be LOCKBOX|STAFF; every
 * non-"default" key must be one of the tenant's locations.
 */
async function updateKeyHandoffSettings(body = {}, scope = {}) {
  const tenantId = requireTenantId(scope);
  const raw = body?.config;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new KioskError('config object is required', 400);
  }

  const keys = Object.keys(raw);
  const locationKeys = keys.filter((key) => key !== 'default');
  if (locationKeys.length) {
    const found = await prisma.location.findMany({
      where: { tenantId, id: { in: locationKeys } },
      select: { id: true },
    });
    const known = new Set(found.map((row) => row.id));
    const dangling = locationKeys.filter((key) => !known.has(key));
    if (dangling.length) {
      throw new KioskError(`Unknown location ids for this tenant: ${dangling.join(', ')}`, 422, 'UNKNOWN_LOCATION_IDS');
    }
  }

  const config = {};
  for (const key of keys) {
    const mode = String(raw[key]?.mode || '').toUpperCase();
    if (!KEY_HANDOFF_MODES.includes(mode)) {
      throw new KioskError(`mode must be one of ${KEY_HANDOFF_MODES.join(', ')} (key ${key})`, 422, 'INVALID_KEY_HANDOFF_MODE');
    }
    config[key] = keyHandoffEntry(raw[key]);
  }

  const settingKey = scopedSettingKey('kioskKeyHandoffConfig', { tenantId });
  await prisma.appSetting.upsert({
    where: { key: settingKey },
    create: { key: settingKey, value: JSON.stringify(config) },
    update: { value: JSON.stringify(config) },
  });
  return { config };
}

/**
 * Best-effort beta.160 customer-inspection link for a checkout that is
 * already CLOSED — delegates to the REAL sendCustomerInspection with
 * { closedSession: true } (step guard accepts CLOSED, no delegation walk,
 * per-reservation dedupe). Never fails complete().
 */
async function maybeSendKioskCustomerInspection({ session, device, cs }) {
  try {
    const result = await customerInspectionService.sendCustomerInspection({
      sessionId: cs.id,
      actorUserId: null,
      closedSession: true,
    });
    if (result?.alreadySent) return { sent: false, reason: 'ALREADY_SENT' };
    // link = the same 24h /inspect/:token URL the email carries — surfaced
    // ONLY on the first completion so the DONE screen can show a QR (K8).
    return { sent: !!result?.ok, link: result?.link || null };
  } catch (err) {
    const code = err?.code || null;
    if (code !== 'CUSTOMER_INSPECTION_DISABLED') {
      logger.warn('[kiosk-checkout] customer inspection link failed (non-fatal)', {
        sessionId: session.id, tenantId: device.tenantId, message: err?.message,
      });
    }
    return { sent: false, reason: code || 'ERROR' };
  }
}

/**
 * POST /sessions/:id/complete — the K10 "keys" screen. HARD GATE: the
 * lockbox code is only ever revealed once the checkout session is CLOSED
 * (spec: "código lockbox se revela SOLO con checkout-session CLOSED").
 * Idempotent (M3): the inspection link is only attempted on the FIRST
 * completion (outcome still IN_PROGRESS) and sendCustomerInspection dedupes
 * per reservation — a retried /complete never re-creates rows or re-emails.
 * The contract email already fired on the CLOSED transition
 * (maybeSendFinalizeEmail, autoEmailedAt-guarded) — nothing is re-sent here.
 */
async function complete(sessionId, device) {
  const session = await getSessionForDevice(sessionId, device);
  const cs = await loadCheckoutSessionFor(session, device);
  if (cs.currentStep !== 'CLOSED') {
    throw new KioskError('Checkout is not closed yet — keys are released only after signing', 409, 'CHECKOUT_NOT_CLOSED');
  }

  const keyHandoff = await keyHandoffConfigFor(device.tenantId, device.locationId);

  let customerInspection = { sent: false, reason: 'ALREADY_COMPLETED' };
  let updated = session;
  if (session.outcome === 'IN_PROGRESS') {
    customerInspection = await maybeSendKioskCustomerInspection({ session, device, cs });
    updated = await prisma.kioskSession.update({
      where: { id: session.id },
      data: { outcome: 'COMPLETED', step: 'DONE', endedAt: new Date(), lastActivityAt: new Date() },
    });
  }

  logger.info('[kiosk-checkout] session completed', {
    sessionId: session.id, deviceId: device.id, tenantId: device.tenantId, keyMode: keyHandoff.mode,
  });

  return {
    ok: true,
    outcome: updated.outcome,
    keyHandoff,
    contractEmail: { sent: !!cs.autoEmailedAt },
    customerInspection: {
      sent: !!customerInspection.sent,
      ...(customerInspection.sent && customerInspection.link ? { link: customerInspection.link } : {}),
    },
  };
}

export const kioskCheckoutService = {
  verifyId,
  getAgreement,
  sign,
  sandboxPayment,
  complete,
  getKeyHandoffSettings,
  updateKeyHandoffSettings,
};
