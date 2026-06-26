# Loaner Program — public self-service car selection, class-upgrade pricing & checked-out lock (build plan, 2026-06-25)

Status: **DRAFT for review** (codebase analyzed against v0.9.0-beta.230, branch `release/deposit-balance-fix-beta119`). Consumer = the Rent & Go storefront (`triangle-dealers-site`, `LoanerFlow.tsx`). Backend-only + RFM admin UI; the storefront is built by the Rent & Go team (spec §6 is context, not RFM work).

---

## 1. Readiness summary — what the code already gives us

The good news: most of the foundation is already shipped (beta.228–230) and verified by code reading.

| Need | Status in code | Reference |
|---|---|---|
| Public router `/api/public/loaner` behind `resolvePublicTenantToken` + rate-limit, fail-closed | **DONE** | `public-loaner.routes.js`, `main.js:190-191` |
| `lookup` / `reserve` / `request` endpoints exist | **DONE** | `public-loaner.service.js` |
| Tenant token resolution (`X-Tenant-Token` → `sha256` → `Tenant.websiteTokenHash`) | **DONE** | `middleware/public-tenant-token.js:25-64` |
| `loanerBillingMode = CUSTOMER_PAY` | **EXISTS** (enum) | `schema.prisma:1115`, enum 368-374 |
| `loanerBillingStatus = PENDING_APPROVAL` | **EXISTS** (enum) | `schema.prisma:1141`, enum 376-383 |
| `estimatedTotal` (Decimal) on Reservation for the differential | **EXISTS** | `schema.prisma:1210` |
| Assigned loaner on reservation (`vehicleId` FK) | **EXISTS** | `schema.prisma:1165-1166` |
| `VehicleType` = the "class" concept (name, code, specs) | **EXISTS** | `schema.prisma:632-663` |
| `LoanerAgreement.portalToken` (long-lived view token) | **EXISTS** | `schema.prisma:4273` |
| Customer agreement view endpoint `GET /api/public/loaner-portal/:token` | **EXISTS** | `loaner-agreement.routes.js:155`, `loaner-agreement.service.js:572-618` |
| `rent-by-vphmotors` tenant + website token provisioned in prod | **EXISTS at runtime** (passed beta220 smoke; no idempotent seed) | `.deploy-notes/2026-06-24-...-beta220.sh` |

## 2. Confirmed gaps — what we must build

1. **Reserve guard bug (confirmed).** `reserve()` does **not** check `reservation.status`. A `CHECKED_OUT`/`CHECKED_IN`/`CANCELLED`/`NO_SHOW` reservation is found, the loaner is overwritten, the agreement is re-stamped with a new signature, and it returns **201**. Verified: no status filter in the `findFirst` (`public-loaner.service.js:141-145`) and no status check before the writes (lines 157-188).
2. **No entitlement anchor.** The service vehicle's **class** is not captured anywhere. Intake stores only `serviceVehicleYear/Make/Model/Plate/Vin` (`schema.prisma:1123-1127`); there is no `serviceVehicleTypeId`/`serviceVehicleClass`. Without it we cannot compute "entitled class" or the upgrade delta.
3. **No loaner rate config.** Confirmed absent (exhaustive search). `VehicleType` has **no** `dailyRate`; rental rates live in `RateItem` (tied to the rental `Rate` system). `public-loaner.service.js:36` hardcodes `costPerDay: 0`. **Decision (D1): reuse `Rate`/`RateItem` tagged for loaner use** — requires a discriminator + strict isolation (see §3) so loaner rates never leak into rental quotes.
4. **`lookup()` is missing fields.** Today it returns only `appointment.{id, vehicle(string), dateTime, location, advisor, repairOrderNumber}` and `loaners[].{id,name,classLabel,imageUrl,passengers,bags,transmission,costPerDay=0,recommended}`. Missing: `appointment.status`, `serviceVehicle{label,classLabel}`, `entitledClassLabel`, `assignedLoaner`, `agreement{available,url}`, and per-loaner `dailyRate` + `upgradeDeltaPerDay`.
5. **No differential recording in `reserve()`.** Needs to set `loanerBillingMode/Status/estimatedTotal` (and optionally a charge line) when the chosen class ≠ entitled class.
6. **No admin UI for loaner rates.** The Loaner Program admin (`frontend/src/app/loaner/page.js`) has no rate config; Settings page has no loaner tab.

## 3. Decisions — LOCKED 2026-06-25

- **D1 — Rate storage: REUSE `Rate`/`RateItem` with a loaner tag.** Add a discriminator to `Rate` (`purpose RatePurpose? @default(RENTAL)`, enum `RENTAL|LOANER`; additive). Per tenant there is one `purpose=LOANER` Rate whose `RateItem` rows hold the per-class loaner daily rate.
  - **Mandatory isolation (the safeguard):** `ratesService.resolveForRental()` (`rates.service.js:732`) MUST filter `purpose != LOANER` (i.e. only `RENTAL`/null) so loaner rates can never surface in a retail quote. The loaner lookup MUST read **only** `purpose=LOANER`. This is the line that prevents the conflation you flagged. Both filters get a unit test.
  - Loaner rate resolution helper: `getLoanerClassRate(tenantId, vehicleTypeId)` → the `LOANER` Rate's `RateItem.daily` for that class (null/absent → $0, "unset").
- **D2 — Entitlement anchor: FK.** Add `Reservation.serviceVehicleTypeId String?` (relation → `VehicleType`); advisor picks the service vehicle's class at intake. Legacy/null → entitlement = assigned loaner's own class (delta $0).
- **D3 — Differential: estimate + visible charge line.** Set `loanerBillingMode=CUSTOMER_PAY` + `loanerBillingStatus=PENDING_APPROVAL` + `estimatedTotal = upgradeDeltaPerDay × days`, AND write a soft `ReservationCharge` `source:'LOANER_UPGRADE'`, `chargeType:'UNIT'`, `selected:true`, then `syncAgreementCharges`. **No gateway** (SPIn / Authorize.Net / Payarc) is ever called.
- **D4 — Admin UI: new Settings tab `loanerRates`** in `frontend/src/app/settings/page.js`, mirroring the `vehicleTypes`/`feeRates` sections; edits the `LOANER` Rate's per-class `RateItem` grid; tenant-scoped (super-admin `?tenantId=`).
- **D5 — Agreement URL.** `agreement.url = ${loanerPortalBaseUrl()}/customer/loaner-portal?token=${portalToken}` (mirrors sign-link at `loaner-agreement.service.js:418`); `available=true` only for a non-VOID agreement with a live `portalToken`. *(Confirm the customer portal route name; defaulting to `/customer/loaner-portal`.)*

### Remaining minor opens (sensible defaults applied unless you object)
- **Unset class rate** → treated as **$0 (covered)**; admin grid shows the cell as "unset". (Not a hard block on selection.)
- **Customer portal route name** for D5 — using `/customer/loaner-portal` unless you tell me otherwise.

## 4. Execution agents (proposed team)

Six focused agents, run mostly in sequence with two parallel pairs. Each is scoped, gets the file map above, and hands off a verifiable artifact.

1. **Schema & Migration agent** — adds `RatePurpose` enum + `Rate.purpose` (default `RENTAL`) and `Reservation.serviceVehicleTypeId` (+ relation); writes one **additive** migration `20260625_rate_purpose_and_service_type`. Runs `prisma format` / `prisma validate`. Output: schema diff + migration SQL. (Blocks everything else.)
2. **Loaner-rate backend agent** — `getLoanerClassRate(tenantId, vehicleTypeId)` + `getLoanerRateMap(tenantId)` resolving the `purpose=LOANER` Rate's `RateItem`; **adds the `purpose != LOANER` filter to `resolveForRental()`** (the isolation safeguard); CRUD for the loaner rate grid (`GET/PUT /api/settings/loaner-rates`, `requireRole('ADMIN')`, `scopeFor`) creating/upserting the tenant's `LOANER` Rate + its `RateItem` rows. Output: endpoints + unit tests (incl. the rental-resolver isolation test).
3. **Public-endpoints agent** — (a) `reserve()` status guard → **409** for non-`NEW`/`CONFIRMED`; (b) differential recording per D3; (c) `lookup()` adds `status`, `serviceVehicle{label,classLabel}`, `entitledClassLabel`, `assignedLoaner`, `agreement{available,url}`, and per-loaner `dailyRate`+`upgradeDeltaPerDay` (delta = `rate(picked) − rate(entitled)`, floored 0). Depends on agents 1–2.
4. **Intake/entitlement agent** — capture `serviceVehicleTypeId` in `dealershipLoanerService.intake()` + the admin intake form; ensure assigned loaner + service class persist so `lookup` can return both. Can run parallel to agent 3 (shares schema from agent 1).
5. **Admin-UI agent** — Settings `loanerRates` tab: per-class editable daily-rate grid (loads `vehicleTypes`, saves via agent-2 endpoints), tenant-scoped (super-admin `?tenantId=`). Depends on agent 2.
6. **Test & verification agent** — Vitest unit tests (delta math, guard 409, lookup shape, rental-resolver isolation), `node --check` on touched files, and the **curl deliverable**: a `lookup` with appointment+loaners+rates+agreement, a `reserve` OK with recorded differential, a `reserve` on a CHECKED_OUT RO → 409, a `request` OK — all with `X-Tenant-Token`. Produces the ship script.
7. **QA / regression agent (independent sign-off)** — runs AFTER agents 1–6, as a separate fresh agent (no build context, so it audits rather than rationalizes). Its job is to prove the feature is correct AND that nothing else in the app broke:
   - **Correctness:** review every changed file against this spec + the four acceptance criteria; confirm each AC is actually satisfied by the code (not just by a test).
   - **Whole-app regression — blast radius:** for every function/signature touched (`resolveForRental`, `intake`, `getIntakeOptions`, `lookup`, `reserve`, charge `syncAgreementCharges`, rate resolution), grep ALL callers across the entire `backend/` and `frontend/` and confirm none broke (changed return shapes, new required args, enum changes). Walk the import graph of touched modules + their dependents.
   - **Full test suite, not just new tests:** run the **entire** existing Vitest suite (backend + any frontend), not only the loaner tests, and report any newly-failing test.
   - **Migration safety:** confirm the migration is strictly **additive** (new nullable columns / new enum / new table only — no drops, no renames, no NOT-NULL without default, no data loss); confirm rollback story.
   - **Money/gateway audit:** prove no gateway (SPIn / Authorize.Net / Payarc) is reachable from the new differential path; confirm no existing money math changed.
   - **Isolation proof:** demonstrate (test + reasoning) that `purpose=LOANER` rates never appear in a rental quote and vice-versa.
   - **Build/lint:** `node --check` import-graph walk; report what MUST be run on Hector's machine (`npm test`, `npm run build`, `prisma validate`, migration on SESSION port 5432) with expected results.
   - **Output:** a QA report with a PASS/FAIL per acceptance criterion + a regression verdict + an explicit go/no-go. No-go blocks the ship.

(The storefront `LoanerFlow.tsx` work in spec §6 is **out of scope** for these agents — that's your Rent & Go / Claude Code session. This plan delivers the exact contract it consumes.)

## 5. Phased build order (mapped to acceptance criteria)

- **Phase 0 — schema** (agent 1): `Rate.purpose` + `serviceVehicleTypeId` + additive migration. *Gate: `prisma validate`, migration applies on a scratch DB.*
- **Phase 1 — rate backend + admin** (agents 2, 5): loaner-tagged Rate resolution + rental-resolver isolation filter + Settings tab so the dealership can set per-class rates. *Gate: set a rate, read it back via API + UI; isolation test proves loaner rates don't appear in a rental quote.*
- **Phase 2 — intake entitlement** (agent 4): advisor picks service-vehicle class; stored on reservation. *Gate: new loaner intake persists `serviceVehicleTypeId`.*
- **Phase 3 — public endpoints** (agent 3): guard + differential + enriched `lookup`. *Gates ↦ acceptance criteria:*
  - AC1 lookup on `NEW`/`CONFIRMED` returns serviceVehicle+class, entitledClassLabel, assignedLoaner, per-loaner dailyRate/upgradeDeltaPerDay, agreement, status ✓
  - AC2 lookup on `CHECKED_OUT`/`CHECKED_IN` returns status + agreement ✓
  - AC3 `reserve` on `CHECKED_OUT`+ → 409 ✓
  - AC4 `reserve` above entitled class → records pending differential (no online charge); same/lower → $0 ✓
- **Phase 4 — verify** (agent 6): tests + curls + ship script `2026-06-25-ship-public-loaner-class-upgrade-betaNNN.sh`. *Gate: all curls pass against a seeded tenant; new tests green.*
- **Phase 5 — QA / regression sign-off** (agent 7): independent whole-app audit per §4.7. *Gate: PASS on all 4 acceptance criteria + regression verdict = no new failures + migration confirmed additive + money/gateway clean. A no-go blocks the ship; the ship script does not run until QA signs off.*

## 6. Risks & notes

- **Money-adjacent code.** Differential touches billing fields. Per house rule, the diff that records charges/`estimatedTotal` should be reviewed by Hector before push; **no gateway calls**.
- **Legacy rows.** Reservations created before this lack `serviceVehicleTypeId` → entitlement falls back to the assigned loaner's class (delta $0). No backfill required unless desired.
- **Migrations** via SESSION port 5432 (pgbouncer 6543 hangs Prisma) — same caveat as the rest of RFM.
- **Rate-limit** on `/api/public/loaner` is in-process per replica (40/min) — fine for a storefront, not distributed.
- **Tenant token** for `rent-by-vphmotors` already provisioned; if a 401 appears, re-issue via `backend/scripts/gen-website-token.mjs` and update `TRIANGLE_TENANT_TOKEN` in Vercel.

## 7. Status

D1–D5 **locked** (see §3). Two minor defaults applied (unset rate = $0/covered; portal route `/customer/loaner-portal`) — change either by saying so. Plan is ready to execute on Hector's go.
