-- Round 22 — Reservation.rentalFeeCollectedAt + rentalFeeCollectedCents
--
-- Idempotent. Tracks when + how much the SALE-at-pickup collected for the
-- rental fee. Set by counter-orchestrator after the SALE succeeds and
-- BEFORE the AUTH deposit.

ALTER TABLE "Reservation"
  ADD COLUMN IF NOT EXISTS "rentalFeeCollectedAt"    TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "rentalFeeCollectedCents" INTEGER;
