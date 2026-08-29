/**
 * Unit tests for the toll queue CSV export (tolls-export.js). No DB.
 *
 * WHY THIS EXISTS: this repo has twice shipped exports that ignored the
 * on-screen filters. The export where-builder is the SAME function the
 * dashboard list uses; these tests pin (1) tenant scoping, (2) location
 * scoping, (3) filter carry-through (q / status / needsReview), (4) the
 * queue-view fragment being AND-ed without clobbering the search OR, and
 * (5) CSV shape/escaping.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

// tenant-scope.js transitively imports middleware/auth.js; keep the env sane
// like the other pure toll tests do.
process.env.DATABASE_URL ||= 'postgresql://unused:unused@127.0.0.1:1/unused';

const {
  buildTollListWhere,
  buildTollExportWhere,
  tollsToCsv,
  tollExportFilename,
  TOLL_EXPORT_COLUMNS,
  TOLL_EXPORT_MAX_ROWS
} = await import('./tolls-export.js');

const TENANT_SCOPE = { tenantId: 'tenant-1' };

test('export where is tenant-scoped', () => {
  const where = buildTollExportWhere(TENANT_SCOPE, {});
  // view ALL -> no fragment, base object comes straight through
  assert.equal(where.tenantId, 'tenant-1');
});

test('a location-scoped caller exports only their vehicles', () => {
  const scope = { tenantId: 'tenant-1', allowedLocationIds: ['LOC-A'] };
  const where = buildTollListWhere(scope, {});
  assert.deepEqual(where.vehicle, { is: { homeLocationId: { in: ['LOC-A'] } } });
});

test('an unrestricted caller gets no location clause', () => {
  const where = buildTollListWhere({ tenantId: 'tenant-1', allowedLocationIds: [] }, {});
  assert.equal(where.vehicle, undefined);
});

test('a [null] allowedLocationIds means unrestricted, not match-nothing', () => {
  const where = buildTollListWhere({ tenantId: 'tenant-1', allowedLocationIds: [null, ''] }, {});
  assert.equal(where.vehicle, undefined);
});

test('q / status / needsReview carry through to the export where', () => {
  const where = buildTollListWhere(TENANT_SCOPE, { q: 'KST-894', status: 'needs_review', needsReview: true });
  assert.equal(where.status, 'NEEDS_REVIEW', 'status is uppercased like the dashboard');
  assert.equal(where.needsReview, true);
  assert.ok(Array.isArray(where.OR), 'search expands to the OR the dashboard uses');
  assert.deepEqual(where.OR[1], { plateRaw: { contains: 'KST-894', mode: 'insensitive' } });
  assert.equal(where.OR.length, 6, 'all six search targets (location/plate/tag/sello/reservation/vehicle)');
});

test('a queue view is AND-ed so the search OR is not clobbered', () => {
  const where = buildTollExportWhere(TENANT_SCOPE, { q: 'plaza', view: 'NEEDS_REVIEW' });
  assert.ok(Array.isArray(where.AND), 'view fragment composes via AND, like countQueues');
  const [base, fragment] = where.AND;
  assert.equal(base.tenantId, 'tenant-1');
  assert.ok(Array.isArray(base.OR), 'search OR survives on the base');
  assert.equal(fragment.needsReview, true);
  assert.ok(Array.isArray(fragment.OR), 'queue fragment keeps its own suggestion OR');
});

test('an unknown view falls back to ALL instead of exporting garbage', () => {
  const where = buildTollExportWhere(TENANT_SCOPE, { view: 'NOT_A_VIEW' });
  assert.equal(where.AND, undefined);
  assert.equal(where.tenantId, 'tenant-1');
});

test('every real queue view produces a where (parity with queueCounts keys)', async () => {
  const { TOLL_QUEUE_KEYS } = await import('./tolls-queue-counts.js');
  for (const key of TOLL_QUEUE_KEYS) {
    const where = buildTollExportWhere(TENANT_SCOPE, { view: key });
    assert.ok(where && typeof where === 'object', `view ${key}`);
    if (key !== 'ALL') assert.ok(Array.isArray(where.AND), `view ${key} composes via AND`);
  }
});

test('CSV: header, row values, and quoting', () => {
  const csv = tollsToCsv([{
    transactionAt: new Date('2026-08-26T07:14:00Z'),
    location: 'Plaza Caguas, Norte', // comma forces quoting
    lane: 'L2',
    direction: 'N',
    amount: 1.4,
    plateRaw: 'KST-894',
    tagRaw: '',
    selloRaw: '',
    vehicle: { internalNumber: 'UNIT-102', plate: 'KST-894' },
    reservation: { reservationNumber: 'TL-ZE40848835BA', customer: { firstName: 'M.', lastName: 'Rivera' } },
    status: 'NEEDS_REVIEW',
    billingStatus: 'PENDING',
    needsReview: true,
    matchConfidence: 92,
    reviewNotes: 'line1\nline2',
    assignments: [{ matchReason: 'plate,withinTripWindow', reservation: { reservationNumber: 'TL-ZE40848835BA' } }]
  }]);
  const lines = csv.split('\r\n');
  assert.equal(lines[0], TOLL_EXPORT_COLUMNS.join(','));
  assert.ok(lines[1].includes('"Plaza Caguas, Norte"'), 'comma value is quoted');
  assert.ok(lines[1].includes('"plate,withinTripWindow"'), 'raw matchReason tokens survive in the data export');
  assert.ok(lines[1].includes('"line1\nline2"'), 'newline value is quoted');
  assert.ok(lines[1].includes('1.40'), 'money keeps two decimals');
  assert.ok(lines[1].includes('M. Rivera'));
  assert.ok(lines[1].includes('92'));
});

test('CSV: empty rows still produce the header', () => {
  assert.equal(tollsToCsv([]), TOLL_EXPORT_COLUMNS.join(','));
});

test('filename names the active view', () => {
  const name = tollExportFilename({ view: 'READY_TO_POST' }, new Date('2026-08-28T12:00:00Z'));
  assert.equal(name, 'tolls-ready-to-post-2026-08-28.csv');
  assert.equal(tollExportFilename({ view: 'bogus' }, new Date('2026-08-28T12:00:00Z')), 'tolls-all-2026-08-28.csv');
});

test('the export cap is bounded and beyond the 200-row screen window', () => {
  assert.ok(TOLL_EXPORT_MAX_ROWS > 200);
  assert.ok(TOLL_EXPORT_MAX_ROWS <= 10000);
});

test('the dashboard list uses the SAME where builder (no drift by construction)', async () => {
  // Read the service source and assert getDashboard delegates to
  // buildTollListWhere — the guarantee the whole module exists for.
  const fs = await import('node:fs/promises');
  const src = await fs.readFile(new URL('./tolls.service.js', import.meta.url), 'utf8');
  assert.match(src, /const where = buildTollListWhere\(scope, filters\);/);
  assert.doesNotMatch(src.slice(src.indexOf('async getDashboard'), src.indexOf('async exportTransactionsCsv')), /searchFilter/);
});
