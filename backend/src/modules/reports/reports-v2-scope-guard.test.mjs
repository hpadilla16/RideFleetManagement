/**
 * Unit tests for the reports-v2 scope guard. No DB.
 *
 * WHY THIS EXISTS: the Reports v2 module computes from a bare `tenantId` and
 * serves out of a tenant-keyed cache — it never sees programScope or
 * allowedLocationIds. `rejectScopedUsers` is therefore not a nicety, it is the
 * whole isolation story for 16 reports: without it a location-restricted user
 * gets whole-tenant numbers AND poisons the shared cache entry for everyone
 * else. It had no test at all.
 *
 * The LOCATION branch is the one this file was added for (2026-07-24) — the
 * program branch is covered incidentally because both must keep working.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

// The routes module transitively imports lib/prisma.js, which CONSTRUCTS a
// PrismaClient at import time and throws without a DATABASE_URL. Nothing here
// touches the DB — the guard is pure — so a syntactically valid dummy URL is
// enough. Set before the dynamic import so it is in place when the chain loads;
// this keeps the test runnable with a bare `node --test`, no env prefix in the
// npm script and no shell-specific syntax (the repo's `TZ=UTC ...` prefixes do
// not work in PowerShell).
process.env.DATABASE_URL ||= 'postgresql://unused:unused@127.0.0.1:1/unused';
const { rejectScopedUsers } = await import('./reports-v2.routes.js');

// Minimal express double: records what the handler did.
function runGuard(user) {
  const calls = { status: null, json: null, nextCalled: false };
  const res = {
    status(code) { calls.status = code; return this; },
    json(body) { calls.json = body; return this; },
  };
  rejectScopedUsers({ user }, res, () => { calls.nextCalled = true; });
  return calls;
}

test('LOCATION branch: a user with locationIds is refused with 403, never served', () => {
  const out = runGuard({ role: 'OPS', tenantId: 'T1', locationIds: ['LOC-A'] });
  assert.equal(out.nextCalled, false, 'the request must NOT reach the report');
  assert.equal(out.status, 403);
  assert.match(out.json.error, /location-restricted/i);
});

test('LOCATION branch: an ADMIN WITH locationIds is a location admin — also refused', () => {
  // The 2026-07-23 rule change: ADMIN no longer bypasses location scoping when
  // it has explicit locationIds. If this guard used a role check instead of
  // userAllowedLocationIds, a branch admin would silently get tenant-wide
  // reports — the exact bug that change fixed elsewhere.
  const out = runGuard({ role: 'ADMIN', tenantId: 'T1', locationIds: ['LOC-A'] });
  assert.equal(out.nextCalled, false);
  assert.equal(out.status, 403);
  assert.match(out.json.error, /location-restricted/i);
});

test('LOCATION branch: an ordinary tenant ADMIN (no locationIds) passes through', () => {
  // The no-regression half. An admin with no location assignment is the
  // ordinary tenant-wide admin and must keep full access.
  const out = runGuard({ role: 'ADMIN', tenantId: 'T1', locationIds: [] });
  assert.equal(out.nextCalled, true);
  assert.equal(out.status, null);
});

test('LOCATION branch: falsy location ids do not trip the guard', () => {
  // `[null]` must read as "unrestricted", matching scopeAllowedLocationIds.
  // If this ever 403s, a user with a half-written locationIds array loses
  // reports entirely with a message that tells them nothing.
  const out = runGuard({ role: 'OPS', tenantId: 'T1', locationIds: [null, ''] });
  assert.equal(out.nextCalled, true);
});

test('SUPER_ADMIN is cross-tenant and never location-restricted', () => {
  const out = runGuard({ role: 'SUPER_ADMIN', locationIds: ['LOC-A'] });
  assert.equal(out.nextCalled, true);
});

test('PROGRAM branch still refuses a program-restricted user', () => {
  const out = runGuard({ role: 'OPS', tenantId: 'T1', programScope: 'RENTAL_ONLY' });
  assert.equal(out.nextCalled, false);
  assert.equal(out.status, 403);
  assert.match(out.json.error, /program-restricted/i);
});

test('an unrestricted user passes both branches', () => {
  const out = runGuard({ role: 'OPS', tenantId: 'T1', programScope: 'BOTH' });
  assert.equal(out.nextCalled, true);
  assert.equal(out.status, null);
});
