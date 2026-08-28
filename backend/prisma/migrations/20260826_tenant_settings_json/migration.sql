-- Tenant."settingsJson" — schema/DB drift repair. 2026-08-26.
--
-- The COLUMN already exists in production (jsonb) and has existed since before
-- the startup-migrate runner; it was simply never declared in schema.prisma.
-- Prisma therefore rejected every `select: { settingsJson: true }` on Tenant at
-- runtime, so the per-tenant config it holds has never taken effect:
--   * sms.service.js            getTenantSmsConfig   (smsProvider / smsFromNumber / creds)
--   * payment-gateway.service.js getTenantSpinConfig (spinAuthKey / spinTpn / spinSandbox …)
--
-- This migration exists to make the schema reproducible from scratch (fresh dev
-- DBs, tenant_<slug> schemas, disaster restore). In production it is a NO-OP:
-- ADD COLUMN IF NOT EXISTS finds the column already there and changes nothing.
--
-- Additive + idempotent per the migration rules. Nullable, no default, no
-- backfill, no type change, no drop — every existing Tenant row stays valid and
-- re-running this is a no-op.
ALTER TABLE "Tenant"
  ADD COLUMN IF NOT EXISTS "settingsJson" JSONB;

-- ADD COLUMN IF NOT EXISTS is silent about the type of a column that already
-- exists. If some environment created it as text/json instead of jsonb, Prisma's
-- `Json?` mapping would be wrong there and we want to hear about it on boot.
-- WARNING, not EXCEPTION, on purpose: startup-migrate treats a throw as a failed
-- migration and retries it every boot forever. Both readers already accept a
-- JSON string as well as an object, so a mismatch degrades, it does not break.
DO $$
DECLARE actual_type text;
BEGIN
  SELECT data_type INTO actual_type
    FROM information_schema.columns
   WHERE table_schema = current_schema()
     AND table_name = 'Tenant'
     AND column_name = 'settingsJson';
  IF actual_type IS DISTINCT FROM 'jsonb' THEN
    RAISE WARNING '[20260826_tenant_settings_json] Tenant."settingsJson" is % in schema %, expected jsonb (Prisma maps it as Json?)',
      COALESCE(actual_type, 'MISSING'), current_schema();
  END IF;
END $$;
