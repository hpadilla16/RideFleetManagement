/**
 * Inventory report — print HTML builder (2026-06-09). Pure function: takes an
 * assembled inventory session and returns a print-ready HTML document, rendered
 * to PDF via reports-export.renderReportPdf(). Light corporate theme matching
 * the incident report. No DB access here.
 */

function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function statusLabel(status) {
  switch (String(status || '').toUpperCase()) {
    case 'AVAILABLE': return 'Available';
    case 'RESERVED': return 'Reserved';
    case 'ON_RENT': return 'Checked out';
    case 'IN_MAINTENANCE': return 'Maintenance';
    case 'OUT_OF_SERVICE': return 'Out of service';
    default: return status || '-';
  }
}

function locatedLabel(located) {
  switch (String(located || '').toUpperCase()) {
    case 'AT_LOT': return 'At lot';
    case 'IN_MAINTENANCE': return 'Maintenance';
    case 'OUT_OF_SERVICE': return 'Out of service';
    case 'ON_RENT': return 'Checked out';
    case 'NOT_FOUND': return 'Not found';
    default: return '-';
  }
}

function mismatchLabel(type) {
  switch (String(type || '').toUpperCase()) {
    case 'ON_RENT_OVERDUE': return 'Checked out but overdue';
    case 'SHOULD_BE_ON_RENT': return 'Should be checked out';
    default: return type || '-';
  }
}

function fmtDate(d) {
  if (!d) return '-';
  const dt = new Date(d);
  return Number.isNaN(dt.getTime()) ? '-' : dt.toLocaleString();
}

function checklist(it) {
  const map = [['Tires', it.tiresOk], ['Brakes', it.brakesOk], ['Lights', it.lightsOk], ['Fluids', it.fluidsOk], ['Clean', it.cleanOk]];
  const parts = map.filter(([, v]) => v !== null && v !== undefined).map(([k, v]) => `${k}: ${v ? 'OK' : 'X'}`);
  return parts.join(' · ') || '-';
}

function mileageCell(it) {
  if (it.reportedMileage != null) return `${Number(it.reportedMileage).toLocaleString()} (corrected)`;
  if (it.expectedMileage != null) return `${Number(it.expectedMileage).toLocaleString()}`;
  return '-';
}

/**
 * @param {object} data
 *   { tenantName, generatedAt, generatedBy, totals, items: [{ vehicle, ... }] }
 */
export function buildInventoryReportHtml(data = {}) {
  const tenantName = data.tenantName || 'Ride Fleet';
  const totals = data.totals || {};
  const items = Array.isArray(data.items) ? data.items : [];

  // Group at-lot / checked-out vehicles by home location for the main listing.
  const byLot = new Map();
  const maintenance = [];
  const exceptions = [];
  const mismatches = [];
  for (const it of items) {
    if (it.mismatchType) {
      mismatches.push(it);
    }
    if (it.state === 'EXCEPTION') {
      exceptions.push(it);
      continue;
    }
    const exp = String(it.expectedStatus || '').toUpperCase();
    if (exp === 'IN_MAINTENANCE' || exp === 'OUT_OF_SERVICE') {
      maintenance.push(it);
      continue;
    }
    const lot = it.vehicle?.homeLocation?.name || 'Unassigned';
    if (!byLot.has(lot)) byLot.set(lot, []);
    byLot.get(lot).push(it);
  }

  const metric = (label, value) => `<div class="metric"><div class="mv">${esc(value)}</div><div class="ml">${esc(label)}</div></div>`;

  const lotSections = [...byLot.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([lot, list]) => `
    <h3>${esc(lot)} <span class="count">${list.length}</span></h3>
    <table class="grid">
      <thead><tr><th>Unit</th><th>Plate</th><th>Status</th><th>Confirmed as</th><th>Method</th><th>Mileage</th><th>Checklist</th><th>Note</th></tr></thead>
      <tbody>
        ${list.map((it) => `<tr>
          <td>${esc(it.vehicle?.internalNumber || '-')}</td>
          <td>${esc(it.vehicle?.plate || '-')}</td>
          <td>${esc(statusLabel(it.expectedStatus))}</td>
          <td>${esc(locatedLabel(it.locatedStatus))}</td>
          <td>${esc(it.confirmMethod || '-')}</td>
          <td>${esc(mileageCell(it))}</td>
          <td class="sm">${esc(checklist(it))}</td>
          <td class="sm">${esc(it.note || '')}</td>
        </tr>`).join('')}
      </tbody>
    </table>`).join('') || '<p class="muted">No vehicles confirmed at a lot.</p>';

  const maintenanceSection = maintenance.length ? `
    <h3>Maintenance / out of service <span class="count">${maintenance.length}</span></h3>
    <table class="grid">
      <thead><tr><th>Unit</th><th>Plate</th><th>Status</th><th>Status note</th></tr></thead>
      <tbody>${maintenance.map((it) => `<tr><td>${esc(it.vehicle?.internalNumber || '-')}</td><td>${esc(it.vehicle?.plate || '-')}</td><td>${esc(statusLabel(it.expectedStatus))}</td><td class="sm">${esc(it.maintenanceNote || '-')}</td></tr>`).join('')}</tbody>
    </table>` : '';

  const exceptionsSection = exceptions.length ? `
    <h3>Exceptions — not located <span class="count">${exceptions.length}</span></h3>
    <table class="grid">
      <thead><tr><th>Unit</th><th>Plate</th><th>Expected</th><th>Reason</th></tr></thead>
      <tbody>${exceptions.map((it) => `<tr><td>${esc(it.vehicle?.internalNumber || '-')}</td><td>${esc(it.vehicle?.plate || '-')}</td><td>${esc(statusLabel(it.expectedStatus))}</td><td class="sm">${esc(it.confirmReason || '-')}</td></tr>`).join('')}</tbody>
    </table>` : '';

  const mismatchSection = mismatches.length ? `
    <h3>Status mismatches <span class="count">${mismatches.length}</span></h3>
    <table class="grid">
      <thead><tr><th>Unit</th><th>Plate</th><th>Mismatch</th><th>Handled</th><th>Note</th></tr></thead>
      <tbody>${mismatches.map((it) => `<tr><td>${esc(it.vehicle?.internalNumber || '-')}</td><td>${esc(it.vehicle?.plate || '-')}</td><td>${esc(mismatchLabel(it.mismatchType))}</td><td>${it.mismatchResolved ? 'Resolved with note' : 'Open'}</td><td class="sm">${esc(it.mismatchResolutionNote || '-')}</td></tr>`).join('')}</tbody>
    </table>` : '';

  return `<!DOCTYPE html><html><head><meta charset="utf-8"/><style>
    * { box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #1f2430; margin: 0; padding: 24px; font-size: 12px; }
    .head { border-bottom: 3px solid #211a38; padding-bottom: 10px; margin-bottom: 16px; }
    .head h1 { margin: 0; font-size: 20px; color: #211a38; }
    .head .sub { color: #5f5e6e; font-size: 12px; margin-top: 4px; }
    .metrics { display: flex; gap: 10px; flex-wrap: wrap; margin: 14px 0 18px; }
    .metric { border: 1px solid #e4e1ef; border-radius: 8px; padding: 8px 14px; min-width: 90px; }
    .mv { font-size: 20px; font-weight: 600; }
    .ml { font-size: 11px; color: #5f5e6e; }
    h3 { font-size: 13px; color: #211a38; margin: 18px 0 6px; border-bottom: 1px solid #e4e1ef; padding-bottom: 4px; }
    h3 .count { color: #8a8699; font-weight: 400; }
    table.grid { width: 100%; border-collapse: collapse; font-size: 11px; }
    table.grid th { text-align: left; background: #f4f3fa; color: #3a3550; padding: 5px 7px; border: 1px solid #e4e1ef; }
    table.grid td { padding: 5px 7px; border: 1px solid #e4e1ef; vertical-align: top; }
    td.sm { font-size: 10px; color: #4a4760; }
    .muted { color: #8a8699; }
    .foot { margin-top: 22px; border-top: 1px solid #e4e1ef; padding-top: 10px; font-size: 10px; color: #8a8699; }
  </style></head><body>
    <div class="head">
      <h1>Fleet inventory report</h1>
      <div class="sub">${esc(tenantName)} · Completed ${esc(fmtDate(data.generatedAt))}${data.generatedBy ? ` · by ${esc(data.generatedBy)}` : ''}</div>
    </div>
    <div class="metrics">
      ${metric('Vehicles', totals.total ?? items.length)}
      ${metric('Confirmed', totals.confirmed ?? 0)}
      ${metric('At lot', totals.atLot ?? 0)}
      ${metric('Checked out', totals.onRent ?? 0)}
      ${metric('Maintenance', totals.maintenance ?? 0)}
      ${metric('Exceptions', totals.exception ?? 0)}
      ${metric('Mismatches', totals.mismatches ?? 0)}
    </div>
    ${lotSections}
    ${maintenanceSection}
    ${exceptionsSection}
    ${mismatchSection}
    <div class="foot">Generated by the Ride Fleet Inventory Helper. Open mismatches remain tracked on the dashboard until resolved.</div>
  </body></html>`;
}
