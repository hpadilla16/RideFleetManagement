-- VozIA service integration (2026-07-03) — Fases 3 + 4.
--
-- 1) User: service-account identity + token versioning. isServiceAccount
--    marks machine accounts (the VozIA voice agent); their JWTs carry
--    svc/tv claims and are checked against tokenVersion in requireAuth,
--    so bumping tokenVersion revokes every outstanding service token at
--    once. Human users are untouched (defaults: false / 0).
-- 2) IdempotencyKey: per-user idempotency ledger for VozIA write endpoints
--    (POST /reservations/:id/notes today; payments in Fase 6). One row per
--    (userId, key); replay returns the stored response. 24h TTL, cleaned
--    opportunistically on insert.
--
-- Additive only. Idempotent — safe to re-run. Normally applied AUTOMATICALLY
-- at boot by the startup-migrate runner (backend/src/lib/startup-migrate.js,
-- AUTO_MIGRATE_ON_BOOT, pgbouncer-safe), so deploy = build + recreate with no
-- manual step. It is also safe to pre-apply by pasting into the Supabase SQL
-- editor — the runner will re-execute the idempotent SQL and record it.

-- 1. User columns ---------------------------------------------------------------
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "isServiceAccount" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "tokenVersion" INTEGER NOT NULL DEFAULT 0;

-- 2. IdempotencyKey table -------------------------------------------------------
-- Matches `prisma migrate diff --from-empty --to-schema-datamodel` output for
-- the model (reconciled 2026-07-03), wrapped in IF NOT EXISTS guards. No FK on
-- userId by design — the ledger must survive user deletion for audit purposes.
CREATE TABLE IF NOT EXISTS "IdempotencyKey" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "userId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "statusCode" INTEGER,
    "responseBody" TEXT,
    "status" TEXT NOT NULL DEFAULT 'IN_PROGRESS',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IdempotencyKey_pkey" PRIMARY KEY ("id")
);

-- 3. Indexes --------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS "IdempotencyKey_userId_key_key" ON "IdempotencyKey"("userId", "key");
CREATE INDEX IF NOT EXISTS "IdempotencyKey_userId_kind_createdAt_idx" ON "IdempotencyKey"("userId", "kind", "createdAt");
