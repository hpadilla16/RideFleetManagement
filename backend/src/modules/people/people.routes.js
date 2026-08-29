import { Router } from 'express';
import { isSuperAdmin, requireRole } from '../../middleware/auth.js';
import { peopleService } from './people.service.js';
import { auditIpFromReq, auditUserAgentFromReq } from '../audit/audit.service.js';

export const peopleRouter = Router();

// Wave 3 (2026-08-24): the scope now also carries the FULL actor context
// (email/role/impersonatedBy) plus ip/userAgent, so peopleService can write an
// AdminAuditLog row from inside the service — where old-vs-new is known — with
// the same actor detail a route-level audit would have. actorUserId/actorRole
// were already threaded for createdByUserId/authorization.
function auditActor(req) {
  return {
    actorUserId: req.user?.id || req.user?.sub || null,
    actorEmail: req.user?.email || null,
    actorRole: req.user?.role || null,
    impersonatedByUserId: req.user?.imp || null,
    actorIp: auditIpFromReq(req),
    actorUserAgent: auditUserAgentFromReq(req),
  };
}

function scopeFor(req) {
  if (isSuperAdmin(req.user)) {
    return req.query?.tenantId ? { tenantId: String(req.query.tenantId), ...auditActor(req) } : { ...auditActor(req) };
  }
  return { tenantId: req.user?.tenantId || null, ...auditActor(req) };
}

peopleRouter.get('/', requireRole('ADMIN'), async (req, res, next) => {
  try {
    res.json(await peopleService.listPeople(scopeFor(req)));
  } catch (e) {
    next(e);
  }
});

peopleRouter.post('/', requireRole('ADMIN'), async (req, res) => {
  try {
    const row = await peopleService.createPerson(req.body || {}, scopeFor(req));
    res.status(201).json(row);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

peopleRouter.patch('/:personId', requireRole('ADMIN'), async (req, res) => {
  try {
    res.json(await peopleService.updatePerson(req.params.personId, req.body || {}, scopeFor(req)));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

peopleRouter.post('/:userId/reset-password', requireRole('ADMIN'), async (req, res) => {
  try {
    res.json(await peopleService.resetPassword(req.params.userId, req.body || {}, scopeFor(req)));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});
