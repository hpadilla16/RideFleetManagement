// Staff 2FA policy (2026-08-22): global-vs-tenant override, requiredRoles,
// grace expiry, and the enforcement kill-switch. Pure logic + resolveTwoFactorPolicy
// against a fake prisma (deps.prisma injection).
import './_two-factor-test-env.mjs'; // MUST be first — sets env before prisma.js constructs

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveTwoFactorPolicy,
  requiresTwoFactor,
  isEnforcementKilled,
  isGraceWindowOpen,
  normalizePolicy
} from './two-factor-policy.js';

function fakePrismaWithSettings(map) {
  return {
    appSetting: {
      async findUnique({ where }) {
        const value = map[where.key];
        return value === undefined ? null : { key: where.key, value: JSON.stringify(value) };
      }
    }
  };
}

test('no policy anywhere resolves to disabled (zero-behavior-change default)', async () => {
  const db = fakePrismaWithSettings({});
  const policy = await resolveTwoFactorPolicy('t1', { prisma: db });
  assert.equal(policy.enabled, false);
  assert.deepEqual(policy.requiredRoles, []);
});

test('global default applies when there is no tenant override', async () => {
  const db = fakePrismaWithSettings({
    twoFactorPolicy: { enabled: true, requiredRoles: ['ADMIN'], graceUntil: null }
  });
  const policy = await resolveTwoFactorPolicy('t1', { prisma: db });
  assert.equal(policy.enabled, true);
  assert.deepEqual(policy.requiredRoles, ['ADMIN']);
});

test('tenant override wins over the global default', async () => {
  const db = fakePrismaWithSettings({
    twoFactorPolicy: { enabled: true, requiredRoles: ['ADMIN', 'OPS', 'AGENT'], graceUntil: null },
    'tenant:t1:twoFactorPolicy': { enabled: false, requiredRoles: [], graceUntil: null }
  });
  const policy = await resolveTwoFactorPolicy('t1', { prisma: db });
  assert.equal(policy.enabled, false, 'tenant override disables despite global enable');
});

test('tenant override can ENABLE where the global default is unset', async () => {
  const db = fakePrismaWithSettings({
    'tenant:t1:twoFactorPolicy': { enabled: true, requiredRoles: ['OPS'], graceUntil: null }
  });
  const globalUser = await resolveTwoFactorPolicy('t2', { prisma: db });
  assert.equal(globalUser.enabled, false, 'a different tenant sees no policy');
  const scoped = await resolveTwoFactorPolicy('t1', { prisma: db });
  assert.equal(scoped.enabled, true);
  assert.deepEqual(scoped.requiredRoles, ['OPS']);
});

test('normalizePolicy drops unknown roles and coerces types', () => {
  const p = normalizePolicy({ enabled: 1, requiredRoles: ['admin', 'GHOST', 'ops'], graceUntil: 'not-a-date' });
  assert.equal(p.enabled, true);
  assert.deepEqual(p.requiredRoles, ['ADMIN', 'OPS']);
  assert.equal(p.graceUntil, null);
});

test('requiresTwoFactor: enabled + role in requiredRoles', () => {
  const policy = { enabled: true, requiredRoles: ['ADMIN'], graceUntil: null };
  assert.equal(requiresTwoFactor({ role: 'ADMIN' }, policy), true);
  assert.equal(requiresTwoFactor({ role: 'AGENT' }, policy), false, 'role not required');
});

test('requiresTwoFactor is false when the policy is disabled, even if role listed', () => {
  const policy = { enabled: false, requiredRoles: ['ADMIN'], graceUntil: null };
  assert.equal(requiresTwoFactor({ role: 'ADMIN' }, policy), false);
});

test('requiresTwoFactor is false when requiredRoles is empty', () => {
  const policy = { enabled: true, requiredRoles: [], graceUntil: null };
  assert.equal(requiresTwoFactor({ role: 'ADMIN' }, policy), false);
});

test('grace window: future date open, past date closed, absent = open', () => {
  const future = new Date(Date.now() + 60_000).toISOString();
  const past = new Date(Date.now() - 60_000).toISOString();
  assert.equal(isGraceWindowOpen({ enabled: true, requiredRoles: ['ADMIN'], graceUntil: future }), true);
  assert.equal(isGraceWindowOpen({ enabled: true, requiredRoles: ['ADMIN'], graceUntil: past }), false);
  assert.equal(isGraceWindowOpen({ enabled: true, requiredRoles: ['ADMIN'], graceUntil: null }), true);
});

test('grace expiry does NOT lift the requirement (must still enroll)', () => {
  const past = new Date(Date.now() - 60_000).toISOString();
  const policy = { enabled: true, requiredRoles: ['ADMIN'], graceUntil: past };
  // requiresTwoFactor ignores grace: an expired window still compels enrollment.
  assert.equal(requiresTwoFactor({ role: 'ADMIN' }, policy), true);
  assert.equal(isGraceWindowOpen(policy), false);
});

test('kill-switch reads the env var at call time', () => {
  const original = process.env.TWO_FACTOR_ENFORCEMENT_DISABLED;
  try {
    delete process.env.TWO_FACTOR_ENFORCEMENT_DISABLED;
    assert.equal(isEnforcementKilled(), false);
    process.env.TWO_FACTOR_ENFORCEMENT_DISABLED = 'true';
    assert.equal(isEnforcementKilled(), true);
    process.env.TWO_FACTOR_ENFORCEMENT_DISABLED = '1';
    assert.equal(isEnforcementKilled(), true);
    process.env.TWO_FACTOR_ENFORCEMENT_DISABLED = 'false';
    assert.equal(isEnforcementKilled(), false);
  } finally {
    if (original === undefined) delete process.env.TWO_FACTOR_ENFORCEMENT_DISABLED;
    else process.env.TWO_FACTOR_ENFORCEMENT_DISABLED = original;
  }
});
