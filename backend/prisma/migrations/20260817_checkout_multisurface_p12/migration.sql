-- M2 PR-tren P1+P2 (Hector-approved 2026-08-17, ops-app-plan/M2-PLAN.md §1.2).
-- Multi-surface checkout substrate: soft presence (P1) + optimistic version
-- counter (P2). Additive + idempotent — safe under the startup migrator's
-- retry-on-next-boot semantics. Inert on deploy for existing clients: nothing
-- reads CheckoutPresence until a surface heartbeats, and stateVersion only
-- matters to callers that send expectedVersion (none do until M2-H6).

-- P2 — optimistic version counter, bumped on transition / stamp / signature.
ALTER TABLE "CheckoutSession"
  ADD COLUMN IF NOT EXISTS "stateVersion" INTEGER NOT NULL DEFAULT 0;

-- P1 — surface enum. DO-block guard because CREATE TYPE has no IF NOT EXISTS.
DO $$ BEGIN
  CREATE TYPE "CheckoutSurface" AS ENUM ('RIDEOPS', 'COUNTER', 'KIOSK', 'CUSTOMER');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- P1 — presence rows. sessionId is a LOOSE reference (no FK) on purpose,
-- mirroring KioskSession.checkoutSessionId: presence is telemetry and must
-- never be able to block or break a CheckoutSession write.
CREATE TABLE IF NOT EXISTS "CheckoutPresence" (
  "id"           TEXT PRIMARY KEY,
  "sessionId"    TEXT NOT NULL,
  "surface"      "CheckoutSurface" NOT NULL,
  "actorUserId"  TEXT,
  "displayLabel" TEXT,
  "lastSeenAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- One row per (session, surface, actor). Postgres treats NULLs as DISTINCT in
-- a plain unique index, so the null-actor writers (kiosk device, customer
-- phone) get their own partial unique index — without it every kiosk
-- heartbeat race could mint a duplicate row.
CREATE UNIQUE INDEX IF NOT EXISTS "CheckoutPresence_sessionId_surface_actorUserId_key"
  ON "CheckoutPresence" ("sessionId", "surface", "actorUserId");
CREATE UNIQUE INDEX IF NOT EXISTS "CheckoutPresence_session_surface_nullactor_key"
  ON "CheckoutPresence" ("sessionId", "surface") WHERE "actorUserId" IS NULL;

-- Read path is always "fresh rows for one session" (TTL filter at read time).
CREATE INDEX IF NOT EXISTS "CheckoutPresence_sessionId_lastSeenAt_idx"
  ON "CheckoutPresence" ("sessionId", "lastSeenAt");
