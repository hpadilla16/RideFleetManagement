# Runbook — Customer-document blobs → Supabase Storage (Phase 1)

Date: 2026-06-30. Goal: move inline base64 KYC documents out of Postgres into a
private Supabase Storage bucket, to permanently fix disk pressure (was 84%) and the
slow `getById`. Ships DARK behind a flag; nothing changes until you run the steps.

## Scope (Phase 1)
4 columns: `Customer.idPhotoUrl`, `Customer.licenseBackUrl`, `Customer.insuranceDocumentUrl`,
`RentalAgreement.insuranceDocumentUrl`. **Signatures are deferred to Phase 2** (they're
embedded in generated PDFs at 10+ sites; needs its own PDF re-inline work + QA).

## What was built (QA: SHIP, flag-off byte-identical)
- `customer-documents.js` helper: decode (image + PDF), upload to bucket, sign-on-read, flag-gated fail-safe writes.
- Serve path signs the 4 fields on read (getById + customer update + portal serializer + agreement getById).
- Write path routes new uploads to Storage when `CUSTOMER_DOCS_STORAGE_ENABLED=true` (fail-safe: on any upload error it keeps base64, never loses a doc, never 500s).
- `backfill-customer-documents-to-storage.mjs`: dry-run default, `--commit/--limit/--tenant`, **reads each object back and verifies bytes BEFORE overwriting the column**, idempotent, skips null-tenant. Tests green (unit 27/27, embedded-pg backfill 3/3).

## CRITICAL — overwriting columns does NOT reclaim disk by itself
Dead base64 stays as TOAST bloat. The 84% will not drop until you run **`pg_repack`**
(online, light locks) or a windowed **`VACUUM FULL`** (ACCESS EXCLUSIVE lock). The
`supabase-dba` agent can check whether `pg_repack` is available on your plan first.

---

## STEP 0 — Prereqs (do before anything else)
1. Connect the **Supabase MCP** and run the new `supabase-dba` agent to: confirm `pg_repack` availability, measure current table/TOAST sizes, and confirm connection/pooler health.
2. In Supabase Storage, create a **private** bucket `customer-documents` (NOT public).
3. Ensure backend env has: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, and `SUPABASE_STORAGE_CUSTOMER_DOCS_BUCKET=customer-documents`. Keep `CUSTOMER_DOCS_STORAGE_ENABLED` **unset/false** for now.

## STEP 1 — Immediate relief: expand disk (optional but recommended)
Project Settings → Compute and Disk → raise Disk size. ~$0.125/GB/mo. Note the 6-hour
resize cooldown, so add a comfortable cushion in one go. Buys headroom while you migrate.

## STEP 2 — Deploy DARK
Tag the new beta and deploy with the flag OFF. Runtime is byte-identical to today; the
only new behavior is that the serve path WOULD sign storage paths if any existed (none yet).
Confirm CI green, then on the droplet rebuild backend + frontend + worker.

## STEP 3 — Snapshot (safety net)
`pg_dump` the `Customer` and `RentalAgreement` tables before any `--commit`. Keep it until
the migration is verified.

## STEP 4 — Backfill DRY RUN
On a machine with working Prisma (droplet or local), first run the backfill **test** green,
then:
`node backend/scripts/backfill-customer-documents-to-storage.mjs`  (no --commit)
Review the stats (scanned / would-migrate / noTenant). Sanity-check counts.

## STEP 5 — Backfill COMMIT (staged)
Start scoped, then widen:
`node backend/scripts/backfill-customer-documents-to-storage.mjs --commit --limit 50`
then `--tenant <id>` for the main tenant, then full. Each field is uploaded, **read back
and byte-verified, and only then** the column is overwritten with the storage path. After a
batch, open a few affected customers in the admin UI and confirm the ID/insurance/license
images still load (getById now returns signed URLs).

## STEP 6 — Turn on Storage for NEW writes
Set `CUSTOMER_DOCS_STORAGE_ENABLED=true` and redeploy/restart backend + worker. New uploads
now go straight to Storage, so the DB won't regrow. (Safe to do once Step 5 verified.)

## STEP 7 — Reclaim disk (the step that actually moves 84%)
- If `pg_repack` available: `pg_repack -t public."Customer" -t public."RentalAgreement"` (online).
- Else, in a brief maintenance window: `VACUUM FULL "Customer"; VACUUM FULL "RentalAgreement";`
Re-check Disk Usage % — it should drop substantially.

## STEP 8 — Monitor
Watch Sentry + the Supabase DB error rate for a day. The pooler `econnrefused` blips are a
SEPARATE issue (not fixed by this); the `supabase-dba` agent can advise on connection tuning.

---

## Rollback
- Flag-off + no backfill: nothing to roll back (byte-identical).
- During backfill: it only overwrites a column AFTER the object is verified in Storage, so the
  bytes always exist in at least one place. If a batch misbehaves, stop; restore the table from
  the Step-3 `pg_dump` if needed. Storage objects are harmless to leave.
- Do NOT run Step 7 (repack/VACUUM FULL) until Step 5 is fully verified — it's the irreversible
  space-reclaim.

## Deferred to Phase 2
All e-signature columns (Reservation/RentalAgreement/Addendum/Incident/Loaner/SectionInitial)
+ PDF re-inline via downloadObject. Separate build + QA.
