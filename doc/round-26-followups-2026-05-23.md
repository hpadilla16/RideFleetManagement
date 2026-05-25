# Round 26 deploy followups — to address before next live attempt

**Date:** 2026-05-23 evening + 2026-05-24 early hours
**Final tags this session:** `v0.9.0-beta.71` (initial deploy, rolled back) → `v0.9.0-beta.72` (hotfix re-deploy, also rolled back) → `v0.9.0-beta.56` (current stable).

**Why rollback at the end:** Hector not available next day to firefight. Both `beta.71` and `beta.72` were validated as far as we could at 4–5am, then deliberately rolled back so IRC agents work the next day on the proven-stable `beta.56` baseline. Both newer tags preserved on `origin/main` for redeploy when staffing allows on-site coverage.

This doc captures everything found during both smoke sessions. Read it first when you come back to the Dejavoo + Reports v2 work.

> **Note:** Sections 1–9 below are from **Session 1** (`beta.71` smoke, 2026-05-23 evening).
> **Session 2** findings (`beta.72` smoke, 2026-05-24 early AM) are in **Sections 10–16** at the bottom. **The fixes Hector landed during Session 2 are in `beta.72`; bugs that remain open after Session 2 still need fixing for the next attempt.**

---

## ✅ What worked in `beta.71`

Validated during smoke test:

- `fleet-db-prod`, `fleet-backend-prod`, `fleet-worker-prod`, `fleet-frontend-prod` — all healthy
- Backend cluster mode (4 workers), Prisma pool size 24, Redis pub/sub connected to the DO managed cluster
- `/api/reports/list` returns 401 (auth required) → routes registered correctly
- 16 of 18 reports built and wired (damage + chargeback deferred — see below)
- `backend/scripts/audit-commissions.mjs` ran cleanly inside the backend container

Plus everything the build + up did was clean — image build, container start, healthcheck cycle all green.

---

## 🔴 Critical followups (block clean live use)

### 1. Commission plan + rules — 0 active in production DB

**Symptom from audit-commissions:** 167 CLOSED agreements have 159 AgreementCommission rows (95% coverage — trigger works), but **157 of 159 are $0.00** because there are zero active CommissionPlans and zero active CommissionRules in the DB.

**What to do:**

1. Open the Commissions settings UI (or query directly: `SELECT * FROM "CommissionPlan"`, `SELECT * FROM "CommissionRule"` — verify both empty).
2. Create one CommissionPlan and mark `isActive: true`.
3. Create CommissionRules for each charge code that should pay commission. The catalog already used by `commission-sales-performance.report.js` is the right starting point:
   - `TOLLS` — $1/sale
   - `TIRE_GLASS` — $1/sale
   - `ROADSIDE` — $1/sale
   - `LIABILITY` — $2/sale
   - `INSURANCE` — $3/sale
   - `ADDITIONAL_DRIVER` — $1/sale
   - `CAR_SEAT` — $1/sale
   - `PRE_PAID_GAS` — $1/sale
4. Either assign the plan to each employee via `User.commissionPlanId`, OR leave it as the tenant default plan (all users inherit when their own plan is null).

Once active, every new agreement that closes will start generating non-zero AgreementCommission rows. **Historical rows stay at $0** unless you backfill them — possibly worth a small script that recalculates retroactively for the current month.

### 2. iPOSpays disclaimer — already configured for TPN 816026739983

**Status:** done by Hector on the iPOSpays portal during this deploy. ASCII-only, 255-char limit, English only:

> `This card stays on file. By using it you authorize charges for todays rental and any post rental fees including damage, late return, tolls, fines, and cleaning, valid 12 months. You agree not to dispute. See Terms in your contract.`

Stays on the terminal even after the rollback. **Safe to leave configured** — even if legacy code doesn't use AutoRental Sale that triggers it, the disclaimer just won't fire. No customer-facing harm.

### 3. Feature flag `dejavooCounter` / `interactiveTC` for IRC

**Observed in tonight's smoke test:** checkout went straight to the legacy signature flow, never reached the Dejavoo terminal. That means the feature flag gating is working correctly — the Dejavoo path is hidden by default until the flag is flipped.

**For the next deploy attempt:**

1. Confirm the flag names in the codebase (round 25 doc mentioned `dejavooCounter` AND `interactiveTC` — both need to be on).
2. Flip them to TEST for IRC tenant via the feature-flags admin UI (or directly: `UPDATE "TenantFeatureFlag" SET state = 'TEST' WHERE tenantId = '<IRC-tenant-id>' AND flagKey IN ('dejavooCounter', 'interactiveTC');`).
3. Do ONE controlled real-customer transaction in TEST mode to confirm the flow.
4. Flip to LIVE for IRC after that single transaction validates.

This is the Phase-5 of the original Round 26 plan (`doc/round-26-plan-2026-05-23.md` lines 171–174). Was deferred tonight because no on-site coverage for the next day.

### 4. Terminal signature → PDF initials wiring (in `beta.71`, will revert with rollback)

This is the new code that:

- Writes `Reservation.signatureDataUrl` whenever the Dejavoo Sale or AUTH returns a signature
- Inlines a 22-px-tall `<img>` of that signature in the 4 INITIALS_S11_* + INITIALS_S13 markers of the agreement PDF

Files: `counter-orchestrator.service.js`, `rental-agreements.service.js`, `lib/terms/index.js`, `lib/terms/index.test.mjs` (3 new tests).

**On rollback to beta.56:** this code is gone. Re-deploys with the next attempt of `beta.71` (or whatever the next tag is).

### 5. `INITIALS_S4_DECLINE` left blank (renders as `___`)

The terminal disclaimer covers S11 (card-on-file, CNP, no-chargeback) and S13 (post-rental charges) — but NOT S4 (optional-coverage decline). Auto-filling S4 from the same terminal signature would be legally weaker than the other 4 slots.

**To fix:** capture the customer's "decline optional coverage" decision separately in the checkout wizard, BEFORE the terminal step. Then pass it as the 5th key in the `initialsForTerms` object built in `rental-agreements.service.js`. Probably a checkbox the agent ticks (or the customer signs on a tablet).

---

## 🟡 Important but not blocking

### 6. BullMQ warning: Redis eviction policy is `allkeys-lru`

Worker logs show:

```
IMPORTANT! Eviction policy is allkeys-lru. It should be "noeviction"
```

**Risk:** if the DigitalOcean managed Redis cluster fills up, it'll evict random keys — including queued jobs (autocharge, counter.checkin, counter.return). Lost jobs = lost financial events.

**Fix:** in the DO control panel for the Redis cluster, change the eviction policy from `allkeys-lru` to `noeviction`. Once set, the cluster will reject new writes when full instead of silently dropping old keys — that's the safer failure mode for a queue.

Pre-existing, not caused by this deploy.

### 7. 12 stuck `FINALIZED` agreements

Status distribution from audit:

```
FINALIZED   179
CLOSED      167
DRAFT        32
```

The gap (179 − 167 = 12) suggests some agreements reach `FINALIZED` but never transition to `CLOSED`. The commission trigger only fires on `CLOSED`, so these 12 never get an AgreementCommission row.

**To investigate:** find code paths that mark an agreement as `FINALIZED` but don't follow up with the `CLOSED` step. Likely a return-flow edge case. Look at `checkin-close.service.js` and the return wizard.

### 8. 8 unexplained agreement → commission gaps

Of 167 CLOSED agreements, 159 have commission rows. The other 8 didn't pass through `syncAgreementCommissionSnapshot()` at all — neither Gate 2 nor Gate 3 victims (those counts are 0).

**Hypothesis:** some close path bypasses the snapshot helper (e.g. a script that flips status directly, an admin override, an older code path). Worth grepping for `status: 'CLOSED'` writes that don't follow with a call to the snapshot helper.

### 9. The 2 deferred reports (damage + chargeback)

Both blocked on schema:

- **`damage`** — DamageFinding + repair-cost model not finalized. When the schema lands, the report is ~1 engineer-day.
- **`chargeback`** — no way today to mark a payment / reservation as having a chargeback. Needs either a `Chargeback` table linked to `RentalAgreementPayment`, or a status field. Then the report is ~1.5 days.

Both stay in `REPORT_REGISTRY` as `COMING_SOON`. Tiles render dimmed on the landing page.

---

## 🟢 Polish items deferred (not affecting prod)

These were in the roadmap but not done this round:

- Caching: cover more heavy reports (only `utilization` and `availability-forecast.soldOutByMonth` are cached today).
- Slug pair confusion: `availability` vs `availability-forecast`, `commission` vs `commission-sales-performance`. Titles were clarified in `beta.71` ("Availability — Right Now", "Commission Payouts"); slugs not renamed because file-delete isn't available in the dev environment.
- Backfill script for historical AgreementCommissions once rules are configured.

---

## Deploy ledger update

| When | What | Tag | State |
|---|---|---|---|
| 2026-05-23 morning | Round 26 plan written | — | doc |
| 2026-05-23 day | 13 new reports + Dejavoo signature → PDF initials + audit script | (HEAD on `origin/main`) | committed |
| 2026-05-23 evening | Tag `v0.9.0-beta.71` pushed; deployed to droplet (after dev/prod compose-file confusion + recovery) | v0.9.0-beta.71 | deployed + smoke-tested |
| 2026-05-23 night | Rolled back to v0.9.0-beta.56 (no overnight on-site coverage) — first rollback | v0.9.0-beta.56 | stable (temporary) |
| 2026-05-24 03:30am | Session 2 began: flipped dejavooCounter + interactiveTC to LIVE for IRC | — | live flag flip |
| 2026-05-24 04:15am | Cazados bugs #10 (deposit double-charge) + #11 (RentalClassId 2201). Hotfixes committed. | (HEAD on `origin/main`) | committed |
| 2026-05-24 04:30am | First `beta.72` build pointed at wrong commit (Mac edits not synced to droplet); rebuilt correctly after Mac→git→droplet sync | v0.9.0-beta.72 | deployed + smoke-tested |
| 2026-05-24 04:50am | Reports v2 smoke found bugs #16 + #17 (Availability Forecast crash + Fleet Status status mismatch) | — | documented |
| 2026-05-24 ~05:00am | Final rollback to v0.9.0-beta.56 | v0.9.0-beta.56 | **STABLE — current** |
| 2026-05-?? | Round 27 ready (after #1, #12, #13, #14, #16, #17 are addressed + Hector on-site) | v0.9.0-beta.73 (next) | pending |

---

## Redeploy procedure when you come back

After fixing the followups (mainly #1 — commission rules):

```bash
cd ~/RideFleetManagement
git fetch --tags --force
git checkout v0.9.0-beta.71

# If you've changed anything since (new tag), checkout that instead.

docker compose -f docker-compose.prod.yml down       # don't pass -v
docker compose -f docker-compose.prod.yml build --no-cache backend worker frontend
docker compose -f docker-compose.prod.yml up -d
docker compose -f docker-compose.prod.yml ps
docker compose -f docker-compose.prod.yml logs backend --tail=30
```

**Lessons from tonight:**

1. Always use `-f docker-compose.prod.yml` on the droplet. Default `docker compose` reads `docker-compose.yml` which is the DEV config. Hardcoded `postgres/postgres` creds + `npm run dev` bind-mounts — wrong for production.
2. Before any production `up -d`, sanity-check `docker volume ls` to confirm prod data volume (`ridefleetmanagement_fleet_pg_data_prod`) is intact.
3. Never pass `-v` or `--volumes` to `down` on the prod compose unless you're explicitly wiping data.

---

# 🌙 Session 2 — `beta.72` smoke (2026-05-24 ~03:30–04:55 AM)

## What we did this session

After the `beta.71` rollback, the next morning never happened — Hector came back the same night at ~3:30am to push further. The plan: flip the Dejavoo feature flags to LIVE on `beta.56`, run a real-customer smoke test, document findings, rollback before morning shift.

Sequence:

1. **Flipped `dejavooCounter` + `interactiveTC` from OFF → LIVE** for IRC tenant in production. Used SQL directly in Supabase against `Tenant.settingsJson.featureFlags` (the lib `setTenantFlag()` couldn't be used from psql; SQL bypassed the audit-log + cache-invalidation that the lib does, so backend was restarted to clear in-memory cache). Verified via `getTenantFlags()` from inside the backend container.
2. **First checkout attempt:** wizard sent to legacy `signing` endpoint, NOT Dejavoo. Root cause: frontend caches `/api/me/feature-flags` response in React state. Hard-refresh the browser (Cmd+Shift+R) and the new flag state propagated. After that the wizard correctly routed to the Dejavoo orchestrator. **→ Session 2 followup #14.**
3. **Second attempt:** wizard sent total of **$339.20** = rental fee $89.20 + security deposit $250 combined into one Sale. Customer would have been charged the deposit AS A REAL CHARGE on top of the $250 AUTH hold = double-charged. Hector aborted before swipe. **→ This is Session 2 bug #10, fixed in code, see below.**
4. **Implemented the deposit double-charge fix** in `counter-orchestrator.service.js` + `counter-return-orchestrator.service.js`. Added `isDepositCharge()` helper (filters on `code`, `source`, and `name` for legacy data tolerance).
5. **Third attempt:** SPIn rejected with statusCode `2201`: `"Rental Class Id must be 4 Digit value or Rental Class Id is not between 0001-0032 and 9999"`. Terminal never showed anything (SPIn validation rejection before terminal interaction). **→ Session 2 bug #11, fixed in code.**
6. **Implemented the RentalClassId fix** in `spin-client.js`. Added `normalizeRentalClassId()` that defaults to `'9999'` (SPIn catch-all) when the vehicle's class code doesn't match the required 4-digit numeric range.
7. **Initial `beta.72` build:** Hector ran `git add && git commit && git tag && git push` ON THE DROPLET, but the edits were on his Mac — not in the droplet's working dir. The tag pointed to the old `beta.71` HEAD. Verified via `docker compose exec backend grep RentalClassId …` — the old code was still in the running container. Re-deployed correctly by syncing from Mac → git → droplet, then `git checkout v0.9.0-beta.72 && docker compose build --no-cache`. **→ Session 2 followup #15.**
8. **Fourth attempt (post correct `beta.72` deploy):** got `statusCode 1012 "Canceled"` in 2.4 seconds — terminal stuck from prior aborts. Power-cycle of the Dejavoo physical terminal would unstick it (we never confirmed that path because the next attempt worked anyway).
9. **Fifth attempt:** terminal **showed the itemized cart + "pay" screen**. Hector aborted before swiping a real card. **No disclaimer screen appeared. No signature prompt** (signature would have been after swipe — couldn't validate because of the abort, but disclaimer should have shown BEFORE the cart). **→ Session 2 followups #12 + #13.**
10. **Reports v2 smoke test:** all 16 tiles present on `/reports-v2/` landing. Spot-checked 4 reports. Found 2 real bugs. **→ Session 2 bugs #16, #17.**

---

## ✅ What got fixed in `beta.72` (committed, deployed, rolled back, ready to redeploy)

### 10. Security deposit double-charge — FIXED in code

**Symptom:** wizard total was $89.20 (correct) but checkout SALE submitted $339.20 (wrong — `$89.20 + $250 deposit`). The deposit was also held as a separate AUTH on top, so net would have been **deposit charged once for real + held a second time** if Hector hadn't aborted.

**Root cause:** in `counter-orchestrator.service.js` step 7a, the `rentalFeeDollars` calc summed ALL selected `ReservationCharge` rows without filtering out deposit-coded lines. The booking engine writes a Security Deposit line into `ReservationCharge` for UI visibility — that row is meant to be informational, not to feed into the SALE.

**The fix:** new exported helper `isDepositCharge(charge)` checks three signals:

- `code` IN `('SECURITY_DEPOSIT', 'DEPOSIT', 'DEPOSIT_DUE')`
- `source` IN `('SECURITY_DEPOSIT', 'DEPOSIT')` (booking-engine writes `source: 'SECURITY_DEPOSIT'`)
- `name` matches `/^security deposit/i` (catches legacy rows where `code` and `source` are `null`, which is what we found in production — the booking engine only started populating those fields recently)

Applied to:

- `counter-orchestrator.service.js` `rentalFeeDollars` calc (line 387–393 area, now also filters via `isDepositCharge`)
- `counter-return-orchestrator.service.js` `computeFinalAmountCents` (same filter — return flow has the same exposure)

Tests: 24/24 orchestrator tests still pass.

### 11. SPIn 2201 — `RentalClassId` must be 4-digit 0001-0032 or 9999 — FIXED in code

**Symptom:** SPIn rejected every `AutoRental/Sale` request before reaching the terminal. detailedMessage:
> `Invalid request data : Rental Class Id must be 4 Digit value or Rental Class Id is not between 0001-0032 and 9999`

**Root cause:** `spin-client.js` `buildLevel3FromReservation` sent `RentalClassId: (vehicle.classCode || vehicle.vehicleType?.code || '').slice(0, 10)`. Our internal vehicle data uses ACRISS letter codes ('SFAR', 'ECAR', etc.) or empty strings. SPIn requires a numeric 4-digit code in the ACRISS-numeric range 0001-0032, OR the catch-all 9999. Anything else → 2201.

**The fix:** new exported helper `normalizeRentalClassId(raw)`:

```js
export function normalizeRentalClassId(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (/^\d{4}$/.test(s)) {
    const n = parseInt(s, 10);
    if ((n >= 1 && n <= 32) || n === 9999) return s;
  }
  return '9999';
}
```

Used at line 582-area replacing the old `.slice(0, 10)`. Defaults to `'9999'` (the SPIn catch-all "all others / not specified") when the value isn't a valid 4-digit code in range. Tests: 18/18 spin-client extension tests pass, including 7 new cases for the normalizer.

**Followup polish (not blocking):** map our internal vehicle classes to SPIn ACRISS-numeric codes (`0001`–`0032`) for actual chargeback evidence quality. `'9999'` works but loses reporting granularity on Dejavoo's side. Add a `numericClassCode` column to `Vehicle` or `VehicleType` and populate via a migration. Probably half a day of work.

---

## 🔴 New critical findings from Session 2 (open — fix before next deploy)

### 12. Disclaimer didn't appear on terminal (open)

**Symptom:** during the 5th attempt (the successful one through `beta.72` + correct deploy + power-cycle implicit), the terminal showed the itemized cart and then the pay screen — but **NO disclaimer page** before the cart. Per round 25 design, the iPOSpays portal config should have triggered the disclaimer automatically as the first screen of any `AutoRental Sale`.

**Possible causes (in order of likelihood):**

1. iPOSpays portal config didn't actually save, or it saved against a different Sale Type (not "AutoRental Sale"). Re-open the portal at https://www.iposconnect.com (TPN 816026739983) and verify:
   - The disclaimer is attached to `AutoRental Sale` (or whatever the explicit Sale Type is for our `v2/AutoRental/Sale` calls).
   - The text saved matches what we drafted (255 ASCII chars).
   - There's a separate "Show Disclaimer" toggle that needs to be ON.
2. The terminal firmware doesn't support inline disclaimer on AutoRental — only on plain Sale. Worth opening a Dejavoo support ticket to confirm.
3. The `AutoRental Sale` flow as configured by SPIn on this TPN explicitly skips the disclaimer step.

**Fix path:** start with #1 (portal re-verification — takes 5 minutes). If portal looks fine, call Dejavoo merchant support to confirm the TPN profile honors the disclaimer flag on AutoRental.

### 13. Signature not captured (open — unverified)

**Symptom:** `Reservation.signatureDataUrl` was `null` after the smoke test. `DejavooTransaction.rawResponse` for the latest attempt had no `SignatureData` field.

**Caveat:** Hector aborted before swiping the card, so the signature prompt (which on Dejavoo comes AFTER card auth) wouldn't have appeared anyway. We can't conclusively say signature capture is broken — only that it didn't fire on an aborted transaction.

**To validate cleanly:** next deploy, run ONE complete checkout with a real card (Hector's own or a test card) to a fully approved state. If `Reservation.signatureDataUrl IS NULL` after that, then the terminal didn't honor `CaptureSignature: true` — call Dejavoo support to enable signature capture on TPN 816026739983.

The orchestrator code IS sending `CaptureSignature: true` on both `autoRentalSale` (line 339) and `autoRentalAuth` (line 367). And the wiring from `SignatureData` → `Reservation.signatureDataUrl` is also in place (the Round 25/26 work). So if the field shows up in the response, the rest of the chain should work.

### 14. Frontend caches `/api/me/feature-flags` until hard refresh (open — UX bug)

**Symptom:** after flipping flags via SQL + backend restart, the wizard still routed to the legacy signing endpoint until Hector did `Cmd+Shift+R`. The new boolean from `/api/me/feature-flags` wasn't picked up because the frontend cached the response at app boot in a React context / SWR cache.

**Fix:** add a 60-second SWR `revalidateOnFocus` to the `/api/me/feature-flags` query, OR push a `window.location.reload()` from an admin "I just flipped flags, propagate now" button, OR push the flag state via the existing Redis pub/sub channel (heavier).

Quickest is the SWR revalidate. It would have saved ~10 minutes of debugging tonight.

### 15. Deploy workflow: edits on Mac don't reach droplet — drop a `make deploy` (open — process bug)

**What happened:** I made code edits via the assistant's Edit tool, which writes to Hector's Mac filesystem at `~/Code/RideFleetManagement`. The droplet has a separate git clone at `~/RideFleetManagement`. Running `git add && git commit && git tag && git push` ON THE DROPLET silently produced an empty commit + tagged at the OLD HEAD because the droplet's working tree didn't have the edits.

**Fix path:** a small `make deploy-droplet` or shell script in the repo root that:

1. Asserts cwd is clean (no uncommitted changes locally — fail fast).
2. SSHes to the droplet, runs `git fetch --tags --force && git checkout <tag> && docker compose -f docker-compose.prod.yml build --no-cache backend worker frontend && docker compose -f docker-compose.prod.yml up -d`.
3. Tails logs for 60s after up to catch crashes.

Forces the Mac→git→droplet pipeline as the only path, removes the temptation to commit from inside the droplet.

---

## 🟡 Reports v2 bugs found in smoke (Session 2)

### 16. Availability Forecast — per Vehicle Type — Prisma crash on `not: "RETIRED"` (open)

**Symptom:** opening `/reports-v2/availability-forecast` renders this error on screen instead of the report:

```
Invalid `prisma.vehicleType.findMany()` invocation: { where: { tenantId: "cmn98hc1u0085ke0i4vefujt3" }, select: { id: true, code: true, name: true, vehicles: { where: { status: { not: "RETIRED" } }, select: { id: true } } } } Invalid value for argument `not`. Expected VehicleStatus.
```

**Root cause:** report query filters `vehicles.status.not = "RETIRED"` but the `VehicleStatus` enum doesn't include `RETIRED`. Current enum members:

```prisma
enum VehicleStatus {
  AVAILABLE
  RESERVED
  ON_RENT
  IN_MAINTENANCE
  OUT_OF_SERVICE
}
```

**Fix options:**

- **A (quickest):** replace `not: "RETIRED"` with `not: "OUT_OF_SERVICE"` if the intent was "exclude retired/sold-off vehicles" (OUT_OF_SERVICE is currently the closest semantic match).
- **B (cleaner):** add `RETIRED` to the enum + migration, then leave the report query as-is. Useful because we ALSO have a Sale-now / Upcoming Vehicle Sales report — eventually we need a sink status for sold/retired units. The Upcoming Vehicle Sales report already shows 9 candidates over threshold; once they're sold there's no current status to mark them as.
- **C:** drop the filter entirely and accept that all 5 statuses count toward forecast inventory. Simplest but maybe overcounts.

Recommend **B** as the right long-term answer. Touch this when you add a Vehicle status transition for sold vehicles anyway.

### 17. Fleet Status — "On rent" count says 0 but rows show active customers (open)

**Symptom:** on `/reports-v2/fleet-status`, the summary cards show:

- Fleet total: **125** vehicles
- Available: **125** (100% of fleet)
- On rent: **0** (0% of fleet)
- Out of service: 0

But the row table contradicts this — e.g. `2023 Ford F-150 · BLUE · #UNIT-012` shows Status `Available` AND a current customer `VENTURA VIVONI · due Sun May 24 · 5:00pm` in the same row. A vehicle with an active customer due back today isn't "Available".

**Root cause hypothesis:** the report computes `On rent` based on `Vehicle.status = 'ON_RENT'` in the DB, but the "Current customer" column is computed by looking up any active `RentalAgreement` (status != CLOSED) on the vehicle. These two data sources are out of sync — `Vehicle.status` doesn't get flipped to `ON_RENT` when an agreement is opened.

**Fix options:**

- **A:** fix the source of truth — write `Vehicle.status = 'ON_RENT'` whenever an agreement opens (and back to `AVAILABLE` on close). Probably a trigger or post-save hook in `rental-agreements.service.js`. Risk: race conditions if multiple agreements exist on the same vehicle.
- **B:** change the report to derive status from active-agreement existence instead of `Vehicle.status`. Less invasive; the rest of the app keeps using `Vehicle.status` for booking conflicts (which is its real purpose). The status column on Fleet Status would then be a *computed* "On rent if active agreement exists, else Available, else IN_MAINTENANCE/OUT_OF_SERVICE".

Recommend **B** for the report. Schedule **A** for a separate pass — the schema invariant matters elsewhere too (Reports v2 utilization, availability, availability-forecast all depend on it being accurate).

---

## 🟢 Lower-priority data observations (not bugs, but worth noting)

- **Upcoming Vehicle Sales report:** several vehicles show `Mileage: 0` — fleet mileage tracking is sparse. The `2019 Land Rover Range Rover · UNIT-L001` shows mileage `1` which is almost certainly a data-entry typo (a `1` where someone meant `100,000` or similar). Data-cleanup pass, not a code bug.
- **Reports Snapshot card "Reservations checked out: 0" for the current month:** real (no completed checkouts via the live Dejavoo flow yet, only aborts) but visually surprising. Maybe add a "this includes today" note or change the wording.
- **Commission Payouts report worked** ($37 across 96 commission lines for the month — confirms the audit script's finding that 2/159 rows have non-zero amounts because there are no active plans/rules yet. Followup #1 from session 1 still stands as the way to make commissions real.).

---

## 🧭 What to do tomorrow (recommended sequence)

1. **iPOSpays portal walk-through** with the disclaimer config. Confirm Sale Type association. (5 min)
2. **Pick up `beta.72` for redeploy.** All Session 1 + Session 2 code fixes are already committed there. No new code needed before next attempt.
3. **Apply Session 2 reports bugs (#16 + #17) ON TOP of `beta.72`** as `beta.73`. Both are isolated to report files (`availability-forecast.report.js`, `fleet-status.report.js`) — low blast radius.
4. **Apply Session 2 followup #14 (frontend SWR revalidate)** in the same `beta.73`.
5. **Re-deploy `beta.73`.** Run ONE complete real-card checkout with no abort. Validate:
   - Disclaimer appears
   - Signature is captured (`Reservation.signatureDataUrl` populated)
   - PDF agreement shows the 4 INITIALS_* slots with the signature image
6. **If signature still doesn't fire:** open Dejavoo support ticket re: `CaptureSignature: true` on TPN 816026739983.
7. **DO NOT skip:** Configure `CommissionPlan` + `CommissionRules` from Session 1 followup #1. Without this, every closed agreement still creates `$0` commission rows. The Commission report will keep showing $37 forever.
