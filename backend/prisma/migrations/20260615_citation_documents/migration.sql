-- OCR mail intake — Fase A plumbing (2026-06-15).
-- Plan: doc/citations-ocr-mail-intake-plan-2026-06-15.md
-- Adds: CitationSource.MAIL_OCR enum value + CitationDocument table.
-- Additive only. Idempotent. Migrate via the SESSION port 5432, never pgbouncer 6543.

-- 1) New citation source for OCR'd mailed notices.
ALTER TYPE "CitationSource" ADD VALUE IF NOT EXISTS 'MAIL_OCR';

-- 2) CitationDocument — a scanned/emailed notice awaiting OCR extraction.
CREATE TABLE IF NOT EXISTS "CitationDocument" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "bucketPath" TEXT NOT NULL,
  "contentType" TEXT,
  "sourceChannel" TEXT NOT NULL DEFAULT 'UPLOAD',
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "ocrJson" TEXT,
  "confidence" DECIMAL(5,2),
  "citationId" TEXT,
  "error" TEXT,
  "uploadedByUserId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CitationDocument_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "CitationDocument_tenantId_status_createdAt_idx"
  ON "CitationDocument"("tenantId", "status", "createdAt");

-- 3) Foreign keys (guarded).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'CitationDocument_tenantId_fkey') THEN
    ALTER TABLE "CitationDocument" ADD CONSTRAINT "CitationDocument_tenantId_fkey"
      FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'CitationDocument_citationId_fkey') THEN
    ALTER TABLE "CitationDocument" ADD CONSTRAINT "CitationDocument_citationId_fkey"
      FOREIGN KEY ("citationId") REFERENCES "Citation"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'CitationDocument_uploadedByUserId_fkey') THEN
    ALTER TABLE "CitationDocument" ADD CONSTRAINT "CitationDocument_uploadedByUserId_fkey"
      FOREIGN KEY ("uploadedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
