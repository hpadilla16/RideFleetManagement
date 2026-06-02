# Incident / Damage Report module — end-to-end build plan (2026-06-02)

Ship target: **v0.9.0-beta.62** on `release/v0.9.0-beta.58`. Approved by Hector
(mockups approved 2026-06-02). This is the first feature on this branch that
requires a **production schema migration**, so the migration is gated and
runbooked separately.

## What it is

A dispute-ready incident/damage report attached to a reservation. Lifecycle:
`DRAFT` (editable) → certify & issue → `ISSUED` (locked); "revise" clones a new
DRAFT. Report renders a 9-section document (header, rental + pre-rental
condition, narrative, evidence table, cited clauses, charge/deposit summary,
chargeback rebuttal, photo grid, certification + signature). Evidence photos are
either uploaded or pulled from existing CHECKOUT/CHECKIN inspection photos. A
per-tenant **clause library** (`AgreementClause`) backs the cited clauses.

## Source of truth (feature/incident-report)

- Code (cherry-pick / extract): `incident-report.service.js` (424), `.routes.js`,
  `incident-report-pdf.js`, `.service.test.mjs`, `-pdf.test.mjs` + `main.js` mount
  + a `backend/package.json` PDF dep bump.
- Schema: 3 models (`ReservationIncident`, `IncidentEvidence`, `AgreementClause`)
  + 4 enums, at `schema.prisma` lines ~3250–3360 on the branch.
- Migration: `backend/prisma/migrations/20260601_add_incident_report/migration.sql`
  (additive only: 4 enums + 3 tables + indexes + FKs to Tenant/Reservation/self).

Deps verified present on release: `lib/storage/supabase-storage.js`
(`uploadObject/safePath/getSignedUrl`), `rental-agreements/inspection-photos.js`
(`decodePhotoValue/getPhotosBucket`). No model-name collisions (the existing
`TripIncident*` are unrelated). Branch base is 72 commits behind release, so we
**port files, never merge the branch**.

## API (mounted at `/api/incident-reports`, roles ADMIN/OPS/AGENT)

Clauses: `GET/POST /clauses`, `POST /clauses/seed`, `PATCH/DELETE /clauses/:id`.
Reservation-scoped: `POST /reservations/:reservationId` (create),
`GET /reservations/:reservationId` (list).
Incident: `GET/PATCH /:id`, `POST /:id/clauses`, `POST /:id/evidence`,
`POST /:id/evidence/pull`, `DELETE /:id/evidence/:evidenceId`,
`POST /:id/certify`, `POST /:id/revise`, `GET /:id/print` (HTML).

## Phases

1. **Backend port** — extract the 5 files, mount in `main.js`, apply package.json
   bump. (no prod impact)
2. **Schema + migration** — add 3 models + 4 enums to release `schema.prisma`,
   add back-relations on `Reservation` (`damageIncidents`) and `Tenant`
   (`reservationIncidents`, `agreementClauses`), copy the migration dir. Run
   `prisma format && prisma validate && prisma generate`. (no prod impact)
3. **Validate** — `node --check` the files, run the two incident test suites.
4. **Frontend (approved mockups)**:
   - Reservation `Incident reports` panel + mount on `/reservations/[id]` (entry).
   - Incident builder (DRAFT): type/severity/title/discovery, narrative, evidence
     table with Add photo / Pull from inspection, clause picker, charge+deposit
     summary, certify panel (name/title/signature → Certify & issue).
   - Issued report view + Print/PDF + Revise.
   - Clause library settings page (`Settings → Agreement clauses`, seed defaults).
5. **Prod migration (gated — Hector runs)** — see runbook below.
6. **Deploy** `v0.9.0-beta.62`, smoke test end-to-end.

## Production migration runbook (the new/risky step)

Prod DB is Supabase. The migration is additive (new tables only) — low risk —
but still:

1. **Backup first** — `ops/backup.sh` on the droplet (pg_dump → DO Spaces) before
   touching the schema.
2. **Dry-run** — apply the migration SQL inside a transaction with `ROLLBACK` on a
   throwaway/branch DB (or a Supabase branch) and confirm the 3 tables + 4 enums
   create cleanly with no FK errors against the live schema.
3. **Apply** — run `20260601_add_incident_report/migration.sql` against prod
   (Supabase SQL editor or `prisma migrate deploy`). Because the app uses the
   pooler with `pgbouncer=true`, prefer running the raw SQL in the SQL editor over
   `migrate deploy` if the shadow-DB/advisory-lock gives trouble.
4. **Verify** — `\d "ReservationIncident"` etc.; confirm enums exist.
5. Only then deploy the beta.62 image (the new Prisma client expects the tables).

Order matters: **migration must land before the new backend image boots**, or
incident endpoints 500 on missing tables.

## Agents / parallelization

- `Explore` — already used to map the branch; reuse for any follow-up lookups.
- `general-purpose` subagent — optional, to build the clause-library settings page
  in parallel with the builder (isolated file set, low conflict risk). Keep the
  reservation-page edits single-threaded (shared `page.js`).
- Verification subagent (`Task`) — final pass: diff review + confirm every
  `/api/incident-reports` call in the UI matches a real route + payload shape.

## Risks / open items

- **No UI existed on the branch** — we are building all of it; budget accordingly.
- **Clause legal text** — `clause.seed()` defaults need Hector/legal review before
  customers see them.
- **Evidence storage** — uses Supabase Storage buckets via existing helpers;
  confirm the incident bucket/path policy at integration.
- **Pooler + migrations** — see runbook step 3.
