/**
 * Public signing service for the T&C signing flow.
 *
 * Used by /api/sign/:token/* endpoints (no auth — token IS the auth).
 *
 *   • loadSession(token)   — resolves token → { session, agreement, sections }
 *   • saveInitial(token, sectionKey, initialDataUrl, customerIp)
 *   • complete(token, signatureDataUrl, signerName, customerIp)
 *
 * The token row's consumedAt is set on complete. Re-using a token after
 * complete returns a 410 TOKEN_CONSUMED so the customer can't double-sign.
 */

import { prisma } from '../../lib/prisma.js';
import logger from '../../lib/logger.js';
import { CheckoutSessionError } from './checkout-session.service.js';
import { sectionsForAgreement } from './terms-content.js';
import { appendEvent } from './state-machine.js';
import { analyzeSignatureInk } from '../../lib/signature-ink.js';

async function loadToken(token) {
  if (!token) throw new CheckoutSessionError('token required', 400);
  const row = await prisma.handoffToken.findUnique({
    where: { token },
    include: {
      reservation: {
        include: {
          rentalAgreement: {
            select: {
              id: true, declinedInsurance: true, agreementNumber: true,
              // Per-branch acknowledgement text (2026-07-24). Read off the
              // AGREEMENT, not the reservation, even though both carry a
              // pickupLocationId: reservationsService.update can move
              // Reservation.pickupLocationId (reservations.service.js:1921) with
              // no sync back to the agreement, and the PDF that re-prints these
              // very sections beside the captured initials resolves them from
              // RentalAgreement.pickupLocation. Reading the reservation here
              // would let one signed document show two branches' wording.
              // The agreement is the document of record and its
              // pickupLocationId is non-null.
              pickupLocation: { select: { id: true, termsSectionsJson: true } },
            },
          },
        },
      },
    },
  });
  if (!row) throw new CheckoutSessionError('Invalid token', 410, 'TOKEN_INVALID');
  if (row.kind !== 'TERMS_SIGNING') throw new CheckoutSessionError('Wrong token kind', 410, 'TOKEN_WRONG_KIND');
  if (row.expiresAt < new Date()) throw new CheckoutSessionError('Token expired', 410, 'TOKEN_EXPIRED');
  if (row.consumedAt) throw new CheckoutSessionError('Token already used', 410, 'TOKEN_CONSUMED');
  if (!row.reservation?.rentalAgreement?.id) {
    throw new CheckoutSessionError('No agreement linked to this reservation', 409);
  }
  return row;
}

async function loadSession(token) {
  const row = await loadToken(token);
  const ag = row.reservation.rentalAgreement;
  const sections = sectionsForAgreement({ declinedInsurance: !!ag.declinedInsurance, sectionOverrides: ag.pickupLocation?.termsSectionsJson });

  // Pull already-completed initials so the UI can show what's left.
  const initials = await prisma.agreementSectionInitial.findMany({
    where: { agreementId: ag.id },
    select: { sectionKey: true, signedAt: true },
  });
  const completedKeys = new Set(initials.map((i) => i.sectionKey));

  return {
    reservationNumber: row.reservation.reservationNumber,
    agreementNumber: ag.agreementNumber,
    customer: { firstName: row.reservation.customerId },
    sections: sections.map((s) => ({
      key: s.key, label: s.label, body: s.body,
      signed: completedKeys.has(s.key),
    })),
    expiresAt: row.expiresAt,
  };
}

async function saveInitial({ token, sectionKey, initialDataUrl, customerIp }) {
  if (!sectionKey) throw new CheckoutSessionError('sectionKey required', 400);
  if (!initialDataUrl || initialDataUrl.length < 200) {
    throw new CheckoutSessionError('initialDataUrl missing or too small', 400);
  }
  const row = await loadToken(token);
  const ag = row.reservation.rentalAgreement;
  const allowed = new Set(sectionsForAgreement({ declinedInsurance: !!ag.declinedInsurance, sectionOverrides: ag.pickupLocation?.termsSectionsJson }).map((s) => s.key));
  if (!allowed.has(sectionKey)) {
    throw new CheckoutSessionError(`Unknown sectionKey: ${sectionKey}`, 400);
  }

  // Upsert — customer can re-do a section before completing.
  const sectionLabel = sectionsForAgreement({ declinedInsurance: !!ag.declinedInsurance, sectionOverrides: ag.pickupLocation?.termsSectionsJson })
    .find((s) => s.key === sectionKey)?.label || sectionKey;
  await prisma.agreementSectionInitial.upsert({
    where: { agreementId_sectionKey: { agreementId: ag.id, sectionKey } },
    create: {
      agreementId: ag.id,
      sectionKey,
      sectionLabel,
      initialDataUrl,
      signedAt: new Date(),
      customerIp: customerIp || null,
    },
    update: {
      initialDataUrl,
      signedAt: new Date(),
      customerIp: customerIp || null,
    },
  });
  logger.info('[terms-signing] section initial saved', { agreementId: ag.id, sectionKey });
  return { sectionKey, signed: true };
}

async function complete({ token, signatureDataUrl, signerName, customerIp }) {
  if (!signatureDataUrl || signatureDataUrl.length < 200) {
    throw new CheckoutSessionError('signature missing or too small', 400);
  }
  // A blank canvas passes the length check — it is a valid PNG (see
  // signature-ink.js and RA-20260701152550, where a blank interactive
  // signature printed a white box over a real T&C stroke). Reject it here,
  // where the customer can simply sign again; fail-open on formats the
  // analyzer cannot read.
  const ink = analyzeSignatureInk(signatureDataUrl);
  if (ink.analyzable && !ink.hasInk) {
    throw new CheckoutSessionError('The signature is blank — please sign before submitting', 400);
  }
  const row = await loadToken(token);
  const ag = row.reservation.rentalAgreement;
  const expected = sectionsForAgreement({ declinedInsurance: !!ag.declinedInsurance, sectionOverrides: ag.pickupLocation?.termsSectionsJson });

  // Verify every section has an initial. Catches the case where the UI
  // and backend disagree on what sections are required.
  const initials = await prisma.agreementSectionInitial.findMany({
    where: { agreementId: ag.id }, select: { sectionKey: true },
  });
  const haveKeys = new Set(initials.map((i) => i.sectionKey));
  const missing = expected.map((s) => s.key).filter((k) => !haveKeys.has(k));
  if (missing.length) {
    throw new CheckoutSessionError(
      `Missing initials for: ${missing.join(', ')}`,
      400, 'INITIALS_INCOMPLETE',
    );
  }

  // Atomic finalize: write tcSignature to agreement, stamp the session,
  // mark the token consumed.
  const session = await prisma.checkoutSession.findUnique({
    where: { reservationId: row.reservationId },
  });
  if (!session) throw new CheckoutSessionError('No session for reservation', 409);

  await prisma.$transaction([
    prisma.rentalAgreement.update({
      where: { id: ag.id },
      data: {
        tcSignatureDataUrl: signatureDataUrl,
        tcSignedAt: new Date(),
        tcSignerName: signerName || null,
        tcCustomerIp: customerIp || null,
      },
    }),
    prisma.checkoutSession.update({
      where: { id: session.id },
      data: {
        tcCompletedAt: new Date(),
        // M2 P2 review MUST-1 (2026-08-17): every REAL writer of a versioned
        // field bumps stateVersion, not just checkoutSessionService — this is
        // the customer's phone signing T&C while an H6 client holds an
        // expectedVersion snapshot; without the bump its guard would pass
        // believing nothing changed.
        stateVersion: { increment: 1 },
        events: appendEvent(session.events, {
          kind: 'TC_SIGNED_BY_CUSTOMER',
          signerName: signerName || null,
          customerIp: customerIp || null,
        }),
      },
    }),
    prisma.handoffToken.update({
      where: { id: row.id }, data: { consumedAt: new Date() },
    }),
  ]);

  logger.info('[terms-signing] T&C completed', { agreementId: ag.id, sessionId: session.id });
  return { ok: true };
}

export const termsSigningService = {
  loadSession,
  saveInitial,
  complete,
};
