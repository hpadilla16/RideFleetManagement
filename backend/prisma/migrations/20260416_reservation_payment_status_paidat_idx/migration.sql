-- Speeds up the dashboard/reports query that scans ReservationPayment by status + paidAt range.
-- Without this, the query falls back to a full scan or the [reservationId, paidAt] index,
-- neither of which helps when the filter is {status: 'PAID', paidAt: {gte, lte}}.
CREATE INDEX IF NOT EXISTS "ReservationPayment_status_paidAt_idx" ON "ReservationPayment"("status", "paidAt");
