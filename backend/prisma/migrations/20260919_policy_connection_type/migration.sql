-- Per-integration GDS connection type (2026-09-08).
--
-- Market Intelligence back-solves ONE base per class using the sede's single
-- connectionType, and every writeback pushes that same number. Titanium
-- compounds tax and brokerage while Amadeus adds them, so the same base reaches
-- a different customer-facing price on each — and a sede running one
-- integration on each connection can only have one of them correctly placed.
--
-- NULL means "inherit the sede", which is every existing row, so this is inert
-- until somebody says an integration differs. Re-runnable.
ALTER TABLE "IntegrationPricePolicy"
  ADD COLUMN IF NOT EXISTS "connectionType" TEXT;
