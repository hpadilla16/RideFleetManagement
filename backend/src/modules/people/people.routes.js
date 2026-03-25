import { Router } from 'express';
import { isSuperAdmin, requireRole } from '../../middleware/auth.js';
import { peopleService } from './people.service.js';

export const peopleRouter = Router();

function scopeFor(req) {
  if (isSuperAdmin(req.user)) {
    return req.query?.tenantId ? { tenantId: String(req.query.tenantId), actorUserId: req.user?.id || null, actorRole: req.user?.role || null } : { actorUserId: req.user?.id || null, actorRole: req.user?.role || null };
  }
  return { tenantId: req.user?.tenantId || null, actorUserId: req.user?.id || null, actorRole: req.user?.role || null };
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
