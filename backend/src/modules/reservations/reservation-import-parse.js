/**
 * Workbook → rows for the reservation migration tool (2026-08-04).
 *
 * WHY: the migration upload asked for CSV, but the first thing any real user
 * does with a CSV template is open it in Excel — and Excel silently converts
 * it to XLSX on save (VPH Motors' file was literally named
 * `reservation_migration_template.csv.xlsx`). The frontend then read the zip
 * BINARY as text, split it into garbage "rows", and validation rejected all
 * 44 with errors that pointed at the user's data instead of the real problem.
 * Parsing happens here now, with exceljs (already a dependency), so an Excel
 * file is a first-class input instead of a trap.
 *
 * Returns plain string cells keyed by the header row — the exact shape the
 * existing /bulk/validate and /bulk/import expect. No validation here; that
 * stays in one place.
 */
import ExcelJS from 'exceljs';

const XLSX_MAGIC = Buffer.from('PK');

export function looksLikeXlsx(buffer) {
  return Buffer.isBuffer(buffer) && buffer.length > 4 && buffer.subarray(0, 2).equals(XLSX_MAGIC);
}

function pad(n) { return String(n).padStart(2, '0'); }

/**
 * Excel date cells arrive as JS Dates built from the timezone-less Excel
 * serial. Render them back with UTC getters into the template's own
 * `YYYY-MM-DDTHH:mm` shape — local getters would shift the wall-clock by the
 * server's offset, corrupting every date-typed cell.
 */
function cellToString(value) {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) {
    return `${value.getUTCFullYear()}-${pad(value.getUTCMonth() + 1)}-${pad(value.getUTCDate())}T${pad(value.getUTCHours())}:${pad(value.getUTCMinutes())}`;
  }
  if (typeof value === 'object') {
    // exceljs rich values: hyperlink cells, rich text, shared/regular formulas.
    if (value.richText) return value.richText.map((part) => part?.text || '').join('');
    if (value.text !== undefined) return String(value.text ?? '');
    if (value.result !== undefined) return cellToString(value.result);
    if (value.hyperlink) return String(value.hyperlink);
    return '';
  }
  return String(value);
}

export async function parseReservationImportWorkbook(buffer) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const sheet = workbook.worksheets[0];
  if (!sheet) return { headers: [], rows: [] };

  const headers = [];
  sheet.getRow(1).eachCell({ includeEmpty: true }, (cell, col) => {
    headers[col - 1] = cellToString(cell.value).trim();
  });
  while (headers.length && !headers[headers.length - 1]) headers.pop();

  const rows = [];
  sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber === 1) return;
    const out = {};
    let hasValue = false;
    headers.forEach((header, i) => {
      if (!header) return;
      const raw = cellToString(row.getCell(i + 1).value).trim();
      out[header] = raw;
      if (raw) hasValue = true;
    });
    // Excel keeps "touched" rows alive long after their content is deleted;
    // importing them as empties would fail validation with phantom rows.
    if (hasValue) rows.push(out);
  });

  return { headers: headers.filter(Boolean), rows };
}
