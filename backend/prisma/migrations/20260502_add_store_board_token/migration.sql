-- Action Board kiosk tokens — one row per TV display authorized to read
-- pickups/returns for one (tenant, location) pair. Tokens are long-lived
-- by design (TV stays plugged in; the URL bookmark IS the auth). Tenant +
-- Location stored as plain string IDs to keep this model self-contained;
-- isolation is enforced at the service layer.
--
-- Idempotent: IF NOT EXISTS guards match the rest of the migrations folder
-- so running this against an already-migrated environment is safe.

CREATE TABLE IF NOT EXISTS "StoreBoardToken" (
  "id"          TEXT         NOT NULL,
  "tenantId"    TEXT         NOT NULL,
  "locationId"  TEXT         NOT NULL,
  "label"       TEXT         NOT NULL,
  -- 32-char URL-safe random string. Generated server-side, never hashed.
  -- Unique constraint enforces lookup-by-token; the URL itself is the auth.
  "token"       TEXT         NOT NULL,
  -- Optional pointer to the User who minted this token, for audit. Stored
  -- as plain string (no FK) so user deletion doesn't cascade-delete tokens.
  "createdBy"   TEXT,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- Bumped on every successful kiosk fetch. Lets the admin see "last seen
  -- 3 min ago" and detect a TV that lost connection.
  "lastSeenAt"  TIMESTAMP(3),
  -- Soft-delete. Set when admin revokes; row stays for audit history.
  -- Service refuses to serve data when revokedAt is non-null.
  "revokedAt"   TIMESTAMP(3),

  CONSTRAINT "StoreBoardToken_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "StoreBoardToken_token_key"
  ON "StoreBoardToken"("token");

CREATE INDEX IF NOT EXISTS "StoreBoardToken_tenantId_idx"
  ON "StoreBoardToken"("tenantId");

CREATE INDEX IF NOT EXISTS "StoreBoardToken_locationId_idx"
  ON "StoreBoardToken"("locationId");
