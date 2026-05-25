/**
 * Reports export helpers — Round 24 (2026-05-22).
 *
 * Two generic helpers for the new reports module:
 *
 *   renderReportPdf(html, opts)
 *     Reuses the singleton Puppeteer browser to render an HTML string to a
 *     PDF Buffer. Same pattern as agreementPdfBuffer() in
 *     rental-agreements.service.js (orientation/format are configurable).
 *
 *   renderReportExcel(workbookSpec)
 *     Builds an ExcelJS workbook from a small declarative spec — multiple
 *     sheets, each with title rows + a column-typed table. Returns
 *     { buffer, filename }.
 *
 * Why these live in the reports module and not in lib/:
 *   - They embed report-specific presentation choices (banner row, footer
 *     date, column widths sane for tables) that other modules don't want.
 *   - The PDF helper expects fully self-contained HTML — no remote assets.
 *
 * Round 24 reports use these from their *-service.js files. Each report
 * also renders its own HTML template for PDF (using the same wrapper layout
 * so all 17 reports look consistent printed).
 */

import ExcelJS from 'exceljs';

let _getBrowser = null;
async function resolveBrowser() {
  if (_getBrowser) return _getBrowser;
  const mod = await import('../../lib/puppeteer-browser.js');
  _getBrowser = mod.getBrowser;
  return _getBrowser;
}

let _logger = null;
async function getLogger() {
  if (_logger) return _logger;
  try {
    const mod = await import('../../lib/logger.js');
    _logger = mod.default || mod;
  } catch {
    _logger = { info: () => {}, warn: () => {}, error: () => {} };
  }
  return _logger;
}

// ---------------------------------------------------------------------------
// PDF
// ---------------------------------------------------------------------------

/**
 * Render an HTML string to a PDF Buffer.
 *
 * @param {string} html — self-contained HTML (CSS inline, images as data URLs)
 * @param {object} [opts]
 * @param {string} [opts.format='Letter']  — Puppeteer paper format
 * @param {boolean} [opts.landscape=true]  — most reports are wider than tall
 * @param {string} [opts.marginTop='0.5in']
 * @param {string} [opts.marginBottom='0.5in']
 * @param {string} [opts.marginLeft='0.5in']
 * @param {string} [opts.marginRight='0.5in']
 * @returns {Promise<Buffer>}
 */
export async function renderReportPdf(html, opts = {}) {
  if (!html || typeof html !== 'string') {
    throw new Error('renderReportPdf: html string required');
  }
  const getBrowser = await resolveBrowser();
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    await page.setContent(html, { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => Promise.all(
      Array.from(document.images)
        .filter((img) => !img.complete)
        .map((img) => new Promise((resolve) => {
          img.addEventListener('load', resolve, { once: true });
          img.addEventListener('error', resolve, { once: true });
        }))
    ));
    const pdfBuffer = await page.pdf({
      format: opts.format || 'Letter',
      landscape: opts.landscape !== false,
      printBackground: true,
      margin: {
        top:    opts.marginTop    || '0.5in',
        bottom: opts.marginBottom || '0.5in',
        left:   opts.marginLeft   || '0.5in',
        right:  opts.marginRight  || '0.5in',
      },
    });
    return pdfBuffer;
  } finally {
    await page.close().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Excel
// ---------------------------------------------------------------------------

/**
 * Render a multi-sheet Excel workbook from a declarative spec.
 *
 * @param {object} spec
 * @param {string} spec.title — used for the filename + the banner row
 * @param {string} spec.subtitle — optional metadata under the banner
 * @param {Array<object>} spec.sheets
 *   Each sheet: {
 *     name: 'Sheet1',
 *     columns: [
 *       { header: 'Clerk',         key: 'clerk',         width: 18 },
 *       { header: 'Counter $',     key: 'counter',       width: 14, type: 'currency' },
 *       { header: 'Commission $',  key: 'commission',    width: 14, type: 'currency' },
 *       { header: 'Attach %',      key: 'attach',        width: 12, type: 'percent' },
 *     ],
 *     rows: [{ clerk: 'Valeria', counter: 23733.67, commission: 503, attach: 0.39 }, ...],
 *     bannerRows: [['April 2026 Commission Report'], ['Generated 2026-05-22']],  // optional
 *   }
 * @returns {Promise<{ buffer: ArrayBuffer, filename: string }>}
 */
export async function renderReportExcel(spec) {
  if (!spec?.title) throw new Error('renderReportExcel: spec.title required');
  if (!Array.isArray(spec.sheets) || spec.sheets.length === 0) {
    throw new Error('renderReportExcel: spec.sheets must be non-empty array');
  }
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'RideFleet Manager';
  workbook.created = new Date();

  for (const sheetSpec of spec.sheets) {
    const sheet = workbook.addWorksheet(sheetSpec.name || 'Sheet 1');

    // Banner rows (title + subtitle) — printed before the column header
    const banners = sheetSpec.bannerRows || [
      [spec.title],
      ...(spec.subtitle ? [[spec.subtitle]] : []),
    ];
    let row = 1;
    for (const bannerRow of banners) {
      const r = sheet.getRow(row);
      bannerRow.forEach((val, i) => {
        r.getCell(i + 1).value = val;
        r.getCell(i + 1).font = { bold: row === 1, size: row === 1 ? 14 : 11 };
      });
      row++;
    }
    row++; // blank row before the table

    // Column headers
    const cols = sheetSpec.columns || [];
    const headerRow = sheet.getRow(row);
    cols.forEach((col, i) => {
      const cell = headerRow.getCell(i + 1);
      cell.value = col.header;
      cell.font = { bold: true };
      cell.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FFE8EAED' },
      };
      cell.border = { bottom: { style: 'thin', color: { argb: 'FF888888' } } };
      const w = Number(col.width);
      if (Number.isFinite(w) && w > 0) sheet.getColumn(i + 1).width = w;
    });
    row++;

    // Data rows
    const dataRows = sheetSpec.rows || [];
    for (const r of dataRows) {
      const sheetRow = sheet.getRow(row);
      cols.forEach((col, i) => {
        const cell = sheetRow.getCell(i + 1);
        cell.value = r[col.key];
        if (col.type === 'currency') {
          cell.numFmt = '$#,##0.00';
        } else if (col.type === 'percent') {
          cell.numFmt = '0.0%';
        } else if (col.type === 'integer') {
          cell.numFmt = '#,##0';
        } else if (col.type === 'date') {
          cell.numFmt = 'yyyy-mm-dd';
        }
      });
      row++;
    }

    // Optional footer row (totals)
    if (sheetSpec.footerRow) {
      const sheetRow = sheet.getRow(row);
      cols.forEach((col, i) => {
        const cell = sheetRow.getCell(i + 1);
        cell.value = sheetSpec.footerRow[col.key];
        cell.font = { bold: true };
        cell.border = { top: { style: 'thin', color: { argb: 'FF888888' } } };
        if (col.type === 'currency') cell.numFmt = '$#,##0.00';
        else if (col.type === 'percent') cell.numFmt = '0.0%';
        else if (col.type === 'integer') cell.numFmt = '#,##0';
      });
    }
  }

  const buffer = await workbook.xlsx.writeBuffer();
  const slug = String(spec.title).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const date = new Date().toISOString().slice(0, 10);
  return {
    buffer,
    filename: `${slug}-${date}.xlsx`,
  };
}

// ---------------------------------------------------------------------------
// Shared HTML wrapper (for consistent PDF rendering across all 17 reports)
// ---------------------------------------------------------------------------

/**
 * Wrap a report's inner HTML in the shared report PDF layout. Embeds a title
 * banner + generated-at footer + reset CSS so every report PDF feels like part
 * of the same family without each report re-implementing the chrome.
 *
 * @param {object} args
 * @param {string} args.title
 * @param {string} args.subtitle    — date range, tenant name, etc.
 * @param {string} args.innerHtml   — the report's table/chart body HTML
 * @returns {string}
 */
export function wrapReportHtml({ title, subtitle = '', innerHtml = '' }) {
  return `<!doctype html><html><head><meta charset="utf-8">
<style>
  * { box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; color: #211a38; margin: 0; padding: 0; font-size: 11px; line-height: 1.4; }
  .report-header { padding: 18px 24px 12px; border-bottom: 2px solid #211a38; }
  .report-title { font-size: 20px; font-weight: 600; margin: 0; color: #211a38; }
  .report-subtitle { font-size: 11px; color: #6f668f; margin: 4px 0 0; }
  .report-body { padding: 16px 24px 24px; }
  .report-footer { padding: 8px 24px; font-size: 9px; color: #888780; border-top: 0.5px solid #d3d1c7; text-align: right; }
  table { border-collapse: collapse; width: 100%; font-size: 10.5px; }
  table th { background: #ECEEF0; padding: 6px 8px; text-align: left; font-weight: 600; border-bottom: 1px solid #888780; }
  table td { padding: 5px 8px; border-bottom: 0.5px solid #e6dfff; }
  table th.num, table td.num { text-align: right; font-variant-numeric: tabular-nums; }
  .heat-green { background: #C0DD97; color: #173404; }
  .heat-amber { background: #FAC775; color: #412402; }
  .heat-red { background: #F7C1C1; color: #501313; }
  .heat-dark { background: #501313; color: white; }
  h3 { font-size: 12px; font-weight: 600; margin: 16px 0 6px; color: #211a38; }
  .strip { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; margin: 10px 0 14px; }
  .strip-card { background: #F1EFE8; padding: 8px 10px; border-radius: 4px; }
  .strip-label { font-size: 9px; color: #5F5E5A; }
  .strip-value { font-size: 16px; font-weight: 500; margin-top: 2px; }
</style></head><body>
  <div class="report-header">
    <div class="report-title">${escapeHtml(title)}</div>
    ${subtitle ? `<div class="report-subtitle">${escapeHtml(subtitle)}</div>` : ''}
  </div>
  <div class="report-body">${innerHtml}</div>
  <div class="report-footer">Generated ${new Date().toISOString().slice(0, 19).replace('T', ' ')} UTC · RideFleet Manager</div>
</body></html>`;
}

function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
