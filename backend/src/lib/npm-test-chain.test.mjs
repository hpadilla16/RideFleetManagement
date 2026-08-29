// A test suite that nobody runs is worse than no test suite: it reports
// safety it never checked. Two ways that happens here, and the first version
// of this guard only caught the second one.
//
// WHY: `reservation-smart-match.test.mjs` — 17 tests including a prefix-drift
// guard — sat in the tree since S30 named by NO script at all. It had never
// run. The bug it would have caught (a spoken code with a stray leading zero)
// cost a customer his airport shuttle on 2026-08-06. That is an orphan FILE.
// This guard originally only checked orphan SCRIPTS, so it would not have
// caught the incident it was written for — and one of the files it was
// missing was `verify-probe-throttle.test.mjs`, the suite for the only rate
// control on the smart-lookup privacy gate (QA, 2026-08-06).
//
// So there are two checks. Scripts: every `test:*` must be reachable from
// `npm test`; the exceptions live in KNOWN_OUT with a reason. Files: the set
// of test files named by no script is a RATCHET — the 50 that already existed
// are grandfathered, and a new one cannot join them. Grandfathering is honest
// about what was verified: nobody audited those 50, and pretending otherwise
// with individual "reasons" would be a worse lie than the list.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';

const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));

const KNOWN_OUT = {
  // Hangs without --test-force-exit (open prisma handle) — it would wedge the
  // whole chain. Fix the script, then delete this line.
  'test:toll-void-credit': 'hangs: no --test-force-exit',
  'test:route-handlers': 'hangs: no --test-force-exit',
  // Need a reachable Postgres; the chain must stay runnable on a laptop.
  'test:module-access-audit': 'DB-backed (.db.test.mjs)',
  'test:customer-inspection': 'DB-backed',
  'test:customer-docs-backfill': 'DB-backed (storage backfill script)',
  // Boots its own throwaway Postgres, but only after `npm install --no-save
  // embedded-postgres` — which `npm ci` does not provide. In the chain it
  // would wedge `npm test` for everyone on a fresh checkout. Its DB-free half
  // (the query shape, the step guard, the signUrl chain) IS chained, as
  // test:declined-insurance.
  'test:declined-insurance-embedded': 'embedded-postgres (npm install --no-save)',
  // Landed on main in the 194 commits between this branch and prod, already
  // orphaned when this guard arrived. Grandfathered UNAUDITED — wiring another
  // session's suite into CI sight-unseen is how the chain gets wedged. Each
  // one is a real suite nobody runs; audit and wire them, then delete the line.
  'test:age-rules': 'inherited from main 2026-08-06, unaudited',
  'test:custom-reports-multi': 'inherited from main 2026-08-06, unaudited',
  'test:airport-lawa': 'inherited from main 2026-08-06, unaudited',
  'test:checkin-email': 'inherited from main 2026-08-06, unaudited',
};

/**
 * Tokenized, NOT substring. `chain.includes('npm run test:maintenance')` is
 * satisfied by `npm run test:maintenance-scope`, which silently exempted seven
 * script names from this very guard (QA m1) — a guard with a blind spot the
 * shape of the bug it is watching for.
 */
function chainScripts() {
  return new Set(
    (pkg.scripts.test ?? '')
      .split('&&')
      .map((s) => s.trim())
      .filter((s) => s.startsWith('npm run '))
      .map((s) => s.slice('npm run '.length).trim()),
  );
}

test('every test:* script is reachable from `npm test`', () => {
  const chain = chainScripts();
  const orphans = Object.keys(pkg.scripts)
    .filter((k) => k.startsWith('test:'))
    .filter((k) => !chain.has(k))
    .filter((k) => !(k in KNOWN_OUT));
  assert.deepEqual(
    orphans,
    [],
    `Orphaned suite(s) — add to the "test" chain, or to KNOWN_OUT with a reason: ${orphans.join(', ')}`,
  );
});

test('KNOWN_OUT does not outlive the scripts it excuses', () => {
  // A stale excuse is how the allowlist turns into a place to hide things.
  const stale = Object.keys(KNOWN_OUT).filter((k) => !(k in pkg.scripts));
  assert.deepEqual(stale, [], `KNOWN_OUT names script(s) that no longer exist: ${stale.join(', ')}`);
  const chain = chainScripts();
  const wired = Object.keys(KNOWN_OUT).filter((k) => chain.has(k));
  assert.deepEqual(wired, [], `KNOWN_OUT names script(s) that ARE in the chain now: ${wired.join(', ')}`);
});

// ---------------------------------------------------------------------------
// Third way a suite reports safety it never checked: it IS in `npm test`, and
// `npm test` is not what CI runs. beta-ci.yml's own comment says the chain
// hangs at an early suite and "cannot be relied on as the automatic gate", so
// the workflow runs an explicit list of scripts instead. A suite wired only
// into the chain is therefore still dark. That is exactly what happened to
// test:terms-signing between 2026-08-17's build and its review.
//
// This is a RATCHET like the two above: names listed here must appear in the
// explicit CI list, and the check fails loudly if the workflow, the step or
// the script disappears from under it.
const CI_GATED = {
  'test:terms-signing':
    'the no-auth /api/sign payload: whose brand the renter sees while signing',
  'test:tenant-brand':
    'the shared cascade behind that brand, and the counter screen that shows the QR',
  'test:presence-boundary':
    'which surfaces may receive the presence array — it carries staff names and, '
    + 'since M2-H6, employee ids; the customer phone and the lobby kiosk must get neither',
};

function ciWorkflowRunLines() {
  const yml = readFileSync(new URL('../../../.github/workflows/beta-ci.yml', import.meta.url), 'utf8');
  // Every `run:` body in the file, joined. Deliberately not a YAML parse: the
  // question is only "does this command line invoke the script", and adding a
  // yaml dependency to a guard is how guards stop being cheap to keep.
  return yml;
}

test('CI-gated suites are in beta-ci.yml, not only in `npm test`', () => {
  const yml = ciWorkflowRunLines();
  const chain = chainScripts();
  const missing = [];
  for (const [script, why] of Object.entries(CI_GATED)) {
    if (!(script in pkg.scripts)) { missing.push(`${script} (no such script) — ${why}`); continue; }
    // Tokenized for the same reason chainScripts() is: `npm run test:terms`
    // is a prefix of `npm run test:terms-signing`.
    const invoked = new RegExp(`npm run ${script.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w:-])`).test(yml);
    if (!invoked) missing.push(`${script} — ${why}`);
    if (!chain.has(script)) missing.push(`${script} (dropped from \`npm test\`) — ${why}`);
  }
  assert.deepEqual(
    missing,
    [],
    `Suite(s) that must run in CI's explicit list AND in \`npm test\`: ${missing.join('; ')}`,
  );
});

/**
 * Test files named by no script, as of 2026-08-06. NOT an approval — a
 * high-water mark. Deleting an entry (by wiring the file into a script) is
 * always welcome; adding one requires a deliberate edit here, which is the
 * whole point.
 */
const UNRUN_FILES_BASELINE = new Set([
  'src/lib/integration-crypto.test.mjs',
  'src/lib/prisma.test.mjs',
  'src/lib/queue/priorities.test.mjs',
  'src/lib/storage/supabase-storage.test.mjs',
  'src/lib/tenant-routing.test.mjs',
  'src/middleware/endpoint-load-sampler.test.mjs',
  // tenant-rate-limit.test.mjs left this list when `test:rate-limit` was wired
  // up alongside the Redis-timeout fix. The baseline is a high-water mark, so a
  // stale entry fails the suite on purpose — that is it working, not breaking.
  'src/modules/booking-engine/car-sharing-discovery.test.mjs',
  'src/modules/checkout-session/age-rules-gate.test.mjs',
  'src/modules/checkout-session/checkout-session.scheduler.test.mjs',
  // spin-charge.test.mjs left this list 2026-08-26: per-tenant terminal config
  // made it a load-bearing money-path suite, so it got an env bootstrap, DB
  // fakes for the new AppSetting read, and a script (test:spin-charge).
  'src/modules/checkout-session/state-machine.test.mjs',
  'src/modules/citations/citations-archive.test.mjs',
  'src/modules/customer-portal/customer-portal-rate-limit.test.mjs',
  'src/modules/customers/customer-doc-endpoints.embedded.test.mjs',
  'src/modules/customers/customer-phone-normalize.embedded.test.mjs',
  'src/modules/fees/fee-rate-audit.service.test.mjs',
  'src/modules/fees/fee-rates.routes.test.mjs',
  'src/modules/fees/fee-rates.service.test.mjs',
  'src/modules/fees/fees-cache.test.mjs',
  'src/modules/integrations/tl-international/duplicate-detector.test.mjs',
  'src/modules/integrations/tl-international/mapper.test.mjs',
  'src/modules/integrations/tl-international/promotion-matcher.service.test.mjs',
  'src/modules/integrations/tl-international/tl-international.routes.test.mjs',
  'src/modules/integrations/tl-international/tl-international.service.test.mjs',
  'src/modules/integrations/tl-international/tl-international.worker.stealth.test.mjs',
  'src/modules/integrations/tl-international/tl-international.worker.test.mjs',
  'src/modules/inventory/inventory-logic.test.mjs',
  'src/modules/market-scraper/market-vendor.test.mjs',
  'src/modules/market-scraper/pricing-tiers.test.mjs',
  'src/modules/market-scraper/pricing-utilization.test.mjs',
  'src/modules/payment-gateway/ipos-auth.test.mjs',
  'src/modules/payment-gateway/ipos-transact-client.test.mjs',
  'src/modules/rental-agreements/duplicate-charges.test.mjs',
  'src/modules/rental-agreements/inspection-photos-hardened.test.mjs',
  'src/modules/rental-agreements/inspection-photos.test.mjs',
  'src/modules/rental-agreements/rental-agreements-compact-response.test.mjs',
  'src/modules/rental-agreements/slim-response-contracts.test.mjs',
  'src/modules/reports/availability.report.test.mjs',
  'src/modules/reports/fleet-status.report.test.mjs',
  'src/modules/reports/rental-status.report.test.mjs',
  'src/modules/reports/reservations-by-day.report.test.mjs',
  'src/modules/reports/upcoming-vehicle-sales.report.test.mjs',
  'src/modules/reports/utilization.report.test.mjs',
  'src/modules/reservations/list-page-date-filter.test.mjs',
  'src/modules/reservations/list-page-shape.test.mjs',
  'src/modules/reservations/notes-updated-at.test.mjs',
  'src/modules/reservations/reservation-summary-counters.test.mjs',
  'src/modules/reservations/start-rental-compact.test.mjs',
  'src/modules/tolls/tolls-scoring.test.mjs',
  'src/modules/vehicles/mileage-history.service.test.mjs',
]);

function testFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    // POSIX separators regardless of platform: these paths are compared against
    // package.json scripts and UNRUN_FILES_BASELINE, which use forward slashes.
    return statSync(p).isDirectory() ? testFiles(p) : p.endsWith('.test.mjs') ? [p.split(sep).join('/')] : [];
  });
}

test('no NEW test file is left unrun by every script', () => {
  const named = new Set();
  for (const cmd of Object.values(pkg.scripts)) {
    for (const m of String(cmd).matchAll(/[\w./-]+\.test\.mjs/g)) named.add(m[0]);
  }
  const unrun = testFiles('src').filter((f) => !named.has(f));
  const added = unrun.filter((f) => !UNRUN_FILES_BASELINE.has(f));
  assert.deepEqual(
    added,
    [],
    `Test file(s) that no script runs — name them in a test:* script: ${added.join(', ')}`,
  );
});

test('the baseline shrinks, never silently rots', () => {
  // An entry that no longer exists, or is now wired, must leave the list —
  // otherwise the high-water mark drifts upward without anyone deciding.
  const named = new Set();
  for (const cmd of Object.values(pkg.scripts)) {
    for (const m of String(cmd).matchAll(/[\w./-]+\.test\.mjs/g)) named.add(m[0]);
  }
  const all = new Set(testFiles('src'));
  const stale = [...UNRUN_FILES_BASELINE].filter((f) => !all.has(f) || named.has(f));
  assert.deepEqual(stale, [], `Baseline entries to delete (gone or now wired): ${stale.join(', ')}`);
});
