# Load Test Baseline — 2026-04-29

**Tag deployed:** `v0.9.0-beta.9+hotfix.1`
**Run by:** Hector (SUPER_ADMIN, `superadmin@fleetbeta.local`)
**Run from:** Hector's Mac in PR → `https://ridefleetmanager.com` (DigitalOcean droplet)
**Date/time:** 2026-04-29, mid-day session
**Schema state:** Fully aligned post counter-table + addendum-signature-token migrations applied via Supabase SQL Editor earlier same morning.

This is the **first captured baseline** of the reservations hot path under load against production. Future runs should compare against this run.

## Command

```bash
TOKEN="<JWT from /api/auth/login as superadmin@fleetbeta.local>"

cd ~/Code/RideFleetManagement/backend
npm run load-test:reservations -- \
  --baseUrl=https://ridefleetmanager.com \
  --token="$TOKEN" \
  --duration=60 \
  --vus=15 \
  --warmup=5
```

Source: `backend/scripts/load-test/run-reservations.mjs`. Endpoint mix:

| Endpoint | Weight | Why it's in the mix |
|---|---|---|
| `GET /api/reservations/page?limit=50` | 50% | List refresh — Phase 2 hydrate-drop target |
| `GET /api/reservations/page?limit=50&q=test` | 10% | Search variant of list refresh |
| `GET /api/reservations/summary` | 25% | Dashboard KPI — Phase 1 cache + counter-table optimization |
| `GET /api/reservations?limit=50` | 15% | Alt list endpoint (no Phase 2 work) |

## Results — raw

```
Endpoint                          count    err   mean   p50   p95   p99   max  (ms)
──────────────────────────────────────────────────────────────────────────────────
reservations.page                 1224    0      469.7  454.2 667.2 884   1307.7
reservations.page.search          241     0      389.5  355.7 598.6 905.6 1009.9
reservations.summary              631     0      106.3  83.7  184.2 466.1 895.8
reservations.list                 354     0      469.5  441   707.6 933   1250.3
──────────────────────────────────────────────────────────────────────────────────
Total requests:  2450
Throughput:      40.8 rps
Error rate:      0.00%
Concurrency:     15 VUs over 60s
Base URL:        https://ridefleetmanager.com
```

## Analysis vs documented targets

Targets from `docs/operations/performance-prep-2026-04-28.md`:

| Endpoint | Phase 1 exit (current target) | Phase 2 exit (post-hydrate-drop target) | Actual | Verdict |
|---|---|---|---|---|
| `reservations.page` p95 | < 800ms | < 500ms | **667ms** | ✅ beats Phase 1; ⚠️ misses Phase 2 by ~33% |
| `reservations.summary` cache hit p95 | (no number; aim cache hit > 80%) | (same) | **184ms** | ✅ clearly cache-hit shape (p50 84ms, p95 184ms) |
| Error rate | 0% | 0% | **0.00%** | ✅ pool didn't choke under 15 VUs sustained |

### Why the Phase 2 "miss" is probably not a real miss

Three confounders inflate these numbers vs the target:

1. **Network RTT from PR → droplet.** The test ran from Hector's Mac in Puerto Rico against `ridefleetmanager.com` on a DigitalOcean droplet (East US region per the assumption). That's ~80-150ms RTT baseline per request before any server work. Server-side p95 is likely closer to ~500-580ms — at or just over the Phase 2 target depending on how much network adds.
2. **SUPER_ADMIN scope bypasses the counter-table optimization.** The token's `tenantId: null` means cross-tenant queries on the read paths AND the counter-table read in `reservations.service.js` is gated on `counterTenantId` being non-null:

   ```js
   const counterTenantId = scope?.tenantId || null;
   const cachedCounters = counterTenantId
     ? await readFreshCounters({ tenantId: counterTenantId, day: dayStart })
     : null;
   ```

   So `reservations.summary`'s 184ms p95 is **pure live-aggregation + Phase 1 LRU cache** — not exercising the new counter table optimization at all. A tenant admin (non-SUPER_ADMIN) would likely see lower summary numbers because the counter table would be hit.
3. **No pre-Phase-2 baseline captured.** We can't verify the predicted ~50% drop empirically. We only know absolute current state.

### Per-endpoint observations

- **`reservations.page` (667ms p95):** Healthy. Phase 1+2 are doing their job. Network noise is the most likely reason it doesn't hit <500ms.
- **`reservations.page.search` (599ms p95):** Faster than non-search probably because `q=test` returns small/empty result sets, less hydration work to do.
- **`reservations.summary` (184ms p95, 84ms p50):** Curve pegged to cache-hit path. Phase 1 LRU cache is doing the work. Counter table optimization not yet measured (needs tenant-scoped login).
- **`reservations.list` (708ms p95):** Slower than `.page` — opposite of the perf prep doc's prediction. Likely didn't receive Phase 2's hydrate-drop. **Candidate for follow-up if traffic on this endpoint grows.**

## Decisions this run unblocks

- **L-3 (Postgres read replica): DEFER.** No signal of read pressure on primary. 0 errors, pool not choking. Trigger criteria not met.
- **L-4 (real APM — Datadog/Honeycomb/etc): DEFER.** Sentry free-tier traces remain sufficient for this profile.
- **Cluster mode: DO NOT ENABLE.** Confirmed; droplet is 1 vCPU/2 GB. Cluster gives no benefit until vertical scale.
- **Phase 3 L-1 Redis pub/sub: DEFER.** Single-worker prod = per-process LRU is fine. Only matters at multi-worker scale.

## Follow-up runs — same day

### Run #2 — Droplet, SUPER_ADMIN, internal (no network)

Run from inside the production container to isolate server-side latency from public-URL / TLS / reverse-proxy overhead.

```bash
ssh root@ridefleetmanager.com
docker exec -i fleet-backend-prod node /app/scripts/load-test/run-reservations.mjs \
  --baseUrl=http://localhost:4000 \
  --token="$TOKEN" \
  --duration=60 \
  --vus=15 \
  --warmup=5
```

**Caveat:** client + server share the same 1 vCPU / same Node process container; some self-contention is unavoidable. Run was clean anyway — 0 errors.

```
Endpoint                          count    err   mean   p50   p95   p99   max  (ms)
──────────────────────────────────────────────────────────────────────────────────
reservations.page                 1308    0      467.7  449.4 668.7 804.2 1248.1
reservations.page.search          250     0      345    332.2 485.9 628.1 707.8
reservations.summary              651     0      31.3   18.7  75    367.4 633.2
reservations.list                 397     0      461.5  439.9 697.1 829.3 1055.6
──────────────────────────────────────────────────────────────────────────────────
Total requests: 2606  Throughput: 43.4 rps  Error rate: 0.00%
```

### Run #3 — Mac, AGENT role (tenant-scoped), public URL

Tenant-scoped JWT (role=`AGENT`, tenantId=`cmn98hc1u0085ke0i4vefujt3`) — exercises the tenant-aware query paths. Note the user is role `AGENT`, not `ADMIN`; the counter-table check in `reservations.service.js` only requires `tenantId !== null` so AGENT is sufficient for that path.

```bash
TENANT_TOKEN=$(curl -fsS -X POST https://ridefleetmanager.com/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"<tenant-user>","password":"..."}' \
  | node -e "process.stdin.on('data', d => { console.log(JSON.parse(d).token) })")

cd ~/Code/RideFleetManagement/backend
npm run load-test:reservations -- \
  --baseUrl=https://ridefleetmanager.com \
  --token="$TENANT_TOKEN" \
  --duration=60 --vus=15 --warmup=5
```

```
Endpoint                          count    err   mean   p50   p95   p99   max  (ms)
──────────────────────────────────────────────────────────────────────────────────
reservations.page                 1229    0      473.6  466.7 629.7 739.6 884.7
reservations.page.search          261     0      380    357.5 517   652.6 739.5
reservations.summary              590     0      104.4  84.6  183   448.9 543.9
reservations.list                 334     0      472.3  459.4 629.2 811.2 824.4
──────────────────────────────────────────────────────────────────────────────────
Total requests: 2414  Throughput: 40.2 rps  Error rate: 0.00%
```

## Three-run comparison

| Run | Auth | Network | page p95 | summary p95 | list p95 |
|---|---|---|---|---|---|
| Run #1 — Mac, SUPER_ADMIN | super-admin (cross-tenant) | PR → public URL | 667ms | 184ms | 708ms |
| Run #2 — Droplet, SUPER_ADMIN | super-admin (cross-tenant) | inside container | **669ms** | **75ms** | **697ms** |
| Run #3 — Mac, AGENT | tenant-scoped | PR → public URL | 630ms | 183ms | 629ms |

### Findings

1. **Network RTT from PR to NY droplet is small (~5-30ms per request) thanks to HTTPS keepalive.** Compare `reservations.page` p95: 667ms (Mac) vs 669ms (Droplet) — basically identical. TLS handshake amortizes; per-request RTT only adds a small constant. The mac numbers are NOT inflated by network for the longer endpoints.
2. **Reverse-proxy / TLS termination overhead is proportionally large for short requests.** `reservations.summary` p95 drops from 184ms (public URL) → 75ms (inside container) — a ~60% reduction. For sub-100ms server work, the public-URL path adds ~100-110ms baseline (TLS + nginx + handshake amortization). For longer requests this overhead is a smaller fraction of total time.
3. **The Phase 2 target miss is real, not network noise.** `reservations.page` p95 ≈ 670ms from inside the container too. The Phase 2 target was <500ms. We're at 130-170ms over target. **Beats Phase 1 target (<800ms) comfortably**, no errors, but Phase 2 hydrate-drop benefit is smaller than predicted.
4. **Counter table optimization is NOT measurable in this test.** `reservations.summary` p95: 184ms (SUPER_ADMIN, no counter) ≈ 183ms (tenant AGENT, counter eligible). Why: the Phase 1 LRU cache (30s TTL on the route layer) intercepts ~95% of requests after warmup; very few reach the service-layer counter-read path. **This is the correct behavior** — the cache is the first line of defense, the counter is the fallback for cache-miss scenarios. To measure counter benefit specifically, would need to disable LRU or hit cache-miss-by-design (different query params).
5. **Tenant-scoped (AGENT) query paths don't show degradation.** Tenant filtering adds essentially no overhead vs SUPER_ADMIN — actually slightly faster on a couple endpoints, probably because tenant filtering reduces the result set the query has to return.
6. **`reservations.list` consistently slower than `.page`.** All three runs: 697-708ms p95 for `.list` vs 629-669ms for `.page`. Phase 2 hydrate-drop applied to `.page` but not `.list`. **Phase 4 candidate** if traffic on `.list` grows.

### Decisions — strengthened

Same as Run #1, but now with stronger evidence:

- **L-3 (Postgres read replica): DEFER.** Server-side p95 < 700ms across all hot endpoints even at 15 VUs sustained. Pool not choking. No read pressure signal.
- **L-4 (real APM): DEFER.** Sentry traces suffice. We had three useful runs with the existing tooling; APM wouldn't have told us more.
- **Cluster mode: DO NOT ENABLE.** Confirmed; 1 vCPU. Cluster would only fight itself.
- **Phase 3 L-1 Redis: DEFER.** Single-worker prod = per-process LRU is fine.

### New observations worth tracking

1. **Reverse-proxy overhead (~100ms baseline) is the dominant cost for short endpoints.** If dashboard / KPI feel laggy from far-away clients (PR, etc.), this is the target — not the database. Possible Phase 4 investigations: HTTP/2 push, brotli compression on the nginx/proxy layer, CDN edge caching for authenticated reads with short TTL.
2. **Counter table is provisioned and the code path is wired**, but cache prevents it from showing up in regular load tests. Worth a one-off dedicated test (cache-disabled or cache-bypass) if proving its effect ever matters for a decision.

### Future-test recommendations

When re-running this baseline (e.g. after enabling cluster mode, or after Phase 4 work), prefer:
- One run from inside the container (server-side truth)
- One run from a representative client location (real user latency)
- One run with a tenant-scoped admin (production access shape)
- Different `--reservationId=` param to also exercise `reservations.detail` + `reservations.pricing-options`

## Operational state

- Production: `v0.9.0-beta.9+hotfix.1`, healthy.
- Schema: fully aligned (counter table + addendum-signature-token migrations applied morning of 2026-04-29 via Supabase SQL Editor).
- Sentry: Phase 1 traces flowing.
- Pool: 30 connections (Phase 1 bump), no exhaustion under 15 VUs.
- Counter table: `ReservationDailyCounter` exists in Supabase, but not exercised by SUPER_ADMIN test.
