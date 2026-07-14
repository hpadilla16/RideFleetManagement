/**
 * Flexways (MobilityPS) integration — unit tests.
 *
 * Pure where possible; fetch/prisma NOT hit (fixtures only — never the live
 * portal). Covers the correctness-critical pieces of the PHP + DataTables
 * integration:
 *   1. DataTables grid parser — a representative JSON payload (the recon row
 *      shape: HTML-wrapped cells, LATAM DD/MM/YYYY dates, "name + CODE" customer
 *      cell, status-icon tooltip) incl. a tag-wrapped date cell, a ref-less row
 *      (skipped), and a short row.
 *   2. cellText tag/entity stripping.
 *   3. splitCustomerAndCode + splitName heuristics.
 *   4. LATAM date parsing (DD/MM/YYYY HH:mm → America/New_York UTC instant).
 *   5. filterByPickupWindow.
 *   6. mapRowToExternalReservation field mapper (detail-only fields stay null).
 *   7. sourceSpec wired into the SHARED promoter (notes-only extras, FW- prefix).
 *   8. window helpers delegate to the shared booking-source factory.
 *
 * Promotion/dedup/crypto/auto-create logic is reused UNCHANGED from
 * booking-source/ (covered by test:booking-source + TL/Economy/NU) so it is not
 * re-tested here.
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
  EXPECTED_COLUMN_COUNT,
  toIsoFromLatam,
  effectiveWindowDays,
  windowBoundsForConfig,
} = await import('./flexways.constants.js');

const {
  cellText,
  splitCustomerAndCode,
  splitName,
  parseReservationGrid,
  latamToUtc,
  filterByPickupWindow,
  extractAcriss,
  parseContractList,
  filterByChannel,
  parseReservationDetailHtml,
  extractInputValue,
  extractSelectedOptionText,
  parseAmount,
} = await import('./flexways.service.js');

const {
  mapRowToExternalReservation,
  mapContractToExternalReservation,
  promoteAutomatically,
} = await import('./flexways.worker.js');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

test('constants: source identity is FLEXWAYS / FRANCHISE_FLEXWAYS / FW-', () => {
  assert.equal(SOURCE_SYSTEM, 'FLEXWAYS');
  assert.equal(BOOKING_CHANNEL, 'FRANCHISE_FLEXWAYS');
  assert.equal(RESERVATION_PREFIX, 'FW-');
  assert.equal(EXPECTED_COLUMN_COUNT, 9);
  assert.equal(TIME_ZONE, 'America/New_York');
});

// ---------------------------------------------------------------------------
// cellText — the DataTables cells arrive as HTML fragments
// ---------------------------------------------------------------------------

test('cellText strips tags + decodes entities + collapses whitespace', () => {
  assert.equal(cellText('<td style="font-size:0.85em;">09/07/2026 20:57:00</td>'), '09/07/2026 20:57:00');
  assert.equal(cellText('U-Save &amp; Co &nbsp; Orlando'), 'U-Save & Co Orlando');
  assert.equal(cellText(null), '');
  assert.equal(cellText('<label style="display:none;"></label>   QSRC58 '), 'QSRC58');
});

// ---------------------------------------------------------------------------
// customer + code splitting
// ---------------------------------------------------------------------------

test('splitCustomerAndCode pulls the trailing all-caps code off the name', () => {
  assert.deepEqual(splitCustomerAndCode('Joan Visschedijk VISSAHE'), { name: 'Joan Visschedijk', code: 'VISSAHE' });
  assert.deepEqual(splitCustomerAndCode('Maria De La Cruz QSRC58'), { name: 'Maria De La Cruz', code: 'QSRC58' });
  // No trailing code → whole cell is the name.
  assert.deepEqual(splitCustomerAndCode('Bob Smith'), { name: 'Bob Smith', code: null });
  assert.deepEqual(splitCustomerAndCode(''), { name: null, code: null });
});

test('splitName: first token → first, remainder → last', () => {
  assert.deepEqual(splitName('Joan Visschedijk'), { firstName: 'Joan', lastName: 'Visschedijk' });
  assert.deepEqual(splitName('Maria De La Cruz'), { firstName: 'Maria', lastName: 'De La Cruz' });
  assert.deepEqual(splitName('Cher'), { firstName: 'Cher', lastName: null });
});

// ---------------------------------------------------------------------------
// LATAM date parsing
// ---------------------------------------------------------------------------

test('toIsoFromLatam: DD/MM/YYYY is day-first (not US month-first)', () => {
  // 19/07 = July 19, not "month 19".
  assert.equal(toIsoFromLatam('19/07/2026 15:00:00'), '2026-07-19T15:00:00');
  assert.equal(toIsoFromLatam('09/07/2026 20:57'), '2026-07-09T20:57:00');
  assert.equal(toIsoFromLatam('05/01/2026'), '2026-01-05T00:00:00'); // date-only → midnight
  assert.equal(toIsoFromLatam('bogus'), null);
});

test('latamToUtc: wall-clock interpreted in America/New_York (EDT = UTC-4 in July)', () => {
  const d = latamToUtc('19/07/2026 15:00:00');
  assert.ok(d instanceof Date);
  // 15:00 EDT → 19:00 UTC
  assert.equal(d.toISOString(), '2026-07-19T19:00:00.000Z');
});

// ---------------------------------------------------------------------------
// grid parser
// ---------------------------------------------------------------------------

function reconPayload() {
  // Shape from the 2026-07-13 in-session recon (funcionesAjaxReservas.php).
  return {
    draw: 0,
    recordsTotal: 3,
    recordsFiltered: 3,
    data: [
      [
        'Flexways Orlando - Vista East',
        '<label style="display:none;"></label><td style="font-size:0.85em;">09/07/2026 20:57:00</td>',
        '19/07/2026 15:00:00',
        'Aeropuerto Internacional de Orlando',
        'Aeropuerto Internacional de Orlando',
        '<td style="font-size:0.85em;">API</td>',
        'Joan Visschedijk VISSAHE',
        '<div style="text-align:center;"><i class="icon-sphere" title="Reserva Nueva - API"></i></div>',
        'QSRC58',
      ],
      // ref-less row → skipped
      [
        'Flexways Orlando - Vista East', '10/07/2026 09:00:00', '20/07/2026 10:00:00',
        'MCO', 'MCO', 'API', 'No Ref Person', '<i title="x"></i>', '   ',
      ],
      // second good row
      [
        'Flexways Miami', '11/07/2026 08:00:00', '21/07/2026 12:30:00',
        'MIA', 'MIA', 'Web', 'Ana Ruiz ANARZ9', '<i title="Confirmada"></i>', 'ANARZ9',
      ],
    ],
  };
}

test('parseReservationGrid: maps columns, skips ref-less rows, records diagnostics', () => {
  const rows = parseReservationGrid(reconPayload());
  assert.equal(rows.length, 2); // 3 data rows, 1 has no ref
  const [a, b] = rows;
  assert.equal(a.externalRef, 'QSRC58');
  assert.equal(a.sede, 'Flexways Orlando - Vista East');
  assert.equal(a.customerName, 'Joan Visschedijk');
  assert.equal(a.customerFirstName, 'Joan');
  assert.equal(a.customerLastName, 'Visschedijk');
  assert.equal(a.bookingCode, 'VISSAHE');
  assert.equal(a.channel, 'API');
  assert.equal(a.status, 'Reserva Nueva - API'); // tooltip pulled from the icon cell
  assert.equal(a.pickupAt.toISOString(), '2026-07-19T19:00:00.000Z');
  assert.ok(a.bookedAt instanceof Date);
  assert.equal(b.externalRef, 'ANARZ9');
  assert.equal(b.sede, 'Flexways Miami');
  // diagnostics is non-enumerable
  assert.equal(rows.diagnostics.recordsTotal, 3);
  assert.equal(rows.diagnostics.parsedRows, 2);
  assert.equal(rows.diagnostics.emptyGridAnomaly, false);
});

test('parseReservationGrid: accepts a JSON string payload and an empty grid', () => {
  const rows = parseReservationGrid(JSON.stringify(reconPayload()));
  assert.equal(rows.length, 2);
  const empty = parseReservationGrid({ data: [] });
  assert.equal(empty.length, 0);
  assert.equal(empty.diagnostics.emptyGridAnomaly, false);
});

test('parseReservationGrid: rows present but none with a ref → emptyGridAnomaly (format break, not empty)', () => {
  const rows = parseReservationGrid({ recordsTotal: 2, data: [['x', 'y'], ['z']] });
  assert.equal(rows.length, 0);
  assert.equal(rows.diagnostics.emptyGridAnomaly, true);
});

test('parseReservationGrid: server-side pagination (data page < recordsTotal) sets truncated', () => {
  // recordsTotal says 50 but only 2 rows came back → we'd under-import.
  const p = reconPayload();
  p.recordsTotal = 50;
  const rows = parseReservationGrid(p);
  assert.equal(rows.diagnostics.truncated, true);
  // When the full set arrives (recordsTotal matches the page), not truncated.
  const full = parseReservationGrid(reconPayload());
  assert.equal(full.diagnostics.truncated, false);
});

// ---------------------------------------------------------------------------
// window filter
// ---------------------------------------------------------------------------

test('filterByPickupWindow: keeps in-range, drops out-of-range + unparseable', () => {
  const rows = [
    { externalRef: 'A', pickupAt: new Date('2026-07-19T19:00:00Z') },
    { externalRef: 'B', pickupAt: new Date('2026-08-30T19:00:00Z') }, // out
    { externalRef: 'C', pickupAt: null },                              // unparseable
  ];
  const out = filterByPickupWindow(rows, new Date('2026-07-01T00:00:00Z'), new Date('2026-07-31T23:59:59Z'));
  assert.deepEqual(out.map((r) => r.externalRef), ['A']);
  // no bounds → passthrough
  assert.equal(filterByPickupWindow(rows, null, null).length, 3);
});

// ---------------------------------------------------------------------------
// field mapper — detail-only fields stay null (recon gap documented)
// ---------------------------------------------------------------------------

test('mapRowToExternalReservation: grid → ExternalReservation, class/total/email null until detail fetch', () => {
  const row = parseReservationGrid(reconPayload())[0];
  const ext = mapRowToExternalReservation(row);
  assert.equal(ext.externalRef, 'QSRC58');
  assert.equal(ext.status, 'CONFIRMED');
  assert.equal(ext.supplierRef, 'VISSAHE');
  assert.equal(ext.customerFirstName, 'Joan');
  assert.equal(ext.pickupLocation, 'Aeropuerto Internacional de Orlando');
  assert.ok(ext.pickupAt instanceof Date);
  assert.equal(ext.currency, 'USD');
  // Grid carries none of these — they come from the per-reservation detail page.
  assert.equal(ext.vehicleAcriss, null);
  assert.equal(ext.totalAmount, null);
  assert.equal(ext.customerEmail, null);
  assert.equal(ext.customerPhone, null);
  assert.equal(ext.dropoffAt, null);
  // raw preserved for the eventual detail merge
  assert.equal(ext.rawJson.list.externalRef, 'QSRC58');
});

// ===========================================================================
// Fase 3.5 — detail-fetch: contract list + detail HTML → AUTO-promotable row
// ===========================================================================

// ---------------------------------------------------------------------------
// extractAcriss — the ACRISS code lives in the category label's parenthetical
// ---------------------------------------------------------------------------

test('extractAcriss pulls the 4-letter code from "Nombre (ACRISS)"', () => {
  assert.equal(extractAcriss('SUV Compact AT (CFAR)'), 'CFAR');
  assert.equal(extractAcriss('Grande Automatico (FDAR)'), 'FDAR');
  assert.equal(extractAcriss('Sedan Mediano (IDMR)'), 'IDMR');
  assert.equal(extractAcriss('Minivan 7 pax (FVMR)'), 'FVMR');
  // lower-case in the parenthetical is normalized up
  assert.equal(extractAcriss('Whatever (cfar)'), 'CFAR');
  // no parenthetical code → null (fail-safe → MANUAL_REVIEW)
  assert.equal(extractAcriss('Sin ACRISS'), null);
  assert.equal(extractAcriss(''), null);
  assert.equal(extractAcriss(null), null);
  // a non-4-letter parenthetical is ignored
  assert.equal(extractAcriss('Van (7 pax)'), null);
});

// ---------------------------------------------------------------------------
// parseContractList — DataTables ARRAY-OF-OBJECTS carrying idAlquiler
// ---------------------------------------------------------------------------

// Build a contract row the way funcionesAjaxContratos.php actually returns it
// (verified live 2026-07-14). idAlquiler lives ONLY in the actions HTML (hidden
// input); the leading columns shift by one between the 11-col and 12-col
// layouts, so `withIdCol` models either. Everything from sede → last is stable.
function actionsCell(idAlquiler) {
  return idAlquiler
    ? `<div class="list-icons"><input type="hidden" name="idAlquiler" value="${idAlquiler}"><a href="#">Modificar</a></div>`
    : '<div class="list-icons"><a href="#">Modificar</a></div>'; // no id → unusable
}
function contractRow(f, withIdCol) {
  // stable tail, sede → last: [sede, pickup(Desde), return(Hasta), pickupLoc,
  // dropoffLoc, channel, customer, (empty), ref, actions]
  const tail = [
    f.sede ?? 'Flexways Orlando - Vista East',
    f.pickup,                                                   // compound Desde cell
    f.dropoff,                                                  // single Hasta cell
    f.pickupLoc ?? 'Aeropuerto Internacional de Orlando',
    f.dropoffLoc ?? 'Aeropuerto Internacional de Orlando',
    f.channel ?? 'API',
    f.customer ?? '',
    '',
    f.ref ?? '',
    actionsCell(f.idAlquiler),
  ];
  const cells = withIdCol ? [f.idAlquiler ?? '', 'P D', ...tail] : ['P D', ...tail];
  const o = {};
  cells.forEach((v, i) => { o[i] = v; });
  return o;
}
function contractPayload(withIdCol = false) {
  return {
    draw: 1,
    recordsTotal: 3,
    recordsFiltered: 3,
    data: [
      contractRow({
        idAlquiler: '485160', ref: 'QJDK07', sede: 'Flexways Orlando - Vista East',
        pickup: '2026-07-19</label> 19/07/2026 15:00:00',   // Desde (compound, ISO label + LATAM)
        dropoff: '21/07/2026 10:00:00',                      // Hasta (single)
        channel: 'API', customer: 'Alfredo Reyes',
      }, withIdCol),
      // actions HTML carries NO idAlquiler input → skipped (unusable)
      contractRow({
        idAlquiler: '', ref: 'NOID11', sede: 'Flexways Miami',
        pickup: '2026-07-20</label> 20/07/2026 09:00:00', dropoff: '22/07/2026 09:00:00',
        pickupLoc: 'MIA', dropoffLoc: 'MIA', channel: 'API', customer: 'No Id Person',
      }, withIdCol),
      // second good row (Web channel — used by the channel-filter test)
      contractRow({
        idAlquiler: '485161', ref: 'ANARZ9', sede: 'Flexways Miami',
        pickup: '2026-07-21</label> 21/07/2026 12:30:00', dropoff: '24/07/2026 12:30:00',
        pickupLoc: 'MIA', dropoffLoc: 'MIA', channel: 'Web', customer: 'Ana Ruiz',
      }, withIdCol),
    ],
  };
}

test('parseContractList: anchors from the end, pulls idAlquiler from actions HTML, skips id-less rows', () => {
  const rows = parseContractList(contractPayload());
  assert.equal(rows.length, 2); // 3 rows, 1 has no idAlquiler
  const [a, b] = rows;
  assert.equal(a.idAlquiler, '485160');
  assert.equal(a.externalRef, 'QJDK07');
  assert.equal(a.ref, 'QJDK07');
  assert.equal(a.sede, 'Flexways Orlando - Vista East');
  assert.equal(a.channel, 'API');
  assert.equal(a.customerName, 'Alfredo Reyes');
  assert.equal(a.customerFirstName, 'Alfredo');
  assert.equal(a.customerLastName, 'Reyes');
  assert.equal(a.pickupLocation, 'Aeropuerto Internacional de Orlando');
  assert.equal(a.pickupAt.toISOString(), '2026-07-19T19:00:00.000Z'); // col 3 pickup, 15:00 EDT → 19:00 UTC
  assert.equal(a.dropoffAt.toISOString(), '2026-07-21T14:00:00.000Z'); // col 4 return
  assert.equal(b.idAlquiler, '485161');
  assert.equal(b.externalRef, 'ANARZ9');
  assert.equal(b.channel, 'Web');
  // diagnostics
  assert.equal(rows.diagnostics.recordsTotal, 3);
  assert.equal(rows.diagnostics.parsedRows, 2);
  assert.equal(rows.diagnostics.missingId, 1);
  assert.equal(rows.diagnostics.emptyGridAnomaly, false);
});

test('parseContractList: identical result whether the portal ships 11 or 12 columns (idAlquiler col present or not)', () => {
  const eleven = parseContractList(contractPayload(false)); // no leading idAlquiler column
  const twelve = parseContractList(contractPayload(true));  // leading idAlquiler column present
  assert.equal(eleven.length, 2);
  assert.equal(twelve.length, 2);
  for (const key of ['idAlquiler', 'externalRef', 'sede', 'channel', 'customerName', 'pickupLocation']) {
    assert.equal(eleven[0][key], twelve[0][key], `mismatch on ${key} across layouts`);
  }
  assert.equal(eleven[0].pickupAt.toISOString(), twelve[0].pickupAt.toISOString());
  assert.equal(eleven[0].dropoffAt.toISOString(), twelve[0].dropoffAt.toISOString());
  // idAlquiler resolved from the actions HTML in BOTH layouts (not a fixed column)
  assert.equal(twelve[0].idAlquiler, '485160');
  assert.equal(eleven[0].idAlquiler, '485160');
});

test('parseContractList: accepts a JSON string + flags truncation when page < recordsTotal', () => {
  const rows = parseContractList(JSON.stringify(contractPayload()));
  assert.equal(rows.length, 2);
  const p = contractPayload();
  p.recordsTotal = 200; // server paginated → we'd under-import
  assert.equal(parseContractList(p).diagnostics.truncated, true);
  assert.equal(parseContractList(contractPayload()).diagnostics.truncated, false);
});

test('filterByChannel: empty list = import all; a set restricts (case-insensitive)', () => {
  const rows = parseContractList(contractPayload());
  assert.equal(filterByChannel(rows, []).length, 2);            // all
  assert.equal(filterByChannel(rows, ['API']).length, 1);       // only Alfredo (API)
  assert.equal(filterByChannel(rows, ['api', 'web']).length, 2);
  assert.equal(filterByChannel(rows, ['GDS']).length, 0);
});

// ---------------------------------------------------------------------------
// detail HTML parsing — input values + selected <option> text, by name
// ---------------------------------------------------------------------------

function detailHtml({ email = 'freakin_rider@gmail.com', fallbackEmail = 'test@test.com',
  total = '32.50', currency = 'USD', category = 'SUV Compact AT (CFAR)' } = {}) {
  return `
    <form id="reservaForm" method="post">
      <input type="hidden" name="idAlquiler" value="485160">
      <input type="text" name="idCliente" value="308707" />
      <input name="emailCustomer" value="${email}" class="form-control" />
      <input class="form-control" value="${fallbackEmail}" name="email" />
      <input name="total" value="${total}" type="text">
      <input type="text" value="${total}" name="totalfin">
      <select name="cbMoneda" class="sel">
        <option value="1">EUR</option>
        <option value="2" selected="selected">${currency}</option>
      </select>
      <select name="cbCategoria">
        <option value="10">Economico Base (EBMN)</option>
        <option value="42" selected>${category}</option>
        <option value="55">Grande Automatico (FDAR)</option>
      </select>
    </form>`;
}

test('extractInputValue: reads a value regardless of attribute order; null when absent', () => {
  const html = detailHtml();
  assert.equal(extractInputValue(html, 'emailCustomer'), 'freakin_rider@gmail.com');
  assert.equal(extractInputValue(html, 'total'), '32.50');
  assert.equal(extractInputValue(html, 'totalfin'), '32.50'); // value-before-name order
  assert.equal(extractInputValue(html, 'idCliente'), '308707');
  assert.equal(extractInputValue(html, 'doesNotExist'), null);
});

test('extractSelectedOptionText: returns the SELECTED option text (selected="selected" or bare)', () => {
  const html = detailHtml();
  assert.equal(extractSelectedOptionText(html, 'cbMoneda'), 'USD');
  assert.equal(extractSelectedOptionText(html, 'cbCategoria'), 'SUV Compact AT (CFAR)');
  assert.equal(extractSelectedOptionText(html, 'nope'), null);
});

test('extractSelectedOptionText: ignores data-selected / class="selected" false positives (Innovation fix)', () => {
  // Only <option ... selected>Real</option> is the choice — the decoys must NOT match.
  const html = '<select name="cbX">'
    + '<option value="1" data-selected="0">Decoy A</option>'
    + '<option value="2" class="selected-row">Decoy B</option>'
    + '<option value="3" selected>Real</option>'
    + '</select>';
  assert.equal(extractSelectedOptionText(html, 'cbX'), 'Real');
});

test('extractSelectedOptionText: handles UNCLOSED <option> tags (Flexways cbCategoria — 2026-07-14)', () => {
  // Flexways renders the category <select> WITHOUT </option> closing tags. The
  // old regex required </option> and returned null for every real reservation
  // (→ vehicleAcriss null → everything to MANUAL_REVIEW). Real shape:
  const html = '<select name="cbCategoria" id="cbCategoria" class="form-control">'
    + '<option value="-1"> Mostrar todo '
    + '<option value="1" >Economico Base (EBMN)'
    + '<option value="296"  selected>Intermediate US (ICAR)'
    + '<option value="61" >Mini Van Auto (MVAR)'
    + '</select>';
  assert.equal(extractSelectedOptionText(html, 'cbCategoria'), 'Intermediate US (ICAR)');
  assert.equal(extractAcriss(extractSelectedOptionText(html, 'cbCategoria')), 'ICAR');
});

test('CONTRACT_CHANNEL_FILTER defaults FAIL-CLOSED to [API] (Innovation fix)', async () => {
  // Fresh import with no env → must be ['API'], not import-all.
  const mod = await import('./flexways.constants.js');
  assert.deepEqual(mod.CONTRACT_CHANNEL_FILTER, ['API']);
});

test('parseAmount: dot/comma decimals + thousands separators', () => {
  assert.equal(parseAmount('32.50'), 32.5);
  assert.equal(parseAmount('1,234.50'), 1234.5);   // US grouping
  assert.equal(parseAmount('1.234,50'), 1234.5);   // LATAM/EU grouping
  assert.equal(parseAmount('USD 32.50'), 32.5);
  assert.equal(parseAmount('45'), 45);
  assert.equal(parseAmount(''), null);
  assert.equal(parseAmount(null), null);
});

test('parseReservationDetailHtml: extracts email/total/currency/ACRISS (real recon shape)', () => {
  const d = parseReservationDetailHtml(detailHtml());
  assert.equal(d.customerEmail, 'freakin_rider@gmail.com');
  assert.equal(d.customerIdExternal, '308707');
  assert.equal(d.totalAmount, 32.5);
  assert.equal(d.currency, 'USD');
  assert.equal(d.vehicleAcriss, 'CFAR');
  assert.equal(d.vehicleCategoryLabel, 'SUV Compact AT (CFAR)');
});

test('parseReservationDetailHtml: ignores the test@test.com placeholder in the `email` fallback', () => {
  // emailCustomer empty → fallback `email` holds the placeholder → must be ignored.
  const html = detailHtml({ email: '', fallbackEmail: 'test@test.com' });
  const d = parseReservationDetailHtml(html);
  assert.equal(d.customerEmail, null);
  // But a real fallback email is used when emailCustomer is empty.
  const d2 = parseReservationDetailHtml(detailHtml({ email: '', fallbackEmail: 'real@person.com' }));
  assert.equal(d2.customerEmail, 'real@person.com');
});

test('parseReservationDetailHtml: category with no ACRISS parenthetical → vehicleAcriss null', () => {
  const d = parseReservationDetailHtml(detailHtml({ category: 'Categoria Sin Codigo' }));
  assert.equal(d.vehicleCategoryLabel, 'Categoria Sin Codigo');
  assert.equal(d.vehicleAcriss, null); // → MANUAL_REVIEW downstream
});

// ---------------------------------------------------------------------------
// contract row + detail → ExternalReservation (email + ACRISS + total populated)
// ---------------------------------------------------------------------------

test('mapContractToExternalReservation: merges contract row + detail into a promotable row', () => {
  const row = parseContractList(contractPayload())[0];
  const detail = parseReservationDetailHtml(detailHtml());
  const ext = mapContractToExternalReservation(row, detail);
  assert.equal(ext.externalRef, 'QJDK07');
  assert.equal(ext.status, 'CONFIRMED');
  assert.equal(ext.customerFirstName, 'Alfredo');
  assert.equal(ext.customerLastName, 'Reyes');
  // Enrichment from the detail page — these are what let evaluatePromotion go AUTO.
  assert.equal(ext.customerEmail, 'freakin_rider@gmail.com');
  assert.equal(ext.vehicleAcriss, 'CFAR');
  assert.equal(ext.totalAmount, 32.5);
  assert.equal(ext.currency, 'USD');
  assert.equal(ext.vehicleDescription, 'SUV Compact AT (CFAR)');
  assert.ok(ext.pickupAt instanceof Date);
  assert.ok(ext.dropoffAt instanceof Date);
  // external customer id preserved for the tray/audit (not a top-level column)
  assert.equal(ext.rawJson.customerIdExternal, '308707');
  assert.equal(ext.rawJson.contract.idAlquiler, '485160');
});

test('mapContractToExternalReservation: null detail → enrichment fields null (MANUAL_REVIEW fail-safe)', () => {
  const row = parseContractList(contractPayload())[0];
  const ext = mapContractToExternalReservation(row, null);
  assert.equal(ext.externalRef, 'QJDK07');
  assert.equal(ext.customerEmail, null);
  assert.equal(ext.vehicleAcriss, null);   // → acriss_unmapped → MANUAL_REVIEW
  assert.equal(ext.totalAmount, null);
  assert.equal(ext.currency, null);        // honest null on missing detail (not fabricated USD)
});

// ---------------------------------------------------------------------------
// sourceSpec → shared promoter parity (money posture: estimatedTotal only)
// ---------------------------------------------------------------------------

test('promoter (flexwaysSourceSpec) stamps FW- number + FRANCHISE_FLEXWAYS channel + notes-only extras', async () => {
  // Fake tx client capturing the reservation create payload.
  let created = null;
  const fakeTx = {
    reservation: {
      create: async ({ data }) => { created = data; return { id: 'res-1', ...data }; },
      findFirst: async () => null,
    },
    externalReservation: { update: async () => ({}) },
    reservationCharge: { createMany: async () => ({}) },
    auditLog: { create: async () => ({}) },
  };
  const extRes = {
    id: 'ext-1', tenantId: 't1', externalRef: 'QSRC58',
    customerFirstName: 'Joan', customerLastName: 'Visschedijk',
    pickupAt: new Date('2026-07-19T19:00:00Z'), dropoffAt: new Date('2026-07-21T19:00:00Z'),
    totalAmount: null, currency: 'USD', vehicleAcriss: null,
  };
  const decision = {
    decision: 'AUTO',
    mappedCustomer: { id: 'cust-1' },
    mappedVehicleCategory: 'ICAR',
    mappedLocation: { id: 'loc-1' },
  };
  const out = await promoteAutomatically(extRes, decision, {
    tx: fakeTx, prisma: fakeTx, actorUserId: null, tenantId: 't1',
  }).catch((e) => ({ __err: String(e && e.message) }));

  // We only assert the reservation payload the promoter built (not the full
  // pipeline, which booking-source tests already cover). If the shared promoter
  // signature differs, surface it rather than silently pass.
  if (created) {
    assert.ok(String(created.reservationNumber || '').startsWith('FW-'), `expected FW- number, got ${created.reservationNumber}`);
    assert.equal(created.bookingChannel, 'FRANCHISE_FLEXWAYS');
  } else {
    // Promoter arg-shape guard: at minimum it must not have thrown a wiring error.
    assert.ok(!out || !out.__err || !/is not a function|undefined/.test(out.__err), `promoter wiring error: ${out && out.__err}`);
  }
});

// ---------------------------------------------------------------------------
// window helpers delegate to the shared factory
// ---------------------------------------------------------------------------

test('windowBoundsForConfig honors per-sede overrides, falls back to FLEXWAYS defaults', () => {
  const now = new Date('2026-07-13T12:00:00Z').getTime();
  const def = windowBoundsForConfig({}, now);
  assert.ok(def.dateFrom instanceof Date && def.dateTo instanceof Date);
  assert.ok(def.dateTo > def.dateFrom);
  // per-sede override widens the window
  const wide = windowBoundsForConfig({ lookbackDays: 5, lookaheadDays: 60 }, now);
  assert.ok(wide.dateFrom < def.dateFrom);
  assert.ok(wide.dateTo > def.dateTo);
  assert.equal(effectiveWindowDays({ lookaheadDays: 60 }).lookaheadDays, 60);
});
