# Perf Phase 3 — L-3 Postgres read replica scoping

**Date:** 2026-04-28
**Owner:** Hector
**Status:** Scoping only — no code in this PR. Provides the implementation plan + readiness checklist for when L-5 load-test data says it's time.
**Source plan:** [`performance-prep-2026-04-28.md`](./performance-prep-2026-04-28.md)

This doc captures the design for **Phase 3 / L-3** so it's ready to execute the day Sentry traces or the L-5 load test surfaces a primary-DB bottleneck. We are not implementing it yet — the perf prep doc puts L-3 explicitly behind L-5 ("the load test gives data to argue the rest with"), and the Phase 1+2 wins haven't even been measured against production load yet.

## What L-3 actually is

A Postgres **read replica** is a second Postgres instance that streams writes from the primary in near-real-time (single-digit milliseconds typically; <1s under most conditions on Supabase). Read-only queries can be routed to it instead of the primary, taking that load off the write path entirely.

**Why we'd want one:**

- **Cost-isolating reports from operations.** A heavy `/api/reports/overview` query on a date range can hold connections and CPU on the primary, which is the same machine handling reservation creates and payment posts.
- **Geographic distribution.** A replica in a region closer to staff (e.g., West Coast for a Pacific Time tenant) cuts round-trip latency on dashboard refreshes.
- **Burn-down.** Migrations, big backfills, and ad-hoc analytics can run against the replica without competing with prod traffic.

**Why this app might NOT need one yet:** the Phase 1 cache layer + Phase 2 query reduction + Phase 3 L-2 counter table already trim a lot of the read load that would justify a replica. We need the load test (L-5) to confirm whether the primary DB is genuinely saturated or whether the app-side fixes were enough.

## Decision criteria — when to actually do this

Run the L-5 load test (`npm run load-test:reservations`) post-Phase-1+2-deploy at 20 VUs against staging. Do L-3 when:

| Signal | Threshold |
|---|---|
| `/api/reservations/page` p95 | Sustained > 800 ms despite Phase 2 |
| `/api/reports/overview` p95 | > 2 s on a 30-day range with 1 location filter |
| Primary DB CPU | Sustained > 70% during peak hours |
| Primary connection pool | Frequent timeouts (already gated by Phase 1 instrumentation) |
| Sentry `prisma slow query` warns | More than ~50/hour with most pointing at report aggregations |

Any TWO of those triggered for two consecutive weeks ⇒ time to provision the replica. One signal alone is usually fixable cheaper.

## What it costs

**Infra:**

- Supabase Pro tier required (~$25/mo). The free tier doesn't expose read replicas.
- Each read replica is a separate compute node. Smallest replica option starts around $7-15/mo on Supabase, scaling with size.
- **Realistic monthly add:** $35-50/mo for tier upgrade + small replica.

**Operational complexity:**

- One more thing to monitor (replica lag, replica CPU/IO, connection counts).
- One more connection string in env (separate `DATABASE_URL_REPLICA`).
- One more failure mode (replica down, replica lagged) — though queries can fall back to primary.

**Engineering effort:**

- Initial wire-up: ~0.5 days (split prisma client, route a handful of endpoints).
- Per-endpoint review of "is this safe on a replica": ~0.5 days.
- Rollout + monitoring: ~0.5 days.
- Total: roughly 1.5 days, matching the perf prep doc's estimate.

## What changes in the codebase

### 1. Two prisma clients

`backend/src/lib/prisma.js` already exports a single `prisma` client. Add `prismaReplica` (or `prismaRead`) that points at the replica's connection string when configured, falls back to the primary client when not.

```js
const REPLICA_URL = process.env.DATABASE_REPLICA_URL || '';

export const prismaReplica = REPLICA_URL
  ? new PrismaClient({ datasources: { db: { url: appendPoolParams(REPLICA_URL) } } })
  : prisma; // fall back to primary when no replica configured
```

This pattern means the app still works on dev/CI without a replica — the replica client is just an alias for the primary.

### 2. Endpoints that route to the replica

Apply this to **read-only endpoints where staleness up to ~1s is acceptable**:

| Endpoint | Replica-safe? | Why |
|---|---|---|
| `GET /api/reports/overview` (and `.csv`) | YES | Analytics; nobody expects "last 5 seconds" precision. |
| `GET /api/reports/services-sold` | YES | Same. |
| `GET /api/reservations/page` | YES with caveat | Staff scrolling the list tolerates ~1s staleness. The Phase 2 query cut already made this fast on the primary, so this might not need to move. |
| `GET /api/reservations/:id` (detail) | NO | Read-after-write — staff hits this immediately after editing a reservation. Replica lag would cause "I just saved this, where's my change?" |
| `GET /api/reservations/summary` | NO | Already cached for 30s; primary is fine. |
| `GET /api/reservations/:id/pricing-options` | YES | Reference data; Phase 1 already caches. Replica is belt-and-suspenders. |
| `GET /api/audit-logs/*` (when added) | YES | Pure read history; staleness expected. |
| Anything inside an Express route handler that follows a `POST/PUT/DELETE` in the same request | NO | Read-after-write within a request flow needs primary. |

**Rule of thumb:** if a user just clicked a button and the next render reads data, that read goes to the primary. Background list refreshes and analytics go to the replica.

### 3. Where the routing decision lives

Two patterns to consider:

**Pattern A — explicit at call site:**

```js
// Routes that already accept (scope) keep using prisma; analytics routes
// pass prismaReplica as the explicit client.
const out = await reportsService.overview(query, scope, { client: prismaReplica });
```

Pro: obvious in the diff which endpoints went to replica. Con: noisy change.

**Pattern B — service-level convention:**

```js
// reportsService.overview always uses prismaReplica internally.
async overview(query, scope) {
  return prismaReplica.reservation.findMany(...);
}
```

Pro: minimal call-site churn. Con: less visible from a route handler whether it's hitting replica.

**Recommended:** Pattern B for service methods that are clearly analytics-only (the entire `reportsService`, the entire `commissionsService`); Pattern A for endpoints inside `reservationsService` where some reads are replica-safe and others aren't.

### 4. Replica-lag awareness for sensitive reads

For the few reads that go to the replica but would be confusing under lag, a small helper:

```js
async function readWithFallback(replicaQueryFn, primaryQueryFn, maxLagMs = 500) {
  const result = await replicaQueryFn();
  // If empty or unexpectedly fresh-data-shaped, retry on primary.
  return result;
}
```

In practice we probably never need this — the routing rules above already partition queries into "lag-tolerant" and "must-be-fresh" buckets.

### 5. Prisma migrations

Migrations only run against the primary. The replica picks them up via streaming replication. **No migration code change needed.**

### 6. Connection-pool tuning

Each prisma client has its own pool. The replica client should get its own pool size:

```
DATABASE_REPLICA_URL=postgresql://...&connection_limit=20&pool_timeout=10
```

Reasonable starting point: same 20-30 connections as the primary. Adjust based on replica CPU after a week of traffic.

### 7. Observability

The Phase 1 Sentry slow-query log already tags every query with the target table. Add the host/connection-string fingerprint to those logs so we can tell primary slow queries from replica slow queries:

```js
// In prisma.js slow-query handler:
logger.warn(`prisma slow query ${event.duration}ms`, {
  durationMs: event.duration,
  // ...
  client: event.target?.includes('replica') ? 'replica' : 'primary'
});
```

(Approximate — actual implementation depends on the prisma event payload shape on multi-client setups.)

## Replica-lag risk catalog

The thing that bites people on read replicas is "I wrote a thing, then read it back, and the read returned the old version because it went to the replica before replication caught up." Mapping out where this could hit us:

| Flow | Risk | Mitigation |
|---|---|---|
| Staff creates reservation, then opens detail view | LOW | Detail view is on primary (recommended above). |
| Staff edits fee, then opens reservation pricing | LOW | Pricing-options is settings-tier; 60s cache + Phase 1 invalidation. Even if replica-routed, the cache pre-empts the replica read. |
| Staff posts payment, then refreshes the reservation list | MED | If list goes to replica, the new payment may not appear for a beat. Acceptable — list refresh is not a transactional surface. |
| Customer signs an addendum, then admin gets the email | LOW | Email send is in-process from the same write transaction, doesn't read from replica. |
| Reports/overview during a busy day | NONE | Reports always tolerate staleness. |

The high-confidence answer: route `reportsService` + `commissionsService` to the replica first. They're the safest and they're also the heaviest readers.

## Provisioning checklist (when we pull the trigger)

1. **Upgrade Supabase to Pro** in the dashboard. (~$25/mo, instant.)
2. **Create the read replica** in the same region as the primary (or a closer region to staff). Wait for replica to come online (~5-15 min).
3. **Capture the replica connection string** from the Supabase dashboard. It uses the same pgbouncer transaction-mode pooler; just a different host.
4. **Add `DATABASE_REPLICA_URL` to the droplet env.** Don't set it in `.env.example` — keep it in env templates only.
5. **Deploy a backend version** that defines the second prisma client (initially routing only one endpoint, like `/api/reports/overview`).
6. **Watch Sentry for 24 hours.** Confirm the routed endpoint's traces show the replica host. Confirm no spike in errors.
7. **Roll forward** to the rest of `reportsService` + `commissionsService`.
8. **Monitor replica lag** via Supabase dashboard. Lag > 5s sustained is a problem; investigate.

Rollback at any step: unset `DATABASE_REPLICA_URL`. The fallback line in `prisma.js` makes the replica client an alias for the primary, so all queries flow back to the primary instantly.

## What this PR explicitly does NOT do

- Provision a replica.
- Pay for a tier upgrade.
- Add the second prisma client.
- Change any routing.

It's a planning artifact. The signal to start implementation is **two of the decision criteria above** firing for two consecutive weeks against a Phase-1+2-deployed backend.

## Open questions to answer at implementation time

1. **Same-region or geographic split?** If staff is concentrated in one region, same-region is enough. If distributed, geo-split replicas (one per region) start to matter.
2. **Connection pool sizing on replica.** Starts at 20-30; adjust based on observed pool waits in the L-1 instrumentation.
3. **Should we replicate the audit log to a separate "cold" replica for compliance retention?** Out of scope for this doc; flag if it comes up.
4. **What's the failover plan if the replica goes down?** Today the answer is "everything falls back to primary because of the alias pattern". If we ever go multi-replica or move critical reads to replica-only, this question gets sharper.

## Cross-references

- Phase 1 instrumentation closeout: [`perf-phase1-2026-04-28.md`](./perf-phase1-2026-04-28.md)
- Phase 2 query reduction closeout: [`perf-phase2-2026-04-28.md`](./perf-phase2-2026-04-28.md)
- Phase 3 L-1 Redis closeout: [`perf-phase3-redis-cache-2026-04-28.md`](./perf-phase3-redis-cache-2026-04-28.md)
- Phase 3 L-2 counter table closeout: [`perf-phase3-summary-counters-2026-04-28.md`](./perf-phase3-summary-counters-2026-04-28.md)
- Phase 3 L-5 load test closeout: [`perf-phase3-load-test-2026-04-28.md`](./perf-phase3-load-test-2026-04-28.md)
