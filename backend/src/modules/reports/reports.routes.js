import { Router } from 'express';
import { requireRole } from '../../middleware/auth.js';
import { scopeFor } from '../../lib/tenant-scope.js';
import { reportsService } from './reports.service.js';

export const reportsRouter = Router();

reportsRouter.get('/overview', async (req, res, next) => {
  try {
    const out = await reportsService.overview(req.query || {}, scopeFor(req));
    res.json(out);
  } catch (e) {
    next(e);
  }
});

reportsRouter.get('/overview.csv', async (req, res, next) => {
  try {
    const csv = await reportsService.overviewCsv(req.query || {}, scopeFor(req));
    const start = String(req.query?.start || '').trim() || 'range-start';
    const end = String(req.query?.end || '').trim() || 'range-end';
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="reports-overview-${start}-to-${end}.csv"`);
    res.send(csv);
  } catch (e) {
    next(e);
  }
});

reportsRouter.post('/overview/email', requireRole('ADMIN', 'OPS'), async (req, res, next) => {
  try {
    const out = await reportsService.sendOverviewEmail(req.body || {}, scopeFor(req));
    res.json(out);
  } catch (e) {
    next(e);
  }
});

reportsRouter.get('/services-sold', async (req, res, next) => {
  try {
    const out = await reportsService.servicesSold(req.query || {}, scopeFor(req));
    res.json(out);
  } catch (e) {
    next(e);
  }
});

reportsRouter.get('/contracts.xlsx', async (req, res, next) => {
  try {
    const { buffer, filename } = await reportsService.contractsExcel(req.query || {}, scopeFor(req));
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', buffer.byteLength);
    res.end(Buffer.from(buffer));
  } catch (e) {
    next(e);
  }
});

// Reservations report. Query params: start, end, programCategory (optional),
// workflowMode (STANDARD_RENTAL | DEALERSHIP_LOANER), status (NEW | CONFIRMED |
// CHECKED_OUT | CANCELLED).
reportsRouter.get('/reservations', async (req, res, next) => {
  try {
    const out = await reportsService.reservationsReport(req.query || {}, scopeFor(req));
    res.json(out);
  } catch (e) {
    next(e);
  }
});

reportsRouter.get('/reservations.xlsx', async (req, res, next) => {
  try {
    const { buffer, filename } = await reportsService.reservationsReportExcel(req.query || {}, scopeFor(req));
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', buffer.byteLength);
    res.end(Buffer.from(buffer));
  } catch (e) {
    next(e);
  }
});

// Inventory report. Query params: start, end, programCategory (optional).
// Returns { range, programCategory, vehicles[], totals } with utilization
// percentages over the given window.
reportsRouter.get('/inventory', async (req, res, next) => {
  try {
    const out = await reportsService.inventoryReport(req.query || {}, scopeFor(req));
    res.json(out);
  } catch (e) {
    next(e);
  }
});

reportsRouter.get('/inventory.xlsx', async (req, res, next) => {
  try {
    const { buffer, filename } = await reportsService.inventoryReportExcel(req.query || {}, scopeFor(req));
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', buffer.byteLength);
    res.end(Buffer.from(buffer));
  } catch (e) {
    next(e);
  }
});

// Per-vehicle revenue. Query params: start (ISO date), end (ISO date),
// programCategory (optional: RENTAL_ONLY | LOANER_ONLY | BOTH).
reportsRouter.get('/vehicle-revenue', async (req, res, next) => {
  try {
    const out = await reportsService.vehicleRevenue(req.query || {}, scopeFor(req));
    res.json(out);
  } catch (e) {
    next(e);
  }
});

reportsRouter.get('/vehicle-revenue.xlsx', async (req, res, next) => {
  try {
    const { buffer, filename } = await reportsService.vehicleRevenueExcel(req.query || {}, scopeFor(req));
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', buffer.byteLength);
    res.end(Buffer.from(buffer));
  } catch (e) {
    next(e);
  }
});
