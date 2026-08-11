/**
 * Payments in the ⌘K palette — find a payment by its reference.
 *
 * WHY (Hector, 2026-08-11): manual payments carry a reference the agents fill
 * in — a receipt number, an auth code, and the house format already bundles
 * the card's last 4 as "****1234 · auth A8K2X9". None of it was searchable:
 * the palette covered reservations, vehicles, customers and agreements, so
 * answering "who paid with the card ending 1234?" meant opening reservations
 * one by one. ReservationPayment.reference has carried an index since the
 * schema was written; this is the search that index was waiting for.
 *
 * THE DEDUP THIS FILE EXISTS FOR: a payment recorded on the agreement is
 * MIRRORED into a ReservationPayment row (rentalAgreementPaymentId points
 * back). Searching both tables therefore finds the same money twice — same
 * amount, same reference — and a palette that shows one payment as two rows
 * reads as a double charge to whoever is searching. The reservation-side row
 * wins because it is the one that links to the page an agent can act on.
 */

const money = (v) => `$${Number(v || 0).toFixed(2)}`;

/**
 * Merge both payment tables into palette results, mirrored rows deduped.
 *
 * @param {Array} reservationPayments rows with { id, amount, method, reference,
 *        paidAt, rentalAgreementPaymentId, reservation: { id, reservationNumber,
 *        customer?: { firstName, lastName } } }
 * @param {Array} agreementPayments rows with { id, amount, method, reference,
 *        paidAt, rentalAgreement: { reservation: { id, reservationNumber,
 *        customer?: { firstName, lastName } } } }
 * @returns {Array<{type, id, title, subtitle, href}>}
 */
export function mapPaymentResults(reservationPayments = [], agreementPayments = []) {
  const mirrored = new Set(
    (reservationPayments || [])
      .map((p) => String(p?.rentalAgreementPaymentId || ''))
      .filter(Boolean)
  );

  const shape = ({ id, amount, method, reference, paidAt, reservation }) => {
    const customer = [reservation?.customer?.firstName, reservation?.customer?.lastName]
      .filter(Boolean).join(' ');
    return {
      type: 'payment',
      id,
      title: `${money(amount)} · ${String(method || '').replaceAll('_', ' ')}`,
      subtitle: [reference, reservation?.reservationNumber, customer]
        .filter(Boolean).join(' · '),
      href: reservation?.id ? `/reservations/${reservation.id}/payments` : null,
      paidAt: paidAt || null,
    };
  };

  const fromReservation = (reservationPayments || [])
    .filter((p) => p && p.reservation)
    .map((p) => shape(p));

  const fromAgreement = (agreementPayments || [])
    .filter((p) => p && !mirrored.has(String(p.id)) && p.rentalAgreement?.reservation)
    .map((p) => shape({ ...p, reservation: p.rentalAgreement.reservation }));

  // Newest first: the payment someone is hunting for is almost always recent.
  return [...fromReservation, ...fromAgreement]
    .sort((a, b) => new Date(b.paidAt || 0) - new Date(a.paidAt || 0))
    .map(({ paidAt, ...row }) => row);
}

/**
 * The minimum query length for the payment bucket. The palette's global
 * minimum is 2, but two characters against `reference contains` matches half
 * the table ("12" hits every card last-4 with a 1 and a 2). Four is exactly a
 * card's last-4 — the search this feature is for — and any real receipt or
 * auth code is at least that long.
 */
export const PAYMENT_QUERY_MIN = 4;
