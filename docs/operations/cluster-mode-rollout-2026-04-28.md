# Cluster Mode Rollout

**Date:** 2026-04-28
**Owner:** Hector
**Status:** Operational guide. Code already exists at `backend/src/cluster.js`. This doc covers when to enable it, what has to be true before you do, the rollout steps, and rollback.

**Related runbooks** (each ships in its own PR; the file links below resolve only after the corresponding PR merges into `main`):

- `docs/operations/performance-prep-2026-04-28.md` — original perf plan. Ships in the `chore/post-beta8-followup` branch (already committed; available once that branch is merged).
- `docs/operations/perf-phase3-redis-cache-2026-04-28.md` — L-1 Redis pub/sub closeout. Ships in PR #18 (`feat/perf-phase3-redis-cache`).
- `docs/operations/perf-phase1-2026-04-28.md` — Phase 1 instrumentation closeout. Ships in PR #15 (`feat/perf-phase1`).

If you're reading this doc on `main` and any of those filenames don't yet exist, the prerequisite PR hasn't been merged. The action items in this doc still hold; the links just won't render until the dependent PRs land.

## Why this matters

The droplet has 4 vCPUs. A single Node process uses **one of them at a time**. Cluster mode (`npm run start:cluster`) forks one Node worker per vCPU and load-balances incoming requests across them — roughly a 4× throughput jump for CPU-bound work.

This is the cheapest perf step on the path before any infra spend. Per the earlier session conversation: "watch Sentry for the signs, the first move when you see them is turn on cluster mode — 5-minute change, big throughput jump."

## When to enable it

Pull the trigger when **any** of these is true:

| Signal | Threshold |
|---|---|
| Single-process CPU | Sustained > 50% during peak hours |
| Reservation list refresh latency | p95 > 500 ms even with Phase 1 + Phase 2 caches |
| Connection-pool warnings | Sentry reports occasional pool timeouts |
| Concurrent staff users | > 25 simultaneous sessions |
| Deploy downtime | The 30s blip on every backend restart starts hurting |

Don't pre-emptively turn it on if none of the above are firing — clustered mode adds complexity (per-worker state, log multiplication, scheduler-deduplication) for no immediate gain. The Phase 1+2 work this session shipped is sized for single-process operation up to about 50 concurrent staff.

## What has to be true before you turn it on

Walk through this checklist. If any item is "no", fix it first or accept the trade-off.

### 1. Redis pub/sub for cache invalidation — STRONGLY RECOMMENDED

`backend/src/lib/cache.js` is per-worker by default. Without Redis, a write on worker A invalidates A's local cache but B/C/D keep serving stale data until TTL expires (5 min for reference data caches).

**Status post-session 2026-04-28:** the Phase 3 L-1 PR adds Redis pub/sub for cross-worker invalidation. Once that's merged and `REDIS_URL` is set on the droplet, this requirement is satisfied.

**Test:** start two terminals locally with the same `REDIS_URL`, run `npm run dev` on each (different ports), edit a fee in one, refresh the fee list on the other — should reflect immediately.

### 2. Schedulers must run on exactly ONE worker

`backend/src/main.js` already gates schedulers with:

```js
const isFirstWorker = !cluster.isWorker || cluster.worker.id === 1;
if (isFirstWorker) {
  startTollAutoSyncScheduler();
  startHandoffReminderScheduler();
}
```

**Verify before rollout:** any new scheduler added between now and rollout is wrapped in the same `isFirstWorker` guard. Double-running schedulers can cause duplicate emails / SMS / pricing recalcs.

```bash
grep -nE "startTollAutoSync|startHandoffReminder|setInterval|setTimeout" backend/src/main.js backend/src/modules/**/*.scheduler.js
```

### 3. SSE connections shouldn't pin DB connections per worker

The trip-chat SSE endpoint (mentioned in `CLAUDE.md`) holds open long-lived connections. Multiplied across workers, a sloppy implementation could exhaust the DB pool.

**Verify:** `prisma.$queryRaw` calls inside SSE handlers are short-lived (request-response), not held for the duration of the connection. Check with:

```bash
grep -rn "/stream\|EventSource\|text/event-stream" backend/src
```

If any match holds a prisma connection across the SSE lifetime, fix that **before** going clustered.

### 4. In-memory state outside `cache.js` is OK to lose on restart

Each worker has its own memory. A custom in-memory Map outside the cache module won't be shared between workers and won't be invalidated by the L-1 pub/sub.

**Audit:** look for non-cache-module global state in the backend.

```bash
grep -rn "^const [A-Z_]* = new Map()\|new Map()$" backend/src --include='*.js'
```

If you find any (e.g., a homegrown counter or rate-limiter), evaluate whether it needs cross-worker sync. Most operational state is fine — login attempt counters, recently-issued tokens, etc., usually tolerate per-worker state.

### 5. Database connection pool can absorb N× workers

Each Node worker opens its own Prisma client → its own connection pool. The total number of DB connections opened by the backend = `pool_size × N_workers`.

Defaults to use in the math:

- **On `main` today (pre-Phase-1):** `DATABASE_POOL_SIZE` defaults to `20` (`backend/src/lib/prisma.js` — `process.env.DATABASE_POOL_SIZE || '20'`).
- **After PR #15 (Phase 1) merges:** the default rises to `30`. Phase 1's pool bump is one of its quick wins.

So the worst-case connection budget for a 4-worker cluster is:

- Today (main): `20 × 4 = 80`.
- After PR #15: `30 × 4 = 120`.

**Check Supabase pgbouncer's max connection limit.** Free tier ≈ 60 in transaction mode. If you exceed that, requests start hanging on connection acquisition.

**Mitigation:** set `DATABASE_POOL_SIZE` explicitly on the droplet env when running clustered, low enough that `pool_size × N_workers` stays under the pgbouncer ceiling. Reasonable starting points:

- pgbouncer cap of 60, 4 workers → `DATABASE_POOL_SIZE=12-15`.
- pgbouncer cap of 200, 4 workers → `DATABASE_POOL_SIZE=40-50`.

The Phase 1 instrumentation (once PR #15 merges) will surface pool timeouts in Sentry if the math doesn't work — that's your signal to lower the per-worker pool size.

### 6. Logs are still readable

Cluster mode produces N× the log lines. The Phase 1 `requestLogger` already tags every line with `requestId` and the `pid` (process ID), so you can grep by worker. Confirm that grouping in your log viewer (DO console, journalctl, or whatever you use) is by `requestId`, not just by chronology.

## Rollout steps

Once the checklist above is satisfied:

### Step 1 — Set the env var

On the droplet:

```bash
echo "CLUSTER_WORKERS=4" >> /path/to/.env
```

Or via `ops/start-day.ps1 -Env production` if you use the ops template.

### Step 2 — Switch the systemd unit / pm2 / Docker command

Wherever the backend is started in production, change `node src/main.js` (or `npm start`) to:

```
node src/cluster.js
```

Or via npm: `npm run start:cluster`.

### Step 3 — Restart the backend

```bash
sudo systemctl restart fleet-backend
# or whatever you use
```

You should see something like this in the logs. **Lines from different workers interleave non-deterministically** — the actual order on your screen will look messier than the example. What matters is that you observe each kind of line, not the exact sequence.

```
Primary 12345 starting 4 workers
Worker 12346 started
Worker 12347 started
Worker 12348 started
Worker 12349 started
Fleet backend listening on http://localhost:4000 (pid=12346)
Fleet backend listening on http://localhost:4000 (pid=12347)
Fleet backend listening on http://localhost:4000 (pid=12348)
Fleet backend listening on http://localhost:4000 (pid=12349)
```

Things to confirm in the output, not the order:

- One `Primary <pid> starting N workers` line.
- N `Worker <pid> started` lines (one per worker).
- N `Fleet backend listening on ...` lines (one per worker — same port; cluster mode shares the listener).
- **If `REDIS_URL` is set AND PR #18 (perf-phase3-redis-cache) is deployed:** also expect N `[cache] redis pub/sub ready (channel=...)` lines, one per worker. If that PR isn't deployed yet, this line won't appear and the per-worker caches stay isolated until TTL expires (single-tenant edits won't reflect on sibling workers within the TTL window).
- No `[cache] Running clustered with in-memory cache only` warning lines, **unless** you intentionally chose to roll out cluster mode without Redis. The warning line is a hint to provision Redis.

### Step 4 — Verify within 5 minutes

```
curl -s http://localhost:4000/health     # should still 200 with database: true
```

Then, in the dashboard / reservation list, do a workflow that exercises a write + a read:

- Edit a fee.
- Refresh the fee list a few times in a row. With Redis pub/sub deployed (PR #18), the change appears on every refresh regardless of which worker handles the read. **Without Redis** (cluster-mode-only rollout, no PR #18), the change can take up to TTL (5 min) to be visible on workers other than the one that handled the write — that's expected, not a bug.

### Step 5 — Watch Sentry for 24 hours

Specifically look for:

- New error spikes (a worker is crashing under a code path the single-worker process tolerated).
- Pool-timeout warnings (DB connection math was wrong; reduce `DATABASE_POOL_SIZE`).
- Duplicate scheduled-job side effects (a scheduler escaped the `isFirstWorker` gate).

If any of those appear, roll back (next section), debug, retry.

## Rollback

Cluster mode can be turned off at any time:

```bash
# revert systemd command back to: node src/main.js  (or npm start)
sudo systemctl restart fleet-backend
```

Optionally also unset `CLUSTER_WORKERS=4`. The cluster.js file falls back to single-process mode in any case if it's not invoked, so leaving the env var set is harmless.

Rollback is **fast** — the only state cluster mode introduced is the per-worker caches, which expire on TTL and are repopulated on next read regardless of single-vs-clustered.

## Operational notes

### Worker count

`cluster.js` reads `CLUSTER_WORKERS` env var, falling back to `min(availableParallelism(), 4)`. On a 4-vCPU droplet that's 4. On an 8-vCPU droplet it'd cap at 4 unless you bump the env or the cap.

The `Math.min(..., 4)` cap exists because most apps see diminishing returns past 4 workers per box — DB and downstream services become the bottleneck instead. If you scale vertically to 8 vCPUs, evaluate whether 4 workers is still right or you want 6-8.

### Worker crash recovery

`cluster.js` already has the auto-respawn line:

```js
cluster.on('exit', (worker, code, signal) => {
  console.error(`Worker ${worker.process.pid} exited (code=${code}, signal=${signal}). Restarting...`);
  cluster.fork();
});
```

A worker that crashes is automatically replaced. The bad request that crashed it gets a 5xx but subsequent requests keep working. Watch for crash patterns — if the same worker keeps dying, there's a real bug, not a transient.

### Zero-downtime deploys

Cluster mode unlocks rolling restarts. Instead of `systemctl restart` (which kills the primary + all workers), you can signal individual workers to gracefully drain and respawn. Pattern:

```bash
# Send SIGUSR2 to primary; primary tells each worker to exit one at a time
# and forks a replacement before signaling the next. No 502s for users.
kill -SIGUSR2 $(cat /run/fleet-backend.pid)
```

This requires a small extension to `cluster.js` to handle SIGUSR2 — not in scope for this rollout doc, but worth a follow-up if you want bullet-proof deploys later.

### Memory budget

Each worker uses its own heap. With 4 workers at ~250 MB each, you're using ~1 GB just for the backend. On an 8 GB droplet that's fine. On a 4 GB droplet you might have less headroom for Postgres + system processes.

`process.memoryUsage()` is exposed today; the Phase 1 perf-snapshot endpoint (mentioned but not built in I-4) would be a useful follow-up.

## What this doc explicitly does NOT change

- No code changes — `backend/src/cluster.js` already exists.
- No env changes — operator sets `CLUSTER_WORKERS` only when ready.
- No schema changes.

## Cross-references

Files that exist on `main` today:

- Cluster code: `backend/src/cluster.js`
- Scheduler gating: `backend/src/main.js` (`isFirstWorker` block)
- Cache module multi-worker warnings: `backend/src/lib/cache.js`

Runbooks that ship in their own PRs (links may not resolve until those PRs merge):

- `docs/operations/perf-phase1-2026-04-28.md` (Phase 1 Sentry instrumentation; helps surface clustered-mode issues) — PR #15 `feat/perf-phase1`.
- `docs/operations/perf-phase3-redis-cache-2026-04-28.md` (Phase 3 L-1 Redis pub/sub; prerequisite for clean clustered mode) — PR #18 `feat/perf-phase3-redis-cache`.
