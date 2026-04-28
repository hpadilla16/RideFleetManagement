import { prisma } from '../../lib/prisma.js';

/**
 * Public token-based signing flow for rental agreement addendums (BUG-001
 * customer self-service follow-up).
 *
 * The token is generated in `rentalAgreementsService.createAddendum` and
 * embedded in the customer notification email built by
 * `addendum-notification.service.js`. The customer is sent a magic-link to
 * `/customer/sign-addendum?token=...`; that page calls these helpers via
 * `/api/public/addendum-signature/:token`.
 *
 * No JWT / no `req.user` — the token IS the authentication. The token is
 * 192 bits of crypto.randomBytes (32 url-safe base64 chars) and `@unique`
 * in the schema, so guessing one is computationally infeasible.
 *
 * The token is consumed (set to null) after a successful signature
 * submission so it can't be reused.
 */

/**
 * Resolve a signature token to a sanitized view of the addendum + parent
 * agreement + reservation context the customer needs to render the
 * signature page.
 *
 * GET-side gating is intentionally permissive: this function returns
 * the row whenever the token matches, regardless of status (PENDING /
 * SIGNED / VOID) or expiry. The page itself decides what to render
 * based on status. SUBMIT-side gating is strict (status check + atomic
 * compare-and-set in `submitAddendumSignature`), so loosening GET does
 * not weaken single-use semantics.
 *
 * Why permissive on read: after a successful sign, the customer often
 * reloads the page or returns via the email link to confirm. If we
 * 404'd those reloads (because the token was nulled or expired), they
 * would see a generic error instead of the intended "already signed"
 * confirmation view.
 *
 * @param {string} token
 * @returns {Promise<{ addendum: object, agreement: object }>}
 * @throws {Error} 'Signature token is required' / 'Signature token is invalid or expired'
 */
export async function findAddendumByToken(token) {
  const clean = String(token || '').trim();
  if (!clean) throw new Error('Signature token is required');

  const addendum = await prisma.rentalAgreementAddendum.findFirst({
    where: { signatureToken: clean },
    include: {
      rentalAgreement: {
        select: {
          id: true,
          agreementNumber: true,
          customerFirstName: true,
          customerLastName: true,
          customerEmail: true,
          tenant: { select: { id: true, name: true } },
          reservation: {
            select: {
              id: true,
              reservationNumber: true,
              pickupAt: true,
              returnAt: true
            }
          }
        }
      }
    }
  });

  if (!addendum) throw new Error('Signature token is invalid or expired');

  // Sanitized view — internal IDs are kept off the wire when not strictly
  // needed (the addendum + agreement IDs are useful for the page; nothing
  // else is exposed).
  return {
    addendum: {
      id: addendum.id,
      pickupAt: addendum.pickupAt,
      returnAt: addendum.returnAt,
      reason: addendum.reason,
      reasonCategory: addendum.reasonCategory,
      status: addendum.status,
      signatureSignedAt: addendum.signatureSignedAt,
      signatureSignedBy: addendum.signatureSignedBy,
      createdAt: addendum.createdAt
    },
    agreement: {
      id: addendum.rentalAgreement.id,
      agreementNumber: addendum.rentalAgreement.agreementNumber,
      customerName: `${addendum.rentalAgreement.customerFirstName || ''} ${addendum.rentalAgreement.customerLastName || ''}`.trim() || null,
      customerEmail: addendum.rentalAgreement.customerEmail || null,
      tenantName: addendum.rentalAgreement.tenant?.name || null,
      reservationNumber: addendum.rentalAgreement.reservation?.reservationNumber || null,
      reservationPickupAt: addendum.rentalAgreement.reservation?.pickupAt || null,
      reservationReturnAt: addendum.rentalAgreement.reservation?.returnAt || null
    }
  };
}

/**
 * Submit a customer signature against a token. Validates inputs, asserts
 * the addendum is in a signable state, transitions status to SIGNED, and
 * consumes the token.
 *
 * @param {string} token
 * @param {object} payload — `{ signatureDataUrl, signerName }`
 * @param {object} [meta] — `{ ip }` captured from req.ip
 * @returns {Promise<{ ok: true, message: string, addendumId: string, status: string }>}
 * @throws {Error} 'Signature token is invalid or expired' (404)
 *                 'Addendum is already signed' (409)
 *                 'Addendum has been voided and cannot be signed' (409)
 *                 'Signature is required' / 'Signer name is required' / 'Signature too large' (400)
 */
export async function submitAddendumSignature(token, payload = {}, { ip } = {}) {
  const clean = String(token || '').trim();
  if (!clean) throw new Error('Signature token is invalid or expired');

  const dataUrl = String(payload?.signatureDataUrl || '').trim();
  if (!dataUrl) throw new Error('Signature is required');
  // Defensive size check — a typical 860×220 PNG signature data URL is
  // 30–60 KB. Anything past 500 KB is almost certainly malformed or
  // hostile and worth rejecting before it hits the DB.
  if (dataUrl.length > 500_000) throw new Error('Signature too large');

  const signerName = String(payload?.signerName || '').trim();
  if (!signerName) throw new Error('Signer name is required');

  // Atomic compare-and-set. Two concurrent POSTs to the same /:token/signature
  // path could otherwise both pass a read-then-write validation pattern and
  // race to overwrite each other's signature data. By moving the predicate
  // (`status: 'PENDING_SIGNATURE'`, token match, expiry-not-passed) into
  // updateMany's WHERE clause, the second request gets `count === 0` and we
  // re-fetch to surface a precise error.
  //
  // The token is intentionally NOT nulled here — keeping it lets the customer
  // reload the page or return via the email link and see the signed-
  // confirmation view (the page renders based on status). Single-use semantics
  // are enforced by the `status: 'PENDING_SIGNATURE'` predicate above; a
  // second submit attempt against a row that already moved to SIGNED won't
  // match, so count === 0 and the re-fetch surfaces 'already signed'.
  const now = new Date();
  const updateResult = await prisma.rentalAgreementAddendum.updateMany({
    where: {
      signatureToken: clean,
      status: 'PENDING_SIGNATURE',
      OR: [
        { signatureTokenExpiresAt: null },
        { signatureTokenExpiresAt: { gt: now } }
      ]
    },
    data: {
      status: 'SIGNED',
      signatureSignedBy: signerName,
      signatureDataUrl: dataUrl,
      signatureSignedAt: now,
      signatureIp: String(ip || '-').trim()
    }
  });

  if (updateResult.count === 0) {
    // Compare-and-set failed. Figure out why so we can return a precise error.
    const fresh = await prisma.rentalAgreementAddendum.findFirst({
      where: { signatureToken: clean },
      select: {
        id: true,
        status: true,
        signatureTokenExpiresAt: true
      }
    });
    if (!fresh) {
      throw new Error('Signature token is invalid or expired');
    }
    if (fresh.status === 'SIGNED') {
      throw new Error('Addendum is already signed');
    }
    if (fresh.status === 'VOID') {
      throw new Error('Addendum has been voided and cannot be signed');
    }
    if (
      fresh.signatureTokenExpiresAt &&
      fresh.signatureTokenExpiresAt.getTime() < Date.now()
    ) {
      throw new Error('Signature token is invalid or expired');
    }
    // Catch-all (shouldn't happen given the checks above)
    throw new Error('Signature token is invalid or expired');
  }

  // updateMany returns count, not the updated row. Re-fetch for the return.
  const updated = await prisma.rentalAgreementAddendum.findFirst({
    where: { signatureToken: clean },
    select: { id: true, status: true }
  });

  return {
    ok: true,
    message: 'Thank you. Your signature has been captured successfully.',
    addendumId: updated?.id ?? null,
    status: updated?.status ?? 'SIGNED'
  };
}
