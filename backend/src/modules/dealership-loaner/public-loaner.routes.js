import { Router } from 'express';
import { publicLoanerService } from './public-loaner.service.js';
import { attachPublicRequestMeta, createPublicRateLimitGuard } from '../../middleware/public-endpoint-guards.js';

// Public loaner self-service router (2026-06-25). Mounted at /api/public/loaner BEHIND
// resolvePublicTenantToken (so req.publicTokenTenantId is the scoped tenant). Fail-closed:
// no/invalid token → 401 (the middleware 401s an invalid token; requirePublicTenant 401s a
// missing one). Plan: doc/public-loaner-selfservice-plan-2026-06-25.md.
export const publicLoanerRouter = Router();

function requirePublicTenant(req, res, next) {
  if (!req.publicTokenTenantId) return res.status(401).json({ error: 'Tenant token required' });
  return next();
}

const loanerGuard = [
  attachPublicRequestMeta('public-loaner'),
  createPublicRateLimitGuard({ name: 'public-loaner', maxRequests: 40, windowMs: 60 * 1000 }),
  requirePublicTenant,
];

function handle(res, next, e) {
  if (e?.statusCode) return res.status(e.statusCode).json({ error: e.message });
  if (/required|not found|not available/i.test(String(e?.message || ''))) {
    return res.status(400).json({ error: e.message });
  }
  return next(e);
}

// POST /api/public/loaner/lookup — verify a service appointment by RO + list available loaners.
publicLoanerRouter.post('/lookup', loanerGuard, async (req, res, next) => {
  try {
    const out = await publicLoanerService.lookup({
      tenantId: req.publicTokenTenantId,
      repairOrderNumber: req.body?.repairOrderNumber,
      lastName: req.body?.lastName,
      phone: req.body?.phone,
    });
    res.json(out);
  } catch (e) { handle(res, next, e); }
});

// POST /api/public/loaner/reserve — pick a loaner + sign (PENDING advisor approval).
publicLoanerRouter.post('/reserve', loanerGuard, async (req, res, next) => {
  try {
    const out = await publicLoanerService.reserve({
      tenantId: req.publicTokenTenantId,
      appointmentId: req.body?.appointmentId,
      loanerId: req.body?.loanerId,
      signature: req.body?.signature,
      ip: req.ip,
    });
    res.status(201).json(out);
  } catch (e) { handle(res, next, e); }
});

// POST /api/public/loaner/request — "request a courtesy car" lead → advisor dashboard.
publicLoanerRouter.post('/request', loanerGuard, async (req, res, next) => {
  try {
    const out = await publicLoanerService.createRequest({
      tenantId: req.publicTokenTenantId,
      name: req.body?.name,
      phone: req.body?.phone,
      email: req.body?.email,
      repairOrderNumber: req.body?.repairOrderNumber,
      preferredDate: req.body?.preferredDate,
      notes: req.body?.notes,
    });
    res.status(201).json(out);
  } catch (e) { handle(res, next, e); }
});
