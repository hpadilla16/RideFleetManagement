/**
 * Inventory Helper — routes (2026-06-09). Phase A.
 * Mounted at /api/inventory with requireAuth + requireModuleAccess('vehicles').
 */
import { Router } from 'express';
import { inventoryService } from './inventory.service.js';
import { scopeFor } from '../../lib/tenant-scope.js';

export const inventoryRouter = Router();

const actor = (req) => req.user?.sub || null;

// Map service errors (which carry a `.status`) to HTTP responses.
function handle(res, next, e) {
  if (e && typeof e.status === 'number') {
    return res.status(e.status).json({ error: e.message, code: e.code });
  }
  return next(e);
}

inventoryRouter.get('/session/active', async (req, res, next) => {
  try {
    res.json(await inventoryService.getActiveSession(scopeFor(req)));
  } catch (e) { handle(res, next, e); }
});

inventoryRouter.post('/session', async (req, res, next) => {
  try {
    const wipeExisting = !!(req.body && req.body.wipeExisting);
    const out = await inventoryService.startSession(scopeFor(req), actor(req), { wipeExisting });
    res.status(out.resumed ? 200 : 201).json(out);
  } catch (e) { handle(res, next, e); }
});

inventoryRouter.get('/session/:id', async (req, res, next) => {
  try {
    res.json(await inventoryService.getSession(req.params.id, scopeFor(req)));
  } catch (e) { handle(res, next, e); }
});

inventoryRouter.post('/session/:id/items/:itemId/confirm', async (req, res, next) => {
  try {
    res.json(await inventoryService.confirmItem(req.params.id, req.params.itemId, req.body || {}, actor(req), scopeFor(req)));
  } catch (e) { handle(res, next, e); }
});

inventoryRouter.post('/session/:id/items/:itemId/maintenance-note', async (req, res, next) => {
  try {
    res.json(await inventoryService.addMaintenanceNote(req.params.id, req.params.itemId, req.body || {}, actor(req), scopeFor(req)));
  } catch (e) { handle(res, next, e); }
});

inventoryRouter.post('/session/:id/items/:itemId/exception', async (req, res, next) => {
  try {
    res.json(await inventoryService.markException(req.params.id, req.params.itemId, req.body || {}, actor(req), scopeFor(req)));
  } catch (e) { handle(res, next, e); }
});

inventoryRouter.post('/session/:id/items/:itemId/resolve-mismatch', async (req, res, next) => {
  try {
    res.json(await inventoryService.resolveMismatch(req.params.id, req.params.itemId, req.body || {}, actor(req), scopeFor(req)));
  } catch (e) { handle(res, next, e); }
});

inventoryRouter.post('/session/:id/complete', async (req, res, next) => {
  try {
    res.json(await inventoryService.completeSession(req.params.id, actor(req), scopeFor(req)));
  } catch (e) { handle(res, next, e); }
});

inventoryRouter.get('/reports', async (req, res, next) => {
  try {
    res.json(await inventoryService.listReports(scopeFor(req)));
  } catch (e) { handle(res, next, e); }
});

inventoryRouter.get('/reports/:id/download', async (req, res, next) => {
  try {
    const { buffer, filename } = await inventoryService.getReportPdf(req.params.id, scopeFor(req));
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(buffer);
  } catch (e) { handle(res, next, e); }
});

inventoryRouter.get('/reconciliation/open', async (req, res, next) => {
  try {
    res.json(await inventoryService.listOpenReconciliation(scopeFor(req)));
  } catch (e) { handle(res, next, e); }
});

inventoryRouter.post('/reconciliation/:flagId/resolve', async (req, res, next) => {
  try {
    res.json(await inventoryService.resolveReconciliationFlag(req.params.flagId, req.body || {}, actor(req), scopeFor(req)));
  } catch (e) { handle(res, next, e); }
});
