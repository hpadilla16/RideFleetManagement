/**
 * Anti-drift guard: the People create form's role defaults vs. the backend's
 * roleAllowedModuleMap (2026-07-25).
 * Run via: npm run test:module-defaults-drift
 *
 * THE BUG THIS EXISTS TO PREVENT
 * ------------------------------
 * frontend/src/app/people/page.js pre-fills the module checkboxes for a NEW
 * person from a role map that was hand-copied from this directory's
 * module-access.js. The copy rotted: quotes, maintenance, tolls, citations,
 * kiosk and marketIntelligence were all added to the backend and never added to
 * the frontend copy. A key missing from the frontend map rendered CHECKED (the
 * checkbox read `!== false`) and savePerson PUTs the whole map back — so simply
 * CREATING a person wrote an explicit `true` override for every one of those
 * modules, including for a HOST whose backend role map denies them. The
 * per-user override then beats the role default in
 * getEditableModuleAccessForUser, so the wrong grant stuck permanently.
 *
 * Only the CREATE path was affected; editing loads the effective config from
 * the API, which always contains every key.
 *
 * Two fixes were applied: the frontend default is now derived from the module
 * registry (everything false, opt in by name) and the checkbox renders
 * `=== true` so an incomplete map fails CLOSED. This test pins the third leg —
 * that the two role maps still agree, key for key. Without it the lists rot
 * again the next time a module is added.
 *
 * WHY A BACKEND TEST IMPORTS A FRONTEND FILE
 * ------------------------------------------
 * This is the only place both halves can be loaded in one process.
 * frontend/src/lib/moduleAccess.js is deliberately dependency-free plain ESM,
 * and CI checks out the whole repo before running the backend suites. The
 * backend half cannot be imported from vitest instead, because module-access.js
 * pulls in prisma and the cache. Keep moduleAccess.js free of `next/*` and
 * React imports or this guard stops loading.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { MODULE_KEYS, roleAllowedModuleMap } from './module-access.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND_MODULE_ACCESS = path.resolve(HERE, '../../../frontend/src/lib/moduleAccess.js');

const { MODULE_DEFINITIONS, buildDefaultUserModuleAccess } = await import(
  pathToFileURL(FRONTEND_MODULE_ACCESS).href
);

/** The backend role map, reduced to the same shape the frontend produces. */
const backendDefaults = (roleOrUser) => {
  const map = roleAllowedModuleMap(roleOrUser);
  return Object.fromEntries(MODULE_KEYS.map((key) => [key, map[key] !== false]));
};

/** How People builds the map: HOST is a personType, the rest are roles. */
const CASES = [
  { label: 'HOST', frontend: () => buildDefaultUserModuleAccess('HOST', 'AGENT'), backend: () => backendDefaults({ role: 'AGENT', hostProfileId: 'h1' }) },
  { label: 'ADMIN', frontend: () => buildDefaultUserModuleAccess('ADMIN', 'ADMIN'), backend: () => backendDefaults('ADMIN') },
  { label: 'OPS', frontend: () => buildDefaultUserModuleAccess('EMPLOYEE', 'OPS'), backend: () => backendDefaults('OPS') },
  { label: 'AGENT', frontend: () => buildDefaultUserModuleAccess('EMPLOYEE', 'AGENT'), backend: () => backendDefaults('AGENT') }
];

test('the two module registries hold the same keys', () => {
  const frontendKeys = MODULE_DEFINITIONS.map((item) => item.key);
  assert.deepEqual(
    [...frontendKeys].sort(),
    [...MODULE_KEYS].sort(),
    'MODULE_DEFINITIONS (frontend) and MODULE_KEYS (backend) have diverged — a module was added to one and not the other'
  );
});

test('every role default covers every module key explicitly', () => {
  // The original defect in one assertion: a MISSING key is what rendered as an
  // unintended grant, so absence is the failure, not just a wrong value.
  for (const { label, frontend } of CASES) {
    const map = frontend();
    const missing = MODULE_KEYS.filter(
      (key) => !Object.prototype.hasOwnProperty.call(map, key) || typeof map[key] !== 'boolean'
    );
    assert.deepEqual(missing, [], `${label} default is missing module key(s): ${missing.join(', ')}`);
  }
});

test('frontend create-form defaults match the backend role map, key for key', () => {
  for (const { label, frontend, backend } of CASES) {
    const fe = frontend();
    const be = backend();
    const disagreements = MODULE_KEYS.filter((key) => fe[key] !== be[key]).map(
      (key) => `${key}: frontend=${fe[key]} backend=${be[key]}`
    );
    assert.deepEqual(
      disagreements,
      [],
      `${label} defaults drifted from roleAllowedModuleMap —\n  ${disagreements.join('\n  ')}\n` +
        'Update ROLE_DEFAULT_MODULES in frontend/src/lib/moduleAccess.js (the backend is the authority).'
    );
  }
});

test('HOST gets dashboard and hostApp and nothing else', () => {
  // Called out separately because a host is an outside partner: an accidental
  // grant here exposes tenant data to someone who is not staff at all.
  const map = buildDefaultUserModuleAccess('HOST', 'AGENT');
  const granted = MODULE_KEYS.filter((key) => map[key]).sort();
  assert.deepEqual(granted, ['dashboard', 'hostApp']);
});

test('the modules that rotted are all denied where the backend denies them', () => {
  // Regression list, named explicitly so the failure message says what broke.
  // These are the six keys that were missing from all four literals.
  const ROTTED = ['quotes', 'maintenance', 'tolls', 'citations', 'kiosk', 'marketIntelligence'];
  for (const key of ROTTED) {
    assert.ok(MODULE_KEYS.includes(key), `${key} is no longer a module — update this test`);
  }

  const host = buildDefaultUserModuleAccess('HOST', 'AGENT');
  for (const key of ROTTED) {
    assert.equal(host[key], false, `HOST must not receive ${key} by default`);
  }

  const agent = buildDefaultUserModuleAccess('EMPLOYEE', 'AGENT');
  assert.equal(agent.tolls, false, 'AGENT must not receive tolls by default');
  assert.equal(agent.kiosk, false, 'AGENT must not receive kiosk by default');
});

test('tenants is never granted from the People screen', () => {
  for (const { label, frontend } of CASES) {
    assert.equal(frontend().tenants, false, `${label} must never be granted tenants here`);
  }
});

test('an unknown role falls back to the agent default, not to everything', () => {
  const unknown = buildDefaultUserModuleAccess('EMPLOYEE', 'SOMETHING_NEW');
  assert.deepEqual(unknown, buildDefaultUserModuleAccess('EMPLOYEE', 'AGENT'));
  assert.equal(unknown.paymentActions, false);
  assert.equal(unknown.settings, false);
});
