import test from 'node:test';
import assert from 'node:assert/strict';

const { __test } = await import('./incident-report.service.js');
const { makeReportNumber, reportingWindowHours, daysBetween, serialize, DEFAULT_CLAUSES, TYPE_META } = __test;

test('makeReportNumber builds INC-YYYYMMDD-PLATE', () => {
  assert.equal(makeReportNumber({ licensePlate: 'KMV358' }, new Date('2026-05-11T12:00:00')), 'INC-20260511-KMV358');
  assert.equal(makeReportNumber({ licensePlate: 'abc-12 3' }, new Date('2026-01-02T12:00:00')), 'INC-20260102-ABC123');
  assert.equal(makeReportNumber({}, new Date('2026-05-11T12:00:00')), 'INC-20260511-NA');
});

test('reportingWindowHours reads tenant settingsJson with a 24h default', () => {
  assert.equal(reportingWindowHours({ settingsJson: '{"incidentReportingWindowHours":48}' }), 48);
  assert.equal(reportingWindowHours({ settingsJson: { incidentReportingWindowHours: 12 } }), 12);
  assert.equal(reportingWindowHours({ settingsJson: '{}' }), 24);
  assert.equal(reportingWindowHours({}), 24);
  assert.equal(reportingWindowHours({ settingsJson: 'not json' }), 24);
});

test('daysBetween computes whole days', () => {
  assert.equal(daysBetween(new Date('2026-05-08'), new Date('2026-05-11')), 3);
  assert.equal(daysBetween(null, new Date()), null);
});

test('serialize exposes locked=true once not DRAFT and parses cited clauses', () => {
  const draft = serialize({ id: 'a', status: 'DRAFT', citedClausesJson: '[{"section":"6","label":"Smoking Fee"}]', evidence: [] });
  assert.equal(draft.locked, false);
  assert.equal(draft.citedClauses.length, 1);
  const issued = serialize({ id: 'b', status: 'ISSUED', evidence: [{ id: 'e', ordinal: 1, location: 'X', description: 'Y', evidenceStatus: 'VIOLATION' }] });
  assert.equal(issued.locked, true);
  assert.equal(issued.evidence[0].location, 'X');
});

test('clause seed + type metadata are present', () => {
  assert.equal(DEFAULT_CLAUSES.length, 6);
  assert.ok(TYPE_META.SMOKING.banner.includes('SMOKING'));
  assert.ok(TYPE_META.DAMAGE.title.includes('DAMAGE'));
});

// ---------------------------------------------------------------------------
// Incidents HUB (2026-07-28): tenant-wide list scoping + email guards.
// prisma methods are monkey-patched (same pattern as the economy scheduler
// tests) — no DB needed beyond the client constructing.
// ---------------------------------------------------------------------------
const { incidentReportService } = await import('./incident-report.service.js');
const { prisma } = await import('../../lib/prisma.js');

function patchIncidentQueries() {
  const captured = { where: null, select: null };
  const origCount = prisma.reservationIncident.count;
  const origFindMany = prisma.reservationIncident.findMany;
  prisma.reservationIncident.count = async ({ where }) => { captured.where = where; return 0; };
  prisma.reservationIncident.findMany = async ({ where, select }) => {
    captured.where = where; captured.select = select; return [];
  };
  return {
    captured,
    restore() {
      prisma.reservationIncident.count = origCount;
      prisma.reservationIncident.findMany = origFindMany;
    },
  };
}

test('hub list: location-scoped user filters by reservation.pickupLocationId (fail-closed)', async () => {
  const { captured, restore } = patchIncidentQueries();
  try {
    const scoped = { role: 'ADMIN', tenantId: 't1', locationIds: ['loc-lax'] };
    await incidentReportService.listForTenant(scoped, {});
    assert.deepEqual(captured.where.reservation, { pickupLocationId: { in: ['loc-lax'] } });
    assert.equal(captured.where.tenantId, 't1');
  } finally { restore(); }
});

test('hub list: unscoped ADMIN sees tenant-wide (no reservation filter)', async () => {
  const { captured, restore } = patchIncidentQueries();
  try {
    await incidentReportService.listForTenant({ role: 'ADMIN', tenantId: 't1' }, {});
    assert.equal(captured.where.reservation, undefined);
    assert.equal(captured.where.tenantId, 't1');
  } finally { restore(); }
});

test('hub list: valid filters apply, bogus values are ignored, q builds the OR', async () => {
  const { captured, restore } = patchIncidentQueries();
  try {
    await incidentReportService.listForTenant({ role: 'ADMIN', tenantId: 't1' }, {
      status: 'issued', type: 'SMOKING', severity: 'BOGUS', q: 'KMV',
    });
    assert.equal(captured.where.status, 'ISSUED');
    assert.equal(captured.where.type, 'SMOKING');
    assert.equal(captured.where.severity, undefined, 'invalid severity ignored');
    assert.ok(Array.isArray(captured.where.OR) && captured.where.OR.length >= 5, 'free-text OR present');
  } finally { restore(); }
});

test('hub list: payload is light — no evidence in the select', async () => {
  const { captured, restore } = patchIncidentQueries();
  try {
    await incidentReportService.listForTenant({ role: 'ADMIN', tenantId: 't1' }, {});
    assert.equal(captured.select.evidence, undefined);
    assert.ok(captured.select.reservation, 'reservation join present');
  } finally { restore(); }
});

test('email: invalid recipient rejected with 400 before any DB access', async () => {
  await assert.rejects(
    () => incidentReportService.emailReport({ role: 'ADMIN', tenantId: 't1' }, 'x', { to: 'not-an-email' }),
    (e) => e.statusCode === 400
  );
});

test('email: DRAFT reports are blocked with 409', async () => {
  const orig = prisma.reservationIncident.findFirst;
  prisma.reservationIncident.findFirst = async () => ({ id: 'x', status: 'DRAFT', reportNumber: 'INC-1', evidence: [] });
  try {
    await assert.rejects(
      () => incidentReportService.emailReport({ role: 'ADMIN', tenantId: 't1' }, 'x', { to: 'a@b.co' }),
      (e) => e.statusCode === 409
    );
  } finally { prisma.reservationIncident.findFirst = orig; }
});
