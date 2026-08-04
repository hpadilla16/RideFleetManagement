-- 2026-08-05 (Hector) — tolls covered by a prepaid toll package get their own
-- billing state instead of masquerading as POSTED_TO_RESERVATION. Fixes the
-- dashboard "Pending tolls" tile counting 900+ prepaid crossings as
-- uncollected money for International Rental Corp.
-- Additive + idempotent: safe under AUTO_MIGRATE_ON_BOOT re-runs.
ALTER TYPE "TollBillingStatus" ADD VALUE IF NOT EXISTS 'COVERED_BY_PACKAGE';
