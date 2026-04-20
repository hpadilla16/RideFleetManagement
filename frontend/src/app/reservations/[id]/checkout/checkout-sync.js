// PR 4 — Parallelize safe UI steps on the check-out flow.
//
// After `POST /api/reservations/:id/start-rental` completes, the UI needs to:
//   1. PUT /api/rental-agreements/:id/rental — persist vehicle + odometer + fuel + cleanliness
//   2. GET /api/rental-agreements/:id/inspection-report — verify the checkout inspection is complete
//
// These two calls are independent: (1) doesn't read anything (2) produces, and
// (2) doesn't read anything (1) produces. Running them sequentially costs the
// full RTT of each (~300-600 ms combined). Running them in parallel via
// `Promise.all` overlaps the two and trims the checkout by ~300-600 ms.
//
// `signature` and `finalize` still run sequentially after this because
// `finalize` needs the signature to be attached to the agreement.
//
// See docs/operations/checkout-perf-plan.md PR 4.
//
// The logic lives in its own module so it can be unit-tested without
// rendering the full checkout page.

/**
 * @param {string} agreementId
 * @param {{ vehicleId: string, odometerOut: number, fuelOut: number, cleanlinessOut: number }} rentalPayload
 * @param {{ api: Function, token: string }} deps
 * @returns {Promise<unknown>} the inspection-report response
 * @throws {Error} if checkout inspection is not complete
 */
export async function syncRentalAndInspection(agreementId, rentalPayload, { api, token }) {
  // Promise.all dispatches both requests synchronously and waits for both.
  // Failure of either short-circuits and rejects the outer promise, so the
  // caller only needs a single try/catch.
  const [, report] = await Promise.all([
    api(`/api/rental-agreements/${agreementId}/rental`, {
      method: 'PUT',
      body: JSON.stringify(rentalPayload)
    }, token),
    api(`/api/rental-agreements/${agreementId}/inspection-report`, {}, token)
  ]);

  if (!report?.checkoutInspection?.at) {
    throw new Error('Checkout inspection is required before completing check-out');
  }
  return report;
}
