-- Structured prepaid flag on the promoted Reservation (2026-07-09).
--
-- Companion to 20260709_nu_integration (which added ExternalReservation.isPrepaid).
-- Sorts AFTER that migration by directory name (…_nu_integration < …_reservation_isprepaid),
-- so the source column exists first; this one lands the same signal on the
-- promoted Reservation so the counter's "pay-at-destination" badge can read a
-- structured boolean instead of a brittle notes-string marker.
--
-- Additive + idempotent — ADD COLUMN IF NOT EXISTS, safe to re-run and safe
-- under the multi-worker boot-apply (startup-migrate) race. Migrate via the
-- SESSION port 5432, never pgbouncer.
--
-- MONEY: informational only. NU carries a prepaid MIX (PP/OP = prepaid, blank
-- Code = pay-at-destination); every other source leaves this NULL (TL/Economy =
-- all prepaid, staff-created = n/a) → zero behavior change. Ride still records
-- estimatedTotal only and NEVER charges on import.
ALTER TABLE "Reservation"
  ADD COLUMN IF NOT EXISTS "isPrepaid" BOOLEAN;
