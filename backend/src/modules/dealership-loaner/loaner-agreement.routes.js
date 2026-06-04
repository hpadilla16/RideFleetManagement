import { Router } from 'express';
import { prisma } from '../../lib/prisma.js';
import { isSuperAdmin, requireRole } from '../../middleware/auth.js';
import {
  attachPublicRequestMeta,
  createPublicRateLimitGuard
} from '../../middleware/public-endpoint-guards.js';
import { loanerAgreementService } from './loaner-agreement.service.js';

// ---------------------------------------------------------------------
// Loaner Agreement routes — the in-bay check-out / check-in wizard.
//   Authenticated:  /api/loaner-agreements/*   (ADMIN | OPS | AGENT)
//   Public signing: /api/public/loaner-signature/:token
// ---------------------------------------------------------------------

export const loanerAgreementRouter = Router();

// Mirrors dealership-loaner.routes.js — gate on the tenant feature flag.
async function ensureLoanerEnabled(req, res, next) {
  try {
    if (isSuperAdmin(req.user)) return next();
    const tenantId = req.user?.tenantId || null;
    if (!tenantId) return res.status(403).json({ error: 'Dealership loaner is not enabled for this tenant' });
    const tenant = await prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { dealershipLoanerEnabled: true }
    });
    if (!tenant?.dealershipLoanerEnabled) {
      return res.status(403).json({ error: 'Dealership loaner is not enabled for this tenant' });
    }
    next();
  } catch (error) {
    next(error);
  }
}

// Map service errors (err.statusCode) to responses; otherwise bubble to the
// global error handler.
function wrap(handler) {
  return async (req, res, next) => {
    try {
      await handler(req, res);
    } catch (e) {
      if (e && Number.isInteger(e.statusCode)) {
        return res.status(e.statusCode).json({ error: e.message });
      }
      next(e);
    }
  };
}

loanerAgreementRouter.use(requireRole('ADMIN', 'OPS', 'AGENT'));
loanerAgreementRouter.use(ensureLoanerEnabled);

loanerAgreementRouter.post('/reservations/:reservationId', wrap(async (req, res) => {
  const result = await loanerAgreementService.createForReservation(req.user, req.params.reservationId, req.body || {});
  res.status(201).json(result);
}));

loanerAgreementRouter.get('/reservations/:reservationId', wrap(async (req, res) => {
  res.json(await loanerAgreementService.getByReservation(req.user, req.params.reservationId));
}));

loanerAgreementRouter.get('/:id', wrap(async (req, res) => {
  res.json(await loanerAgreementService.get(req.user, req.params.id));
}));

loanerAgreementRouter.patch('/:id', wrap(async (req, res) => {
  res.json(await loanerAgreementService.update(req.user, req.params.id, req.body || {}));
}));

loanerAgreementRouter.post('/:id/photos', wrap(async (req, res) => {
  res.json(await loanerAgreementService.uploadPhotos(req.user, req.params.id, req.body || {}));
}));

loanerAgreementRouter.post('/:id/damage-points', wrap(async (req, res) => {
  res.status(201).json(await loanerAgreementService.addDamagePoint(req.user, req.params.id, req.body || {}));
}));

loanerAgreementRouter.post('/:id/sign', wrap(async (req, res) => {
  res.json(await loanerAgreementService.sign(req.user, req.params.id, { ...(req.body || {}), ip: req.ip }));
}));

loanerAgreementRouter.post('/:id/signature-token', wrap(async (req, res) => {
  res.json(await loanerAgreementService.issueSignatureToken(req.user, req.params.id));
}));

loanerAgreementRouter.post('/:id/check-in', wrap(async (req, res) => {
  res.json(await loanerAgreementService.checkIn(req.user, req.params.id, req.body || {}));
}));

loanerAgreementRouter.post('/:id/close', wrap(async (req, res) => {
  res.json(await loanerAgreementService.close(req.user, req.params.id, req.body || {}));
}));

// --------------------- Public token-based signing ---------------------
export const loanerSignaturePublicRouter = Router();

const loanerSigRead = [
  attachPublicRequestMeta('loaner-signature-read'),
  createPublicRateLimitGuard({ name: 'loaner-signature-read', maxRequests: 60, windowMs: 60 * 1000 })
];
const loanerSigWrite = [
  attachPublicRequestMeta('loaner-signature-write'),
  createPublicRateLimitGuard({ name: 'loaner-signature-write', maxRequests: 20, windowMs: 60 * 1000 })
];

loanerSignaturePublicRouter.get('/:token', loanerSigRead, async (req, res, next) => {
  try {
    res.json(await loanerAgreementService.getByToken(req.params.token));
  } catch (e) {
    if (e && Number.isInteger(e.statusCode)) return res.status(e.statusCode).json({ error: e.message });
    next(e);
  }
});

loanerSignaturePublicRouter.post('/:token/signature', loanerSigWrite, async (req, res, next) => {
  try {
    res.json(await loanerAgreementService.submitSignatureByToken(req.params.token, req.body || {}, { ip: req.ip }));
  } catch (e) {
    if (e && Number.isInteger(e.statusCode)) return res.status(e.statusCode).json({ error: e.message });
    next(e);
  }
});

// ----------------- Customer self-service status portal -----------------
export const loanerPortalPublicRouter = Router();

const loanerPortalRead = [
  attachPublicRequestMeta('loaner-portal-read'),
  createPublicRateLimitGuard({ name: 'loaner-portal-read', maxRequests: 120, windowMs: 60 * 1000 })
];
const loanerPortalWrite = [
  attachPublicRequestMeta('loaner-portal-write'),
  createPublicRateLimitGuard({ name: 'loaner-portal-write', maxRequests: 30, windowMs: 60 * 1000 })
];

function handlePortal(res, next, e) {
  if (e && Number.isInteger(e.statusCode)) return res.status(e.statusCode).json({ error: e.message });
  next(e);
}

loanerPortalPublicRouter.get('/:token', loanerPortalRead, async (req, res, next) => {
  try {
    res.json(await loanerAgreementService.getByPortalToken(req.params.token));
  } catch (e) { handlePortal(res, next, e); }
});

loanerPortalPublicRouter.post('/:token/extend', loanerPortalWrite, async (req, res, next) => {
  try {
    res.json(await loanerAgreementService.requestExtensionByToken(req.params.token, req.body || {}));
  } catch (e) { handlePortal(res, next, e); }
});

loanerPortalPublicRouter.post('/:token/schedule-return', loanerPortalWrite, async (req, res, next) => {
  try {
    res.json(await loanerAgreementService.scheduleReturnByToken(req.params.token, req.body || {}));
  } catch (e) { handlePortal(res, next, e); }
});
