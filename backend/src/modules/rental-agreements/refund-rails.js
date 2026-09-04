/**
 * refund-rails.js — which gateway (if any) a payment row's refund runs through.
 *
 * View Payments refund (2026-09-04). refundPayment used to know two card rails
 * (PAYARC: / AUTHNET:) and silently bookkept everything else — including SPIn
 * terminal sales and Transact card-on-file charges, whose money never went back
 * to the customer's card. Hector found it live on the Corpusa (SPIn) tenant:
 * "there is no way to refund customer from this page."
 *
 * PURE + I/O-free on purpose (same argument as service-payment-guards.js): the
 * row→rail truth table is unit-tested in refund-rails.test.mjs without prisma
 * or a gateway. The service applies the tenant-terminal rule ON TOP of this
 * (a tenant-resolved SPIn terminal forces the SPIn rail — see refundPayment).
 *
 * Rails:
 *   PAYARC   — reference `PAYARC:<chargeId>`   → PayArc void/refund API
 *   AUTHNET  — reference `AUTHNET:<transId>`   → Auth.Net void/refund
 *   TRANSACT — reference `IPOS_COF:`/`IPOS_REAUTH:` etc. → iPOSpays Transact
 *              void by RRN (the stored key is authCode||rrn||referenceId from
 *              the original charge — see spinChargeCardOnFile — so the void is
 *              attempted with the best key we have and the gateway is the
 *              judge). NOTE `IPOS_` (underscore, Transact CNP) is NOT `IPOS:`
 *              (colon, the HPP e-com prefix) — HPP rows have no refund API on
 *              our side and stay bookkeeping-only.
 *   SPIN     — gateway SPIN CARD rows (terminal sales + their mirrors). The
 *              SPIn ReferenceId lives in the notes ("Spin Sale · <refId>" —
 *              spin-charge.service.js) because `reference` stores the
 *              AuthCode when the terminal returned one.
 *   RECORD   — everything else (cash/check/manual card/ATH Móvil…): negative
 *              bookkeeping row only, no gateway call. This is the pre-existing
 *              fallback, unchanged.
 */

const SPIN_SALE_NOTES_RE = /Spin Sale\s*·\s*(\S+)/;

/**
 * Classify one ReservationPayment row. Returns { rail, key } where `key` is
 * the gateway reference the rail needs (null when the rail needs none, or when
 * a gateway rail's key cannot be found — the service refuses rather than
 * guessing a money call's target).
 */
export function resolveRefundRail(payment = {}) {
  const reference = String(payment.reference || '').trim();
  const upper = reference.toUpperCase();

  if (upper.startsWith('PAYARC:')) {
    return { rail: 'PAYARC', key: reference.slice('PAYARC:'.length).trim() || null };
  }
  if (upper.startsWith('AUTHNET:')) {
    return { rail: 'AUTHNET', key: reference.slice('AUTHNET:'.length).trim() || null };
  }
  // Transact CNP rows: `IPOS_COF:K123 ****4821`, `IPOS_REAUTH:...`. Take the
  // first token after the colon; the trailing ` ****1234` display suffix is
  // never part of the gateway key.
  const transact = /^IPOS_[A-Z0-9_]*:\s*(\S+)/i.exec(reference);
  if (transact) {
    return { rail: 'TRANSACT', key: transact[1] || null };
  }
  if (
    String(payment.gateway || '').toUpperCase() === 'SPIN'
    && String(payment.method || '').toUpperCase() === 'CARD'
  ) {
    const fromNotes = SPIN_SALE_NOTES_RE.exec(String(payment.notes || ''));
    return { rail: 'SPIN', key: (fromNotes && fromNotes[1]) || reference || null };
  }
  return { rail: 'RECORD', key: null };
}

/**
 * Same LOCAL calendar day — the void-vs-return boundary for SPIn. A terminal
 * sale still in the open batch is voided; once the batch has (very likely)
 * settled, the money goes back as a Return. Calendar day in server time is a
 * proxy for "batch not yet settled": Dejavoo batches close on the terminal's
 * daily settle, and the counter and this server run in the same timezone.
 * When the proxy is wrong in the safe direction (batch actually still open
 * next morning) the Return still succeeds — processors accept a return against
 * an unsettled sale far more gracefully than a void against a settled one.
 */
export function isSameLocalDay(a, b = new Date()) {
  const d1 = new Date(a);
  const d2 = new Date(b);
  if (Number.isNaN(d1.getTime()) || Number.isNaN(d2.getTime())) return false;
  return d1.getFullYear() === d2.getFullYear()
    && d1.getMonth() === d2.getMonth()
    && d1.getDate() === d2.getDate();
}
