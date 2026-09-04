/**
 * Contract clause overrides for ONE location. Mounted by locations.routes.js at
 * /api/locations/:id/clauses.
 *
 * SECURITY GATE: ADMIN only, narrower than the router it hangs off.
 * /api/locations is ADMIN+OPS, which is right for hours, fees and addresses.
 * These clauses are the text a renter legally agrees to and initials — the same
 * text re-printed inside the signed PDF beside their own initial image — so
 * they sit at the same tier as the terms documents themselves, not at the tier
 * of a phone number. `requireRole` already lets SUPER_ADMIN through.
 *
 * Branch scoping is enforced in the service (scopeAllowedLocationIds), fail
 * closed, 404 rather than 403 — a LAX admin must not be able to rewrite
 * Orlando's contract, nor learn that Orlando exists.
 *
 * Every write records an AdminAuditLog row carrying WHICH clauses changed and
 * how long they now are — never the wording. See clauseChangeSummary.
 */

import { Router } from 'express';
import { requireRole } from '../../middleware/auth.js';
import { scopeFor } from '../../lib/tenant-scope.js';
import { auditFromReq, AUDIT_ACTIONS, AUDIT_OUTCOME } from '../audit/audit.service.js';
import { locationClausesService, ClauseValidationError } from './location-clauses.service.js';

export const locationClausesRouter = Router({ mergeParams: true });

locationClausesRouter.use(requireRole('ADMIN'));

locationClausesRouter.get('/', async (req, res, next) => {
  try {
    const out = await locationClausesService.get(req.params.id, scopeFor(req));
    if (!out) return res.status(404).json({ error: 'Location not found' });
    res.json(out);
  } catch (e) { next(e); }
});

locationClausesRouter.put('/', async (req, res, next) => {
  const locationId = String(req.params.id || '');
  try {
    const out = await locationClausesService.update(locationId, req.body || {}, scopeFor(req));
    if (!out) {
      // A write aimed at a branch this admin cannot see is exactly what an
      // auditor wants to find, so the refusal leaves a row too (same shape as
      // the shuttle-zones precedent). No clause data: there is none to report.
      auditFromReq(req, {
        action: AUDIT_ACTIONS.LOCATION_CLAUSE_OVERRIDE_CHANGE,
        outcome: AUDIT_OUTCOME.FAILURE,
        targetType: 'LOCATION',
        targetId: locationId,
        metadata: { reason: 'LOCATION_NOT_FOUND' },
      });
      return res.status(404).json({ error: 'Location not found' });
    }

    auditFromReq(req, {
      action: AUDIT_ACTIONS.LOCATION_CLAUSE_OVERRIDE_CHANGE,
      tenantId: out.location.tenantId ?? undefined,
      targetType: 'LOCATION',
      targetId: out.location.id,
      metadata: {
        locationCode: out.location.code,
        // KEYS AND LENGTHS ONLY — never the clause wording. The trail answers
        // "who changed which clauses where, and did that knock this branch off
        // terminal signing"; the wording itself lives in the column and in the
        // acceptance rows of everyone who signed it.
        changed: out.changed,
        changedKeys: out.changed.map((c) => c.key),
        overriddenKeys: out.clauses.filter((c) => c.isOverridden).map((c) => c.key),
        terminalBlockedKeys: out.terminal.blockedKeys,
        terminalSigningAvailable: out.terminal.terminalSigningAvailable,
      },
    });

    res.json(out);
  } catch (e) {
    if (e instanceof ClauseValidationError) {
      return res.status(400).json({ error: e.message, details: e.details });
    }
    next(e);
  }
});
