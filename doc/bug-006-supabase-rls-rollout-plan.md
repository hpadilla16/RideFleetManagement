# BUG-006 — Supabase Advisor: RLS Disabled on every public table

**Started:** 2026-05-06
**Owner:** Hector
**Severity at time of report:** High (security advisor) / Medium (real-world exploitability)
**Status:** Plan drafted, not yet implemented

---

## Symptom

Supabase Advisor on the `ridefleetmanager` project (org `hpadilla16's Org`, branch `main` PRODUCTION) reports **62 issues**, the majority labeled `SECURITY · CRITICAL · RLS Disabled in Public`. Visible in the screenshot:

- `public._prisma_migrations` — RLS not enabled
- `public.VehicleType` — RLS not enabled
- `public.Vehicle` — RLS not enabled
- "View 58 more issues in Advisor"

This matches what's in the schema: `backend/prisma/schema.prisma` defines ~64 application models, plus `_prisma_migrations` from Prisma itself. None of the migrations under `backend/prisma/migrations/` enable RLS or create any policy (`grep "ENABLE ROW LEVEL SECURITY|CREATE POLICY"` → 0 hits).

## Why this matters (and where it doesn't)

The honest framing — because the wrong framing leads to a false sense of safety once we flip the switch.

**What is actually exposed today:**

1. **Supabase Studio / SQL editor / Table editor** — anyone with project access (currently just Hector) can read or write any row in any tenant. RLS off in the dashboard = no guardrail against an accidental cross-tenant query, a misclick on "Delete row," or a future contractor with project access.
2. **Any future PostgREST / anon usage.** The Supabase project ships PostgREST enabled by default. If a frontend ever calls Supabase directly with the anon key (we don't today, but the surface exists), every row in every tenant is reachable. Today the risk is "the door is unlocked"; turning RLS on is "we put a lock on the door."
3. **Credential leak blast radius.** If the `DATABASE_URL` ever leaks (env file in a repo, log capture, compromised CI), an attacker has full read/write to every tenant. RLS doesn't fully fix this — see below — but with the right role split it shrinks the blast radius.

**What is NOT actually exposed today (and what RLS by itself will NOT fix):**

The backend is the only application path to Postgres. It connects through `backend/src/lib/prisma.js` using `DATABASE_URL`, which is the Supabase pooler URL bound to a role that bypasses RLS (the standard `postgres` / service role on Supabase has `BYPASSRLS`). Application-layer tenant scoping is already validated end-to-end (`BETA_TENANT_ISOLATION_CHECKLIST.md`, V1–V6). So:

- Turning RLS on while the backend continues to connect with a bypass role gives **zero runtime enforcement on backend traffic.** Every Prisma query continues to see every tenant's rows. The advisor goes green, but the practical risk to production traffic is unchanged.
- The defense-in-depth value the team wrote up in the beta checklist ("Add DB-level RLS as defense-in-depth," Next Recommended Action #2) only materializes when the backend connects with a non-bypass role and a per-request `SET LOCAL` of the tenant id. That is a separate, larger change.

This plan splits the work along that line: a Phase 1 that silences the advisor and closes the Studio / PostgREST hole quickly with no app-side change, and a Phase 2 that delivers the real defense-in-depth value. We can ship Phase 1 in a single migration; Phase 2 requires a Prisma middleware and a new DB role and should be sprint-scoped.

## Options considered

**A. Enable RLS + deny-all default policy on every public table. Backend stays on the bypass role.**
Pros: one migration, low risk, advisor goes green, Studio mistakes blocked, future PostgREST/anon misuse blocked by default. Cons: no real enforcement on backend traffic; the credentials-leak threat model is unchanged.

**B. Option A + move the backend onto a non-`BYPASSRLS` role and set `app.current_tenant` via `SET LOCAL` per request; write per-table tenant policies.**
Pros: real defense-in-depth, matches the beta checklist's stated next action. Cons: requires a Prisma middleware that runs `set_config('app.current_tenant', $tenantId, true)` at the start of every transaction; requires a new `app_user` role with `GRANT` on every table and on the `cuid()` defaults / sequences; risk of breaking SUPER_ADMIN cross-tenant flows (Trips, Knowledge Base seed, audit consoles) — those need an explicit bypass GUC like `app.tenant_bypass`.

**C. Migrate auth to Supabase Auth and use `auth.uid()` / `auth.jwt()` policies.**
Pros: the textbook Supabase pattern. Cons: a real auth migration. The whole codebase is on a custom JWT (`JWT_SECRET`, `lockPinHash`, public-booking guest tokens, addendum signature tokens, account-deletion tokens). This is out of scope for BUG-006 and should be a separate decision driven by other product needs, not by an advisor warning.

**Chosen path:** Phase 1 = Option A (this PR). Phase 2 = Option B (next sprint). Option C deferred indefinitely.

## Phase 1 — Enable RLS + deny-all default on every public table

Goal: Advisor goes from 62 issues to ~0 RLS-class issues, with no behavior change on the backend.

### Migration plan

New migration directory: `backend/prisma/migrations/20260506_enable_rls_default_deny/migration.sql`. The migration is one block per table:

```sql
-- For every application table:
ALTER TABLE public."Vehicle" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."Vehicle" FORCE ROW LEVEL SECURITY;

-- Plus a default-deny policy so that any non-bypass role sees nothing
-- until Phase 2 wires up real tenant policies. The backend's bypass role
-- is unaffected by this — it continues to read and write normally.
CREATE POLICY "deny_all_default" ON public."Vehicle"
  FOR ALL TO PUBLIC USING (false) WITH CHECK (false);
```

`FORCE ROW LEVEL SECURITY` is set explicitly so that the table owner is also subject to policies — this is what blocks the Studio table editor when it's running as the table owner. The deny-all policy is what makes the lock real for any role that doesn't have `BYPASSRLS`.

The full list of tables to enable comes straight from `schema.prisma`:

```
_prisma_migrations
Tenant, User, Location, VehicleType, Vehicle, VehicleAvailabilityBlock,
VehicleClassStopSale, VehicleTelematicsDevice, VehicleTelematicsEvent,
Customer, Reservation, Invoice, MaintenanceJob,
HostVehicleListing, HostVehicleSubmission, HostVehicleSubmissionCommunication,
ListingAvailabilityWindow, HostProfile, HostPickupSpot, CarSharingSearchPlace,
HostServiceArea, AuditLog,
RentalAgreement, RentalAgreementAddendum, RentalAgreementCharge,
RentalAgreementPayment, RentalAgreementInspection, RentalAgreementVehicleSwap,
Trip, TripDocument, TripFulfillmentPlan, TripPayout, TripIncident,
TripIncidentCommunication, TripTimelineEvent,
AgreementDriver, CommissionPlan, CommissionRule, AgreementCommission,
AgreementCommissionLine, HostReview,
ReservationPricingSnapshot, ReservationCharge, ReservationPayment,
ReservationAdditionalDriver, ReservationDailyCounter,
Rate, RateItem, RateDailyPrice, Fee, LocationFee, AdditionalService,
AppSetting,
PlannerRuleSet, PlannerScenario, PlannerScenarioAction, PlannerRecommendationAudit,
TollProviderAccount, TollImportRun, TollTransaction, TollAssignment,
Conversation, Message, KnowledgeArticle, Franchise, StoreBoardToken
```

That's 65 tables. The migration will be generated from this list, not typed by hand — see the script note in the implementation steps.

### What stays untouched in Phase 1

- `auth.*`, `storage.*`, `extensions.*`, `realtime.*` Supabase-managed schemas.
- Any extensions / system views the advisor flags as non-RLS issues (function search-path, materialized-view-in-public, etc.). Those are the "View 58 more issues in Advisor" delta — many of them are NOT RLS issues. Phase 1 only addresses the RLS-disabled class. The non-RLS findings get a sibling ticket (BUG-006-followup or rolled into an Advisor sweep doc).

### Backend changes in Phase 1

**None.** The Prisma client keeps connecting with the existing role, which has `BYPASSRLS`, so every backend query continues to work unchanged. The deny-all policy is a no-op for that role.

### Validation

1. Apply the migration to the staging Supabase project first (`fleet-staging`, if it exists; otherwise a throwaway branch on the same project).
2. Run the existing tenant-isolation test suite (`backend/.github/workflows/beta-ci.yml` `tenant-isolation-suite` job). It must still pass — Prisma traffic is unaffected by RLS because the backend role has `BYPASSRLS`.
3. In Supabase Studio, open the Table editor for `public.Vehicle` while logged in as a non-owner role (or with the anon key in the SQL editor) and confirm the row count shows 0. With the owner role / service-role key, the table reads normally — that confirms `FORCE ROW LEVEL SECURITY` plus the bypass attribute are interacting as expected.
4. Re-run the Supabase Advisor — RLS-class findings drop to 0.
5. Hit a representative production endpoint after deploy: `/api/health`, `/api/reservations` (authed), `/api/public/booking/bootstrap` (cached). All return 200 with normal payloads.

### Rollback

The migration is reversible by a single drop:

```sql
DROP POLICY IF EXISTS "deny_all_default" ON public."Vehicle";
ALTER TABLE public."Vehicle" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE public."Vehicle" DISABLE ROW LEVEL SECURITY;
```

Generate the down script alongside the up script and keep it in the migration folder as `rollback.sql` (Prisma doesn't run it; it's there for an operator to copy-paste in Supabase SQL editor if Phase 1 goes sideways).

### Acceptance criteria — Phase 1

- New migration `20260506_enable_rls_default_deny` is in `backend/prisma/migrations/`.
- All 65 public tables have `ENABLE ROW LEVEL SECURITY` + `FORCE ROW LEVEL SECURITY` + `deny_all_default` policy.
- `tenant-isolation-suite` CI job still passes.
- Supabase Advisor shows 0 RLS-class findings on `public.*` tables.
- Three smoke endpoints return 200 in production after deploy.
- `BUG-006` entry in `doc/known-bugs-2026-04-23.md` updated to "Closed — Phase 1 only" with the merge commit / tag.

---

## Phase 2 — Real defense-in-depth (separate sprint)

Goal: a credentials leak or lateral-movement attempt against the backend's DB role no longer reads cross-tenant data.

### Pieces

1. **New role `app_user`.** Owned by Supabase admin; `NOLOGIN`, `NOBYPASSRLS`, `NOSUPERUSER`. Granted `SELECT, INSERT, UPDATE, DELETE` on every public table and `USAGE` on every sequence. The backend gets a separate login role (`app_user_login`) that has `app_user` in `INHERIT`.
2. **New env var `DATABASE_URL_APP`** that points the backend at `app_user_login`. Old `DATABASE_URL` stays for migrations / Prisma CLI / scripts.
3. **Prisma middleware: per-request `SET LOCAL`.** In `backend/src/lib/prisma.js`, wrap every authenticated request in a transaction that begins with:
   ```sql
   SELECT set_config('app.current_tenant', $tenantId, true);
   SELECT set_config('app.tenant_bypass', $isSuperAdmin, true);
   ```
   `true` = `is_local`, so the value is scoped to the transaction. The middleware reads `tenantId` and `role` from the JWT context the existing auth middleware already attaches to the request.
4. **Replace `deny_all_default` with real per-table policies.** For tables that have `tenantId`:
   ```sql
   CREATE POLICY tenant_isolation_select ON public."Vehicle"
     FOR SELECT TO app_user
     USING (
       current_setting('app.tenant_bypass', true) = 'true'
       OR "tenantId" = current_setting('app.current_tenant', true)
     );
   -- and the same for INSERT / UPDATE / DELETE with WITH CHECK as well.
   ```
   For tables without `tenantId` (e.g. `_prisma_migrations`, `KnowledgeArticle` if it's global) — pick per-table: either a SUPER_ADMIN-only policy (`current_setting('app.tenant_bypass', true) = 'true'`) or a join-based policy through a parent table.
5. **SUPER_ADMIN bypass.** SUPER_ADMIN flows (cross-tenant audit, Trip moderation, Knowledge Base curation) work because `app.tenant_bypass` is set to `'true'` on those requests. This must be unit-tested per route group.

### What can break in Phase 2 (and how we'll catch it)

- **Migrations / scripts.** Anything that runs outside an HTTP request (Prisma migrate, the seed scripts, ops PowerShell scripts) needs to keep using the original bypass role. Audit `scripts/` and `backend/scripts/seed-bootstrap.mjs` before flipping the runtime role.
- **Background jobs.** The cache-invalidation Redis listener and any cron — currently none in `backend/src/`, but check before flipping.
- **Routes that hold a connection across multiple tenants in one request.** The cross-tenant SUPER_ADMIN endpoints either need to set `app.tenant_bypass=true` for the whole request, or split their work into per-tenant transactions.
- **Public-booking, store-board-public, and addendum-signature-public routes.** These use guest tokens and don't have a logged-in tenant on the request. The middleware needs a "public route" branch that resolves `tenantId` from the token before opening the transaction.
- **Connection pool overhead.** `SET LOCAL` requires a transaction. If we wrap every request in `prisma.$transaction(...)` we add a small per-request cost. Validate against the BUG-005 baseline before shipping.

### Validation matrix — Phase 2

Re-run V3–V6 from `BETA_TENANT_ISOLATION_CHECKLIST.md`, but this time with the backend on the non-bypass role:

- V3 read isolation — already passes at the app layer; must keep passing with RLS on.
- V4 write isolation — same.
- V5 SUPER_ADMIN — explicit test that the bypass GUC is set correctly on cross-tenant routes and not set on regular routes.
- V6 reservation lifecycle — full reservation -> agreement -> payment -> addendum chain on tenant A, tenant B; each end-to-end flow on tenant A while another connection is impersonating tenant B in parallel.
- Plus a new V7: simulate the credentials-leak case — connect to Postgres as `app_user_login` outside the backend (e.g. with `psql`) and confirm `SELECT * FROM public."Vehicle"` returns 0 rows because no `app.current_tenant` is set.

### Acceptance criteria — Phase 2

- New `app_user` / `app_user_login` roles exist in Supabase with the documented grants.
- `DATABASE_URL_APP` is configured in production env; backend connects via the non-bypass role.
- Prisma middleware wraps authenticated and public-token routes in a transaction with `set_config(...)` calls.
- Every `tenantId`-bearing table has real per-table tenant policies; non-`tenantId` tables have explicit per-table decisions documented in this plan.
- Existing tenant-isolation suite + new V7 cred-leak test both pass.
- Sentry shows no new pool-timeout / transaction-failure error class for ≥48 h after deploy.
- `BUG-006` index entry updated to "Closed — Phase 2 complete" with commit / tag.

---

## Files to change

### Phase 1 (this PR / next deploy)

- `backend/prisma/migrations/20260506_enable_rls_default_deny/migration.sql` — new
- `doc/bug-006-supabase-rls-rollout-plan.md` — this file (already drafted)
- `doc/known-bugs-2026-04-23.md` — add BUG-006 entry under **Open**

### Phase 2 (separate sprint)

- `backend/prisma/migrations/<date>_app_user_role_and_tenant_policies/migration.sql` — new
- `backend/src/lib/prisma.js` — add the per-request `SET LOCAL` middleware
- `backend/src/middleware/auth.js` — make sure `tenantId` and `isSuperAdmin` are reliably on `req.user` for every authenticated route, and document the public-token routes that resolve `tenantId` differently
- `backend/.env.example` — add `DATABASE_URL_APP`
- `docs/operations/version-control-and-release.md` — document the two DB URLs, what migrations vs runtime use which
- Public-token routes (`store-board-public.routes.js`, `addendum-signature-public.routes.js`, the public-booking entry points) — verify they set the GUCs correctly before issuing Prisma queries

## Open questions (to resolve before starting Phase 2)

1. Does the Supabase plan we're on let us create custom roles with `NOLOGIN` / `NOBYPASSRLS`? On the Free tier some role attributes are restricted. Confirm in dashboard before committing to Phase 2.
2. Is there a staging Supabase project, or will Phase 1 / Phase 2 land directly on production? If only production exists, we either spin up a temporary branch / shadow project, or accept testing in a small maintenance window.
3. Which non-`tenantId` tables (if any) should be globally readable by all tenants vs SUPER_ADMIN-only? Candidates: `_prisma_migrations` (always SUPER_ADMIN), `KnowledgeArticle` (per-tenant — already has `tenantId` per the schema, so no decision needed; double-check `Tenant` itself — every authenticated user reads their own tenant row, so the policy is `id = current_setting('app.current_tenant', true)`).
4. Do we keep `_prisma_migrations` under RLS at all? Prisma's CLI runs as the bypass role, so this is fine — but worth confirming that `prisma migrate deploy` against the `app_user_login` role would fail (it should, and it should not be configured to use that role anyway).

## Why this didn't happen earlier — analysis

1. **The beta-tenant-isolation push prioritized correctness, not depth.** The team validated that the application layer enforced tenant scoping on every endpoint (V1–V6). DB-level RLS was explicitly punted to "next recommended actions." That was the right call for getting to beta — and it's how we got here without RLS on.
2. **Supabase Advisor wasn't part of the regular review cadence.** The advisor surfaces issues quietly in the dashboard. There's no CI check for "Advisor count delta" today. Adding one is cheap and would have surfaced this in February when the multi-tenant migration first landed.
3. **Custom JWT auth made the textbook Supabase RLS path inapplicable.** Most Supabase docs assume `auth.uid()` policies, which require Supabase Auth. The team wasn't on Supabase Auth, so the quickest pattern in the docs didn't match and the work felt larger than it actually is. This plan's `set_config` approach is the right fit for a non-Supabase-Auth backend and is documented in the Supabase RLS guide under "use a custom claim from a JWT."

## Follow-ups not in BUG-006

- **Non-RLS advisor findings.** The screenshot says "View 58 more issues" — many of those are likely `function_search_path_mutable`, `extension_in_public`, `materialized_view_in_api`, `auth_users_exposed`, etc. Open a separate ticket (BUG-007 or "Supabase Advisor sweep 2026-05-06") and triage them after Phase 1 is shipped.
- **Add an Advisor check to CI.** A nightly job that hits the Supabase Advisor API and fails if the issue count regresses past a baseline. Roll this into the operations runbook once Phase 2 is closed.
