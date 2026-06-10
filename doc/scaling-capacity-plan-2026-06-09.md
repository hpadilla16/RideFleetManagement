# RideFleet — Capacity & Scaling Plan

**Date:** 2026-06-09
**Author:** Infra analysis (Cowork session)
**Owner:** Hector Padilla
**Supersedes / updates:** `doc/server-scaling-plan-2026-05-08.md`, `doc/server-scaling-500-users-2026-05-08.md`, `docs/architecture/SCALING_ROADMAP.md`

> **Scope & method.** This was produced from static analysis of the codebase, `docker-compose.prod.yml`, the Prisma schema, the cache/pool/queue layers, and the corrected droplet specs you gave me. It does **not** include live `docker stats` / Supabase dashboard numbers (Cowork's SSH key is log-dump-only and has no prod DB credentials). Capacity figures are **engineering estimates with stated assumptions** — validate the ones that gate a spend with a short load test before committing.

---

## 1. TL;DR

RideFleet today runs on **one DigitalOcean droplet — Basic, 4 vCPU / 8 GB RAM / 160 GB disk** — behind nginx, talking to a **Supabase Postgres (compute LARGE, `max_connections=160`)** through the pgbouncer pooler, with **Upstash Redis** for cross-worker cache invalidation. The app is a Node cluster (4 API workers) + a separate BullMQ worker container + a Next.js frontend container, all on that single box.

**The honest current ceiling is roughly:**

| Axis | Comfortable | Stress / start to feel it | Hard wall (current box) |
|---|---|---|---|
| Concurrent active users (staff + public) | ~150 | ~250 | ~350–400 |
| Sustained request rate | ~80 rps | ~120 rps | ~150–180 rps |
| Active "Triangle-class" tenants (100–200 vehicles, multi-location, daily use) | 8–12 | 15–18 | ~20 |
| Total provisioned tenants (most low-activity) | 50–80 | 100 | ~150 |
| Vehicles under active management (all tenants) | ~5,000 | ~10,000 | ~15–20k* |
| Named users provisioned | ~3,000 | ~5,000 | ~8k* |

\* Row counts marked with `*` are limited by query patterns (notably `ILIKE` search), not by the box — fixable in software well before you hit them. See §4.

**What breaks first is RAM, then CPU — not the database.** The Supabase connection budget (108 of 160 client connections in use by design) and disk are not the binding constraints. The single-box, single-point-of-failure topology is the biggest *risk*, separate from capacity.

**The growth path, in one line:** finish hardening the single box (Phase 0) → scale the box up (Phase 1) → add a read replica (Phase 2) → go horizontal with a second app droplet + a dedicated jobs droplet behind a load balancer (Phase 3) → carve heavy/enterprise tenants onto their own schema → DB → droplet (Phase 4). The architecture is already 80% ready for Phase 3 because state lives in Supabase + Redis + Supabase Storage, **not** on the droplet — so app droplets are effectively stateless and need no droplet-to-droplet sync.

---

## 2. Current architecture (as built)

### 2.1 Compute / topology

```
                          Internet
                             │
                          nginx  (same droplet, SSL terminated locally)
                             │
   ┌─────────────────────────────────────────────────────────────┐
   │  DigitalOcean droplet — Basic / 4 vCPU / 8 GB RAM / 160 GB    │
   │                                                               │
   │  fleet-frontend-prod   Next.js (port 3000)                    │
   │  fleet-backend-prod    Node cluster, CLUSTER_WORKERS=4        │
   │                        + headless Chromium (PDF, scrapers)    │
   │  fleet-worker-prod     BullMQ worker (1 proc), schedulers     │
   │  fleet-db-prod         postgres:16-alpine  ← see ⚠ §5.1       │
   └─────────────────────────────────────────────────────────────┘
                 │                              │
          Supabase Postgres              Upstash Redis
          compute LARGE                  (pub/sub cache invalidation,
          max_connections=160           BullMQ queue, rate-limit counters)
          via pgbouncer :6543
                 │
          Supabase Storage  (photos, receipts buckets)
```

- **API tier:** Node.js `cluster` with `CLUSTER_WORKERS=4` (one logical worker per vCPU). Stateless per request — auth is JWT, so any worker/host can serve any request.
- **Worker tier:** a separate container running `src/worker.js` (BullMQ). Handles auto-charge after check-in and TL International sync. Schedulers (toll auto-sync, handoff reminders, checkout-session cleanup) run **only in the first worker** to avoid duplicate runs — this is already multi-instance-safe.
- **DB:** Supabase Postgres, compute LARGE (`max_connections=160`, confirmed via `SELECT current_setting`), accessed through the pgbouncer pooler on `:6543` (`?pgbouncer=true`). Migrations go through the session port `:5432`.
- **Redis:** Upstash. Used for (a) cross-worker/host cache **invalidation** pub/sub, (b) the BullMQ job queue, (c) per-tenant rate-limit counters. `pingInterval` keeps the socket alive (Upstash drops idle sockets).

### 2.2 Data model

- **95 Prisma models**, **71 carry `tenantId`** → shared-database, shared-schema multi-tenancy with row-level tenant scoping.
- **181 `@@index` declarations** — indexing discipline is good.
- The `Tenant` model already has the scaffolding for stronger isolation later: `tier` (`STANDARD | PREMIUM | ENTERPRISE`) and `schemaName` (`'public'` | `'tenant_<slug>'`) — the "Path D hybrid" multi-tenancy approach. Today everything is `public`.

### 2.3 Connection pool math (current)

From `docker-compose.prod.yml`:

```
backend: DATABASE_POOL_SIZE=24 × 4 cluster workers = 96 client connections
worker:  DATABASE_POOL_SIZE=12 × 1 process          = 12 client connections
                                              total  = 108 / 160 = 67%
```

That leaves ~52 connections for migrations/admin. Because traffic goes through pgbouncer in transaction mode, those 108 *client* connections multiplex onto fewer real Postgres backends under typical load — the 160 cap is worst-case headroom, not a per-request reservation. **Connections are not the bottleneck today.**

### 2.4 Caching

`backend/src/lib/cache.js` is an **in-memory `Map` per worker** (5-min default TTL, `MAX_ENTRIES=500`), with **Redis pub/sub used only to fan out invalidations** (`del` / `invalidate` / `clear`) across workers and hosts. Reads stay local and synchronous (sub-ms).

Important nuance for scaling: this is **not** a shared read-through L2 cache. Each worker (and each future host) populates its own copy on a miss, and a `set` is **not** broadcast — only "this is now stale" events are. Correctness across workers is handled; raw hit-rate is not pooled. That's fine at current scale; it matters when you add hosts (§ Phase 3).

### 2.5 Observability & protection

- **Sentry** (errors + uptime monitor + a "Prisma Pool Exhaustion" alert rule).
- **Slow-query logging:** `PRISMA_SLOW_QUERY_MS` (default 200 ms) → Winston, with PII redaction (params never logged in prod).
- **Statement timeouts:** API tier 15 s, worker tier 60 s; `idle_in_transaction_session_timeout` 30 s.
- **Rate limits (per tenant, Redis fixed-window):** STANDARD 5,000 rpm · PREMIUM 15,000 rpm · ENTERPRISE 50,000 rpm, plus a per-IP guard on public routes.

---

## 3. What breaks first — in order (current box)

This is the failure sequence as load climbs on the **4 vCPU / 8 GB** box. Updated from the May analysis to reflect the LARGE Supabase tier, the pool bump (20 → 108), and Redis now being live.

1. **RAM pressure (breaks first).** 8 GB is shared across: 4 API workers, the BullMQ worker container, the Next.js frontend, **headless Chromium** (rental-agreement PDF rendering + Expedia/TL scrapers run *inside* the backend container), and the **redundant local `fleet-db-prod` Postgres container** (see §5.1). Chromium is spiky (100–400 MB per instance) and PDF generation happens on the API request path. The `express.json({ limit: '50mb' })` ceiling means a single large upload can balloon a worker's RSS. **Symptom:** worker restarts / OOM kills, intermittent latency spikes in Sentry.
2. **CPU saturation (~next).** 4 vCPU shared by request handling, JSON serialization of large payloads (the rental-search response is heavy), Prisma query parsing, Chromium, and nginx. **Symptom:** p95 climbs to multiple seconds, throughput flattens.
3. **Reports vs. transactional contention.** Reports/market-intelligence run wide aggregate queries against the **primary** Postgres, competing with reservation writes. **Symptom:** reservation/checkout latency rises whenever someone runs a big report.
4. **Search slow queries (data-scale).** Customer/vehicle search uses `ILIKE '%term%'`, which cannot use a normal index. At tens of thousands of rows this becomes a top slow query. **Symptom:** `prisma slow query` warnings on search endpoints.
5. **Connection budget.** Only ~67% used today; this is the *last* thing to break on the current tier and only matters once you add hosts (each host adds its own pool — see Phase 3 math).
6. **Single point of failure (always present).** Any crash, OOM, or deploy takes down all tenants at once; there is no zero-downtime deploy path. This is a *risk*, not a load ceiling, but it's the one most visible to enterprise customers.

---

## 4. Current capacity — the numbers and the assumptions

**Two different axes, don't conflate them:**

- **Data scale** (tenants / vehicles / users / reservations *stored*) is cheap. It lives in Supabase, not on the droplet disk. With 181 indexes and LARGE compute, Postgres handles tens of thousands of vehicles and hundreds of thousands of reservations comfortably. The only data-scale risk before then is the `ILIKE` search paths (§3.4) — a software fix, not an infra spend.
- **Concurrency scale** (active users / requests-per-second) is what the 4 vCPU / 8 GB box actually limits, via RAM then CPU.

**Estimated current ceilings** (single box + Supabase LARGE + Upstash):

| Metric | Comfortable | Feels it | Hard wall | Binding constraint |
|---|---|---|---|---|
| Concurrent active users | 150 | 250 | 350–400 | RAM → CPU |
| Sustained rps | 80 | 120 | 150–180 | CPU |
| Active Triangle-class tenants | 8–12 | 15–18 | ~20 | RAM (caches + Chromium) |
| Total provisioned tenants | 50–80 | 100 | ~150 | RAM (per-tenant cache footprint) |
| Vehicles actively managed | 5,000 | 10,000 | 15–20k | Query patterns (fixable) |
| Provisioned users | 3,000 | 5,000 | 8k | Query patterns (fixable) |
| DB client connections | 108 used | — | 160 cap | Not binding yet |

**Assumptions behind these:** ~150 ms average server time per request; cache-hit-dominant traffic; PDF/scraper work occasionally contending on the API box (this is what pulls the "active tenants" number down — moving it off the box, §Phase 0, raises it); pooler multiplexing in transaction mode. The May 2026 load test (5 sustained VUs/IP → 0 errors, p99 < 1.1 s; 50 VUs from one IP correctly rate-limited) is consistent with these ranges. **Re-run a short k6/Artillery test at 50–100 distinct-IP VUs after Phase 0 to confirm before you sign a second large tenant.**

---

## 5. Findings to fix regardless of scaling phase

### 5.1 ⚠ The local `fleet-db-prod` Postgres container is (almost certainly) dead weight
`docker-compose.prod.yml` still defines a `postgres:16-alpine` container (`fleet-db-prod`) with its own 256 MB `shared_buffers`, **but `DATABASE_URL` points at the Supabase pooler** (`:6543`). Prod is running on Supabase, so this container is consuming RAM and creating confusion (your `CLAUDE.md` even lists `fleet-db-prod` as one of "the 4 containers to verify"). **Action:** confirm nothing reads from it, then remove it from the prod compose file. Free RAM on the box that breaks on RAM. *(Money-code rule does not apply — this is infra, not payment logic — but verify before removing.)*

### 5.2 Move Chromium/PDF/scrapers off the API request path
Rental-agreement PDF rendering and the Expedia/TL scrapers spawn headless Chromium **inside `fleet-backend-prod`**, the container serving live requests. This is the #1 RAM-spike source on the box. **Action:** route PDF generation and all scraping through the BullMQ worker container (or a dedicated jobs droplet in Phase 3). Cap concurrent Chromium instances explicitly.

### 5.3 Replace `ILIKE` search with trigram / full-text before ~10k rows
Add `pg_trgm` + GIN indexes (or `tsvector`) on customer and vehicle search columns. Cheap migration, removes the only data-scale wall in the table above.

### 5.4 Verify Cloudflare is actually in front
The May plan listed Cloudflare as a TODO. If it isn't live yet, put the domain behind Cloudflare (free plan): DDoS protection, edge caching of static assets, and a backup TLS path — ~30 min of DNS work, $0. This single-handedly absorbs traffic spikes that would otherwise hit the box.

### 5.5 Memory guardrails
Set `NODE_OPTIONS=--max-old-space-size` per worker so a runaway request fails its worker instead of OOM-killing the box; review whether `express.json` needs the full 50 MB on every route or only on upload routes.

---

## 6. Expansion plan — phased, with triggers

Each phase lists **what you do**, **why**, **the trigger metric that tells you it's time**, and **rough monthly cost**. Don't move on intuition — move on the trigger.

### Phase 0 — Harden the single box (do now, ~$0)
**Do:** §5.1–§5.5 (remove dead DB container, move Chromium to worker, trigram search, confirm Cloudflare, memory caps). No new infra.
**Why:** buys back a meaningful slice of the RAM/CPU headroom you already paid for and removes the only software-side data wall.
**Trigger:** none — this is maintenance you do before onboarding the next big tenant.
**Cost:** $0 (Cloudflare free; rest is code/config).

### Phase 1 — Vertical scale (single box stays, 0–9 months)
**Do:** resize the droplet to **8 vCPU / 16 GB** (DigitalOcean resize, ~5 min downtime); when DB connections sustain >70% of 160, bump Supabase compute (LARGE → XL) and raise `DATABASE_POOL_SIZE` *after* checking the new `max_connections`.
**Why:** doubles the constraint that breaks first (RAM) and the second (CPU) with zero architecture change. Cheapest capacity you can buy.
**Trigger:** sustained RAM > 75%, **or** p95 > 1 s on staff endpoints for 5+ days, **or** > 3 OOM/pool alerts/week.
**Cost:** ~+$48/mo droplet; ~+$50–100/mo Supabase compute if/when needed.

### Phase 2 — Secondary database: read replica (when reports bite)
**Do:** provision a **Supabase read replica**; add `DATABASE_URL_REPLICA`; route reports, market-intelligence aggregations, and other read-only heavy queries to the replica. Keep all writes and read-after-write on the primary.
**Why:** removes the reports-vs-transactions contention (§3.3) so a big report can't slow checkout.
**Synchronization:** handled by Supabase via Postgres streaming replication (async, typically sub-second lag). Your only job in code is the read/write split — never read-after-write from the replica.
**Trigger:** report queries visibly raising reservation latency, **or** the first tenant with heavy reporting needs.
**Cost:** included on Supabase Pro+ tiers; effectively the compute of the replica.

### Phase 3 — Horizontal app tier: second droplet + jobs droplet + load balancer
**Do:**
- 2× stateless app droplets (4–8 vCPU / 8–16 GB) behind a **DO Load Balancer**.
- A dedicated **jobs droplet** (2 vCPU / 4 GB) running the BullMQ worker + all Chromium/scraper work.
- nginx becomes per-droplet (or move TLS to Cloudflare/LB).

**Why this is mostly ready already:** the app is stateless (JWT auth), all shared state lives in **Supabase + Redis + Supabase Storage**, schedulers already run in a single designated worker, and Redis already fans out cache invalidations across hosts. **There is no droplet-to-droplet synchronization to build** — that's the whole point of keeping state off the droplet.

**The two things to handle before going multi-host:**
1. **Cache hit-rate across hosts.** Today's pub/sub-invalidation cache means each host repopulates its own `Map`. That's still *correct*, just less efficient. If a hot path needs a truly shared cache, promote `cache.js` to a Redis read-through L2 for that path (the facade already abstracts callers).
2. **Connection-pool math with N hosts.** `pool_size × workers × hosts` must stay under the pooler cap. Example: `24 × 4 × 2 hosts = 192` would exceed the 160 cap — so either lower per-host `DATABASE_POOL_SIZE`, raise Supabase compute, **or** (recommended) front Postgres with a dedicated **PgBouncer/Supavisor** layer sized for the host count. Plan the pool budget as a function of host count, not per host.

**Trigger:** sustained p95 > 1 s after Phase 1, **or** > 3 pool/CPU alerts/week, **or** you need **zero-downtime deploys** (first enterprise SLA in a contract), **or** > ~15 active Triangle-class tenants.
**Cost:** ~+$48–96/mo (second app droplet) + $12/mo (LB) + ~$24/mo (jobs droplet).

### Phase 4 — Per-tenant isolation: dedicated schema → DB → droplet
This answers *"when should a tenant get their own droplet/database?"* You already have the model field (`Tenant.schemaName`, `Tenant.tier`) for the first rung. Isolation comes in increasing strength — promote a tenant only when a trigger below fires:

| Level | What it means | Use for | Cost |
|---|---|---|---|
| **L1 — shared DB, shared schema, `tenantId`** (today) | Row-level scoping | The default; vast majority of tenants | baseline |
| **L2 — shared DB, per-tenant schema** (`schemaName='tenant_<slug>'`) | Logical isolation, same Postgres instance | Tenants needing data separation without dedicated cost | ~$0 infra, migration fan-out cost |
| **L3 — dedicated database** (own Supabase project / Postgres) | Own connection budget, own backups, blast-radius isolation | Noisy-neighbor tenants; data-residency; large fleets | one DB/project per tenant |
| **L4 — dedicated droplet + dedicated DB** (full single-tenant stack) | Complete isolation, own scaling, own SLA | Enterprise SLA, compliance (SOC2/PCI/HIPAA), 500+ vehicle national operators | one full stack per tenant |

**Triggers to carve a tenant out of the shared pool:**
- **Contractual:** a formal 99.9% SLA, or data-residency / compliance (SOC2, PCI-DSS, HIPAA) requirement → go to L3/L4.
- **Noisy neighbor:** one tenant consistently consuming > 25–30% of shared compute or connections (e.g., a 500+ vehicle operator, or one running constant public-booking campaigns) → L2, then L3.
- **Risk isolation:** a tenant whose traffic spikes threaten everyone else's latency → at least L2, ideally L3.

**Synchronization & the control plane (the hard part of sharding):**
When tenants live in different schemas/DBs/droplets, **each tenant store is authoritative for its own data — there is no bidirectional tenant-to-tenant sync.** What you *do* need to build is a control plane:

1. **Tenant registry / routing map.** A small central table (or config service) mapping `tenant slug/subdomain → shard (schema / DB / droplet)`. Cache it in Redis. The load balancer / app reads it to route each request to the right backend and DB. This is the single source of truth for "where does tenant X live."
2. **Migration fan-out.** Schema migrations must run against *every* shard. Build a migration runner that loops over the registry (additive-only, same as today's rule). This is the real operational tax of sharding — budget for it.
3. **Cross-tenant / super-admin reporting.** Do **not** do live cross-DB joins. Instead run a nightly **ETL/CDC** (logical replication, or a tool like Airbyte/Fivetran) from each tenant store into a central **read-only analytics warehouse**. Super-admin dashboards and platform-fee accounting read the warehouse, not the live shards.
4. **Shared/global data** (market-intelligence catalog, SIPP data, T&C templates) stays in one central store and is read by all tenants.
5. **Config / feature-flag propagation** goes through the registry so a flag flip reaches the right shard.

**Sync mechanisms summary:** primary↔replica = Postgres streaming replication (Supabase-managed); shard→warehouse = async CDC/ETL nightly; app↔app = none needed (stateless); routing = registry-in-Redis. Avoid live cross-shard queries entirely.

**Trigger:** the contractual/noisy-neighbor/risk conditions above. Most tenants should *never* leave L1.
**Cost:** L2 ≈ $0 incremental; L3 = one DB/project per tenant; L4 = full stack (~$72+/mo each) — priced into the enterprise contract.

### Phase 5 — Multi-region & enterprise grade (50+ tenants, future)
Matches the old "Tier C": 3–5 app droplets in an autoscaling group, a second region (e.g., NYC + SFO/LON) for non-US-East latency, dedicated/Team-plan database, Cloudflare Pro/Business, and full observability (Datadog-class). Real 99.9% multi-region failover. **Trigger:** > 50 active tenants, a contractual multi-region SLA, or a customer outside US-East complaining about latency. **Cost:** ~+$700–1,500/mo. Don't pre-build this.

---

## 7. Decision-trigger cheat sheet

| You are here | Move to | When (measure it) |
|---|---|---|
| Single box | **Phase 0 hardening** | Before onboarding the next big tenant |
| Single box | **Phase 1 (resize)** | RAM > 75% sustained, or p95 > 1 s for 5+ days, or > 3 OOM/pool alerts/wk |
| Phase 1 | **Phase 2 (read replica)** | Reports visibly raising reservation latency |
| Phase 1/2 | **Phase 3 (2nd droplet + LB)** | p95 > 1 s after resize, or > 3 pool/CPU alerts/wk, or need zero-downtime deploy, or > ~15 active Triangle-class tenants |
| Shared pool | **Phase 4 (isolate a tenant)** | Formal SLA / compliance, noisy neighbor > 25–30% of shared capacity, or spike-risk tenant |
| Phase 3 | **Phase 5 (multi-region)** | > 50 active tenants, multi-region SLA, or non-US-East latency complaints |

**Metrics to watch (Sentry + a `SELECT count(*) FROM "Tenant" WHERE status='ACTIVE'`):** sustained p95 on staff endpoints, RAM %, DB connections in use vs. cap, pool-exhaustion alert frequency, slow-query rate, active-tenant count.

---

## 8. Cost vs. revenue (ROI context)

Using the Triangle-class pricing from the May plan (~$1,750–2,550/tenant/mo):

| Stage | Infra cost/mo | At 10 tenants (~$17.5–25.5k/mo) | At 30 tenants (~$52.5–76.5k/mo) |
|---|---|---|---|
| Phase 0–1 | ~$50–150 | < 1% | < 0.3% |
| Phase 2–3 | ~$200–350 | ~1–1.5% | < 0.5% |
| Phase 5 | ~$1,000–1,500 | n/a | ~2% |

Every tier upgrade is a rounding error against revenue. The discipline isn't *whether* to scale — it's *not scaling before the trigger fires* and wasting the headroom you already have on the current box.

---

## 9. What you do NOT need yet

- ❌ **Kubernetes** — Docker Compose on VMs is correct until ~5+ droplets.
- ❌ **Microservices** — a well-organized monolith is easier to operate at this scale.
- ❌ **Multi-region now** — NYC3 serves US-East + PR at < 50 ms.
- ❌ **Paid global CDN** — Cloudflare free covers assets.
- ❌ **Per-tenant droplets for everyone** — L1 shared is right for almost all tenants; isolate only on a trigger.

---

*Nota (ES): este documento actualiza los planes de mayo. Cambios clave desde entonces: Supabase MICRO→LARGE (max_connections 60→160), pool 20→108, Redis (Upstash) ya en producción, y las specs reales del droplet confirmadas en 4 vCPU / 8 GB / 160 GB. Los números de capacidad son estimados de ingeniería con supuestos declarados — valida con un load test corto antes de cualquier gasto que dependa de ellos.*
