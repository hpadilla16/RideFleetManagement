# Performance Prep — 15-20 Staff User Tenant Onboarding

**Date:** 2026-04-28
**Owner:** Hector
**Scope:** One existing tenant scaling from a few staff users to **~15-20 simultaneous staff users** on the back-office UI. Public booking / customer surface load is unchanged.
**Status:** Scoping — actions below are proposals, not commits.

---

## 1. Context & assumptions

A new operator is onboarding 15-20 employees onto an existing tenant. They'll all be hitting the back-office (`/`, `/reservations`, `/reservations/[id]`, `/customers`, `/vehicles`, `/dashboard`, etc.) in parallel during business hours — creating reservations, opening reservation detail to check status, running reports, posting payments.

**Assumed worst-case load profile:**

- ~15 concurrent active staff sessions
- Each session loads the dashboard on login + auto-refreshes the reservation list every few minutes
- Each session has 1-2 reservation detail pages open at any time
- Burst pattern: morning ramp 8-9am, afternoon spike 1-3pm, smoother off-peak

**Out of scope** (defer to separate planning):

- Public booking surface (`/api/public/booking/*`) — its own load profile.
- Multi-tenant cross-tenant load (we're scaling one tenant, not adding many).
- Mobile apps (Capacitor employee app, Flutter car-sharing app) — they hit different APIs.

---

## 2. Current state

### 2.1 Instrumentation

| Surface | State | Notes |
|---|---|---|
| Sentry | Wired (`backend/src/lib/sentry.js:23`) | Traces sample rate reads `SENTRY_TRACES_SAMPLE_RATE` env, **default 0** — so production captures errors but not performance traces. Single biggest "free win" lever to flip first. |
| Logger | Winston (`backend/src/lib/logger.js`) | `requestLogger()` middleware in `main.js:53` records duration per request. Logged but not aggregated; no dashboard. |
| Compression | Enabled (`main.js:4,52`) | `compression()` with `threshold: 1024`. Good. |
| Cache | `backend/src/lib/cache.js` (in-memory LRU) | TTL 5 min default, max 500 entries, per-worker. No Redis backing → cluster workers don't share. **Underused** — survey didn't find heavy adoption in hot paths. |
| Prisma logging | `log: ['error', 'warn']` only (`prisma.js:3-5`) | No slow-query log; no query event listener. |
| APM | None beyond Sentry traces (off) | No Datadog / Honeycomb / NewRelic. |

### 2.2 Database

- **Pool size:** 20 connections (`prisma.js:18-24`, configurable via `DATABASE_POOL_SIZE`).
- **Pool timeout:** 10s (`DATABASE_POOL_TIMEOUT`).
- **Migrations:** 28 to date. Recent perf-focused: `20260410_add_performance_indexes`, `20260415_add_multi_tenant_indexes`, `20260416_add_performance_indexes`.
- **Indexes:** 45+ across the schema. Coverage looks decent; nothing obviously missing in the hot path. Reservation list pagination relies on a full-table scan + sort (no `(tenantId, createdAt)` composite); mitigated by `LIMIT` clauses.

### 2.3 Hot endpoints (back-office, what staff hit constantly)

| Endpoint | Rough cost | Risk under 15-20 concurrent | Why |
|---|---|---|---|
| `GET /api/reservations/page` (paginated list) | 1 main query + 4 hydration round-trips | **HIGH** | Hydration in `reservations.service.js:999` is sequential — 5 queries per request × 15 staff hitting list refreshes ≈ 75 queries pending against a 20-connection pool. **Most likely to choke first.** |
| `GET /api/reservations/{id}` (detail) | 1 query w/ deep `include` (charges, payments, drivers) | MEDIUM | Single query, but payload size scales with agreement charges/payments. Bounded but hefty. |
| `GET /api/reservations/{id}/pricing-options` | 5 parallel `findMany` (locations, services, fees, insurance, franchises) | MEDIUM | Re-fetches everything every time the detail page loads. **Should cache.** |
| `GET /api/reservations/summary` (dashboard KPI) | Multiple filtered `findMany` + in-memory aggregation | MEDIUM | Recomputed on every dashboard mount. **Should cache for ~30s.** |
| `GET /api/reservations` (full list) | Single query with eager `select` | LOW | Fine. Used less often than the paginated `/page` variant. |
| `GET /api/reservations/{id}/pricing` (called by reservation detail + checkout) | Toll-transaction update path (just optimized in beta.8) | LOW (was HIGH) | Sentry trace flagged 6+ sequential `prisma.tollTransaction.update` inside a `$transaction` — fixed by grouping into `updateMany` calls in the v0.9.0-beta.8 chore PR. Watch CI metrics post-deploy to confirm. |

### 2.4 Frontend

- All reservation pages declare `'use client'`. No SSR / SSG / ISR is in play; first-paint waits on bundle download + API calls.
- No `next.config.js`; defaults apply.
- No `dynamic()` imports / lazy loading observed in scanned files.
- Reservation detail page is **2,563 lines** of single-file React. Big bundle, lots of state.

### 2.5 Known fixed issues (already shipped)

| Issue | Where | Status |
|---|---|---|
| BUG-002 — `calculateShortage` over-reports phantom shortage on return day | `planner.service.js:402` | Fixed in v0.9.0-beta.7 chore PR (`e7dd5c9`) |
| Toll N+1 in `/api/reservations/:id/pricing` | `tolls.service.js:1241` | Fixed in v0.9.0-beta.8 chore PR (`8ff6d21`) |
| Logger ReferenceError in review-email catch | `reservations.service.js:1290` | Fixed in v0.9.0-beta.7 chore PR (`4d8c74e`) |

---

## 3. Likely bottlenecks under 10× staff load

Ranked by perceived risk (highest first), with rationale:

### 3.1 HIGH — Connection-pool starvation on reservation list refresh

`hydrateReservationListRows()` at `reservations.service.js:999` runs 4 batch queries sequentially after the main paginated `findMany`. That's 5 round-trips per `GET /api/reservations/page` request. With ~15 staff each refreshing the list every 30-60s, the queue against a 20-connection pool can saturate during the morning ramp.

**Symptom you'll see first:** intermittent `connection pool timeout` errors in Sentry, reservation list spinner stuck for 5-10s, occasional 504s.

### 3.2 MEDIUM-HIGH — Repeated re-fetches of slowly-changing reference data

`/api/reservations/{id}/pricing-options` re-fetches **all** locations, services, fees, insurance plans, and franchises every time a staff member opens reservation detail. None of these change often — they're settings-tier data. With reservation detail being one of the most-opened pages, this is wasted DB work many times per minute.

`/api/reservations/summary` (dashboard KPI) is in the same shape — re-aggregated on every dashboard load, without short-TTL caching.

### 3.3 MEDIUM — Unbounded payload sizes on reservation detail

`reservations.service.js:1022-1048`'s `findFirst` includes nested `rentalAgreement` with `charges` + `payments`. For a typical reservation that's fine; for a long-running rental with many addendums + payments + charges, the payload can balloon to hundreds of KB. Plus the frontend page parses 2,563 lines of JS to render it.

### 3.4 MEDIUM — No SSE/WebSocket hardening

The handoff and `CLAUDE.md` mention trip-chat SSE with 30s heartbeat. Long-lived SSE connections can pin a Node worker / DB connection if not multiplexed correctly. Not a problem at current load but worth verifying before 15-20 staff sessions are open all day.

### 3.5 LOW — Frontend bundle size

Reservation detail's 2.5k-line bundle is large but not catastrophic. Only matters at first paint. Lazy-loading sub-tabs (checkout, inspection, payments) would help but isn't blocking.

### 3.6 LOW — Cache coherence under cluster mode

`cache.js` is per-worker; if `CLUSTER_WORKERS > 1` and there's no Redis (the file warns about this), workers see different cache states. Acceptable trade-off until you actually scale to multi-worker prod.

---

## 4. Recommended actions

Tagged by effort (S/M/L) and expected impact (low/med/high). Numbers below are rough; treat as planning estimates, not commitments.

### 4.1 Instrumentation (do these first — they're cheap and they tell you what to fix)

| # | Action | Effort | Impact | Notes |
|---|---|---|---|---|
| I-1 | Bump `SENTRY_TRACES_SAMPLE_RATE` to `0.1` in prod env | S (5 min) | High | Get real traces flowing. Watch the "Slow Endpoints" view in Sentry for 1 week to validate the bottleneck ranking above. |
| I-2 | Add Prisma slow-query logging (`log: [{ emit: 'event', level: 'query' }]` + listener that warns when `e.duration > 200`) | S (1 hr) | High | Surfaces N+1 / missing-index issues directly in `logger.warn` lines. |
| I-3 | Extend `requestLogger` to log a Sentry breadcrumb when `duration > 1000ms` | S (30 min) | Medium | Cheap signal to correlate slow requests with Sentry traces. |
| I-4 | Set up a simple `/api/admin/perf-snapshot` endpoint that returns process metrics (heap, event-loop lag, DB pool state via `prisma.$metrics`) — admin-only | M (2-3 hrs) | Medium | Lightweight self-serve diagnostic. |

### 4.2 Quick wins (Phase 1, days 1-3)

| # | Action | Effort | Impact | Notes |
|---|---|---|---|---|
| Q-1 | Bump `DATABASE_POOL_SIZE` to 30-40 in prod env (verify against Supabase pooler limits — likely fine in transaction-mode pgbouncer) | S (5 min) | High | Buys headroom for the reservation-list hydration burst. |
| Q-2 | Cache `/api/reservations/{id}/pricing-options` payload via `cache.getOrSet` with TTL 60s, keyed by tenant + reservation-pickup-location | S (1 hr) | High | Settings-tier data; staff opening the same reservation 3× in 5 min should hit cache for 2 of 3. |
| Q-3 | Cache `/api/reservations/summary` per `tenantId` with TTL 30s | S (1 hr) | High | Dashboard KPI cache. Stale-by-30s is fine for staff visibility. |
| Q-4 | Cache `/api/locations`, `/api/vehicle-types`, `/api/fees`, `/api/insurance-plans`, `/api/franchises` (all tenant-scoped) with TTL 5 min | M (2-3 hrs) | Medium-High | Many endpoints fan out to these. The cache module is built; just wire it up. |
| Q-5 | Add `Vary: Accept-Encoding, Authorization` headers on cacheable endpoints | S (15 min) | Low | Defensive; don't accidentally serve a wrong tenant's cached blob. |

### 4.3 Medium (Phase 2, weeks 1-2)

| # | Action | Effort | Impact | Notes |
|---|---|---|---|---|
| M-1 | Refactor `hydrateReservationListRows` to run the 4 batch queries in a single `Promise.all` (currently they're inside the awaited function chain — verify if they're already parallel; if not, parallelize) | M (3-4 hrs) | High | Cuts /api/reservations/page round-trip cost roughly in half. |
| M-2 | Trim payload on `/api/reservations/page` — drop `rentalAgreement.charges` and `rentalAgreement.payments` from the list response (they're only needed in detail view) | S (1 hr) | Medium-High | List page doesn't render these; pure waste over the wire. |
| M-3 | Add `(tenantId, createdAt DESC)` composite index on `Reservation` to make pagination an index scan rather than full table scan + sort | S (30 min for migration; 2-5 min for the actual `CREATE INDEX CONCURRENTLY` on prod) | Medium | Modest now, larger as the row count grows past 100k. |
| M-4 | Convert reservation list refresh to **stale-while-revalidate**: render last response immediately, refresh in background | M (4 hrs frontend + small backend) | Medium | UX win and load reducer. |
| M-5 | Frontend code-split the reservation detail page — lazy-load the checkout / inspection / payments sub-trees | M (4-6 hrs) | Medium | Smaller first-paint bundle. Most reservations don't need every sub-tree. |
| M-6 | SSE connection audit — confirm trip-chat SSE doesn't hold open DB connections; use HTTP keepalive only | M (3 hrs) | Medium | Pre-emptive; not yet a problem at current scale. |

### 4.4 Longer-term (Phase 3, weeks 2-4 or beyond)

| # | Action | Effort | Impact | Notes |
|---|---|---|---|---|
| L-1 | Replace per-worker in-memory cache with Redis-backed (still keyed by the same API; just swap the backend) | L (1-2 days) | High at multi-worker scale | Required if `CLUSTER_WORKERS > 1` and you actually want shared cache. Until then, single-worker prod is fine. |
| L-2 | Migrate `/api/reports/overview` and `/api/reservations/summary` to a materialized view in Postgres that refreshes every N minutes | L (1-2 days) | Medium-High at >1000 reservations/day | Future-proofing; not blocking for 15-20 staff. |
| L-3 | Add a Postgres read replica for heavy read traffic (reports, dashboards) | L (1 day infra + 0.5 day code) | High at scale | Supabase Pro supports this; not needed yet. |
| L-4 | Real APM (Datadog / Honeycomb / Sentry Performance Plus) | L (1-2 days incl. dashboards) | High visibility | After I-1 if Sentry's free tier traces aren't enough. |
| L-5 | E2E load test against staging with k6 / artillery — simulate 20 concurrent staff sessions with the actual access patterns | L (1-2 days incl. fixture seeding) | High confidence | The single best way to validate any of the above worked. |

---

## 5. Phased plan

Concrete, time-boxed sequence. Adjust as Sentry data comes in.

### Week 1 — instrumentation + quick wins

**Goal:** know where you actually hurt, then defang the obvious offenders.

- Day 1: ship I-1, I-2, I-3 in a small PR. Watch Sentry for 24-48h.
- Day 2: based on the data, ship Q-1 + Q-2 + Q-3 + Q-4 in a "perf-quick-wins" PR.
- Day 3: validate with a 30-min synthetic load test (15 simultaneous tabs hitting reservation list / detail). Confirm /health stays green and pool doesn't exhaust.

**Exit criteria:**

- `SENTRY_TRACES_SAMPLE_RATE = 0.1` deployed.
- Slow-query log emitting under prod-grade traffic.
- `/api/reservations/{id}/pricing-options` and `/api/reservations/summary` cache hit rate > 80%.
- p95 latency on `/api/reservations/page` < 800ms (current; aim 500ms after Phase 2).

### Weeks 2-3 — medium fixes

**Goal:** cut the fat from the highest-traffic endpoint and make the frontend feel snappier.

- Week 2: M-1 (parallelize hydration) + M-2 (trim payload) + M-3 (composite index) in one PR. The combination should drop reservation-list p95 substantially.
- Week 3: M-4 (stale-while-revalidate frontend) + M-5 (code-split detail) in separate PRs.
- M-6 (SSE audit) in parallel as a separate small investigation.

**Exit criteria:**

- p95 `/api/reservations/page` < 500ms.
- p95 `/api/reservations/{id}` < 300ms.
- Reservation detail page first-paint bundle reduced by 30%+ (measure with Next's `--profile` flag).

### Week 4+ — longer-term

L-1 through L-5 are scaled-up choices. Pick based on what Sentry says about Phase 1+2 outcomes; don't pre-commit. L-5 (load test) is the most useful first long-term action because it gives you data to argue the rest with.

---

## 6. Success metrics

Define "done" so we know when to stop. Targets are educated guesses; revise after Phase 1 data lands.

| Metric | Today (estimated) | Phase 1 target | Phase 2 target |
|---|---|---|---|
| p95 latency `/api/reservations/page` | ~1500ms (extrapolated; actual TBD by I-1) | < 800ms | < 500ms |
| p95 latency `/api/reservations/{id}` | ~600ms | < 400ms | < 300ms |
| p95 latency `/api/reservations/summary` | ~700ms | < 200ms (cached) | < 200ms |
| Sentry tracing | 0% sampled | 10% sampled | 10% sampled |
| Cache hit rate on settings-tier endpoints | 0% | > 80% | > 90% |
| Connection-pool timeouts under 20-user concurrent load | unknown (untested) | 0 | 0 |
| Reservation detail bundle size | ~2.5k LOC single file | unchanged | -30% via code splitting |

---

## 7. Open questions (decide before Phase 2)

1. **Cluster vs single-worker prod?** Currently the prod docker compose runs single-worker (per `main.js`). If we'll stay single-worker for the foreseeable future, the per-worker cache is fine and L-1 (Redis) can wait. If we plan to cluster soon, prioritize L-1.
2. **Supabase pooler limits.** Bumping `DATABASE_POOL_SIZE` to 30-40 (Q-1) needs to fit under the pooler's `max_client_conn`. Confirm via Supabase dashboard. The pooler uses transaction mode so per-app pool sizes can be moderate; avoid overshooting.
3. **Staff usage shape.** Are these 15-20 staff active simultaneously all day, or more like 5-8 active concurrent in any given hour with rotation? The phasing above assumes the tighter case; if it's the looser one, Phase 2 may not be needed urgently.
4. **What "premier-product" means for the reservation-list UX.** A polished list view (filters, saved searches, server-side pagination cursors) might shift bottlenecks. If the loaner-module premier scoping (separate doc) reshapes UX patterns, revisit M-4 / M-5 in light of that.

---

## 8. References

- Survey commit: this doc was written from a perf-landscape survey of `backend/src/lib/{cache,sentry,prisma}.js`, `backend/src/main.js`, `backend/src/modules/reservations/`, `backend/prisma/schema.prisma`, and `backend/prisma/migrations/`.
- Prior fixes: BUG-002 (planner shortage), BUG-003 (PayArc imports), toll-transaction N+1 — all closed in `doc/known-bugs-2026-04-23.md`.
- Deploy / release runbook: `docs/operations/version-control-and-release.md`.
- Bug backlog format: `doc/known-bugs-2026-04-23.md`.
