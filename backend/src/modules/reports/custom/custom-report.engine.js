/**
 * Report Builder engine (2026-07-26). One function executes any saved
 * definition: runCustomReport(definition, scope, opts).
 *
 * FAIL-CLOSED BY CONSTRUCTION:
 * - `scope` ({ tenantId, allowedLocationIds, role }) comes from req.user in
 *   the route — the definition JSON cannot express a tenant or location.
 *   Tenant + location filters are injected here before any user filter.
 * - Every column/filter/groupBy key must exist in the dataset registry AND be
 *   visible to the RUNNER's role; unknown keys become "(unavailable)"
 *   columns (drift-safe), role-hidden keys are stripped and reported.
 * - Datasets with no location column are BLOCKED for location-scoped users
 *   (scopedUsersBlocked) — consistent with reports-v2's fail-closed posture.
 *
 * TZ: all day/week/month bucketing goes through isoDayInTz with the tenant's
 * timezone (the sales.report 2026-05-26 lesson — never bucket in UTC).
 */
import { prisma } from '../../../lib/prisma.js';
import { CUSTOM_REPORT_DATASETS, MONEY_ROLES, STAFF_ROLES } from './custom-report-datasets.js';
import { isoDayInTz, startOfDayInTz, addDaysInTz, startOfMonthInTz, addMonthsInTz } from '../../../lib/date-utils.js';
import { resolveTenantTimeZone } from '../../../lib/tenant-tz.js';

export const PREVIEW_ROW_CAP = 200;
export const EXPORT_ROW_CAP = 5000;
const MAX_RANGE_DAYS = 366;
const DAY_MS = 24 * 60 * 60 * 1000;

class CustomReportError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}
export { CustomReportError };

function nestedWhere(path, cond) {
  const parts = String(path).split('.');
  let out = cond;
  for (let i = parts.length - 1; i >= 0; i -= 1) out = { [parts[i]]: out };
  return out;
}

function deepMergeSelect(target, extra) {
  for (const [key, value] of Object.entries(extra || {})) {
    if (value && typeof value === 'object') {
      if (!target[key] || typeof target[key] !== 'object' || target[key] === true) target[key] = {};
      deepMergeSelect(target[key], value);
    } else if (target[key] === undefined) {
      target[key] = value;
    }
  }
  return target;
}

// Prisma relation selects need a `select` wrapper at EVERY hop:
// 'vehicle.internalNumber' -> { vehicle: { select: { internalNumber: true } } }.
// (QA blocker: the old nestedWhere-shaped select was invalid Prisma and 500'd
// the preview the moment a path-only chip like "Agreement status" was ticked.)
function pathToSelect(path) {
  const parts = String(path).split('.');
  let out = true;
  for (let i = parts.length - 1; i >= 0; i -= 1) {
    out = i === parts.length - 1 ? { [parts[i]]: true } : { [parts[i]]: { select: out } };
  }
  return out;
}

function walkPath(row, path) {
  let cur = row;
  for (const part of String(path).split('.')) {
    if (cur == null) return null;
    cur = cur[part];
  }
  return cur;
}

function plainValue(value, type) {
  if (value == null) return null;
  if (type === 'date') return value instanceof Date ? value.toISOString() : String(value);
  if (type === 'money' || type === 'number') {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  if (type === 'boolean') return !!value;
  return String(value);
}

export function resolveRangePreset(range, tz, now = new Date()) {
  const preset = String(range?.preset || 'THIS_MONTH').toUpperCase();
  if (!['CUSTOM', 'TODAY', 'THIS_WEEK', 'THIS_MONTH', 'LAST_MONTH'].includes(preset)) {
    throw new CustomReportError(`Unknown range preset "${preset}"`);
  }
  const today = startOfDayInTz(now, tz);
  if (preset === 'CUSTOM') {
    const fromRaw = range?.from ? new Date(range.from) : null;
    const toRaw = range?.to ? new Date(range.to) : null;
    if (!fromRaw || !toRaw || Number.isNaN(fromRaw.getTime()) || Number.isNaN(toRaw.getTime())) {
      throw new CustomReportError('Custom range needs valid from/to dates');
    }
    // Tenant-TZ day boundaries, `to` day INCLUDED (QA: raw UTC parsing shifted
    // both edges ~4h for AST and the exclusive `lt` dropped the last selected
    // day entirely).
    const from = startOfDayInTz(fromRaw, tz);
    const to = addDaysInTz(startOfDayInTz(toRaw, tz), 1);
    if (from.getTime() >= to.getTime()) throw new CustomReportError('Range start must be before its end');
    return { from, to };
  }
  if (preset === 'TODAY') return { from: today, to: addDaysInTz(today, 1) };
  if (preset === 'THIS_WEEK') return { from: addDaysInTz(today, -6), to: addDaysInTz(today, 1) };
  if (preset === 'LAST_MONTH') {
    const startThis = startOfMonthInTz(now, tz);
    return { from: addMonthsInTz(startThis, -1, tz), to: startThis };
  }
  // THIS_MONTH default
  return { from: startOfMonthInTz(now, tz), to: addDaysInTz(today, 1) };
}

function bucketLabel(dateValue, bucket, tz) {
  if (dateValue == null) return '(no date)';
  const d = dateValue instanceof Date ? dateValue : new Date(dateValue);
  const iso = isoDayInTz(d, tz); // YYYY-MM-DD in tenant tz
  if (bucket === 'day') return iso;
  if (bucket === 'month') return iso.slice(0, 7);
  if (bucket === 'week') {
    // Week = the Monday of the toll's tenant-tz day. Pure date math on the
    // ISO string keeps it TZ-safe.
    const [y, m, dd] = iso.split('-').map(Number);
    const utcNoon = new Date(Date.UTC(y, m - 1, dd, 12));
    const dow = (utcNoon.getUTCDay() + 6) % 7; // Mon=0
    const monday = new Date(utcNoon.getTime() - dow * DAY_MS);
    return `Week of ${monday.toISOString().slice(0, 10)}`;
  }
  return iso;
}

/** Validate + resolve a definition against the registry and the runner's role. */
export function resolveDefinition(datasetKey, definition = {}, role) {
  const ds = CUSTOM_REPORT_DATASETS[datasetKey];
  if (!ds) throw new CustomReportError(`Unknown dataset "${datasetKey}"`);
  const dsRoles = ds.rolesDataset || STAFF_ROLES;
  if (!dsRoles.includes(role)) throw new CustomReportError('This dataset is not available for your role', 403);

  const byKey = new Map(ds.fields.map((field) => [field.key, field]));
  const visible = (field) => (field.roles || MONEY_ROLES).includes(role);

  const requested = Array.isArray(definition.columns) ? definition.columns.map(String) : [];
  if (!requested.length) throw new CustomReportError('Pick at least one column');
  const columns = [];
  const hiddenColumns = [];
  const unavailableColumns = [];
  for (const key of requested) {
    const field = byKey.get(key);
    if (!field) { unavailableColumns.push(key); continue; }
    if (!visible(field)) { hiddenColumns.push(key); continue; }
    columns.push(field);
  }
  if (!columns.length) throw new CustomReportError('No columns are available for your role in this report', 403);

  const filters = [];
  for (const raw of Array.isArray(definition.filters) ? definition.filters : []) {
    const field = byKey.get(String(raw?.field || ''));
    if (!field || !visible(field) || !ds.filterableKeys.includes(field.key)) {
      throw new CustomReportError(`Filter on "${raw?.field}" is not allowed`);
    }
    const op = String(raw.op || 'in');
    if (!['in', 'equals'].includes(op)) throw new CustomReportError(`Unsupported filter op "${op}"`);
    filters.push({ field, op, value: raw.value });
  }

  let groupBy = null;
  if (definition.groupBy && definition.groupBy.field) {
    const gField = String(definition.groupBy.field);
    const bucket = definition.groupBy.bucket ? String(definition.groupBy.bucket) : null;
    if (bucket) {
      if (!['day', 'week', 'month'].includes(bucket)) throw new CustomReportError(`Unsupported bucket "${bucket}"`);
      const field = byKey.get(gField);
      if (!field || field.type !== 'date' || !visible(field)) throw new CustomReportError('Date grouping needs a visible date column');
      groupBy = { field, bucket };
    } else {
      const field = byKey.get(gField);
      if (!field || !visible(field) || !ds.groupByKeys.includes(field.key)) {
        throw new CustomReportError(`Grouping by "${gField}" is not allowed`);
      }
      groupBy = { field, bucket: null };
    }
  }

  const aggregates = [];
  for (const raw of Array.isArray(definition.aggregates) ? definition.aggregates : []) {
    const fn = String(raw?.fn || '').toLowerCase();
    if (!['count', 'sum', 'avg'].includes(fn)) throw new CustomReportError(`Unsupported aggregate "${raw?.fn}"`);
    if (fn === 'count') { aggregates.push({ fn, field: null }); continue; }
    const field = byKey.get(String(raw.field || ''));
    if (!field || !visible(field) || !['money', 'number'].includes(field.type)) {
      throw new CustomReportError(`${fn} needs a visible number column`);
    }
    aggregates.push({ fn, field });
  }
  if (groupBy && !aggregates.length) aggregates.push({ fn: 'count', field: null });

  let dateField = null;
  const dateKeys = Object.keys(ds.dateFields || {});
  if (dateKeys.length) {
    const requestedDate = definition.dateField ? String(definition.dateField) : dateKeys[0];
    if (!dateKeys.includes(requestedDate)) throw new CustomReportError(`Unknown date field "${requestedDate}"`);
    dateField = requestedDate;
  }

  return { ds, columns, hiddenColumns, unavailableColumns, filters, groupBy, aggregates, dateField };
}

export async function runCustomReport(datasetKey, definition = {}, scope = {}, opts = {}) {
  const { tenantId, role } = scope;
  const allowedLocationIds = Array.isArray(scope.allowedLocationIds) && scope.allowedLocationIds.length
    ? scope.allowedLocationIds.map(String) : null;
  if (!tenantId) throw new CustomReportError('tenantId is required', 401);
  if (!role) throw new CustomReportError('role is required', 401);

  const resolved = resolveDefinition(datasetKey, definition, role);
  const { ds, columns, filters, groupBy, aggregates, dateField } = resolved;

  if (allowedLocationIds && (ds.scopedUsersBlocked || !ds.locationPaths.length)) {
    throw new CustomReportError('This dataset is not available for location-scoped accounts', 403);
  }

  const tz = await resolveTenantTimeZone(tenantId);
  const where = { AND: [] };
  where.AND.push(ds.tenantPath ? nestedWhere(ds.tenantPath, tenantId) : { tenantId });
  if (Object.keys(ds.baseWhere || {}).length) where.AND.push(ds.baseWhere);
  if (allowedLocationIds) {
    where.AND.push({ OR: ds.locationPaths.map((p) => nestedWhere(p, { in: allowedLocationIds })) });
  }

  let range = null;
  if (dateField && (ds.requiredDateFilter || definition.range)) {
    range = resolveRangePreset(definition.range, tz);
    if ((range.to.getTime() - range.from.getTime()) / DAY_MS > MAX_RANGE_DAYS) {
      throw new CustomReportError(`Date range is limited to ${MAX_RANGE_DAYS} days — narrow your filters`);
    }
    where.AND.push({ [dateField]: { gte: range.from, lt: range.to } });
  } else if (ds.requiredDateFilter) {
    throw new CustomReportError('A date range is required for this dataset');
  }

  for (const { field, op, value } of filters) {
    const path = field.filterPath || field.key;
    const values = Array.isArray(value) ? value : [value];
    if (!values.length) continue;
    // Booleans PARSE, not truthiness (QA: Boolean('false') === true).
    const castValue = (v) => (field.type === 'boolean'
      ? !['false', '0', ''].includes(String(v).toLowerCase())
      : String(v));
    const cond = op === 'equals' ? castValue(values[0]) : { in: values.map(castValue) };
    where.AND.push(nestedWhere(path, cond));
  }

  // Select tree: scalars for path-less/top-level fields + each field's tree.
  const select = { id: true };
  const neededFields = [...columns];
  if (groupBy) neededFields.push(groupBy.field);
  for (const agg of aggregates) if (agg.field) neededFields.push(agg.field);
  for (const field of neededFields) {
    if (field.select) deepMergeSelect(select, field.select);
    if (field.path) deepMergeSelect(select, pathToSelect(field.path));
    if (!field.select && !field.path && !field.resolve) select[field.key] = true;
  }

  const cap = opts.forExport ? EXPORT_ROW_CAP : (groupBy ? EXPORT_ROW_CAP : PREVIEW_ROW_CAP);
  const sortField = definition.sort?.field ? columns.find((c) => c.key === String(definition.sort.field)) : null;
  const orderBy = sortField && !sortField.resolve && !sortField.path
    ? [{ [sortField.key]: definition.sort?.dir === 'asc' ? 'asc' : 'desc' }]
    : (dateField ? [{ [dateField]: 'desc' }] : [{ id: 'asc' }]);

  const rows = await prisma[ds.model].findMany({ where, select, orderBy, take: cap + 1 });
  const truncated = rows.length > cap;
  const page = rows.slice(0, cap);
  if (opts.forExport && truncated) {
    throw new CustomReportError(`Export is limited to ${EXPORT_ROW_CAP} rows — narrow your filters`);
  }

  const valueOf = (row, field) => {
    if (field.resolve) return field.resolve(row);
    return plainValue(walkPath(row, field.path || field.key), field.type);
  };

  if (!groupBy) {
    return {
      mode: 'flat',
      tz,
      range,
      columns: columns.map(({ key, label, type }) => ({ key, label, type })),
      hiddenColumns: resolved.hiddenColumns,
      unavailableColumns: resolved.unavailableColumns,
      rows: page.map((row) => columns.map((field) => valueOf(row, field))),
      // LAX #14 (JOINED mode): the caller needs each row's primary key to
      // merge per-reservation aggregates. Internal — never serialized to the
      // client (the routes pass opts without captureIds).
      ...(opts.captureIds ? { ids: page.map((row) => String(row.id)) } : {}),
      rowCount: page.length,
      truncated
    };
  }

  const buckets = new Map();
  for (const row of page) {
    const raw = groupBy.bucket
      ? bucketLabel(walkPath(row, groupBy.field.path || groupBy.field.key), groupBy.bucket, tz)
      : String(valueOf(row, groupBy.field) ?? '(none)');
    let bucketRow = buckets.get(raw);
    if (!bucketRow) { bucketRow = { key: raw, count: 0, sums: {}, ns: {} }; buckets.set(raw, bucketRow); }
    bucketRow.count += 1;
    for (const agg of aggregates) {
      if (!agg.field) continue;
      const n = Number(valueOf(row, agg.field));
      if (Number.isFinite(n)) {
        bucketRow.sums[agg.field.key] = (bucketRow.sums[agg.field.key] || 0) + n;
        bucketRow.ns[agg.field.key] = (bucketRow.ns[agg.field.key] || 0) + 1;
      }
    }
  }

  const aggCols = aggregates.map((agg) => ({
    key: agg.field ? `${agg.fn}_${agg.field.key}` : 'count',
    label: agg.field ? `${agg.fn === 'sum' ? 'Sum of' : 'Average of'} ${agg.field.label}` : 'Count',
    type: agg.field ? agg.field.type : 'number'
  }));
  const groupedRows = [...buckets.values()]
    .sort((a, b) => (a.key < b.key ? 1 : -1))
    .map((bucketRow) => [
      bucketRow.key,
      ...aggregates.map((agg) => {
        if (!agg.field) return bucketRow.count;
        const sum = bucketRow.sums[agg.field.key] || 0;
        return agg.fn === 'sum' ? Number(sum.toFixed(2)) : Number((sum / Math.max(1, bucketRow.ns[agg.field.key] || 0)).toFixed(2));
      })
    ]);
  const totals = ['Total', ...aggregates.map((agg) => {
    if (!agg.field) return page.length;
    let sum = 0; let n = 0;
    for (const b of buckets.values()) { sum += b.sums[agg.field.key] || 0; n += b.ns[agg.field.key] || 0; }
    return agg.fn === 'sum' ? Number(sum.toFixed(2)) : Number((sum / Math.max(1, n)).toFixed(2));
  })];

  return {
    mode: 'grouped',
    tz,
    range,
    columns: [
      { key: 'bucket', label: groupBy.bucket ? `${groupBy.field.label} (${groupBy.bucket})` : groupBy.field.label, type: 'string' },
      ...aggCols
    ],
    hiddenColumns: resolved.hiddenColumns,
    unavailableColumns: resolved.unavailableColumns,
    rows: groupedRows,
    totals,
    rowCount: groupedRows.length,
    scannedRows: page.length,
    truncated
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Multi-dataset reports (2026-07-28, LAX #14). Two tenant-selectable modes:
//
//   SECTIONS — N independent sections (each its own dataset/columns/grouping)
//              sharing ONE date range. Output = one result per section;
//              Excel = one sheet per section. Zero new query semantics: each
//              section runs through runCustomReport unchanged, so every
//              fail-closed property (tenant/location injection, role gates,
//              caps) holds per section by construction.
//
//   JOINED   — ONE table anchored on the `reservations` dataset, with
//              per-reservation AGGREGATES (count / sums) appended from
//              datasets that declare `reservationJoin` in the registry
//              (tolls, citations, incidents). Aggregating to the anchor grain
//              avoids row multiplication; a reservation with no rows in a
//              joined dataset shows 0.
//
// Single-dataset (schemaVersion 1) definitions are untouched — the routes
// branch on definition.mode.
// ═══════════════════════════════════════════════════════════════════════════

export const MAX_SECTIONS = 5;
export const JOINED_ANCHOR_DATASET = 'reservations';

export const MULTI_MODES = Object.freeze(['SECTIONS', 'JOINED']);

export function isMultiDefinition(definition) {
  return MULTI_MODES.includes(String(definition?.mode || '').toUpperCase());
}

/** Validate the joins array against the registry + runner role. Pure. */
function resolveJoins(definition, role) {
  const rawJoins = Array.isArray(definition.joins) ? definition.joins : [];
  if (!rawJoins.length) throw new CustomReportError('Pick at least one dataset to join');
  const joins = [];
  for (const raw of rawJoins) {
    const key = String(raw?.dataset || '');
    const ds = CUSTOM_REPORT_DATASETS[key];
    if (!ds || !ds.reservationJoin) throw new CustomReportError(`Dataset "${key}" cannot be joined by reservation`);
    const dsRoles = ds.rolesDataset || STAFF_ROLES;
    if (!dsRoles.includes(role)) throw new CustomReportError(`Dataset "${ds.label}" is not available for your role`, 403);
    const requested = Array.isArray(raw.metrics) && raw.metrics.length ? raw.metrics.map(String) : ['count'];
    const metrics = [];
    for (const metricKey of requested) {
      const metric = ds.reservationJoin.metrics.find((m) => m.key === metricKey);
      if (!metric) throw new CustomReportError(`Unknown metric "${metricKey}" for "${key}"`);
      if ((metric.roles || MONEY_ROLES).includes(role)) metrics.push(metric);
      // Role-hidden metrics are silently dropped (mirrors hiddenColumns).
    }
    if (!metrics.length) throw new CustomReportError(`No metrics from "${ds.label}" are available for your role`, 403);
    joins.push({ key, ds, metrics });
  }
  return joins;
}

/**
 * Validation-only pass for create/update routes (no queries). Throws
 * CustomReportError on a bad multi definition; returns the normalized mode.
 */
export function validateMultiDefinition(definition = {}, role) {
  const mode = String(definition?.mode || '').toUpperCase();
  if (mode === 'SECTIONS') {
    const sections = Array.isArray(definition.sections) ? definition.sections : [];
    if (!sections.length) throw new CustomReportError('Add at least one section');
    if (sections.length > MAX_SECTIONS) throw new CustomReportError(`Reports are limited to ${MAX_SECTIONS} sections`);
    for (const section of sections) {
      resolveDefinition(String(section?.dataset || ''), { ...section, range: definition.range }, role);
    }
    return mode;
  }
  if (mode === 'JOINED') {
    if (definition.groupBy?.field) throw new CustomReportError('Joined reports are flat — remove the grouping');
    resolveDefinition(JOINED_ANCHOR_DATASET, { ...definition.anchor, range: definition.range }, role);
    resolveJoins(definition, role);
    return mode;
  }
  throw new CustomReportError(`Unknown report mode "${definition?.mode}"`);
}

export async function runCustomReportMulti(definition = {}, scope = {}, opts = {}) {
  const mode = String(definition?.mode || '').toUpperCase();
  const role = scope.role;

  if (mode === 'SECTIONS') {
    const sections = Array.isArray(definition.sections) ? definition.sections : [];
    if (!sections.length) throw new CustomReportError('Add at least one section');
    if (sections.length > MAX_SECTIONS) throw new CustomReportError(`Reports are limited to ${MAX_SECTIONS} sections`);
    const results = [];
    for (const section of sections) {
      const datasetKey = String(section?.dataset || '');
      const ds = CUSTOM_REPORT_DATASETS[datasetKey];
      const result = await runCustomReport(datasetKey, { ...section, range: definition.range }, scope, opts);
      results.push({ dataset: datasetKey, label: ds?.label || datasetKey, ...result });
    }
    return { mode: 'sections', tz: results[0]?.tz || null, range: results[0]?.range || null, sections: results };
  }

  if (mode === 'JOINED') {
    if (definition.groupBy?.field) throw new CustomReportError('Joined reports are flat — remove the grouping');
    const joins = resolveJoins(definition, role);

    const anchor = await runCustomReport(
      JOINED_ANCHOR_DATASET,
      { ...definition.anchor, range: definition.range },
      scope,
      { ...opts, captureIds: true }
    );
    const ids = anchor.ids || [];

    const joinColumns = [];
    const perJoinValues = []; // aligned with joinColumns: Map<reservationId, number>
    for (const { key, ds, metrics } of joins) {
      const sumColumns = metrics.filter((m) => m.fn === 'sum').map((m) => m.column);
      const grouped = ids.length
        ? await prisma[ds.model].groupBy({
            by: [ds.reservationJoin.field],
            where: {
              AND: [
                ds.tenantPath ? nestedWhere(ds.tenantPath, scope.tenantId) : { tenantId: scope.tenantId },
                ...(Object.keys(ds.baseWhere || {}).length ? [ds.baseWhere] : []),
                ...(ds.reservationJoin.baseWhere ? [ds.reservationJoin.baseWhere] : []),
                { [ds.reservationJoin.field]: { in: ids } },
              ],
            },
            _count: { _all: true },
            ...(sumColumns.length ? { _sum: Object.fromEntries(sumColumns.map((c) => [c, true])) } : {}),
          })
        : [];
      const byReservation = new Map(grouped.map((g) => [String(g[ds.reservationJoin.field]), g]));
      for (const metric of metrics) {
        joinColumns.push({
          key: `${key}_${metric.key}`,
          label: metric.label,
          type: metric.fn === 'count' ? 'number' : (metric.type || 'money'),
        });
        perJoinValues.push({
          valueFor: (reservationId) => {
            const g = byReservation.get(String(reservationId));
            if (!g) return 0;
            if (metric.fn === 'count') return g._count?._all || 0;
            const n = Number(g._sum?.[metric.column] ?? 0);
            return Number.isFinite(n) ? Number(n.toFixed(2)) : 0;
          },
        });
      }
    }

    const { ids: _ids, ...anchorPublic } = anchor;
    return {
      ...anchorPublic,
      mode: 'flat',
      joined: joins.map(({ key, ds }) => ({ dataset: key, label: ds.label })),
      columns: [...anchor.columns, ...joinColumns],
      rows: anchor.rows.map((row, i) => [...row, ...perJoinValues.map((j) => j.valueFor(ids[i]))]),
    };
  }

  throw new CustomReportError(`Unknown report mode "${definition?.mode}"`);
}
