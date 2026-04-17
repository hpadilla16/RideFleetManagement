# RideFleet Scaling Roadmap

This document captures scaling work that is **not yet done** but is on deck as the
platform grows. The business goal is to compete with established fleet-management
vendors like TSD, which means we need production-grade multi-host deployment,
low-latency reservation flows, and strong cache consistency across workers.

---

## 1. Redis-backed distributed cache (high priority for multi-server)

### Current state (as of 2026-04-16)

[backend/src/lib/cache.js](../../backend/src/lib/cache.js) is a JavaScript `Map` living
inside each cluster worker. With `CLUSTER_WORKERS=4` we effectively run **four
independent caches** that don't talk to each other. When cache entries are
invalidated (role change, module-access update, config edit), only the worker
that processed the write clears its local copy — siblings keep serving stale data
until the TTL expires.

We've mitigated this short-term by:

- Shortening the auth session TTL to **30s** ([auth.service.js:8](../../backend/src/modules/auth/auth.service.js)).
  A demoted user can still hit a stale worker for up to 30s.
- Logging a startup warning when `CLUSTER_WORKERS > 1 && !REDIS_URL`.

### Why this must change before we scale

- **Horizontal scaling**: the moment we run more than one backend host (two
  droplets behind a load balancer, Kubernetes, Fly.io, etc.), "cross-worker
  staleness" turns into "cross-host staleness" — now measured in TTL, not ms.
- **Cache usage will grow**: today only 6 modules use the cache (auth,
  module-access, knowledge-base, AI search, payment-gateway config, SMS config).
  As we add Voltswitch telematics polling, live dispatch boards, listing search,
  and real-time availability, we'll want caching on much hotter paths where
  inconsistency is more visible.
- **Rate-limiting needs it**: the 30s token-issuance cooldown in
  [reservations.routes.js](../../backend/src/modules/reservations/reservations.routes.js)
  (added 2026-04-16) is currently per-worker. An attacker hitting a 4-worker
  cluster can issue 4x the allowed tokens. Shared rate-limiter state needs
  Redis (or a DB-backed alternative with decent latency).

### Proposed implementation

**Package**: `ioredis` (mature, handles reconnects, cluster-aware).

**Infra**: add a `redis:7-alpine` container to [docker-compose.yml](../../docker-compose.yml)
and `docker-compose.prod.yml`. Single-node is fine until we need HA. Persist
to disk with AOF for durability across restarts (though cache data is by
definition disposable — a cold start just means the first N requests fall
through to Postgres).

**Code changes**:

1. Create `backend/src/lib/cache-redis.js` that exports the same interface
   as `cache.js` (`get`, `set`, `del`, `invalidate`, `getOrSet`, `stats`).
2. Switch `cache.js` to be a facade that returns the Redis impl when
   `REDIS_URL` is set, otherwise the in-memory impl. Callers don't change.
3. `invalidate(prefix)` uses Redis `SCAN` + `DEL` batching (avoid `KEYS` —
   blocks the server). Consider keyspace notifications for fan-out later.
4. Add `redis-cli ping` health check to startup.
5. On Redis outage, fail-over to in-memory (log a `warn`) rather than hard-crash.

**Ops**:

- Backups: Redis is a cache, not source of truth — snapshots optional, but AOF
  avoids thundering-herd on restart.
- Monitoring: add Sentry breadcrumbs or a `/metrics` Prometheus endpoint for
  hit/miss ratio, latency, memory use.
- Memory budget: start with 256MB cap, `maxmemory-policy allkeys-lru`.

### Estimated effort

**4-8 hours** including docker-compose wiring, the facade, tests,
and a local staging validation. Low-risk because the interface is stable
and the fallback-to-in-memory path preserves behavior on Redis failure.

### When to pull the trigger

Do it **before** either of these happens:

- [ ] We provision a second backend host (even for staging).
- [ ] We add a high-write cache path (live vehicle telematics, trip chat,
      availability grid) where 30s staleness would hurt UX.
- [ ] We start charging based on per-tenant usage (rate-limiter correctness matters for billing).

---

## 2. Secondary items (after Redis)

### 2a. Move reservation audit trail out of `notes`

Today system events (signature requested, payment requested, admin override,
email sent/failed) are appended to `Reservation.notes` with a 16KB cap
([appendSystemNote](../../backend/src/modules/reservations/reservations.routes.js)).
Once cap hits, the oldest events truncate. For compliance/dispute workflows
we'll want an append-only `ReservationAuditEvent` table with structured
fields (event type, actor, timestamp, metadata JSON). `AuditLog` partially
covers this but isn't written to consistently.

### 2b. Background job queue

Currently email sends, report generation, and Voltswitch telematics polling
are synchronous inside HTTP handlers. Move to a queue (BullMQ on Redis once
Redis lands) so request latency stops depending on external service speed.

### 2c. Read replica for reports

Reports service runs wide-range aggregate queries
([reports.service.js](../../backend/src/modules/reports/reports.service.js))
that compete with transactional writes on the primary. When report load
becomes visible in reservation latency, point heavy queries at a Supabase
read replica via `DATABASE_URL_REPLICA`.

### 2d. Full-text search for customers / vehicles

Today customer/vehicle search uses `ILIKE '%foo%'` which can't use indexes.
At tens of thousands of rows this becomes the slow query. Switch to Postgres
full-text search (`tsvector` + GIN index) or pg_trgm for fuzzy matching.

---

## 3. Competitive context

**TSD** offers the dominant dealership loaner / rental management product in
the US. Their advantages we need to match or beat:

- Multi-location enterprise customers with dozens of concurrent operators.
- Deep integrations: DMS (CDK, Reynolds), insurance, payment.
- Uptime expectations — they're an operational dependency, not a tool.

Performance and cache consistency matter because slow ops workflows and
stale permissions are *very* visible to operators and sales, and will
surface fast in demos against TSD.
