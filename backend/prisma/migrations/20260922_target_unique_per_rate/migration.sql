-- A brand needs one target per RATE, not one in total (2026-09-09).
--
-- The original key was (profileId, franchiseId), which assumed a brand's prices
-- live in ONE Rate holding every class. That is not how these sedes are built:
-- LAX keeps a separate single-class Rate per class — LAX_CCAR_DAILY,
-- LAX_ICAR_DAILY and five more — so a brand covering its seven classes needs
-- seven rows. Under the old key it could have priced exactly one class, and the
-- second row would have been refused with a confusing "already has a target".
--
-- The engine never needed the narrower key: resolveProfileTargets already
-- returns a list, applyRunSuggestions already writes one Rate per target, and
-- selectRatesForFranchise already reads back every rate a brand owns.
--
-- Re-runnable.
DROP INDEX IF EXISTS "MarketScrapeProfileTarget_profileId_franchiseId_key";

CREATE UNIQUE INDEX IF NOT EXISTS "MarketScrapeProfileTarget_profileId_franchiseId_rateId_key"
  ON "MarketScrapeProfileTarget"("profileId", "franchiseId", "rateId");
