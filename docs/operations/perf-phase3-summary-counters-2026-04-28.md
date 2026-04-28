# Perf Phase 3 — L-2 daily counter table for reservations summary

**Date:** 2026-04-28
**Owner:** Hector
**Branch:** `feat/perf-phase3-summary-counters`
**Source plan:** [`performance-prep-2026-04-28.md`](./performance-prep-2026-04-28.md)

This is the implementation closeout for **Phase 3 / L-2**. The perf prep doc described L-2 as "Migrate `/api/reports/overview` and `/api/reservations/summary` to a materialized view in Postgres that refreshes every N minutes". This PR ships the summary half of that and explains why it's a regular table rather than a literal `MATERIALIZED VIEW`.

## Why a counter table, not a Postgres `MATERIALIZED VIEW`

The summary endpoint computes "today's" pickup/return counts in **the tenant's local timezone**:

```js
const tenantTimeZone = String(reservationOptions?.tenantTimeZone || 'America/Puerto_Rico');
const nowInTz = new Date(new Date().toLocaleString('en-US', { timeZone: tenantTimeZone }));
const todayStr = `${nowInTz.getFullYear()}-${String(nowInTz.getMonth() + 1).padStart(2, '0')}-${String(nowInTz.getDate()).padStart(2, '0')}`;
const dayStart = new Date(`${todayStr}T00:00:00`);
```

Each tenant's "today" is a different window. A single MV with a fixed time bucket would either need to recompute every tenant on every refresh (`REFRESH MATERIALIZED VIEW` always recomputes the entire view) or store per-tenant rows anyway — at which point you might as well use a regular table that's upsertable per-tenant. The regular table also tests cleanly under `node --test` (just monkey-patch prisma) where MVs need a real Postgres.

## What shipped

### Schema + migration

**`prisma/schema.prisma`** — new `ReservationDailyCounter` model:

```prisma
model ReservationDailyCounter {
  id             String   @id @default(cuid())
  tenantId       String?
  day            DateTime
  pickupsToday   Int      @default(0)
  returnsToday   Int      @default(0)
  checkedOut     Int      @default(0)
  feeAdvisories  Int      @default(0)
  noShows        Int      @default(0)
  refreshedAt    DateTime @default(now())
  createdAt      DateTime @default(now())
  updatedAt      DateTime @updatedAt

  @@unique([tenantId, day])
  @@index([tenantId, refreshedAt])
}
```

**`prisma/migrations/20260428_add_reservation_daily_counter/migration.sql`** — `CREATE TABLE IF NOT EXISTS` + the unique and lookup indexes. Idempotent.

### Service module

**`backend/src/modules/reservations/reservation-summary-counters.service.js`**:

- `readFreshCounters({ tenantId, day, maxAgeMs })` — returns the row if `refreshedAt` is within `maxAgeMs` (default 5 min); otherwise null. A row that's too stale is treated as a miss so the caller falls back to live aggregation.
- `refreshCounters({ tenantId, day, dayStart, dayEnd })` — runs the same 5 `prisma.reservation.count(...)` queries the live summary path runs (in parallel via `Promise.all`), then upserts the row.
- `refreshCountersAsync(args)` — fire-and-forget wrapper. Errors are swallowed so a counter-table outage can't break the request that triggered it.

### Wiring into `reservationsService.summary()`

The 5 expensive `count()` queries inside the existing `Promise.all` are now conditional:

- If `readFreshCounters` returns a hit, each count slot is a literal value (e.g. `cachedCounters.pickupsToday`).
- Otherwise the existing live `prisma.reservation.count(...)` runs.
- The 4 `findFirst` queries for the "next" items always run live (cheap; they need fresh data).

After the response is computed, if the counter table was a miss/stale, `refreshCountersAsync(...)` fires (not awaited) so the next request hits the table.

### Tests

**`backend/src/modules/reservations/reservation-summary-counters.test.mjs`** — 7 sub-tests:

- `readFreshCounters` returns the row when refreshedAt is within `maxAgeMs`.
- `readFreshCounters` returns null when stale.
- `readFreshCounters` returns null when no row exists.
- `readFreshCounters` returns null and does not throw on prisma rejection.
- `refreshCounters` runs 5 count() calls and upserts the result.
- `refreshCounters` returns null and does not throw on count() rejection (and does NOT run the upsert).
- `refreshCounters` returns null on missing args.

All 7 sub-tests pass under `node --test`. (The file-level `not ok` is the same prisma-engine sandbox artifact that affects every backend test in the sandbox; CI runs `prisma:generate` first and is unaffected.)

## What this changes for users

**Today, no visible change.** The Phase 1 cache layer (30s TTL on `/api/reservations/summary`) already shields the live aggregation cost behind one query per 30 seconds per tenant. The counter table sits underneath that cache as a second layer.

**At >100 reservations/day per tenant**, counts start to creep into 50-100ms. That's when this PR pays off — the dashboard endpoint's count work drops to a single PK lookup on `ReservationDailyCounter`.

**At scale (>1000 reservations/day per tenant or many tenants)**, the wins compound. The 5 sequential `COUNT(*)` queries against a growing Reservation table get replaced by a 5-integer-column row read.

## Rollout plan

1. **Merge.** Deploys the migration. The table is created but no rows exist yet.
2. **First request after deploy** for any given tenant: counter table miss → falls back to live aggregation → `refreshCountersAsync` writes a row.
3. **Subsequent requests within 5 minutes** for that tenant: counter table hit → fast path.
4. **Optional follow-up: wire up a scheduler.** Today the counter table is refreshed reactively on miss. A scheduler that calls `refreshCounters` for every active tenant every minute would eliminate the on-miss recompute path entirely. Suggested location: `backend/src/modules/reservations/reservation-summary-scheduler.js` alongside the existing toll/handoff schedulers in `main.js`. Not in this PR — separate ops decision.

## What about `/api/reports/overview`?

The doc bundled it with the summary endpoint, but `/api/reports/overview` accepts an arbitrary date range + optional location filter. That's a different shape problem — you'd either pre-compute every conceivable (range, location) tuple (combinatorial explosion) or compute on-demand and cache by `(tenantId, range, location)` key. The latter is just an extension of the Phase 1 cache pattern and doesn't need its own table.

Deferred to a separate PR if/when the load test shows it actually needs intervention.

## Risk assessment

**Low.**

- The migration is idempotent (`CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`).
- The new code path is fall-through-safe: if any part of the counter system fails (prisma rejection, missing model, table not yet created), the live aggregation runs as before. No request can fail because of this PR that wouldn't have failed before.
- The 5 `count()` queries inside `Promise.all` change shape — they're now ternary expressions choosing between a literal and the live count. Same shape contract.
- `refreshCountersAsync` is fire-and-forget with caught errors, so a counter-table write failure can't poison the response that triggered it.

**Specifically not at risk:**

- Tenant isolation — every counter row is scoped by `tenantId` (nullable for SUPER_ADMIN cross-tenant view); reads use the unique `(tenantId, day)` index.
- API contract — `/api/reservations/summary` returns the same shape as before.
- Phase 1 cache — the 30s cache layer in `reservations.routes.js` still runs in front of this. The counter table is a second-tier optimization underneath.

## Verification before merge

1. `cd backend && npm run prisma:generate` — regenerates the prisma client with the new model.
2. `npm run test` — full chain green.
3. `npm run prisma:migrate` (in dev) or apply the SQL via `db push` (against the deployment DB through Supabase — same pattern as the addendum migration) — table created.
4. CI green on `feat/perf-phase3-summary-counters`.
