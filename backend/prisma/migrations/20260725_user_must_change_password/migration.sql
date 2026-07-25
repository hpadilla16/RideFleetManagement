-- 2026-07-25 - first-login onboarding: forced password change.
--
-- WHY: staff accounts are created with a temp password (peopleService.create
-- -> randomTempPassword + invite email that PROMISES "change your password
-- after your first login") and admin resets mint another temp password --
-- but no self-service change-password existed, so temp passwords lived
-- forever. 33 LAX staff accounts are about to be seeded this way.
--
-- WHAT: two additive columns on "User".
--   mustChangePassword: true whenever someone OTHER than the user knows the
--     password. requireAuth 403s (code PASSWORD_CHANGE_REQUIRED) everything
--     but the change-password allowlist while true.
--   passwordChangedAt: when the user last chose their OWN password
--     (NULL = never; existing users stay NULL and are NOT forced -- the flag
--     only turns on at the three temp-password sites going forward).
--
-- Additive + idempotent (IF NOT EXISTS is REQUIRED: startup-migrate is
-- fail-open and retries every boot; multiple workers race to apply). A
-- BOOLEAN NOT NULL DEFAULT false and a nullable timestamp are metadata-only
-- in PG 11+, no table rewrite. Migrate via SESSION port 5432, never
-- pgbouncer 6543.

ALTER TABLE "User"
  ADD COLUMN IF NOT EXISTS "mustChangePassword" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "User"
  ADD COLUMN IF NOT EXISTS "passwordChangedAt" TIMESTAMPTZ;
