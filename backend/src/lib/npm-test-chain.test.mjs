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
  // Need a reachable Postgres; the chain must stay runnable on a laptop. But
  // out of `npm test` is NOT out of CI, which is the whole point of the last
  // three tests in this file: everything below that boots embedded-postgres is
  // run by the `embedded-postgres-suites` job in beta-ci.yml via
  // `npm run test:embedded`, and this suite fails if that stops being true —
  // including if the job is commented out, switched off with `if:`, or has its
  // command neutered with `|| true` — in the workflow OR in the test:embedded
  // script itself. The cases it does NOT catch are listed at
  // that assertion rather than left to be discovered.
  // The two entries that are NOT embedded-pg suites say so individually.
  'test:module-access-audit': 'DB-backed (.db.test.mjs); run by the tenant-isolation-suite job',
  'test:customer-inspection': 'DB-backed via the shared prisma singleton; needs a live DATABASE_URL, run by no automation',
  'test:customer-docs-backfill': 'embedded-postgres; also in test:embedded (CI)',
  'test:precheckin-charges': 'embedded-postgres; also in test:embedded (CI)',
  // The aggregate CI entry point. Installing embedded-postgres and booting
  // seven throwaway clusters is ~5 minutes and a `npm install --no-save`, so it
  // cannot sit in the chain a laptop runs; it gets its own CI job instead.
  'test:embedded': 'boots embedded-postgres; run by the embedded-postgres-suites CI job',
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

/**
 * Test files named by no script, as of 2026-08-06 for src/ and 2026-08-17 for
 * scripts/. NOT an approval — a high-water mark. Deleting an entry (by wiring
 * the file into a script) is always welcome; adding one requires a deliberate
 * edit here, which is the whole point.
 *
 * The walk covers src/ AND scripts/. It was src/ only until the embedded-suite
 * guard needed scripts/, at which point a ratchet that ignored half the tree
 * the detector reads was just a place for a suite to hide.
 */
const UNRUN_FILES_BASELINE = new Set([
  // scripts/ joined this ratchet when the embedded-suite guard below started
  // scanning it. Widening the walk without grandfathering these three would
  // have failed the suite for files this commit never touched; they are real
  // suites nobody runs, same deal as the src/ entries — audit and wire them,
  // then delete the lines.
  'scripts/backfill-inspection-photos-to-storage.test.mjs',
  'scripts/tl-rematch-existing.test.mjs',
  'scripts/unblock-pre-terms-reservations.test.mjs',
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
  'src/modules/checkout-session/spin-charge.test.mjs',
  'src/modules/checkout-session/state-machine.test.mjs',
  'src/modules/checkout-session/terms-signing.test.mjs',
  'src/modules/citations/citations-archive.test.mjs',
  'src/modules/customer-portal/customer-portal-rate-limit.test.mjs',
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
  'src/modules/reports/unpaid-balance.report.test.mjs',
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
  const unrun = [...testFiles('src'), ...testFiles('scripts')].filter((f) => !named.has(f));
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
  const all = new Set([...testFiles('src'), ...testFiles('scripts')]);
  const stale = [...UNRUN_FILES_BASELINE].filter((f) => !all.has(f) || named.has(f));
  assert.deepEqual(stale, [], `Baseline entries to delete (gone or now wired): ${stale.join(', ')}`);
});

/**
 * The embedded-postgres suites: named by a script AND actually run by CI.
 *
 * These are the only tests in the repo that exercise real transactions,
 * real constraints and real concurrency. Until now every one of them was
 * excused from `npm test` (correctly — they need `npm install --no-save
 * embedded-postgres` and about four minutes) and then run by nothing at all.
 * The most expensive gap was precheckin-charges.embedded: the sole proof that a
 * money route an unsupervised customer drives from their phone rewrites its
 * charge sheet atomically and refuses a double tap. A guard that does not run
 * is documentation — beta-ci.yml's own words, a few lines above the step that
 * exists for the same reason.
 *
 * Two halves, because either one alone is a lie:
 *   - every suite that boots embedded-postgres is named by `test:embedded`;
 *   - beta-ci.yml actually invokes `npm run test:embedded`.
 * Membership is derived from the IMPORT, not the filename. Six of the seven
 * carry an `.embedded.test.mjs` infix and one — the customer-documents storage
 * backfill — does not, so a filename glob would have quietly skipped it.
 */
function suitesBootingEmbeddedPg() {
  // The IMPORT SPECIFIER, not a bare substring: this very file names
  // embedded-pg-boot in the prose above, and a substring match duly reported
  // the guard itself as an unrun suite the first time it ran.
  //
  // `import(` as well as `from`, so a suite that boots the helper lazily is not
  // invisible. Two blind spots remain and are deliberate: a suite that drives
  // the `embedded-postgres` package directly instead of through this helper,
  // and one that reaches it via a shared fixture module (testFiles only reads
  // *.test.mjs and does not follow into helpers). The helper is the repo
  // convention; if that stops being true, this needs to walk imports.
  const IMPORTS_BOOT = /(?:from|import\()\s*['"][^'"]*embedded-pg-boot\.mjs['"]/;
  return [...testFiles('src'), ...testFiles('scripts')].filter((f) =>
    IMPORTS_BOOT.test(readFileSync(f, 'utf8')),
  );
}

test('every embedded-postgres suite is named by `test:embedded`', () => {
  const named = new Set(
    [...String(pkg.scripts['test:embedded'] ?? '').matchAll(/[\w./-]+\.test\.mjs/g)].map((m) => m[0]),
  );
  const missing = suitesBootingEmbeddedPg().filter((f) => !named.has(f));
  assert.deepEqual(
    missing,
    [],
    `Suite(s) that boot embedded-postgres but no CI job runs — add to "test:embedded": ${missing.join(', ')}`,
  );
});

test('`test:embedded` does not name a suite that has stopped booting embedded pg', () => {
  // Same ratchet logic as the baseline: the script must describe reality, or
  // the guard above passes by naming files that no longer need the job.
  const listed = [...String(pkg.scripts['test:embedded'] ?? '').matchAll(/[\w./-]+\.test\.mjs/g)].map((m) => m[0]);
  const actual = new Set(suitesBootingEmbeddedPg());
  const stale = listed.filter((f) => !actual.has(f));
  assert.deepEqual(stale, [], `"test:embedded" names suite(s) that no longer boot embedded pg: ${stale.join(', ')}`);
});

/**
 * The script the CI job invokes must still BE the thing it claims to be.
 *
 * Every other assertion here hardens the workflow line. None of them looked at
 * `test:embedded` itself as anything but a bag of filenames — tests 5 and 6 read
 * it only through /[\w./-]+\.test\.mjs/g, so everything outside those filenames
 * was invisible. QA neutered the script five ways and the whole suite stayed
 * green while the CI job would have run nothing:
 *     ... <7 files> || true
 *     ... <7 files> ; exit 0
 *     echo would run: ...
 *     node --test --test-only ...        (runs zero tests)
 *     true # <the entire original script>
 *
 * This is the same `|| true` the workflow-side check was hardened against,
 * moved one file to the left — into package.json, where a script edit gets a
 * fraction of the scrutiny a .github/workflows/ diff gets, and which is the
 * file somebody is already in when they are tuning --test-concurrency or the
 * file list. The first red run on a platform this has never executed on is
 * exactly when they would reach for it.
 */
test('`test:embedded` cannot be neutered into a no-op', () => {
  const embedded = String(pkg.scripts['test:embedded'] ?? '');
  assert.match(
    embedded,
    /^node --test(?: |$)/,
    'test:embedded no longer STARTS with `node --test` — whatever it runs now, it is not the suites',
  );
  assert.ok(
    !/[|;&]/.test(embedded),
    'test:embedded chains a shell operator — `|| true` or `; exit 0` here makes the CI job ' +
      'green while every suite fails, and the workflow-side guards cannot see it',
  );
  assert.ok(
    !/(?:^|\s)--test-only(?:\s|=|$)/.test(embedded),
    'test:embedded passes --test-only, which runs ZERO tests unless a suite opts in',
  );
});
test('beta-ci.yml actually runs `npm run test:embedded`, unguarded, in a live job', () => {
  // The point of the whole exercise. Naming the suites in a script they COULD
  // be run by is not coverage; a job that runs them is.
  //
  // This assertion has now been defeated twice by QA and rewritten twice, which
  // is the honest summary of how hard it is to assert 'CI really does this':
  //   1. A whole-file `includes()` was green with the step COMMENTED OUT and
  //      green with `if: false` on the job.
  //   2. Requiring `run:` + `.*` was green with `npm run test:embedded || true`
  //      — semantically identical to continue-on-error, and the first thing
  //      somebody reaches for at 11pm because they are already editing that
  //      line — and green when the real invocation was moved into a SIBLING
  //      job that was itself switched off.
  // Hence: comments stripped, the job body extracted FIRST, and the command
  // matched whole-line with nothing appended.
  //
  // NOT COVERED, deliberately, so this comment does not become the next
  // over-claim, ways past this that are NOT caught — INCLUDING, not an
  // exhaustive inventory, because the list grew every time QA looked:
  //   - an empty `strategy.matrix`, so the job never materializes;
  //   - narrowing the workflow's `on:` triggers, or paths-ignore;
  //   - a `needs:` on a job that is itself skipped;
  //   - a decoy `embedded-postgres-suites:` line inside a block scalar under
  //     `jobs:`, or a decoy `run:` line in an EARLIER step, which makes the
  //     step search below pick the wrong chunk;
  //   - `shell: cat {0}`, which prints the script and exits 0;
  //   - `"if": false` with a quoted key, or `if : false` with a space before
  //     the colon.
  // Each is exotic, loud (the `on:` one disables all four jobs at once), or
  // requires intent to deceive. A nonexistent `runs-on` label also passes, but
  // it reports as a PENDING check, never a green one, so it cannot forge a pass.
  const CI_PATH = '../../../.github/workflows/beta-ci.yml';
  let ci;
  try {
    ci = readFileSync(new URL(CI_PATH, import.meta.url), 'utf8');
  } catch (err) {
    // Not an fs stack trace: this assertion needs the repo root, so a backend
    // tree checked out on its own (or COPY'd into the fleet-backend image,
    // which is built from backend/ and has no .github) fails here for a reason
    // that has nothing to do with the guard. Say so.
    assert.fail(
      `Cannot read ${CI_PATH} (${err.code ?? err.message}). This guard asserts CI still runs ` +
        'the embedded suites and therefore needs a FULL repo checkout, not a standalone backend/ tree.',
    );
  }
  const live = ci.replace(/^[ 	]*#.*$/gm, '');
  // Terminator accepts end-of-input: the job being LAST in the file is a
  // legitimate reorder, and reporting it as 'the job is gone' sends the reader
  // hunting for a deletion that never happened.
  // Sliced from `jobs:` first: `^  embedded-postgres-suites:` is a legal line
  // inside a top-level block scalar, and .exec takes the FIRST match, so an
  // unanchored search can be pointed at a decoy header. Needs intent to
  // deceive, but 'extracted from the job' should mean that.
  const jobsAt = live.search(/^jobs:$/m);
  // search() returns -1 and slice(-1) then yields the LAST CHARACTER of the
  // file rather than throwing, so a stray space after `jobs:` reported the job
  // as deleted. Same 'sends the reader hunting' failure as the terminator above.
  assert.ok(jobsAt >= 0, 'beta-ci.yml has no top-level `jobs:` line');
  const jobs = live.slice(jobsAt);
  const body = /^  embedded-postgres-suites:$([\s\S]*?)(?:^  \S|$(?![\s\S]))/m.exec(jobs)?.[1];
  assert.ok(body, 'the embedded-postgres-suites job is gone from beta-ci.yml');
  // Whole-line and exact. `.*` after the command was the hole: `|| true`,
  // `; exit 0` and a shell-variable gate all satisfied it. Matched against the
  // JOB BODY, not the file, so the invocation cannot be relocated into some
  // other job that is itself disabled.
  assert.match(
    body,
    /^\s+run:\s*npm run test:embedded\s*$/m,
    'beta-ci.yml no longer runs `npm run test:embedded` inside the embedded-postgres-suites ' +
      'job as a SINGLE-LINE `run:` with nothing appended (no `|` block, no quoting, no ' +
      '`|| true`) — the embedded suites are unguarded again',
  );
  // Kill switches, scoped so that each one catches the disabling edit without
  // catching the legitimate one next to it.
  for (const [label, re] of [
    // EXACTLY four spaces = job level. A step may legitimately carry `if:`.
    ['a job-level `if:`', /^ {4}if:/m],
    // Any value that is not `false`, case-insensitively: YAML 1.2 resolves
    // True/TRUE as well as true, and `${{ true }}` is another spelling. Matching
    // one spelling of a value is how the `if: false` hole got opened.
    ['a `continue-on-error` that is not false', /^\s*continue-on-error:\s*(?!false(?:$|[^-\w]))\S/im],
  ]) {
    assert.ok(
      !re.test(body),
      `embedded-postgres-suites carries ${label} — a job that can skip itself, or pass while ` +
        'failing, is not a gate',
    );
  }
  // ANY `if:` on the step that carries the command, not just a literal `false`.
  // Matching only `if: false` was a REGRESSION: the previous version's blunter
  // `/^\s{4,}if:/` caught `if: github.event_name == 'push'`, and narrowing it to
  // fix a false failure on sibling steps let that back through. It is also the
  // likeliest disabling edit on this whole list — gating an expensive job to
  // save five minutes per PR is normal, well-intentioned and cost-motivated,
  // far more likely than `|| true`. Scoping to the ONE step keeps
  // `if: failure()` on a log-dump step legal, which is what m1 was about.
  const RUN_LINE = /^\s*run:\s*npm run test:embedded\s*$/m;
  // The split below assumes the 6-space step indent both workflows in this repo
  // use. 4- and 8-space are also valid YAML and Actions accepts them; without
  // this assertion a reindent yields ONE chunk (the whole body), and then any
  // sibling step's `if: failure()` trips the check with a message accusing the
  // command step — m1 resurrected, silently.
  assert.match(body, /^ {6}- /m, 'the steps of embedded-postgres-suites are not at the 6-space indent this guard assumes');
  const step = body.split(/^ {6}- /m).find((chunk) => RUN_LINE.test(chunk));
  assert.ok(step, 'the `npm run test:embedded` invocation is not a step of embedded-postgres-suites');
  assert.ok(
    !/^[ 	]*if:/m.test(step),
    'the step running `npm run test:embedded` carries an `if:` — a conditional step is not a gate. ' +
      'Put the condition on a step that is not the one doing the work.',
  );
});
