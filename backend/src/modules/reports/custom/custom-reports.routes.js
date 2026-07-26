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
import { userAllowedLocationIds } from '../../../lib/tenant-scope.js';
import { datasetsForRole } from './custom-report-datasets.js';
import { runCustomReport, resolveDefinition, CustomReportError } from './custom-report.engine.js';
import { renderReportExcel } from '../reports-export.js';

export const customReportsRouter = Router();

function scopeFor(req) {
  return {
    tenantId: req.user?.tenantId || null,
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
    res.json(await runCustomReport(String(dataset || ''), definition || {}, scopeFor(req)));
  } catch (error) {
    try { sendError(res, error); } catch (e) { next(e); }
  }
});

customReportsRouter.get('/', async (req, res, next) => {
  try {
    const scope = scopeFor(req);
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
    const { name, description, dataset, definition, visibility } = req.body || {};
    const cleanName = String(name || '').trim();
    if (!cleanName) throw new CustomReportError('Report name is required');
    // Validate against the registry + role BEFORE saving — never store junk.
    resolveDefinition(String(dataset || ''), definition || {}, scope.role);
    const row = await prisma.customReport.create({
      data: {
        tenantId: scope.tenantId,
        ownerUserId: req.user?.id || req.user?.sub || null,
        name: cleanName,
        description: String(description || '').trim() || null,
        dataset: String(dataset),
        definition: definition || {},
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
    const out = await runCustomReport(row.dataset, definition, scope);
    prisma.customReport.update({ where: { id: row.id }, data: { lastRunAt: new Date() } }).catch(() => {});
    res.json(out);
  } catch (error) { try { sendError(res, error); } catch (e) { next(e); } }
});

customReportsRouter.get('/:id/excel', async (req, res, next) => {
  try {
    const { row, scope } = await getReportOrThrow(req);
    const definition = { ...row.definition, ...(req.query?.preset ? { range: { preset: String(req.query.preset) } } : {}) };
    const out = await runCustomReport(row.dataset, definition, scope, { forExport: true });
    // renderReportExcel returns { buffer, filename } (QA blocker: res.send on
    // the raw object JSON-serialized it into a corrupt .xlsx).
    const { buffer } = await renderReportExcel({
      title: row.name,
      sheets: [{
        name: 'Report',
        columns: out.columns.map((c) => ({ header: c.label, key: c.key })),
        rows: out.rows.map((r) => Object.fromEntries(out.columns.map((c, i) => [c.key, r[i]])))
      }]
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
    const nextDataset = dataset ? String(dataset) : row.dataset;
    if (definition || dataset) resolveDefinition(nextDataset, definition || row.definition, scope.role);
    const updated = await prisma.customReport.update({
      where: { id: row.id },
      data: {
        ...(name !== undefined ? { name: String(name).trim() } : {}),
        ...(description !== undefined ? { description: String(description).trim() || null } : {}),
        ...(definition !== undefined ? { definition } : {}),
        ...(dataset !== undefined ? { dataset: nextDataset } : {}),
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
