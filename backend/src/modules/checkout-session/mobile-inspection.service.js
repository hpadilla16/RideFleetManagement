/**
 * Public mobile-inspection service for the agent's phone.
 *
 * Used by /api/mobile-inspection/:token/* endpoints (NO auth — the token
 * IS the auth, same model as terms-signing.service.js).
 *
 *   • loadSession(token)            — resolves token → angles + already
 *                                     captured photo URLs
 *   • savePhoto({ token, angleKey,  — upserts one angle's photo on the
 *       photoDataUrl, notes })        RentalAgreementInspection row
 *                                     (creates the row on first photo)
 *   • complete({ token, signatureDataUrl?, signerName? })
 *                                   — stamps inspectionCompletedAt on
 *                                     the linked CheckoutSession and
 *                                     consumes the token. Optional
 *                                     customer signature on the phone.
 *
 * The token row's consumedAt is set on complete. Re-using a token after
 * complete returns a 410 TOKEN_CONSUMED.
 *
 * The 8 canonical angles match the legacy mobile inspection wizard so
 * old reports + the desktop reservation detail page render the same
 * thumbnails regardless of which capture path was used.
 */

import { prisma } from '../../lib/prisma.js';
import logger from '../../lib/logger.js';
import { CheckoutSessionError } from './checkout-session.service.js';
import { appendEvent } from './state-machine.js';

// Canonical capture angles, in display order. Matches the legacy
// inspection wizard's 8-slot grid (Front, Rear, Left, Right, F. Seat,
// R. Seat, Dash, Trunk) so the resulting RentalAgreementInspection row
// is indistinguishable from one produced by the legacy path.
export const INSPECTION_ANGLES = [
  { key: 'front',     label: 'Front (exterior)' },
  { key: 'rear',      label: 'Rear (exterior)' },
  { key: 'left',      label: 'Left side' },
  { key: 'right',     label: 'Right side' },
  { key: 'front_seat', label: 'Front seat' },
  { key: 'rear_seat',  label: 'Rear seat' },
  { key: 'dash',      label: 'Dashboard' },
  { key: 'trunk',     label: 'Trunk' },
];

async function loadToken(token) {
  if (!token) throw new CheckoutSessionError('token required', 400);
  const row = await prisma.handoffToken.findUnique({
    where: { token },
    include: {
      reservation: {
        include: {
          rentalAgreement: { select: { id: true, agreementNumber: true } },
          vehicle: { select: { id: true, year: true, make: true, model: true, plate: true } },
        },
      },
    },
  });
  if (!row) throw new CheckoutSessionError('Invalid token', 410, 'TOKEN_INVALID');
  if (row.kind !== 'MOBILE_INSPECTION') {
    throw new CheckoutSessionError('Wrong token kind', 410, 'TOKEN_WRONG_KIND');
  }
  if (row.expiresAt < new Date()) throw new CheckoutSessionError('Token expired', 410, 'TOKEN_EXPIRED');
  if (row.consumedAt) throw new CheckoutSessionError('Token already used', 410, 'TOKEN_CONSUMED');
  if (!row.reservation?.rentalAgreement?.id) {
    throw new CheckoutSessionError('No agreement linked to this reservation', 409);
  }
  return row;
}

// photosJson on RentalAgreementInspection is a stringified JSON array.
// We use the convention [{ key, dataUrl, capturedAt, notes }, ...] —
// keyed by INSPECTION_ANGLES.key so the upsert is a simple find +
// replace by key.
function parsePhotos(jsonStr) {
  if (!jsonStr) return [];
  try {
    const parsed = JSON.parse(jsonStr);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function ensureCheckoutInspection(agreementId, actorUserId = null) {
  // One CHECKOUT-phase inspection per agreement. The schema has a
  // unique([rentalAgreementId, phase]) constraint so upsert is safe.
  //
  // 2026-06-15 — actorUserId is the commission earner (syncAgreementCommission
  // Snapshot attributes the rental to the CHECKOUT inspection's actorUserId).
  // The mobile flow used to create this row WITHOUT an actor, so counter
  // checkouts done on the tablet lost their clerk and earned $0 commission.
  // We now stamp the staff user who minted the mobile token (passed in by the
  // caller from the token's createdByUserId), and backfill it if an earlier
  // photo save created the row before we knew the actor.
  const existing = await prisma.rentalAgreementInspection.findFirst({
    where: { rentalAgreementId: agreementId, phase: 'CHECKOUT' },
  });
  if (existing) {
    if (!existing.actorUserId && actorUserId) {
      return prisma.rentalAgreementInspection.update({
        where: { id: existing.id },
        data: { actorUserId },
      });
    }
    return existing;
  }
  return prisma.rentalAgreementInspection.create({
    data: {
      rentalAgreementId: agreementId,
      phase: 'CHECKOUT',
      photosJson: '[]',
      actorUserId: actorUserId || null,
    },
  });
}

async function loadSession(token) {
  const row = await loadToken(token);
  const ag = row.reservation.rentalAgreement;
  const inspection = await prisma.rentalAgreementInspection.findFirst({
    where: { rentalAgreementId: ag.id, phase: 'CHECKOUT' },
    select: { photosJson: true },
  });
  const captured = parsePhotos(inspection?.photosJson);
  const capturedKeys = new Set(captured.map((p) => p.key));

  return {
    reservationNumber: row.reservation.reservationNumber,
    agreementNumber: ag.agreementNumber,
    vehicle: row.reservation.vehicle
      ? `${row.reservation.vehicle.year} ${row.reservation.vehicle.make} ${row.reservation.vehicle.model} · ${row.reservation.vehicle.plate}`
      : null,
    angles: INSPECTION_ANGLES.map((a) => ({
      key: a.key,
      label: a.label,
      captured: capturedKeys.has(a.key),
      // Keep dataUrl off the public payload — it's only used for the
      // upload flow, not the view. Reduces phone bandwidth.
    })),
    expiresAt: row.expiresAt,
  };
}

async function savePhoto({ token, angleKey, photoDataUrl, notes, customerIp }) {
  if (!angleKey) throw new CheckoutSessionError('angleKey required', 400);
  if (!photoDataUrl || photoDataUrl.length < 200) {
    throw new CheckoutSessionError('photoDataUrl missing or too small', 400);
  }
  const validKeys = new Set(INSPECTION_ANGLES.map((a) => a.key));
  if (!validKeys.has(angleKey)) {
    throw new CheckoutSessionError(`Unknown angleKey: ${angleKey}`, 400);
  }

  const row = await loadToken(token);
  const ag = row.reservation.rentalAgreement;
  // Stamp the commission earner = the staff user who minted this mobile token.
  const inspection = await ensureCheckoutInspection(ag.id, row.createdByUserId || null);
  const photos = parsePhotos(inspection.photosJson);

  // Upsert by key — replace existing or push new.
  const idx = photos.findIndex((p) => p.key === angleKey);
  const entry = {
    key: angleKey,
    dataUrl: photoDataUrl,
    capturedAt: new Date().toISOString(),
    notes: String(notes || '').slice(0, 500),
    customerIp: customerIp || null,
  };
  if (idx >= 0) photos[idx] = entry;
  else photos.push(entry);

  await prisma.rentalAgreementInspection.update({
    where: { id: inspection.id },
    data: { photosJson: JSON.stringify(photos) },
  });
  logger.info('[mobile-inspection] photo saved', { agreementId: ag.id, angleKey });
  return { angleKey, captured: true };
}

async function complete({ token, signatureDataUrl, signerName, odometer, fuelLevel, cleanliness, notes, customerIp }) {
  const row = await loadToken(token);
  const ag = row.reservation.rentalAgreement;

  const inspection = await prisma.rentalAgreementInspection.findFirst({
    where: { rentalAgreementId: ag.id, phase: 'CHECKOUT' },
  });
  if (!inspection) {
    throw new CheckoutSessionError('No photos captured', 400, 'PHOTOS_EMPTY');
  }
  const photos = parsePhotos(inspection.photosJson);
  if (photos.length === 0) {
    throw new CheckoutSessionError('No photos captured', 400, 'PHOTOS_EMPTY');
  }

  // Permit partial captures — staff might only walk around an SUV
  // and skip "Trunk" if the customer has it closed. Front + Rear at
  // minimum are required so we always have a chain-of-custody anchor.
  const haveKeys = new Set(photos.map((p) => p.key));
  const requiredKeys = ['front', 'rear'];
  const missingRequired = requiredKeys.filter((k) => !haveKeys.has(k));
  if (missingRequired.length) {
    throw new CheckoutSessionError(
      `Missing required angles: ${missingRequired.join(', ')}`,
      400, 'REQUIRED_ANGLES_MISSING',
    );
  }

  // 2026-05-28 — Phase 4 redesign per Hector.
  //
  // The mobile inspection page collects EVERYTHING from steps 4, 5,
  // and 6 of the legacy desktop wizard: photos + metrics (odometer,
  // fuel, notes) + the customer's final signature. On a successful
  // submit we stamp BOTH inspectionCompletedAt AND customerSignedAt
  // so the desktop wizard's auto-advance effect cascades all the way
  // INSPECTION_HANDOFF → INSPECTION_IN_PROGRESS → CUSTOMER_SIGN_PENDING
  // → FINALIZING → CLOSED in one screen-locked sweep. The agent's
  // tablet/desktop never has to touch step 5 or step 6 again — they
  // just watch the wizard cross the finish line.
  //
  // The signature is optional from the API's perspective (we still
  // close out inspection-only flows for non-finalize use cases), but
  // the mobile UI now requires it before allowing submit.
  const session = await prisma.checkoutSession.findUnique({
    where: { reservationId: row.reservationId },
  });
  if (!session) throw new CheckoutSessionError('No session for reservation', 409);

  const hasSignature = signatureDataUrl && signatureDataUrl.length > 200;
  const now = new Date();

  // 2026-06-10 — mobile checkouts never captured cleanliness, so contracts
  // printed "-" for Cleanliness Out (known limitation of beta.152). The page
  // now sends a 1..5 value (desktop wizard scale; feeds computeCleaningFee at
  // check-in). Write-through to the agreement column, but ONLY if it's still
  // null — an agent-set value from the desktop wizard always wins.
  const cleanlinessNum = Number(cleanliness);
  const cleanlinessVal =
    Number.isInteger(cleanlinessNum) && cleanlinessNum >= 1 && cleanlinessNum <= 5
      ? cleanlinessNum
      : null;
  let writeCleanliness = false;
  if (cleanlinessVal != null) {
    const agClean = await prisma.rentalAgreement.findUnique({
      where: { id: ag.id },
      select: { cleanlinessOut: true },
    });
    writeCleanliness = agClean != null && agClean.cleanlinessOut == null;
  }

  const txOps = [
    prisma.rentalAgreementInspection.update({
      where: { id: inspection.id },
      data: {
        odometer: odometer != null ? Number(odometer) : inspection.odometer,
        fuelLevel: fuelLevel != null ? String(fuelLevel) : inspection.fuelLevel,
        notes: notes ? String(notes).slice(0, 2000) : inspection.notes,
        actorIp: customerIp || inspection.actorIp,
        // Commission earner: never leave the CHECKOUT inspection without an
        // actor when we know who ran the checkout. Token's createdByUserId
        // first, then the session starter. (2026-06-15 commission-attribution fix.)
        actorUserId: inspection.actorUserId || row.createdByUserId || session.startedByUserId || null,
      },
    }),
    prisma.checkoutSession.update({
      where: { id: session.id },
      data: {
        inspectionCompletedAt: now,
        // Stamp customerSignedAt in the same write so the desktop's
        // auto-advance cascade can hop through CUSTOMER_SIGN_PENDING
        // without waiting on the agent to re-sign anywhere else.
        ...(hasSignature ? { customerSignedAt: now } : {}),
        // M2 P2 review MUST-1 (2026-08-17): direct writer of versioned
        // fields → bump stateVersion (see schema.prisma invariant).
        stateVersion: { increment: 1 },
        events: appendEvent(session.events, {
          kind: 'INSPECTION_COMPLETED_VIA_MOBILE',
          photoCount: photos.length,
          hasSignature,
          signerName: signerName || null,
          customerIp: customerIp || null,
        }),
      },
    }),
    prisma.handoffToken.update({
      where: { id: row.id }, data: { consumedAt: now },
    }),
  ];

  // Persist the signature on the agreement when supplied. We reuse the
  // existing tcSignature* columns since the PDF builder already reads
  // those for "Customer Signature" on page 2 and the appended signed
  // acknowledgement page. Falls back gracefully when the column is
  // already populated (e.g. customer also signed during T&C — that
  // signature is fine to keep).
  if (hasSignature) {
    txOps.push(prisma.rentalAgreement.update({
      where: { id: ag.id },
      data: {
        tcSignatureDataUrl: signatureDataUrl,
        tcSignedAt: now,
        tcSignerName: signerName || ag.tcSignerName || null,
        tcCustomerIp: customerIp || null,
      },
    }));
  }

  // Cleanliness write-through (see note above — only when column is null).
  if (writeCleanliness) {
    txOps.push(prisma.rentalAgreement.update({
      where: { id: ag.id },
      data: { cleanlinessOut: cleanlinessVal },
    }));
  }

  await prisma.$transaction(txOps);

  logger.info('[mobile-inspection] completed', {
    agreementId: ag.id, sessionId: session.id,
    photoCount: photos.length, hasSignature,
  });
  return { ok: true, photoCount: photos.length, hasSignature };
}

export const mobileInspectionService = {
  loadSession,
  savePhoto,
  complete,
};
