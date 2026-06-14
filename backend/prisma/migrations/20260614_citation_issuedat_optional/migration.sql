-- Citation.issuedAt → optional (2026-06-14).
-- Sources that only expose a citation list without a date (e.g. CPC list view)
-- ingest the citation bound to the vehicle (by plate, NEEDS_REVIEW); the date is
-- enriched later. Additive + safe: no data loss, existing rows keep their value.
ALTER TABLE "Citation" ALTER COLUMN "issuedAt" DROP NOT NULL;
