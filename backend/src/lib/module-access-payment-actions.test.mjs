/**
 * paymentActions module-access tests (2026-07-25).
 * Run via: npm run test:payment-actions
 *
 * paymentActions gates the routes that make the SYSTEM move money at the
 * gateway, destroy a payment record, or store a reusable card. Recording a
 * payment already taken on the external POS terminal is deliberately NOT gated.
 *
 * Two traps these tests pin down:
 *
 *  1. FAIL-OPEN ROLE MAPS. getEditableModuleAccessForUser reads the role map as
 *     `roleAllowed[key] !== false`, so a key MISSING from a map resolves to
 *     TRUE. hostRoleModuleMap is a literal object, so forgetting to list
 *     paymentActions there would silently hand the capability to every host.
 *
 *  2. SELF-LOCKOUT. For every other module the tenant switch turns it off for
 *     everyone. Applied literally here, one checkbox would leave the whole
 *     company unable to release a customer's deposit hold. ADMIN is therefore
 *     immune to the tenant switch for this key (SUPER_ADMIN already is, via the
 *     early return in getEffectiveModuleAccessForUser).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from './prisma.js';
import { requireCapability, requireModuleAccess } from '../middleware/auth.js';
import {
  MODULE_KEYS,
  MODULE_LABELS,
  roleAllowedModuleMap,
  defaultTenantModuleConfig,
  getEffectiveModuleAccessForUser,
  getEditableModuleAccessForUser
} from './module-access.js';

const TENANT = {
  id: 't1',
  carSharingEnabled: false,
  dealershipLoanerEnabled: false,
  tollsEnabled: false,
  marketIntelligenceEnabled: false
};

/** Stub the two AppSetting reads: tenant config and per-user override. */
function stub({ tenantConfig = null, userConfig = null } = {}) {
  prisma.tenant.findUnique = async () => TENANT;
  prisma.appSetting.findUnique = async ({ where }) => {
    const key = String(where?.key || '');
    if (key.startsWith('user:')) {
      return userConfig === null ? null : { value: JSON.stringify(userConfig) };
    }
    return tenantConfig === null ? null : { value: JSON.stringify(tenantConfig) };
  };
}

const user = (role, extra = {}) => ({ id: 'u1', tenantId: 't1', role, ...extra });

test('paymentActions is a registered module with a label', () => {
  assert.ok(MODULE_KEYS.includes('paymentActions'));
  assert.equal(MODULE_LABELS.paymentActions, 'Payment Actions');
});

test('tenant default is ON', () => {
  assert.equal(defaultTenantModuleConfig({}).paymentActions, true);
});

test('role defaults: ADMIN/OPS on, AGENT and unknown roles off', () => {
  assert.equal(roleAllowedModuleMap('SUPER_ADMIN').paymentActions, true);
  assert.equal(roleAllowedModuleMap('ADMIN').paymentActions, true);
  assert.equal(roleAllowedModuleMap('OPS').paymentActions, true);
  assert.equal(roleAllowedModuleMap('AGENT').paymentActions, false);
  assert.equal(roleAllowedModuleMap('SOMETHING_NEW').paymentActions, false);
});

test('hosts are OFF — and the key is listed EXPLICITLY, not inherited', () => {
  // A missing key would read as `undefined !== false` === true downstream.
  const hostMap = roleAllowedModuleMap({ role: 'AGENT', hostProfileId: 'h1' });
  assert.ok(
    Object.prototype.hasOwnProperty.call(hostMap, 'paymentActions'),
    'hostRoleModuleMap must list paymentActions explicitly (fail-open trap)'
  );
  assert.equal(hostMap.paymentActions, false);
});

test('STRUCTURAL: every role map contains every MODULE_KEY as a boolean', () => {
  // Generic guard, not paymentActions-specific. roleAllowed[key] !== false means
  // a MISSING key silently GRANTS the module. This asserts no role map can ever
  // fail open again, including for modules added long after this test.
  const roles = ['SUPER_ADMIN', 'ADMIN', 'OPS', 'AGENT', 'UNKNOWN_ROLE'];
  for (const role of roles) {
    const map = roleAllowedModuleMap(role);
    const missing = MODULE_KEYS.filter(
      (k) => !Object.prototype.hasOwnProperty.call(map, k) || typeof map[k] !== 'boolean'
    );
    assert.deepEqual(missing, [], `role ${role} is missing MODULE_KEY(s): ${missing.join(', ')}`);
  }
  const hostMap = roleAllowedModuleMap({ role: 'AGENT', hostProfileId: 'h1' });
  const hostMissing = MODULE_KEYS.filter(
    (k) => !Object.prototype.hasOwnProperty.call(hostMap, k) || typeof hostMap[k] !== 'boolean'
  );
  assert.deepEqual(hostMissing, [], `host map is missing MODULE_KEY(s): ${hostMissing.join(', ')}`);
});

test('STRUCTURAL: the tenant default map covers every MODULE_KEY', () => {
  const defaults = defaultTenantModuleConfig({});
  const missing = MODULE_KEYS.filter(
    (k) => !Object.prototype.hasOwnProperty.call(defaults, k) || typeof defaults[k] !== 'boolean'
  );
  assert.deepEqual(missing, [], `tenant defaults missing MODULE_KEY(s): ${missing.join(', ')}`);
});

test('effective access follows the role when nothing is overridden', async () => {
  stub();
  assert.equal((await getEffectiveModuleAccessForUser(user('ADMIN'))).effective.paymentActions, true);
  assert.equal((await getEffectiveModuleAccessForUser(user('OPS'))).effective.paymentActions, true);
  assert.equal((await getEffectiveModuleAccessForUser(user('AGENT'))).effective.paymentActions, false);
});

test('SUPER_ADMIN is always on, even with everything switched off', async () => {
  stub({ tenantConfig: { paymentActions: false }, userConfig: { paymentActions: false } });
  const out = await getEffectiveModuleAccessForUser(user('SUPER_ADMIN'));
  assert.equal(out.effective.paymentActions, true);
});

test('per-person override opens it for one agent without opening it for all', async () => {
  stub({ userConfig: { paymentActions: true } });
  const opened = await getEffectiveModuleAccessForUser(user('AGENT'));
  assert.equal(opened.effective.paymentActions, true, 'this is the "open it for a specific agent" case');

  stub({ userConfig: null });
  const other = await getEffectiveModuleAccessForUser(user('AGENT'));
  assert.equal(other.effective.paymentActions, false, 'other agents are unaffected');
});

test('per-person override can also REMOVE it from one admin', async () => {
  stub({ userConfig: { paymentActions: false } });
  const out = await getEffectiveModuleAccessForUser(user('ADMIN'));
  assert.equal(out.effective.paymentActions, false);
});

test('ANTI-SELF-LOCKOUT: tenant switch OFF cannot strip ADMIN', async () => {
  stub({ tenantConfig: { paymentActions: false } });
  const admin = await getEffectiveModuleAccessForUser(user('ADMIN'));
  assert.equal(
    admin.effective.paymentActions,
    true,
    'turning the tenant switch off must never leave the company unable to release a deposit'
  );
});

test('ANTI-SELF-LOCKOUT holds on the EDITABLE path too (what People renders)', async () => {
  // settings.service.js returns getEditableModuleAccessForUser().config to the
  // People screen. If only the effective path had the carve-out, People would
  // show an admin's box UNCHECKED while the admin actually had access.
  stub({ tenantConfig: { paymentActions: false } });
  const editable = await getEditableModuleAccessForUser(user('ADMIN'));
  assert.equal(
    editable.config.paymentActions,
    true,
    'People must render the same value the gate enforces'
  );
});

test('REGRESSION: a routine People save cannot silently lock an admin out', async () => {
  // The defeat path: tenant switch OFF -> People renders the admin unchecked ->
  // savePerson PUTs the whole map back -> paymentActions:false persists as an
  // EXPLICIT override -> hasUserOverride becomes true -> the carve-out stops
  // applying -> admin locked out, recoverable only by a SUPER_ADMIN. Editing a
  // phone number would have been enough.
  stub({ tenantConfig: { paymentActions: false } });

  // 1. What People renders today for this admin:
  const rendered = (await getEditableModuleAccessForUser(user('ADMIN'))).config;
  assert.equal(rendered.paymentActions, true, 'rendered checked');

  // 2. savePerson round-trips exactly what was rendered.
  stub({ tenantConfig: { paymentActions: false }, userConfig: rendered });

  // 3. The admin still has it — the round trip persisted `true`, not `false`.
  const after = await getEffectiveModuleAccessForUser(user('ADMIN'));
  assert.equal(after.effective.paymentActions, true, 'a routine save must not revoke it');
});

test('tenant switch OFF still removes it from OPS and agents', async () => {
  stub({ tenantConfig: { paymentActions: false } });
  assert.equal((await getEffectiveModuleAccessForUser(user('OPS'))).effective.paymentActions, false);
  assert.equal((await getEffectiveModuleAccessForUser(user('AGENT'))).effective.paymentActions, false);
});

test('tenant switch OFF beats a per-person grant for a non-admin', async () => {
  stub({ tenantConfig: { paymentActions: false }, userConfig: { paymentActions: true } });
  const out = await getEffectiveModuleAccessForUser(user('AGENT'));
  assert.equal(out.effective.paymentActions, false, 'tenant config is still the ceiling below admin');
});

test('a stored tenant config predating this module leaves it ON', async () => {
  // normalizeBooleanMap treats a MISSING key as true. For paymentActions that
  // is the behavior we want (tenant default ON) — pinned so a future change to
  // that helper cannot silently flip every tenant off.
  stub({ tenantConfig: { dashboard: true, reservations: true } });
  const out = await getEffectiveModuleAccessForUser(user('OPS'));
  assert.equal(out.effective.paymentActions, true);
});

test('a stored USER config predating this module does not grant it to an agent', async () => {
  // normalizeUserModuleConfig only copies keys present in the stored blob, so
  // an old blob leaves no override and the role default (false) wins.
  stub({ userConfig: { dashboard: true, reservations: true } });
  const out = await getEffectiveModuleAccessForUser(user('AGENT'));
  assert.equal(out.effective.paymentActions, false);
});

// ── requireCapability — the middleware that ACTUALLY enforces all of the above ─
//
// Everything above tests the module MAPS. The maps decide what a session's
// moduleAccess blob contains; `requireCapability` in middleware/auth.js is the
// single function that turns that blob into a 403. Until these tests existed it
// had NO direct coverage: money-route-gate.test.mjs asserts only that the
// STRING "requireCapability('paymentActions')" appears on the route
// registrations, which stays green no matter what the middleware does.
//
// The property under test is FAIL-CLOSED — an ABSENT key must DENY. That is the
// entire reason a second gate was written instead of reusing
// requireModuleAccess (which denies only on an explicit `false`, so a missing
// key PERMITS). "Simplifying" the predicate back to `=== false` restores the
// fail-open behavior silently; the `undefined` case below is the assertion that
// makes that edit fail.

/** Minimal express double: records the status/body, and whether next() ran. */
function runGate(middleware, req) {
  const out = { status: null, body: null, nextCalled: false };
  const res = {
    status(code) {
      out.status = code;
      return res;
    },
    json(payload) {
      out.body = payload;
      return res;
    }
  };
  middleware(req, res, () => {
    out.nextCalled = true;
  });
  return out;
}

const gate = requireCapability('paymentActions');

test('requireCapability — 401 when there is no authenticated user', () => {
  const out = runGate(gate, {});
  assert.equal(out.status, 401);
  assert.deepEqual(out.body, { error: 'Unauthorized' });
  assert.equal(out.nextCalled, false, 'must not fall through to the handler');
});

test('requireCapability — SUPER_ADMIN bypasses the gate entirely', () => {
  // Even with the capability explicitly switched off: SUPER_ADMIN is the
  // recovery path if an admin locks the tenant out of its own deposit releases.
  const out = runGate(gate, { user: { role: 'SUPER_ADMIN', moduleAccess: { paymentActions: false } } });
  assert.equal(out.nextCalled, true);
  assert.equal(out.status, null, 'no response written — the request continues');
});

test('requireCapability — DENIES when the key is UNDEFINED (fail-closed)', () => {
  // ★ THE POINT OF THE WHOLE MIDDLEWARE ★
  // A session whose moduleAccess blob simply does not carry the key must be
  // denied. Flipping the predicate to `=== false` (the requireModuleAccess
  // form) makes this case PERMIT — a silent fail-open on the routes that charge
  // and refund cards. This assertion is what breaks when someone does that.
  const out = runGate(gate, { user: { role: 'AGENT', moduleAccess: { reservations: true } } });
  assert.equal(out.status, 403, 'an ABSENT capability key must DENY, not permit');
  assert.equal(out.nextCalled, false);
});

test('requireCapability — DENIES when moduleAccess itself is missing', () => {
  // A session minted by a parallel workstream (employee mobile app, a service
  // account, a future token path) that never populates moduleAccess must not
  // inherit the capability by omission.
  assert.equal(runGate(gate, { user: { role: 'AGENT' } }).status, 403);
  assert.equal(runGate(gate, { user: { role: 'AGENT', moduleAccess: null } }).status, 403);
  assert.equal(runGate(gate, { user: { role: 'AGENT' } }).nextCalled, false);
});

test('requireCapability — DENIES on an explicit false', () => {
  const out = runGate(gate, { user: { role: 'ADMIN', moduleAccess: { paymentActions: false } } });
  assert.equal(out.status, 403);
  assert.equal(out.nextCalled, false);
});

test('requireCapability — PERMITS only on a literal true', () => {
  const out = runGate(gate, { user: { role: 'AGENT', moduleAccess: { paymentActions: true } } });
  assert.equal(out.nextCalled, true);
  assert.equal(out.status, null);
});

test('requireCapability — a TRUTHY non-boolean is not enough', () => {
  // Pins the strict `!== true`. A stored blob that somehow holds "true" (string)
  // or 1 is corrupt data, not a grant; a loosened truthy check would let it
  // through. Cheap to assert, and it fails the moment `!== true` becomes a
  // truthiness test.
  for (const value of ['true', 1, 'yes', {}]) {
    const out = runGate(gate, { user: { role: 'AGENT', moduleAccess: { paymentActions: value } } });
    assert.equal(out.status, 403, `moduleAccess.paymentActions = ${JSON.stringify(value)} must deny`);
    assert.equal(out.nextCalled, false);
  }
});

test('requireCapability — the 403 body is the human label, never the raw key', () => {
  const out = runGate(gate, { user: { role: 'AGENT', moduleAccess: { paymentActions: false } } });
  assert.match(out.body.error, /^Payment Actions is turned off for your account\./);
  assert.doesNotMatch(out.body.error, /paymentActions/, 'the raw key must not reach the user-facing banner');
  assert.match(out.body.error, /card terminal/, 'the hint tells the agent what they CAN still do');
});

test('requireCapability is STRICTLY STRONGER than requireModuleAccess', () => {
  // The contrast that justifies having two gates. If someone ever "unifies"
  // them, one of these two lines stops holding.
  const absentKey = { user: { role: 'AGENT', moduleAccess: { reservations: true } } };
  assert.equal(
    runGate(requireModuleAccess('paymentActions'), absentKey).nextCalled,
    true,
    'the nav gate PERMITS a missing key — this is why it must not guard money'
  );
  assert.equal(
    runGate(requireCapability('paymentActions'), absentKey).nextCalled,
    false,
    'the capability gate DENIES the same session'
  );
});
