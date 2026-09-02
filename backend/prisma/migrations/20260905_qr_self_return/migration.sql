-- QR self-return = customer return timestamp (Hector, 2026-09-02).
-- Design: a per-location QR poster in the return area opens a public page
-- where the customer types their reservation number + last name and marks
-- "devolví el carro". That moment is evidence of when the car was actually
-- handed back, so check-in close can compute the late fee up to THAT hour
-- instead of the moment an agent finally ran the wizard.
--
-- ADDITIVE AND IDEMPOTENT per the migration rules (startup-migrate applies
-- this on boot; mirrors 20260904_copilot_miss). Nothing is dropped; every
-- existing row keeps byte-identical behavior (all new columns are NULL, the
-- new table starts empty, and the feature is OFF for every location until an
-- admin mints a QR — the shuttle-tracker ship-inert precedent).
--
-- Reservation stamp columns:
--   customerReportedReturnAt          when the customer marked the return.
--                                     THE evidence timestamp.
--   customerReportedReturnLocationId  the sede whose QR was scanned (plain
--                                     ref, no FK — evidence, not workflow).
--   customerReportedReturnMetaJson    { ip, userAgent } capped — abuse triage.
--   customerReportedReturnVoidedAt/-ByUserId/-Reason
--                                     ADMIN correction. The stamp is never
--                                     deleted — voiding keeps the trail.

ALTER TABLE "Reservation" ADD COLUMN IF NOT EXISTS "customerReportedReturnAt" TIMESTAMP(3);
ALTER TABLE "Reservation" ADD COLUMN IF NOT EXISTS "customerReportedReturnLocationId" TEXT;
ALTER TABLE "Reservation" ADD COLUMN IF NOT EXISTS "customerReportedReturnMetaJson" TEXT;
ALTER TABLE "Reservation" ADD COLUMN IF NOT EXISTS "customerReportedReturnVoidedAt" TIMESTAMP(3);
ALTER TABLE "Reservation" ADD COLUMN IF NOT EXISTS "customerReportedReturnVoidedByUserId" TEXT;
ALTER TABLE "Reservation" ADD COLUMN IF NOT EXISTS "customerReportedReturnVoidReason" TEXT;

-- One QR token per location. The row IS the enablement: no row (or a revoked
-- one) = the public page 404s exactly like a bad token, and the admin button
-- reads "off". Re-enabling mints a NEW token so old posters die — same
-- public-token idiom as ShuttleTrackerLink/ShuttleDriverShift (192-bit
-- random, unique, revocable, bare-404 on anything unusable). Plain String
-- refs, no relations — tracker-substrate style, ownership re-verified on
-- every read.
CREATE TABLE IF NOT EXISTS "SelfReturnQr" (
  "id"              TEXT NOT NULL,
  "tenantId"        TEXT NOT NULL,
  "locationId"      TEXT NOT NULL,
  "token"           TEXT NOT NULL,
  "revokedAt"       TIMESTAMP(3),
  "createdByUserId" TEXT,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SelfReturnQr_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "SelfReturnQr_locationId_key" ON "SelfReturnQr"("locationId");
CREATE UNIQUE INDEX IF NOT EXISTS "SelfReturnQr_token_key" ON "SelfReturnQr"("token");
CREATE INDEX IF NOT EXISTS "SelfReturnQr_tenantId_idx" ON "SelfReturnQr"("tenantId");

-- Supabase advisor requirement (2026-09-02): every new table ships with RLS
-- enabled. The app connects as the table owner (owner bypasses RLS), so this
-- changes nothing for the backend — it closes the anon/direct-API surface.
ALTER TABLE "SelfReturnQr" ENABLE ROW LEVEL SECURITY;
