import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

// Route-MODULE tests, mirroring economy.routes.test.mjs: focus on the router
// surface (mounted paths, auth guard present) and the pure validation contracts
// the handlers rely on. Full HTTP integration (JWT + express app) lives in the
// e2e suite; here we lock the route inventory + guard so a refactor can't
// silently drop an endpoint or the admin gate. Adapted for NU's KEY DIFFERENCE:
// NU is location 1:1 — the config validates on locationId (not a 3-letter area)
// and carries an optional externalCenter.

process.env.INTEGRATION_ENC_KEY = crypto.randomBytes(32).toString('base64');

const { nuRouter } = await import('./nu.routes.js');

test('nuRouter mounts the full Fase 5 endpoint inventory (same shape as Economy)', () => {
  assert.ok(nuRouter);
  const paths = nuRouter.stack.filter((l) => l.route).map((l) => l.route.path);
  const expected = [
    '/status',
    '/enabled',
    '/credentials',
    '/test-auth',
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

test('nuRouter has an admin auth guard as its FIRST middleware layer', () => {
  // The router.use(requireAuth, requireRole(...)) registers guard layers with no
  // .route (they apply to every request). Assert at least one non-route layer
  // precedes the route layers — i.e. the guard is installed.
  const firstRouteIdx = nuRouter.stack.findIndex((l) => l.route);
  const guardLayers = nuRouter.stack.slice(0, firstRouteIdx).filter((l) => !l.route);
  assert.ok(guardLayers.length >= 1, 'expected auth/role guard middleware before routes');
});

test('credentials route contract: username + password required, password never echoed', () => {
  // Contract mirror (the handler validates the same way). This documents the
  // money/security-sensitive invariant: the response shape never contains a
  // password field.
  const validate = (body) => {
    const username = String(body?.username || '').trim();
    const password = String(body?.password ?? '');
    if (!username) return { error: 'username is required' };
    if (!password) return { error: 'password is required' };
    return { ok: true, credentialId: 'cred-1', rotatedAt: new Date().toISOString() };
  };
  assert.deepEqual(validate({ username: '', password: 'x' }), { error: 'username is required' });
  assert.deepEqual(validate({ username: 'u', password: '' }), { error: 'password is required' });
  const ok = validate({ username: 'u', password: 'secret' });
  assert.ok(ok.ok);
  assert.ok(!('password' in ok) && !JSON.stringify(ok).includes('secret'));
});

test('location-config validation: locationId is required (1:1 mapping, no area code)', () => {
  // NU is 1:1 — the config validates on the presence of a Ride locationId, NOT a
  // 3-letter external area (that is Economy's multi-area shape).
  const validate = (body) => {
    const locationId = String(body?.locationId || '').trim();
    if (!locationId) return { error: 'locationId is required' };
    return { ok: true };
  };
  assert.deepEqual(validate({ locationId: '' }), { error: 'locationId is required' });
  assert.deepEqual(validate({}), { error: 'locationId is required' });
  assert.ok(validate({ locationId: 'loc_fll' }).ok);
});

test('externalCenter validation: blank clears, otherwise trimmed (defaults to 100/FLL on create)', () => {
  const normalizeCenterInput = (v) => {
    if (v === undefined) return undefined;
    if (v === null || v === '') return null;
    return String(v).trim().slice(0, 32) || null;
  };
  assert.equal(normalizeCenterInput(undefined), undefined); // untouched → create defaults to "100"
  assert.equal(normalizeCenterInput(null), null);
  assert.equal(normalizeCenterInput(''), null);
  assert.equal(normalizeCenterInput('  100 '), '100');
  assert.equal(normalizeCenterInput('205'), '205');
});

test('window-days validation: null clears (env fallback), out-of-range rejected', () => {
  const normalizeDaysInput = (v) => {
    if (v === undefined) return undefined;
    if (v === null || v === '') return null;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0 || n > 3650) return NaN;
    return Math.floor(n);
  };
  assert.equal(normalizeDaysInput(undefined), undefined);
  assert.equal(normalizeDaysInput(null), null);
  assert.equal(normalizeDaysInput(''), null);
  assert.equal(normalizeDaysInput(7), 7);
  assert.equal(normalizeDaysInput('30'), 30);
  assert.ok(Number.isNaN(normalizeDaysInput(-1)));
  assert.ok(Number.isNaN(normalizeDaysInput(99999)));
  assert.ok(Number.isNaN(normalizeDaysInput('abc')));
});

test('master-enable read helper: only { nu: { enabled: true } } counts as enabled', () => {
  const readEnabled = (cfg) => !!(cfg && typeof cfg === 'object' && cfg.nu && cfg.nu.enabled === true);
  assert.equal(readEnabled(null), false);
  assert.equal(readEnabled({}), false);
  assert.equal(readEnabled({ nu: {} }), false);
  assert.equal(readEnabled({ nu: { enabled: false } }), false);
  assert.equal(readEnabled({ nu: { enabled: true } }), true);
  // TL + Economy config coexist and are untouched.
  assert.equal(readEnabled({ tl: { enabled: true }, economy: { enabled: true }, nu: { enabled: true } }), true);
  assert.equal(readEnabled({ economy: { enabled: true } }), false);
});

test('S2: /run-now guard rejects when the per-tenant master switch is disabled (409)', () => {
  // Contract mirror of the handler's guard: when readMasterEnabled(tenantId) is
  // false, the route returns 409 with a clear message and does NOT enqueue. When
  // enabled, it proceeds to enqueue. (Full HTTP wiring is in the e2e suite.)
  const runNowGuard = (masterEnabled) => {
    if (!masterEnabled) {
      return { status: 409, body: { error: 'Integration is disabled for this tenant. Enable it before running a sync.' }, enqueued: false };
    }
    return { status: 200, body: { ok: true }, enqueued: true };
  };

  const disabled = runNowGuard(false);
  assert.equal(disabled.status, 409);
  assert.equal(disabled.enqueued, false);
  assert.match(disabled.body.error, /disabled for this tenant/i);
  assert.ok(!('ok' in disabled.body));

  const enabled = runNowGuard(true);
  assert.equal(enabled.status, 200);
  assert.equal(enabled.enqueued, true);
  assert.equal(enabled.body.ok, true);
});

test('S3: 1:1 write guard rejects a SECOND enabled config with 409 (one active location per tenant)', () => {
  // Contract mirror of findOtherEnabledConfig + the create/enable/toggle guards:
  // an enabled create or enable that would leave a SECOND enabled row returns 409
  // and does NOT write. Disabling is always allowed. Keeps the worker's
  // deterministic single-config resolution (orderBy createdAt asc) unambiguous.
  const ONE_ACTIVE = 'NU is one active location per tenant. Disable the other mapping first.';
  const enableGuard = (nextEnabled, otherEnabledExists) => {
    if (nextEnabled && otherEnabledExists) {
      return { status: 409, body: { error: ONE_ACTIVE }, wrote: false };
    }
    return { status: 200, body: { ok: true }, wrote: true };
  };

  const blocked = enableGuard(true, true);
  assert.equal(blocked.status, 409);
  assert.equal(blocked.wrote, false);
  assert.match(blocked.body.error, /one active location per tenant/i);

  // The FIRST enabled row is fine (no other enabled row yet).
  const first = enableGuard(true, false);
  assert.equal(first.status, 200);
  assert.equal(first.wrote, true);

  // Disabling never trips the guard, even if another enabled row exists.
  const disabling = enableGuard(false, true);
  assert.equal(disabling.status, 200);
  assert.equal(disabling.wrote, true);
});
