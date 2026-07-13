// Canonical definition of "money actually COLLECTED" for revenue reporting.
//
// Two rules, and every report that sums RentalAgreementPayment as revenue MUST
// apply both (spread COLLECTED_PAYMENT_WHERE into the Prisma where):
//
//   1. status = 'PAID' — PENDING/PARTIAL/REFUNDED/VOID rows are not collected
//      money (RES-756256 taught the agreement balance the same rule).
//   2. method != AUTH_HOLD — security-deposit authorization holds are recorded
//      as payment rows so the balance math can exclude the deposit, but the
//      funds are NEVER captured (see AgreementPaymentMethod in schema.prisma).
//
// History: payments-by-day always did this right; the /reports landing
// snapshot ("Revenue in period") summed raw rows and showed $336k when the
// real collected revenue was $47.5k (International, 2026-07-01..13 — 86% of
// the inflation was deposit holds). Sharing the filter here keeps the two
// from ever diverging again.

export const EXCLUDED_PAYMENT_METHODS = Object.freeze(['AUTH_HOLD']);

// Deep-frozen: the object is spread by reference into many Prisma wheres —
// nothing may mutate the shared nested filter.
export const COLLECTED_PAYMENT_WHERE = Object.freeze({
  status: 'PAID',
  method: Object.freeze({ notIn: Object.freeze(Array.from(EXCLUDED_PAYMENT_METHODS)) }),
});
