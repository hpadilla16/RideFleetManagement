-- 2026-08-06 (Hector) — "Check" as a first-class payment method: checkout
-- step 3 and manual payment entry. The checkout wizard's deposit modals were
-- already OFFERING Check, but the enum lacked it, so sanitizePaymentMethod
-- silently collapsed those payments to OTHER — the method was being lost at
-- the door.
-- Additive + idempotent: safe under AUTO_MIGRATE_ON_BOOT re-runs.
ALTER TYPE "AgreementPaymentMethod" ADD VALUE IF NOT EXISTS 'CHECK';
