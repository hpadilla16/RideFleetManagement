/**
 * Migration upload parsing (2026-08-04, the VPH Motors incident).
 *
 * The failure this pins down: staff open the CSV template in Excel, Excel
 * converts it to XLSX on save (even keeping the .csv name), the browser read
 * the zip binary as text and validation rejected every row with errors that
 * blamed the user's data. Three layers get tested:
 *
 *   1. an Excel workbook parses into the exact row shape /bulk/validate eats
 *   2. dates survive Excel's habits — single-digit hours parse, date-TYPED
 *      cells render timezone-less
 *   3. a provable day/month swap produces a hint a human can act on, and an
 *      ambiguous one deliberately does NOT get guessed
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { looksLikeXlsx, parseReservationImportWorkbook } from './reservation-import-parse.js';
import { parseDateInput, dateInputHint } from './reservations.service.js';

async function workbookBuffer(build) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Sheet1');
  build(ws);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

describe('reservation import — workbook parsing', () => {
  it('detects an xlsx by magic bytes, whatever the file is named', async () => {
    const buf = await workbookBuffer((ws) => ws.addRow(['a']));
    assert.equal(looksLikeXlsx(buf), true);
    assert.equal(looksLikeXlsx(Buffer.from('reservationNumber,pickupAt\nMIG-1,2026-03-30T10:00')), false);
  });

  it('parses headers + rows into the /bulk/validate shape', async () => {
    const buf = await workbookBuffer((ws) => {
      ws.addRow(['reservationNumber', 'customerFirstName', 'pickupAt', 'notes']);
      ws.addRow(['MIG-1001', 'Jose', '2026-03-30T10:00', 'Imported, needs review']);
      ws.addRow(['MIG-1002', 'Ana', '2026-04-01T09:00', '']);
    });
    const { headers, rows } = await parseReservationImportWorkbook(buf);
    assert.deepEqual(headers, ['reservationNumber', 'customerFirstName', 'pickupAt', 'notes']);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].reservationNumber, 'MIG-1001');
    assert.equal(rows[0].notes, 'Imported, needs review');
    assert.equal(rows[1].customerFirstName, 'Ana');
  });

  it('renders date-typed cells timezone-less, in the template format', async () => {
    const buf = await workbookBuffer((ws) => {
      ws.addRow(['pickupAt']);
      // What Excel stores when someone retypes a date: a real date cell.
      ws.addRow([new Date(Date.UTC(2026, 2, 30, 10, 0))]);
    });
    const { rows } = await parseReservationImportWorkbook(buf);
    assert.equal(rows[0].pickupAt, '2026-03-30T10:00');
  });

  it('drops rows Excel kept alive after their content was deleted', async () => {
    const buf = await workbookBuffer((ws) => {
      ws.addRow(['reservationNumber', 'pickupAt']);
      ws.addRow(['MIG-1', '2026-03-30T10:00']);
      ws.addRow(['', '']); // touched-then-cleared row
      ws.addRow(['MIG-2', '2026-04-02T10:00']);
    });
    const { rows } = await parseReservationImportWorkbook(buf);
    assert.deepEqual(rows.map((r) => r.reservationNumber), ['MIG-1', 'MIG-2']);
  });
});

describe('reservation import — date forgiveness and hints', () => {
  it('accepts the single-digit hour Excel produces', () => {
    const d = parseDateInput('2026-03-08T9:00');
    assert.ok(d instanceof Date && !Number.isNaN(d.getTime()));
    assert.equal(d.getHours(), 9);
  });

  it('names a provable day/month swap instead of a bare "invalid"', () => {
    assert.match(dateInputHint('2026-21-07T9:00'), /day and month look swapped/);
    assert.equal(parseDateInput('2026-21-07T9:00'), null, 'a swapped date must still FAIL — no silent guessing');
  });

  it('stays silent on ambiguous dates — guessing would import rentals nobody booked', () => {
    assert.equal(dateInputHint('2026-03-08T9:00'), null);
    assert.equal(dateInputHint('not-a-date'), null);
    assert.equal(dateInputHint(''), null);
  });
});
