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
