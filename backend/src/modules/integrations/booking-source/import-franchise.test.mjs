/**
 * Which franchise brand an imported reservation belongs to (2026-09-08).
 *
 * The load-bearing case is the REFUSAL: when two active franchises claim the
 * same source there is no right answer, and stamping a rental with the wrong
 * company's name and logo is worse than leaving it unbranded for a human to
 * fix. Everything else here pins the cascade order.
 *
 * No DB: a fake `franchise.findMany` returns whatever the case needs.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

const { resolveImportFranchiseId } = await import('./import-franchise.js');
const { normalizeImportSources } = await import('../../settings/franchise.service.js');

const db = (rows) => ({ franchise: { findMany: async () => rows } });
const ARGS = { tenantId: 't1', sourceSystem: 'TL_INTERNATIONAL' };

// Corpusa's real shape on the day this was written.
const CORPUSA = [
  { id: 'f-eco', code: 'ECONOMY', name: 'Economy', importSources: [], isDefault: false },
  { id: 'f-mex', code: 'MEX', name: 'Mex', importSources: [], isDefault: false },
  { id: 'f-zez', code: 'ZEZGO___RIGHT_CARS', name: 'Zezgo | Right CArs', importSources: ['TL_INTERNATIONAL'], isDefault: false },
];

test('an explicit claim wins — the brand whose code cannot equal the source', async () => {
  assert.equal(await resolveImportFranchiseId(db(CORPUSA), ARGS), 'f-zez');
});

test('the code convention covers the common case with no configuration at all', async () => {
  assert.equal(await resolveImportFranchiseId(db(CORPUSA), { tenantId: 't1', sourceSystem: 'ECONOMY' }), 'f-eco');
  assert.equal(await resolveImportFranchiseId(db(CORPUSA), { tenantId: 't1', sourceSystem: 'MEX' }), 'f-mex');
});

test('an explicit claim BEATS a code match', async () => {
  // 'MEX' is claimed by the Zezgo brand and is also another franchise's code.
  const rows = [
    { id: 'f-mex', code: 'MEX', name: 'Mex', importSources: [], isDefault: false },
    { id: 'f-zez', code: 'ZEZGO', name: 'Zezgo', importSources: ['MEX'], isDefault: false },
  ];
  assert.equal(await resolveImportFranchiseId(db(rows), { tenantId: 't1', sourceSystem: 'MEX' }), 'f-zez');
});

test('matching ignores case and surrounding space on both sides', async () => {
  const rows = [{ id: 'f-1', code: ' economy ', name: 'E', importSources: [' tl_international '], isDefault: false }];
  assert.equal(await resolveImportFranchiseId(db(rows), { tenantId: 't1', sourceSystem: 'TL_INTERNATIONAL' }), 'f-1');
  assert.equal(await resolveImportFranchiseId(db(rows), { tenantId: 't1', sourceSystem: 'economy' }), 'f-1');
});

test('REFUSES when two franchises claim one source — unbranded beats wrongly branded', async () => {
  const rows = [
    { id: 'f-a', code: 'A', name: 'A', importSources: ['ECONOMY'], isDefault: false },
    { id: 'f-b', code: 'B', name: 'B', importSources: ['ECONOMY'], isDefault: false },
    { id: 'f-d', code: 'D', name: 'D', importSources: [], isDefault: true },
  ];
  assert.equal(
    await resolveImportFranchiseId(db(rows), { tenantId: 't1', sourceSystem: 'ECONOMY' }), null,
    'and it must NOT quietly fall through to the default either — the config is wrong and must stay visible',
  );
});

test('REFUSES on two franchises sharing a code, for the same reason', async () => {
  const rows = [
    { id: 'f-a', code: 'ECONOMY', name: 'A', importSources: [], isDefault: false },
    { id: 'f-b', code: 'ECONOMY', name: 'B', importSources: [], isDefault: false },
  ];
  assert.equal(await resolveImportFranchiseId(db(rows), { tenantId: 't1', sourceSystem: 'ECONOMY' }), null);
});

test('falls back to the tenant default — the CorpUSA case', async () => {
  const rows = [
    { id: 'f-eco', code: 'ECONOMY', name: 'Economy', importSources: [], isDefault: false },
    { id: 'f-corp', code: 'CORPUSA', name: 'CorpUSA', importSources: [], isDefault: true },
  ];
  assert.equal(await resolveImportFranchiseId(db(rows), { tenantId: 't1', sourceSystem: 'FLEXWAYS' }), 'f-corp');
});

test('no default and no match is null, not an error — the behaviour before this existed', async () => {
  assert.equal(await resolveImportFranchiseId(db(CORPUSA), { tenantId: 't1', sourceSystem: 'FLEXWAYS' }), null);
  assert.equal(await resolveImportFranchiseId(db([]), ARGS), null);
});

test('inactive franchises are never considered — the filter is asked of the DB', async () => {
  let seen = null;
  const spy = { franchise: { findMany: async (args) => { seen = args; return []; } } };
  await resolveImportFranchiseId(spy, ARGS);
  assert.equal(seen.where.isActive, true);
  assert.equal(seen.where.tenantId, 't1');
});

test('a lookup failure leaves the reservation unbranded instead of failing the import', async () => {
  const boom = { franchise: { findMany: async () => { throw new Error('pool timeout'); } } };
  assert.equal(await resolveImportFranchiseId(boom, ARGS), null);
});

test('missing arguments never throw', async () => {
  assert.equal(await resolveImportFranchiseId(db(CORPUSA), {}), null);
  assert.equal(await resolveImportFranchiseId(db(CORPUSA), { tenantId: 't1' }), null);
  assert.equal(await resolveImportFranchiseId(null, ARGS), null);
  assert.equal(await resolveImportFranchiseId({}, ARGS), null);
});

test('normalizeImportSources: upper-cases, trims, de-duplicates, accepts a CSV string', () => {
  assert.deepEqual(normalizeImportSources([' economy ', 'MEX', 'economy']), ['ECONOMY', 'MEX']);
  assert.deepEqual(normalizeImportSources('tl_international, mex'), ['TL_INTERNATIONAL', 'MEX']);
  assert.deepEqual(normalizeImportSources(null), []);
  assert.deepEqual(normalizeImportSources([]), []);
  assert.deepEqual(normalizeImportSources(['', '  ']), []);
});
