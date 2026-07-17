/**
 * Advantage routes — MODULE tests, mirroring flexways.routes.test.mjs: lock the
 * endpoint inventory + the admin guard so a refactor can't silently drop an
 * endpoint or the auth gate. Full HTTP integration (JWT + express app) lives in
 * the e2e suite.
 *
 * PLUS the one test this family did not have and paid for in production:
 *
 *   THE FIELD-NAME CONTRACT (beta.301). The Flexways panel POSTed
 *   `{ externalSede }` while flexways.routes.js read `req.body.idSede` — "Add
 *   sede" 400'd in prod because the two names only ever met at runtime. Here they
 *   meet in `location config body: the PANEL's builder feeds the ROUTES' reader`
 *   below: the real frontend builder (frontend/src/lib/advantage-location-contract.js)
 *   produces a body, the real route reader (readLocationBody) consumes it, and the
 *   values must survive the round trip. Rename a field on either side alone and
 *   this goes red.
 *
 * Advantage KEY DIFFERENCE vs Flexways: a config row's identity is the PAIR
 * (tsdNumber, branch) — the portal's `Loc` column, "61302.MCO" — not a single
 * idSede. Both halves are exercised below.
 *
 * Pure: no prisma, no network. The router is imported for its stack only.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

process.env.INTEGRATION_ENC_KEY = crypto.randomBytes(32).toString('base64');

const {
  advantageRouter,
  readLocationBody,
  LOCATION_BODY_FIELDS,
  normalizeTsdNumberInput,
  normalizeBranchInput,
  computeHealth,
} = await import('./advantage.routes.js');

// The REAL panel-side builder. Importing across the workspace boundary is
// deliberate — a copy of the contract in this file would prove nothing.
const {
  buildAdvantageLocationBody,
  ADVANTAGE_LOCATION_BODY_FIELDS,
} = await import('../../../../../frontend/src/lib/advantage-location-contract.js');

// ---------------------------------------------------------------------------
// Endpoint inventory + guard
// ---------------------------------------------------------------------------

test('advantageRouter mounts the full Fase 5 endpoint inventory (Flexways shape)', () => {
  assert.ok(advantageRouter);
  const paths = advantageRouter.stack.filter((l) => l.route).map((l) => l.route.path);
  const expected = [
    '/status',
    '/enabled',
    '/credentials',
    '/test-auth',
    '/force-relogin',
    '/run-now',
    '/runs',
    '/locations',
    '/locations/:id',
    '/locations/:id/toggle',
    '/pending-imports',
    '/pending-imports/:id/promote',
    '/pending-imports/:id/reject',
  ];
  for (const p of expected) {
    assert.ok(paths.includes(p), `missing route ${p}`);
  }
});

test('advantageRouter has an admin auth guard as its FIRST middleware layer', () => {
  const firstRouteIdx = advantageRouter.stack.findIndex((l) => l.route);
  const guardLayers = advantageRouter.stack.slice(0, firstRouteIdx).filter((l) => !l.route);
  assert.ok(guardLayers.length >= 1, 'expected auth/role guard middleware before routes');
});

test('advantageRouter exposes mutations as POST/PUT/DELETE and reads as GET', () => {
  const byPath = new Map();
  for (const l of advantageRouter.stack) {
    if (!l.route) continue;
    const methods = Object.keys(l.route.methods).filter((m) => l.route.methods[m]);
    byPath.set(l.route.path, [...(byPath.get(l.route.path) || []), ...methods]);
  }
  assert.ok(byPath.get('/status').includes('get'));
  assert.ok(byPath.get('/runs').includes('get'));
  assert.ok(byPath.get('/locations').includes('get'));
  assert.ok(byPath.get('/locations').includes('post'));
  assert.ok(byPath.get('/credentials').includes('post'));
  assert.ok(byPath.get('/test-auth').includes('post'));
  assert.ok(byPath.get('/force-relogin').includes('post'));
  assert.ok(byPath.get('/run-now').includes('post'));
  assert.ok(byPath.get('/enabled').includes('put'));
  assert.ok(byPath.get('/locations/:id').includes('put'));
  assert.ok(byPath.get('/locations/:id').includes('delete'));
});

// ---------------------------------------------------------------------------
// THE beta.301 REGRESSION: panel body ↔ route reader
// ---------------------------------------------------------------------------

test('location config body: the PANEL\'s builder feeds the ROUTES\' reader (beta.301)', () => {
  // Exactly what AdvantageIntegrationPanel's "Add location" form builds.
  const panelBody = buildAdvantageLocationBody({
    tsdNumber: '61302',
    branch: 'MCO',
    locationId: 'loc_zezgo_orl',
    enabled: true,
  });

  // Cross the wire the way the browser does — JSON in, JSON out.
  const overTheWire = JSON.parse(JSON.stringify(panelBody));
  const read = readLocationBody(overTheWire);

  // If the panel renamed a field (Flexways' externalSede→idSede bug), these land
  // as undefined and the route would answer 400 "tsdNumber is required".
  assert.equal(read.tsdNumber, '61302');
  assert.equal(read.branch, 'MCO');
  assert.equal(read.locationId, 'loc_zezgo_orl');
  assert.equal(read.enabled, true);
});

test('the panel sends NO field the routes do not read, and vice versa', () => {
  // Same list on both sides of the wire.
  assert.deepEqual(
    [...ADVANTAGE_LOCATION_BODY_FIELDS].sort(),
    [...LOCATION_BODY_FIELDS].sort()
  );

  // And a maximal body only ever contains declared keys.
  const body = buildAdvantageLocationBody({
    tsdNumber: '61302', branch: 'MCO', locationId: 'loc1',
    enabled: false, lookbackDays: 3, lookaheadDays: 45,
  });
  for (const key of Object.keys(body)) {
    assert.ok(LOCATION_BODY_FIELDS.includes(key), `panel sends undeclared field "${key}"`);
  }
  const read = readLocationBody(body);
  assert.equal(read.lookbackDays, 3);
  assert.equal(read.lookaheadDays, 45);
  assert.equal(read.enabled, false);
});

test('panel PATCH bodies (partial edits) round-trip as "leave the rest alone"', () => {
  // Editing only the Ride location in the grid must not blank the identity pair.
  const read = readLocationBody(buildAdvantageLocationBody({ locationId: 'loc2' }));
  assert.equal(read.locationId, 'loc2');
  assert.equal(read.tsdNumber, undefined);
  assert.equal(read.branch, undefined);
  assert.equal(read.enabled, undefined);
  assert.equal(read.lookbackDays, undefined);

  // Clearing an import-window override → explicit null (env fallback), NOT absent.
  const cleared = readLocationBody(buildAdvantageLocationBody({ lookbackDays: null }));
  assert.equal(cleared.lookbackDays, null);
});

test('branch is upper-cased on BOTH sides — a lowercase entry still matches the portal Loc', () => {
  // The grid parser upper-cases the `Loc` suffix, so a stored "mco" would never
  // match a fetched "MCO".
  assert.equal(buildAdvantageLocationBody({ branch: 'mco' }).branch, 'MCO');
  assert.equal(readLocationBody({ branch: ' mco ' }).branch, 'MCO');
  assert.equal(normalizeBranchInput('mco'), 'MCO');
});

// ---------------------------------------------------------------------------
// Body normalization
// ---------------------------------------------------------------------------

test('normalizeTsdNumberInput keeps the account as TEXT (zero-padding survives)', () => {
  assert.equal(normalizeTsdNumberInput(' 61302 '), '61302');
  assert.equal(normalizeTsdNumberInput('0061302'), '0061302'); // not coerced to 61302
  assert.equal(normalizeTsdNumberInput(''), null);
  assert.equal(normalizeTsdNumberInput(undefined), undefined);
});

test('readLocationBody rejects out-of-range windows with the NaN sentinel', () => {
  assert.ok(Number.isNaN(readLocationBody({ lookbackDays: -1 }).lookbackDays));
  assert.ok(Number.isNaN(readLocationBody({ lookaheadDays: 99999 }).lookaheadDays));
  assert.ok(Number.isNaN(readLocationBody({ lookbackDays: 'soon' }).lookbackDays));
  assert.equal(readLocationBody({ lookaheadDays: '30' }).lookaheadDays, 30);
});

test('readLocationBody tolerates a missing/!object body', () => {
  for (const b of [undefined, null, 'nope', 42]) {
    const read = readLocationBody(b);
    assert.equal(read.tsdNumber, undefined);
    assert.equal(read.locationId, undefined);
  }
});

// ---------------------------------------------------------------------------
// Live health (the panel's header pill derives from this)
// ---------------------------------------------------------------------------

test('computeHealth: no credential → unconfigured', () => {
  const h = computeHealth({ credential: null, lastRun: null });
  assert.equal(h.state, 'unconfigured');
});

test('computeHealth: credentials stored but never probed → untested (not healthy)', () => {
  const h = computeHealth({ credential: { lastTestStatus: null }, lastRun: null });
  assert.equal(h.state, 'untested');
});

test('computeHealth: a FAILING scheduled run beats a stale OK manual test (GD lesson)', () => {
  // The exact drift the Flexways review caught: green pill from an old manual
  // test while the 15-minute cron is failing.
  const h = computeHealth({
    credential: { lastTestStatus: 'OK', lastTestedAt: new Date('2026-07-01') },
    lastRun: { status: 'FAILED', startedAt: new Date('2026-07-16') },
  });
  assert.equal(h.state, 'failing');
  assert.equal(h.reasonKind, 'credentials rejected');
});

test('computeHealth: AUTH_EXPIRED is failing-but-self-healing, not "credentials rejected"', () => {
  const h = computeHealth({
    credential: { lastTestStatus: 'OK' },
    lastRun: { status: 'AUTH_EXPIRED', startedAt: new Date() },
  });
  assert.equal(h.state, 'failing');
  assert.equal(h.reasonKind, 'session expired');
  assert.match(h.reason, /re-logs in automatically/);
});

test('computeHealth: layout drift (ATTENTION) surfaces as its own reason', () => {
  const h = computeHealth({
    credential: { lastTestStatus: 'OK' },
    lastRun: { status: 'ATTENTION', startedAt: new Date() },
  });
  assert.equal(h.state, 'failing');
  assert.equal(h.reasonKind, 'report layout drift');
});

test('computeHealth: OK test + OK run → healthy, lastSuccessAt from the RUN', () => {
  const finishedAt = new Date('2026-07-16T12:00:00Z');
  const h = computeHealth({
    credential: { lastTestStatus: 'OK', lastTestedAt: new Date('2026-07-01') },
    lastRun: { status: 'OK', finishedAt },
  });
  assert.equal(h.state, 'healthy');
  assert.equal(h.lastSuccessAt, finishedAt);
});
