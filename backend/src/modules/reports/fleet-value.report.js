/**
 * Fleet Value & Rotation — 2026-06-10 (Vehicle Profile pack follow-up).
 *
 * Pedido por Hector: "reporte que muestre el valor de inventario y lista de
 * carros con su valor que entró, depreciación, cuál es el valor y cuándo le
 * toca venta."
 *
 *   GET /api/reports/fleet-value?locationId=
 *     Returns { asOf, rule, totals, rows[], untracked, filters }
 *
 * Inputs per vehicle (set on the profile / Edit Vehicle, beta.157):
 *   acquisitionCost, acquisitionDate, depreciationAnnualPct (declining
 *   balance), targetFleetMonths / targetFleetMiles.
 * Tenant rotation rule (TIME | MILEAGE) comes from AppSetting
 * fleetRotationConfig — same source the dashboard "Ready to Rotate" tile uses,
 * so the two never disagree.
 *
 * Informational only — nothing here feeds billing.
 */

import { registerReport } from './reports-v2.routes.js';
import { computeVehicleValue, rotationStatus } from '../vehicles/vehicle-value.js';
import { settingsService } from '../settings/settings.service.js';
import { DEFAULT_TENANT_TIMEZONE, dayLabelInTz } from '../../lib/date-utils.js';
import { resolveTenantTimeZone } from '../../lib/tenant-tz.js';

const MAX_RESULTS = 1000;
const MS_PER_MONTH = 1000 * 60 * 60 * 24 * 30.4375;

const STATUS_LABEL = {
  AVAILABLE: 'Available',
  RESERVED: 'Reserved',
  ON_RENT: 'On rent',
  IN_MAINTENANCE: 'Maintenance',
  OUT_OF_SERVICE: 'Out of service',
  SOLD: 'Sold',
};

const ROTATION_LABEL = { ready: 'Ready to sell', approaching: 'Approaching', ok: 'In window' };
const ROTATION_ORDER = { ready: 0, approaching: 1, ok: 2 };

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }
function round2(v) { return Math.round(v * 100) / 100; }

let _defaultPrisma = null;
async function resolveDefaultPrisma() {
  if (_defaultPrisma) return _defaultPrisma;
  const mod = await import('../../lib/prisma.js');
  _defaultPrisma = mod.prisma;
  return _defaultPrisma;
}

/** Sale-due descriptor under the tenant rule. Pure — exposed for tests. */
export function saleDue({ rule, acquisitionDate, targetFleetMonths, mileage, targetFleetMiles, now = new Date() }) {
  if (String(rule).toUpperCase() === 'MILEAGE') {
    if (!targetFleetMiles) return null;
    const remaining = num(targetFleetMiles) - num(mileage);
    return {
      kind: 'MILEAGE',
      dueAt: null,
      label: remaining <= 0
        ? `Past target by ${Math.abs(remaining).toLocaleString()} mi`
        : `In ${remaining.toLocaleString()} mi (${num(mileage).toLocaleString()} / ${num(targetFleetMiles).toLocaleString()})`,
    };
  }
  if (!acquisitionDate || !targetFleetMonths) return null;
  const start = new Date(acquisitionDate);
  if (Number.isNaN(start.getTime())) return null;
  const dueAt = new Date(start.getTime() + num(targetFleetMonths) * MS_PER_MONTH);
  return { kind: 'TIME', dueAt: dueAt.toISOString(), label: null };
}

async function computeData({ tenantId, query }, deps = {}) {
  const prisma = deps.prisma || (await resolveDefaultPrisma());
  if (!tenantId) throw new Error('tenantId required');

  const tenantTz = deps.tenantTz || (await resolveTenantTimeZone(tenantId));
  const locationId = (query && query.locationId) || null;
  const asOf = (deps && deps.now) || new Date();
  const rotationCfg = deps.rotationCfg
    || (await settingsService.getFleetRotationConfig({ tenantId }).catch(() => ({ rule: 'TIME' })));
  const rule = rotationCfg?.rule === 'MILEAGE' ? 'MILEAGE' : 'TIME';

  const where = { tenantId, status: { not: 'SOLD' } };
  if (locationId) where.homeLocationId = locationId;

  const vehicles = await prisma.vehicle.findMany({
    where,
    select: {
      id: true,
      internalNumber: true,
      plate: true,
      year: true,
      make: true,
      model: true,
      mileage: true,
      status: true,
      acquisitionCost: true,
      acquisitionDate: true,
      depreciationAnnualPct: true,
      targetFleetMonths: true,
      targetFleetMiles: true,
      vehicleType: { select: { name: true } },
      homeLocation: { select: { name: true } },
    },
    orderBy: { internalNumber: 'asc' },
    take: MAX_RESULTS,
  });

  const rows = [];
  let untrackedCount = 0;
  let totalCost = 0;
  let totalValue = 0;
  let readyCount = 0;
  let approachingCount = 0;

  for (const v of vehicles) {
    const value = computeVehicleValue({
      acquisitionCost: v.acquisitionCost,
      acquisitionDate: v.acquisitionDate,
      depreciationAnnualPct: v.depreciationAnnualPct,
      now: asOf,
    });
    const rotation = rotationStatus({
      rule,
      acquisitionDate: v.acquisitionDate,
      targetFleetMonths: v.targetFleetMonths,
      mileage: v.mileage,
      targetFleetMiles: v.targetFleetMiles,
      now: asOf,
    });
    if (!value && !rotation) { untrackedCount += 1; continue; }

    const due = saleDue({
      rule,
      acquisitionDate: v.acquisitionDate,
      targetFleetMonths: v.targetFleetMonths,
      mileage: v.mileage,
      targetFleetMiles: v.targetFleetMiles,
      now: asOf,
    });

    const cost = value ? num(v.acquisitionCost) : null;
    if (value) {
      totalCost += cost;
      totalValue += value.currentValue;
    }
    if (rotation === 'ready') readyCount += 1;
    if (rotation === 'approaching') approachingCount += 1;

    rows.push({
      id: v.id,
      internalNumber: v.internalNumber,
      plate: v.plate || null,
      label: [v.year, v.make, v.model].filter(Boolean).join(' ') || null,
      vehicleType: v.vehicleType?.name || null,
      homeLocation: v.homeLocation?.name || null,
      status: v.status,
      statusLabel: STATUS_LABEL[v.status] || v.status,
      mileage: num(v.mileage),
      acquisitionCost: cost,
      acquisitionDate: v.acquisitionDate ? new Date(v.acquisitionDate).toISOString() : null,
      acquisitionDateLabel: v.acquisitionDate ? dayLabelInTz(new Date(v.acquisitionDate), tenantTz) : null,
      depreciationAnnualPct: v.depreciationAnnualPct == null ? null : Number(v.depreciationAnnualPct),
      currentValue: value ? value.currentValue : null,
      depreciatedAmount: value ? round2(cost - value.currentValue) : null,
      depreciatedPct: value ? value.depreciatedPct : null,
      monthsInFleet: value ? value.monthsInFleet : null,
      rotation: rotation || null,
      rotationLabel: rotation ? ROTATION_LABEL[rotation] : null,
      saleDueAt: due?.dueAt || null,
      saleDueLabel: due
        ? (due.kind === 'TIME' ? dayLabelInTz(new Date(due.dueAt), tenantTz) : due.label)
        : null,
    });
  }

  // Ready first, then approaching, then by due date / months in fleet desc.
  rows.sort((a, b) => {
    const ra = a.rotation ? ROTATION_ORDER[a.rotation] : 3;
    const rb = b.rotation ? ROTATION_ORDER[b.rotation] : 3;
    if (ra !== rb) return ra - rb;
    if (a.saleDueAt && b.saleDueAt) return new Date(a.saleDueAt) - new Date(b.saleDueAt);
    return num(b.monthsInFleet) - num(a.monthsInFleet);
  });

  return {
    asOf: asOf.toISOString(),
    asOfLabel: dayLabelInTz(asOf, tenantTz),
    tenantTimeZone: tenantTz,
    rule,
    totals: {
      trackedCount: rows.length,
      untrackedCount,
      totalAcquisitionCost: round2(totalCost),
      totalCurrentValue: round2(totalValue),
      totalDepreciated: round2(totalCost - totalValue),
      readyCount,
      approachingCount,
    },
    rows,
    filters: { locationId },
    truncated: vehicles.length >= MAX_RESULTS,
  };
}

// ---------------------------------------------------------------------------
// HTML (PDF)
// ---------------------------------------------------------------------------

function escapeHtml(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
const money = (v) => (v == null ? '—' : `$${Number(v).toLocaleString('en-US', { maximumFractionDigits: 0 })}`);

function renderHtml(data) {
  const { totals, rows, rule, asOfLabel } = data;
  const strip = `<div class="strip">
    <div class="strip-card"><div class="strip-label">Invested</div><div class="strip-value">${money(totals.totalAcquisitionCost)}</div></div>
    <div class="strip-card"><div class="strip-label">Current fleet value</div><div class="strip-value">${money(totals.totalCurrentValue)}</div></div>
    <div class="strip-card heat-amber"><div class="strip-label">Depreciated</div><div class="strip-value">${money(totals.totalDepreciated)}</div></div>
    <div class="strip-card heat-red"><div class="strip-label">Ready to sell</div><div class="strip-value">${totals.readyCount}</div></div>
  </div>`;

  let body = `${strip}
    <p style="font-size:10px;color:#5F5E5A;margin:0 0 12px">As of ${escapeHtml(asOfLabel)} · Rotation rule: ${rule === 'MILEAGE' ? 'mileage target' : 'time in fleet'} · ${totals.trackedCount} tracked · ${totals.untrackedCount} without value data</p>
    <table style="font-size:10px"><thead><tr>
      <th style="text-align:left">Unit</th>
      <th style="text-align:left">Vehicle</th>
      <th style="text-align:left">Acquired</th>
      <th class="num">Cost</th>
      <th class="num">%/yr</th>
      <th class="num">Value today</th>
      <th class="num">Depreciated</th>
      <th style="text-align:left">Sale due</th>
      <th style="text-align:left">Rotation</th>
    </tr></thead><tbody>`;
  for (const r of rows) {
    body += `<tr>
      <td><strong>${escapeHtml(r.internalNumber || r.plate || '—')}</strong></td>
      <td>${escapeHtml(r.label || '—')}</td>
      <td>${escapeHtml(r.acquisitionDateLabel || '—')}</td>
      <td class="num">${money(r.acquisitionCost)}</td>
      <td class="num">${r.depreciationAnnualPct == null ? '—' : `${r.depreciationAnnualPct}%`}</td>
      <td class="num">${money(r.currentValue)}</td>
      <td class="num">${r.depreciatedPct == null ? '—' : `${money(r.depreciatedAmount)} (${r.depreciatedPct}%)`}</td>
      <td>${escapeHtml(r.saleDueLabel || '—')}</td>
      <td>${escapeHtml(r.rotationLabel || '—')}</td>
    </tr>`;
  }
  body += `</tbody></table>`;
  if (!rows.length) {
    body += `<p style="text-align:center;color:#5F5E5A;font-size:11px;padding:30px">No vehicles have value-tracker data yet — set cost, depreciation and targets from each vehicle's Edit form.</p>`;
  }
  return body;
}

// ---------------------------------------------------------------------------
// Excel
// ---------------------------------------------------------------------------

function buildExcelSpec(data) {
  const { rows, totals, rule, asOfLabel } = data;
  const title = 'Fleet Value & Rotation';
  const subtitle = `As of ${asOfLabel} · ${rule === 'MILEAGE' ? 'Mileage rule' : 'Time-in-fleet rule'} · Invested ${money(totals.totalAcquisitionCost)} · Value ${money(totals.totalCurrentValue)}`;

  const columns = [
    { header: 'Unit',           key: 'unit',       width: 12 },
    { header: 'Plate',          key: 'plate',      width: 10 },
    { header: 'Vehicle',        key: 'label',      width: 24 },
    { header: 'Class',          key: 'class',      width: 14 },
    { header: 'Acquired',       key: 'acquired',   width: 14 },
    { header: 'Cost',           key: 'cost',       width: 14, type: 'currency' },
    { header: 'Depreciation %/yr', key: 'pct',     width: 14 },
    { header: 'Months in fleet', key: 'months',    width: 14 },
    { header: 'Value today',    key: 'value',      width: 14, type: 'currency' },
    { header: 'Depreciated $',  key: 'depAmt',     width: 14, type: 'currency' },
    { header: 'Depreciated %',  key: 'depPct',     width: 14 },
    { header: 'Mileage',        key: 'mileage',    width: 12, type: 'integer' },
    { header: 'Sale due',       key: 'due',        width: 18 },
    { header: 'Rotation',       key: 'rotation',   width: 14 },
    { header: 'Status',         key: 'status',     width: 14 },
    { header: 'Location',       key: 'location',   width: 18 },
  ];

  const dataRows = rows.map((r) => ({
    unit: r.internalNumber || '',
    plate: r.plate || '',
    label: r.label || '',
    class: r.vehicleType || '',
    acquired: r.acquisitionDateLabel || '',
    cost: r.acquisitionCost ?? '',
    pct: r.depreciationAnnualPct ?? '',
    months: r.monthsInFleet ?? '',
    value: r.currentValue ?? '',
    depAmt: r.depreciatedAmount ?? '',
    depPct: r.depreciatedPct ?? '',
    mileage: r.mileage,
    due: r.saleDueLabel || '',
    rotation: r.rotationLabel || '',
    status: r.statusLabel,
    location: r.homeLocation || '',
  }));

  return {
    title,
    subtitle,
    sheets: [{
      name: 'Fleet value',
      bannerRows: [[title], [subtitle]],
      columns,
      rows: dataRows,
    }],
  };
}

registerReport({
  slug: 'fleet-value',
  title: 'Fleet Value & Rotation',
  computeData,
  renderHtml,
  buildExcelSpec,
});

export const _fleetValueInternal = { computeData, saleDue };
