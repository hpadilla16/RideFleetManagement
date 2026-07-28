import { Router } from 'express';
import { requireRole } from '../../middleware/auth.js';
import { incidentReportService } from './incident-report.service.js';

// Authenticated incident-report routes. Mounted at /api/incident-reports.
//   builder + lifecycle, evidence, clause library, print HTML.
export const incidentReportRouter = Router();

incidentReportRouter.use(requireRole('ADMIN', 'OPS', 'AGENT'));

function wrap(handler) {
  return async (req, res, next) => {
    try {
      await handler(req, res);
    } catch (e) {
      if (e && Number.isInteger(e.statusCode)) return res.status(e.statusCode).json({ error: e.message });
      next(e);
    }
  };
}

const svc = incidentReportService;

// ---- clause library (must precede /:id to avoid capture) ----
incidentReportRouter.get('/clauses', wrap(async (req, res) => res.json(await svc.clause.list(req.user))));
incidentReportRouter.post('/clauses', wrap(async (req, res) => res.status(201).json(await svc.clause.create(req.user, req.body || {}))));
incidentReportRouter.post('/clauses/seed', wrap(async (req, res) => res.json(await svc.clause.seed(req.user))));
incidentReportRouter.patch('/clauses/:id', wrap(async (req, res) => res.json(await svc.clause.update(req.user, req.params.id, req.body || {}))));
incidentReportRouter.delete('/clauses/:id', wrap(async (req, res) => res.json(await svc.clause.remove(req.user, req.params.id))));

// ---- tenant-wide HUB (2026-07-28): all reports in one place, joined with
// reservation + customer + vehicle + sede. Location-scoped users see only
// their sedes' incidents (fail-closed inside listForTenant). ----
incidentReportRouter.get('/', wrap(async (req, res) => {
  res.json(await svc.listForTenant(req.user, {
    status: req.query.status, type: req.query.type, severity: req.query.severity,
    q: req.query.q, page: req.query.page, pageSize: req.query.pageSize,
  }));
}));

// ---- reservation-scoped ----
incidentReportRouter.post('/reservations/:reservationId', wrap(async (req, res) => {
  res.status(201).json(await svc.create(req.user, req.params.reservationId, req.body || {}));
}));
incidentReportRouter.get('/reservations/:reservationId', wrap(async (req, res) => {
  res.json(await svc.listForReservation(req.user, req.params.reservationId));
}));

// ---- single incident ----
incidentReportRouter.get('/:id', wrap(async (req, res) => res.json(await svc.get(req.user, req.params.id))));
incidentReportRouter.patch('/:id', wrap(async (req, res) => res.json(await svc.update(req.user, req.params.id, req.body || {}))));
incidentReportRouter.post('/:id/clauses', wrap(async (req, res) => res.json(await svc.setClauses(req.user, req.params.id, (req.body || {}).clauseIds || []))));
incidentReportRouter.post('/:id/evidence', wrap(async (req, res) => res.status(201).json(await svc.addEvidence(req.user, req.params.id, req.body || {}))));
incidentReportRouter.post('/:id/evidence/pull', wrap(async (req, res) => res.json(await svc.pullInspectionEvidence(req.user, req.params.id, (req.body || {}).phase || 'CHECKIN'))));
incidentReportRouter.patch('/:id/evidence/:evidenceId', wrap(async (req, res) => res.json(await svc.updateEvidence(req.user, req.params.id, req.params.evidenceId, req.body || {}))));
incidentReportRouter.delete('/:id/evidence/:evidenceId', wrap(async (req, res) => res.json(await svc.removeEvidence(req.user, req.params.id, req.params.evidenceId))));
incidentReportRouter.post('/:id/certify', wrap(async (req, res) => res.json(await svc.certifyAndIssue(req.user, req.params.id, req.body || {}))));
incidentReportRouter.post('/:id/status', wrap(async (req, res) => res.json(await svc.setStatus(req.user, req.params.id, (req.body || {}).status))));
incidentReportRouter.post('/:id/revise', wrap(async (req, res) => res.status(201).json(await svc.revise(req.user, req.params.id))));

incidentReportRouter.get('/:id/print', wrap(async (req, res) => {
  const html = await svc.renderHtml(req.user, req.params.id);
  res.set('Content-Type', 'text/html; charset=utf-8').send(html);
}));

// Email the report (2026-07-28 hub): same print HTML, inline + .html attach.
// DRAFTs are rejected (409) — only issued/later documents leave the building.
incidentReportRouter.post('/:id/email', wrap(async (req, res) => {
  res.json(await svc.emailReport(req.user, req.params.id, {
    to: (req.body || {}).to, note: (req.body || {}).note,
  }));
}));
