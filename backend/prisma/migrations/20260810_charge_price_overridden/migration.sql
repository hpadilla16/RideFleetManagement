-- A price a human typed on THIS reservation must not be re-derived from the
-- settings catalog (Hector, 2026-08-10).
--
-- The editor rebuilt every additional-service row from AdditionalService each
-- time it opened, so a rate the agent had set was replaced by the configured
-- one and written back on the next Save Override.
--
-- The flag has to be STORED rather than inferred. Comparing the saved rate to
-- the catalog looks like it would work and does not: change a service's price
-- in settings and every untouched reservation suddenly "differs" from the
-- catalog and would freeze at its old rate — the opposite of what a settings
-- change is for.
--
-- Additive and idempotent: existing rows default to false, i.e. "nobody has
-- touched this", which is the correct reading of every row written before the
-- flag existed.
ALTER TABLE "ReservationCharge"
  ADD COLUMN IF NOT EXISTS "priceOverridden" BOOLEAN NOT NULL DEFAULT false;
