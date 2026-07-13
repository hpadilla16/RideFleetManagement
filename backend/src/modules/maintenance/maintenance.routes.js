// Maintenance Module — routes. Mounted in main.js (authed, tenant-scoped).
//   /api/repair-orders ...   (RO CRUD + lines + complete/cancel + from-damage + vehicle history)
//   /api/maintenance/summary|board|due
//   /api/maintenance/vehicles/:vehicleId/schedules   (service intervals)
// Money: RO costs are an internal record only — no auto-charge here.

import { Router } from 'express';
import { scopeFor } from '../../lib/tenant-scope.js';
import { repairOrdersService } from './repair-orders.service.js';
import { maintenanceService } from './maintenance.service.js';

export const repairOrdersRouter = Router();
export const maintenanceRouter = Router();

function handle(err, res) {
  const status = err?.status || (/required|invalid|must|not found/i.test(String(err?.message || '')) ? 400 : 500);
  if (status >= 500) return res.status(500).json({ error: 'Internal error' });
  return res.status(status).json({ error: err.message });
}
const ok = (fn) => async (req, res) => { try { res.json(await fn(req)); } catch (e) { handle(e, res); } };

// ── Repair Orders ──
repairOrdersRouter.get('/', ok((req) => repairOrdersService.list(req.query || {}, scopeFor(req))));
repairOrdersRouter.post('/', ok((req) => repairOrdersService.create(req.body || {}, scopeFor(req))));
repairOrdersRouter.post('/from-damage', ok((req) => repairOrdersService.fromDamage(req.body || {}, scopeFor(req))));
repairOrdersRouter.get('/vehicle/:vehicleId', ok((req) => repairOrdersService.vehicleHistory(req.params.vehicleId, scopeFor(req))));
repairOrdersRouter.get('/:id', ok((req) => repairOrdersService.get(req.params.id, scopeFor(req))));
repairOrdersRouter.patch('/:id', ok((req) => repairOrdersService.update(req.params.id, req.body || {}, scopeFor(req))));
repairOrdersRouter.post('/:id/lines', ok((req) => repairOrdersService.addLine(req.params.id, req.body || {}, scopeFor(req))));
repairOrdersRouter.delete('/:id/lines/:lineId', ok((req) => repairOrdersService.deleteLine(req.params.id, req.params.lineId, scopeFor(req))));
repairOrdersRouter.post('/:id/complete', ok((req) => repairOrdersService.complete(req.params.id, scopeFor(req))));
repairOrdersRouter.post('/:id/cancel', ok((req) => repairOrdersService.cancel(req.params.id, scopeFor(req))));

// ── Maintenance hub ──
maintenanceRouter.get('/summary', ok((req) => maintenanceService.summary(req.query || {}, scopeFor(req))));
maintenanceRouter.get('/board', ok((req) => maintenanceService.board(req.query || {}, scopeFor(req))));
maintenanceRouter.get('/due', ok((req) => maintenanceService.due(req.query || {}, scopeFor(req))));
maintenanceRouter.get('/vehicles/:vehicleId/schedules', ok((req) => maintenanceService.listSchedules(req.params.vehicleId, scopeFor(req))));
maintenanceRouter.put('/vehicles/:vehicleId/schedules', ok((req) => maintenanceService.upsertSchedule(req.params.vehicleId, req.body || {}, scopeFor(req))));
// "Log service": rolls the baseline to the vehicle's current odometer + now (server-side read).
maintenanceRouter.post('/vehicles/:vehicleId/schedules/:serviceType/log-service', ok((req) => maintenanceService.logService(req.params.vehicleId, req.params.serviceType, scopeFor(req), { actorUserId: req.user?.id || null })));
maintenanceRouter.delete('/vehicles/:vehicleId/schedules/:serviceType', ok((req) => maintenanceService.deleteSchedule(req.params.vehicleId, req.params.serviceType, scopeFor(req))));
