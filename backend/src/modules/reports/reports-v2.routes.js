/**
 * Reports v2 routes — Round 24 (2026-05-22).
 *
 * Mounted in main.js as:
 *   app.use('/api/reports', requireAuth, tenantRateLimit, reportsV2Router);
 *
 * Routes:
 *   GET  /api/reports/list      — directory of available reports
 *   GET  /api/reports/snapshot  — landing page headline metrics
 *
 * Individual report endpoints are registered separately under
 * `/api/reports/{slug}` (data), `/api/reports/{slug}/pdf` (PDF),
 * `/api/reports/{slug}/excel` (Excel). Each individual report file
 * (commission-sales-performance.report.js, etc.) wires its own three sub-
 * routes into this router via the registerReport() helper.
 */

import { Router } from 'express';
import { requireRole } from '../../middleware/auth.js';
import {
  listReports,
  getSnapshot,
  ReportsServiceError,
} from './reports-v2.service.js';
import { renderReportPdf, renderReportExcel, wrapReportHtml } from './reports-export.js';

// Round 25: removed local requireRole — replaced with canonical import from
// middleware/auth.js which adds the SUPER_ADMIN bypass. Without the bypass,
// SUPER_ADMIN users got 403s on per-report endpoints that didn't list
// SUPER_ADMIN explicitly in their allowed roles.

function sendError(res, err) {
  if (err instanceof ReportsServiceError) {
    return res.status(err.status).json({ error: err.message, code: err.code || null });
  }
  console.error('[reports-v2] error', err);
  return res.status(500).json({ error: err?.message || 'Internal error' });
}

export const reportsV2Router = Router();

// ---------------------------------------------------------------------------
// GET /api/reports/list
// ---------------------------------------------------------------------------
reportsV2Router.get(
  '/list',
  requireRole('ADMIN', 'OPS', 'SUPER_ADMIN'),
  async (req, res) => {
    try {
      const out = await listReports({ tenantId: req.user.tenantId });
      res.json(out);
    } catch (err) {
      sendError(res, err);
    }
  }
);

// ---------------------------------------------------------------------------
// GET /api/reports/snapshot?from=&to=
// ---------------------------------------------------------------------------
reportsV2Router.get(
  '/snapshot',
  requireRole('ADMIN', 'OPS', 'SUPER_ADMIN'),
  async (req, res) => {
    try {
      const out = await getSnapshot({
        tenantId: req.user.tenantId,
        from: req.query?.from,
        to: req.query?.to,
      });
      res.json(out);
    } catch (err) {
      sendError(res, err);
    }
  }
);

// ---------------------------------------------------------------------------
// registerReport — used by individual report files to wire up the trio of
// data/pdf/excel routes consistently.
// ---------------------------------------------------------------------------

/**
 * @param {object} report
 * @param {string} report.slug
 * @param {function} report.computeData     — (params, deps) → Promise<reportData>
 * @param {function} report.renderHtml      — (reportData)   → string (inner HTML)
 * @param {function} report.buildExcelSpec  — (reportData)   → renderReportExcel spec
 * @param {string} report.title             — used in PDF + Excel headers
 * @param {string[]} [report.roles]         — allowed roles (default ADMIN/OPS/SUPER_ADMIN)
 * @param {Array<{path:string, method?:string, handler:Function}>} [report.subRoutes]
 *   Optional extra sub-routes for the report (drill-downs, slices, etc.). Each
 *   sub-route is mounted at /api/reports/{slug}{path}. Handler receives
 *   (req, res, ctx) where ctx = { tenantId }. Errors bubble through sendError
 *   for consistent JSON shape.
 */
export function registerReport(report) {
  const slug = report.slug;
  const roles = report.roles || ['ADMIN', 'OPS', 'SUPER_ADMIN'];

  reportsV2Router.get(`/${slug}`, requireRole(...roles), async (req, res) => {
    try {
      const data = await report.computeData(
        { tenantId: req.user.tenantId, from: req.query?.from, to: req.query?.to, query: req.query || {} },
        {}
      );
      res.json(data);
    } catch (err) {
      sendError(res, err);
    }
  });

  // Inject `_isExport: '1'` into the query on the PDF + Excel paths so each
  // individual report can short-circuit slow optional sections (e.g.
  // availability-forecast's 12-month sold-out scan) that would otherwise
  // push us over nginx's 60s gateway timeout. Reports that don't care about
  // the flag simply ignore it.
  reportsV2Router.get(`/${slug}/pdf`, requireRole(...roles), async (req, res) => {
    try {
      const data = await report.computeData(
        { tenantId: req.user.tenantId, from: req.query?.from, to: req.query?.to, query: { ...(req.query || {}), _isExport: '1' } },
        {}
      );
      const subtitle = formatRangeSubtitle(data?.range || { from: req.query?.from, to: req.query?.to });
      const innerHtml = report.renderHtml(data);
      const html = wrapReportHtml({ title: report.title, subtitle, innerHtml });
      const buffer = await renderReportPdf(html);
      const filename = `${slug}-${new Date().toISOString().slice(0, 10)}.pdf`;
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.setHeader('Content-Length', buffer.byteLength);
      res.end(buffer);
    } catch (err) {
      sendError(res, err);
    }
  });

  reportsV2Router.get(`/${slug}/excel`, requireRole(...roles), async (req, res) => {
    try {
      const data = await report.computeData(
        { tenantId: req.user.tenantId, from: req.query?.from, to: req.query?.to, query: { ...(req.query || {}), _isExport: '1' } },
        {}
      );
      const spec = report.buildExcelSpec(data);
      const { buffer, filename } = await renderReportExcel(spec);
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.setHeader('Content-Length', buffer.byteLength);
      res.end(Buffer.from(buffer));
    } catch (err) {
      sendError(res, err);
    }
  });

  // Optional sub-routes (drill-downs, slices). Each handler is wrapped in the
  // standard sendError path so subRoute authors don't have to re-implement it.
  if (Array.isArray(report.subRoutes)) {
    for (const sub of report.subRoutes) {
      const method = (sub.method || 'get').toLowerCase();
      const subPath = sub.path.startsWith('/') ? sub.path : `/${sub.path}`;
      const fullPath = `/${slug}${subPath}`;
      const wrapped = async (req, res) => {
        try {
          await sub.handler(req, res, { tenantId: req.user.tenantId });
        } catch (err) {
          sendError(res, err);
        }
      };
      const subRoles = Array.isArray(sub.roles) ? sub.roles : roles;
      reportsV2Router[method](fullPath, requireRole(...subRoles), wrapped);
    }
  }
}

function formatRangeSubtitle(range) {
  if (!range?.from && !range?.to) return '';
  const from = range.from ? new Date(range.from) : null;
  const to = range.to ? new Date(range.to) : null;
  const fmt = (d) => d ? d.toISOString().slice(0, 10) : '?';
  return `${fmt(from)} → ${fmt(to)}`;
}
