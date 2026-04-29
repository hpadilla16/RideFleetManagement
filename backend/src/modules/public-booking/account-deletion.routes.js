import express from 'express';
import { accountDeletionService } from './account-deletion.service.js';
import {
  attachPublicRequestMeta,
  createPublicRateLimitGuard
} from '../../middleware/public-endpoint-guards.js';

export const accountDeletionRouter = express.Router();

const requestGuard = [
  attachPublicRequestMeta('account-deletion-request'),
  createPublicRateLimitGuard({
    name: 'account-deletion-request',
    maxRequests: 5,
    windowMs: 60 * 60 * 1000 // 1 hour — destructive op, low limit
  })
];

const confirmGuard = [
  attachPublicRequestMeta('account-deletion-confirm'),
  createPublicRateLimitGuard({
    name: 'account-deletion-confirm',
    maxRequests: 10,
    windowMs: 60 * 1000 // 10/min — confirmation is idempotent-ish
  })
];

accountDeletionRouter.post('/account/delete-request', ...requestGuard, async (req, res) => {
  try {
    const { email, tenantId, typedConfirmation } = req.body || {};
    const result = await accountDeletionService.requestAccountDeletion({
      email,
      tenantId,
      typedConfirmation
    });
    res.status(202).json(result);
  } catch (e) {
    const status = e.statusCode || 500;
    const body = { error: e.message || 'Account deletion request failed.' };
    if (e.activeTripCodes) body.activeTripCodes = e.activeTripCodes;
    res.status(status).json(body);
  }
});

accountDeletionRouter.post('/account/delete-confirm/:token', ...confirmGuard, async (req, res) => {
  try {
    const { token } = req.params;
    const result = await accountDeletionService.confirmAccountDeletion({ token });
    res.status(200).json(result);
  } catch (e) {
    const status = e.statusCode || 500;
    const body = { error: e.message || 'Account deletion failed.' };
    if (e.activeTripCodes) body.activeTripCodes = e.activeTripCodes;
    res.status(status).json(body);
  }
});
