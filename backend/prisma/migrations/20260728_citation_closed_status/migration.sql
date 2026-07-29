-- 2026-07-28 (LAX #11) — CLOSED citation status (archive set = VOID + CLOSED).
-- ADD VALUE IF NOT EXISTS is idempotent; PG 12+ allows it inside the
-- migration transaction (the new value just can't be USED in the same txn —
-- and nothing here uses it).
ALTER TYPE "CitationStatus" ADD VALUE IF NOT EXISTS 'CLOSED';
