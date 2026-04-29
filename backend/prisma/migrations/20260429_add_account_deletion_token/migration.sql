-- Sprint 8: in-app account deletion (Apple guideline 5.1.1 compliance).
-- Adds two nullable columns to Customer for the deletion-confirmation
-- email flow. Token is single-use; expires 24h after request.

ALTER TABLE "Customer"
  ADD COLUMN IF NOT EXISTS "deletionToken"          TEXT,
  ADD COLUMN IF NOT EXISTS "deletionTokenExpiresAt" TIMESTAMP(3);

CREATE UNIQUE INDEX IF NOT EXISTS "Customer_deletionToken_key"
  ON "Customer"("deletionToken");
