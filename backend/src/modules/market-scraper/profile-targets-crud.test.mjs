/**
 * CRUD for a profile's per-brand targets (2026-09-09).
 *
 * A target points at a Rate whose prices go live on a partner's portal, so the
 * cases that matter are the refusals: an id from another tenant, a second house
 * target the unique index cannot catch, and a target with no rate at all.
 *
 * No DB.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

const {
  listProfileTargets, createProfileTarget, updateProfileTarget, deleteProfileTarget,
  locationsForProfile, STRATEGIES,
} = await import('./profile-targets.crud.js');

const PROFILE = {
  id: 'p1', tenantId: 't1', name: 'LAX 1-14 Daily', locationCode: 'LAX',
  targetRateId: null, autoApply: false,
  strategy: 'CHEAPEST_MINUS_AMOUNT', strategyAmount: 1, strategyPct: null, strategyFloor: null,
};

function fakeDb({
  profile = PROFILE, targets = [], rates = [{ id: 'rate-mex', tenantId: 't1' }],
  franchises = [{ id: 'f-mex', tenantId: 't1', code: 'MEX', name: 'Mex' }],
  locations = [{ id: 'loc-lax', code: 'LAXA01', name: 'Los Angeles' }],
  existingTarget = null, capture = {},
} = {}) {
  return {
    capture,
    marketScrapeProfile: { findFirst: async ({ where }) => (
      (!where.tenantId || where.tenantId === profile?.tenantId) && where.id === profile?.id ? profile : null) },
    marketScrapeProfileTarget: {
      findMany: async () => targets,
      findFirst: async ({ where }) => (where.id ? existingTarget : (existingTarget || null)),
      create: async (args) => { capture.create = args; return { id: 'new', ...args.data }; },
      update: async (args) => { capture.update = args; return { id: args.where.id, ...args.data }; },
      delete: async (args) => { capture.delete = args; return {}; },
    },
    franchise: { findMany: async () => franchises, findFirst: async ({ where }) => franchises.find((f) => f.id === where.id && f.tenantId === where.tenantId) || null },
    rate: { findMany: async () => rates, findFirst: async ({ where }) => rates.find((r) => r.id === where.id && r.tenantId === where.tenantId) || null },
    location: { findMany: async () => locations },
  };
}
const SCOPE = { tenantId: 't1' };

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------
test('the panel is told what the engine would ACTUALLY do, legacy included', async () => {
  const db = fakeDb({ profile: { ...PROFILE, targetRateId: 'rate-house' } });
  const out = await listProfileTargets('p1', { scope: SCOPE, prisma: db });
  assert.equal(out.targets.length, 0, 'no rows configured');
  assert.equal(out.effective.length, 1, 'but the engine still writes the profile rate');
  assert.equal(out.effective[0].legacy, true);
  assert.deepEqual(out.strategies, STRATEGIES);
});

test('the Rate picker offers the sede behind the AIRPORT code', async () => {
  // Profile says LAX, the sede is LAXA01. They are usually equal, which is why
  // the difference stayed invisible until LAX.
  const db = fakeDb();
  const locs = await locationsForProfile(db, PROFILE);
  assert.deepEqual(locs.map((l) => l.code), ['LAXA01']);
});

test('a sede whose code is unrelated is not offered', async () => {
  const db = fakeDb({ locations: [{ id: 'l2', code: 'MIA', name: 'Miami' }] });
  assert.deepEqual(await locationsForProfile(db, PROFILE), []);
  assert.deepEqual(await locationsForProfile(db, { ...PROFILE, locationCode: '' }), []);
});

test('another tenant\'s profile is a 404, not an empty list', async () => {
  const db = fakeDb();
  await assert.rejects(
    () => listProfileTargets('p1', { scope: { tenantId: 'other' }, prisma: db }),
    (e) => e.httpStatus === 404,
  );
});

// ---------------------------------------------------------------------------
// Creating — the refusals are the point
// ---------------------------------------------------------------------------
test('a target with no rate is refused — it would write nowhere', async () => {
  const db = fakeDb();
  await assert.rejects(
    () => createProfileTarget('p1', { franchiseId: 'f-mex' }, { scope: SCOPE, prisma: db }),
    /rateId is required/,
  );
});

test("a rate from ANOTHER tenant is refused", async () => {
  const db = fakeDb({ rates: [{ id: 'rate-mex', tenantId: 'someone-else' }] });
  await assert.rejects(
    () => createProfileTarget('p1', { rateId: 'rate-mex' }, { scope: SCOPE, prisma: db }),
    /does not belong to this tenant/,
  );
});

test('a franchise from another tenant is refused', async () => {
  const db = fakeDb({ franchises: [{ id: 'f-mex', tenantId: 'someone-else', code: 'MEX', name: 'Mex' }] });
  await assert.rejects(
    () => createProfileTarget('p1', { rateId: 'rate-mex', franchiseId: 'f-mex' }, { scope: SCOPE, prisma: db }),
    /does not belong to this tenant/,
  );
});

test('a SECOND house target is refused — Postgres cannot catch it', async () => {
  const db = fakeDb({ existingTarget: { id: 'existing' } });
  await assert.rejects(
    () => createProfileTarget('p1', { rateId: 'rate-mex' }, { scope: SCOPE, prisma: db }),
    /house target/,
  );
});

test('a valid target is created with the franchise normalized to null', async () => {
  const db = fakeDb();
  await createProfileTarget('p1', { rateId: 'rate-mex' }, { scope: SCOPE, prisma: db });
  assert.equal(db.capture.create.data.franchiseId, null);
  assert.equal(db.capture.create.data.rateId, 'rate-mex');
  assert.equal(db.capture.create.data.profileId, 'p1');
});

test('an unknown strategy is refused, a known one is kept', async () => {
  const db = fakeDb();
  await assert.rejects(
    () => createProfileTarget('p1', { rateId: 'rate-mex', strategy: 'VIBES' }, { scope: SCOPE, prisma: db }),
    /Unknown strategy/,
  );
  await createProfileTarget('p1', { rateId: 'rate-mex', strategy: 'MATCH_CHEAPEST' }, { scope: SCOPE, prisma: db });
  assert.equal(db.capture.create.data.strategy, 'MATCH_CHEAPEST');
});

test('BLANK means inherit, ZERO means zero — they are not the same', async () => {
  const db = fakeDb();
  await createProfileTarget('p1', { rateId: 'rate-mex', strategyAmount: '' }, { scope: SCOPE, prisma: db });
  assert.equal(db.capture.create.data.strategyAmount, null, 'blank inherits the profile amount');

  await createProfileTarget('p1', { rateId: 'rate-mex', strategyAmount: 0 }, { scope: SCOPE, prisma: db });
  assert.equal(db.capture.create.data.strategyAmount, 0, 'an explicit zero is a real instruction');
});

test('a negative or non-numeric amount is refused', async () => {
  const db = fakeDb();
  for (const bad of [-1, 'abc']) {
    await assert.rejects(
      () => createProfileTarget('p1', { rateId: 'rate-mex', strategyAmount: bad }, { scope: SCOPE, prisma: db }),
      /strategyAmount/,
    );
  }
});

// ---------------------------------------------------------------------------
// Updating and deleting
// ---------------------------------------------------------------------------
test('the rate cannot be cleared — that would be a silent no-op target', async () => {
  const db = fakeDb({ existingTarget: { id: 'tg1', profileId: 'p1', franchiseId: 'f-mex' } });
  await assert.rejects(
    () => updateProfileTarget('tg1', { rateId: '' }, { scope: SCOPE, prisma: db }),
    /delete the target instead/,
  );
});

test('editing a target without moving its franchise does not trip the uniqueness check', async () => {
  const db = fakeDb({ existingTarget: { id: 'tg1', profileId: 'p1', franchiseId: 'f-mex' } });
  await updateProfileTarget('tg1', { autoApply: true }, { scope: SCOPE, prisma: db });
  assert.equal(db.capture.update.data.autoApply, true);
});

test('a missing target is a 404 on update, and a silent no-op on delete', async () => {
  const db = fakeDb({ existingTarget: null });
  await assert.rejects(
    () => updateProfileTarget('nope', { autoApply: true }, { scope: SCOPE, prisma: db }),
    (e) => e.httpStatus === 404,
  );
  assert.deepEqual(await deleteProfileTarget('nope', { scope: SCOPE, prisma: db }), { ok: true, deleted: 0 });
});

test('deleting checks the tenant before it deletes', async () => {
  const db = fakeDb({ existingTarget: { id: 'tg1', profileId: 'p1' } });
  await assert.rejects(
    () => deleteProfileTarget('tg1', { scope: { tenantId: 'other' }, prisma: db }),
    (e) => e.httpStatus === 404,
  );
  assert.equal(db.capture.delete, undefined, 'nothing was deleted for the wrong tenant');
});
