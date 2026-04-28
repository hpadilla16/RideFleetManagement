#!/usr/bin/env node
// Zero-dependency load test for the reservations hot path.
//
// Validates Phase 1 + Phase 2 perf wins by simulating ~15 concurrent staff
// sessions hitting /api/reservations/page (list refresh — the biggest
// connection-pool risk per docs/operations/performance-prep-2026-04-28.md),
// /api/reservations/summary (dashboard KPI cache hit path), and the
// alternate /api/reservations list endpoint.
//
// Usage:
//   node scripts/load-test/run-reservations.mjs \
//     --baseUrl=http://localhost:4000 \
//     --token=<JWT> \
//     --duration=60 \
//     --vus=15
//
// Optional flags:
//   --tenantSlug=<slug>      Adds ?tenantSlug=... to public-style endpoints
//   --reservationId=<id>     If set, also hits /api/reservations/:id and
//                            /api/reservations/:id/pricing-options
//   --warmup=5               Seconds before measurement starts (cache warmup)
//   --json                   Emit machine-readable JSON summary at the end
//
// Output: per-endpoint count / errors / p50 / p95 / p99 / mean (ms),
// plus an aggregate throughput and error rate for the run.
//
// Bring-up:
//   1) Start the backend (npm run dev or docker compose up).
//   2) Get a real JWT (login via /api/auth/login or use tenant-seed output).
//   3) `node scripts/load-test/run-reservations.mjs --token=<jwt>`
//   4) Compare numbers before/after merging perf-phase1 + perf-phase2.

const args = parseArgs(process.argv.slice(2));
const BASE_URL = stripTrailingSlash(args.baseUrl || process.env.LOAD_TEST_BASE_URL || 'http://localhost:4000');
const TOKEN = args.token || process.env.LOAD_TEST_TOKEN || '';
const DURATION_S = clampInt(args.duration, 60, 5, 600);
const VUS = clampInt(args.vus, 15, 1, 200);
const WARMUP_S = clampInt(args.warmup, 5, 0, 60);
const TENANT_SLUG = args.tenantSlug || '';
const RESERVATION_ID = args.reservationId || '';
const JSON_OUT = !!args.json;

if (!TOKEN) {
  console.error('Missing --token=<JWT>. Get one via /api/auth/login.');
  process.exit(2);
}

// Endpoint mix — weights approximate observed staff usage. The list refresh
// path is the most expensive (Phase 2 cut it from 6 -> 2 prisma queries) so
// it dominates here.
const ENDPOINTS = [
  { name: 'reservations.page',         weight: 50, path: '/api/reservations/page?limit=50' },
  { name: 'reservations.page.search',  weight: 10, path: '/api/reservations/page?limit=50&q=test' },
  { name: 'reservations.summary',      weight: 25, path: '/api/reservations/summary' },
  { name: 'reservations.list',         weight: 15, path: '/api/reservations?limit=50' }
];

if (RESERVATION_ID) {
  ENDPOINTS.push(
    { name: 'reservations.detail',          weight: 10, path: `/api/reservations/${encodeURIComponent(RESERVATION_ID)}` },
    { name: 'reservations.pricing-options', weight: 10, path: `/api/reservations/${encodeURIComponent(RESERVATION_ID)}/pricing-options` }
  );
}

if (TENANT_SLUG) {
  for (const ep of ENDPOINTS) {
    ep.path = ep.path.includes('?')
      ? `${ep.path}&tenantSlug=${encodeURIComponent(TENANT_SLUG)}`
      : `${ep.path}?tenantSlug=${encodeURIComponent(TENANT_SLUG)}`;
  }
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

const headers = {
  'Authorization': `Bearer ${TOKEN}`,
  'Accept': 'application/json'
};

// Per-endpoint accumulators
const stats = new Map();
for (const ep of ENDPOINTS) stats.set(ep.name, { count: 0, errors: 0, durations: [] });

let measuring = false;
let stopAt = 0;

async function vu(id) {
  while (Date.now() < stopAt) {
    const ep = pickEndpoint();
    const url = `${BASE_URL}${ep.path}`;
    const start = performance.now();
    let ok = true;
    try {
      const res = await fetch(url, { headers });
      // Drain body so we measure full server work, not just headers.
      // Using arrayBuffer to avoid encoding overhead.
      await res.arrayBuffer();
      if (!res.ok) ok = false;
    } catch {
      ok = false;
    }
    if (measuring) {
      const ms = performance.now() - start;
      const s = stats.get(ep.name);
      s.count += 1;
      if (!ok) s.errors += 1;
      s.durations.push(ms);
    }
  }
}

function quantile(sortedAsc, q) {
  if (!sortedAsc.length) return 0;
  const idx = Math.min(sortedAsc.length - 1, Math.floor(q * sortedAsc.length));
  return sortedAsc[idx];
}

function summarize() {
  const summary = { totals: { requests: 0, errors: 0, durationS: DURATION_S, vus: VUS, baseUrl: BASE_URL }, endpoints: {} };
  for (const [name, s] of stats) {
    const sorted = s.durations.slice().sort((a, b) => a - b);
    const mean = sorted.length ? sorted.reduce((a, b) => a + b, 0) / sorted.length : 0;
    summary.endpoints[name] = {
      count: s.count,
      errors: s.errors,
      mean_ms: round(mean),
      p50_ms: round(quantile(sorted, 0.5)),
      p95_ms: round(quantile(sorted, 0.95)),
      p99_ms: round(quantile(sorted, 0.99)),
      max_ms: round(sorted[sorted.length - 1] || 0)
    };
    summary.totals.requests += s.count;
    summary.totals.errors += s.errors;
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
  console.log(`Endpoint                          count    err   mean   p50   p95   p99   max  (ms)`);
  console.log(`──────────────────────────────────────────────────────────────────────────────────`);
  for (const [name, row] of Object.entries(s.endpoints)) {
    console.log(
      pad(name, 32) +
      pad(row.count, 8) +
      pad(row.errors, 7) +
      pad(row.mean_ms, 7) +
      pad(row.p50_ms, 6) +
      pad(row.p95_ms, 6) +
      pad(row.p99_ms, 6) +
      pad(row.max_ms, 6)
    );
  }
  console.log(`──────────────────────────────────────────────────────────────────────────────────`);
  console.log(`Total requests:  ${s.totals.requests}`);
  console.log(`Throughput:      ${s.totals.throughput_rps} rps`);
  console.log(`Error rate:      ${(s.totals.error_rate * 100).toFixed(2)}%`);
  console.log(`Concurrency:     ${s.totals.vus} VUs over ${s.totals.durationS}s`);
  console.log(`Base URL:        ${s.totals.baseUrl}`);
}

async function main() {
  console.log(`Load test: ${VUS} VUs × ${DURATION_S}s against ${BASE_URL}`);
  if (TENANT_SLUG) console.log(`Tenant slug: ${TENANT_SLUG}`);
  if (RESERVATION_ID) console.log(`Reservation ID: ${RESERVATION_ID}`);
  console.log(`Warmup: ${WARMUP_S}s, then measuring for ${DURATION_S}s.`);

  // Warmup phase populates Phase 1 caches before we start measuring.
  if (WARMUP_S > 0) {
    stopAt = Date.now() + WARMUP_S * 1000;
    measuring = false;
    await Promise.all(Array.from({ length: VUS }, (_, i) => vu(i)));
  }

  // Measurement phase
  measuring = true;
  stopAt = Date.now() + DURATION_S * 1000;
  await Promise.all(Array.from({ length: VUS }, (_, i) => vu(i)));

  const summary = summarize();
  if (JSON_OUT) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    printHumanSummary(summary);
  }

  // Exit non-zero if error rate is alarming so this can gate CI runs later.
  if (summary.totals.error_rate > 0.05) {
    console.error(`\nFAIL: error rate ${(summary.totals.error_rate * 100).toFixed(2)}% > 5% threshold.`);
    process.exit(1);
  }
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
