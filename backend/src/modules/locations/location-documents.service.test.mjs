/**
 * Business documents — service behaviour (2026-07-28). prisma and storage are
 * stubbed; nothing touches a DB or a network. The focus is the money/privacy
 * boundary: who may see and touch a branch's paperwork.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

process.env.INTEGRATION_ENC_KEY = crypto.randomBytes(32).toString('base64');

const { locationDocumentsService } = await import('./location-documents.service.js');
const { DOC_STATUS } = await import('./location-documents.js');

const LAX = { id: 'loc-lax', name: 'LAX', code: 'LAXA01' };
const MIA = { id: 'loc-mia', name: 'Miami', code: 'MIAA01' };
const ADMIN = { id: 'u1', role: 'ADMIN', tenantId: 't1' };                       // unrestricted
const SCOPED = { id: 'u2', role: 'ADMIN', tenantId: 't1', locationIds: ['loc-lax'] }; // LAX only

// A 1x1 gif as a data URL — small, valid, and obviously not real paperwork.
const TINY_FILE = 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==';

function makeDb({ locations = [LAX, MIA], documents = [] } = {}) {
  const created = [];
  const updated = [];
  return {
    created, updated, documents,
    location: {
      findFirst: async ({ where }) => locations.find((l) => l.id === where.id && where.tenantId === 't1') || null,
    },
    locationDocument: {
      findMany: async ({ where }) => documents.filter((d) => {
        if (where.tenantId && d.tenantId !== where.tenantId) return false;
        if (where.locationId && typeof where.locationId === 'string' && d.locationId !== where.locationId) return false;
        if (where.locationId?.in && !where.locationId.in.includes(d.locationId)) return false;
        if (where.status && d.status !== where.status) return false;
        if (where.expiresAt?.lte && (!d.expiresAt || new Date(d.expiresAt) > where.expiresAt.lte)) return false;
        if (where.expiresAt?.not === null && d.expiresAt == null) return false;
        return true;
      }),
      findFirst: async ({ where }) => documents.find((d) => d.id === where.id && d.tenantId === where.tenantId) || null,
      create: async ({ data }) => { const row = { id: `doc-${created.length}`, status: 'ACTIVE', ...data }; created.push(row); return row; },
      update: async ({ where, data }) => {
        const row = documents.find((d) => d.id === where.id) || { id: where.id };
        Object.assign(row, data); updated.push({ id: where.id, data }); return row;
      },
    },
  };
}

const storageOk = { uploadObject: async () => ({ ok: true }), getSignedUrl: async () => 'https://signed.example/doc' };

// ---------------------------------------------------------------------------
// Location scoping — fail-closed
// ---------------------------------------------------------------------------
test('SCOPING: a branch-restricted user cannot list another branch\'s documents', async () => {
  const db = makeDb();
  await assert.rejects(
    () => locationDocumentsService.list(SCOPED, 'loc-mia', {}, db),
    (e) => e.statusCode === 404,
  );
});

test('SCOPING: the refusal is 404, not 403 — no existence oracle', async () => {
  const db = makeDb();
  // A branch outside scope and a branch that does not exist must be
  // indistinguishable, or the API leaks the org chart.
  const outOfScope = await locationDocumentsService.list(SCOPED, 'loc-mia', {}, db).catch((e) => e);
  const nonExistent = await locationDocumentsService.list(SCOPED, 'loc-nope', {}, db).catch((e) => e);
  assert.equal(outOfScope.statusCode, 404);
  assert.equal(nonExistent.statusCode, 404);
  assert.equal(outOfScope.message, nonExistent.message);
});

test('SCOPING: a restricted user CAN work with their own branch', async () => {
  const db = makeDb({ documents: [
    { id: 'd1', tenantId: 't1', locationId: 'loc-lax', status: 'ACTIVE', docType: 'PERMIT', label: 'City permit', expiresAt: '2027-01-01' },
  ] });
  const out = await locationDocumentsService.list(SCOPED, 'loc-lax', {}, db);
  assert.equal(out.length, 1);
  assert.equal(out[0].label, 'City permit');
});

test('SCOPING: uploading to a branch outside scope is refused', async () => {
  const db = makeDb();
  await assert.rejects(
    () => locationDocumentsService.upload(SCOPED, 'loc-mia', { label: 'x', file: TINY_FILE }, db, storageOk),
    (e) => e.statusCode === 404,
  );
  assert.equal(db.created.length, 0, 'nothing was recorded');
});

test('SCOPING: the expiry feed only covers branches the user can see', async () => {
  const db = makeDb({ documents: [
    { id: 'd-lax', tenantId: 't1', locationId: 'loc-lax', status: 'ACTIVE', label: 'LAX permit', expiresAt: '2026-08-05', location: LAX },
    { id: 'd-mia', tenantId: 't1', locationId: 'loc-mia', status: 'ACTIVE', label: 'MIA permit', expiresAt: '2026-08-05', location: MIA },
  ] });
  const now = new Date('2026-07-28T12:00:00Z');
  const scoped = await locationDocumentsService.expiringSoon(SCOPED, { now }, db);
  assert.deepEqual(scoped.items.map((i) => i.label), ['LAX permit']);
  const unrestricted = await locationDocumentsService.expiringSoon(ADMIN, { now }, db);
  assert.equal(unrestricted.items.length, 2);
});

// ---------------------------------------------------------------------------
// Upload validation
// ---------------------------------------------------------------------------
test('upload requires a label and a file', async () => {
  const db = makeDb();
  await assert.rejects(() => locationDocumentsService.upload(ADMIN, 'loc-lax', { file: TINY_FILE }, db, storageOk), (e) => e.statusCode === 400);
  await assert.rejects(() => locationDocumentsService.upload(ADMIN, 'loc-lax', { label: 'x' }, db, storageOk), (e) => e.statusCode === 400);
});

test('upload rejects an expiry that precedes the issue date', async () => {
  const db = makeDb();
  await assert.rejects(
    () => locationDocumentsService.upload(ADMIN, 'loc-lax', {
      label: 'Permit', file: TINY_FILE, issuedAt: '2026-06-01', expiresAt: '2026-05-01',
    }, db, storageOk),
    (e) => e.statusCode === 400,
  );
});

test('upload rejects a link — we store documents, not references that can rot', async () => {
  const db = makeDb();
  await assert.rejects(
    () => locationDocumentsService.upload(ADMIN, 'loc-lax', { label: 'Permit', file: 'https://example.com/permit.pdf' }, db, storageOk),
    (e) => e.statusCode === 400,
  );
});

test('a failed storage write records NOTHING (no row pointing at a missing file)', async () => {
  const db = makeDb();
  const storageDown = { uploadObject: async () => { throw new Error('bucket unavailable'); } };
  await assert.rejects(
    () => locationDocumentsService.upload(ADMIN, 'loc-lax', { label: 'Permit', file: TINY_FILE }, db, storageDown),
    (e) => e.statusCode === 502,
  );
  assert.equal(db.created.length, 0);
});

test('a stored document keeps its file under the tenant AND location prefix', async () => {
  const db = makeDb();
  let capturedPath = null;
  await locationDocumentsService.upload(ADMIN, 'loc-lax', { label: 'Permit', file: TINY_FILE }, db, {
    uploadObject: async ({ path }) => { capturedPath = path; return { ok: true }; },
  });
  assert.match(capturedPath, /^tenants\/t1\/locations\/loc-lax\/documents\//);
  assert.equal(db.created[0].locationId, 'loc-lax');
});

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------
test('archiving never destroys the record — an audit can still see it', async () => {
  const db = makeDb({ documents: [{ id: 'd1', tenantId: 't1', locationId: 'loc-lax', status: 'ACTIVE', label: 'Permit', expiresAt: null }] });
  await locationDocumentsService.archive(ADMIN, 'd1', db);
  assert.deepEqual(db.updated[0].data, { status: 'ARCHIVED' });
});

test('expiry status is DERIVED on read, so it can never go stale', async () => {
  const db = makeDb({ documents: [
    { id: 'd1', tenantId: 't1', locationId: 'loc-lax', status: 'ACTIVE', label: 'Permit', expiresAt: '2026-08-10' },
  ] });
  const soon = await locationDocumentsService.list(ADMIN, 'loc-lax', {}, db);
  assert.equal(soon[0].expiryStatus, DOC_STATUS.EXPIRING, 'read near the date');
  // The SAME row, read later, reports itself expired — nothing was rewritten.
  const later = await locationDocumentsService.expiringSoon(ADMIN, { now: new Date('2026-09-01T00:00:00Z') }, db);
  assert.equal(later.items[0].expiryStatus, DOC_STATUS.EXPIRED);
});
