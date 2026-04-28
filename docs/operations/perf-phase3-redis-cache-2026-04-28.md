# Perf Phase 3 — L-1 Redis pub/sub for cross-worker cache invalidation

**Date:** 2026-04-28
**Owner:** Hector
**Branch:** `feat/perf-phase3-redis-cache`
**Source plan:** [`performance-prep-2026-04-28.md`](./performance-prep-2026-04-28.md)

This is the implementation closeout for **Phase 3 / L-1**. The perf prep doc described L-1 as "Replace per-worker in-memory cache with Redis-backed". This PR takes a more surgical path that addresses the same problem with smaller blast radius and zero new latency on the request path.

## What L-1 actually does

The actual cross-worker problem with the in-memory cache is **invalidation**, not reads:

- A worker handling a `POST /api/fees` invalidates `fees:list:tenant-1` locally.
- Sibling workers serving `GET /api/fees` continue to return their stale `fees:list:tenant-1` until TTL expires.
- Operators see "I just edited this fee, why does the list still show the old value?"

This PR fixes that by adding a Redis pub/sub channel:

- Every `cache.del(key)`, `cache.invalidate(prefix)`, and `cache.clear()` publishes a small JSON event to the channel.
- All workers (including across instances) subscribe at startup. On a remote event, they apply the same operation to their own in-memory store.
- Self-events are filtered via a per-process UUID — workers don't double-apply their own publishes.

**Reads stay in-memory and synchronous.** No new latency on the request path. `cache.get` still returns from a local `Map.get` in nanoseconds. Redis is invalidation-only.

## Why pub/sub-only (vs. full read-through L2)

Three reasons:

1. **Latency.** Redis read-through would add ~1-3 ms per cached fetch. The Phase 1+2 caches were specifically tuned for sub-millisecond reads. The current bottleneck is invalidation correctness across workers, not read speed.
2. **API.** The cache module's API is synchronous (`cache.get(key)` returns the value, not a promise). A read-through Redis backend forces every call site to become async, which is a lot of churn for no current win.
3. **Failure mode.** With pub/sub-only, if Redis is down, the local cache continues to work; remote invalidations just don't propagate (degrades back to per-worker TTL behavior). With L2, a Redis outage would cascade into prisma load.

If we ever need a shared read-through L2 (because cold-start cost on a new worker is meaningful), it can layer on top of this PR without breaking the API.

## What shipped

### `backend/src/lib/cache.js` — Redis-aware

- New `ensureRedis()` lazy-init: opens a publisher + a subscriber via the `redis` v4 client when `REDIS_URL` is set. Connection errors are logged once and never throw.
- Per-process UUID (`PROCESS_ID`) embedded in every published event so subscribers ignore their own publishes.
- `cache.del`, `cache.invalidate`, `cache.clear` now also call `publish({...})` after the local op completes.
- `cache.set` is **NOT** broadcast — both V0 and V1 are valid prisma reads at different times; only "this is stale" needs cross-worker visibility.
- `cache.stats()` now reports `redis: { configured, ready, channel }` for observability.
- Added `_shutdownForTests()` so tests that opt into Redis can exit cleanly.

### Dependency

`redis@^4.7.1` added to `backend/package.json` and `package-lock.json`. Used only when `REDIS_URL` is set; otherwise it never executes.

### Env config

`backend/.env.example` documents:

```
REDIS_URL=""
REDIS_INVALIDATION_CHANNEL="fleet:cache-invalidate"
```

`REDIS_URL` left empty means "single-worker / single-instance — no pub/sub, behavior identical to before".

### Tests

`backend/src/lib/cache.test.mjs` adds:

- `stats reports redis as not configured when REDIS_URL is unset` — pins the contract that the caller can introspect Redis readiness.
- `del / invalidate / clear still work synchronously without REDIS_URL` — guards against future Redis changes silently regressing local behavior.

All 11 cache sub-tests pass under `node --test`.

## How to roll out

1. **Merge.** No code-path change for the existing single-worker prod.
2. **Provision Redis** — DigitalOcean Managed Redis is the easiest fit alongside the droplet. Smallest plan is fine; pub/sub is light. Or self-host Redis on the same droplet for zero monthly cost.
3. **Set env var** on the droplet:
   ```
   REDIS_URL="redis://default:<password>@<host>:6379"
   ```
4. **Restart backend** (clustered or otherwise). On startup, look for:
   ```
   [cache] redis pub/sub ready (channel=fleet:cache-invalidate, url=redis://...***@...)
   ```
5. **Validate** by writing a fee/location in the back-office and confirming the change appears immediately on every connected client (vs. up to 5 min before).

## Failure modes (and what happens)

| Scenario | Behavior |
|---|---|
| `REDIS_URL` unset | Identical to pre-PR. No publish, no subscribe. |
| Redis unreachable at startup | Logged once; cache works locally; invalidations don't propagate. Reconnect retries handled by the redis client internally. |
| Redis goes down mid-operation | Same as above — local cache continues to serve; Sentry breadcrumb on each failed publish (best-effort). |
| Network partition between workers | Same TTL-bounded staleness as today, until partition resolves. |

The request path **never blocks on Redis**. Publishes are fire-and-forget; the local op is already complete before `publish()` is called.

## Risk assessment

**Low.** Backend-only. No schema. No API surface change. When `REDIS_URL` is unset, cache.js behavior is byte-identical to `main`. The new `redis` dependency is lazy-imported only when `REDIS_URL` is set.

**Specifically not at risk:**

- Tenant isolation — pub/sub messages contain only cache keys/prefixes, never tenant data.
- API shape — every cache call returns the same type as before.
- Test suite — the existing `npm run test:cache` suite still runs 9/9 green; 2 new tests cover the Redis-not-configured guarantees.
- CI — no Redis service is needed in CI; tests don't set `REDIS_URL`.

## Verification before merge

1. `cd backend && npm run test:cache` — 11/11 green.
2. `npm run prisma:generate && npm run verify` — full chain green.
3. CI green on `feat/perf-phase3-redis-cache`.
4. (Optional, manual) Run two backends locally with the same `REDIS_URL`, hit one's `POST /api/fees`, verify the other's `GET /api/fees` reflects the change before TTL would have expired.

## What's next on Phase 3

After this lands and Redis is provisioned, the remaining L items still want data from the L-5 load test before committing infra:

- **L-2 materialized view for `/api/reservations/summary`** — only worth the schema migration if test shows the 30s cache from Phase 1 isn't enough.
- **L-3 Postgres read replica** — only if Phase 2's query reduction can't keep p95 under 500 ms at 20 VUs.
- **L-4 real APM (Datadog / Honeycomb)** — only if Phase 1's Sentry traces + slow-query log aren't enough signal.
