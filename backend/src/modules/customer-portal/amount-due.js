/**
 * What a customer owes right now — the decision, with no I/O.
 *
 * Lives in its own module so a test can drive the REAL rule. The previous test
 * restated this logic in a local helper and diverged on
 * `{prepaid:true, paid:45, agreementBalance:0, agreementTotal:45}` — the mirror
 * said 0, the function said 45. Five of its eight cases would have passed with
 * the production code deleted. Importing customer-portal.routes.js to reach it
 * is not an option: its transitive imports hang.
 */
export function decideAmountDue({ agreement, reservation, breakdown, paid = 0, fallbackEstimated = 0 }) {

  // A PREPAID BOOKING'S RENTAL IS NOT OWED TO US — and on this path it already
  // is not charged, which is worth writing down so nobody "fixes" it again.
  //
  // `est` comes from breakdown.total. The `?? reservation.estimatedTotal`
  // beside it is unreachable either way: breakdown is always an object, total is
  // always a number, and `??` does not fall through on 0. So the partner's
  // stored total never reaches this arithmetic.
  //
  // What breakdown.total HOLDS depends on which branch built it. With charge
  // rows it is their sum. With none — the imported shape, since promote.js
  // writes the partner's total and no rows — buildReservationBreakdown does NOT
  // return 0: it SYNTHESIZES one from `pricingSnapshot.dailyRate ?? dailyRate`
  // times the day count, plus mandatory location fees, underage and
  // additional-driver fees, and tax. An earlier version of this comment claimed
  // est was simply 0 there; it is not, and the test that "covered" it stipulated
  // `breakdown: {total: 0}`, so it never exercised the real shape.
  //
  // For a broker import that still lands on 0 — but because promote.js writes
  // no dailyRate either, NOT because the branch returns 0. And a zero rate is
  // NECESSARY but not SUFFICIENT: with dailyRate 0 the synthetic branch still
  // returns mandatory location fees, underage and additional-driver fees, and
  // tax. Nothing enforces even the rate being absent — 10 FRANCHISE_TL
  // reservations already carry a dailyRate written by some other path, and TL
  // is 100% prepaid. A guard keyed on the rate alone leaves the fee path open.
  //
  // MEASURED 2026-08-09: 0 franchise imports are currently in the shape that
  // would bill (a rate, no agreement, no visible charge rows) — all 10 have an
  // agreement or real rows. So the exposure is latent, not live. If a prepaid
  // import ever reaches the synthetic branch with a rate, this WILL quote it a
  // rental it already paid for, and the guard belongs here rather than in a
  // comment explaining why it is not needed.
  //
  // What DOES reach it, correctly, is whatever was sold here — insurance at the
  // pre-check-in step, a kiosk toll pass. Zeroing `est` for prepaid (tried
  // 2026-08-09) dropped exactly that: a $45 insurance line became $0.00 due and
  // the Pay Now button disappeared, making it uncollectible until the counter.
  //
  // The exposure that DID exist was on the public booking path, which reads
  // estimatedTotal directly — fixed separately in authnet-accept-hosted.js.
  //
  // THIS FUNCTION DOES NOT READ `isPrepaid`, on purpose. It used to bind it to a
  // local that nothing consumed, which is worse than not reading it at all: in a
  // money module a reader sees the flag computed and assumes the decision turns
  // on it. It does not, and it cannot yet — `breakdown.total` arrives as a bare
  // number with no provenance, so "$45 of insurance sold at pre-check-in" and
  // "$45 synthesized from a rate" are indistinguishable here. Suppressing on the
  // flag alone is what dropped the $45 insurance line described above.
  //
  // The guard, when it comes, needs `buildReservationBreakdown` to say WHICH
  // branch built the figure (a `synthesized: true` on the returned object), and
  // suppresses only that one. That is a signature change on a money path, so it
  // is its own change with its own tests — not a rider on this one.
  const est = Number(breakdown?.total ?? reservation?.estimatedTotal ?? fallbackEstimated ?? 0);
  const reservationOutstanding = Math.max(0, Number((est - paid).toFixed(2)));

  let depositDueNow = null;
  if (reservation?.pricingSnapshot) {
    const dep = Number(reservation.pricingSnapshot.depositAmountDue || 0);
    if (reservation.pricingSnapshot.depositRequired && Number.isFinite(dep) && dep > 0) {
      depositDueNow = Math.max(0, Number((dep - paid).toFixed(2)));
    }
  }

  // ONCE AN AGREEMENT EXISTS, THE COUNTER OWNS THE MONEY CONVERSATION.
  //
  // Hector's rule, 2026-08-09: prepaid is prepaid; what the customer pays at the
  // counter is what the counter quotes, and they pay it there. So the agreement's
  // ledger is the whole answer — `RentalAgreement.balance` is already the app's
  // documented source of truth for unpaid (the staff UI has read it alone since
  // beta.133), and post-check-in fees are mirrored into it by syncAgreementCharges.
  // The portal does not get a second opinion.
  //
  // This replaces two fallbacks that each re-billed somebody:
  //
  //   `reservationOutstanding` — `est - paid` over the RESERVATION's books,
  //   which returned before any agreement guard was reached. A counter payment
  //   that was never mirrored down to ReservationPayment re-presented the whole
  //   charge sheet. MEASURED on prod 2026-08-09: 19 settled agreements would ask
  //   for $1,135.60 today, and 16 of them already carry a payment on the
  //   agreement's own ledger. (Measure this with the PORTAL's deposit filter at
  //   customer-portal.routes.js — `source === 'SECURITY_DEPOSIT'` or the two
  //   names — not `chargeType = 'DEPOSIT'`. The first pass used chargeType and
  //   was wrong twice: including deposit rows entirely said $49,008.54, and
  //   excluding by chargeType counted deposit rows that carry a different type
  //   as rental.)
  //
  //   `total` — re-presented the entire agreement to somebody who had paid it.
  //   MEASURED: 0 of 1,298 agreements in prod are the shape this was written for
  //   (balance 0, total > 0, paidAmount 0). It defended nobody and billed people.
  //
  // Cost of the rule, measured the same day across BOTH breakdown branches —
  // charge rows and the synthesized one, which a charge-row query cannot see:
  // 4 reservations stop being collectible HERE. One is CHECKED_IN for $300, one
  // CHECKED_IN_UNPAID, and the other two are CANCELLED and NO_SHOW, which this
  // page should not be billing anyway. So the live cost is the two checked-in
  // rentals, and both of those are standing at a counter. Under-collecting in
  // front of a human beats double-charging a customer who is not there to argue.
  //
  // DECIDED by Hector, 2026-08-09: "counter only". A dealership loaner upgrade
  // (loanerBillingMode CUSTOMER_PAY) carries its differential on the RESERVATION
  // while check-out creates a deliberately $0 agreement — see the comment at
  // rental-agreements.service.js, "loaner billing is tracked on the reservation".
  // Under this rule that differential is collected by the service advisor at
  // pickup, which is what public-loaner.service.js already says it expects
  // ("advisor to confirm/collect at pickup"). The portal showing $0 is CORRECT,
  // not a gap to be patched: do not "fix" it by reaching back into
  // reservation.estimatedTotal here. If the differential should ever be
  // collectible online, it has to be carried on the AGREEMENT, upstream of this
  // function. MEASURED the day of the decision: 9 loaner reservations in prod,
  // none with an agreement, the only CUSTOMER_PAY one cancelled.
  //
  // Deposits are deliberately not consulted below when an agreement exists: a
  // hold is a pre-check-in concept, and by check-out the agreement has absorbed it.
  if (agreement) {
    const balance = Number(agreement.balance ?? 0);
    return Number.isFinite(balance) && balance > 0 ? balance : 0;
  }

  if (depositDueNow != null && depositDueNow > 0) {
    return Math.min(reservationOutstanding || depositDueNow, depositDueNow);
  }

  return reservationOutstanding;
}
