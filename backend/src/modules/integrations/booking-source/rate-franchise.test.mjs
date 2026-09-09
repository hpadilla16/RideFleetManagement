/**
 * Which franchise's prices an integration publishes (2026-09-09).
 *
 * Two rules carry this file. First, a writeback NEVER falls back to the default
 * brand the way an import does — a wrong brand on a reservation is cosmetic, a
 * wrong brand's price on a live portal is not. Second, "shared" (franchiseId
 * null) is what every rate in the system is today, so all of this must be inert
 * until somebody actually splits them.
 *
 * No DB: a fake franchise client returns whatever the case needs.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

const {
  resolvePushFranchiseId, selectRatesForFranchise, isFranchiseSpecific,
} = await import('./rate-franchise.js');

const db = (rows) => ({ franchise: { findMany: async () => rows } });

// Corpusa's real shape on the day this was written.
const CORPUSA = [
  { id: 'f-eco', code: 'ECONOMY', importSources: [] },
  { id: 'f-mex', code: 'MEX', importSources: [] },
  { id: 'f-zez', code: 'ZEZGO___RIGHT_CARS', importSources: ['TL_INTERNATIONAL'] },
  { id: 'f-corp', code: 'CORPUSA_GROUP_LLC', importSources: [] },
];

// ---------------------------------------------------------------------------
// resolvePushFranchiseId
// ---------------------------------------------------------------------------
test('the code convention covers Economy and MEX with no configuration', async () => {
  assert.equal(await resolvePushFranchiseId(db(CORPUSA), { tenantId: 't1', provider: 'MEX' }), 'f-mex');
  assert.equal(await resolvePushFranchiseId(db(CORPUSA), { tenantId: 't1', provider: 'ECONOMY' }), 'f-eco');
});

test('an explicit claim covers the brand whose code cannot equal the provider', async () => {
  assert.equal(
    await resolvePushFranchiseId(db(CORPUSA), { tenantId: 't1', provider: 'TL_INTERNATIONAL' }),
    'f-zez',
  );
});

test('an explicit claim BEATS a code match', async () => {
  const rows = [
    { id: 'f-mex', code: 'MEX', importSources: [] },
    { id: 'f-zez', code: 'ZEZGO', importSources: ['MEX'] },
  ];
  assert.equal(await resolvePushFranchiseId(db(rows), { tenantId: 't1', provider: 'MEX' }), 'f-zez');
});

test('NEVER falls back to the default brand — the difference from the import resolver', async () => {
  // resolveImportFranchiseId returns the default here, and should. Stamping a
  // reservation with the house brand is a guess a human fixes on the
  // reservation screen; publishing the house brand's PRICE on another
  // company's portal is a live shelf price nobody is watching.
  const rows = [
    { id: 'f-eco', code: 'ECONOMY', importSources: [] },
    { id: 'f-corp', code: 'CORPUSA_GROUP_LLC', importSources: [], isDefault: true },
  ];
  assert.equal(
    await resolvePushFranchiseId(db(rows), { tenantId: 't1', provider: 'FLEXWAYS' }), null,
    'unresolved must mean "publish only what is shared", never "publish the default brand"',
  );
});

test('REFUSES when two active franchises claim one provider', async () => {
  const rows = [
    { id: 'f-a', code: 'A', importSources: ['MEX'] },
    { id: 'f-b', code: 'B', importSources: ['MEX'] },
  ];
  assert.equal(await resolvePushFranchiseId(db(rows), { tenantId: 't1', provider: 'MEX' }), null);
});

test('REFUSES on two franchises sharing a code, and does not fall through', async () => {
  const rows = [
    { id: 'f-a', code: 'MEX', importSources: [] },
    { id: 'f-b', code: 'MEX', importSources: [] },
  ];
  assert.equal(await resolvePushFranchiseId(db(rows), { tenantId: 't1', provider: 'MEX' }), null);
});

test('matching ignores case and surrounding space', async () => {
  const rows = [{ id: 'f-1', code: ' mex ', importSources: [' tl_international '] }];
  assert.equal(await resolvePushFranchiseId(db(rows), { tenantId: 't1', provider: 'MEX' }), 'f-1');
  assert.equal(await resolvePushFranchiseId(db(rows), { tenantId: 't1', provider: 'tl_international' }), 'f-1');
});

test('a lookup failure and missing arguments are null, never a throw', async () => {
  const boom = { franchise: { findMany: async () => { throw new Error('pool timeout'); } } };
  assert.equal(await resolvePushFranchiseId(boom, { tenantId: 't1', provider: 'MEX' }), null);
  assert.equal(await resolvePushFranchiseId(null, { tenantId: 't1', provider: 'MEX' }), null);
  assert.equal(await resolvePushFranchiseId({}, { tenantId: 't1', provider: 'MEX' }), null);
  assert.equal(await resolvePushFranchiseId(db(CORPUSA), {}), null);
  assert.equal(await resolvePushFranchiseId(db(CORPUSA), { tenantId: 't1' }), null);
  assert.equal(await resolvePushFranchiseId(db([]), { tenantId: 't1', provider: 'MEX' }), null);
});

// ---------------------------------------------------------------------------
// selectRatesForFranchise — the inertness guarantee
// ---------------------------------------------------------------------------
const SHARED_A = { id: 'r1', franchiseId: null };
const SHARED_B = { id: 'r2', franchiseId: null };
const MEX_RATE = { id: 'r3', franchiseId: 'f-mex' };
const ZEZ_RATE = { id: 'r4', franchiseId: 'f-zez' };

test('INERT: with nothing split, every rate is shared and everyone sees all of them', () => {
  const all = [SHARED_A, SHARED_B];
  assert.deepEqual(selectRatesForFranchise(all, 'f-mex'), all);
  assert.deepEqual(selectRatesForFranchise(all, null), all);
});

test('a resolved franchise sees its own rates plus the shared ones', () => {
  const got = selectRatesForFranchise([SHARED_A, MEX_RATE, ZEZ_RATE], 'f-mex');
  assert.deepEqual(got.map((r) => r.id), ['r3', 'r1']);
  assert.equal(got.includes(ZEZ_RATE), false, "another brand's rate must never be published here");
});

test('an UNRESOLVED franchise sees shared rates only — never another brand\'s', () => {
  const got = selectRatesForFranchise([SHARED_A, MEX_RATE, ZEZ_RATE], null);
  assert.deepEqual(got.map((r) => r.id), ['r1']);
});

test('a brand with no rates of its own falls back to the shared ones', () => {
  assert.deepEqual(
    selectRatesForFranchise([SHARED_A, ZEZ_RATE], 'f-mex').map((r) => r.id),
    ['r1'],
  );
});

test('a sede split with NO shared rate publishes only the brand\'s own', () => {
  assert.deepEqual(
    selectRatesForFranchise([MEX_RATE, ZEZ_RATE], 'f-mex').map((r) => r.id),
    ['r3'],
  );
  // And the brand we cannot identify publishes nothing at all, rather than
  // picking one of the two at random.
  assert.deepEqual(selectRatesForFranchise([MEX_RATE, ZEZ_RATE], null), []);
});

test('selectRatesForFranchise never throws on junk', () => {
  assert.deepEqual(selectRatesForFranchise(null, 'f-mex'), []);
  assert.deepEqual(selectRatesForFranchise(undefined, null), []);
  assert.deepEqual(selectRatesForFranchise([null, undefined], null), []);
});

test('isFranchiseSpecific: shared is never specific, and null franchise never matches', () => {
  assert.equal(isFranchiseSpecific(MEX_RATE, 'f-mex'), true);
  assert.equal(isFranchiseSpecific(SHARED_A, 'f-mex'), false);
  assert.equal(isFranchiseSpecific(MEX_RATE, null), false);
  assert.equal(isFranchiseSpecific(SHARED_A, null), false);
  assert.equal(isFranchiseSpecific(null, 'f-mex'), false);
});
