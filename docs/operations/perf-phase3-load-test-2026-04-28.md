# Perf Phase 3 — L-5 load test

**Date:** 2026-04-28
**Owner:** Hector
**Branch:** `feat/perf-phase3-load-test`
**Source plan:** [`performance-prep-2026-04-28.md`](./performance-prep-2026-04-28.md)

This is the implementation closeout for **Phase 3 / L-5** — the synthetic load test the perf prep doc explicitly recommended as the first long-term action because it generates data to argue subsequent infra investments with (Redis, materialized views, read replica, real APM).

## What shipped

### `backend/scripts/load-test/run-reservations.mjs`

A zero-dependency Node script that simulates 15 concurrent staff sessions hitting the reservations hot path:

- `/api/reservations/page` — paginated list (50% of mix; the biggest connection-pool risk on `main` before Phase 2 cut it from 6 → 2 prisma queries).
- `/api/reservations/page?q=test` — search variant (10%).
- `/api/reservations/summary` — dashboard KPI (25%; Phase 1 added a 30s cache).
- `/api/reservations` — alternate list endpoint (15%).
- Optional `/api/reservations/:id` and `/api/reservations/:id/pricing-options` when `--reservationId` is provided (Phase 1 added a 60s cache on pricing-options).

Implementation notes:

- Uses Node's built-in `fetch` with the global `undici` agent — no new dependencies. autocannon and k6 are great but a 200-line script is enough for this scope and lives well in the repo.
- Each VU is an async loop that picks an endpoint by weight, fetches it, drains the body (so we measure full server work, not just headers), and records `performance.now()` deltas.
- Warmup phase (default 5s) runs concurrently before measurement to populate Phase 1 caches.
- Per-endpoint output: `count / errors / mean / p50 / p95 / p99 / max` in ms.
- Aggregate output: total requests, throughput (rps), error rate, concurrency.
- Exits non-zero if error rate exceeds 5% (gate-able for CI later).
- Supports `--json` for machine-readable output.

### `npm run load-test:reservations`

Wired into `backend/package.json` so the test is discoverable.

## How to run

Local backend:

```bash
cd backend
npm run dev   # in another terminal

# Get a JWT (login as ADMIN/OPS or use tenant-seed-superadmin output)
TOKEN="..."

# Smoke run: 5 VUs, 15s
node scripts/load-test/run-reservations.mjs \
  --baseUrl=http://localhost:4000 \
  --token="$TOKEN" \
  --duration=15 \
  --vus=5

# Full run mirroring perf prep doc's worst-case (15 concurrent staff for 60s)
npm run load-test:reservations -- \
  --baseUrl=http://localhost:4000 \
  --token="$TOKEN" \
  --duration=60 \
  --vus=15
```

Against staging or the droplet:

```bash
npm run load-test:reservations -- \
  --baseUrl=https://api.staging.ridefleet.com \
  --token="$TOKEN" \
  --duration=120 \
  --vus=20
```

To exercise the per-reservation pricing-options cache:

```bash
npm run load-test:reservations -- \
  --baseUrl=http://localhost:4000 \
  --token="$TOKEN" \
  --reservationId=<real-reservation-id> \
  --duration=60 \
  --vus=15
```

## How to interpret results

Targets from `performance-prep-2026-04-28.md` §6:

| Metric | Pre-Phase-1 (estimate) | Phase 1 target | Phase 2 target |
|---|---|---|---|
| `/api/reservations/page` p95 | ~1500 ms | < 800 ms | < 500 ms |
| `/api/reservations/:id` p95 | ~600 ms | — | < 300 ms |
| Error rate | — | 0% | 0% |

Acceptance pattern for a perf PR:

1. Run the load test against `main` (baseline).
2. Run again against the perf branch.
3. p95 should drop on the targeted endpoint(s); error rate stays at 0%.

## Validating Phase 1 + Phase 2 wins

The fastest way to confirm both PRs deliver what they promised:

1. Check out `main`. Start backend. Run `--duration=60 --vus=15`. Record `reservations.page` p50/p95/p99.
2. Check out `feat/perf-phase1`. Restart backend. Run again. Expect `reservations.summary` p95 to drop sharply (cache hits from second request onward) and connection-pool errors to disappear under sustained load.
3. Check out `feat/perf-phase2`. Restart backend. Run again. Expect `reservations.page` p95 to drop ~50% (4 fewer prisma queries per request).

This is what to argue Phase 3 L-1 (Redis), L-2 (materialized views), L-3 (read replica), and L-4 (real APM) with — concrete before/after numbers from this test.

## What's intentionally NOT in this PR

- **Seed/fixture management** — the script assumes the target environment already has data. Pairing it with a fresh-seed step is a separate concern (pollutes prod data); local runs should hit a populated dev DB.
- **CI integration** — the script exits non-zero on >5% error rate, but wiring it into `.github/workflows/beta-ci.yml` requires a real backend in CI (currently CI starts the stack via docker compose for the tenant-isolation suite; reusing that for load tests is a follow-up).
- **Tenant isolation under load** — orthogonal to perf; the existing tenant-isolation suite covers correctness.

## Risk assessment

**Zero risk to production.** This is a developer tool. No source files in the request path changed; only `package.json` (added an npm script) and a new file under `scripts/load-test/`.

## Verification before merge

1. `node --check backend/scripts/load-test/run-reservations.mjs` — syntax green.
2. CI green on `feat/perf-phase3-load-test`.
3. Optional: run the script locally with `--duration=5 --vus=2` against a dev backend; confirm output formatting.

## What's next on Phase 3

After running this test post-merge of Phase 1 + 2 to get baseline numbers, decisions on the remaining items become data-driven:

- **L-1 Redis cache** — only needed if the test reveals cache-thrash under multi-worker prod, OR if the operator scales beyond one tenant simultaneously running.
- **L-2 materialized view for `/api/reservations/summary`** — only worth it if test shows the 30s cache is still insufficient.
- **L-3 Postgres read replica** — only needed if Phase 2's query reduction isn't enough to keep p95 < 500 ms under 20 VUs.
- **L-4 real APM (Datadog / Honeycomb)** — only worth the spend if Sentry traces (Phase 1) are missing signal. The slow-query and slow-request logs from Phase 1 may be sufficient for a while.
