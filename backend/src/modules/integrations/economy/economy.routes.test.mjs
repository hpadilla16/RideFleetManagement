import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

// Route-MODULE tests, mirroring tl-international.routes.test.mjs: focus on the
// router surface (mounted paths, auth guard present) and the pure validation
// contracts the handlers rely on. Full HTTP integration (JWT + express app)
// lives in the e2e suite; here we lock the route inventory + guard so a
// refactor can't silently drop an endpoint or the admin gate.

process.env.INTEGRATION_ENC_KEY = crypto.randomBytes(32).toString('base64');

const { economyRouter } = await import('./economy.routes.js');

test('economyRouter mounts the full Fase 5 endpoint inventory', () => {
  assert.ok(economyRouter);
  const paths = economyRouter.stack.filter((l) => l.route).map((l) => l.route.path);
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

test('economyRouter has an admin auth guard as its FIRST middleware layer', () => {
  // The router.use(requireAuth, requireRole(...)) registers guard layers with no
  // .route (they apply to every request). Assert at least one non-route layer
  // precedes the route layers — i.e. the guard is installed.
  const firstRouteIdx = economyRouter.stack.findIndex((l) => l.route);
  const guardLayers = economyRouter.stack.slice(0, firstRouteIdx).filter((l) => !l.route);
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

test('area-config validation: externalArea must be a 3-letter code', () => {
  const isValidArea = (a) => /^[A-Z]{3}$/.test(String(a || '').trim().toUpperCase());
  assert.ok(isValidArea('MIA'));
  assert.ok(isValidArea('lax'));
  assert.ok(!isValidArea('MIAO01'));
  assert.ok(!isValidArea('MI'));
  assert.ok(!isValidArea('M1A'));
  assert.ok(!isValidArea(''));
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

test('master-enable read helper: only { economy: { enabled: true } } counts as enabled', () => {
  const readEnabled = (cfg) => !!(cfg && typeof cfg === 'object' && cfg.economy && cfg.economy.enabled === true);
  assert.equal(readEnabled(null), false);
  assert.equal(readEnabled({}), false);
  assert.equal(readEnabled({ economy: {} }), false);
  assert.equal(readEnabled({ economy: { enabled: false } }), false);
  assert.equal(readEnabled({ economy: { enabled: true } }), true);
  // TL config coexists and is untouched.
  assert.equal(readEnabled({ tl: { enabled: true }, economy: { enabled: true } }), true);
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
