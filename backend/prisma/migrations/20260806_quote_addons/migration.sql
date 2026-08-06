-- 2026-08-06 (Hector) — quotes become staff-editable: additional services and
-- insurance plans chosen after the quote was created. The VozIA phone flow is
-- untouched: it never sets this column, and a NULL here renders the exact
-- pre-feature shape.
-- Additive + idempotent: safe under AUTO_MIGRATE_ON_BOOT re-runs.
ALTER TABLE "Quote" ADD COLUMN IF NOT EXISTS "addOnsJson" TEXT;
