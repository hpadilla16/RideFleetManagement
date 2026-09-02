-- Agent Copilot Phase 2 — server-side miss telemetry (2026-09-02).
-- Design: design/mockups/copilot-NOTES.md §2 (Phase 2/3: the miss list IS the
-- authoring backlog) — the panel's localStorage ring buffer now also flushes
-- here, and the AI-fallback spend cap counts kind='AI_CALL' rows per day.
--
-- ADDITIVE AND IDEMPOTENT per the migration rules (startup-migrate applies
-- this on boot; mirrors 20260903_checkin_audit): one new observation table
-- with no rows. Nothing reads it until the first panel flush after deploy.
--
-- CopilotMiss is an OBSERVATION table, not a workflow owner: loose ids, no
-- foreign keys on purpose (CheckinAuditFinding precedent) — a deleted user
-- must never cascade into the authoring backlog.

CREATE TABLE IF NOT EXISTS "CopilotMiss" (
  "id"              TEXT NOT NULL,
  "tenantId"        TEXT NOT NULL,
  -- MISS | AI_CALL
  "kind"            TEXT NOT NULL DEFAULT 'MISS',
  -- The question as typed (capped at 300 chars) and its normalized form
  -- (lowercase, accent-stripped) — the grouping key for "what to teach next".
  "query"           TEXT NOT NULL,
  "normalizedQuery" TEXT NOT NULL,
  "pathname"        TEXT,
  "lang"            TEXT,
  "userId"          TEXT,
  "flagged"         BOOLEAN NOT NULL DEFAULT false,
  -- kind=AI_CALL only: ANSWERED | NO_ANSWER | ERROR.
  "aiOutcome"       TEXT,
  "askedAt"         TIMESTAMP(3),
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CopilotMiss_pkey" PRIMARY KEY ("id")
);

-- The daily AI-call cap: count(tenantId, kind='AI_CALL', createdAt >= day).
CREATE INDEX IF NOT EXISTS "CopilotMiss_tenantId_kind_createdAt_idx"
  ON "CopilotMiss"("tenantId", "kind", "createdAt");
-- The admin "top misses" grouping.
CREATE INDEX IF NOT EXISTS "CopilotMiss_tenantId_normalizedQuery_idx"
  ON "CopilotMiss"("tenantId", "normalizedQuery");

-- Supabase advisor requirement (2026-09-02): every new table ships with RLS
-- enabled. The app connects as the table owner (owner bypasses RLS), so this
-- changes nothing for the backend — it closes the anon/direct-API surface.
ALTER TABLE "CopilotMiss" ENABLE ROW LEVEL SECURITY;
