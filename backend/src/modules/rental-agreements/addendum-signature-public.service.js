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
 * @param {string} token
 * @param {object} [options]
 * @param {boolean} [options.allowSigned=false] — if true, returns the
 *   addendum even when status === 'SIGNED' (so a successful submission
 *   can be re-confirmed via a follow-up GET). Default false: only valid
 *   while the token is active.
 * @returns {Promise<{ addendum: object, agreement: object }>}
 * @throws {Error} 'Signature token is required' / 'Signature token is invalid or expired'
 */
export async function findAddendumByToken(token, { allowSigned = false } = {}) {
  const clean = String(token || '').trim();
  if (!clean) throw new Error('Signature token is required');

  const addendum = await prisma.rentalAgreementAddendum.findFirst({
    where: {
      signatureToken: clean,
      ...(allowSigned ? {} : { signatureTokenExpiresAt: { gt: new Date() } })
    },
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

  const existing = await prisma.rentalAgreementAddendum.findFirst({
    where: { signatureToken: clean }
  });
  if (!existing) throw new Error('Signature token is invalid or expired');

  if (existing.status === 'SIGNED') {
    throw new Error('Addendum is already signed');
  }
  if (existing.status === 'VOID') {
    throw new Error('Addendum has been voided and cannot be signed');
  }
  if (
    existing.signatureTokenExpiresAt &&
    existing.signatureTokenExpiresAt.getTime() < Date.now()
  ) {
    throw new Error('Signature token is invalid or expired');
  }

  const updated = await prisma.rentalAgreementAddendum.update({
    where: { id: existing.id },
    data: {
      status: 'SIGNED',
      signatureSignedBy: signerName,
      signatureDataUrl: dataUrl,
      signatureSignedAt: new Date(),
      signatureIp: String(ip || '-').trim(),
      // Consume the token so it can't be reused after a successful sign.
      signatureToken: null,
      signatureTokenExpiresAt: null
    },
    select: { id: true, status: true }
  });

  return {
    ok: true,
    message: 'Thank you. Your signature has been captured successfully.',
    addendumId: updated.id,
    status: updated.status
  };
}
