/**
 * Extracted from the inline object literal previously in `reservations.routes.js`
 * POST /:id/start-rental.
 *
 * Before: ~475 KB full agreement response.
 * After: ~200 B envelope.
 *
 * See `docs/operations/checkout-perf-plan.md` PR 3.2 for the contract.
 *
 * Lives in its own module so the pure function can be unit-tested without
 * pulling the full route module (which transitively loads Prisma + the service
 * layer).
 */

/**
 * Trim a start-rental agreement response to its 7-field contract envelope.
 *
 * @param {object} row - Agreement row from service.
 * @returns {object} Slim response with 7 exact fields.
 *
 * Defensive: if row is null/undefined/non-object, return it unchanged.
 */
export function compactStartRentalResponse(row) {
  if (!row || typeof row !== 'object') return row;

  return {
    id: row.id,
    agreementNumber: row.agreementNumber,
    reservationId: row.reservationId,
    status: row.status,
    total: row.total,
    paidAmount: row.paidAmount,
    balance: row.balance
  };
}
