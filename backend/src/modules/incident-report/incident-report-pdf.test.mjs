import test from 'node:test';
import assert from 'node:assert/strict';

const { buildIncidentReportHtml, __test } = await import('./incident-report-pdf.js');

const SAMPLE = {
  company: { name: 'International Rental Corp' },
  reportNumber: 'INC-2026-0511-KMV358',
  dateIssued: 'May 11, 2026',
  title: 'VEHICLE POLICY VIOLATION & SMOKING FEE INCIDENT REPORT',
  bannerText: 'SMOKING FEE VIOLATION — EVIDENCE OF PROHIBITED SUBSTANCE USE',
  renter: { name: 'David Brooks' },
  checkIn: 'May 8, 2026', checkOut: 'May 11, 2026', periodDays: 3,
  depositCollected: 250, smokingFeeAssessed: 'YES',
  vehicle: { makeModel: 'Jeep Wrangler', color: 'White', plate: 'KMV358', company: 'Go Kar Rental' },
  preRentalCondition: 'Clean, no odor or residue.',
  incident: { discoveryAt: 'May 11, 2026', violationType: 'Prohibited smoking', odorNoted: 'Smoke odor', chargeApplied: 'Smoking fee' },
  evidence: [
    { ordinal: 1, location: 'License Plate', description: 'Plate KMV358 confirms unit.', status: 'CONFIRMED' },
    { ordinal: 2, location: 'Cup Holders', description: 'Ash & residue.', status: 'VIOLATION' }
  ],
  clauses: [{ section: '6', label: 'Smoking Fee', text: '$500 fee for smoking.', amountRange: '$500 + tax' }],
  charges: { lines: [{ name: 'Smoking fee', total: 500 }, { name: 'Cleaning', total: 150 }], total: 721.5, depositApplied: 250, balanceDue: 471.5 },
  rebuttalPoints: ['Signed agreement prohibits smoking.', 'Vehicle delivered clean May 8.'],
  photos: [{ caption: 'Fig. 1 — Plate', url: '' }, { caption: 'Fig. 2 — Cup holders', url: '' }],
  certification: { name: 'Jose Carlos Diaz', title: 'Ops Manager', date: '5/11/2026' }
};

test('renders the core report scaffolding', () => {
  const html = buildIncidentReportHtml(SAMPLE);
  assert.match(html, /INC-2026-0511-KMV358/);
  assert.match(html, /International Rental Corp/);
  assert.match(html, /SMOKING FEE VIOLATION/);
  assert.match(html, /1\. Rental Agreement Information/);
  assert.match(html, /9\. Declaration/i);
});

test('evidence rows carry CONFIRMED / VIOLATION statuses', () => {
  const html = buildIncidentReportHtml(SAMPLE);
  assert.match(html, /CONFIRMED/);
  assert.match(html, /VIOLATION/);
  assert.match(html, /Cup Holders/);
});

test('charge summary shows totals + deposit + balance', () => {
  const html = buildIncidentReportHtml(SAMPLE);
  assert.match(html, /\$721\.50/);
  assert.match(html, /– \$250\.00/);
  assert.match(html, /\$471\.50/);
});

test('escapeHtml neutralizes angle brackets and ampersands', () => {
  assert.equal(__test.escapeHtml('<script>&"'), '&lt;script&gt;&amp;&quot;');
});

test('omits optional sections when data absent', () => {
  const html = buildIncidentReportHtml({ reportNumber: 'INC-X', company: { name: 'X' } });
  assert.doesNotMatch(html, /5\. Rental Agreement Policy Violations/);
  assert.doesNotMatch(html, /8\. Photographic Evidence/);
  assert.match(html, /No evidence rows recorded/);
});

test('injection in fields is escaped, not rendered', () => {
  const html = buildIncidentReportHtml({ ...SAMPLE, renter: { name: '<img src=x onerror=alert(1)>' } });
  assert.doesNotMatch(html, /<img src=x onerror/);
  assert.match(html, /&lt;img src=x/);
});
