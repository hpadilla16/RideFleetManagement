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
 * WRITER INVENTORY as of 2026-08-17:
 *   1. checkout-session.service.js  setDeclinedInsurance()  — agent, wizard step 1
 *   2. customer-portal.routes.js    POST /customer-info/:token — customer, pre-check-in
 * Everything else that names the column only READS it: kiosk-checkout.service.js
 * (2 selects + 2 response mappings), rental-agreements.service.js (select, PDF
 * addendum, buildDeclinedInsuranceBlock), reservations.service.js (list + detail
 * selects), terms-signing.service.js and terms-content.js. No backfill script,
 * no raw-SQL UPDATE, and no RideOps/Flutter writer touched it at that date.
 *
 * That list is a SNAPSHOT, not a guarantee, and a comment cannot keep itself
 * honest — so it is ratcheted by a test: `the set of files naming
 * declinedInsurance is a ratchet` in declined-insurance-and-sign-url.test.mjs
 * fails the build when a file starts touching the column, forcing whoever added
 * it to classify it here. New writers call this gate BEFORE their first
 * mutation.
 *
 * WHY tcSignedAt AND NOT ONLY session.tcCompletedAt. The agreement is the
 * document of record and the two are stamped in the same transaction by
 * terms-signing.complete(). But pre-check-in normally runs BEFORE any
 * CheckoutSession row exists, so a session-only check would silently pass for
 * the portal — the exact hole this module closes. Check the agreement first and
 * treat the session as corroboration.
 *
 * How much tcSignedAt covers: the later signature steps (saveCustomerSignature,
 * mobile-inspection) sit downstream of T&C in the CHECKOUT_STEPS graph, so in
 * practice the stamp is already set by the time they run. That ordering is
 * imposed by the transition endpoint and the wizard, though — neither service
 * asserts the step itself — so treat this as "the transition graph enforces
 * it", not as something the data model makes impossible.
 */

import { prisma } from '../../lib/prisma.js';
import { CheckoutSessionError } from './checkout-session.errors.js';

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
 * Returns a VERDICT rather than only throwing, because "may I write the flag?"
 * and "is this contract already signed?" are different questions and a caller
 * can need the second even when the first says yes. The portal is exactly that
 * case: on a no-flip re-submit the gate allows the write, but the surrounding
 * update also carries declinedInsuranceSignatureDataUrl / ...SignedAt, and
 * those ARE printed on the contract (rental-agreements.service.js
 * buildDeclinedInsuranceBlock). Overwriting them would replace the addendum
 * signature and re-date it to AFTER the customer signed the agreement. The
 * caller reads `signed` and omits those columns; the gate does not need to know
 * which columns exist.
 *
 * @param {object}  args
 * @param {string}  [args.agreementId]   RentalAgreement being written. Resolved
 *                                       from reservationId when omitted.
 * @param {string}  [args.reservationId] Owning reservation (for the token lookup).
 * @param {boolean} [args.nextValue]     Value about to be written, if known.
 * @param {object}  [args.client]        Prisma client or $transaction handle.
 * @returns {Promise<{locked: boolean, code: string|null, signed: boolean,
 *                    agreementId: string|null}>}
 */
export async function inspectInsuranceSelection({
  agreementId, reservationId, nextValue, client = prisma,
} = {}) {
  const open = { locked: false, code: null, signed: false, agreementId: agreementId || null };
  if (!agreementId && !reservationId) return open;

  // RentalAgreement.reservationId is @unique, so either key resolves the row.
  // The portal reaches this gate before it has looked the agreement up.
  const agreement = await client.rentalAgreement.findUnique({
    where: agreementId ? { id: agreementId } : { reservationId },
    select: { id: true, tcSignedAt: true, reservationId: true, declinedInsurance: true },
  });
  // No agreement yet — nothing is signed and nothing can desync.
  if (!agreement) return open;

  const resId = reservationId || agreement.reservationId;
  const verdict = { locked: false, code: null, signed: false, agreementId: agreement.id };

  // 1. Already signed. The captured initials and the PDF's addendum would no
  //    longer agree with the flag, so this is final — not a timing window.
  //    `signed` is reported even when the write is allowed through as a no-op.
  const session = resId
    ? await client.checkoutSession.findUnique({
      where: { reservationId: resId },
      select: { tcCompletedAt: true },
    })
    : null;
  verdict.signed = !!agreement.tcSignedAt || !!session?.tcCompletedAt;

  // A write that does not FLIP the flag cannot desync the section set, so it is
  // allowed even on a signed agreement. Evaluated after `signed` so the caller
  // still learns the contract is closed.
  const flips = !(typeof nextValue === 'boolean' && !!agreement.declinedInsurance === nextValue);
  if (!flips) return verdict;

  if (verdict.signed) return { ...verdict, locked: true, code: INSURANCE_LOCK.SIGNED };

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
  if (!resId) return verdict;
  const liveSigningToken = await client.handoffToken.findFirst({
    where: {
      reservationId: resId,
      kind: 'TERMS_SIGNING',
      consumedAt: null,
      expiresAt: { gt: new Date() },
    },
    select: { id: true },
  });
  if (!liveSigningToken) return verdict;

  const started = await client.agreementSectionInitial.findFirst({
    where: { agreementId: agreement.id },
    select: { id: true },
  });
  if (started) return { ...verdict, locked: true, code: INSURANCE_LOCK.SIGNING };
  return verdict;
}

/**
 * inspectInsuranceSelection(), but throws on a locked verdict. Returns the
 * verdict when the write is allowed, so callers that also need `signed` can use
 * this one and skip the two-call dance.
 *
 * @param {'staff'|'customer'} [args.audience] Wording of the thrown message.
 * @throws {CheckoutSessionError} 409 with .code set to an INSURANCE_LOCK value.
 */
export async function assertInsuranceSelectionEditable({ audience = 'staff', ...args } = {}) {
  const verdict = await inspectInsuranceSelection(args);
  if (verdict.locked) {
    throw new CheckoutSessionError(messageFor(verdict.code, audience), 409, verdict.code);
  }
  return verdict;
}
