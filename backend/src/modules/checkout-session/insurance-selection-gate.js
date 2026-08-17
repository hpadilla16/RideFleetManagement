/**
 * THE single gate on RentalAgreement.declinedInsurance.
 *
 * WHY THIS IS ONE MODULE AND NOT A CHECK COPIED INTO EACH ROUTE. The flag is
 * not a preference: sectionsForAgreement() keys off it to decide which sections
 * the customer must initial, and the PDF generator keys off it to decide
 * whether the contract carries the declined-insurance acknowledgement page.
 * terms-signing recomputes that section set on EVERY call, so a late write
 * rewrites the requirements of a signature that is already in flight or already
 * captured. Two surfaces write the column (see the inventory below); a rule
 * enforced in one of them is not a control, and the same rule pasted into both
 * is a rule that will drift. It lives here, once.
 *
 * WRITER INVENTORY (backend/src, verified 2026-08-17 — keep current):
 *   1. checkout-session.service.js  setDeclinedInsurance()  — agent, wizard step 1
 *   2. customer-portal.routes.js    POST /customer-info/:token — customer, pre-check-in
 * Everything else that names the column only READS it: kiosk-checkout.service.js
 * (2 selects + 2 response mappings), rental-agreements.service.js (select, PDF
 * addendum, buildDeclinedInsuranceBlock), reservations.service.js (list + detail
 * selects), terms-signing.service.js and terms-content.js. No backfill script,
 * no raw-SQL UPDATE, and no RideOps/Flutter writer touches it. New writers call
 * this gate BEFORE their first mutation.
 *
 * WHY tcSignedAt AND NOT ONLY session.tcCompletedAt. The agreement is the
 * document of record and the two are stamped in the same transaction by
 * terms-signing.complete(). But pre-check-in normally runs BEFORE any
 * CheckoutSession row exists, so a session-only check would silently pass for
 * the portal — the exact hole this module closes. Check the agreement first and
 * treat the session as corroboration.
 */

import { prisma } from '../../lib/prisma.js';
import { CheckoutSessionError } from './checkout-session.service.js';

/**
 * Machine codes. DELIBERATELY SHARED between the agent and customer surfaces:
 * one rule should speak one vocabulary, and minting portal-only codes would
 * recreate the divergence this module exists to remove. What differs per
 * surface is the human sentence, not the code — see messageFor().
 */
export const INSURANCE_LOCK = Object.freeze({
  SIGNED: 'TC_ALREADY_COMPLETED',
  SIGNING: 'TC_SIGNING_IN_PROGRESS',
});

/**
 * Audience-appropriate wording for the same rule.
 *
 * 'staff'    — an agent at the counter who can act on the explanation.
 * 'customer' — nobody is standing next to them to interpret a 409, so the
 *              sentence has to be self-contained and tell them what to do
 *              next, in their own terms, with no internal vocabulary.
 */
export function messageFor(code, audience = 'staff') {
  const copy = {
    [INSURANCE_LOCK.SIGNED]: {
      staff: 'The customer has already signed the Terms & Conditions — the insurance selection can no longer be changed here.',
      customer: 'Your rental agreement has already been signed, so the insurance choice on it can no longer be changed online. Please speak with the rental counter and they will take care of it.',
    },
    [INSURANCE_LOCK.SIGNING]: {
      staff: 'The customer is signing the Terms & Conditions right now — changing the insurance selection would invalidate the initials they have already given.',
      customer: 'Your rental agreement is being signed right now, so the insurance choice cannot be changed at this moment. Please finish signing, or ask the rental counter for help.',
    },
  };
  return copy[code]?.[audience] || copy[code]?.staff || 'The insurance selection cannot be changed right now.';
}

/**
 * Throw unless RentalAgreement.declinedInsurance may still be written.
 *
 * CALL THIS BEFORE THE FIRST MUTATION of the surrounding request, not beside
 * the update. The portal's pre-check-in handler deletes the reservation's
 * INSURANCE charges before it reaches the flag, and none of it is wrapped in a
 * transaction — a gate placed at the write site would reject the request only
 * after it had already destroyed the charges it was meant to protect.
 *
 * Pass `nextValue` whenever you know it. A write that does not FLIP the flag
 * cannot desync anything, so it is allowed even on a signed agreement — and
 * skipping it avoids a nasty false positive: the portal only ever writes
 * `true`, so without this check a customer who declined coverage and later
 * re-submits pre-check-in (to fix an address, say) would be refused over a
 * field they never changed.
 *
 * @param {object}  args
 * @param {string}  [args.agreementId]   RentalAgreement being written. Resolved
 *                                       from reservationId when omitted.
 * @param {string}  [args.reservationId] Owning reservation (for the token lookup).
 * @param {boolean} [args.nextValue]     Value about to be written, if known.
 * @param {'staff'|'customer'} [args.audience]  Wording of the thrown message.
 * @throws {CheckoutSessionError} 409 with .code set to an INSURANCE_LOCK value.
 */
export async function assertInsuranceSelectionEditable({
  agreementId, reservationId, nextValue, audience = 'staff',
} = {}) {
  if (!agreementId && !reservationId) return;

  // RentalAgreement.reservationId is @unique, so either key resolves the row.
  // The portal reaches this gate before it has looked the agreement up.
  const agreement = agreementId
    ? await prisma.rentalAgreement.findUnique({
      where: { id: agreementId },
      select: { id: true, tcSignedAt: true, reservationId: true, declinedInsurance: true },
    })
    : await prisma.rentalAgreement.findUnique({
      where: { reservationId },
      select: { id: true, tcSignedAt: true, reservationId: true, declinedInsurance: true },
    });
  // No agreement yet — nothing is signed and nothing can desync.
  if (!agreement) return;

  if (typeof nextValue === 'boolean' && !!agreement.declinedInsurance === nextValue) return;

  agreementId = agreement.id;
  const resId = reservationId || agreement.reservationId;

  // 1. Already signed. The captured initials and the PDF's addendum would no
  //    longer agree with the flag, so this is final — not a timing window.
  if (agreement.tcSignedAt) throwLocked(INSURANCE_LOCK.SIGNED, audience);

  const session = resId
    ? await prisma.checkoutSession.findUnique({
      where: { reservationId: resId },
      select: { tcCompletedAt: true },
    })
    : null;
  if (session?.tcCompletedAt) throwLocked(INSURANCE_LOCK.SIGNED, audience);

  // 2. Signing in progress. tcCompletedAt is only stamped inside complete(),
  //    so during the signature itself both stamps above are still null while
  //    the customer already has ink down. Flipping the flag here changes
  //    `expected` between loadSession and complete, and complete() answers the
  //    CUSTOMER with 400 INITIALS_INCOMPLETE for a signature they already drew.
  //
  //    BOTH conditions are required on purpose. A minted-but-untouched token is
  //    still editable: an agent correcting the selection right after handing
  //    over the QR is legitimate, and the customer's next page load picks up
  //    the new section set on its own. An expired or consumed token is not a
  //    hazard either — a fresh loadSession recomputes from the current flag.
  if (!resId) return;
  const liveSigningToken = await prisma.handoffToken.findFirst({
    where: {
      reservationId: resId,
      kind: 'TERMS_SIGNING',
      consumedAt: null,
      expiresAt: { gt: new Date() },
    },
    select: { id: true },
  });
  if (!liveSigningToken) return;

  const started = await prisma.agreementSectionInitial.findFirst({
    where: { agreementId },
    select: { id: true },
  });
  if (started) throwLocked(INSURANCE_LOCK.SIGNING, audience);
}

function throwLocked(code, audience) {
  throw new CheckoutSessionError(messageFor(code, audience), 409, code);
}
