/**
 * Shuttle list + delay-notice decisions — DB-FREE, so CI actually runs them.
 *
 * The integration suite (shuttle-requests.test.mjs) needs embedded postgres
 * and does not run in CI's DB-free step; these are the rules that decide who
 * sees whose customers, so they get a home where they are guarded on every
 * push.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildListQuery,
  scopeWhere,
  buildDelayNotice,
  appendNotice,
  markNoticeFailed,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
} from './shuttle-query.js';

const TENANT = 't1';
const KEN = 'loc-ken';
const PON = 'loc-pon';
const NOW = new Date('2026-08-07T18:30:00.000Z');

test('scopeWhere: tenant always, locations only when restricted', () => {
  assert.deepEqual(scopeWhere({ tenantId: TENANT }), { tenantId: TENANT });
  assert.deepEqual(scopeWhere({ tenantId: TENANT, allowedLocationIds: [] }), { tenantId: TENANT });
  assert.deepEqual(scopeWhere({ tenantId: TENANT, allowedLocationIds: [KEN] }), {
    tenantId: TENANT, locationId: { in: [KEN] },
  });
});

test('the LIVE queue is never date-windowed — an open request from yesterday is still a person at a curb', () => {
  const q = buildListQuery({ tenantId: TENANT }, { status: 'open', now: NOW });
  assert.equal(q.isLiveQueue, true);
  assert.equal(q.where.createdAt, undefined, 'windowing the live queue would drop customers off the banner');
  assert.deepEqual(q.where.status, { in: ['READY', 'VIEWED'] });
  assert.deepEqual(q.orderBy, [{ createdAt: 'asc' }], 'oldest first: longest wait on top');
});

test('history defaults to TODAY and sorts newest first', () => {
  const q = buildListQuery({ tenantId: TENANT }, { status: 'all', now: NOW });
  assert.equal(q.isLiveQueue, false);
  assert.equal(q.where.status, undefined, '"all" means all statuses');
  assert.equal(q.where.createdAt.gte.toISOString(), '2026-08-07T00:00:00.000Z');
  assert.equal(q.where.createdAt.lt.toISOString(), '2026-08-08T00:00:00.000Z');
  assert.deepEqual(q.orderBy, [{ createdAt: 'desc' }]);
});

test('an explicit window is inclusive of the `to` day', () => {
  const q = buildListQuery({ tenantId: TENANT }, { status: 'COMPLETED', from: '2026-08-01', to: '2026-08-03', now: NOW });
  assert.equal(q.where.status, 'COMPLETED');
  assert.equal(q.where.createdAt.gte.toISOString(), '2026-08-01T00:00:00.000Z');
  assert.equal(q.where.createdAt.lt.toISOString(), '2026-08-04T00:00:00.000Z', 'Aug 3 must be included, not excluded');
});

test('locationId INTERSECTS the caller scope — it can never widen it', () => {
  const scoped = { tenantId: TENANT, allowedLocationIds: [KEN] };
  const own = buildListQuery(scoped, { status: 'all', locationId: KEN, now: NOW });
  assert.equal(own.where.locationId, KEN);

  // The whole point: a Mayagüez agent typing Ponce's id gets NOTHING.
  const foreign = buildListQuery(scoped, { status: 'all', locationId: PON, now: NOW });
  assert.deepEqual(foreign.where.locationId, { in: [] }, 'an impossible filter, not another sede queue');

  // An unscoped user may narrow freely.
  const admin = buildListQuery({ tenantId: TENANT }, { status: 'all', locationId: PON, now: NOW });
  assert.equal(admin.where.locationId, PON);
});

test('pagination is bounded and 1-indexed', () => {
  const d = buildListQuery({ tenantId: TENANT }, { status: 'all', now: NOW });
  assert.equal(d.take, DEFAULT_PAGE_SIZE);
  assert.equal(d.skip, 0);
  assert.equal(d.page, 1);

  const p3 = buildListQuery({ tenantId: TENANT }, { status: 'all', limit: 20, page: 3, now: NOW });
  assert.equal(p3.take, 20);
  assert.equal(p3.skip, 40);

  // Junk cannot produce a giant scan or a negative skip.
  assert.equal(buildListQuery({ tenantId: TENANT }, { status: 'all', limit: 99999, now: NOW }).take, MAX_PAGE_SIZE);
  assert.equal(buildListQuery({ tenantId: TENANT }, { status: 'all', limit: 0, page: -5, now: NOW }).skip, 0);
  assert.equal(buildListQuery({ tenantId: TENANT }, { status: 'all', limit: 'abc', now: NOW }).take, DEFAULT_PAGE_SIZE);
});

test('buildDelayNotice normalizes what the agent typed', () => {
  const n = buildDelayNotice({ reason: '  traffic  ', etaMinutes: '15', to: 'a@b.test', userId: 'u1', now: NOW });
  assert.deepEqual(n, {
    at: '2026-08-07T18:30:00.000Z', byUserId: 'u1', reason: 'traffic',
    etaMinutes: 15, to: 'a@b.test', status: 'SENT',
  });
  // Empty / nonsense ETA is absent, never zero or NaN in the email.
  for (const bad of ['', 'soon', 0, -5, null]) {
    assert.equal(buildDelayNotice({ etaMinutes: bad, to: 'a@b.test', now: NOW }).etaMinutes, null, String(bad));
  }
  assert.equal(buildDelayNotice({ reason: '   ', to: 'a@b.test', now: NOW }).reason, null);
});

test('appendNotice keeps history and survives garbage', () => {
  const first = buildDelayNotice({ to: 'a@b.test', now: NOW });
  const second = buildDelayNotice({ to: 'a@b.test', now: new Date('2026-08-07T19:00:00Z') });
  assert.equal(appendNotice(null, first).length, 1);
  assert.equal(appendNotice(JSON.stringify([first]), second).length, 2, 'a second notice appends, never replaces');
  // Unreadable log must not block the notice the customer is waiting on.
  assert.deepEqual(appendNotice('not json', first), [first]);
  assert.deepEqual(appendNotice('{"nope":1}', first), [first]);
});

test('markNoticeFailed downgrades the right entry only', () => {
  const a = buildDelayNotice({ to: 'a@b.test', now: NOW });
  const b = buildDelayNotice({ to: 'other@b.test', now: new Date('2026-08-07T19:00:00Z') });
  const list = markNoticeFailed(JSON.stringify([a, b]), b, new Error('provider said no'));
  assert.equal(list[0].status, 'SENT', 'the earlier successful notice is untouched');
  assert.equal(list[1].status, 'FAILED');
  assert.match(list[1].error, /provider said no/);

  // A notice that is not in the log leaves everything alone rather than throwing.
  const untouched = markNoticeFailed(JSON.stringify([a]), b, new Error('x'));
  assert.equal(untouched.length, 1);
  assert.equal(untouched[0].status, 'SENT');
});
