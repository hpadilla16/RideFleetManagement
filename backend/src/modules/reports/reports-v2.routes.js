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
import { userProgramScope, userAllowedLocationIds } from '../../lib/tenant-scope.js';
import { scopeFor as tenantScopeFor } from '../../lib/tenant-scope.js';
import { computeTodayKpis } from './today-kpis.js';
import { computeDashboardV2Kpis } from './dashboard-v2-kpis.js';
import { computeDashboardV2Fleet } from './dashboard-v2-fleet.js';
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

// Scope guard (2026-07-02, extended 2026-07-23) — pragmatic fail-closed guard.
// Every reports-v2 data path (getSnapshot + each report's computeData) receives
// only { tenantId }, so results are tenant-wide: serving them to a restricted
// employee would leak the rest of the tenant. Until the scope is threaded
// through, block those accounts outright with a clear message.
//
// The location axis was added 2026-07-23 along with the ADMIN scoping change:
// an ADMIN with locationIds is now a LOCATION admin, and previously would have
// sailed through this guard straight into whole-tenant reports. Note the
// utilization report also caches per `query.locationId` only, not per caller
// scope, so serving a scoped caller here would poison the shared cache too.
// TODO(2026-07-02, Fase C): thread the full resolved scope (programScope +
// allowedLocationIds) into computeData/getSnapshot and delete this guard.
// Exported for the unit test — this guard is the ONLY thing standing between a
// scoped user and a whole-tenant report set (computeData/getSnapshot take a bare
// tenantId and share a cache), so both branches are pinned in reports-v2-scope-guard.test.mjs.
export function rejectScopedUsers(req, res, next) {
  if (userProgramScope(req.user)) {
    return res.status(403).json({
      error: 'This report set is not yet available for program-restricted accounts',
    });
  }
  if (userAllowedLocationIds(req.user)) {
    return res.status(403).json({
      error: 'This report set is not yet available for location-restricted accounts',
    });
  }
  next();
}

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
  rejectScopedUsers,
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
// GET /api/reports/today-kpis lives in today-kpis.routes.js, mounted BEFORE
// this router's `requireModuleAccess('reports')` gate. An AGENT defaults to
// reports:false, so keeping it here 403'd the very users Hector asked to see
// it (2026-08-06, "que todo usuario lo pueda ver"). Moved, not copied — two
// definitions of one endpoint drift.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// GET /api/reports/dashboard-v2-kpis — the v2 hero row (2026-08-03, phase 4-5
// of design/DASHBOARD-V2.md): fleet-wide Turn-Ready counts + average, 7-day
// utilization with week-over-week delta, tolls reconciled over 30 days. Same
// guard posture as /today-kpis — money display, scoped users fail closed,
// SUPER_ADMIN without a tenant gets nulls.
// ---------------------------------------------------------------------------
reportsV2Router.get(
  '/dashboard-v2-kpis',
  requireRole('ADMIN', 'OPS', 'SUPER_ADMIN'),
  rejectScopedUsers,
  async (req, res) => {
    try {
      const tenantId = tenantScopeFor(req)?.tenantId || null;
      if (!tenantId) return res.json({ turnReady: null, utilization: null, tolls30d: null });
      res.json(await computeDashboardV2Kpis(tenantId));
    } catch (err) {
      sendError(res, err);
    }
  }
);

// ---------------------------------------------------------------------------
// GET /api/reports/dashboard-v2-fleet — the v2 fleet table (2026-08-04,
// phase 6): worst-Turn-Ready-first rows with a derived next action. Same
// guard posture as the KPIs above.
// ---------------------------------------------------------------------------
reportsV2Router.get(
  '/dashboard-v2-fleet',
  requireRole('ADMIN', 'OPS', 'SUPER_ADMIN'),
  rejectScopedUsers,
  async (req, res) => {
    try {
      const tenantId = tenantScopeFor(req)?.tenantId || null;
      if (!tenantId) return res.json({ totalCount: 0, rows: [] });
      res.json(await computeDashboardV2Fleet(tenantId, { limit: req.query?.limit }));
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
/**
 * Location scoping for report routes (2026-08-06, Hector — a location-
 * restricted ADMIN was getting the flat 403 on every report page).
 *
 * Almost every report already filters by `query.locationId` down in its own
 * Prisma where (16 of 19 at the time of writing), so a scoped user does not
 * need to be rejected — they need their location PINNED:
 *   - a requested locationId outside their allowed set → 403;
 *   - no locationId and exactly one allowed location → pinned silently;
 *   - no locationId and several allowed → 400 with allowedLocationIds, so
 *     the UI's own dropdown (already limited to their locations) must choose
 *     — never a silent default to the wrong branch.
 * Reports that have NO location dimension (registered with
 * locationScoped: false) keep the old rejection: without a filter to pin,
 * letting the request through would show other locations' data.
 * Program-restricted accounts stay rejected everywhere — their world is a
 * program, not a set of locations.
 *
 * Returns true to continue; false when it already answered.
 */
export function applyReportLocationScope(req, res, { locationScoped = true } = {}) {
  if (userProgramScope(req.user)) {
    res.status(403).json({
      error: 'This report set is not yet available for program-restricted accounts',
    });
    return false;
  }
  const allowed = userAllowedLocationIds(req.user);
  if (!allowed) return true; // unscoped user — nothing to pin
  if (!locationScoped) {
    res.status(403).json({
      error: 'This report has no per-location view yet, so location-restricted accounts cannot open it',
    });
    return false;
  }
  const requested = req.query?.locationId ? String(req.query.locationId) : null;
  if (requested) {
    if (!allowed.includes(requested)) {
      res.status(403).json({ error: 'That location is outside your allowed locations' });
      return false;
    }
    return true;
  }
  if (allowed.length === 1) {
    req.query = { ...(req.query || {}), locationId: allowed[0] };
    return true;
  }
  res.status(400).json({
    error: 'Choose one of your locations to run this report',
    allowedLocationIds: allowed,
  });
  return false;
}

export function registerReport(report) {
  const slug = report.slug;
  const roles = report.roles || ['ADMIN', 'OPS', 'SUPER_ADMIN'];
  const scopeOpts = { locationScoped: report.locationScoped !== false };
  const scopeGate = (req, res, next) => {
    if (applyReportLocationScope(req, res, scopeOpts)) next();
  };

  reportsV2Router.get(`/${slug}`, requireRole(...roles), scopeGate, async (req, res) => {
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
  reportsV2Router.get(`/${slug}/pdf`, requireRole(...roles), scopeGate, async (req, res) => {
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

  reportsV2Router.get(`/${slug}/excel`, requireRole(...roles), scopeGate, async (req, res) => {
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
      // Sub-routes carry the same location semantics as the parent report
      // (their handlers read query.locationId too), so the same gate pins them.
      reportsV2Router[method](fullPath, requireRole(...subRoles), scopeGate, wrapped);
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
