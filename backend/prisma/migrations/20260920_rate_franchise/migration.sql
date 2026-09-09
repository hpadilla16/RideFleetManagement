-- Which brand's shelf a rate prices (2026-09-09).
--
-- Hector: "el objetivo es distinguir por franquicia para que los precios que
-- son de MEX, escriban a MEX directamente y que los de zezgo escriban al de
-- zezgo cuando prendemos el rate writeback".
--
-- NULL means SHARED — belonging to every brand — which is what all 100% of
-- existing rates are. Nothing changes until a sede deliberately splits its
-- pricing, so this is inert on arrival.
--
-- NOTE the ordering constraint this column comes with: the rate writebacks
-- drop any class two active rates disagree about. Until they understand
-- franchises, creating one rate per brand at a sede would make EVERY class
-- ambiguous and publish nothing. The code that reads this column ships in the
-- same commit, ahead of any data using it.
--
-- Re-runnable.
ALTER TABLE "Rate"
  ADD COLUMN IF NOT EXISTS "franchiseId" TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'Rate_franchiseId_fkey'
  ) THEN
    ALTER TABLE "Rate"
      ADD CONSTRAINT "Rate_franchiseId_fkey"
      FOREIGN KEY ("franchiseId") REFERENCES "Franchise"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

-- The writebacks filter by (location, franchise) on every run.
CREATE INDEX IF NOT EXISTS "Rate_franchiseId_idx" ON "Rate"("franchiseId");
