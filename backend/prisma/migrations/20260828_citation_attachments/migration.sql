-- 2026-08-28 — supporting documents attached TO a citation.
--
-- WHY: a disputed citation generates paperwork — the agency's notice, proof
-- that it was paid, the dispute letter we sent, the agency's reply, the
-- renter's signed acknowledgement. Today that lives in someone's inbox, and
-- when the agency asks for the file there is nothing to send. This table holds
-- it against the citation, and the export endpoint turns it into one PDF.
--
-- WHY NOT CitationDocument: that table points the OTHER WAY. It is the OCR
-- intake queue — a scanned notice arrives, citation-ocr.scheduler.js claims it
-- by `status = 'PENDING'`, ships the bytes to an AI provider, and a Citation is
-- CREATED FROM it. Filing a payment receipt there would feed the renter's
-- name, licence details and address to that provider on a timer and try to
-- parse the receipt as a new citation. Corpusa's citation OCR was deliberately
-- disabled on 2026-08-27 for the TL International disclosure. A separate table
-- with no PENDING status and no OCR columns makes that structurally
-- impossible rather than merely unintended.
--
-- WHY docType is a controlled list and not free text: painful to normalise
-- once operators have typed a hundred variants of "receipt". Enforced in the
-- service (normalizeDocType), not by a CHECK constraint, so adding a type
-- later stays a code change and not a lock-taking DDL on a live table.
--
-- RETENTION: these files routinely carry the renter's name, licence details
-- and address. They sit on the 4-YEAR IDENTITY clock, not the 10-year
-- accounting one — a dispute letter is not an accounting record. Registered in
-- customer-pii-map.js (HARD_DELETE) and swept by retention.service.js, which
-- deletes the row AND the stored object.
--
-- The file itself lives in a private Supabase Storage bucket; only the
-- "<bucket>:<path>" reference is stored here.
--
-- Additive + idempotent per the migration rules (startup-migrate applies this
-- on boot; mirrors 20260728_location_documents). INERT on deploy: one new
-- table with no rows, no changes to any existing table, and nothing reads it
-- until a tenant uploads a document. Safe under the multi-worker boot-apply
-- (startup-migrate) race.

CREATE TABLE IF NOT EXISTS "CitationAttachment" (
  "id"               TEXT NOT NULL,
  "tenantId"         TEXT NOT NULL,
  "citationId"       TEXT NOT NULL,
  "docType"          TEXT NOT NULL,
  "label"            TEXT NOT NULL,
  "notes"            TEXT,
  "storagePath"      TEXT NOT NULL,
  "fileName"         TEXT,
  "mimeType"         TEXT,
  "sizeBytes"        INTEGER,
  "status"           TEXT NOT NULL DEFAULT 'ACTIVE',
  "uploadedByUserId" TEXT,
  "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CitationAttachment_pkey" PRIMARY KEY ("id")
);

-- Cascade on tenant delete, matching Citation itself (Citation_tenantId_fkey
-- is ON DELETE CASCADE). Attachments have no meaning without their tenant, and
-- leaving them behind would strand personal data no sweep still reaches.
DO $$ BEGIN
  ALTER TABLE "CitationAttachment"
    ADD CONSTRAINT "CitationAttachment_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Cascade on citation delete: the evidence belongs to the citation and is
-- meaningless once it is gone. NOTE the stored objects are NOT reaped by this
-- cascade — the retention sweep is what deletes bytes. Deleting a Citation row
-- by hand orphans its files in the bucket.
DO $$ BEGIN
  ALTER TABLE "CitationAttachment"
    ADD CONSTRAINT "CitationAttachment_citationId_fkey"
    FOREIGN KEY ("citationId") REFERENCES "Citation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- The two hot reads: "show me this citation's active attachments" (the detail
-- screen and the export) and the tenant-wide age scan the retention sweep runs.
CREATE INDEX IF NOT EXISTS "CitationAttachment_tenantId_citationId_status_idx"
  ON "CitationAttachment"("tenantId", "citationId", "status");
CREATE INDEX IF NOT EXISTS "CitationAttachment_tenantId_createdAt_idx"
  ON "CitationAttachment"("tenantId", "createdAt");
