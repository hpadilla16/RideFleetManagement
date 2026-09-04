import { prisma } from '../../lib/prisma.js';
import logger from '../../lib/logger.js';
import { buildGatewayReference } from '../../lib/payment-references.js';
import {
  hppConfigured,
  hppReferenceId,
  isValidHppReferenceId,
  extractHppReferenceId,
  mintHostedPaymentPage,
  queryHppPaymentStatus,
  resolveTenantHppConfig,
  isHppDryRun,
} from './ipos-hpp-client.js';

/**
 * iPOSpays HPP payment-link flow — the glue between the pure client
 * (ipos-hpp-client.js) and the two customer surfaces that mint links:
 *
 *   • customer-portal  POST /payment/:token/create-session  → mintHppSession
 *   • public-booking   POST /trips/:code/payment-session    → mintHppSession
 *   • customer-portal  POST /payment/:token/confirm         → verifyHppPayment
 *   • public-booking   GET  /trips/:code/payment-return     → verifyAndRecordHppReturn
 *
 * ─── The three MONEY rules this module enforces ────────────────────────────
 * 1. FAIL CLOSED. A tenant whose gateway is 'ipos' but whose HPP credentials
 *    are absent gets a refusal naming Settings → Payments — NEVER a silent
 *    fallback to the platform's Authorize.Net, because that silent fallback
 *    settles the tenant's money into the wrong merchant account (the exact
 *    bug this feature exists to end).
 * 2. NEVER TRUST THE REDIRECT. The browser's return to returnUrl carries our
 *    own reference and nothing else we believe. Recording happens only after
 *    queryPaymentStatus comes back approved, and the amount recorded is the
 *    gateway's totalAmount — not the redirect's, not even our own quote.
 * 3. IDEMPOTENT. Every mint writes an AuditLog row binding the reference to
 *    ONE reservation (so a reference replayed against another reservation is
 *    refused), and recording is keyed on the `IPOS:<transactionId>` reference,
 *    which sits inside the ReservationPayment partial unique index — a
 *    re-visited return URL or a webhook/poll race cannot double-record.
 */

const AUDIT_MARKER = 'iposHppRef';

function codedError(message, code) {
  const err = new Error(message);
  err.code = code;
  return err;
}

export function hppNotConfiguredMessage(resolved = {}) {
  const reason = resolved?.reason || 'NOT_CONFIGURED';
  const detail = reason === 'INCOMPLETE_CONFIG'
    ? 'the iPOS payment-link setup is incomplete (both the CloudPOS TPN and the HPP Auth Token are required)'
    : 'iPOS payment links are not configured for this tenant';
  return `Customer payment links are set to iPOS, but ${detail}. `
    + 'Add the CloudPOS TPN and HPP Auth Token under Settings → Payments → iPOS Payment Links. '
    + 'Links are NOT falling back to Authorize.Net: that would settle into the wrong merchant account.';
}

/**
 * Mint a hosted payment page for a reservation and bind the reference to it.
 *
 * @param {object} opts
 * @param {object} opts.reservation   — must carry id (+ tenantId, reservationNumber)
 * @param {number} opts.amount        — dollars, must be > 0
 * @param {(ref: string) => string} opts.buildReturnUrl — receives the minted
 *        reference so the return URL can carry it back to us
 * @param {string} [opts.cancelUrl]
 * @param {string} [opts.failureUrl]
 * @param {string} [opts.origin]      — 'PORTAL' | 'PUBLIC' | 'KIOSK' (audit only)
 * @param {string} [opts.reuseReferenceId] — use THIS reference instead of minting one.
 *        For callers that own the reference already (the kiosk payment intent).
 * @returns {Promise<{ url: string, referenceId: string }>}
 */
export async function mintHppSession({
  reservation,
  amount,
  buildReturnUrl,
  cancelUrl = '',
  failureUrl = '',
  customer = {},
  merchantName = '',
  description = '',
  origin = 'PORTAL',
  reuseReferenceId = '',
}, deps = {}) {
  const db = deps.prisma || prisma;
  const resolveConfig = deps.resolveConfig || resolveTenantHppConfig;
  const mint = deps.mint || mintHostedPaymentPage;

  if (!reservation?.id) throw codedError('Reservation is required', 'VALIDATION');
  if (!(Number(amount) > 0)) throw codedError('Nothing is due on this reservation', 'ALREADY_PAID');
  if (typeof buildReturnUrl !== 'function') throw codedError('buildReturnUrl is required', 'VALIDATION');

  const resolved = await resolveConfig(reservation.tenantId || null);
  if (!hppConfigured(resolved) && !isHppDryRun()) {
    logger.warn('[ipos-hpp] payment link refused — tenant HPP config missing (failing closed, NO Auth.Net fallback)', {
      tenantId: reservation.tenantId || null,
      reservationId: reservation.id,
      reason: resolved?.reason,
    });
    throw codedError(hppNotConfiguredMessage(resolved), 'GATEWAY_NOT_CONFIGURED');
  }

  // A caller that already OWNS a reference passes it in, and we must use theirs
  // rather than minting a second one. The kiosk is the case: its payment intent
  // owns one reference per session precisely so a retried link cannot put a
  // second live QR into the world (two references are not duplicates to the
  // dedupe, so they would settle as two genuine charges). Every existing caller
  // omits it and keeps the generated reference, byte for byte as before.
  const referenceId = String(reuseReferenceId || '').trim()
    || hppReferenceId(reservation.reservationNumber || reservation.id, { amount });
  const { url } = await mint({
    amount,
    transactionReferenceId: referenceId,
    returnUrl: buildReturnUrl(referenceId),
    cancelUrl,
    failureUrl,
    customer,
    merchantName,
    description,
  }, resolved, deps);

  // Bind the reference to THIS reservation. verify refuses any reference that
  // was not minted for the reservation it is being presented against.
  await db.auditLog.create({
    data: {
      tenantId: reservation.tenantId || null,
      reservationId: reservation.id,
      action: 'UPDATE',
      metadata: JSON.stringify({
        [AUDIT_MARKER]: referenceId,
        gateway: 'ipos',
        amount: Number(Number(amount).toFixed(2)),
        origin,
        mintedAt: new Date().toISOString(),
      }),
    },
  });

  return { url, referenceId };
}

/**
 * Verify a returned HPP reference server-side. Pure verification — records
 * nothing. Returns a normalized verdict the caller records from.
 *
 * @returns {Promise<{ approved: true, amount: number, reference: string,
 *                     transactionId: string, duplicate: boolean,
 *                     existingAmount: number }>}
 * Throws coded errors: VALIDATION | UNKNOWN_REFERENCE |
 * GATEWAY_NOT_CONFIGURED | PAYMENT_NOT_COMPLETED | GATEWAY_ERROR.
 */
export async function verifyHppPayment({ reservation, iposRef }, deps = {}) {
  const db = deps.prisma || prisma;
  const resolveConfig = deps.resolveConfig || resolveTenantHppConfig;
  const query = deps.query || queryHppPaymentStatus;

  // The gateway's redirect DECORATES the reference (a second `?` glued onto
  // the returnUrl — seen live twice, 2026-08-30, rejecting customers who had
  // genuinely paid). Extract our strictly-alphanumeric prefix; the audit
  // binding below stays the real gate.
  const ref = extractHppReferenceId(iposRef);
  if (!reservation?.id) throw codedError('Reservation is required', 'VALIDATION');
  if (!isValidHppReferenceId(ref)) throw codedError('iPOS payment reference is invalid', 'VALIDATION');

  // The reference must have been minted for THIS reservation (metadata is a
  // JSON string; the quoted-key match is exact because references are strictly
  // alphanumeric).
  const minted = await db.auditLog.findFirst({
    where: {
      reservationId: reservation.id,
      metadata: { contains: `"${AUDIT_MARKER}":"${ref}"` },
    },
    // The kiosk reuses one reference across presses, so there can be several
    // mint rows for it. Without an order this picked an arbitrary one, and if
    // the balance had moved between presses a genuine payment failed as an
    // amount mismatch. The latest mint is the one the guest actually paid.
    orderBy: { createdAt: 'desc' },
    select: { id: true, metadata: true },
  });
  if (!minted) throw codedError('Unknown iPOS payment reference for this reservation', 'UNKNOWN_REFERENCE');

  // The amount THIS reference was minted for — the anchor the gateway's echo
  // is reconciled against below.
  let mintedAmount = 0;
  try { mintedAmount = Number(JSON.parse(minted.metadata || '{}')?.amount || 0); } catch { mintedAmount = 0; }

  const resolved = await resolveConfig(reservation.tenantId || null);
  const status = await query({ transactionReferenceId: ref }, resolved, deps);

  if (!status.approved) {
    throw codedError(
      status.errMessage || status.responseMessage
        || `iPOS payment is not completed (code ${status.responseCode || 'unknown'})`,
      'PAYMENT_NOT_COMPLETED',
    );
  }
  // AMOUNT RECONCILIATION — the first live recording booked $112.00 for a
  // $1.12 charge (2026-08-30): the live rail's totalAmount is in CENTS while
  // the UAT documentation shows dollars. Units are decided by AGREEMENT with
  // the minted amount, never by guessing: the gateway echo is accepted as
  // dollars or as cents only when it reconciles, to the cent, with what this
  // reference was minted for. An echo matching NEITHER reading is refused —
  // recording a number the gateway and the mint cannot agree on is how books
  // diverge from banks.
  const rawEcho = Number(status.amount || 0);
  if (!(rawEcho > 0)) throw codedError('iPOS payment amount is missing', 'PAYMENT_NOT_COMPLETED');
  const asDollars = Number(rawEcho.toFixed(2));
  const asCentsToDollars = Number((rawEcho / 100).toFixed(2));
  let amount;
  if (mintedAmount > 0 && asDollars === Number(mintedAmount.toFixed(2))) {
    amount = asDollars;
  } else if (mintedAmount > 0 && asCentsToDollars === Number(mintedAmount.toFixed(2))) {
    amount = asCentsToDollars;
  } else {
    throw codedError(
      `iPOS amount mismatch: gateway echoed ${rawEcho}, reference was minted for ${mintedAmount || 'unknown'}`,
      'AMOUNT_MISMATCH',
    );
  }

  const reference = buildGatewayReference('IPOS', status.transactionId || ref);
  const existing = await db.reservationPayment.findFirst({
    where: { reservationId: reservation.id, reference },
  });

  return {
    approved: true,
    amount,
    reference,
    transactionId: String(status.transactionId || ref),
    cardType: status.cardType,
    cardLast4: status.cardLast4,
    duplicate: !!existing,
    existingAmount: existing ? Number(existing.amount || 0) : 0,
  };
}

/**
 * Website-checkout return path (public-booking GET /payment-return):
 * verify, then record payarc-style — a direct ReservationPayment insert that
 * is idempotent on (reservationId, reference) plus a PAID nudge so the
 * storefront/Flutter polling loop resolves fast. Mirrors confirmPayArcCharge.
 *
 * @returns {Promise<{ ok: true, duplicate: boolean, amount: number, reference: string }>}
 */
export async function verifyAndRecordHppReturn({ reservation, iposRef }, deps = {}) {
  const db = deps.prisma || prisma;
  const verdict = await verifyHppPayment({ reservation, iposRef }, deps);

  if (!verdict.duplicate) {
    await db.reservationPayment.create({
      data: {
        reservationId: reservation.id,
        amount: verdict.amount,
        method: 'CARD',
        status: 'PAID',
        reference: verdict.reference,
        notes: 'Paid via iPOSpays hosted payment page (website checkout)',
        origin: 'PORTAL', // guest-paid; matches the PayArc precedent
        paidAt: new Date(),
      },
    }).catch((e) => {
      // The partial unique index collapses a concurrent double-record into a
      // P2002 — that is the idempotency floor doing its job, not a failure.
      if (String(e?.code) === 'P2002') return;
      logger.warn('[ipos-hpp] payment row insert failed (non-fatal)', {
        reservationId: reservation.id,
        reference: verdict.reference,
        message: e?.message,
      });
    });

    try {
      await db.reservation.update({
        where: { id: reservation.id },
        data: { paymentStatus: 'PAID' },
      });
    } catch (e) {
      logger.warn('[ipos-hpp] paymentStatus update failed (non-fatal)', {
        reservationId: reservation.id,
        message: e?.message,
      });
    }

    logger.info('[ipos-hpp] website checkout payment recorded', {
      reservationId: reservation.id,
      reference: verdict.reference,
      amount: verdict.amount,
    });
  }

  return {
    ok: true,
    duplicate: verdict.duplicate,
    amount: verdict.duplicate ? verdict.existingAmount : verdict.amount,
    reference: verdict.reference,
  };
}

export const iposHppPaymentService = {
  mintHppSession,
  verifyHppPayment,
  verifyAndRecordHppReturn,
  hppNotConfiguredMessage,
};
