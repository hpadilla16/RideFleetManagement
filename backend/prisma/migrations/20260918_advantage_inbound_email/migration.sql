-- Advantage reservation ingestion by EMAIL (2026-09-08) — the inbound-message
-- ledger.
--
-- Ryan White (IT Manager, Advantage Car Rental): "Since there is no TSD
-- integration, everything will need to be done VIA email delivery." Every other
-- booking source in RFM is a portal scraper; this account has no portal to
-- scrape, so confirmations arrive as text emails polled out of a dedicated IMAP
-- mailbox.
--
-- The BOOKINGS themselves still land in "ExternalReservation" under
-- sourceSystem 'ADVANTAGE' and promote through the shared promoter — this table
-- is the TRANSPORT ledger, not a second staging area:
--   * (tenantId, messageId) unique = message-level idempotency, so a re-delivery
--     or a run that dies between fetching and flagging cannot double-import;
--     bodyHash distinguishes an identical re-send (skip) from a regenerated
--     snapshot under the same Message-ID (re-parse).
--   * quarantined messages (unknown banner, unconfigured branch, unreadable
--     layout) are recorded WITH their reason instead of being dropped.
--
-- "rawBody" is the verbatim message and holds renter PII (name, phone, email).
-- It is kept only to diagnose and replay a mis-parse; the existing retention
-- sweep NULLs it at RETENTION_INBOUND_EMAIL_DAYS (default 90) and stamps
-- "rawPurgedAt".
--
-- Additive and re-runnable. No existing table is touched, so this is inert
-- until the feature flag and a tenant's mailbox credential are both set.

CREATE TABLE IF NOT EXISTS "AdvantageInboundEmail" (
  "id"            TEXT NOT NULL,
  "tenantId"      TEXT NOT NULL,
  "messageId"     TEXT NOT NULL,
  "bodyHash"      TEXT NOT NULL,
  "receivedAt"    TIMESTAMP(3) NOT NULL,
  "fromAddress"   TEXT,
  "subject"       TEXT,
  "docType"       TEXT,
  "docTypeRaw"    TEXT,
  "externalRef"   TEXT,
  "tsdNumber"     TEXT,
  "branch"        TEXT,
  "status"        TEXT NOT NULL,
  "failureReason" TEXT,
  "failureDetail" TEXT,
  "rawBody"       TEXT,
  "rawPurgedAt"   TIMESTAMP(3),
  "parsedJson"    JSONB,
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AdvantageInboundEmail_pkey" PRIMARY KEY ("id")
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'AdvantageInboundEmail_tenantId_fkey'
  ) THEN
    ALTER TABLE "AdvantageInboundEmail"
      ADD CONSTRAINT "AdvantageInboundEmail_tenantId_fkey"
      FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "AdvantageInboundEmail_tenantId_messageId_key"
  ON "AdvantageInboundEmail" ("tenantId", "messageId");

CREATE INDEX IF NOT EXISTS "AdvantageInboundEmail_tenantId_receivedAt_idx"
  ON "AdvantageInboundEmail" ("tenantId", "receivedAt" DESC);

CREATE INDEX IF NOT EXISTS "AdvantageInboundEmail_tenantId_status_idx"
  ON "AdvantageInboundEmail" ("tenantId", "status");

-- The retention sweep selects on this: rows whose raw body has not been purged
-- yet. Partial so the index only ever holds the un-purged population.
CREATE INDEX IF NOT EXISTS "AdvantageInboundEmail_rawPurgedAt_idx"
  ON "AdvantageInboundEmail" ("rawPurgedAt");
