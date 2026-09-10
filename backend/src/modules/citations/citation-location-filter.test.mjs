/**
 * Branch filter for the citations list (2026-09-10).
 *
 * Hector, seeing Corpusa's list: "separa los que son de LAX y los que son de
 * Orlando. No deberian estar viendo los de Orlando y LAX junto." Measured that
 * day: 175 Los Angeles citations (Long Beach, Beverly Hills, Pasadena)
 * interleaved with 80 Orlando ones, and 10 nobody could attribute.
 *
 * THE CASE THAT MUST NOT BREAK is the fifth one: a branch-restricted user typing
 * another branch's id must not read it. That guarantee does not come from this
 * module — it comes from `effectiveLocationIds`, which already owns the rule
 * that a `?locationId` the caller may not see is ignored rather than honoured.
 * The first draft of this feature hand-rolled a second clause and spread it
 * beside the permission scope; these tests exist because that is the version
 * that could have leaked.
 *
 * Pure: no client, no DB.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

const { citationLocationWhereFor, CITATION_LOCATION_UNMATCHED } =
  await import('./citations.service.js');

const ADMIN = { tenantId: 't1' };                                         // unrestricted
const LAX_ONLY = { tenantId: 't1', allowedLocationIds: ['loc-lax'] };     // one branch
const TWO = { tenantId: 't1', allowedLocationIds: ['loc-lax', 'loc-mco'] };

// ---------------------------------------------------------------------------
// The everyday behaviour
// ---------------------------------------------------------------------------
test('an admin who picks nothing still sees every branch — this IS the mixed list', () => {
  for (const v of ['', null, undefined, '   ']) {
    assert.deepEqual(citationLocationWhereFor({ locationId: v }, ADMIN), {});
  }
  assert.deepEqual(citationLocationWhereFor({}, ADMIN), {});
});

test('an admin picking a branch gets that branch, through the matched vehicle', () => {
  assert.deepEqual(
    citationLocationWhereFor({ locationId: 'loc-lax' }, ADMIN),
    { vehicle: { is: { homeLocationId: { in: ['loc-lax'] } } } },
  );
});

test('surrounding space does not defeat it', () => {
  assert.deepEqual(
    citationLocationWhereFor({ locationId: '  loc-lax  ' }, ADMIN),
    { vehicle: { is: { homeLocationId: { in: ['loc-lax'] } } } },
  );
});

test('a restricted user who picks nothing is still confined to their own branches', () => {
  assert.deepEqual(
    citationLocationWhereFor({}, TWO),
    { vehicle: { is: { homeLocationId: { in: ['loc-lax', 'loc-mco'] } } } },
  );
});

test('a restricted user narrowing to one of THEIR branches gets it', () => {
  assert.deepEqual(
    citationLocationWhereFor({ locationId: 'loc-mco' }, TWO),
    { vehicle: { is: { homeLocationId: { in: ['loc-mco'] } } } },
  );
});

// ---------------------------------------------------------------------------
// The security property
// ---------------------------------------------------------------------------
test('THE ONE THAT MATTERS: asking for a branch you may not see never widens the scope', () => {
  const out = citationLocationWhereFor({ locationId: 'loc-orlando' }, LAX_ONLY);
  assert.deepEqual(
    out,
    { vehicle: { is: { homeLocationId: { in: ['loc-lax'] } } } },
    'the request falls back to the caller\'s own branch — it is not honoured',
  );
  assert.equal(JSON.stringify(out).includes('loc-orlando'), false, 'and the asked-for id appears nowhere');
});

test('a made-up id is equally ignored for a restricted caller', () => {
  assert.deepEqual(
    citationLocationWhereFor({ locationId: 'not-a-real-location' }, LAX_ONLY),
    { vehicle: { is: { homeLocationId: { in: ['loc-lax'] } } } },
  );
});

// ---------------------------------------------------------------------------
// UNMATCHED — the citations nobody can attribute
// ---------------------------------------------------------------------------
test('UNMATCHED covers BOTH ways a citation loses its branch', () => {
  // The bug this pins, found against production: the picker counted a citation
  // as unattributable when its VEHICLE had no home branch, but the filter only
  // matched citations with no vehicle at all. Corpusa had 8 of the first shape
  // and 2 of the second, so the option said 10 and the view showed 8 — and two
  // Orlando citations were reachable from no view whatsoever.
  const out = citationLocationWhereFor({ locationId: CITATION_LOCATION_UNMATCHED }, ADMIN);
  assert.deepEqual(out, {
    OR: [{ vehicleId: null }, { vehicle: { is: { homeLocationId: null } } }],
  });
  assert.deepEqual(
    citationLocationWhereFor({ locationId: 'unmatched' }, ADMIN),
    out,
    'case-insensitive',
  );
});

test("the UNMATCHED clause matches the breakdown's own definition", () => {
  // locationBreakdown buckets by `vehicle?.homeLocationId || null`. Any filter
  // narrower than that leaves rows counted but unreachable, which is how the
  // two Orlando citations disappeared. Both arms must be present.
  const { OR } = citationLocationWhereFor({ locationId: 'UNMATCHED' }, ADMIN);
  assert.equal(OR.length, 2, 'a single-armed clause is the regression');
  assert.ok(OR.some((c) => c.vehicleId === null), 'no vehicle at all');
  assert.ok(OR.some((c) => c.vehicle?.is?.homeLocationId === null), 'vehicle without a home branch');
});

test('UNMATCHED stays fail-closed for a restricted caller', () => {
  // The OR and the scope's `vehicle` clause are different keys, so both survive
  // into the query and contradict: unattributable AND at my branch returns
  // nothing. Same answer the existing scope tests pin for unmatched rows, which
  // only a tenant admin triages.
  const out = citationLocationWhereFor({ locationId: 'UNMATCHED' }, LAX_ONLY);
  assert.ok(Array.isArray(out.OR));
  assert.deepEqual(out.vehicle, { is: { homeLocationId: { in: ['loc-lax'] } } },
    'the permission clause is still there');
});

test('never throws on junk', () => {
  for (const q of [null, undefined, {}, { locationId: 42 }, { locationId: {} }]) {
    assert.equal(typeof citationLocationWhereFor(q, ADMIN), 'object');
  }
});
