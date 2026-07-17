/**
 * Advantage (TSD RezCentral) integration — unit tests.
 *
 * Pure: fetch/prisma are NEVER hit (fixtures only, never the live portal). The
 * fixtures reproduce the REAL shapes captured in the Fase 0 recon (2026-07-14),
 * including the exact sample rows quoted in
 * doc/advantage-integration-plan-2026-07-13.md.
 *
 * Covers the correctness-critical pieces:
 *   1. `*Estimated T&M Summary` grid parser — the real 18-column header + the
 *      real row, PLUS a Cancelled row and a No Show row (the two shapes that
 *      encode status WITHOUT a Status column).
 *   2. Header-name column resolution + the layout-drift guard (a missing
 *      required column must THROW, not import a shifted mapping).
 *   3. `Loc` = "61302.MCO" → { tsdNumber, branch }.
 *   4. ACRISS extraction from the inline Class column (no detail fetch).
 *   5. TSD "YYYY/MM/DD" date parsing → Eastern wall-clock → UTC instant.
 *   6. Email Address Report parse + the join-by-Confirm (incl. the ~50%
 *      coverage case: a T&M row with no matching email row).
 *   7. mapRowToExternalReservation — Total Bill → totalAmount, isPrepaid=false,
 *      rateCode/PNR/CD in rawJson, and the NO-EMAIL → phone-placeholder path
 *      (Hector's decision A) that lets the SHARED auto-create helper make a
 *      DISTINCT customer per booking instead of merging them by a fake email.
 *   8. The cancelled/no-show rows are not promotable + map to a reject reason.
 *   9. WebForms plumbing: form scrape (inputs + selects), suffix-keyed override
 *      body, image-button login coords, menu-postback argument.
 *  10. sourceSpec wired into the SHARED promoter (ADV- prefix, pay-at-destination).
 *  11. window helpers delegate to the shared booking-source factory.
 *
 * Promotion/dedup/crypto/auto-create logic is reused UNCHANGED from
 * booking-source/ (covered by test:booking-source + TL/Economy/NU/Flexways) so it
 * is not re-tested here.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

process.env.INTEGRATION_ENC_KEY = crypto.randomBytes(32).toString('base64');

const {
  SOURCE_SYSTEM,
  BOOKING_CHANNEL,
  RESERVATION_PREFIX,
  QUEUE_NAME,
  TIME_ZONE,
  STATUS,
  TM_EXPECTED_COLUMN_COUNT,
  EMAIL_EXPECTED_COLUMN_COUNT,
  MENU_EVENT_TARGET,
  MENU_PATH_TM_SUMMARY,
  REPORT,
  FIELD,
  CAL_TARGET,
  RUN_BY,
  RUN_BY_VALUE,
  RANGE_MODES,
  DEFAULT_RANGE_MODE,
  normalizeRangeMode,
  toIsoFromTsdDate,
  toCalendarDaySerial,
  fromCalendarDaySerial,
  toMonthOptionLabel,
  mtdCoverageBounds,
  effectiveWindowDays,
  windowBoundsForConfig,
} = await import('./advantage.constants.js');

const {
  cellText,
  headerKey,
  parseWebFormsForm,
  decodeEntities,
  buildPostBody,
  buildCalendarPostBody,
  eventTargetFor,
  namingContainerOf,
  parseSelectOptions,
  findOptionValueByLabel,
  selectedOptionOf,
  fieldSuffix,
  findFieldName,
  reportOverrides,
  rangeCoverage,
  extractGridHtml,
  parseGridTable,
  footerRowCount,
  missingHeaders,
  parseTMSummary,
  parseEmailReport,
  joinEmailsByConfirm,
  filterByPickupWindow,
  dateRangeOf,
  parseLoc,
  splitName,
  parseAmount,
  tsdDateToUtc,
  deriveStatus,
  extractAcriss,
  fetchTMSummary,
  __test,
  AdvantageLayoutError,
} = await import('./advantage.service.js');

const {
  mapRowToExternalReservation,
  isPromotableStatus,
  rejectReasonForStatus,
  REJECT_REASONS,
} = await import('./advantage.worker.js');

const { CUSTOMER_PHONE_PLACEHOLDER } = await import('../booking-source/customer-autocreate.js');

// ---------------------------------------------------------------------------
// Fixtures — the REAL recon shapes.
// ---------------------------------------------------------------------------

const TM_HEADERS = [
  'Confirm #', 'Name', 'Loc', 'Date Out', 'Date In', 'Booked', 'Class', 'Days', 'IATA',
  'Total Rate', 'Total Tax', 'Total Bill', 'Date Cancelled', 'Rate Code', 'PNR', 'Source',
  'CD', 'PO/BR',
];

// The verbatim row from the recon doc.
const TM_ROW_LIVE = [
  'A1TL012880', 'DAVOOD ASHRAFISISI', '61302.MCO', '2026/07/04', '2026/07/10', '2026/05/04',
  'ECAR', '6', '33895934', '101.16', '22.69', '135.85', '', 'D6', 'A6D994', 'AMADEUS',
  'AD0016', '',
];
// A cancelled booking (MEASURED 2026-07-17): Date Cancelled populated — with a
// TIMESTAMP, not a bare date — AND Total Rate = "Cancelled". Note `Total Bill`
// keeps a REAL, NON-ZERO amount: 112 of 590 live rows look exactly like this.
// Modelled on `A1TL0128C1 | cancelled 2026/07/01 02:31 | Total Bill 130.98`.
const TM_ROW_CANCELLED = [
  'B2XY045511', 'SMITH, JOHN', '61302.MCO', '2026/07/09', '2026/07/12', '2026/06/01',
  'FFAR', '', '07560685', 'Cancelled', '', '130.98', '2026/07/01 02:31', 'D4', 'PNR123',
  'SABRE', 'AD0012', '',
];
// A no-show: Total Rate = "No Show". Also carries a live-looking Total Bill.
const TM_ROW_NO_SHOW = [
  'C3ZZ099122', 'DOE, JANE', '61302.MCO', '2026/07/05', '2026/07/08', '2026/06/15',
  'MVAR', '', 'WebLink', 'No Show', '', '252.00', '2026/07/05 15:41', 'MBRD1', 'PNR456',
  'WEBLINK', '', '',
];

function td(v) { return `<td>${v === '' ? '&nbsp;' : v}</td>`; }
function tr(cells) { return `<tr>${cells.map(td).join('')}</tr>`; }

/**
 * Render a dgRates DataGrid the way TSD really does.
 *
 * `footer: true` appends the REAL footer row measured 2026-07-17: cell 0 is the
 * literal "Rows: N" and cells 1..17 REPEAT THE HEADER LABELS. The live run was
 * 592 <tr> = 1 header + 590 data + 1 footer.
 */
function gridHtml(headers, rows, { idSuffix = 'dgRates', footer = false } = {}) {
  const footerRow = footer
    ? tr([`Rows: ${rows.length}`, ...headers.slice(1)])
    : '';
  return `
    <html><body><form name="Form1" method="post" action="WebRezClient.aspx">
      <input type="hidden" name="__VIEWSTATE" value="/wEPDwUKMTIz" />
      <table id="_ctl0_cphMaster1_${idSuffix}" cellspacing="0" border="1">
        <tr>${headers.map((h) => `<th>${h}</th>`).join('')}</tr>
        ${rows.map(tr).join('')}
        ${footerRow}
      </table>
    </form></body></html>`;
}

const EMAIL_HEADERS = ['Email Address', 'Confirm', 'Name', 'Branch', 'Pickup', 'Return', 'Class'];
const EMAIL_ROWS = [
  ['davood@example.com', 'A1TL012880', 'DAVOOD ASHRAFISISI', 'MCO', '2026/07/04', '2026/07/10', 'ECAR'],
  // NOTE: no row for C3ZZ099122 → the ~50%-coverage case.
  ['jsmith@example.com', 'B2XY045511', 'SMITH, JOHN', 'MCO', '2026/07/09', '2026/07/12', 'FFAR'],
];

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

test('constants: source identity is ADVANTAGE / FRANCHISE_ADVANTAGE / ADV-', () => {
  assert.equal(SOURCE_SYSTEM, 'ADVANTAGE');
  assert.equal(BOOKING_CHANNEL, 'FRANCHISE_ADVANTAGE');
  assert.equal(RESERVATION_PREFIX, 'ADV-');
  assert.equal(QUEUE_NAME, 'advantage.sync');
  assert.equal(TIME_ZONE, 'America/New_York');
  assert.equal(TM_EXPECTED_COLUMN_COUNT, 18);
  assert.equal(EMAIL_EXPECTED_COLUMN_COUNT, 7);
});

test('constants: the report IS the menu path — there is no cmbReport', () => {
  assert.equal(MENU_EVENT_TARGET, '_ctl0$Menu1');
  // Backslash path — the single-window menu argument.
  assert.equal(MENU_PATH_TM_SUMMARY, 'Reports POS\\Estimated T&M Summary');
  assert.equal(REPORT.TM_SUMMARY.menuPath, MENU_PATH_TM_SUMMARY);
  // VALIDATED-FALSE 2026-07-17: the live form has NO cmbReport control. Nothing
  // may reintroduce it as a driven field.
  assert.equal(FIELD.REPORT, undefined);
  assert.equal(Object.values(FIELD).includes('cmbReport'), false);
});

// ---------------------------------------------------------------------------
// Date + cell helpers
// ---------------------------------------------------------------------------

test('toIsoFromTsdDate: YYYY/MM/DD is unambiguous (date-only → midnight)', () => {
  assert.equal(toIsoFromTsdDate('2026/07/04'), '2026-07-04T00:00:00');
  // The Create/Cancel grid's datetime shape is tolerated by the same helper.
  assert.equal(toIsoFromTsdDate('2026/10/30 10:00'), '2026-10-30T10:00:00');
  assert.equal(toIsoFromTsdDate(''), null);
  assert.equal(toIsoFromTsdDate('not a date'), null);
});

test('tsdDateToUtc: a July date is read as EASTERN wall-clock, not UTC', () => {
  const d = tsdDateToUtc('2026/07/04');
  // 2026-07-04 00:00 EDT (UTC-4) === 2026-07-04T04:00:00Z.
  assert.equal(d.toISOString(), '2026-07-04T04:00:00.000Z');
});

test('toCalendarDaySerial: the ASP.NET Calendar argument is days since 2000-01-01', () => {
  // THE anchor, verified against the live DOM: __doPostBack('…$CalFrom','9716')
  // selects 2026-08-08 (the August spill-over cell in July's grid).
  assert.equal(toCalendarDaySerial(new Date('2026-08-08T12:00:00Z')), '9716');
  assert.equal(fromCalendarDaySerial('9716'), '2026-08-08');
  // The epoch itself.
  assert.equal(toCalendarDaySerial(new Date('2000-01-01T12:00:00Z')), '0');
  assert.equal(toCalendarDaySerial(new Date('invalid')), '');
});

test('toCalendarDaySerial: the serial is the PORTAL wall-clock day, not the UTC day', () => {
  // 03:00Z on Jul 5 is still Jul 4 in Orlando. Computing this in UTC would post
  // the NEXT day's cell — an off-by-one on the window bound, every night.
  assert.equal(fromCalendarDaySerial(toCalendarDaySerial(new Date('2026-07-05T03:00:00Z'))), '2026-07-04');
  // And in winter (EST, UTC-5) the same holds.
  assert.equal(fromCalendarDaySerial(toCalendarDaySerial(new Date('2026-01-05T04:00:00Z'))), '2026-01-04');
});

test('toMonthOptionLabel: matches the measured "Jul 2026" option format', () => {
  assert.equal(toMonthOptionLabel(new Date('2026-07-15T12:00:00Z')), 'Jul 2026');
  // Portal-timezone again: 03:00Z Aug 1 is still July 31 in Orlando.
  assert.equal(toMonthOptionLabel(new Date('2026-08-01T03:00:00Z')), 'Jul 2026');
});

test('mtdCoverageBounds: Current MTD = the 1st → today, in portal wall-clock', () => {
  // Measured: on a 2026-07-17 run the shortcut set CalFrom=Jul 1, CalTo=Jul 17.
  const { from, to } = mtdCoverageBounds(Date.parse('2026-07-17T16:00:00Z'));
  assert.equal(from.toISOString(), '2026-07-01T04:00:00.000Z');  // Jul 1 00:00 EDT
  assert.equal(to.toISOString(), '2026-07-18T03:59:59.000Z');    // Jul 17 23:59 EDT
});

test('cellText strips tags/entities and collapses whitespace', () => {
  assert.equal(cellText('<span>  A1TL012880 </span>&nbsp;'), 'A1TL012880');
  assert.equal(cellText('R&amp;R  Rentals'), 'R&R Rentals');
  assert.equal(cellText(null), '');
});

test('headerKey normalizes labels to a lookup key', () => {
  assert.equal(headerKey('Confirm #'), 'confirm');
  assert.equal(headerKey('Date Out'), 'dateout');
  assert.equal(headerKey('PO/BR'), 'pobr');
  assert.equal(headerKey('Total Bill'), 'totalbill');
});

test('parseAmount: money cells parse; the Cancelled/No Show literals do NOT', () => {
  assert.equal(parseAmount('135.85'), 135.85);
  assert.equal(parseAmount('$1,234.50'), 1234.50);
  assert.equal(parseAmount('Cancelled'), null);
  assert.equal(parseAmount('No Show'), null);
  assert.equal(parseAmount(''), null);
});

test('parseLoc splits the TSD account from the branch', () => {
  assert.deepEqual(parseLoc('61302.MCO'), { tsdNumber: '61302', branch: 'MCO' });
  assert.deepEqual(parseLoc(' 42823.MCOA01 '), { tsdNumber: '42823', branch: 'MCOA01' });
  assert.deepEqual(parseLoc('garbage'), { tsdNumber: null, branch: null });
  assert.deepEqual(parseLoc(''), { tsdNumber: null, branch: null });
});

test('splitName handles both TSD shapes (comma-less and "LAST, FIRST")', () => {
  // T&M shape (comma-less): first token is the given name.
  assert.deepEqual(splitName('DAVOOD ASHRAFISISI'), { firstName: 'DAVOOD', lastName: 'ASHRAFISISI' });
  // Create/Cancel shape: "LAST, FIRST".
  assert.deepEqual(splitName('FRAZIER, WILLIAM'), { firstName: 'WILLIAM', lastName: 'FRAZIER' });
  assert.deepEqual(splitName('CHER'), { firstName: 'CHER', lastName: null });
  assert.deepEqual(splitName(''), { firstName: null, lastName: null });
});

test('extractAcriss accepts a 4-letter class, rejects anything else (→ MANUAL_REVIEW)', () => {
  assert.equal(extractAcriss('ECAR'), 'ECAR');
  assert.equal(extractAcriss(' scar '), 'SCAR');
  assert.equal(extractAcriss(''), null);
  assert.equal(extractAcriss('E'), null);
});

// ---------------------------------------------------------------------------
// Status derivation — the feed has NO Status column.
// ---------------------------------------------------------------------------

test('deriveStatus: both cancel signals, independently', () => {
  assert.equal(deriveStatus({ totalRateRaw: '101.16', dateCancelledRaw: '' }), STATUS.CONFIRMED);
  assert.equal(deriveStatus({ totalRateRaw: 'Cancelled', dateCancelledRaw: '2026/06/20' }), STATUS.CANCELLED);
  assert.equal(deriveStatus({ totalRateRaw: 'No Show', dateCancelledRaw: '2026/07/05' }), STATUS.NO_SHOW);
  // Either signal ALONE is enough — a live-looking rate with a cancel date is
  // still cancelled (never promote a dead booking).
  assert.equal(deriveStatus({ totalRateRaw: '101.16', dateCancelledRaw: '2026/06/20' }), STATUS.CANCELLED);
  assert.equal(deriveStatus({ totalRateRaw: 'Cancelled', dateCancelledRaw: '' }), STATUS.CANCELLED);
});

// ---------------------------------------------------------------------------
// T&M grid parser
// ---------------------------------------------------------------------------

test('parseTMSummary: the real recon row maps every field', () => {
  const rows = parseTMSummary(gridHtml(TM_HEADERS, [TM_ROW_LIVE]));
  assert.equal(rows.length, 1);
  const r = rows[0];
  assert.equal(r.externalRef, 'A1TL012880');
  assert.equal(r.customerFirstName, 'DAVOOD');
  assert.equal(r.customerLastName, 'ASHRAFISISI');
  assert.equal(r.loc, '61302.MCO');
  assert.equal(r.tsdNumber, '61302');
  assert.equal(r.branch, 'MCO');
  assert.equal(r.pickupAt.toISOString(), '2026-07-04T04:00:00.000Z');
  assert.equal(r.dropoffAt.toISOString(), '2026-07-10T04:00:00.000Z');
  assert.equal(r.bookedAt.toISOString(), '2026-05-04T04:00:00.000Z');
  // ACRISS is INLINE — no detail fetch (the whole point vs Flexways).
  assert.equal(r.acriss, 'ECAR');
  assert.equal(r.days, 6);
  assert.equal(r.iata, '33895934');
  assert.equal(r.totalRate, 101.16);
  assert.equal(r.totalTax, 22.69);
  assert.equal(r.totalBill, 135.85);   // → estimatedTotal
  assert.equal(r.cancelledAt, null);
  assert.equal(r.status, STATUS.CONFIRMED);
  assert.equal(r.rateCode, 'D6');
  assert.equal(r.pnr, 'A6D994');
  assert.equal(r.source, 'AMADEUS');
  assert.equal(r.cd, 'AD0016');
  assert.equal(rows.diagnostics.gridPresent, true);
  assert.equal(rows.diagnostics.parsedRows, 1);
  assert.equal(rows.diagnostics.emptyGridAnomaly, false);
});

test('parseTMSummary: Cancelled + No Show rows derive their status from the two carriers', () => {
  const rows = parseTMSummary(gridHtml(TM_HEADERS, [TM_ROW_LIVE, TM_ROW_CANCELLED, TM_ROW_NO_SHOW]));
  assert.equal(rows.length, 3);
  const byRef = Object.fromEntries(rows.map((r) => [r.externalRef, r]));

  const cancelled = byRef.B2XY045511;
  assert.equal(cancelled.status, STATUS.CANCELLED);
  assert.equal(cancelled.totalRate, null);          // "Cancelled" is not an amount
  assert.equal(cancelled.totalRateRaw, 'Cancelled');
  // MEASURED 2026-07-17: `Total Bill` is NOT zeroed on cancel — 112 of 590 rows
  // are cancelled and carry a real amount. The status carriers are the ONLY thing
  // standing between that number and a promoted reservation's estimatedTotal.
  assert.equal(cancelled.totalBill, 130.98);
  // `Date Cancelled` carries a TIMESTAMP, not a bare date.
  assert.equal(cancelled.cancelledAt.toISOString(), '2026-07-01T06:31:00.000Z');
  assert.equal(cancelled.dateCancelledRaw, '2026/07/01 02:31');
  assert.equal(cancelled.customerFirstName, 'JOHN');
  assert.equal(cancelled.customerLastName, 'SMITH');

  const noShow = byRef.C3ZZ099122;
  assert.equal(noShow.status, STATUS.NO_SHOW);
  assert.equal(noShow.totalRateRaw, 'No Show');
  assert.equal(noShow.days, null);                  // empty on dead rows
});

test('parseTMSummary: a row without a Confirm # is skipped', () => {
  const ghost = [...TM_ROW_LIVE];
  ghost[0] = '';
  const rows = parseTMSummary(gridHtml(TM_HEADERS, [ghost]));
  assert.equal(rows.length, 0);
  // Rows rendered but none usable → a format break, not a clean empty window.
  assert.equal(rows.diagnostics.emptyGridAnomaly, true);
});

test('parseTMSummary: columns resolve BY NAME — an inserted column does not shift the mapping', () => {
  // TSD adds a "Notes" column in the middle. A positional parser would read
  // Total Bill out of the wrong cell (corrupt MONEY); a name-keyed one cannot.
  const headers = [...TM_HEADERS];
  const row = [...TM_ROW_LIVE];
  headers.splice(3, 0, 'Notes');
  row.splice(3, 0, 'some note');
  const rows = parseTMSummary(gridHtml(headers, [row]));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].totalBill, 135.85);
  assert.equal(rows[0].acriss, 'ECAR');
  assert.equal(rows[0].pickupAt.toISOString(), '2026-07-04T04:00:00.000Z');
});

test('parseTMSummary: a MISSING required column THROWS instead of importing a shifted mapping', () => {
  const headers = TM_HEADERS.filter((h) => h !== 'Total Bill');
  const row = TM_ROW_LIVE.filter((_, i) => i !== 11);
  assert.throws(
    () => parseTMSummary(gridHtml(headers, [row])),
    (err) => err instanceof AdvantageLayoutError && /totalbill/i.test(err.message)
  );
});

test('parseTMSummary: no dgRates grid → empty + gridPresent false (no throw)', () => {
  const rows = parseTMSummary('<html><body><p>Session timeout</p></body></html>');
  assert.equal(rows.length, 0);
  assert.equal(rows.diagnostics.gridPresent, false);
});

// ---------------------------------------------------------------------------
// The FOOTER ROW trap (measured 2026-07-17).
// ---------------------------------------------------------------------------

test('FOOTER: the "Rows: N" footer is NOT imported as a booking', () => {
  // ⚠️ REGRESSION PIN. The real grid's last <tr> is a footer: cell 0 reads
  // "Rows: 590" and cells 1-17 repeat the HEADER LABELS. A header-name-keyed
  // parser does not crash on it — it stages a garbage booking with externalRef
  // "Rows: 2", pickup "Date Out" (unparseable → null) and no money.
  const rows = parseTMSummary(gridHtml(TM_HEADERS, [TM_ROW_LIVE, TM_ROW_CANCELLED], { footer: true }));
  assert.equal(rows.length, 2, 'the footer must not become a third record');
  assert.deepEqual(rows.map((r) => r.externalRef), ['A1TL012880', 'B2XY045511']);
  assert.equal(rows.some((r) => /^Rows:/i.test(r.externalRef)), false);
});

test('FOOTER: "Rows: N" is the SERVER\'s own count → cross-checks what we parsed', () => {
  const rows = parseTMSummary(gridHtml(TM_HEADERS, [TM_ROW_LIVE, TM_ROW_CANCELLED], { footer: true }));
  assert.equal(rows.diagnostics.footerCount, 2);
  assert.equal(rows.diagnostics.parsedRows, 2);
  // Nothing the server sent was dropped.
  assert.equal(rows.diagnostics.unparsedRows, 0);

  // A Confirm-less row IS a drop, and the footer is what makes it visible: the
  // server says 2, we parsed 1.
  const ghost = [...TM_ROW_CANCELLED];
  ghost[0] = '';
  const dropped = parseTMSummary(gridHtml(TM_HEADERS, [TM_ROW_LIVE, ghost], { footer: true }));
  assert.equal(dropped.length, 1);
  assert.equal(dropped.diagnostics.footerCount, 2);
  assert.equal(dropped.diagnostics.unparsedRows, 1);
});

test('FOOTER: footerRowCount recognizes the footer by its "Rows: N" cell only', () => {
  assert.equal(footerRowCount(['Rows: 590', 'Name', 'Loc']), 590);
  assert.equal(footerRowCount(['Rows: 1,234']), 1234);
  assert.equal(footerRowCount([' rows : 12 ']), 12);
  // A real booking is never mistaken for it.
  assert.equal(footerRowCount(TM_ROW_LIVE), null);
  assert.equal(footerRowCount(['Rows']), null);
  assert.equal(footerRowCount([]), null);
  // No footer → null count, and unparsedRows makes no claim.
  const noFooter = parseTMSummary(gridHtml(TM_HEADERS, [TM_ROW_LIVE]));
  assert.equal(noFooter.diagnostics.footerCount, null);
  assert.equal(noFooter.diagnostics.unparsedRows, null);
});

test('extractGridHtml / parseGridTable / missingHeaders', () => {
  const html = gridHtml(TM_HEADERS, [TM_ROW_LIVE]);
  const table = extractGridHtml(html);
  assert.ok(table && table.includes('_ctl0_cphMaster1_dgRates'));
  const { headerIndex, dataRows } = parseGridTable(table);
  assert.equal(headerIndex.confirm, 0);
  assert.equal(headerIndex.totalbill, 11);
  assert.equal(headerIndex.pobr, 17);
  assert.equal(dataRows.length, 1);
  assert.deepEqual(missingHeaders(headerIndex, ['confirm', 'totalbill']), []);
  assert.deepEqual(missingHeaders(headerIndex, ['confirm', 'nope']), ['nope']);
});

// ---------------------------------------------------------------------------
// Email report + join
// ---------------------------------------------------------------------------

test('parseEmailReport: parses the 7-column grid and drops rows missing the join key', () => {
  const rows = parseEmailReport(gridHtml(EMAIL_HEADERS, [
    ...EMAIL_ROWS,
    ['orphan@example.com', '', 'NO CONFIRM', 'MCO', '2026/07/01', '2026/07/02', 'CCAR'],
  ]));
  assert.equal(rows.length, 2);
  assert.equal(rows[0].confirm, 'A1TL012880');
  assert.equal(rows[0].email, 'davood@example.com');
});

test('joinEmailsByConfirm: joins by Confirm and leaves ~50%-coverage rows at null', () => {
  const tm = parseTMSummary(gridHtml(TM_HEADERS, [TM_ROW_LIVE, TM_ROW_CANCELLED, TM_ROW_NO_SHOW]));
  const emails = parseEmailReport(gridHtml(EMAIL_HEADERS, EMAIL_ROWS));
  const joined = joinEmailsByConfirm(tm, emails);

  assert.equal(joined.length, 3);
  const byRef = Object.fromEntries(joined.map((r) => [r.externalRef, r]));
  assert.equal(byRef.A1TL012880.customerEmail, 'davood@example.com');
  assert.equal(byRef.B2XY045511.customerEmail, 'jsmith@example.com');
  // No email row for this booking — expected, NOT an error. Never invented.
  assert.equal(byRef.C3ZZ099122.customerEmail, null);
  assert.equal(joined.diagnostics.emailsMatched, 2);
  // The join must not mutate the T&M rows nor lose their fields.
  assert.equal(byRef.A1TL012880.totalBill, 135.85);
  assert.equal(tm[0].customerEmail, undefined);
});

test('joinEmailsByConfirm: an empty email report leaves every row at null email', () => {
  const tm = parseTMSummary(gridHtml(TM_HEADERS, [TM_ROW_LIVE]));
  const joined = joinEmailsByConfirm(tm, []);
  assert.equal(joined[0].customerEmail, null);
  assert.equal(joined.diagnostics.emailsMatched, 0);
});

// ---------------------------------------------------------------------------
// Window filter
// ---------------------------------------------------------------------------

test('filterByPickupWindow keeps in-window pickups and drops undated rows', () => {
  const rows = [
    { externalRef: 'A', pickupAt: new Date('2026-07-04T04:00:00Z') },
    { externalRef: 'B', pickupAt: new Date('2026-09-01T04:00:00Z') },
    { externalRef: 'C', pickupAt: null },
  ];
  const kept = filterByPickupWindow(rows, new Date('2026-07-01T00:00:00Z'), new Date('2026-08-01T00:00:00Z'));
  assert.deepEqual(kept.map((r) => r.externalRef), ['A']);
  // No window → untouched.
  assert.equal(filterByPickupWindow(rows, null, null).length, 3);
});

test('window helpers delegate to the shared booking-source factory', () => {
  assert.deepEqual(effectiveWindowDays({}), { lookbackDays: 2, lookaheadDays: 30 });
  assert.deepEqual(
    effectiveWindowDays({ lookbackDays: 5, lookaheadDays: null }),
    { lookbackDays: 5, lookaheadDays: 30 }
  );
  const now = Date.parse('2026-07-16T12:00:00Z');
  const { dateFrom, dateTo } = windowBoundsForConfig({ lookbackDays: 1, lookaheadDays: 2 }, now);
  assert.equal(dateFrom.toISOString(), '2026-07-15T12:00:00.000Z');
  assert.equal(dateTo.toISOString(), '2026-07-18T12:00:00.000Z');
});

// ---------------------------------------------------------------------------
// WebForms plumbing
// ---------------------------------------------------------------------------

const LOGIN_HTML = `
<html><body>
  <form name="Form1" method="post" action="WebLogin.aspx" id="Form1">
    <input type="hidden" name="__VIEWSTATE" value="/wEPDwUKMTIzNDU2Nzg5" />
    <input type="hidden" name="__VIEWSTATEGENERATOR" value="CA0B0334" />
    <input name="txtUserID" type="text" id="txtUserID" />
    <input name="txtPwd" type="password" id="txtPwd" />
    <input type="image" name="imgLogin" id="imgLogin" src="images/login.gif" />
  </form>
</body></html>`;

/**
 * The report screen (rcEstimatedTM.aspx) as MEASURED 2026-07-17 off the live DOM.
 *
 * Everything that used to be wrong about this fixture is the point of it:
 *   - there is NO cmbReport (the menu path is the report selector);
 *   - CalFrom/CalTo are Calendar SERVER CONTROLS — <table>s with day cells whose
 *     links are __doPostBack('_ctl0$cphMaster1$CalFrom','<days since 2000-01-01>')
 *     — NOT text inputs. `document.forms[0].elements` holds no CalFrom/CalTo, so
 *     neither does this fixture;
 *   - lstRunBy exists and picks the date column to range on;
 *   - cmdMonthTD is a PLAIN submit, and only SETS the range;
 *   - chkSummary is present and UNCHECKED.
 */
const REPORT_SCREEN_HTML = renderReportScreen();

function calendarTable(id, monthLabel) {
  // Day cells, the way an ASP.NET Calendar renders them. The serials are real:
  // 9693 = 2026-07-16, 9716 = 2026-08-08 (the August spill-over cell in July).
  return `
    <table id="_ctl0_cphMaster1_${id}" class="calendar" cellspacing="0" border="0">
      <tr><td colspan="7">${monthLabel}</td></tr>
      <tr>
        <td><a href="javascript:__doPostBack('_ctl0$cphMaster1$${id}','9693')">16</a></td>
        <td><a href="javascript:__doPostBack('_ctl0$cphMaster1$${id}','9716')">8</a></td>
      </tr>
    </table>`;
}

function renderReportScreen({
  fromMonth = 'Jul 2026', toMonth = 'Jul 2026', runBy = 'Date Out', summaryChecked = false,
} = {}) {
  const monthOptions = (selected) => ['Jun 2026', 'Jul 2026', 'Aug 2026']
    .map((m) => `<option value="${m}"${m === selected ? ' selected' : ''}>${m}</option>`)
    .join('');
  return `
<html><body>
  <form name="Form1" method="post" action="WebRezClient.aspx" id="Form1">
    <input type="hidden" name="__EVENTTARGET" value="" />
    <input type="hidden" name="__EVENTARGUMENT" value="" />
    <input type="hidden" name="__VIEWSTATE" value="/wEPDwUJODY3NTMwOQ==" />
    <input type="hidden" name="__VIEWSTATEGENERATOR" value="DBB9B394" />
    <select name="_ctl0:cphMaster1:lstTSDNumber" multiple>
      <option value="42823">42823</option>
      <option value="61302" selected>61302</option>
    </select>
    <select name="_ctl0:cphMaster1:lstBranch" multiple>
      <option value="ALL">ALL</option>
      <option value="MCO" selected>MCO</option>
    </select>
    <select name="_ctl0:cphMaster1:lstClass" multiple>
      <option value="*ALL" selected>*ALL</option>
      <option value="ECAR">ECAR</option>
    </select>
    <select name="_ctl0:cphMaster1:lstRunBy">
      <option value="Date Booked"${runBy === 'Date Booked' ? ' selected' : ''}>Date Booked</option>
      <option value="Date Out"${runBy === 'Date Out' ? ' selected' : ''}>Date Out</option>
      <option value="Date In"${runBy === 'Date In' ? ' selected' : ''}>Date In</option>
    </select>
    <select name="_ctl0:cphMaster1:lstFromMonth">${monthOptions(fromMonth)}</select>
    <select name="_ctl0:cphMaster1:lstToMonth">${monthOptions(toMonth)}</select>
    <input type="checkbox" name="_ctl0:cphMaster1:chkSummary"${summaryChecked ? ' checked' : ''} />
    <input type="checkbox" name="_ctl0:cphMaster1:chkPrepaid" />
    ${calendarTable('CalFrom', fromMonth)}
    ${calendarTable('CalTo', toMonth)}
    <input type="submit" name="_ctl0:cphMaster1:Button1" value="Submit" id="_ctl0_cphMaster1_Button1" />
    <input type="submit" name="_ctl0:cphMaster1:cmdMonthTD" value="Current MTD" />
    <input type="submit" name="_ctl0:cphMaster1:btnToday" value="Today" />
    <input type="submit" name="_ctl0:cphMaster1:cmdLastMonth" value="Last Month" />
  </form>
</body></html>`;
}

test('parseWebFormsForm: scrapes hidden inputs WITH values + each select\'s selected option', () => {
  const { action, fields } = parseWebFormsForm(REPORT_SCREEN_HTML);
  assert.equal(action, 'WebRezClient.aspx');
  assert.equal(fields.__VIEWSTATE.value, '/wEPDwUJODY3NTMwOQ==');
  assert.equal(fields.__VIEWSTATEGENERATOR.value, 'DBB9B394');
  assert.equal(fields['_ctl0:cphMaster1:lstTSDNumber'].value, '61302'); // bare `selected`
  assert.equal(fields['_ctl0:cphMaster1:lstRunBy'].value, 'Date Out');
  // A filter we don't drive keeps its scraped *ALL default.
  assert.equal(fields['_ctl0:cphMaster1:lstClass'].value, '*ALL');
  // The CALENDARS are <table>s, not inputs — the form has no such elements, which
  // is the whole reason `CalFrom=07/01/2026` was a no-op against the live server.
  assert.equal(fields['_ctl0:cphMaster1:CalFrom'], undefined);
  assert.equal(fields['_ctl0:cphMaster1:CalTo'], undefined);
  // An UNCHECKED checkbox is not submitted by a browser and is not scraped.
  assert.equal(fields['_ctl0:cphMaster1:chkSummary'], undefined);
});

test('decodeEntities: attribute values round-trip decoded, viewstate blobs untouched', () => {
  // The report's own name is the real case: the ampersand in "Estimated T&M
  // Summary" renders as "&amp;" wherever the portal echoes it, and posting the raw
  // "&amp;" back would send a string the server has never heard of.
  assert.equal(decodeEntities('*Estimated T&amp;M Summary'), '*Estimated T&M Summary');
  assert.equal(decodeEntities('&lt;b&gt;'), '<b>');
  // &amp; must decode LAST — "&amp;lt;" is a literal "&lt;", not a "<".
  assert.equal(decodeEntities('&amp;lt;'), '&lt;');
  // A base64 viewstate must survive byte-for-byte (whitespace/case/+/=/ intact).
  const vs = '/wEPDwUKMTIzNDU2Nzg5ZGQ=+/abc';
  assert.equal(decodeEntities(vs), vs);
});

test('fieldSuffix / findFieldName see through the _ctl0:cphMaster1: naming container', () => {
  assert.equal(fieldSuffix('_ctl0:cphMaster1:cmbReport'), 'cmbReport');
  assert.equal(fieldSuffix('_ctl0$Menu1'), 'Menu1');
  const { fields } = parseWebFormsForm(REPORT_SCREEN_HTML);
  assert.equal(findFieldName(fields, 'Button1'), '_ctl0:cphMaster1:Button1');
  assert.equal(findFieldName(fields, 'nope'), null);
});

test('buildPostBody: echoes the viewstate, applies suffix overrides, drops submit inputs', () => {
  const { fields } = parseWebFormsForm(REPORT_SCREEN_HTML);
  const body = buildPostBody(fields, { lstRunBy: 'Date In', lstTSDNumber: '42823' }, {
    '_ctl0:cphMaster1:Button1': 'Submit',
  });
  const params = new URLSearchParams(body.toString());
  assert.equal(params.get('__VIEWSTATE'), '/wEPDwUJODY3NTMwOQ==');
  assert.equal(params.get('_ctl0:cphMaster1:lstRunBy'), 'Date In');
  assert.equal(params.get('_ctl0:cphMaster1:lstTSDNumber'), '42823');
  assert.equal(params.get('_ctl0:cphMaster1:lstBranch'), 'MCO');  // untouched
  assert.equal(params.get('_ctl0:cphMaster1:lstClass'), '*ALL');  // default preserved
  // The submit controls are dropped by the echo; only the one we "click" (extra)
  // is posted — otherwise the server would see two buttons pressed and
  // RaisePostBackEvent would have to guess which one.
  assert.equal(params.get('_ctl0:cphMaster1:cmdMonthTD'), null);
  assert.equal(params.get('_ctl0:cphMaster1:btnToday'), null);
  assert.equal(params.get('_ctl0:cphMaster1:Button1'), 'Submit');
});

test('login body carries the IMAGE BUTTON coordinates (name alone does nothing)', () => {
  const { fields } = parseWebFormsForm(LOGIN_HTML);
  const body = buildPostBody(fields, {}, {
    txtUserID: 'user', txtPwd: 'secret', 'imgLogin.x': '10', 'imgLogin.y': '10',
  });
  const params = new URLSearchParams(body.toString());
  assert.equal(params.get('__VIEWSTATE'), '/wEPDwUKMTIzNDU2Nzg5');
  assert.equal(params.get('__VIEWSTATEGENERATOR'), 'CA0B0334');
  assert.equal(params.get('txtUserID'), 'user');
  assert.equal(params.get('txtPwd'), 'secret');
  assert.equal(params.get('imgLogin.x'), '10');
  assert.equal(params.get('imgLogin.y'), '10');
  // The type=image control itself must NOT be echoed as a plain field.
  assert.equal(params.get('imgLogin'), null);
});

// ---------------------------------------------------------------------------
// THE RANGE MECHANISM (measured 2026-07-17). The two tests Hector asked to be
// pinned live here: one bites if anyone posts CalFrom/CalTo as text fields, one
// bites if lstRunBy stops being sent explicitly.
// ---------------------------------------------------------------------------

test('RANGE: CalFrom/CalTo are NEVER posted as text fields (they are Calendar controls)', () => {
  // ⚠️ REGRESSION PIN. The original code posted `CalFrom=07/15/2026`. The live
  // form has NO such element, so ASP.NET silently ignored the key and ran the
  // report over its ViewState DEFAULT range: green run, plausible rows, wrong
  // window, nobody notices. This test fails the moment anyone reintroduces that.
  const o = reportOverrides({ tsdNumber: '61302', branch: 'MCO' });
  assert.equal(o.CalFrom, undefined);
  assert.equal(o.CalTo, undefined);

  // …and belt: the built body must not carry them either, under any suffix.
  const { fields } = parseWebFormsForm(REPORT_SCREEN_HTML);
  const body = buildCalendarPostBody(fields, o, CAL_TARGET.FROM, '9693');
  for (const key of new URLSearchParams(body.toString()).keys()) {
    assert.notEqual(fieldSuffix(key), 'CalFrom', 'CalFrom must never be posted as a field');
    assert.notEqual(fieldSuffix(key), 'CalTo', 'CalTo must never be posted as a field');
  }
  // The screen itself proves the premise: no CalFrom/CalTo among the elements.
  assert.equal(findFieldName(fields, 'CalFrom'), null);
  assert.equal(findFieldName(fields, 'CalTo'), null);
});

test('RANGE: a day is selected by __doPostBack(target, <day serial>)', () => {
  const { fields } = parseWebFormsForm(REPORT_SCREEN_HTML);
  const o = reportOverrides({ tsdNumber: '61302', branch: 'MCO' });
  const params = new URLSearchParams(
    buildCalendarPostBody(fields, o, CAL_TARGET.FROM, toCalendarDaySerial(new Date('2026-08-08T12:00:00Z'))).toString()
  );
  // The REAL mechanism, verbatim from the live DOM's day-cell link.
  assert.equal(params.get('__EVENTTARGET'), '_ctl0$cphMaster1$CalFrom');
  assert.equal(params.get('__EVENTARGUMENT'), '9716');
  // The viewstate still rides along (WebForms requires it).
  assert.equal(params.get('__VIEWSTATE'), '/wEPDwUJODY3NTMwOQ==');
  // A calendar postback is NOT a submit — no button may be posted with it.
  assert.equal(params.get('_ctl0:cphMaster1:Button1'), null);
  assert.equal(params.get('_ctl0:cphMaster1:cmdMonthTD'), null);
});

test('RANGE: lstRunBy=Date Out is sent EXPLICITLY on every postback (MC3)', () => {
  // ⚠️ REGRESSION PIN. lstRunBy picks the date column the report ranges on. The
  // screen happens to DEFAULT to "Date Out" — relying on that default is exactly
  // the class of bug this rework exists to kill, and it is what made the
  // booked-vs-pickup question look unanswerable. It must be posted, always.
  const o = reportOverrides({ tsdNumber: '61302', branch: 'MCO' });
  assert.equal(o[FIELD.RUN_BY], RUN_BY.DATE_OUT);
  assert.equal(RUN_BY_VALUE, 'Date Out');

  const { fields } = parseWebFormsForm(REPORT_SCREEN_HTML);
  // Every body the range machinery builds carries it — calendar postbacks…
  const cal = new URLSearchParams(buildCalendarPostBody(fields, o, CAL_TARGET.TO, '9693').toString());
  assert.equal(cal.get('_ctl0:cphMaster1:lstRunBy'), 'Date Out');
  // …and the submit.
  const submit = new URLSearchParams(
    buildPostBody(fields, o, { '_ctl0:cphMaster1:Button1': 'Submit' }).toString()
  );
  assert.equal(submit.get('_ctl0:cphMaster1:lstRunBy'), 'Date Out');
});

test('RANGE: reportOverrides drives TSD/branch, leaves the *ALL filters alone', () => {
  const o = reportOverrides({ tsdNumber: '61302', branch: 'MCO' });
  assert.equal(o.lstTSDNumber, '61302');
  assert.equal(o.lstBranch, 'MCO');
  // Filters we don't drive stay untouched so their *ALL default survives.
  assert.equal(o.lstClass, undefined);
  assert.equal(o.lstFromMonth, undefined);
});

test('RANGE: chkSummary is never posted — the parser needs the DETAIL rows', () => {
  // Measured unchecked. Checked, the grid collapses to summary totals. A browser
  // does not submit an unchecked box, so it must not appear; and even if TSD
  // rendered it pre-checked we must not echo it back.
  const preChecked = renderReportScreen({ summaryChecked: true });
  const { fields } = parseWebFormsForm(preChecked);
  assert.ok(fields['_ctl0:cphMaster1:chkSummary'], 'fixture really does render it checked');
  const params = new URLSearchParams(buildPostBody(fields, reportOverrides({})).toString());
  assert.equal(params.get('_ctl0:cphMaster1:chkSummary'), null);
});

test('RANGE: the month selects resolve by LABEL and expose the selected one', () => {
  const options = parseSelectOptions(REPORT_SCREEN_HTML, FIELD.FROM_MONTH);
  assert.deepEqual(options.map((o) => o.label), ['Jun 2026', 'Jul 2026', 'Aug 2026']);
  assert.equal(selectedOptionOf(options).label, 'Jul 2026');
  assert.equal(findOptionValueByLabel(options, 'Aug 2026'), 'Aug 2026');
  // A month the select doesn't offer → null, so the caller can decline to guess.
  assert.equal(findOptionValueByLabel(options, 'Dec 2099'), null);
  assert.equal(parseSelectOptions(REPORT_SCREEN_HTML, 'nope').length, 0);
});

test('RANGE: __EVENTTARGET uses $ separators, resolved from the rendered name', () => {
  const { fields } = parseWebFormsForm(REPORT_SCREEN_HTML);
  assert.equal(eventTargetFor(fields, FIELD.FROM_MONTH), '_ctl0$cphMaster1$lstFromMonth');
  assert.equal(eventTargetFor(fields, 'nope'), null);
  // The calendars are <table>s — never in `fields` — so their target is BUILT
  // from the naming container of a control that is.
  assert.equal(namingContainerOf(fields), '_ctl0$cphMaster1$');
});

test('RANGE: normalizeRangeMode — explicit is the default, "shortcut" is a legacy alias', () => {
  assert.equal(DEFAULT_RANGE_MODE, RANGE_MODES.EXPLICIT);
  assert.equal(normalizeRangeMode('explicit'), 'explicit');
  assert.equal(normalizeRangeMode('MTD'), 'mtd');
  assert.equal(normalizeRangeMode('none'), 'none');
  // The old env value meant "fire Current MTD".
  assert.equal(normalizeRangeMode('shortcut'), 'mtd');
  // An unknown/absent mode must fall back to the SAFE one (full coverage), never
  // to "post no range at all".
  assert.equal(normalizeRangeMode('banana'), 'explicit');
  assert.equal(normalizeRangeMode(undefined), 'explicit');
  assert.equal(normalizeRangeMode(''), 'explicit');
});

test('RANGE: rangeCoverage quantifies what MTD structurally cannot fetch', () => {
  const now = Date.parse('2026-07-17T16:00:00Z');
  const from = new Date('2026-07-15T16:00:00Z');   // today - 2
  const to = new Date('2026-08-16T16:00:00Z');     // today + 30

  // explicit → the calendars ARE the requested window.
  const exp = rangeCoverage({ mode: RANGE_MODES.EXPLICIT, from, to, now });
  assert.equal(exp.covers, true);
  assert.equal(exp.uncoveredDays, 0);

  // mtd → the 1st..today only. The ENTIRE lookahead is unreachable: ~30 days of
  // the window are never fetched. This is why 'mtd' is not the production mode.
  const mtd = rangeCoverage({ mode: RANGE_MODES.MTD, from, to, now });
  assert.equal(mtd.covers, false);
  assert.ok(mtd.uncoveredDays >= 29 && mtd.uncoveredDays <= 31, `~30 days uncovered, got ${mtd.uncoveredDays}`);
  assert.equal(mtd.coveredFrom, '2026-07-01T04:00:00.000Z');

  // none → makes no claim either way.
  assert.equal(rangeCoverage({ mode: RANGE_MODES.NONE, from, to, now }).covers, null);
});

// ---------------------------------------------------------------------------
// THE POSTBACK SEQUENCE, end to end through the __test.setFetch seam.
//
// Everything above tests one body in isolation. These drive fetchTMSummary and
// assert on the ORDER and CONTENT of the real request sequence — which is where
// the two dead assumptions actually did their damage.
// ---------------------------------------------------------------------------

/**
 * A stub portal. Records every POST body; answers the menu postback with the
 * report screen and the Submit postback with a grid.
 */
function stubPortal({ rows = [TM_ROW_LIVE], footer = true, screen = REPORT_SCREEN_HTML } = {}) {
  const posts = [];
  const fetchStub = async (url, opts = {}) => {
    const body = opts.body ? new URLSearchParams(opts.body) : new URLSearchParams();
    if (opts.method === 'POST') posts.push({ url, params: body });

    const target = body.get('__EVENTTARGET') || '';
    const clicked = (suffix) => [...body.keys()].some((k) => fieldSuffix(k) === suffix);

    let html = screen;
    if (clicked('Button1')) html = gridHtml(TM_HEADERS, rows, { footer });
    else if (target.endsWith('$Menu1')) html = screen;

    return {
      status: 200,
      headers: { get: () => null, getSetCookie: () => ['ASP.NET_SessionId=abc123; path=/'] },
      text: async () => html,
    };
  };
  return { posts, fetchStub };
}

/** Log in the stub tenant so fetchTMSummary skips straight to the report. */
async function primeSession(tenantId, fetchStub) {
  __test.setCredentialsResolver(async () => ({ username: 'u', password: 'p' }));
  __test.setFetch(fetchStub);
  const { login } = await import('./advantage.service.js');
  await login(tenantId);
}

test('SEQUENCE(explicit): month → CalFrom day → CalTo day → Submit, all carrying lstRunBy', async () => {
  const { posts, fetchStub } = stubPortal();
  await primeSession('t-seq-1', fetchStub);
  posts.length = 0;

  await fetchTMSummary('t-seq-1', {
    tsdNumber: '61302',
    branch: 'MCO',
    from: new Date('2026-07-16T12:00:00Z'),
    to: new Date('2026-08-08T12:00:00Z'),
    mode: RANGE_MODES.EXPLICIT,
  });

  // Drop the menu postback; what remains is the range sequence.
  const range = posts.filter((p) => !(p.params.get('__EVENTTARGET') || '').endsWith('$Menu1'));
  const trace = range.map((p) => {
    const t = p.params.get('__EVENTTARGET') || '';
    if (t) return `${fieldSuffix(t)}=${p.params.get('__EVENTARGUMENT')}`;
    return [...p.params.keys()].map(fieldSuffix).find((k) => k === 'Button1') || '?';
  });

  // The from-month is ALREADY Jul 2026 on the screen → no wasted postback for it.
  // The to-month is Aug → its autopostback fires. Then the two day serials. Then
  // Submit — the only thing that runs the report.
  assert.deepEqual(trace, [
    'CalFrom=9693',        // 2026-07-16
    'lstToMonth=',         // autopostback: display August
    'CalTo=9716',          // 2026-08-08
    'Button1',
  ]);

  // EVERY postback of the sequence names the date column. Not one of them relies
  // on the screen's default.
  for (const p of range) {
    assert.equal(p.params.get('_ctl0:cphMaster1:lstRunBy'), 'Date Out');
  }
  // And not one of them posts a CalFrom/CalTo TEXT field.
  for (const p of range) {
    for (const k of p.params.keys()) {
      assert.ok(!['CalFrom', 'CalTo'].includes(fieldSuffix(k)), `${k} must not be posted as a field`);
    }
  }
});

test('SEQUENCE: lstRunBy is OVERRIDDEN, not inherited — a screen defaulting to Date Booked still ranges on pickup', async () => {
  // ⚠️ REGRESSION PIN, and the one that actually bites. Every other lstRunBy
  // assertion is satisfied by the ECHO: our fixture's screen renders
  // selected="Date Out", so buildPostBody re-posts it whether or not we override
  // it, and dropping the override looks green. Here the screen defaults to
  // "Date Booked" — exactly what a changed ViewState could hand us — so 'Date Out'
  // in the body can ONLY come from an explicit override. If someone deletes it,
  // this run silently ranges on BOOKED date: the wrong 44% of the feed, forever.
  const { posts, fetchStub } = stubPortal({ screen: renderReportScreen({ runBy: 'Date Booked' }) });
  await primeSession('t-seq-runby', fetchStub);
  posts.length = 0;

  await fetchTMSummary('t-seq-runby', {
    tsdNumber: '61302', branch: 'MCO',
    from: new Date('2026-07-16T12:00:00Z'), to: new Date('2026-07-16T12:00:00Z'),
    mode: RANGE_MODES.EXPLICIT,
  });

  const range = posts.filter((p) => !(p.params.get('__EVENTTARGET') || '').endsWith('$Menu1'));
  assert.ok(range.length > 0);
  for (const p of range) {
    assert.equal(
      p.params.get('_ctl0:cphMaster1:lstRunBy'), 'Date Out',
      'the date column must be SET, never inherited from the screen'
    );
  }
});

test('SEQUENCE(mtd): Current MTD and Submit are TWO postbacks, never one body', async () => {
  const { posts, fetchStub } = stubPortal();
  await primeSession('t-seq-2', fetchStub);
  posts.length = 0;

  await fetchTMSummary('t-seq-2', {
    tsdNumber: '61302', branch: 'MCO',
    from: new Date('2026-07-15T16:00:00Z'), to: new Date('2026-08-16T16:00:00Z'),
    mode: RANGE_MODES.MTD,
  });

  const range = posts.filter((p) => !(p.params.get('__EVENTTARGET') || '').endsWith('$Menu1'));
  assert.equal(range.length, 2, 'Current MTD sets the range; Submit runs the report');

  // ⚠️ REGRESSION PIN. The original code posted the shortcut AND Button1 in one
  // body: two submit controls in one RaisePostBackEvent is ambiguous — the server
  // picks one and drops the other, so it was a coin flip between setting the range
  // and running the report. They must be SEQUENCED, one button per body.
  const [mtd, submit] = range;
  assert.equal(mtd.params.get('_ctl0:cphMaster1:cmdMonthTD'), 'Current MTD');
  assert.equal(mtd.params.get('_ctl0:cphMaster1:Button1'), null, 'the MTD postback must NOT also click Submit');
  assert.equal(submit.params.get('_ctl0:cphMaster1:Button1'), 'Submit');
  assert.equal(submit.params.get('_ctl0:cphMaster1:cmdMonthTD'), null, 'the Submit postback must NOT also click MTD');

  // A PLAIN submit — no ImageButton coordinates (VALIDATED-FALSE 2026-07-17).
  assert.equal(mtd.params.get('_ctl0:cphMaster1:cmdMonthTD.x'), null);
  assert.equal(mtd.params.get('_ctl0:cphMaster1:cmdMonthTD.y'), null);
});

test('SEQUENCE(mtd): the coverage gap lands in the diagnostics, not in silence', async () => {
  const { fetchStub } = stubPortal();
  await primeSession('t-seq-3', fetchStub);

  const now = Date.now();
  const rows = await fetchTMSummary('t-seq-3', {
    tsdNumber: '61302', branch: 'MCO',
    from: new Date(now - 2 * 86400000), to: new Date(now + 30 * 86400000),
    mode: RANGE_MODES.MTD,
  });

  const d = rows.diagnostics;
  assert.equal(d.rangeMode, 'mtd');
  assert.equal(d.rangeCoverage.covers, false);
  assert.ok(d.rangeCoverage.uncoveredDays > 0, 'the lookahead MTD cannot reach is a NUMBER');
  assert.deepEqual(d.rangePostbacks, ['mtd', 'submit']);
});

test('SEQUENCE(none): no range postbacks at all — just Submit', async () => {
  const { posts, fetchStub } = stubPortal();
  await primeSession('t-seq-4', fetchStub);
  posts.length = 0;

  await fetchTMSummary('t-seq-4', {
    tsdNumber: '61302', branch: 'MCO', from: null, to: null, mode: RANGE_MODES.NONE,
  });
  const range = posts.filter((p) => !(p.params.get('__EVENTTARGET') || '').endsWith('$Menu1'));
  assert.equal(range.length, 1);
  assert.equal(range[0].params.get('_ctl0:cphMaster1:Button1'), 'Submit');
});

test('SEQUENCE: the report is reached by ITS OWN menu path, and cmbReport is never posted', async () => {
  const { posts, fetchStub } = stubPortal();
  await primeSession('t-seq-5', fetchStub);
  posts.length = 0;

  await fetchTMSummary('t-seq-5', {
    tsdNumber: '61302', branch: 'MCO',
    from: new Date('2026-07-16T12:00:00Z'), to: new Date('2026-07-16T12:00:00Z'),
    mode: RANGE_MODES.EXPLICIT,
  });

  const menu = posts.find((p) => (p.params.get('__EVENTTARGET') || '').endsWith('$Menu1'));
  assert.ok(menu, 'navigation happens by menu postback (single-window rule)');
  assert.equal(menu.params.get('__EVENTARGUMENT'), 'Reports POS\\Estimated T&M Summary');
  // ⚠️ The report selector is the MENU PATH. cmbReport does not exist.
  for (const p of posts) {
    for (const k of p.params.keys()) {
      assert.notEqual(fieldSuffix(k), 'cmbReport', 'cmbReport does not exist on this screen');
    }
  }
});

test('SEQUENCE: __test.setFetch is restored so later tests are unaffected', () => {
  __test.setFetch(null);
  __test.setCredentialsResolver(null);
});

// ---------------------------------------------------------------------------
// Field mapper
// ---------------------------------------------------------------------------

test('mapRowToExternalReservation: the real row maps Total Bill → totalAmount, ACRISS inline, POA', () => {
  const tm = parseTMSummary(gridHtml(TM_HEADERS, [TM_ROW_LIVE]));
  const [row] = joinEmailsByConfirm(tm, parseEmailReport(gridHtml(EMAIL_HEADERS, EMAIL_ROWS)));
  const mapped = mapRowToExternalReservation(row);

  assert.equal(mapped.externalRef, 'A1TL012880');
  assert.equal(mapped.channel, 'AMADEUS');       // `Source` = booking channel
  assert.equal(mapped.subBrand, 'ADVANTAGE');
  assert.equal(mapped.supplierRef, 'A6D994');    // PNR
  assert.equal(mapped.status, STATUS.CONFIRMED);
  assert.equal(mapped.customerFirstName, 'DAVOOD');
  assert.equal(mapped.customerLastName, 'ASHRAFISISI');
  assert.equal(mapped.customerEmail, 'davood@example.com');
  // Email present → NO placeholder phone.
  assert.equal(mapped.customerPhone, null);
  assert.equal(mapped.vehicleAcriss, 'ECAR');
  assert.equal(mapped.pickupAt.toISOString(), '2026-07-04T04:00:00.000Z');
  assert.equal(mapped.dropoffAt.toISOString(), '2026-07-10T04:00:00.000Z');
  assert.equal(mapped.pickupLocation, '61302.MCO');
  // MONEY: Total Bill only → estimatedTotal downstream. Never a charge.
  assert.equal(mapped.totalAmount, 135.85);
  assert.equal(mapped.currency, 'USD');
  // Advantage is 100% Pay on Arrival (confirmed 2026-07-14).
  assert.equal(mapped.isPrepaid, false);
  // Rate code / PNR / CD preserved for audit + a future prepaid-by-rate-code config.
  assert.equal(mapped.rawJson.rateCode, 'D6');
  assert.equal(mapped.rawJson.pnr, 'A6D994');
  assert.equal(mapped.rawJson.cd, 'AD0016');
  assert.equal(mapped.rawJson.totalRate, 101.16);
  assert.equal(mapped.rawJson.totalTax, 22.69);
});

test('mapRowToExternalReservation: NO EMAIL → null email AND null phone (decision A)', () => {
  const tm = parseTMSummary(gridHtml(TM_HEADERS, [TM_ROW_NO_SHOW]));
  // No email row for this Confirm → the ~50%-coverage path.
  const [row] = joinEmailsByConfirm(tm, parseEmailReport(gridHtml(EMAIL_HEADERS, EMAIL_ROWS)));
  const mapped = mapRowToExternalReservation(row);

  // NEVER a fake email: the shared auto-create helper dedupes BY EMAIL, so a
  // shared placeholder address would merge hundreds of people into one customer.
  assert.equal(mapped.customerEmail, null);
  // And NEVER a placeholder phone on the STAGED row (Innovation MC1, 2026-07-16).
  // The staged phone is a LOOKUP KEY for the shared matcher: '0000000000' is
  // exactly equal to the whole auto-created placeholder pool, so staging it would
  // leave only the fuzzy name gate between this booking and a stranger's record.
  // The placeholder belongs in the auto-CREATE call and nowhere else.
  assert.equal(mapped.customerPhone, null);
  assert.notEqual(mapped.customerPhone, CUSTOMER_PHONE_PLACEHOLDER);
  // Identity is still present, so the create helper's first+last gate passes.
  assert.equal(mapped.customerFirstName, 'JANE');
  assert.equal(mapped.customerLastName, 'DOE');
});

test('mapRowToExternalReservation: an email row ALSO stages no phone', () => {
  const tm = parseTMSummary(gridHtml(TM_HEADERS, [TM_ROW_LIVE]));
  const [row] = joinEmailsByConfirm(tm, parseEmailReport(gridHtml(EMAIL_HEADERS, EMAIL_ROWS)));
  const mapped = mapRowToExternalReservation(row);
  // The T&M / Email reports carry no phone column at all — there is never a real
  // phone to stage, with or without an email.
  assert.equal(mapped.customerEmail, 'davood@example.com');
  assert.equal(mapped.customerPhone, null);
});

test('mapRowToExternalReservation: a cancelled row keeps its PHANTOM Total Bill — the status is the guard', () => {
  const tm = parseTMSummary(gridHtml(TM_HEADERS, [TM_ROW_CANCELLED]));
  const mapped = mapRowToExternalReservation(joinEmailsByConfirm(tm, [])[0]);
  assert.equal(mapped.status, STATUS.CANCELLED);
  assert.equal(mapped.rawJson.sourceStatus, STATUS.CANCELLED);
  // MEASURED 2026-07-17: the source does NOT zero Total Bill on cancel, so the
  // staged row honestly carries 130.98. We do NOT scrub it — staging what the
  // source said is the point of the staging table, and rawJson must stay faithful
  // for audit. What makes that safe is that a cancelled row can never REACH the
  // promoter: the worker stamps it REJECTED and skips promotion, and the manual
  // promote route refuses a REJECTED row outright. The two tests below pin both
  // ends of that guarantee.
  assert.equal(mapped.totalAmount, 130.98);
  assert.equal(isPromotableStatus(mapped.status), false);
});

test('cancelled / no-show rows are NOT promotable and map to a reject reason', () => {
  assert.equal(isPromotableStatus(STATUS.CONFIRMED), true);
  assert.equal(isPromotableStatus(STATUS.CANCELLED), false);
  assert.equal(isPromotableStatus(STATUS.NO_SHOW), false);
  assert.equal(rejectReasonForStatus(STATUS.CANCELLED), REJECT_REASONS.SOURCE_CANCELLED);
  assert.equal(rejectReasonForStatus(STATUS.NO_SHOW), REJECT_REASONS.SOURCE_NO_SHOW);
});

// ---------------------------------------------------------------------------
// MC3 — coverage diagnostics. `outOfWindowRows === 0` proves NOTHING on its own;
// the raw server span is what tells a human whether the server ranged on the
// column we think it did.
// ---------------------------------------------------------------------------

test('MC3: dateRangeOf reports the min/max span of a Date field (null when never set)', () => {
  const rows = [
    { pickupAt: new Date('2026-07-10T04:00:00Z'), bookedAt: null },
    { pickupAt: new Date('2026-07-04T04:00:00Z'), bookedAt: null },
    { pickupAt: null, bookedAt: null },
  ];
  assert.deepEqual(dateRangeOf(rows, 'pickupAt'), {
    min: '2026-07-04T04:00:00.000Z', max: '2026-07-10T04:00:00.000Z',
  });
  assert.deepEqual(dateRangeOf(rows, 'bookedAt'), { min: null, max: null });
  assert.deepEqual(dateRangeOf([], 'pickupAt'), { min: null, max: null });
});

test('MC3: the wrong-date-column under-fetch is READABLE off the diagnostics', () => {
  // Simulate the exact failure the comment used to hide: we ask for a 30-day
  // pickup window, and the server ranges on BOOKED date instead — returning only
  // bookings CREATED in the last 2 days. Every returned row's pickup happens to
  // fall inside our window, so the client-side filter drops nothing and
  // outOfWindowRows lands on 0 — the "everything is fine" signature.
  const rows = [
    { externalRef: 'A', pickupAt: new Date('2026-07-05T04:00:00Z'), bookedAt: new Date('2026-07-16T12:00:00Z') },
    { externalRef: 'B', pickupAt: new Date('2026-07-09T04:00:00Z'), bookedAt: new Date('2026-07-15T09:00:00Z') },
  ];
  const from = new Date('2026-07-14T00:00:00Z');
  const to = new Date('2026-08-13T00:00:00Z');
  const filtered = filterByPickupWindow(rows, new Date('2026-07-01T00:00:00Z'), to);

  // The old "health signal" says all-clear...
  assert.equal(rows.length - filtered.length, 0);
  // ...while the honest numbers show it: the server's Booked span is 2 days wide
  // against a 30-day request, and its DateOut span starts BEFORE `from` — i.e.
  // the server is not ranging on the column we asked on.
  const booked = dateRangeOf(rows, 'bookedAt');
  const dateOut = dateRangeOf(rows, 'pickupAt');
  const spanDays = (r) => (new Date(r.max) - new Date(r.min)) / 86400000;
  assert.ok(spanDays(booked) < 2, 'Booked span collapses to the last couple of days');
  assert.ok(new Date(dateOut.min) < from, 'DateOut ignores the requested `from`');
});

// ---------------------------------------------------------------------------
// MAPPER → MATCHER interaction (Innovation MC1, 2026-07-16).
//
// The gap that let MC1 through: every test above stops at the mapper's output,
// and the matcher is tested with hand-written rows. Nobody fed a REAL mapped
// Advantage row to the REAL shared matcher, so the one combination that matters —
// a no-email row meeting the placeholder-phone customer pool — was never
// exercised. These tests close that seam end to end.
// ---------------------------------------------------------------------------

const { evaluatePromotion: sharedEvaluatePromotion, REVIEW_REASONS: SHARED_REASONS } =
  await import('../booking-source/promotion-matcher.service.js');

/**
 * A fake Prisma that implements the slices matchCustomer actually uses, with the
 * SAME semantics Postgres gives it: `phone: { contains }` is a substring scan and
 * `take` truncates an UNORDERED result.
 */
function fakeMatcherPrisma(customers, { acriss = { vehicleCategory: 'ECON' } } = {}) {
  return {
    acrissCategoryMap: {
      findUnique: async () => acriss,
      findFirst: async () => acriss,
    },
    customer: {
      findMany: async ({ where, take }) => {
        let out = customers.filter((c) => c.tenantId === where.tenantId);
        if (where.email?.equals) {
          const want = String(where.email.equals).toLowerCase();
          out = out.filter((c) => (c.email || '').toLowerCase() === want);
        }
        if (where.phone?.contains) {
          out = out.filter((c) => String(c.phone || '').includes(where.phone.contains));
        }
        return take ? out.slice(0, take) : out;
      },
    },
  };
}

// The '0000000000' pool as it exists in Corpusa TODAY: every customer the
// Flexways sweep auto-created on 2026-07-14 carries the placeholder phone.
// MARIA GARCIA is the stranger; MARIO GARCIA is the incoming Advantage booking.
// jaroWinkler('MARIO GARCIA', 'MARIA GARCIA') is ~0.97 — far past the 0.85 gate.
//
// EXACTLY ONE fuzzy-close stranger, deliberately. This fixture is load-bearing:
// with TWO close names the old code returns multiple_matches — the SAFE branch —
// and the test passes against the bug it is supposed to catch (verified by
// bite-test, 2026-07-16). One close stranger is what makes the old code commit
// the actual harm: a silent AUTO promotion onto that person's record.
const PLACEHOLDER_POOL = [
  { id: 'c-maria', tenantId: 't1', firstName: 'MARIA', lastName: 'GARCIA', email: null, phone: '0000000000' },
  { id: 'c-jose', tenantId: 't1', firstName: 'JOSE', lastName: 'RIVERA', email: null, phone: '0000000000' },
  { id: 'c-ana', tenantId: 't1', firstName: 'ANA', lastName: 'TORRES', email: null, phone: '0000000000' },
];

/** Build a staged Advantage row (as the worker upserts it) for one T&M row. */
function stageRow(tmCells, emailRows = []) {
  const tm = parseTMSummary(gridHtml(TM_HEADERS, [tmCells]));
  const [row] = joinEmailsByConfirm(tm, emailRows);
  return { id: 'ext1', tenantId: 't1', ...mapRowToExternalReservation(row) };
}

// A live (promotable) T&M row for MARIO GARCIA with NO email — the ~50% path.
const TM_ROW_NO_EMAIL_MARIO = [
  'D4NE001234', 'MARIO GARCIA', '61302.MCO', '2026/07/04', '2026/07/10', '2026/05/04',
  'ECAR', '6', '33895934', '101.16', '22.69', '135.85', '', 'D6', 'PNR789', 'AMADEUS',
  'AD0016', '',
];

test('MC1: a no-email Advantage row does NOT match a stranger in the placeholder-phone pool', async () => {
  const staged = stageRow(TM_ROW_NO_EMAIL_MARIO);
  // Precondition: this really is the dangerous shape — no email at all.
  assert.equal(staged.customerEmail, null);
  assert.equal(staged.customerFirstName, 'MARIO');

  const decision = await sharedEvaluatePromotion(staged, {
    prisma: fakeMatcherPrisma(PLACEHOLDER_POOL),
    overrideLocationId: 'loc-mco',
  });

  // It must NEVER auto-promote onto MARIA GARCIA (or any other pooled stranger).
  // The only honest answer for a row with no identifying key is "I don't know".
  assert.equal(decision.decision, 'MANUAL_REVIEW');
  assert.equal(decision.reason, SHARED_REASONS.CUSTOMER_NOT_FOUND);
  assert.equal(decision.mappedCustomer, undefined);
});

test('MC1: the same row against MANY close pool names is not "saved" by multiple_matches either', async () => {
  // The bug had a second, milder branch: with 2+ fuzzy-close strangers the old
  // code returned multiple_matches instead of promoting onto one of them. That is
  // NOT a fix — it still routes ~270 rows/month into MANUAL_REVIEW, and (with
  // auto-create on) still drives the create-loop. The answer must be the honest
  // customer_not_found in BOTH shapes.
  const crowded = [
    ...PLACEHOLDER_POOL,
    { id: 'c-marias', tenantId: 't1', firstName: 'MARIA', lastName: 'GARCIAS', email: null, phone: '0000000000' },
  ];
  const decision = await sharedEvaluatePromotion(stageRow(TM_ROW_NO_EMAIL_MARIO), {
    prisma: fakeMatcherPrisma(crowded),
    overrideLocationId: 'loc-mco',
  });
  assert.equal(decision.decision, 'MANUAL_REVIEW');
  assert.equal(decision.reason, SHARED_REASONS.CUSTOMER_NOT_FOUND);
});

test('MC1: the guard holds even if a placeholder phone reaches the matcher anyway', async () => {
  // Belt AND braces: force the staged phone to the placeholder (i.e. pretend the
  // mapper regressed, or a future source hands us a literal 0000000000). The
  // SHARED matcher must still refuse — this is the fix that covers TL/Economy/
  // NU/Flexways, all of which pass the upstream phone through verbatim.
  const staged = { ...stageRow(TM_ROW_NO_EMAIL_MARIO), customerPhone: CUSTOMER_PHONE_PLACEHOLDER };
  const decision = await sharedEvaluatePromotion(staged, {
    prisma: fakeMatcherPrisma(PLACEHOLDER_POOL),
    overrideLocationId: 'loc-mco',
  });
  assert.equal(decision.decision, 'MANUAL_REVIEW');
  assert.equal(decision.reason, SHARED_REASONS.CUSTOMER_NOT_FOUND);
});

test('MC1: a REAL phone + matching name still auto-promotes (the guard is not a blanket block)', async () => {
  // The counter-test: the guard must only reject the DEGENERATE pool value. A
  // genuine phone+name match is still an AUTO — otherwise we would have "fixed"
  // the bug by breaking matching for TL/NU, whose phone path is load-bearing.
  // NB: the stored phone is digits. `contains` scans the RAW column before the
  // per-candidate normalized compare, so a formatted '(407) 555-8899' would not
  // even be a candidate for the normalized '4075558899' — a real (pre-existing,
  // out-of-scope) limitation of the shared matcher, not something this fix moved.
  const pool = [
    ...PLACEHOLDER_POOL,
    { id: 'c-real', tenantId: 't1', firstName: 'MARIO', lastName: 'GARCIA', email: null, phone: '4075558899' },
  ];
  const staged = { ...stageRow(TM_ROW_NO_EMAIL_MARIO), customerPhone: '4075558899' };
  const decision = await sharedEvaluatePromotion(staged, {
    prisma: fakeMatcherPrisma(pool),
    overrideLocationId: 'loc-mco',
  });
  assert.equal(decision.decision, 'AUTO');
  assert.equal(decision.mappedCustomer.id, 'c-real');
});

test('MC1: an email row matches by email — the normal Advantage happy path is intact', async () => {
  const pool = [
    ...PLACEHOLDER_POOL,
    { id: 'c-davood', tenantId: 't1', firstName: 'DAVOOD', lastName: 'ASHRAFISISI', email: 'davood@example.com', phone: '0000000000' },
  ];
  const staged = stageRow(TM_ROW_LIVE, parseEmailReport(gridHtml(EMAIL_HEADERS, EMAIL_ROWS)));
  assert.equal(staged.customerEmail, 'davood@example.com');
  const decision = await sharedEvaluatePromotion(staged, {
    prisma: fakeMatcherPrisma(pool),
    overrideLocationId: 'loc-mco',
  });
  assert.equal(decision.decision, 'AUTO');
  assert.equal(decision.mappedCustomer.id, 'c-davood');
});

test('MC1(b): overrideCustomerId settles the customer step without re-searching', async () => {
  // After auto-create the worker HOLDS the new customer id. Re-evaluating without
  // it would return customer_not_found again (nothing to find it by) → the row
  // goes to MANUAL_REVIEW → the next sweep creates ANOTHER customer, forever.
  const staged = stageRow(TM_ROW_NO_EMAIL_MARIO);
  let searched = false;
  const prisma = fakeMatcherPrisma(PLACEHOLDER_POOL);
  const findMany = prisma.customer.findMany;
  prisma.customer.findMany = async (...a) => { searched = true; return findMany(...a); };

  const decision = await sharedEvaluatePromotion(staged, {
    prisma, overrideLocationId: 'loc-mco', overrideCustomerId: 'c-just-created',
  });

  assert.equal(decision.decision, 'AUTO');
  assert.equal(decision.mappedCustomer.id, 'c-just-created');
  assert.equal(searched, false, 'must not search for a customer it was handed');
});

test('MC1(b): overrideCustomerId does NOT bypass the other gates', async () => {
  // It settles the CUSTOMER step only. An unmapped ACRISS must still block.
  const staged = stageRow(TM_ROW_NO_EMAIL_MARIO);
  const decision = await sharedEvaluatePromotion(staged, {
    prisma: fakeMatcherPrisma(PLACEHOLDER_POOL, { acriss: null }),
    overrideLocationId: 'loc-mco',
    overrideCustomerId: 'c-just-created',
  });
  assert.equal(decision.decision, 'MANUAL_REVIEW');
  assert.equal(decision.reason, SHARED_REASONS.ACRISS_UNMAPPED);
});

// ---------------------------------------------------------------------------
// Shared promoter wiring
// ---------------------------------------------------------------------------

test('sourceSpec: the shared promoter writes ADV-<ref> + FRANCHISE_ADVANTAGE + estimatedTotal only', async () => {
  const { createPromoter } = await import('../booking-source/promote.js');
  const captured = {};
  const fakePrisma = {
    $transaction: async (fn) => fn({
      externalReservation: {
        findUnique: async () => ({
          id: 'ext1', tenantId: 't1', externalRef: 'A1TL012880',
          promotionStatus: 'PENDING', totalAmount: 135.85, isPrepaid: false,
          pickupAt: new Date('2026-07-04T04:00:00Z'), dropoffAt: new Date('2026-07-10T04:00:00Z'),
          customerEmail: 'davood@example.com', vehicleAcriss: 'ECAR',
        }),
        update: async ({ data }) => ({ id: 'ext1', ...data }),
      },
      reservation: { create: async ({ data }) => { captured.reservation = data; return { id: 'r1', ...data }; } },
      vehicleType: { findFirst: async () => ({ id: 'vt1' }) },
    }),
  };
  // Rebuild the worker's spec against the fake client (the real module binds the
  // live prisma at import time).
  const { promoteWithMappings } = createPromoter({
    reservationPrefix: RESERVATION_PREFIX,
    bookingChannel: BOOKING_CHANNEL,
    sourceLabel: 'Advantage',
    logPrefix: '[advantage-sync]',
    defaultTimeZone: TIME_ZONE,
    buildReservationExtras: (fresh) => ({
      isPrepaid: typeof fresh.isPrepaid === 'boolean' ? fresh.isPrepaid : null,
      notes: `Imported from Advantage — ${fresh.externalRef}`
        + (fresh.isPrepaid === false ? ' (pay-at-destination)' : ''),
    }),
    prismaClient: fakePrisma,
  });

  await promoteWithMappings({ id: 'ext1' }, {
    customerId: 'c1', locationId: 'loc1', vehicleCategory: 'ECON', isAuto: true,
  });

  const r = captured.reservation;
  assert.equal(r.reservationNumber, 'ADV-A1TL012880');
  assert.equal(r.bookingChannel, 'FRANCHISE_ADVANTAGE');
  assert.equal(r.estimatedTotal, 135.85);
  assert.equal(r.isPrepaid, false);
  assert.match(r.notes, /Imported from Advantage — A1TL012880 \(pay-at-destination\)/);
  assert.equal(r.sendConfirmationEmail, false);
  // MONEY posture: estimatedTotal is the ONLY money field the promoter writes.
  assert.equal('charges' in r, false);
  assert.equal('paidAmount' in r, false);
});
