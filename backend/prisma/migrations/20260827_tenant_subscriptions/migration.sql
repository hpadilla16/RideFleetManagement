-- Tenant Subscriptions — Ride's own billing of its tenants (2026-08-27).
-- Additive + idempotent per the migration rules (startup-migrate applies this
-- on boot; mirrors 20260825_shuttle_phase3_core). INERT on deploy: four new
-- tables with no rows, and ONE nullable column on Tenant. Nothing about an
-- existing tenant changes until a subscription row is created by hand, and
-- nothing in this release can create one automatically.
--
-- Billing dates are VARCHAR(10) 'YYYY-MM-DD', not TIMESTAMP. ARB bills on a
-- calendar DAY in the merchant's own time; Puerto Rico is UTC-4, so a timestamp
-- rendered without an explicit UTC zone shows the day BEFORE the one that
-- actually charges. Text makes the value we send, store and render identical
-- and kills the bug class at the schema. Real instants stay TIMESTAMP(3).
--
-- NEVER A PAN in any column below. Only Authorize.Net handles, brand, last4.
-- The platform is PCI SAQ C certified and a card number here moves it to SAQ D.

CREATE TABLE IF NOT EXISTS "TenantSubscription" (
  "id"                         TEXT PRIMARY KEY,
  "tenantId"                   TEXT NOT NULL REFERENCES "Tenant"("id") ON DELETE RESTRICT,
  "planCode"                   TEXT NOT NULL,
  "planNameSnapshot"           TEXT NOT NULL,
  "amount"                     DECIMAL(10,2) NOT NULL,
  "currency"                   TEXT NOT NULL DEFAULT 'USD',
  "intervalUnit"               TEXT NOT NULL,
  "intervalLength"             INTEGER NOT NULL,
  "status"                     TEXT NOT NULL DEFAULT 'PENDING_AUTHORIZATION',
  "arbSubscriptionId"          TEXT,
  "customerProfileId"          TEXT,
  "customerPaymentProfileId"   TEXT,
  "cardBrand"                  TEXT,
  "cardLast4"                  VARCHAR(4),
  "cardExpMonth"               INTEGER,
  "cardExpYear"                INTEGER,
  "trialOccurrences"           INTEGER NOT NULL DEFAULT 0,
  "trialAmount"                DECIMAL(10,2),
  "trialEndsAt"                VARCHAR(10),
  "startDate"                  VARCHAR(10) NOT NULL,
  "nextChargeDate"             VARCHAR(10),
  "currentPeriodStart"         VARCHAR(10),
  "currentPeriodEnd"           VARCHAR(10),
  "pendingPlanCode"            TEXT,
  "pendingAmount"              DECIMAL(10,2),
  "pendingEffectiveDate"       VARCHAR(10),
  "failedAttempts"             INTEGER NOT NULL DEFAULT 0,
  "lastFailureCode"            TEXT,
  "lastFailureText"            TEXT,
  "lastFailureAt"              TIMESTAMP(3),
  "pastDueSince"               TIMESTAMP(3),
  "suspendedAt"                TIMESTAMP(3),
  "cancelledAt"                TIMESTAMP(3),
  "cancelReason"               TEXT,
  "cancelRequestedByUserId"    TEXT,
  "supersededBySubscriptionId" TEXT,
  "authorizedAt"               TIMESTAMP(3),
  "authorizedIp"               TEXT,
  "authorizedUserAgent"        VARCHAR(120),
  "authorizedEmail"            TEXT,
  "authorizedName"             TEXT,
  "authorizedDisclosureText"   TEXT,
  "authorizedDisclosureHash"   TEXT,
  "authorizedInviteId"         TEXT,
  "lastWebhookAt"              TIMESTAMP(3),
  "lastReconciledAt"           TIMESTAMP(3),
  "arbStatusSnapshot"          TEXT,
  "notes"                      TEXT,
  "createdByUserId"            TEXT,
  "createdAt"                  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"                  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS "TenantSubscription_arbSubscriptionId_key"
  ON "TenantSubscription" ("arbSubscriptionId");
CREATE INDEX IF NOT EXISTS "TenantSubscription_tenantId_createdAt_idx"
  ON "TenantSubscription" ("tenantId", "createdAt");
CREATE INDEX IF NOT EXISTS "TenantSubscription_status_nextChargeDate_idx"
  ON "TenantSubscription" ("status", "nextChargeDate");
CREATE INDEX IF NOT EXISTS "TenantSubscription_customerProfileId_idx"
  ON "TenantSubscription" ("customerProfileId");
CREATE INDEX IF NOT EXISTS "TenantSubscription_cardExp_idx"
  ON "TenantSubscription" ("cardExpYear", "cardExpMonth");

-- THE LOAD-BEARING INVARIANT: at most one LIVE subscription per tenant.
-- Prisma cannot express a partial unique index, so it lives here and ONLY
-- here. Terminal rows (cancelled/superseded/expired) are history and are
-- deliberately excluded so a cycle change can keep the old row.
-- WARNING: `prisma db push` / `migrate dev --create-only` will not know about
-- this index and a careless reset would drop it. Production applies raw SQL
-- through startup-migrate.js, so it survives there. Do not `db push` at prod.
CREATE UNIQUE INDEX IF NOT EXISTS "TenantSubscription_one_live_per_tenant"
  ON "TenantSubscription" ("tenantId")
  WHERE "status" NOT IN ('CANCELLED', 'SUPERSEDED', 'EXPIRED');

CREATE TABLE IF NOT EXISTS "TenantSubscriptionCharge" (
  "id"                  TEXT PRIMARY KEY,
  "subscriptionId"      TEXT NOT NULL REFERENCES "TenantSubscription"("id") ON DELETE RESTRICT,
  "tenantId"            TEXT NOT NULL,
  "kind"                TEXT NOT NULL,
  "status"              TEXT NOT NULL,
  "amount"              DECIMAL(10,2) NOT NULL,
  "currency"            TEXT NOT NULL DEFAULT 'USD',
  "transId"             TEXT,
  "refId"               TEXT,
  "arbSubscriptionId"   TEXT,
  "arbPaymentNum"       INTEGER,
  "authCode"            TEXT,
  "responseCode"        TEXT,
  "responseReasonCode"  TEXT,
  "responseReasonText"  TEXT,
  "avsResponse"         TEXT,
  "cardBrand"           TEXT,
  "cardLast4"           VARCHAR(4),
  "chargeDate"          VARCHAR(10) NOT NULL,
  "settledAt"           TIMESTAMP(3),
  "description"         TEXT NOT NULL,
  "periodStart"         VARCHAR(10),
  "periodEnd"           VARCHAR(10),
  "prorationDays"       INTEGER,
  "prorationDailyDelta" DECIMAL(10,4),
  "fromPlanCode"        TEXT,
  "toPlanCode"          TEXT,
  "fromAmount"          DECIMAL(10,2),
  "toAmount"            DECIMAL(10,2),
  "source"              TEXT NOT NULL,
  "sourceEventId"       TEXT,
  "actorUserId"         TEXT,
  "createdAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- transId unique is what makes a replayed webhook physically unable to
-- double-count revenue. refId unique is what makes a charge whose response we
-- never saw findable at Authorize.Net instead of retried blindly.
CREATE UNIQUE INDEX IF NOT EXISTS "TenantSubscriptionCharge_transId_key"
  ON "TenantSubscriptionCharge" ("transId");
CREATE UNIQUE INDEX IF NOT EXISTS "TenantSubscriptionCharge_refId_key"
  ON "TenantSubscriptionCharge" ("refId");
CREATE INDEX IF NOT EXISTS "TenantSubscriptionCharge_sub_date_idx"
  ON "TenantSubscriptionCharge" ("subscriptionId", "chargeDate");
CREATE INDEX IF NOT EXISTS "TenantSubscriptionCharge_tenant_created_idx"
  ON "TenantSubscriptionCharge" ("tenantId", "createdAt");
CREATE INDEX IF NOT EXISTS "TenantSubscriptionCharge_status_date_idx"
  ON "TenantSubscriptionCharge" ("status", "chargeDate");
CREATE INDEX IF NOT EXISTS "TenantSubscriptionCharge_arb_paymentnum_idx"
  ON "TenantSubscriptionCharge" ("arbSubscriptionId", "arbPaymentNum");

-- Created now, filled in Phase 2. The table lands with the rest so the schema
-- change is one migration rather than two, and so the receiver's contract is
-- already decided when it arrives.
CREATE TABLE IF NOT EXISTS "TenantSubscriptionEvent" (
  "id"                TEXT PRIMARY KEY,
  "notificationId"    TEXT NOT NULL,
  "eventType"         TEXT NOT NULL,
  "eventDate"         TIMESTAMP(3),
  "arbSubscriptionId" TEXT,
  "transId"           TEXT,
  "subscriptionId"    TEXT REFERENCES "TenantSubscription"("id") ON DELETE SET NULL,
  "payload"           JSONB NOT NULL,
  "signatureOk"       BOOLEAN NOT NULL DEFAULT TRUE,
  "receivedAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "processedAt"       TIMESTAMP(3),
  "processingError"   TEXT,
  "attempts"          INTEGER NOT NULL DEFAULT 0
);

-- The replay gate. INSERT ... ON CONFLICT DO NOTHING against this index is
-- how a redelivered webhook becomes a no-op instead of a second charge row.
CREATE UNIQUE INDEX IF NOT EXISTS "TenantSubscriptionEvent_notificationId_key"
  ON "TenantSubscriptionEvent" ("notificationId");
CREATE INDEX IF NOT EXISTS "TenantSubscriptionEvent_type_received_idx"
  ON "TenantSubscriptionEvent" ("eventType", "receivedAt");
CREATE INDEX IF NOT EXISTS "TenantSubscriptionEvent_arb_received_idx"
  ON "TenantSubscriptionEvent" ("arbSubscriptionId", "receivedAt");
CREATE INDEX IF NOT EXISTS "TenantSubscriptionEvent_processedAt_idx"
  ON "TenantSubscriptionEvent" ("processedAt");

-- tokenHash, never token. The plaintext is generated once, put in the link and
-- never persisted — same rule as Tenant.websiteTokenHash. A DB dump of
-- plaintext autopay tokens would let the holder enroll a card against a tenant
-- and read that tenant's plan and price.
CREATE TABLE IF NOT EXISTS "AutopayInvite" (
  "id"                       TEXT PRIMARY KEY,
  "tokenHash"                TEXT NOT NULL,
  "tokenPrefix"              VARCHAR(8) NOT NULL,
  "mode"                     TEXT NOT NULL DEFAULT 'enroll',
  "tenantId"                 TEXT NOT NULL,
  "subscriptionId"           TEXT REFERENCES "TenantSubscription"("id") ON DELETE SET NULL,
  "merchantCustomerId"       VARCHAR(20) NOT NULL,
  "email"                    TEXT NOT NULL,
  "companyName"              TEXT NOT NULL,
  "planCode"                 TEXT NOT NULL,
  "planName"                 TEXT NOT NULL,
  "amount"                   DECIMAL(10,2) NOT NULL,
  "intervalUnit"             TEXT NOT NULL DEFAULT 'months',
  "intervalLength"           INTEGER NOT NULL DEFAULT 1,
  "startDate"                VARCHAR(10) NOT NULL,
  "nextChargeDate"           VARCHAR(10),
  "trialOccurrences"         INTEGER NOT NULL DEFAULT 0,
  "trialAmount"              DECIMAL(10,2),
  "customerProfileId"        TEXT,
  "customerPaymentProfileId" TEXT,
  "arbSubscriptionId"        TEXT,
  "cardBrand"                TEXT,
  "cardLast4"                VARCHAR(4),
  "disclosureText"           TEXT NOT NULL,
  "disclosureHash"           TEXT NOT NULL,
  "expiresAt"                TIMESTAMP(3) NOT NULL,
  "usedAt"                   TIMESTAMP(3),
  "revokedAt"                TIMESTAMP(3),
  "openedAt"                 TIMESTAMP(3),
  "attempts"                 INTEGER NOT NULL DEFAULT 0,
  "createdByUserId"          TEXT,
  "createdAt"                TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"                TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS "AutopayInvite_tokenHash_key"
  ON "AutopayInvite" ("tokenHash");
CREATE INDEX IF NOT EXISTS "AutopayInvite_tenant_created_idx"
  ON "AutopayInvite" ("tenantId", "createdAt");
CREATE INDEX IF NOT EXISTS "AutopayInvite_subscriptionId_idx"
  ON "AutopayInvite" ("subscriptionId");
CREATE INDEX IF NOT EXISTS "AutopayInvite_expiresAt_idx"
  ON "AutopayInvite" ("expiresAt");

-- Distinguishes "suspended because they did not pay" from "suspended by a
-- human for some other reason". Automation may ONLY clear a suspension it set,
-- so a payment landing can never silently un-suspend a tenant somebody switched
-- off deliberately. NULL for every existing tenant — no behaviour change, and
-- nothing reads this column until the suspension gate ships in a later phase.
ALTER TABLE "Tenant"
  ADD COLUMN IF NOT EXISTS "billingSuspendedAt" TIMESTAMP(3);
