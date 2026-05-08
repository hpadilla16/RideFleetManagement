#!/usr/bin/env node
// Zero-dependency load test for the public booking hot path.
//
// Validates the resilience plan (R1, R2, R3, R8, R23 — see
// doc/pool-resilience-plan-2026-05-05.md) by simulating concurrent visitor
// traffic on the public booking endpoints. Specifically targets the
// endpoints that fan out prisma queries and were the cause of BUG-005:
//   - GET  /api/public/booking/bootstrap     (cached, ~2KB after R23)
//   - GET  /api/public/booking/website-fees  (cached after R3)
//   - POST /api/public/booking/rental-search (cached after R1, parallelized after R8)
//
// Usage:
//   node scripts/load-test/run-public-booking.mjs \
//     --baseUrl=https://ridefleetmanager.com \
//     --tenantSlug=internationrentalcorp-fleet \
//     --pickupLocationId=cmnakn5w00001ok0iyhs1govp \
//     --duration=60 \
//     --vus=50
//
// Optional flags:
//   --pickupAt=ISO            Override pickup date (defaults to +7 days)
//   --returnAt=ISO            Override return date (defaults to +9 days)
//   --varyDates               Vary search dates per VU to stress cold-cache path
//   --warmup=10               Seconds before measurement starts (default 10s)
//   --json                    Emit machine-readable JSON summary at the end
//   --noSearch                Skip the POST /rental-search endpoint
//
// Output: per-endpoint count / errors / p50 / p95 / p99 / mean (ms),
// plus aggregate throughput, error rate, and a pass/fail summary.
//
// Pass criteria (gates CI):
//   - error rate < 1%
//   - p95 of any endpoint < 5000ms
//   - zero "connection pool" or "ECIRCUITBREAKER" errors observed

const args = parseArgs(process.argv.slice(2));
const BASE_URL = stripTrailingSlash(args.baseUrl || process.env.LOAD_TEST_BASE_URL || 'https://ridefleetmanager.com');
const TENANT_SLUG = args.tenantSlug || process.env.LOAD_TEST_TENANT_SLUG || '';
const PICKUP_LOCATION_ID = args.pickupLocationId || process.env.LOAD_TEST_PICKUP_LOC || '';
const DURATION_S = clampInt(args.duration, 60, 5, 600);
const VUS = clampInt(args.vus, 50, 1, 500);
const WARMUP_S = clampInt(args.warmup, 10, 0, 60);
const VARY_DATES = !!args.varyDates;
const NO_SEARCH = !!args.noSearch;
const JSON_OUT = !!args.json;

const DEFAULT_PICKUP = args.pickupAt || isoNDaysFromNow(7);
const DEFAULT_RETURN = args.returnAt || isoNDaysFromNow(9);

if (!TENANT_SLUG) {
  console.error('Missing --tenantSlug=<slug>. The public endpoints require a tenant context.');
  process.exit(2);
}
if (!NO_SEARCH && !PICKUP_LOCATION_ID) {
  console.error('Missing --pickupLocationId=<id>. Required for /rental-search. Use --noSearch to skip.');
  process.exit(2);
}

// Endpoint mix — weights approximate observed visitor traffic. Bootstrap
// and website-fees are hit on every page load; rental-search only when
// a user actually searches (the heavier endpoint).
const ENDPOINTS = [
  { name: 'public.bootstrap',     weight: 40, kind: 'GET',
    path: `/api/public/booking/bootstrap?tenantSlug=${encodeURIComponent(TENANT_SLUG)}` },
  { name: 'public.website-fees',  weight: 20, kind: 'GET',
    path: `/api/public/booking/website-fees?tenantSlug=${encodeURIComponent(TENANT_SLUG)}` }
];

if (!NO_SEARCH) {
  ENDPOINTS.push({
    name: 'public.rental-search', weight: 40, kind: 'POST',
    path: '/api/public/booking/rental-search'
  });
}

const TOTAL_WEIGHT = ENDPOINTS.reduce((s, e) => s + e.weight, 0);
function pickEndpoint() {
  let r = Math.random() * TOTAL_WEIGHT;
  for (const ep of ENDPOINTS) {
    r -= ep.weight;
    if (r <= 0) return ep;
  }
  return ENDPOINTS[ENDPOINTS.length - 1];
}

function buildSearchBody(vuId) {
  // varyDates: each VU uses a slightly different window so cache keys
  // diverge. Without it, all VUs share one cache entry — almost pure cache
  // hits after warmup, which is realistic for repeat-visitor traffic but
  // doesn't stress the cold-cache path.
  const offsetDays = VARY_DATES ? (vuId % 14) : 0;
  return JSON.stringify({
    tenantSlug: TENANT_SLUG,
    pickupLocationId: PICKUP_LOCATION_ID,
    pickupAt: VARY_DATES ? isoNDaysFromNow(7 + offsetDays) : DEFAULT_PICKUP,
    returnAt: VARY_DATES ? isoNDaysFromNow(9 + offsetDays) : DEFAULT_RETURN
  });
}

const COMMON_HEADERS = { 'Accept': 'application/json' };
const POST_HEADERS = { ...COMMON_HEADERS, 'Content-Type': 'application/json' };

const stats = new Map();
for (const ep of ENDPOINTS) stats.set(ep.name, { count: 0, errors: 0, durations: [], poolErrors: 0 });

let measuring = false;
let stopAt = 0;

async function vu(id) {
  while (Date.now() < stopAt) {
    const ep = pickEndpoint();
    const url = `${BASE_URL}${ep.path}`;
    const start = performance.now();
    let ok = true;
    let isPoolErr = false;
    try {
      const init = ep.kind === 'POST'
        ? { method: 'POST', headers: POST_HEADERS, body: buildSearchBody(id) }
        : { headers: COMMON_HEADERS };
      const res = await fetch(url, init);
      const text = await res.text();
      if (!res.ok) {
        ok = false;
        if (/connection pool|ECIRCUITBREAKER/i.test(text)) isPoolErr = true;
      }
    } catch {
      ok = false;
    }
    if (measuring) {
      const ms = performance.now() - start;
      const s = stats.get(ep.name);
      s.count += 1;
      if (!ok) s.errors += 1;
      if (isPoolErr) s.poolErrors += 1;
      s.durations.push(ms);
    }
  }
}

function quantile(sortedAsc, q) {
  if (!sortedAsc.length) return 0;
  if (q <= 0) return sortedAsc[0];
  if (q >= 1) return sortedAsc[sortedAsc.length - 1];
  const rank = Math.ceil(q * sortedAsc.length);
  const idx = Math.min(sortedAsc.length - 1, Math.max(0, rank - 1));
  return sortedAsc[idx];
}

function summarize() {
  const summary = {
    totals: { requests: 0, errors: 0, poolErrors: 0, durationS: DURATION_S, vus: VUS, baseUrl: BASE_URL },
    endpoints: {}
  };
  for (const [name, s] of stats) {
    const sorted = s.durations.slice().sort((a, b) => a - b);
    const mean = sorted.length ? sorted.reduce((a, b) => a + b, 0) / sorted.length : 0;
    summary.endpoints[name] = {
      count: s.count,
      errors: s.errors,
      poolErrors: s.poolErrors,
      mean_ms: round(mean),
      p50_ms: round(quantile(sorted, 0.5)),
      p95_ms: round(quantile(sorted, 0.95)),
      p99_ms: round(quantile(sorted, 0.99)),
      max_ms: round(sorted[sorted.length - 1] || 0)
    };
    summary.totals.requests += s.count;
    summary.totals.errors += s.errors;
    summary.totals.poolErrors += s.poolErrors;
  }
  summary.totals.throughput_rps = round(summary.totals.requests / DURATION_S);
  summary.totals.error_rate = summary.totals.requests
    ? round(summary.totals.errors / summary.totals.requests, 4)
    : 0;
  return summary;
}

function printHumanSummary(s) {
  const pad = (str, n) => String(str).padEnd(n);
  console.log('');
  console.log(`Endpoint                          count    err  pool   mean    p50    p95    p99    max  (ms)`);
  console.log(`────────────────────────────────────────────────────────────────────────────────────────────`);
  for (const [name, row] of Object.entries(s.endpoints)) {
    console.log(
      pad(name, 32) +
      pad(row.count, 8) +
      pad(row.errors, 7) +
      pad(row.poolErrors, 6) +
      pad(row.mean_ms, 7) +
      pad(row.p50_ms, 7) +
      pad(row.p95_ms, 7) +
      pad(row.p99_ms, 7) +
      pad(row.max_ms, 7)
    );
  }
  console.log(`────────────────────────────────────────────────────────────────────────────────────────────`);
  console.log(`Total requests:    ${s.totals.requests}`);
  console.log(`Throughput:        ${s.totals.throughput_rps} rps`);
  console.log(`Error rate:        ${(s.totals.error_rate * 100).toFixed(2)}%`);
  console.log(`Pool errors:       ${s.totals.poolErrors}`);
  console.log(`Concurrency:       ${s.totals.vus} VUs over ${s.totals.durationS}s`);
  console.log(`Base URL:          ${s.totals.baseUrl}`);
  console.log(`Vary dates:        ${VARY_DATES ? 'YES (cold-cache stress)' : 'NO (warm-cache realistic)'}`);
}

async function main() {
  console.log(`Public booking load test: ${VUS} VUs × ${DURATION_S}s against ${BASE_URL}`);
  console.log(`Tenant: ${TENANT_SLUG}`);
  if (PICKUP_LOCATION_ID) console.log(`Pickup location: ${PICKUP_LOCATION_ID}`);
  console.log(`Warmup: ${WARMUP_S}s, then measuring for ${DURATION_S}s.`);

  if (WARMUP_S > 0) {
    stopAt = Date.now() + WARMUP_S * 1000;
    measuring = false;
    await Promise.all(Array.from({ length: VUS }, (_, i) => vu(i)));
  }

  measuring = true;
  stopAt = Date.now() + DURATION_S * 1000;
  await Promise.all(Array.from({ length: VUS }, (_, i) => vu(i)));

  const summary = summarize();
  if (JSON_OUT) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    printHumanSummary(summary);
  }

  // Pass/fail gates — make this script suitable for CI sometime in the future.
  let failed = false;
  if (summary.totals.error_rate > 0.01) {
    console.error(`\nFAIL: error rate ${(summary.totals.error_rate * 100).toFixed(2)}% > 1% threshold.`);
    failed = true;
  }
  if (summary.totals.poolErrors > 0) {
    console.error(`\nFAIL: ${summary.totals.poolErrors} pool/circuit-breaker errors observed (must be 0).`);
    failed = true;
  }
  for (const [name, row] of Object.entries(summary.endpoints)) {
    if (row.p95_ms > 5000) {
      console.error(`\nFAIL: ${name} p95 ${row.p95_ms}ms > 5000ms threshold.`);
      failed = true;
    }
  }
  if (failed) process.exit(1);
  console.log(`\nPASS: all gates met.`);
}

main().catch((err) => {
  console.error('Load test failed:', err);
  process.exit(1);
});

// ---------- helpers ----------

function parseArgs(argv) {
  const out = {};
  for (const a of argv) {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    if (m) out[m[1]] = m[2] === undefined ? true : m[2];
  }
  return out;
}

function clampInt(value, fallback, min, max) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function stripTrailingSlash(s) {
  return String(s || '').replace(/\/+$/, '');
}

function round(n, digits = 1) {
  const m = Math.pow(10, digits);
  return Math.round(n * m) / m;
}

function isoNDaysFromNow(n) {
  const d = new Date(Date.now() + n * 24 * 3600 * 1000);
  // Round to next 14:00 UTC for consistency
  d.setUTCHours(14, 0, 0, 0);
  return d.toISOString();
}
