// Compact response for hot-path mutations on checkout (POST /:id/signature,
// POST /:id/finalize). Before: the full agreement with charges + payments +
// reservation + customer + vehicle + locations ran ~475 KB per response.
// After: a ~200 B envelope. The web frontend reads nothing from these
// responses on the checkout flow (only chains on agreementId returned by
// start-rental). Detail views refetch via GET /:id when they need the full
// tree. Saves ~300-500 ms per checkout.
//
// See docs/operations/checkout-perf-plan.md PR 3.
//
// This lives in its own module (rather than inline in rental-agreements.routes.js)
// so the pure function can be unit-tested without pulling the full route module
// (which transitively loads Prisma and the service layer).

export function compactAgreementResponse(row) {
  if (!row || typeof row !== 'object') return row;
  return {
    id: row.id,
    agreementNumber: row.agreementNumber,
    status: row.status,
    total: row.total,
    balance: row.balance,
    finalizedAt: row.finalizedAt
  };
}
