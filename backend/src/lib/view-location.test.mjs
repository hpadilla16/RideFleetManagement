/**
 * The location switcher's gate — DB-free.
 *
 * Hector, 2026-08-11: admins/agents with several locations pick which one
 * they are viewing, like a super admin picks a tenant. One chokepoint in
 * requireAuth; these tests are its contract.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { applyViewLocation } from './view-location.js';

const restricted = { role: 'AGENT', locationIds: ['loc-a', 'loc-b'] };
const unrestricted = { role: 'ADMIN', locationIds: null };

test('no header, no change — the feature is invisible until used', () => {
  for (const requested of [undefined, null, '', '   ']) {
    assert.deepEqual(applyViewLocation({ user: restricted, requested }), { ok: true, locationIds: undefined });
  }
});

test('a restricted user narrows WITHIN their set', () => {
  assert.deepEqual(applyViewLocation({ user: restricted, requested: 'loc-b' }), { ok: true, locationIds: ['loc-b'] });
});

test('a restricted user picking outside their set is REFUSED, not blanked', () => {
  // A scoped agent probing other branches should be told no — an empty page
  // invites retrying and hides that scoping did anything.
  const r = applyViewLocation({ user: restricted, requested: 'loc-elsewhere' });
  assert.equal(r.ok, false);
  assert.match(r.error, /do not have access/);
});

test('an unrestricted admin narrows to any id — the tenant AND makes foreign ids inert', () => {
  // No DB lookup needed: every downstream query still ANDs tenantId, so a
  // foreign location id can only produce empty results, never leakage.
  assert.deepEqual(applyViewLocation({ user: unrestricted, requested: 'loc-x' }), { ok: true, locationIds: ['loc-x'] });
});

test('SUPER_ADMIN narrows too — view-as composes with the tenant switcher', () => {
  assert.deepEqual(applyViewLocation({ user: { role: 'SUPER_ADMIN' }, requested: 'loc-x' }), { ok: true, locationIds: ['loc-x'] });
});

test('a service account ignores the header instead of failing', () => {
  // VozIA must never break because a proxy forwarded a browser header.
  assert.deepEqual(
    applyViewLocation({ user: { isServiceAccount: true, locationIds: null }, requested: 'loc-x' }),
    { ok: true, locationIds: undefined },
  );
});

test('the override can only SHRINK: one id in, one id out, always', () => {
  const out = applyViewLocation({ user: restricted, requested: 'loc-a' });
  assert.equal(out.locationIds.length, 1);
});
