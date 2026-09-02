// Post-check-in audit routes (2026-09-03, T1 rules).
//
// Mounted in main.js with requireAuth + tenantRateLimit and NO
// requireModuleAccess — the notifications precedent: the review queue is a
// staff surface for every authenticated role that closes check-ins (AGENT
// included), and every read is tenant-scoped via scopeFor. Writes are the
// dismiss fork only; money never moves here (the only path to a charge stays
// the existing Report Damage wizard).

import { Router } from 'express';
import express from 'express';
import { scopeFor } from '../../lib/tenant-scope.js';
import { checkinAuditService } from './checkin-audit.service.js';

function handleError(res, err) {
  const status = Number(err?.status) || 500;
  res.status(status).json({ error: err?.message || 'Internal error' });
}

export const checkinAuditRouter = Router();

// GET /api/checkin-audit?lane=entry|mileageFuel|damage|passed|dismissed|resolved|all
// The queue: one lane's rows + counts for every lane + the KPI strip.
checkinAuditRouter.get('/', async (req, res) => {
  try {
    res.json(await checkinAuditService.listCheckinAudits(req.query || {}, scopeFor(req)));
  } catch (err) {
    handleError(res, err);
  }
});

// GET /api/checkin-audit/:reservationId — every finding for one reservation
// (the detail view's audit cards).
checkinAuditRouter.get('/:reservationId', async (req, res) => {
  try {
    res.json(await checkinAuditService.getCheckinAuditDetail(req.params.reservationId, scopeFor(req)));
  } catch (err) {
    handleError(res, err);
  }
});

// GET /api/checkin-audit/findings/:id/convert-prefill
// The Mock-2 handoff: everything the Report Damage wizard can be pre-filled
// with from a DAMAGE finding's own evidence — view, dot, description, and the
// check-in + checkout photos as data URLs. READ-ONLY: nothing changes until
// the human completes the wizard's normal submit (estimate + who-pays are
// theirs alone); the finding resolves only when that submit commits.
checkinAuditRouter.get('/findings/:id/convert-prefill', async (req, res) => {
  try {
    res.json(await checkinAuditService.buildConvertPrefill(req.params.id, scopeFor(req)));
  } catch (err) {
    handleError(res, err);
  }
});

// POST /api/checkin-audit/findings/:id/dismiss
// body: { classification: 'NOT_ISSUE' } or
//       { classification: 'PREEXISTING', view, xPct, yPct, description?, photoDataUrl }
// PREEXISTING (DAMAGE findings only — none in T1; the verb ships for T2)
// appends a HARD_APPROVED ledger entry via the existing manual-damage create,
// source AUDIT_PREEXISTING, reviewer stamped, linked via sourceAuditFindingId.
// 15mb limit because the pre-existing path carries the check-in photo.
checkinAuditRouter.post('/findings/:id/dismiss', express.json({ limit: '15mb' }), async (req, res) => {
  try {
    // scopeFor carries tenant/location scoping only — the reviewer stamp
    // needs the actor id alongside it (same merge the report-damage routes do).
    const scope = { ...scopeFor(req), userId: req.user?.id || req.user?.sub || null };
    res.json(await checkinAuditService.dismissFinding(req.params.id, req.body || {}, scope));
  } catch (err) {
    handleError(res, err);
  }
});
