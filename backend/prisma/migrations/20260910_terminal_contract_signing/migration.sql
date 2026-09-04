-- Terminal contract signing (2026-09-04) — per-clause acceptance captured on a
-- Dejavoo QD2 via /v2/Common/UserChoice, before the single /v2/Common/GetSignature
-- ink capture that binds all six clauses.
--
-- Additive + idempotent, per the migration rules (startup-migrate applies this
-- on boot). INERT ON DEPLOY: nothing writes to this table until a tenant sets
-- checkoutContractMode = TERMINAL, which defaults to PHONE for every tenant and
-- has no UI default that turns it on.
--
-- This table exists BECAUSE it must not be AgreementSectionInitial. A clause is
-- accepted before any ink exists, and AgreementSectionInitial.initialDataUrl is
-- NOT NULL and is the table that terms-signing.complete() reads to decide "this
-- contract is fully signed". Writing acceptance there would make a half-signed
-- agreement indistinguishable from a complete one. See the model comment in
-- schema.prisma for the full argument and for how per-clause ink switches on
-- later without touching this schema again.

CREATE TABLE IF NOT EXISTS "AgreementClauseAcceptance" (
  "id"           TEXT NOT NULL,
  "agreementId"  TEXT NOT NULL,
  "sectionKey"   TEXT NOT NULL,
  "sectionLabel" TEXT NOT NULL,
  -- The clause text EXACTLY as displayed on the terminal. Snapshotted because
  -- Location.termsSectionsJson can change the wording afterwards, and a
  -- re-printed agreement must never show text nobody agreed to.
  "sectionBody"  TEXT NOT NULL,
  -- The verbatim SelectedOption the terminal echoed back. Confirmed live
  -- 2026-09-04: it is the option string we sent, byte for byte. Kept verbatim
  -- so an audit can show what the renter literally saw and pressed, in the
  -- language they saw it in.
  "choiceOption" TEXT NOT NULL,
  -- Derived, and ONLY ever true when choiceOption matched the accept option
  -- exactly. Never inferred from the absence of an error.
  "accepted"     BOOLEAN NOT NULL,
  "acceptedAt"   TIMESTAMP(3) NOT NULL,
  "capturedVia"  TEXT NOT NULL DEFAULT 'TERMINAL',
  -- MASKED TPN (first4****last4) and register id — audit only, never the key.
  "terminalTpn"  TEXT,
  "registerId"   TEXT,
  -- Per-clause ink. NULL in the one-capture shape Hector chose; this column is
  -- the switch that turns six separate ink captures on later.
  "inkDataUrl"   TEXT,
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AgreementClauseAcceptance_pkey" PRIMARY KEY ("id")
);

-- One answer per clause per agreement. This is the resume anchor: the sequencer
-- upserts on it, so a re-sent clause overwrites its own row rather than
-- appending a second answer to the same question.
CREATE UNIQUE INDEX IF NOT EXISTS "AgreementClauseAcceptance_agreementId_sectionKey_key"
  ON "AgreementClauseAcceptance"("agreementId", "sectionKey");
CREATE INDEX IF NOT EXISTS "AgreementClauseAcceptance_agreementId_idx"
  ON "AgreementClauseAcceptance"("agreementId");

DO $$ BEGIN
  ALTER TABLE "AgreementClauseAcceptance"
    ADD CONSTRAINT "AgreementClauseAcceptance_agreementId_fkey"
    FOREIGN KEY ("agreementId") REFERENCES "RentalAgreement"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Supabase advisor requirement (2026-09-02): every new table ships with RLS
-- enabled. The app connects as the table owner (owner bypasses RLS), so this
-- changes nothing for the backend — it closes the anon/direct-API surface.
ALTER TABLE "AgreementClauseAcceptance" ENABLE ROW LEVEL SECURITY;
