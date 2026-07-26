-- 2026-07-26 - citation ingest guards (Orlando-on-LAX bug). MONEY-ADJACENT:
-- auto-matching posts charges, so a wrong match bills the wrong customer.
--
-- WHY: 38 citations labeled "City of Orlando" attached to LAX vehicles.
-- The plate binds were CORRECT (CA plates, real LAX cars, no twin plates in
-- any tenant) - the agency was mislabeled upstream - but the incident
-- exposed two real holes in the ingest: (1) the plate map is tenant-wide
-- first-write-wins, so two branches sharing a normalized plate would
-- silently misattribute + auto-bill; (2) nothing sanity-checks the
-- citation's geography (agency / plate state) against the vehicle's home
-- state. Both now hold the citation for review instead of auto-matching,
-- and this column records WHY.
--
-- Additive + idempotent (IF NOT EXISTS REQUIRED: startup-migrate is
-- fail-open, workers race). Migrate via SESSION port 5432, never 6543.

ALTER TABLE "Citation"
  ADD COLUMN IF NOT EXISTS "holdReason" TEXT;
