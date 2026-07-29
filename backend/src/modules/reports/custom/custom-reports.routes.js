/**
 * Report Builder routes (2026-07-26). Mounted in main.js at
 * /api/reports/custom BEFORE reportsV2Router (same requireAuth +
 * tenantRateLimit + requireModuleAccess('reports') stack).
 *
 * Scope posture: unlike the fixed reports' blanket rejectScopedUsers, the
 * engine is scope-threaded by construction — location-scoped users CAN run
 * datasets that declare a location path (scoped to their sedes), and are
 * fail-closed 403'd on datasets that can't scope (engine decides).
 */
import { Router } from 'express';
import { prisma } from '../../../lib/prisma.js';
import { userAllowedLocationIds, scopeFor as tenantScopeFor } from '../../../lib/tenant-scope.js';
import { datasetsForRole } from './custom-report-datasets.js';
import {
  runCustomReport, resolveDefinition, CustomReportError,
  runCustomReportMulti, validateMultiDefinition, isMultiDefinition, JOINED_ANCHOR_DATASET
} from './custom-report.engine.js';
import { renderReportExcel } from '../reports-export.js';

// LAX #14: a multi-mode definition carries its own datasets — run it through
// the multi engine; classic single-dataset definitions are untouched.
async function runAny(datasetKey, definition, scope, opts = {}) {
  return isMultiDefinition(definition)
    ? runCustomReportMulti(definition, scope, opts)
    : runCustomReport(String(datasetKey || ''), definition || {}, scope, opts);
}

function validateAny(datasetKey, definition, role) {
  if (isMultiDefinition(definition)) return validateMultiDefinition(definition, role);
  return resolveDefinition(String(datasetKey || ''), definition || {}, role);
}

/** The `dataset` column value for a multi definition (NOT NULL in the model):
 * the anchor for JOINED, the first section's dataset for SECTIONS. */
function datasetColumnFor(definition, fallback) {
  if (!isMultiDefinition(definition)) return fallback;
  const mode = String(definition.mode).toUpperCase();
  if (mode === 'JOINED') return JOINED_ANCHOR_DATASET;
  return String(definition.sections?.[0]?.dataset || fallback || JOINED_ANCHOR_DATASET);
}

export const customReportsRouter = Router();

function scopeFor(req) {
  // Canonical tenant resolution (Sentry 54aacfd1, 2026-07-26): a SUPER_ADMIN
  // has no tenantId of their own — req.user.tenantId is null and Prisma
  // rejects a null filter with a 500 on every reports-v2 landing view. The
  // lib helper resolves ?tenantId= for supers and the JWT tenant otherwise;
  // callers below treat a still-missing tenant as empty/400, never a query.
  const base = tenantScopeFor(req);
  return {
    tenantId: base?.tenantId || null,
    role: String(req.user?.role || ''),
    allowedLocationIds: userAllowedLocationIds(req.user) || null
  };
}

function sendError(res, error) {
  if (error instanceof CustomReportError) {
    return res.status(error.status || 400).json({ error: error.message });
  }
  throw error;
}

async function getReportOrThrow(req) {
  const scope = scopeFor(req);
  if (!scope.tenantId) throw new CustomReportError('Select a tenant first', 400);
  const row = await prisma.customReport.findFirst({
    where: { id: String(req.params.id), tenantId: scope.tenantId }
  });
  if (!row) throw new CustomReportError('Report not found', 404);
  const userId = req.user?.id || req.user?.sub || null;
  const isOwner = row.ownerUserId === userId;
  const isAdmin = ['ADMIN', 'SUPER_ADMIN'].includes(scope.role);
  if (!isOwner && row.visibility !== 'TENANT' && !isAdmin) {
    throw new CustomReportError('Report not found', 404);
  }
  return { row, isOwner, isAdmin, scope, userId };
}

customReportsRouter.get('/datasets', (req, res) => {
  res.json({ datasets: datasetsForRole(String(req.user?.role || '')) });
});

// Ad-hoc preview from the builder (nothing saved).
customReportsRouter.post('/run', async (req, res, next) => {
  try {
    const { dataset, definition } = req.body || {};
    res.json(await runAny(dataset, definition || {}, scopeFor(req)));
  } catch (error) {
    try { sendError(res, error); } catch (e) { next(e); }
  }
});

customReportsRouter.get('/', async (req, res, next) => {
  try {
    const scope = scopeFor(req);
    // Super admin browsing without a tenant selected: nothing to list.
    if (!scope.tenantId) return res.json({ reports: [] });
    const userId = req.user?.id || req.user?.sub || null;
    const rows = await prisma.customReport.findMany({
      where: {
        tenantId: scope.tenantId,
        OR: [{ ownerUserId: userId }, { visibility: 'TENANT' }]
      },
      orderBy: [{ updatedAt: 'desc' }],
      take: 200
    });
    res.json({
      reports: rows.map((row) => ({
        id: row.id,
        name: row.name,
        description: row.description || '',
        dataset: row.dataset,
        visibility: row.visibility,
        mine: row.ownerUserId === userId,
        lastRunAt: row.lastRunAt,
        updatedAt: row.updatedAt
      }))
    });
  } catch (error) { next(error); }
});

customReportsRouter.post('/', async (req, res, next) => {
  try {
    const scope = scopeFor(req);
    if (!scope.tenantId) throw new CustomReportError('Select a tenant first', 400);
    const { name, description, dataset, definition, visibility } = req.body || {};
    const cleanName = String(name || '').trim();
    if (!cleanName) throw new CustomReportError('Report name is required');
    // Validate against the registry + role BEFORE saving — never store junk.
    validateAny(dataset, definition || {}, scope.role);
    const row = await prisma.customReport.create({
      data: {
        tenantId: scope.tenantId,
        ownerUserId: req.user?.id || req.user?.sub || null,
        name: cleanName,
        description: String(description || '').trim() || null,
        dataset: datasetColumnFor(definition, String(dataset || '')),
        definition: definition || {},
        schemaVersion: isMultiDefinition(definition) ? 2 : 1,
        visibility: visibility === 'TENANT' ? 'TENANT' : 'PRIVATE'
      }
    });
    res.status(201).json({ id: row.id });
  } catch (error) {
    if (String(error?.code) === 'P2002') return res.status(400).json({ error: 'You already have a report with that name' });
    try { sendError(res, error); } catch (e) { next(e); }
  }
});

customReportsRouter.get('/:id', async (req, res, next) => {
  try {
    const { row, isOwner, isAdmin } = await getReportOrThrow(req);
    res.json({
      id: row.id, name: row.name, description: row.description || '',
      dataset: row.dataset, definition: row.definition, visibility: row.visibility,
      canEdit: isOwner || isAdmin, lastRunAt: row.lastRunAt
    });
  } catch (error) { try { sendError(res, error); } catch (e) { next(e); } }
});

// Run a saved report; optional one-off range override (does NOT persist).
customReportsRouter.post('/:id/run', async (req, res, next) => {
  try {
    const { row, scope } = await getReportOrThrow(req);
    const definition = { ...row.definition, ...(req.body?.range ? { range: req.body.range } : {}) };
    const out = await runAny(row.dataset, definition, scope);
    prisma.customReport.update({ where: { id: row.id }, data: { lastRunAt: new Date() } }).catch(() => {});
    res.json(out);
  } catch (error) { try { sendError(res, error); } catch (e) { next(e); } }
});

customReportsRouter.get('/:id/excel', async (req, res, next) => {
  try {
    const { row, scope } = await getReportOrThrow(req);
    const definition = { ...row.definition, ...(req.query?.preset ? { range: { preset: String(req.query.preset) } } : {}) };
    const out = await runAny(row.dataset, definition, scope, { forExport: true });
    // renderReportExcel returns { buffer, filename } (QA blocker: res.send on
    // the raw object JSON-serialized it into a corrupt .xlsx).
    const toSheet = (name, result) => ({
      name: String(name).slice(0, 31) || 'Report', // Excel sheet-name cap
      columns: result.columns.map((c) => ({ header: c.label, key: c.key })),
      rows: result.rows.map((r) => Object.fromEntries(result.columns.map((c, i) => [c.key, r[i]])))
    });
    // LAX #14: SECTIONS exports one sheet per section (the renderer already
    // loops spec.sheets); JOINED and classic reports stay single-sheet.
    const sheets = out.mode === 'sections'
      ? out.sections.map((section, i) => toSheet(section.label || `Section ${i + 1}`, section))
      : [toSheet('Report', out)];
    const { buffer } = await renderReportExcel({
      title: row.name,
      sheets
    });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${row.name.replace(/[^a-z0-9-_ ]/gi, '')}.xlsx"`);
    res.send(Buffer.from(buffer));
  } catch (error) { try { sendError(res, error); } catch (e) { next(e); } }
});

customReportsRouter.put('/:id', async (req, res, next) => {
  try {
    const { row, isOwner, isAdmin, scope } = await getReportOrThrow(req);
    if (!isOwner && !isAdmin) throw new CustomReportError('Only the owner or an admin can edit this report', 403);
    const { name, description, definition, visibility, dataset } = req.body || {};
    const effectiveDefinition = definition || row.definition;
    const nextDataset = isMultiDefinition(effectiveDefinition)
      ? datasetColumnFor(effectiveDefinition, row.dataset)
      : (dataset ? String(dataset) : row.dataset);
    if (definition || dataset) validateAny(nextDataset, effectiveDefinition, scope.role);
    const updated = await prisma.customReport.update({
      where: { id: row.id },
      data: {
        ...(name !== undefined ? { name: String(name).trim() } : {}),
        ...(description !== undefined ? { description: String(description).trim() || null } : {}),
        ...(definition !== undefined ? { definition, schemaVersion: isMultiDefinition(definition) ? 2 : 1 } : {}),
        ...(definition !== undefined || dataset !== undefined ? { dataset: nextDataset } : {}),
        ...(visibility !== undefined ? { visibility: visibility === 'TENANT' ? 'TENANT' : 'PRIVATE' } : {})
      }
    });
    res.json({ id: updated.id });
  } catch (error) {
    if (String(error?.code) === 'P2002') return res.status(400).json({ error: 'You already have a report with that name' });
    try { sendError(res, error); } catch (e) { next(e); }
  }
});

customReportsRouter.delete('/:id', async (req, res, next) => {
  try {
    const { row, isOwner, isAdmin } = await getReportOrThrow(req);
    if (!isOwner && !isAdmin) throw new CustomReportError('Only the owner or an admin can delete this report', 403);
    await prisma.customReport.delete({ where: { id: row.id } });
    res.json({ ok: true });
  } catch (error) { try { sendError(res, error); } catch (e) { next(e); } }
});
