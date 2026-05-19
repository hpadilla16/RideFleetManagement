# Session Handoff — 2026-05-19

**Last live deploy:** `v0.9.0-beta.43` on `ridefleetmanager.com`
**Branch focus:** `feature/pillar2-followups` (deployed) + `feature/pillar1-perf-hardening` (PR-1 merged via cherry-pick into pillar2-followups)
**Today's work:** Pillar 2 followups (email, LATE_RETURN, per-tenant fee rates with on/off toggle) + Pillar 1 PR-1 (Prisma pool + P2024 → 503)

---

## Tags shipped today (in order)

| Tag | Bundle | Branch |
|-----|--------|--------|
| `v0.9.0-beta.37` | Pillar 2 wizards relaunch (route swap to wizards, vehicle searcher, odometer auto-fill, Post-Check-in Fees panel, `[RES_CHECKIN]` notes for ops-view, status guards accept CHECKED_IN_UNPAID) | feature/pillar2-wizards |
| `v0.9.0-beta.38` | Email light-theme templates + PDF attachment + LATE_RETURN fee engine + 16q Per-tenant Fee Rate Settings UI (backend API + frontend tab) | feature/pillar2-followups |
| `v0.9.0-beta.39` | Checkin wizard fetches tenant rates and passes to useFeePreview (Step 3 preview matches what backend will charge) | feature/pillar2-followups |
| `v0.9.0-beta.40` | Dropped `requireModuleAccess('settings')` on fee-rates GET (so OPS/AGENT can read for preview) | feature/pillar2-followups |
| `v0.9.0-beta.41` | Wizard passes `?tenantId=<reservation.tenantId>` to fee-rates GET (super-admin support) | feature/pillar2-followups |
| `v0.9.0-beta.42` | Per-fee-type on/off toggle (engine skips fees with `isActive=false` instead of falling back to hardcoded) | feature/pillar2-followups |
| `v0.9.0-beta.43` | **Pillar 1 PR-1**: Prisma pool default 6 + backend 24 / worker 12 + statement_timeout 15s API / 60s worker + P2024 → 503 with Retry-After: 5 | feature/pillar2-followups |

All deployed via `docker compose -f docker-compose.prod.yml up -d --build --force-recreate` on the droplet.

---

## Infra changes that landed today

- **Supabase upgraded MICRO → LARGE** (max_connections went 60 → 160). Verified via `SELECT current_setting('max_connections')`.
- **Prod pool config (in `docker-compose.prod.yml`):**
  - Backend: `DATABASE_POOL_SIZE=24` × 4 cluster workers = 96 client connections
  - Worker: `DATABASE_POOL_SIZE=12` × 1 process = 12 client connections
  - Worker has `DATABASE_STATEMENT_TIMEOUT_MS=60000` override (API stays at 15s default)
  - Total budget: 108 / 160 = 67% utilization, 52 conns headroom for migrations/admin
- **Schema state in Supabase**: confirmed in sync. `Customer_deletionToken_key` UNIQUE already applied (existed before today). No prisma db push needed during deploys.

---

## Where work-in-progress branches stand

- `feature/pillar2-wizards` → HEAD `bc9237d` (tag v0.9.0-beta.37). Was the entry point; subsequent work moved to followups branch.
- `feature/pillar2-followups` → HEAD `ba1afc9` (tag v0.9.0-beta.43). **THIS IS PROD.** Has email fixes + LATE_RETURN + 16q + on/off toggle + PR-1 cherry-pick.
- `feature/pillar1-perf-hardening` → HEAD `3712e7f` (original PR-1 commit, NOT pushed). The PR-1 work was cherry-picked into pillar2-followups; this branch can be deleted or left as a reference.
- `main` → `495e290` (Pillar 2 wizards revert from before today's rebuild). **Out of date.** Needs merge from pillar2-followups soon.

---

## Pillar 1 plan status (per the Plan agent's design)

| PR | Substream | Hours | Risk | Status |
|----|-----------|-------|------|--------|
| **PR-1** | A.2 Prisma pool + P2024 → 503 | 2-3h | Low | ✅ **Deployed in beta.43** |
| PR-2 | A.1 Per-tenant rate limiter (Conservative tiers: 5K/15K/50K rpm) | 10-14h | Med | ⏳ Pending — depends on PR-1 |
| PR-3a | B.1a Cache tenant-key helpers + lint test | 4-6h | Low | ⏳ Pending |
| PR-3b | B.1b Codemod migrate 12 cache callsites | 8-10h | Med | ⏳ Pending — depends on PR-3a |
| PR-4 | B.2 BullMQ priority lanes (autocharge high / email-invoice normal / scraper low) | 4-6h | Low | ⏳ Pending |
| PR-5 | C.1+C.2 EndpointLoadObservation schema + sampling middleware | 13-18h | Med | ⏳ Pending |
| PR-6 | C.3 Weekly endpoint-load rollup cron | 4-6h | Low | ⏳ Pending — depends on PR-5 |

**Parallelizable to start tomorrow:** PR-2, PR-3a, PR-4, PR-5 (PR-3b and PR-6 wait on their prereqs).

**Hector's approved decisions** (from today, carried forward to tomorrow):
- Rate-limit defaults: **Conservative tier** (STANDARD 5K rpm / PREMIUM 15K rpm / ENTERPRISE 50K rpm)
- Telemetry table naming: **Keep both** — existing `LoadObservation` for biz volume, new `EndpointLoadObservation` + `EndpointLoadObservationDaily` for perf telemetry
- Cache callsite migration: **Codemod in a single PR** (PR-3b), grouped commits per module

---

## Pillar 2 follow-up bugs/UX known but not yet fixed

1. **Date validation on New Reservation form** — return < pickup currently fires the resolve-rate endpoint which returns 400 "No rate tables found". The form should block submission OR set the return date picker `min` to `pickupAt + 1 day`. Hector hit this today and self-resolved. ~30 min frontend fix.
2. **LATE_RETURN preview in Step 3** — backend computes & charges LATE_RETURN, but `useFeePreview` hook in `frontend/src/components/wizard/useFeePreview.js` doesn't have `computeLateReturnFee`. Step 3 misses it from the live preview. ~1h fix.
3. **Audit history for fee rate changes** — currently only `logger.info()`. No DB row of who changed what. V2.
4. **Per-location fee rate overrides UI** — schema supports it (FeeRate.locationId), V1 UI only exposes tenant defaults.

---

## Pillar 2 longer-standing pending items

(From `memory:project_pillar2_foundation` + master plan)

- **16g — Update terms language** for autocharge authorization. 281 pre-update reservations are `autochargeBlocked=true` until the terms change goes through legal review.
- **16h — Supabase Storage bucket** for manual payment receipts.
- **16l — Migrate inspection photos** from `RentalAgreementInspection.photosJson` (base64 in DB) to Supabase Storage. Post-foundation work.

---

## Key file locations (for fast lookup tomorrow)

**Backend:**
- Fee engine: `backend/src/modules/fees/fee-engine.service.js` — `HARDCODED_RATES`, `resolveRate` (returns null when tenant disabled), `computeCheckinFees`
- Fee rates API: `backend/src/modules/fees/fee-rates.service.js` + `fee-rates.routes.js` — GET + PUT with validation + `isActive` toggle
- Checkin orchestrator: `backend/src/modules/rental-agreements/checkin-close.service.js`
- Checkin emails: `backend/src/modules/rental-agreements/checkin-emails.service.js` — light theme templates + PDF attach
- Email templates: `backend/src/templates/invoice-after-checkin.html` + `receipt-paid-in-full.html`
- Prisma pool: `backend/src/lib/prisma.js` + `prisma-url.js` (pure helper for tests)
- Error handler: `backend/src/lib/errors.js` — `ServiceUnavailableError`, P2024 → 503 mapping

**Frontend:**
- Settings page (single file, tabs): `frontend/src/app/settings/page.js` — Inspection Fees tab at `feeRates`, FeeRatesTab component near bottom
- Checkin wizard: `frontend/src/app/reservations/[id]/checkin-wizard/page.js` — fetches fee rates with reservation tenantId
- Fee preview hook: `frontend/src/components/wizard/useFeePreview.js` — `rateOf` returns null when disabled

**Mockups:**
- 16q UI: `design/mockups/pillar2-fee-rates-settings/index.html`
- Wizards: `design/mockups/pillar2-checkin-checkout/index.html`

---

## How to resume tomorrow (concrete next steps)

### Option A: Continue Pillar 1 (most likely path)

1. Open new session, ask Claude to read this handoff doc first
2. Dispatch Plan agent (or use the existing Pillar 1 plan from today's conversation memory) to brief on PR-2 (Per-tenant rate limiter)
3. Decide: tomorrow's plan was to do PR-2, PR-3a, PR-4, PR-5 in parallel. With 4 agents simultaneously the throughput is high but coordination cost grows. Recommend starting with PR-4 (BullMQ lanes) and PR-3a (cache helpers) in parallel, as they're the least entangled.
4. Branch off `feature/pillar2-followups` for the next batch — call it `feature/pillar1-perf-batch-2` or similar
5. After each PR lands locally, commit + tag + deploy individually (incremental ship, not big-bang)

### Option B: Polish Pillar 2 follow-ups before more infra

1. Fix the date validation on New Reservation form (~30 min)
2. Add `computeLateReturnFee` to `useFeePreview` so Step 3 shows late return in preview (~1h)
3. Then continue Pillar 1

### Memory entries that the next session should auto-read

These are starred in `MEMORY.md` and will be loaded automatically:

- `project_90day_master_plan.md` — 8-pillar roadmap
- `project_pillar2_foundation.md` — Pillar 2 base
- `project_pillar2_beta37_deploy.md` — wizard relaunch context
- `project_pillar2_followups_shipped.md` — what was added on top (today's work)
- `project_pillar1_kickoff.md` — Pillar 1 plan + PR-1 status (now deployed)
- `feedback_paste_block_safety.md` — Hector's paste block preferences

---

## Quick sanity-check commands tomorrow

```bash
# Verify last deployed tag matches expectations
ssh root@ridefleetmanager.com "cd ~/RideFleetManagement && git describe --tags"
# Should print: v0.9.0-beta.43

# Verify Supabase pool budget
ssh root@ridefleetmanager.com "cd ~/RideFleetManagement && docker compose -f docker-compose.prod.yml logs backend --tail 20 | grep prisma"
# Should show: [prisma] appending connection_limit=24&pool_timeout=10&options=-c statement_timeout=15000...

# Verify branch state
cd ~/Code/RideFleetManagement && git fetch origin && git branch -vv && git log --oneline -5
```

---

End of handoff. Sleep well 🌙
