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
import { parseLocationConfig } from '../../lib/location-config.js';

// settings.service.js DEFAULTS.companyName. A tenant that never filled in
// Settings → Rental agreement reads back the PLATFORM's name from
// getRentalAgreementConfig(), so this value can never be treated as "the
// tenant configured their brand" — see resolveSigningBrand below.
const PLATFORM_DEFAULT_COMPANY_NAME = 'Ride Fleet';

async function loadToken(token) {
  if (!token) throw new CheckoutSessionError('token required', 400);
  const row = await prisma.handoffToken.findUnique({
    where: { token },
    include: {
      reservation: {
        include: {
          // The signer's own language preference. This page renders on the
          // CUSTOMER's phone, so the staff device's stored UI language is
          // meaningless here — see the frontend's useSignLang().
          customer: { select: { locale: true } },
          rentalAgreement: {
            select: {
              id: true, declinedInsurance: true, agreementNumber: true,
              tenantId: true,
              tenant: { select: { id: true, name: true } },
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
              pickupLocation: { select: { id: true, termsSectionsJson: true, name: true, locationConfig: true } },
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

/**
 * Whose business name does the customer see while they sign?
 *
 * The customer scans a QR off the agent's screen and lands on this page on
 * their OWN phone, with no other context. Before this resolver the page said
 * "Ride Fleet · Terms & Conditions" — the PLATFORM's brand — on the screen
 * where the renter signs a legal contract with, say, Autos del Valle. That is
 * a brand leak from the platform onto another business's customer, at the
 * worst possible moment.
 *
 * The cascade deliberately mirrors the one the signed PDF header uses
 * (rental-agreements.service.js:3551-3555), so the phone and the printed
 * agreement never disagree about who the customer contracted with:
 *
 *   location config → franchise → branch name → tenant-wide setting → Tenant.name
 *
 * Two deviations from the PDF, both about never falling through to the
 * platform brand:
 *   • the tenant-wide `companyName` is ignored when it is still the
 *     'Ride Fleet' DEFAULT (an unconfigured tenant, not a real answer);
 *   • `Tenant.name` backstops the chain — it is a required column, so a
 *     tenant that configured nothing at all still gets its own plain-text
 *     name rather than ours.
 *
 * Returns null only if every source is empty, which the UI renders as a
 * neutral, unbranded header. Never returns the platform's name.
 */
async function resolveSigningBrand(ag) {
  const locCfg = parseLocationConfig(ag?.pickupLocation?.locationConfig);
  let globalCfg = {};
  let franchiseCfg = null;
  try {
    const { settingsService } = await import('../settings/settings.service.js');
    globalCfg = await settingsService.getRentalAgreementConfig(
      ag?.tenantId ? { tenantId: ag.tenantId } : {},
    );
  } catch (err) {
    // Branding must never be able to break signing. Fall through to the
    // location/tenant names below.
    logger.warn('[terms-signing] brand settings lookup failed', { message: err.message });
  }
  try {
    const { franchiseService } = await import('../settings/franchise.service.js');
    franchiseCfg = await franchiseService.getAgreementConfig(
      ag?.reservation?.franchiseId ?? null, { tenantId: ag?.tenantId },
    );
  } catch (err) {
    logger.warn('[terms-signing] brand franchise lookup failed', { message: err.message });
  }

  const configuredGlobalName = String(globalCfg?.companyName || '').trim();
  const companyName =
    String(locCfg?.companyName || '').trim()
    || String(franchiseCfg?.companyName || '').trim()
    || String(ag?.pickupLocation?.name || '').trim()
    || (configuredGlobalName && configuredGlobalName !== PLATFORM_DEFAULT_COMPANY_NAME
      ? configuredGlobalName : '')
    || String(ag?.tenant?.name || '').trim()
    || null;

  return { companyName };
}

/**
 * Narrow the signer's stored locale to a language this page actually ships
 * strings for. Anything unknown returns null so the frontend can fall back to
 * the customer's own browser language instead of guessing wrong.
 *
 * HONEST STATE OF THIS FIELD: `Customer.locale` is read by
 * precheckin-invite.scheduler.js and shuttle-link-invite.js to pick an email
 * language, but NOTHING in backend/src ever writes it — no API, no portal
 * form, no kiosk field. So in practice it is null for every customer who was
 * not seeded or hand-edited, and this returns null with them. Wiring it up
 * here is what makes populating that column pay off later; it is not, today,
 * a working "the contract knows its language" answer. There is no language
 * field on Tenant, Location or RentalAgreement at all.
 */
function normalizeSignerLocale(raw) {
  const s = String(raw || '').trim().toLowerCase();
  if (!s) return null;
  if (s.startsWith('es')) return 'es';
  if (s.startsWith('en')) return 'en';
  return null;
}

async function loadSession(token) {
  const row = await loadToken(token);
  const ag = row.reservation.rentalAgreement;
  const brand = await resolveSigningBrand({ ...ag, reservation: row.reservation });
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
    // Who the customer is signing WITH. Business identity only — this is a
    // no-auth payload, so nothing about the signer, the vehicle or the money
    // belongs in it (and the frontend puts companyName in the <title>, which
    // is public and cacheable).
    brand: { companyName: brand.companyName },
    // Preferred language of the SIGNER, not of the staff device. null = the
    // frontend should fall back to the customer's browser language.
    signerLocale: normalizeSignerLocale(row.reservation.customer?.locale),
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
