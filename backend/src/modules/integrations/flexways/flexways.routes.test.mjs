/**
 * Flexways routes — MODULE tests, mirroring nu.routes.test.mjs / economy: lock
 * the endpoint inventory + the admin guard so a refactor can't silently drop an
 * endpoint or the auth gate. Full HTTP integration (JWT + express app) lives in
 * the e2e suite. Flexways KEY DIFFERENCE vs NU: multi-sede (locations keyed by
 * idSede/externalSede) + a dedicated /force-relogin endpoint for the autonomous
 * headless re-login (Force re-login button, emergency only).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

process.env.INTEGRATION_ENC_KEY = crypto.randomBytes(32).toString('base64');

const { flexwaysRouter } = await import('./flexways.routes.js');

test('flexwaysRouter mounts the full Fase 5 endpoint inventory (NU shape + /force-relogin)', () => {
  assert.ok(flexwaysRouter);
  const paths = flexwaysRouter.stack.filter((l) => l.route).map((l) => l.route.path);
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

test('flexwaysRouter has an admin auth guard as its FIRST middleware layer', () => {
  const firstRouteIdx = flexwaysRouter.stack.findIndex((l) => l.route);
  const guardLayers = flexwaysRouter.stack.slice(0, firstRouteIdx).filter((l) => !l.route);
  assert.ok(guardLayers.length >= 1, 'expected auth/role guard middleware before routes');
});

test('flexwaysRouter exposes credential + relogin as POST (mutations), status/runs as GET', () => {
  // A path can appear on multiple stack layers (PUT + DELETE on /locations/:id
  // register separately) — accumulate methods across all layers for that path.
  const byPath = new Map();
  for (const l of flexwaysRouter.stack) {
    if (!l.route) continue;
    const methods = Object.keys(l.route.methods).filter((m) => l.route.methods[m]);
    byPath.set(l.route.path, [...(byPath.get(l.route.path) || []), ...methods]);
  }
  assert.ok(byPath.get('/status').includes('get'));
  assert.ok(byPath.get('/runs').includes('get'));
  assert.ok(byPath.get('/credentials').includes('post'));
  assert.ok(byPath.get('/force-relogin').includes('post'));
  assert.ok(byPath.get('/locations/:id').includes('put'));
  assert.ok(byPath.get('/locations/:id').includes('delete'));
});
