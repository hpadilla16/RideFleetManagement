/**
 * NU Car Rentals (affiliates portal) integration — unit tests.
 *
 * Pure where possible; fetch/prisma mocked. Covers the correctness-critical
 * pieces of the WebForms + Telerik integration:
 *   1. RadGrid parser — a representative Telerik RadGrid HTML fixture
 *      (rgMasterTable + rgRow/rgAltRow + the 14+ column order) incl. a PP row,
 *      an OP row, a blank-code row, a missing-AltConf row, and a "UN" flight.
 *   2. isPrepaid derivation (PP/OP → true, blank/other → false).
 *   3. ACRISS → vehicleType mapper (via the shared evaluatePromotion + override).
 *   4. date/TZ parsing (M/D/YYYY + time → America/New_York UTC instant).
 *   5. login ClientState builder + WebForms form scrape.
 *   6. re-login-once retry (mocked fetch).
 *   7. field mapper + scheduler master-flag enforcement.
 *
 * Promotion/dedup/crypto logic is reused UNCHANGED from TL/Economy — covered by
 * those suites — so it is not re-tested here.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

process.env.INTEGRATION_ENC_KEY = crypto.randomBytes(32).toString('base64');

const {
  SOURCE_SYSTEM,
  BOOKING_CHANNEL,
  RESERVATION_PREFIX,
  TIME_ZONE,
  DATE_WINDOW_LOOKBACK_DAYS,
  DATE_WINDOW_LOOKAHEAD_DAYS,
  formatNuDate,
  isPrepaidFromCode,
  effectiveWindowDays,
  windowBoundsForConfig,
} = await import('./nu.constants.js');

const {
  parseWebFormsForm,
  buildClientState,
  radDatePickerOverrides,
  parseRadGrid,
  extractHeaderCells,
  headerAnchorMismatch,
  parsePagerInfo,
  combineDateTimeToUtc,
  parseMoney,
  filterByPickupWindow,
  login,
  authedFetch,
  NuAuthExpiredError,
  NuLayoutError,
  __test,
  _resetCookieJarsForTests,
} = await import('./nu.service.js');

const { mapRowToExternalReservation } = await import('./nu.worker.js');

const { evaluatePromotion, REVIEW_REASONS } = await import('../tl-international/promotion-matcher.service.js');

// ---------------------------------------------------------------------------
// Constants sanity
// ---------------------------------------------------------------------------
test('constants: source/channel/prefix are the NU values', () => {
  assert.equal(SOURCE_SYSTEM, 'NU');
  assert.equal(BOOKING_CHANNEL, 'FRANCHISE_NU');
  assert.equal(RESERVATION_PREFIX, 'NU-');
  assert.equal(TIME_ZONE, 'America/New_York');
});

// ---------------------------------------------------------------------------
// 1. RadGrid parser — representative fixture (REAL live markup, 2026-07-09)
//
// The live grid renders 20 <td> per data row; the first TWO are structural
// (row-select / expand) and are IGNORED. Column order:
//   0,1 structural(ignore)  2 Confirmation  3 Last  4 First  5 PU  6 Flight
//   7 TAKENdate(ISO)  8 TAKENtime(HH:MM)  9 RENTALdate(ISO,=PICKUP) 10 RENTALtime
//  11 RETURNdate(ISO,=DROPOFF) 12 RETURNtime  13 Class(ACRISS) 14 Status
//  15 Total($)  16 COMBINED "Code + rate" ("OP 39","PP 40","36" pay-at-dest,"PP 70")
//  17 ratePlan (system code "SYS30"/"SYS4"…)  18 AltConfirmation#(may be empty)
//  19 Phone ("p 0017168071101" artifact-then-digits; "p -"/"p" = no phone)
// Rows carry the real classes "rgRow PadAllSides" / "rgAltRow" (contains-match).
// ---------------------------------------------------------------------------
function td(v) { return `<td>${v}</td>`; }
function gridRow(cls, cells) {
  return `<tr class="${cls}">${cells.map(td).join('')}</tr>`;
}
// The two leading structural cells (select checkbox + expand toggle). Distinct
// text so tests can prove they are skipped, not mapped into a field.
const STRUCT = ['<input type="checkbox">SEL', '<a href="#">EXP</a>'];

const RADGRID_FIXTURE = `
<div>
  <table id="ctl00_ContentPlaceHolder1_RadGrid1_ctl00" class="rgMasterTable rgClipCells">
    <thead><tr class="rgHeader">
      <th>&nbsp;</th><th>&nbsp;</th>
      <th>Confirmation</th><th>Last Name</th><th>First Name</th><th>PU</th>
      <th>Flight</th><th>Taken</th><th>Time</th><th>Rental</th><th>Time</th>
      <th>Return</th><th>Time</th><th>Class</th><th>Status</th><th>Total</th>
      <th>Code</th><th>Rate</th><th>AltConf</th><th>Phone</th>
    </tr></thead>
    <tbody>
      ${/* PP prepaid row: combined "PP 40", ratePlan, AltConfirmation + phone */''}
      ${gridRow('rgRow PadAllSides', [
        ...STRUCT,
        '617-0103071-NU', 'Doe', 'John', 'FLL', 'B6 2780',
        '2026-07-01', '10:30', '2026-07-09', '14:00', '2026-07-12', '11:00',
        'IFAR', 'OPEN', '$249.50', 'PP 40', 'SYS30', 'US904718150', 'p 0017168071101',
      ])}
      ${/* OP prepaid row: combined "OP 39", UN flight, empty AltConf, "p -" no phone */''}
      ${gridRow('rgAltRow', [
        ...STRUCT,
        '617-0103072-NU', 'Smith', 'Jane', 'FLL', 'UN',
        '2026-07-02', '09:00', '2026-07-10', '09:30', '2026-07-14', '09:30',
        'CCAR', 'OPEN', '$0.00', 'OP 39', 'SYS5', '&nbsp;', 'p -',
      ])}
      ${/* blank-code = pay-at-destination: combined "36" (number-only), empty AltConf */''}
      ${gridRow('rgRow PadAllSides', [
        ...STRUCT,
        '617-0103073-NU', 'Nguyen', 'Bao', 'FLL', 'AA100',
        '2026-07-03', '08:00', '2026-07-11', '16:15', '2026-07-13', '16:15',
        'ECAR', 'OPEN', '$132.00', '36', 'SYS4', '', 'p 3055550199',
      ])}
      ${/* lowercase "pp 70" (still prepaid → code uppercased), UN flight, empty AltConf */''}
      ${gridRow('rgAltRow', [
        ...STRUCT,
        '617-0103074-NU', 'Garcia', 'Lucia', 'FLL', 'UN',
        '2026-07-04', '07:45', '2026-07-12', '12:00', '2026-07-15', '10:00',
        'MVAR', 'OPEN', '$410.75', 'pp 70', 'SYS4', '&nbsp;', 'p 9545550177',
      ])}
    </tbody>
  </table>
</div>`;

test('parseRadGrid: parses all data rows from the rgMasterTable', () => {
  const rows = parseRadGrid(RADGRID_FIXTURE);
  assert.equal(rows.length, 4);
  assert.deepEqual(rows.map((r) => r.confirmation), [
    '617-0103071-NU', '617-0103072-NU', '617-0103073-NU', '617-0103074-NU',
  ]);
});

test('parseRadGrid: maps names, PU, class, status, code/rate/ratePlan, altConf, phone correctly', () => {
  const [r0] = parseRadGrid(RADGRID_FIXTURE);
  assert.equal(r0.confirmation, '617-0103071-NU');
  assert.equal(r0.lastName, 'Doe');
  assert.equal(r0.firstName, 'John');
  assert.equal(r0.pu, 'FLL');
  assert.equal(r0.flight, 'B6 2780');
  assert.equal(r0.acriss, 'IFAR');
  assert.equal(r0.status, 'OPEN');
  assert.equal(r0.total, '249.50');       // cell[15] money → estimatedTotal
  assert.equal(r0.code, 'PP');            // from combined cell[16] "PP 40"
  assert.equal(r0.rate, '40');            // trailing integer of "PP 40"
  assert.equal(r0.ratePlan, 'SYS30');     // cell[17] system code
  assert.equal(r0.altConfirmation, 'US904718150'); // cell[18]
  assert.equal(r0.phone, '0017168071101');         // cell[19] digits only
});

test('parseRadGrid: combined cell[16] → code (PP/OP/blank) + trailing-integer rate', () => {
  const rows = parseRadGrid(RADGRID_FIXTURE);
  // "PP 40" → PP / 40
  assert.equal(rows[0].code, 'PP');
  assert.equal(rows[0].rate, '40');
  // "OP 39" → OP / 39
  assert.equal(rows[1].code, 'OP');
  assert.equal(rows[1].rate, '39');
  // "36" (number-only, no PP/OP) → blank code / 36, pay-at-destination
  assert.equal(rows[2].code, '');
  assert.equal(rows[2].rate, '36');
  assert.equal(rows[2].isPrepaid, false);
  // "pp 70" (lowercase) → code uppercased to PP / 70
  assert.equal(rows[3].code, 'PP');
  assert.equal(rows[3].rate, '70');
});

test('parseRadGrid: phone digits extracted; "p -" artifact row → no phone', () => {
  const rows = parseRadGrid(RADGRID_FIXTURE);
  assert.equal(rows[0].phone, '0017168071101'); // "p 0017168071101" → digits
  assert.equal(rows[1].phone, null);            // "p -" → < 7 digits → no phone
  assert.equal(rows[2].phone, '3055550199');
  assert.equal(rows[3].phone, '9545550177');
});

test('parseRadGrid: the 2 leading structural cells are ignored (not mapped into a field)', () => {
  const rows = parseRadGrid(RADGRID_FIXTURE);
  // Confirmation is read from cell[2], NOT the structural cell[0]/cell[1].
  assert.equal(rows[0].confirmation, '617-0103071-NU');
  // None of the extracted string fields should carry the structural markers.
  for (const r of rows) {
    for (const v of [r.confirmation, r.lastName, r.firstName, r.pu, r.flight,
      r.acriss, r.status, r.code, r.rate, r.altConfirmation, r.phone]) {
      assert.ok(!/SEL|EXP/.test(String(v ?? '')), `structural leak in ${v}`);
    }
  }
});

test('parseRadGrid: "UN" flight is normalized to empty', () => {
  const rows = parseRadGrid(RADGRID_FIXTURE);
  assert.equal(rows[1].flight, ''); // UN → ''
  assert.equal(rows[3].flight, ''); // UN → ''
});

test('parseRadGrid: PP and OP rows are isPrepaid=true; blank is false', () => {
  const rows = parseRadGrid(RADGRID_FIXTURE);
  assert.equal(rows[0].code, 'PP');
  assert.equal(rows[0].isPrepaid, true);
  assert.equal(rows[1].code, 'OP');
  assert.equal(rows[1].isPrepaid, true);
  assert.equal(rows[2].code, '');      // number-only "36" → blank → pay-at-destination
  assert.equal(rows[2].isPrepaid, false);
  assert.equal(rows[3].code, 'PP');    // lowercase "pp 70" → uppercased, still prepaid
  assert.equal(rows[3].isPrepaid, true);
});

test('parseRadGrid: AltConfirmation# present on one row, empty tolerated (null) on others', () => {
  const rows = parseRadGrid(RADGRID_FIXTURE);
  assert.equal(rows[0].altConfirmation, 'US904718150'); // present → kept
  assert.equal(rows[1].altConfirmation, null);          // &nbsp; → null
  assert.equal(rows[2].altConfirmation, null);          // '' → null
  assert.equal(rows[3].altConfirmation, null);          // &nbsp; → null
});

test('parseRadGrid: pickupAt/dropoffAt/bookedAt are Dates interpreted in ET', () => {
  const [r0] = parseRadGrid(RADGRID_FIXTURE);
  assert.ok(r0.pickupAt instanceof Date);
  assert.ok(r0.dropoffAt instanceof Date);
  assert.ok(r0.bookedAt instanceof Date);
  // 7/9/2026 2:00 PM ET = 18:00 UTC (EDT = UTC-4 in July).
  assert.equal(r0.pickupAt.toISOString(), '2026-07-09T18:00:00.000Z');
});

test('parseRadGrid: empty / non-grid HTML → []', () => {
  assert.deepEqual(parseRadGrid(''), []);
  assert.deepEqual(parseRadGrid('<html><body>no grid here</body></html>'), []);
});

test('parseRadGrid: falls back to whole-doc when rgMasterTable class drifts', () => {
  // No rgMasterTable/RadGrid1 wrapper, but the rows still carry rgRow/rgAltRow.
  const html = `<table>${gridRow('rgRow PadAllSides', [
    ...STRUCT,
    'C1', 'L', 'F', 'FLL', 'UN', '2026-07-01', '09:00', '2026-07-02', '09:00',
    '2026-07-03', '09:00', 'CCAR', 'OPEN', '$10.00', 'PP 5', 'SYS4', 'ALT-C1', 'p 7875550000',
  ])}</table>`;
  const rows = parseRadGrid(html);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].confirmation, 'C1');
  assert.equal(rows[0].code, 'PP');
  assert.equal(rows[0].rate, '5');
  assert.equal(rows[0].phone, '7875550000');
});

// ---------------------------------------------------------------------------
// 1b. Silent-miss hardening (Innovation MUST-CHANGE) — FIX A/B/C.
//
// The validated happy-path mapping is UNCHANGED; these prove failures are now
// LOUD (throw / diagnostics) instead of silently importing corrupt data.
// ---------------------------------------------------------------------------

// Correct header (20 cols incl. the 2 leading structural columns).
const HEADER_OK = [
  '&nbsp;', '&nbsp;', 'Confirmation', 'Last Name', 'First Name', 'PU', 'Flight',
  'Taken', 'Time', 'Rental', 'Time', 'Return', 'Time', 'Class', 'Status', 'Total',
  'Code', 'Rate', 'AltConf', 'Phone',
];
// One valid data row's 18 data cells (grid cells 2..19).
const SAMPLE_DATA = [
  '617-0100001-NU', 'Doe', 'John', 'FLL', 'UN',
  '2026-07-01', '10:00', '2026-07-09', '12:00', '2026-07-12', '12:00',
  'CCAR', 'OPEN', '$100.00', 'PP 40', 'SYS4', '', 'p 3055550123',
];
function headerRow(cells) {
  return `<thead><tr class="rgHeader">${cells.map((h) => `<th>${h}</th>`).join('')}</tr></thead>`;
}
function grid(headerCells, bodyRows, pagerHtml = '') {
  return `<div><table id="ctl00_ContentPlaceHolder1_RadGrid1_ctl00" class="rgMasterTable">
    ${headerRow(headerCells)}<tbody>${bodyRows.join('')}</tbody></table>${pagerHtml}</div>`;
}
function pager(infoText) {
  return `<div class="rgPager"><span class="rgInfoPart">${infoText}</span></div>`;
}

// --- FIX A: header-anchor column-drift guard --------------------------------
test('FIX A: correct-header grid parses fine (anchors aligned, no drift)', () => {
  const rows = parseRadGrid(grid(HEADER_OK, [gridRow('rgRow', [...STRUCT, ...SAMPLE_DATA])]));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].confirmation, '617-0100001-NU');
  assert.equal(rows.diagnostics.headerFound, true);
  assert.equal(rows.diagnostics.gridPresent, true);
  assert.deepEqual(headerAnchorMismatch(HEADER_OK), []);
});

test('FIX A: an INSERTED column (Total/Code shifted) → parseRadGrid throws NuLayoutError', () => {
  // Insert an "Extra" column before Total → Total/Code shift right by one, so the
  // idx15 anchor no longer reads "Total".
  const drifted = [...HEADER_OK.slice(0, 15), 'Extra', ...HEADER_OK.slice(15)];
  assert.ok(headerAnchorMismatch(drifted).length > 0);
  const html = grid(drifted, [gridRow('rgRow', [...STRUCT, ...SAMPLE_DATA, 'x'])]);
  assert.throws(() => parseRadGrid(html), (err) => err instanceof NuLayoutError);
});

test('FIX A: the real RADGRID_FIXTURE header is aligned (no drift, guard passes)', () => {
  const rows = parseRadGrid(RADGRID_FIXTURE);
  assert.equal(rows.diagnostics.headerFound, true);
  assert.equal(rows.diagnostics.emptyGridAnomaly, false);
  assert.equal(rows.diagnostics.truncated, false);
  assert.equal(rows.diagnostics.unexpectedCodeTokens, 0);
});

test('FIX A: a grid with NO extractable header WARNs-but-proceeds (no throw)', () => {
  // rgMasterTable present, rows present, but zero <th> → best-effort parse.
  const html = `<table id="RadGrid1" class="rgMasterTable"><tbody>${
    gridRow('rgRow', [...STRUCT, ...SAMPLE_DATA])}</tbody></table>`;
  const rows = parseRadGrid(html);
  assert.equal(rows.length, 1);
  assert.equal(rows.diagnostics.gridPresent, true);
  assert.equal(rows.diagnostics.headerFound, false);
});

test('extractHeaderCells: pulls the rgHeader <th> texts in order; null when none', () => {
  const cells = extractHeaderCells(headerRow(HEADER_OK));
  assert.equal(cells[2], 'Confirmation');
  assert.equal(cells[15], 'Total');
  assert.equal(cells[16], 'Code');
  assert.equal(extractHeaderCells('<table><tr><td>x</td></tr></table>'), null);
});

// --- FIX B: total-count cross-check + present-but-empty anomaly --------------
test('parsePagerInfo: reads Telerik "items 1 to N of TOTAL" / "N items" / page count', () => {
  assert.equal(parsePagerInfo(pager('items 1 to 20 of 459')).totalItems, 459);
  assert.equal(parsePagerInfo(pager('459 items')).totalItems, 459);
  assert.equal(parsePagerInfo(pager('1 items')).totalItems, 1);
  assert.equal(parsePagerInfo(pager('0 items')).totalItems, 0);
  assert.equal(parsePagerInfo('<div class="rgPager">Page 1 of 23</div>').pageCount, 23);
  assert.equal(parsePagerInfo('<div>no pager</div>').totalItems, null);
});

test('FIX B: pager TOTAL greater than rendered rows → truncation signal fires', () => {
  const body = [
    gridRow('rgRow', [...STRUCT, ...SAMPLE_DATA]),
    gridRow('rgAltRow', [...STRUCT, ...SAMPLE_DATA]),
  ];
  const rows = parseRadGrid(grid(HEADER_OK, body, pager('items 1 to 20 of 459')));
  assert.equal(rows.length, 2);
  assert.equal(rows.diagnostics.parsedRows, 2);
  assert.equal(rows.diagnostics.totalCount, 459);
  assert.equal(rows.diagnostics.truncated, true);
});

test('FIX B: a multi-PAGE pager with no item total still flags truncation', () => {
  const rows = parseRadGrid(grid(HEADER_OK,
    [gridRow('rgRow', [...STRUCT, ...SAMPLE_DATA])],
    '<div class="rgPager">Page 1 of 5</div>'));
  assert.equal(rows.diagnostics.truncated, true);
  assert.equal(rows.diagnostics.pageCount, 5);
});

test('FIX B: grid present but 0 rows + unknown total → emptyGridAnomaly (NOT silent OK)', () => {
  const rows = parseRadGrid(grid(HEADER_OK, [])); // no pager → total unknown
  assert.equal(rows.length, 0);
  assert.equal(rows.diagnostics.gridPresent, true);
  assert.equal(rows.diagnostics.emptyGridAnomaly, true);
});

test('FIX B: grid present, 0 rows, pager total 0 → genuinely empty (quiet)', () => {
  const rows = parseRadGrid(grid(HEADER_OK, [], pager('0 items')));
  assert.equal(rows.length, 0);
  assert.equal(rows.diagnostics.totalCount, 0);
  assert.equal(rows.diagnostics.emptyGridAnomaly, false);
  assert.equal(rows.diagnostics.truncated, false);
});

// --- FIX C: unexpected cell[16] token telemetry -----------------------------
test('FIX C: an unexpected Code token is counted; isPrepaid stays false', () => {
  const bad = [...SAMPLE_DATA];
  bad[14] = 'ZZ 9'; // grid cell[16] — neither PP/OP nor a pure number
  const rows = parseRadGrid(grid(HEADER_OK, [gridRow('rgRow', [...STRUCT, ...bad])]));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].code, '');            // no PP/OP → blank
  assert.equal(rows[0].isPrepaid, false);    // MUST stay false (counter still collects)
  assert.equal(rows.diagnostics.unexpectedCodeTokens, 1);
});

test('FIX C: PP/OP and pure-number Code cells are NOT counted as unexpected', () => {
  // RADGRID_FIXTURE has PP/OP/number-only ("36") codes only → zero unexpected.
  assert.equal(parseRadGrid(RADGRID_FIXTURE).diagnostics.unexpectedCodeTokens, 0);
});

// ---------------------------------------------------------------------------
// 2. isPrepaid derivation
// ---------------------------------------------------------------------------
test('isPrepaidFromCode: PP/OP (any case) → true; blank/other → false', () => {
  assert.equal(isPrepaidFromCode('PP'), true);
  assert.equal(isPrepaidFromCode('OP'), true);
  assert.equal(isPrepaidFromCode(' pp '), true);
  assert.equal(isPrepaidFromCode('op'), true);
  assert.equal(isPrepaidFromCode(''), false);
  assert.equal(isPrepaidFromCode('   '), false);
  assert.equal(isPrepaidFromCode(null), false);
  assert.equal(isPrepaidFromCode('XX'), false);
  assert.equal(isPrepaidFromCode('12345'), false); // a RATE number, not a code
});

// ---------------------------------------------------------------------------
// 3. ACRISS → vehicleType mapper (via shared evaluatePromotion + override).
// The NU worker resolves the ACRISS class through AcrissCategoryMap exactly like
// Economy — location is authoritative via overrideLocationId. Prove the ACRISS
// gate resolves the category and a mapped-away ACRISS still gates to review.
// ---------------------------------------------------------------------------
function fakePrisma({ acriss = { vehicleCategory: 'ECONOMY' }, customers = [] } = {}) {
  return {
    acrissCategoryMap: { findUnique: async () => acriss, findFirst: async () => acriss },
    locationCodeMap: { findUnique: async () => null },
    customer: { findMany: async () => customers },
  };
}
const NU_EXT = Object.freeze({
  tenantId: 't1', currency: 'USD', vehicleAcriss: 'IFAR',
  pickupLocation: 'FLL', customerEmail: 'match@example.com',
});

test('ACRISS mapper: overrideLocationId + mapped ACRISS → AUTO with the category', async () => {
  const prisma = fakePrisma({
    acriss: { vehicleCategory: 'FULLSIZE' },
    customers: [{ id: 'c1', firstName: 'A', lastName: 'B', email: 'match@example.com', phone: null }],
  });
  const decision = await evaluatePromotion(NU_EXT, { prisma, overrideLocationId: 'loc-fll' });
  assert.equal(decision.decision, 'AUTO');
  assert.equal(decision.mappedLocation.id, 'loc-fll');
  assert.equal(decision.mappedVehicleCategory, 'FULLSIZE');
});

test('ACRISS mapper: unmapped ACRISS gates to MANUAL_REVIEW even with override', async () => {
  const prisma = fakePrisma({
    acriss: null, // no AcrissCategoryMap row → acriss_unmapped
    customers: [{ id: 'c1', firstName: 'A', lastName: 'B', email: 'match@example.com', phone: null }],
  });
  const decision = await evaluatePromotion(NU_EXT, { prisma, overrideLocationId: 'loc-fll' });
  assert.equal(decision.decision, 'MANUAL_REVIEW');
  assert.equal(decision.reason, REVIEW_REASONS.ACRISS_UNMAPPED);
});

// ---------------------------------------------------------------------------
// 4. date/TZ parsing
// ---------------------------------------------------------------------------
test('combineDateTimeToUtc: M/D/YYYY + 12h time → ET-interpreted UTC instant', () => {
  // 7/9/2026 2:00 PM ET (EDT, UTC-4) → 18:00Z.
  assert.equal(combineDateTimeToUtc('7/9/2026', '2:00 PM').toISOString(), '2026-07-09T18:00:00.000Z');
  // midnight-ish AM handling: 12:30 AM → 00:30 ET → 04:30Z.
  assert.equal(combineDateTimeToUtc('7/9/2026', '12:30 AM').toISOString(), '2026-07-09T04:30:00.000Z');
  // noon: 12:00 PM → 12:00 ET → 16:00Z.
  assert.equal(combineDateTimeToUtc('7/9/2026', '12:00 PM').toISOString(), '2026-07-09T16:00:00.000Z');
  // 2-digit year expands to 20xx.
  assert.equal(combineDateTimeToUtc('7/9/26', '2:00 PM').toISOString(), '2026-07-09T18:00:00.000Z');
});

test('combineDateTimeToUtc: blank time defaults to midnight ET; blank date → null', () => {
  assert.equal(combineDateTimeToUtc('7/9/2026', '').toISOString(), '2026-07-09T04:00:00.000Z');
  assert.equal(combineDateTimeToUtc('', '2:00 PM'), null);
  assert.equal(combineDateTimeToUtc(null, null), null);
});

test('formatNuDate: Date → unpadded M/D/YYYY in ET', () => {
  // Use a UTC instant clearly inside the ET day.
  const d = new Date('2026-07-09T16:00:00Z'); // noon ET
  assert.equal(formatNuDate(d), '7/9/2026');
  const d2 = new Date('2026-12-05T17:00:00Z');
  assert.equal(formatNuDate(d2), '12/5/2026');
});

test('parseMoney: strips $ and commas; blank/garbage → null', () => {
  assert.equal(parseMoney('$1,234.50'), '1234.50');
  assert.equal(parseMoney('249.50'), '249.50');
  assert.equal(parseMoney('$0.00'), '0.00');
  assert.equal(parseMoney(''), null);
  assert.equal(parseMoney('&nbsp;'), null);
  assert.equal(parseMoney(null), null);
});

test('filterByPickupWindow: keeps in-window pickupAt, drops out-of-window + null', () => {
  const rows = [
    { confirmation: 'A', pickupAt: new Date('2026-07-10T12:00:00Z') }, // in
    { confirmation: 'B', pickupAt: new Date('2020-01-01T12:00:00Z') }, // before → drop
    { confirmation: 'C', pickupAt: new Date('2030-01-01T12:00:00Z') }, // after → drop
    { confirmation: 'D', pickupAt: null },                             // null → drop
  ];
  const from = new Date('2026-07-01T00:00:00Z');
  const to = new Date('2026-07-31T23:59:59Z');
  assert.deepEqual(filterByPickupWindow(rows, from, to).map((r) => r.confirmation), ['A']);
  assert.equal(filterByPickupWindow(rows, null, null).length, 4); // no bounds → all
});

// ---------------------------------------------------------------------------
// Per-config date window helpers
// ---------------------------------------------------------------------------
const DAY = 24 * 60 * 60 * 1000;
test('effectiveWindowDays: null override → env defaults; set values win', () => {
  assert.deepEqual(effectiveWindowDays({ lookbackDays: null, lookaheadDays: null }), {
    lookbackDays: DATE_WINDOW_LOOKBACK_DAYS, lookaheadDays: DATE_WINDOW_LOOKAHEAD_DAYS,
  });
  assert.deepEqual(effectiveWindowDays({ lookbackDays: 7, lookaheadDays: 90 }), {
    lookbackDays: 7, lookaheadDays: 90,
  });
});
test('windowBoundsForConfig: resolves [dateFrom, dateTo] around now', () => {
  const now = Date.UTC(2026, 6, 9, 12, 0, 0);
  const { dateFrom, dateTo } = windowBoundsForConfig({ lookbackDays: 2, lookaheadDays: 30 }, now);
  assert.equal(dateFrom.getTime(), now - 2 * DAY);
  assert.equal(dateTo.getTime(), now + 30 * DAY);
});

// ---------------------------------------------------------------------------
// 5. WebForms form scrape + ClientState builder
// ---------------------------------------------------------------------------
test('buildClientState: valid Telerik JSON with the value in every slot', () => {
  const cs = JSON.parse(buildClientState('hunter2'));
  assert.equal(cs.enabled, true);
  assert.equal(cs.emptyMessage, '');
  assert.equal(cs.validationText, 'hunter2');
  assert.equal(cs.valueAsString, 'hunter2');
  assert.equal(cs.lastSetTextBoxValue, 'hunter2');
  // null → empty string, still valid JSON.
  assert.equal(JSON.parse(buildClientState(null)).valueAsString, '');
});

test('radDatePickerOverrides: full coordinated field set for 2026-08-08 (START)', () => {
  // Use a UTC instant clearly inside the ET day so nuDateParts reads 2026-08-08.
  const date = new Date('2026-08-08T16:00:00Z');
  const rules = radDatePickerOverrides('RadDatePickerSTART', date);
  const bySuffix = (suffix) => rules.find((r) => r.suffix === suffix)?.value;

  assert.equal(bySuffix('$RadDatePickerSTART'), '2026-08-08'); // ISO
  assert.equal(bySuffix('$RadDatePickerSTART$dateInput'), '08/8/2026'); // MM/d/yyyy
  assert.equal(
    bySuffix('RadDatePickerSTART_dateInput_ClientState'),
    '{"enabled":true,"emptyMessage":"","validationText":"2026-08-08-00-00-00",'
    + '"valueAsString":"2026-08-08-00-00-00","minDateStr":"1980-01-01-00-00-00",'
    + '"maxDateStr":"2099-12-31-00-00-00","lastSetTextBoxValue":"08/8/2026"}'
  );
  assert.equal(bySuffix('RadDatePickerSTART_calendar_AD'), '[[1980,1,1],[2099,12,30],[2026,8,8]]');
  assert.equal(bySuffix('RadDatePickerSTART_calendar_SD'), '[]');

  // Rules ordered MOST-specific first so the bare picker never clobbers $dateInput.
  assert.equal(rules[0].suffix, '$RadDatePickerSTART$dateInput');
  assert.equal(rules[rules.length - 1].suffix, '$RadDatePickerSTART');
});

test('radDatePickerOverrides: matched by SUFFIX regardless of the ctl00 prefix', () => {
  const date = new Date('2026-08-08T16:00:00Z');
  const rules = radDatePickerOverrides('RadDatePickerSTART', date);
  // A real ClientID-based hidden name (underscore prefix) still matches.
  const adName = 'ctl00_ContentPlaceHolder1_RadDatePickerSTART_calendar_AD';
  const bareName = 'ctl00$ContentPlaceHolder1$RadDatePickerSTART';
  const dateInputName = 'ctl00$ContentPlaceHolder1$RadDatePickerSTART$dateInput';
  const firstMatch = (name) => rules.find((r) => name.endsWith(r.suffix));
  assert.equal(firstMatch(adName).value, '[[1980,1,1],[2099,12,30],[2026,8,8]]');
  assert.equal(firstMatch(bareName).value, '2026-08-08');
  // The $dateInput hidden matches the display rule, NOT the bare-ISO rule.
  assert.equal(firstMatch(dateInputName).value, '08/8/2026');
});

test('parseWebFormsForm: scrapes hidden + visible inputs with values', () => {
  const html = `
    <form action="./AffiliateLOGIN.aspx" method="post">
      <input type="hidden" name="__VIEWSTATE" value="VS-ABC" />
      <input type="hidden" name="__EVENTVALIDATION" value="EV-XYZ" />
      <input type="hidden" name="txtLoginID_ClientState" value="" />
      <input type="text" name="txtLoginID" />
      <input type="password" name="txtPSWD" />
      <input type="submit" name="Button1" value="Submit" />
    </form>`;
  const { action, fields } = parseWebFormsForm(html);
  assert.equal(action, './AffiliateLOGIN.aspx');
  assert.equal(fields.__VIEWSTATE.value, 'VS-ABC');
  assert.equal(fields.__EVENTVALIDATION.value, 'EV-XYZ');
  assert.equal(fields.Button1.type, 'submit');
  assert.equal(fields.Button1.value, 'Submit');
  assert.ok('txtLoginID_ClientState' in fields);
});

// ---------------------------------------------------------------------------
// 6. login + re-login-once (mocked fetch)
// ---------------------------------------------------------------------------
function fakeRes({ status = 200, body = '', setCookie = null, location = null } = {}) {
  const headers = new Map();
  if (location) headers.set('location', location);
  return {
    status,
    headers: {
      get: (k) => (k.toLowerCase() === 'set-cookie'
        ? (Array.isArray(setCookie) ? setCookie.join(', ') : setCookie)
        : headers.get(k.toLowerCase()) ?? null),
      getSetCookie: () => (setCookie ? (Array.isArray(setCookie) ? setCookie : [setCookie]) : []),
    },
    text: async () => body,
  };
}

const LOGIN_HTML = `<form action="./AffiliateLOGIN.aspx" method="post">
  <input type="hidden" name="__VIEWSTATE" value="VS1"/>
  <input type="hidden" name="__EVENTVALIDATION" value="EV1"/>
  <input type="text" name="txtLoginID"/>
  <input type="password" name="txtPSWD"/>
  <input type="submit" name="Button1" value="Submit"/>
</form>`;

const LANDING_HTML = '<html><title>NU Affiliates</title><body>Welcome, dashboard</body></html>';

test('login: fails (NuAuthExpiredError) when no ASP.NET_SessionId appears', async () => {
  _resetCookieJarsForTests();
  __test.setCredentialsResolver(() => ({ username: 'u', password: 'p' }));
  const script = [
    () => fakeRes({ status: 200, body: LOGIN_HTML }),               // GET login
    () => fakeRes({ status: 200, body: 'LoginID Is Required' }),    // POST → no cookie, no redirect
  ];
  let call = 0;
  __test.setFetch(async () => (script[call++] || (() => fakeRes({})))());
  await assert.rejects(() => login('tenant-x'), (err) => err instanceof NuAuthExpiredError);
  __test.setFetch(null);
  __test.setCredentialsResolver(null);
  _resetCookieJarsForTests();
});

test('login: succeeds on 302 chain → non-login landing with a session cookie', async () => {
  _resetCookieJarsForTests();
  __test.setCredentialsResolver(() => ({ username: 'u', password: 'p' }));
  const script = [
    () => fakeRes({ status: 200, body: LOGIN_HTML }),                         // GET login
    () => fakeRes({ status: 302, location: '/AffiliateMAIN.aspx',
      setCookie: 'ASP.NET_SessionId=SESS1; path=/; HttpOnly' }),             // POST → 302 + session
    () => fakeRes({ status: 302, location: '/affiliates.aspx' }),            // MAIN → affiliates
    () => fakeRes({ status: 200, body: LANDING_HTML }),                      // affiliates 200
  ];
  let call = 0;
  __test.setFetch(async () => (script[call++] || (() => fakeRes({ status: 200, body: LANDING_HTML })))());
  const ok = await login('tenant-x');
  assert.equal(ok, true);
  assert.equal(__test.hasSessionCookie('tenant-x'), true);
  __test.setFetch(null);
  __test.setCredentialsResolver(null);
  _resetCookieJarsForTests();
});

test('login: bounce back to AffiliateLOGIN after POST → NuAuthExpiredError', async () => {
  _resetCookieJarsForTests();
  __test.setCredentialsResolver(() => ({ username: 'u', password: 'p' }));
  const script = [
    () => fakeRes({ status: 200, body: LOGIN_HTML }),
    () => fakeRes({ status: 302, location: '/AffiliateLOGIN.aspx',
      setCookie: 'ASP.NET_SessionId=SESS1; path=/' }), // bounced to login
  ];
  let call = 0;
  __test.setFetch(async () => (script[call++] || (() => fakeRes({})))());
  await assert.rejects(() => login('tenant-x'), (err) => err instanceof NuAuthExpiredError);
  __test.setFetch(null);
  __test.setCredentialsResolver(null);
  _resetCookieJarsForTests();
});

test('authedFetch: logs in first, re-logs-in EXACTLY once on a mid-flight bounce', async () => {
  _resetCookieJarsForTests();
  __test.setCredentialsResolver(() => ({ username: 'u', password: 'p' }));
  //  0 login GET     1 login POST 302   2 MAIN→affiliates   3 affiliates 200
  //  4 target GET → 302 bounce to login
  //  5 re-login GET  6 re-login POST 302   7 MAIN→affiliates  8 affiliates 200
  //  9 retry target → 200 OK
  let call = 0;
  const script = [
    () => fakeRes({ status: 200, body: LOGIN_HTML }),
    () => fakeRes({ status: 302, location: '/AffiliateMAIN.aspx', setCookie: 'ASP.NET_SessionId=S1; path=/' }),
    () => fakeRes({ status: 302, location: '/affiliates.aspx' }),
    () => fakeRes({ status: 200, body: LANDING_HTML }),
    () => fakeRes({ status: 302, location: '/AffiliateLOGIN.aspx' }),        // bounce
    () => fakeRes({ status: 200, body: LOGIN_HTML }),
    () => fakeRes({ status: 302, location: '/AffiliateMAIN.aspx', setCookie: 'ASP.NET_SessionId=S2; path=/' }),
    () => fakeRes({ status: 302, location: '/affiliates.aspx' }),
    () => fakeRes({ status: 200, body: LANDING_HTML }),
    () => fakeRes({ status: 200, body: '<html>grid</html>' }),
  ];
  __test.setFetch(async () => (script[call++] || (() => fakeRes({ status: 200, body: 'x' })))());
  const res = await authedFetch('tenant-x', '/affiliates.aspx');
  assert.equal(res.status, 200);
  assert.equal(await res.text(), '<html>grid</html>');
  assert.equal(call, 10);
  __test.setFetch(null);
  __test.setCredentialsResolver(null);
  _resetCookieJarsForTests();
});

test('authedFetch: a SECOND bounce after re-login throws (no infinite loop)', async () => {
  _resetCookieJarsForTests();
  __test.setCredentialsResolver(() => ({ username: 'u', password: 'p' }));
  let call = 0;
  const script = [
    () => fakeRes({ status: 200, body: LOGIN_HTML }),
    () => fakeRes({ status: 302, location: '/AffiliateMAIN.aspx', setCookie: 'ASP.NET_SessionId=S1; path=/' }),
    () => fakeRes({ status: 302, location: '/affiliates.aspx' }),
    () => fakeRes({ status: 200, body: LANDING_HTML }),
    () => fakeRes({ status: 401 }),                                          // target bounce
    () => fakeRes({ status: 200, body: LOGIN_HTML }),
    () => fakeRes({ status: 302, location: '/AffiliateMAIN.aspx', setCookie: 'ASP.NET_SessionId=S2; path=/' }),
    () => fakeRes({ status: 302, location: '/affiliates.aspx' }),
    () => fakeRes({ status: 200, body: LANDING_HTML }),
    () => fakeRes({ status: 401 }),                                          // still bounced
  ];
  __test.setFetch(async () => (script[call++] || (() => fakeRes({ status: 401 })))());
  await assert.rejects(
    () => authedFetch('tenant-x', '/affiliates.aspx'),
    (err) => err instanceof NuAuthExpiredError
  );
  __test.setFetch(null);
  __test.setCredentialsResolver(null);
  _resetCookieJarsForTests();
});

// ---------------------------------------------------------------------------
// 7. field mapper — normalized row → ExternalReservation shape
// ---------------------------------------------------------------------------
test('mapRowToExternalReservation: maps a normalized RadGrid row', () => {
  const [row] = parseRadGrid(RADGRID_FIXTURE);
  const mapped = mapRowToExternalReservation(row, { timeZone: TIME_ZONE });
  assert.equal(mapped.externalRef, '617-0103071-NU');
  assert.equal(mapped.customerFirstName, 'John');
  assert.equal(mapped.customerLastName, 'Doe');
  assert.equal(mapped.vehicleAcriss, 'IFAR');
  assert.equal(mapped.flightNumber, 'B6 2780');
  assert.equal(mapped.totalAmount, '249.50');
  assert.equal(mapped.currency, 'USD');
  assert.equal(mapped.status, 'CONFIRMED');
  assert.equal(mapped.isPrepaid, true);
  assert.equal(mapped.supplierRef, 'US904718150'); // AltConfirmation#
  assert.equal(mapped.customerPhone, '0017168071101'); // phone digits → customer contact
  assert.ok(mapped.pickupAt instanceof Date);
  assert.ok(mapped.dropoffAt instanceof Date);
});

test('mapRowToExternalReservation: blank-code row → isPrepaid=false (pay-at-destination)', () => {
  const rows = parseRadGrid(RADGRID_FIXTURE);
  const mapped = mapRowToExternalReservation(rows[2], { timeZone: TIME_ZONE });
  assert.equal(mapped.externalRef, '617-0103073-NU');
  assert.equal(mapped.isPrepaid, false);
});

// ---------------------------------------------------------------------------
// 8. scheduler master-flag enforcement
// ---------------------------------------------------------------------------
const { masterEnabledFromConfig, enumerateActiveTenants } = await import('./nu.scheduler.js');

test('masterEnabledFromConfig: only { nu: { enabled: true } } counts', () => {
  assert.equal(masterEnabledFromConfig(null), false);
  assert.equal(masterEnabledFromConfig({}), false);
  assert.equal(masterEnabledFromConfig({ nu: {} }), false);
  assert.equal(masterEnabledFromConfig({ nu: { enabled: false } }), false);
  assert.equal(masterEnabledFromConfig({ nu: { enabled: true } }), true);
  assert.equal(masterEnabledFromConfig({ economy: { enabled: true }, nu: { enabled: true } }), true);
});

test('enumerateActiveTenants: excludes a tenant with master enabled=false', async () => {
  const { prisma } = await import('../../../lib/prisma.js');
  const origCred = prisma.integrationCredential.findMany;
  const origCfg = prisma.nuLocationConfig.findMany;
  prisma.integrationCredential.findMany = async () => ([
    { tenantId: 'tenant-on', tenant: { integrationConfig: { nu: { enabled: true } } } },
    { tenantId: 'tenant-off', tenant: { integrationConfig: { nu: { enabled: false } } } },
  ]);
  prisma.nuLocationConfig.findMany = async ({ where }) => where.tenantId.in.map((id) => ({ tenantId: id }));
  try {
    const tenants = await enumerateActiveTenants();
    assert.deepEqual(tenants, ['tenant-on']);
  } finally {
    prisma.integrationCredential.findMany = origCred;
    prisma.nuLocationConfig.findMany = origCfg;
  }
});

test('enumerateActiveTenants: returns [] and skips config query when no master-on tenant', async () => {
  const { prisma } = await import('../../../lib/prisma.js');
  const origCred = prisma.integrationCredential.findMany;
  const origCfg = prisma.nuLocationConfig.findMany;
  prisma.integrationCredential.findMany = async () => ([
    { tenantId: 'tenant-off', tenant: { integrationConfig: { nu: { enabled: false } } } },
  ]);
  let cfgCalled = false;
  prisma.nuLocationConfig.findMany = async ({ where }) => {
    cfgCalled = true;
    return where.tenantId.in.map((id) => ({ tenantId: id }));
  };
  try {
    const tenants = await enumerateActiveTenants();
    assert.deepEqual(tenants, []);
    assert.equal(cfgCalled, false);
  } finally {
    prisma.integrationCredential.findMany = origCred;
    prisma.nuLocationConfig.findMany = origCfg;
  }
});

// ---------------------------------------------------------------------------
// 9. worker: deterministic single-config resolution + isPrepaid stamping
//
// MUST 2 — the worker resolves the enabled NuLocationConfig with
// `orderBy: { createdAt: 'asc' }` (byte-identical to the manual-promote path in
// nu.routes.js), so configs[0] is DETERMINISTIC. If the 1:1 invariant is ever
// breached (>1 enabled), the run is flagged ATTENTION (not a silent random pick).
// MUST 1 — promoteWithMappings stamps the structured isPrepaid boolean onto the
// Reservation (money-adjacent) while keeping the money posture: estimatedTotal
// only, never a charge.
// ---------------------------------------------------------------------------
const { nuSyncHandler, promoteWithMappings } = await import('./nu.worker.js');

test('worker: resolves the enabled config with orderBy createdAt asc (deterministic) and flags ATTENTION when >1 enabled', async () => {
  const { prisma } = await import('../../../lib/prisma.js');
  const origFind = prisma.nuLocationConfig.findMany;
  const origCreate = prisma.externalSyncRun.create;
  const origUpdate = prisma.externalSyncRun.update;
  let capturedArgs = null;
  let updatedStatus = null;
  let updatedNotes = null;
  // Two enabled rows = invariant breach. locationId null → no network fetch, so
  // the run resolves purely on the config query. The worker orders createdAt asc
  // and takes the earliest — the SAME ordering nu.routes.js manual-promote uses.
  prisma.nuLocationConfig.findMany = async (args) => {
    capturedArgs = args;
    return [
      { locationId: null, externalCenter: '100', lookbackDays: null, lookaheadDays: null },
      { locationId: null, externalCenter: '205', lookbackDays: null, lookaheadDays: null },
    ];
  };
  prisma.externalSyncRun.create = async () => ({ id: 'run-multi' });
  prisma.externalSyncRun.update = async ({ data }) => { updatedStatus = data.status; updatedNotes = data.notes; return {}; };
  try {
    const result = await nuSyncHandler({ data: { tenantId: 't-multi', triggeredBy: 'test' } });
    // Determinism: the query the worker builds matches the manual-promote path.
    assert.deepEqual(capturedArgs.where, { tenantId: 't-multi', enabled: true });
    assert.deepEqual(capturedArgs.orderBy, { createdAt: 'asc' });
    // Defensive: >1 enabled → ATTENTION (both the returned status and the persisted run).
    assert.equal(result.status, 'ATTENTION');
    assert.equal(updatedStatus, 'ATTENTION');
    assert.match(updatedNotes || '', /1:1 invariant breached/i);
  } finally {
    prisma.nuLocationConfig.findMany = origFind;
    prisma.externalSyncRun.create = origCreate;
    prisma.externalSyncRun.update = origUpdate;
  }
});

// A small mock tx factory for promoteWithMappings. fresh has no customer name →
// findDuplicateReservation returns null early (no $queryRaw), so we only observe
// the reservation.create payload.
function fakePromoteTx(fresh, onCreate) {
  return {
    externalReservation: {
      findUnique: async () => fresh,
      update: async () => ({ ...fresh, promotionStatus: 'AUTO_PROMOTED' }),
    },
    reservation: {
      findUnique: async () => null,
      create: async ({ data }) => { onCreate(data); return { id: 'res-1', ...data }; },
    },
    vehicleType: { findFirst: async () => null },
  };
}

test('worker: promoteWithMappings stamps isPrepaid=false + keeps the note; MONEY stays estimatedTotal only', async () => {
  const { prisma } = await import('../../../lib/prisma.js');
  const origTx = prisma.$transaction;
  const fresh = {
    id: 'ext-1', tenantId: 't1', externalRef: '617-X-NU',
    promotionStatus: 'PENDING', totalAmount: '249.50', isPrepaid: false,
    customerFirstName: null, customerLastName: null, pickupAt: null, dropoffAt: null,
  };
  let createdData = null;
  prisma.$transaction = async (fn) => fn(fakePromoteTx(fresh, (d) => { createdData = d; }));
  try {
    const out = await promoteWithMappings(fresh, { customerId: 'c1', locationId: 'loc1', isAuto: true });
    assert.equal(createdData.isPrepaid, false);                 // structured pay-at-destination flag
    assert.equal(String(createdData.estimatedTotal), '249.50'); // MONEY: only estimatedTotal
    assert.equal('dailyRate' in createdData, false);            // no rate math, no charge fields
    assert.match(createdData.notes, /pay-at-destination/);      // human note kept too
    assert.ok(out.reservation);
  } finally {
    prisma.$transaction = origTx;
  }
});

test('worker: promoteWithMappings leaves isPrepaid null for a source without the signal (no behavior change, no note)', async () => {
  const { prisma } = await import('../../../lib/prisma.js');
  const origTx = prisma.$transaction;
  const fresh = {
    id: 'ext-2', tenantId: 't1', externalRef: 'TL-999',
    promotionStatus: 'PENDING', totalAmount: '100.00', isPrepaid: null,
    customerFirstName: null, customerLastName: null, pickupAt: null, dropoffAt: null,
  };
  let createdData = null;
  prisma.$transaction = async (fn) => fn(fakePromoteTx(fresh, (d) => { createdData = d; }));
  try {
    await promoteWithMappings(fresh, { customerId: 'c1', locationId: 'loc1', isAuto: true });
    assert.equal(createdData.isPrepaid, null);                  // null → no franchise-prepaid badge
    assert.doesNotMatch(createdData.notes, /pay-at-destination/); // only false triggers the marker
  } finally {
    prisma.$transaction = origTx;
  }
});
