/**
 * Contract preview (2026-09-09).
 *
 * The load-bearing case is the one `lib/terms/index.js` warns about in its own
 * error path: a branch with no override and a branch whose lookup FAILED render
 * byte-identical HTML — the tenant's terms — and "that is a wrong legal
 * document with no signal anywhere". So the tests that matter are the ones
 * pinning WHICH layer the preview says won, not the HTML.
 *
 * No DB.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

const { previewTerms, listTermsCoverage, TERMS_SOURCES } = await import('./terms-preview.service.js');

const LOC = { id: 'l1', code: 'LAXA01', name: 'Los Angeles' };
const SCOPE = { tenantId: 't1' };

function db({ location = null, tenant = { name: 'Corpusa', termsHtml: null }, locations = [] } = {}) {
  return {
    location: {
      findFirst: async ({ where }) => (location && where.id === location.id && where.tenantId === 't1' ? location : null),
      findUnique: async ({ where }) => (location && where.id === location.id ? location : null),
      findMany: async () => locations,
    },
    tenant: { findUnique: async () => tenant },
  };
}

test('a branch with its own contract is reported as the branch', async () => {
  const out = await previewTerms(SCOPE, {
    locationId: 'l1',
    prisma: db({ location: { ...LOC, termsHtml: '<h1>LAX</h1>', termsRiderHtml: '' } }),
  });
  assert.equal(out.source, TERMS_SOURCES.LOCATION);
  assert.match(out.sourceLabel, /LAXA01/);
  assert.equal(out.location.code, 'LAXA01');
});

test('a branch with NO contract falls to the tenant, and SAYS so', async () => {
  // This is the case that is invisible in the HTML.
  const out = await previewTerms(SCOPE, {
    locationId: 'l1',
    prisma: db({
      location: { ...LOC, termsHtml: null, termsRiderHtml: null },
      tenant: { name: 'Corpusa', termsHtml: '<h1>Corpusa</h1>' },
    }),
  });
  assert.equal(out.source, TERMS_SOURCES.TENANT);
  assert.match(out.sourceLabel, /has none of its own/);
});

test('neither branch nor tenant: the built-in document, named with its version', async () => {
  const out = await previewTerms(SCOPE, {
    locationId: 'l1',
    prisma: db({ location: { ...LOC, termsHtml: null, termsRiderHtml: null } }),
  });
  assert.equal(out.source, TERMS_SOURCES.CANONICAL);
  assert.match(out.sourceLabel, new RegExp(out.tcVersion));
  assert.ok(out.html.length > 0, 'the canonical document still renders');
});

test('whitespace is not a contract', async () => {
  // A branch field holding only spaces would otherwise read as an override and
  // print a blank agreement.
  const out = await previewTerms(SCOPE, {
    locationId: 'l1',
    prisma: db({
      location: { ...LOC, termsHtml: '   \n  ', termsRiderHtml: '  ' },
      tenant: { name: 'Corpusa', termsHtml: '<h1>Corpusa</h1>' },
    }),
  });
  assert.equal(out.source, TERMS_SOURCES.TENANT);
  assert.equal(out.hasRider, false);
});

test('the rider is reported separately from the base', async () => {
  const out = await previewTerms(SCOPE, {
    locationId: 'l1',
    prisma: db({ location: { ...LOC, termsHtml: '<h1>LAX</h1>', termsRiderHtml: '<h2>19. LOCAL</h2>' } }),
  });
  assert.equal(out.hasRider, true);
  assert.ok(out.lengths.locationRider > 0);
});

test('the template is UNSIGNED — every initials marker renders blank', async () => {
  const out = await previewTerms(SCOPE, { locationId: 'l1', prisma: db({ location: { ...LOC } }) });
  for (const key of out.initialsMarkers) {
    assert.equal(out.html.includes(`{{${key}}}`), false, `${key} must not survive as a raw marker`);
  }
});

test('no location at all resolves at tenant level', async () => {
  const out = await previewTerms(SCOPE, {
    prisma: db({ tenant: { name: 'Corpusa', termsHtml: '<h1>Corpusa</h1>' } }),
  });
  assert.equal(out.source, TERMS_SOURCES.TENANT);
  assert.equal(out.location, null);
});

test("another tenant's location is a 404, not somebody else's contract", async () => {
  await assert.rejects(
    () => previewTerms({ tenantId: 'other' }, { locationId: 'l1', prisma: db({ location: { ...LOC } }) }),
    (e) => e.httpStatus === 404,
  );
});

test('no tenant is a 400', async () => {
  await assert.rejects(() => previewTerms({}, { prisma: db() }), (e) => e.httpStatus === 400);
  await assert.rejects(() => listTermsCoverage({}, { prisma: db() }), (e) => e.httpStatus === 400);
});

test('coverage says which branches have their own contract and which fall back', async () => {
  const out = await listTermsCoverage(SCOPE, {
    prisma: db({
      tenant: { name: 'Corpusa', termsHtml: null },
      locations: [
        { id: 'l1', code: 'LAXA01', name: 'Los Angeles', termsHtml: '<h1>LAX</h1>', termsRiderHtml: '<h2>rider</h2>' },
        { id: 'l2', code: 'MIA', name: 'Miami', termsHtml: null, termsRiderHtml: null },
      ],
    }),
  });
  assert.equal(out.tenantHasBase, false);
  const [lax, mia] = out.locations;
  assert.deepEqual(
    { code: lax.code, source: lax.source, own: lax.hasOwnBase, rider: lax.hasRider },
    { code: 'LAXA01', source: TERMS_SOURCES.LOCATION, own: true, rider: true },
  );
  // With no tenant base either, MIA prints the built-in document.
  assert.deepEqual(
    { code: mia.code, source: mia.source, own: mia.hasOwnBase },
    { code: 'MIA', source: TERMS_SOURCES.CANONICAL, own: false },
  );
});

// ---------------------------------------------------------------------------
// Saving a branch's own contract (2026-09-09).
//
// Nothing could write these columns before, so LAX's terms had been seeded
// straight into the database while four other Corpusa branches quietly printed
// the canonical Puerto Rico document. These pin the two things that make the
// write path safe: it sanitizes (the signing page does not), and clearing is a
// real, deliberate operation rather than a no-op.
// ---------------------------------------------------------------------------
const { saveBranchTerms } = await import('./terms-preview.service.js');

function saveDb({ location = { ...LOC, termsHtml: null, termsRiderHtml: null }, capture = {} } = {}) {
  return {
    capture,
    location: {
      findFirst: async ({ where }) => (where.id === location.id && where.tenantId === 't1' ? location : null),
      update: async (args) => { capture.update = args; return { ...location, ...args.data }; },
    },
    tenant: { findUnique: async () => ({ name: 'Corpusa', termsHtml: null }) },
  };
}

test('a script never reaches the database', async () => {
  const db = saveDb();
  await saveBranchTerms(SCOPE, {
    locationId: 'l1', prisma: db,
    termsHtml: '<h2>1. MILEAGE</h2><p>Unlimited.</p><script>steal()</script>',
  });
  const stored = db.capture.update.data.termsHtml;
  assert.equal(stored.includes('<script'), false);
  assert.equal(stored.includes('steal'), false);
  assert.match(stored, /1\. MILEAGE/, 'the contract itself is kept');
});

test('the document structure survives the filter', async () => {
  const db = saveDb();
  await saveBranchTerms(SCOPE, {
    locationId: 'l1', prisma: db,
    termsHtml: '<section><header><h1 lang="en">Terms</h1></header><table><tr><td>x</td></tr></table></section>',
  });
  const stored = db.capture.update.data.termsHtml;
  for (const bit of ['<section', '<header', '<h1', 'lang="en"', '<table', '<td']) {
    assert.ok(stored.includes(bit), `${bit} must survive a save`);
  }
});

test('CLEARING is deliberate: an empty string stores NULL and returns to the cascade', async () => {
  const db = saveDb({ location: { ...LOC, termsHtml: '<h1>old</h1>', termsRiderHtml: null } });
  const out = await saveBranchTerms(SCOPE, { locationId: 'l1', prisma: db, termsHtml: '' });
  assert.equal(db.capture.update.data.termsHtml, null, 'NULL, not an empty string');
  assert.deepEqual(out.cleared, ['termsHtml']);
});

test('a field NOT sent is left alone — saving the rider does not wipe the base', async () => {
  const db = saveDb({ location: { ...LOC, termsHtml: '<h1>keep me</h1>', termsRiderHtml: null } });
  await saveBranchTerms(SCOPE, { locationId: 'l1', prisma: db, termsRiderHtml: '<h2>19. LOCAL</h2>' });
  assert.equal('termsHtml' in db.capture.update.data, false, 'absent means untouched');
  assert.match(db.capture.update.data.termsRiderHtml, /19\. LOCAL/);
});

test('the caller is told what the filter removed', async () => {
  const db = saveDb();
  const out = await saveBranchTerms(SCOPE, {
    locationId: 'l1', prisma: db, termsHtml: '<p>ok</p><script>x()</script>',
  });
  assert.equal(out.impact.termsHtml.changed, true);
  assert.ok(out.impact.termsHtml.removedTags.some((r) => r.tag === 'script'));
});

test('sending nothing at all is a 400, not a silent no-op', async () => {
  await assert.rejects(
    () => saveBranchTerms(SCOPE, { locationId: 'l1', prisma: saveDb() }),
    (e) => e.httpStatus === 400,
  );
});

test("another tenant's branch cannot be written", async () => {
  const db = saveDb();
  await assert.rejects(
    () => saveBranchTerms({ tenantId: 'other' }, { locationId: 'l1', prisma: db, termsHtml: '<p>x</p>' }),
    (e) => e.httpStatus === 404,
  );
  assert.equal(db.capture.update, undefined, 'nothing was written');
});

test('the editor is given the branch OWN fields, never the cascade output', async () => {
  // Loading the rendered contract into the edit box and saving it would
  // promote a fallback into an override: a branch that was correctly
  // inheriting would acquire a frozen copy and stop following tenant edits.
  const { getBranchTermsRaw } = await import('./terms-preview.service.js');
  const out = await getBranchTermsRaw(SCOPE, {
    locationId: 'l1',
    prisma: db({
      location: { ...LOC, termsHtml: null, termsRiderHtml: null },
      tenant: { name: 'Corpusa', termsHtml: '<h1>Corpusa</h1>' },
    }),
  });
  assert.equal(out.termsHtml, '', 'inheriting from the tenant must present as EMPTY');
  assert.equal(out.locationCode, 'LAXA01');
});
