-- Interactive T&C + Dejavoo P1 — unified signing model (2026-05-21)
--
-- Idempotent migration (safe to run twice). Adds:
--   - TermsFieldKind enum
--   - TermsTemplate + TermsTemplateField tables (per-tenant T&C with field markers)
--   - ReservationSigning + ReservationSigningField tables (signed evidence)
--   - DejavooTerminal + DejavooTransaction tables (counter payment terminal)
--   - Reservation.signingCompletedAt column
--
-- Companion: doc/interactive-tc-and-dejavoo-unified-2026-05-21.md
-- Feature-flag spec: doc/feature-flag-convention.md

-- ============================================================================
-- Enum: TermsFieldKind
-- ============================================================================
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'TermsFieldKind') THEN
    CREATE TYPE "TermsFieldKind" AS ENUM ('INITIAL', 'SIGNATURE', 'CHECKBOX', 'TEXT_FIELD', 'DATE');
  END IF;
END$$;

-- ============================================================================
-- Reservation.signingCompletedAt
-- ============================================================================
ALTER TABLE "Reservation"
  ADD COLUMN IF NOT EXISTS "signingCompletedAt" TIMESTAMP(3);

-- ============================================================================
-- Table: TermsTemplate
-- ============================================================================
CREATE TABLE IF NOT EXISTS "TermsTemplate" (
  "id"              TEXT PRIMARY KEY,
  "tenantId"        TEXT NOT NULL,
  "name"            TEXT NOT NULL,
  "version"         TEXT NOT NULL,
  "isActive"        BOOLEAN NOT NULL DEFAULT FALSE,
  "contentHtml"     TEXT NOT NULL,
  "contentLanguage" TEXT NOT NULL DEFAULT 'both',
  "effectiveDate"   TIMESTAMP(3) NOT NULL,
  "createdByUserId" TEXT,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT NOW(),
  "updatedAt"       TIMESTAMP(3) NOT NULL DEFAULT NOW(),
  CONSTRAINT "TermsTemplate_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "TermsTemplate_tenantId_version_key"
  ON "TermsTemplate"("tenantId", "version");
CREATE INDEX IF NOT EXISTS "TermsTemplate_tenantId_isActive_idx"
  ON "TermsTemplate"("tenantId", "isActive");

-- ============================================================================
-- Table: TermsTemplateField
-- ============================================================================
CREATE TABLE IF NOT EXISTS "TermsTemplateField" (
  "id"                  TEXT PRIMARY KEY,
  "templateId"          TEXT NOT NULL,
  "kind"                "TermsFieldKind" NOT NULL,
  "label"               TEXT NOT NULL,
  "markerKey"           TEXT NOT NULL,
  "required"            BOOLEAN NOT NULL DEFAULT TRUE,
  "order"               INTEGER NOT NULL DEFAULT 0,
  "terminalContextText" TEXT,
  "terminalPromptText"  TEXT,
  CONSTRAINT "TermsTemplateField_templateId_fkey"
    FOREIGN KEY ("templateId") REFERENCES "TermsTemplate"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "TermsTemplateField_templateId_markerKey_key"
  ON "TermsTemplateField"("templateId", "markerKey");
CREATE INDEX IF NOT EXISTS "TermsTemplateField_templateId_order_idx"
  ON "TermsTemplateField"("templateId", "order");

-- ============================================================================
-- Table: DejavooTerminal
-- ============================================================================
CREATE TABLE IF NOT EXISTS "DejavooTerminal" (
  "id"             TEXT PRIMARY KEY,
  "tenantId"       TEXT NOT NULL,
  "name"           TEXT NOT NULL,
  "tpn"            TEXT NOT NULL,
  "authKeyEnc"     TEXT,
  "merchantNumber" INTEGER NOT NULL DEFAULT 1,
  "callbackUrl"    TEXT,
  "sandbox"        BOOLEAN NOT NULL DEFAULT TRUE,
  "status"         TEXT NOT NULL DEFAULT 'ACTIVE',
  "lastSeenAt"     TIMESTAMP(3),
  "notes"          TEXT,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT NOW(),
  "updatedAt"      TIMESTAMP(3) NOT NULL DEFAULT NOW(),
  CONSTRAINT "DejavooTerminal_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "DejavooTerminal_tenantId_tpn_key"
  ON "DejavooTerminal"("tenantId", "tpn");
CREATE INDEX IF NOT EXISTS "DejavooTerminal_tenantId_status_idx"
  ON "DejavooTerminal"("tenantId", "status");

-- ============================================================================
-- Table: ReservationSigning
-- ============================================================================
CREATE TABLE IF NOT EXISTS "ReservationSigning" (
  "id"                      TEXT PRIMARY KEY,
  "reservationId"           TEXT NOT NULL,
  "templateId"              TEXT NOT NULL,
  "templateVersionSnapshot" TEXT NOT NULL,
  "surfaceUsed"             TEXT NOT NULL,
  "dejavooTerminalId"       TEXT,
  "startedAt"               TIMESTAMP(3) NOT NULL DEFAULT NOW(),
  "completedAt"             TIMESTAMP(3),
  "refusedAt"               TIMESTAMP(3),
  "refusalReason"           TEXT,
  "agentUserId"             TEXT NOT NULL,
  "customerName"            TEXT NOT NULL,
  "customerLicense"         TEXT,
  "customerCardLast4"       TEXT,
  "ipAddress"               TEXT,
  "userAgent"               TEXT,
  "signedPdfStoragePath"    TEXT,
  "receiptStoragePath"      TEXT,
  "createdAt"               TIMESTAMP(3) NOT NULL DEFAULT NOW(),
  "updatedAt"               TIMESTAMP(3) NOT NULL DEFAULT NOW(),
  CONSTRAINT "ReservationSigning_reservationId_fkey"
    FOREIGN KEY ("reservationId") REFERENCES "Reservation"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "ReservationSigning_templateId_fkey"
    FOREIGN KEY ("templateId") REFERENCES "TermsTemplate"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "ReservationSigning_dejavooTerminalId_fkey"
    FOREIGN KEY ("dejavooTerminalId") REFERENCES "DejavooTerminal"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "ReservationSigning_agentUserId_fkey"
    FOREIGN KEY ("agentUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "ReservationSigning_reservationId_key"
  ON "ReservationSigning"("reservationId");
CREATE INDEX IF NOT EXISTS "ReservationSigning_templateId_idx"
  ON "ReservationSigning"("templateId");
CREATE INDEX IF NOT EXISTS "ReservationSigning_agentUserId_idx"
  ON "ReservationSigning"("agentUserId");

-- ============================================================================
-- Table: DejavooTransaction
-- ============================================================================
CREATE TABLE IF NOT EXISTS "DejavooTransaction" (
  "id"                   TEXT PRIMARY KEY,
  "tenantId"             TEXT NOT NULL,
  "terminalId"           TEXT NOT NULL,
  "reservationId"        TEXT,
  "signingId"            TEXT,
  "type"                 TEXT NOT NULL,
  "referenceId"          TEXT NOT NULL,
  "amountCents"          INTEGER,
  "invoiceNumber"        TEXT,
  "customLabel"          TEXT,
  "requestJson"          JSONB NOT NULL,
  "responseJson"         JSONB,
  "rawResponse"          JSONB,
  "statusCode"           TEXT,
  "resultCode"           INTEGER,
  "approved"             BOOLEAN NOT NULL DEFAULT FALSE,
  "authCode"             TEXT,
  "iposToken"            TEXT,
  "cardLast4"            TEXT,
  "cardBrand"            TEXT,
  "cardEntryType"        TEXT,
  "errorMessage"         TEXT,
  "signatureStoragePath" TEXT,
  "parentTransactionId"  TEXT,
  "startedAt"            TIMESTAMP(3) NOT NULL DEFAULT NOW(),
  "completedAt"          TIMESTAMP(3),
  "callbackReceivedAt"   TIMESTAMP(3),
  "createdAt"            TIMESTAMP(3) NOT NULL DEFAULT NOW(),
  "updatedAt"            TIMESTAMP(3) NOT NULL DEFAULT NOW(),
  CONSTRAINT "DejavooTransaction_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "DejavooTransaction_terminalId_fkey"
    FOREIGN KEY ("terminalId") REFERENCES "DejavooTerminal"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "DejavooTransaction_reservationId_fkey"
    FOREIGN KEY ("reservationId") REFERENCES "Reservation"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "DejavooTransaction_signingId_fkey"
    FOREIGN KEY ("signingId") REFERENCES "ReservationSigning"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "DejavooTransaction_parentTransactionId_fkey"
    FOREIGN KEY ("parentTransactionId") REFERENCES "DejavooTransaction"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "DejavooTransaction_referenceId_key"
  ON "DejavooTransaction"("referenceId");
CREATE INDEX IF NOT EXISTS "DejavooTransaction_tenantId_createdAt_idx"
  ON "DejavooTransaction"("tenantId", "createdAt");
CREATE INDEX IF NOT EXISTS "DejavooTransaction_reservationId_type_idx"
  ON "DejavooTransaction"("reservationId", "type");
CREATE INDEX IF NOT EXISTS "DejavooTransaction_referenceId_idx"
  ON "DejavooTransaction"("referenceId");
CREATE INDEX IF NOT EXISTS "DejavooTransaction_signingId_idx"
  ON "DejavooTransaction"("signingId");

-- ============================================================================
-- Table: ReservationSigningField  (depends on DejavooTransaction)
-- ============================================================================
CREATE TABLE IF NOT EXISTS "ReservationSigningField" (
  "id"                   TEXT PRIMARY KEY,
  "signingId"            TEXT NOT NULL,
  "templateFieldId"      TEXT NOT NULL,
  "value"                TEXT,
  "signatureSvgOrPath"   TEXT,
  "signedAt"             TIMESTAMP(3),
  "dejavooTransactionId" TEXT,
  CONSTRAINT "ReservationSigningField_signingId_fkey"
    FOREIGN KEY ("signingId") REFERENCES "ReservationSigning"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ReservationSigningField_templateFieldId_fkey"
    FOREIGN KEY ("templateFieldId") REFERENCES "TermsTemplateField"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "ReservationSigningField_dejavooTransactionId_fkey"
    FOREIGN KEY ("dejavooTransactionId") REFERENCES "DejavooTransaction"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "ReservationSigningField_signingId_templateFieldId_key"
  ON "ReservationSigningField"("signingId", "templateFieldId");
CREATE INDEX IF NOT EXISTS "ReservationSigningField_signingId_idx"
  ON "ReservationSigningField"("signingId");
