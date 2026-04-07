import { Router } from 'express';
import { issueCenterService } from './issue-center.service.js';
import { hostAppService } from '../host-app/host-app.service.js';
import { requireString, assertPlainObject } from '../../lib/request-validation.js';
import { attachPublicRequestMeta, createOptionalIdempotencyGuard, createPublicRateLimitGuard } from '../../middleware/public-endpoint-guards.js';

export const issueCenterRouter = Router();
export const publicIssueCenterRouter = Router();

const publicIssueReadGuard = [
  attachPublicRequestMeta('public-issue-center-read'),
  createPublicRateLimitGuard({ name: 'public-issue-center-read', maxRequests: 90, windowMs: 60 * 1000 })
];

const publicIssueWriteGuard = [
  attachPublicRequestMeta('public-issue-center-write'),
  createPublicRateLimitGuard({ name: 'public-issue-center-write', maxRequests: 25, windowMs: 60 * 1000 }),
  createOptionalIdempotencyGuard({ name: 'public-issue-center-write', windowMs: 15 * 60 * 1000 })
];

issueCenterRouter.get('/dashboard', async (req, res, next) => {
  try {
    res.json(await issueCenterService.getDashboard(req.user, {
      q: req.query?.q ? String(req.query.q) : '',
      status: req.query?.status ? String(req.query.status) : '',
      type: req.query?.type ? String(req.query.type) : ''
    }));
  } catch (error) {
    next(error);
  }
});

issueCenterRouter.post('/incidents', async (req, res, next) => {
  try {
    res.status(201).json(await issueCenterService.createInternalIncident(req.user, req.body || {}));
  } catch (error) {
    if (/not found|required|must be|valid number/i.test(String(error?.message || ''))) {
      return res.status(400).json({ error: error.message });
    }
    next(error);
  }
});

issueCenterRouter.patch('/incidents/:id', async (req, res, next) => {
  try {
    res.json(await issueCenterService.updateIncident(req.user, req.params.id, req.body || {}));
  } catch (error) {
    if (/not found|required/i.test(String(error?.message || ''))) {
      return res.status(400).json({ error: error.message });
    }
    next(error);
  }
});

issueCenterRouter.post('/incidents/:id/actions', async (req, res, next) => {
  try {
    res.json(await issueCenterService.applyWorkflowAction(req.user, req.params.id, req.body || {}));
  } catch (error) {
    if (/not found|required|action must be/i.test(String(error?.message || ''))) {
      return res.status(400).json({ error: error.message });
    }
    next(error);
  }
});

issueCenterRouter.post('/incidents/:id/charge-draft', async (req, res, next) => {
  try {
    res.json(await issueCenterService.createChargeDraft(req.user, req.params.id, req.body || {}));
  } catch (error) {
    if (/not found|required|greater than 0/i.test(String(error?.message || ''))) {
      return res.status(400).json({ error: error.message });
    }
    next(error);
  }
});

issueCenterRouter.post('/incidents/:id/charge-card-on-file', async (req, res, next) => {
  try {
    res.json(await issueCenterService.chargeCardOnFile(req.user, req.params.id, req.body || {}));
  } catch (error) {
    if (/not found|required|greater than 0|Authorize\.Net|card on file|payment profile|reservation/i.test(String(error?.message || ''))) {
      return res.status(400).json({ error: error.message });
    }
    next(error);
  }
});

issueCenterRouter.get('/incidents/:id/packet.txt', async (req, res, next) => {
  try {
    const packet = await issueCenterService.getIncidentPacket(req.user, requireString(req.params.id, 'id'));
    res.setHeader('Content-Type', packet.contentType || 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${packet.filename || 'claims-packet.txt'}"`);
    res.send(packet.body || '');
  } catch (error) {
    if (/not found|required/i.test(String(error?.message || ''))) {
      return res.status(400).json({ error: error.message });
    }
    next(error);
  }
});

issueCenterRouter.get('/incidents/:id/packet-print', async (req, res, next) => {
  try {
    const packet = await issueCenterService.getIncidentPacketPrint(req.user, requireString(req.params.id, 'id'));
    res.setHeader('Content-Type', packet.contentType || 'text/html; charset=utf-8');
    res.setHeader('Content-Disposition', `inline; filename="${packet.filename || 'claims-packet.html'}"`);
    res.send(packet.body || '');
  } catch (error) {
    if (/not found|required/i.test(String(error?.message || ''))) {
      return res.status(400).json({ error: error.message });
    }
    next(error);
  }
});

issueCenterRouter.post('/incidents/:id/request-info', async (req, res, next) => {
  try {
    res.json(await issueCenterService.requestMoreInfo(req.user, req.params.id, req.body || {}));
  } catch (error) {
    if (/not found|required|not available/i.test(String(error?.message || ''))) {
      return res.status(400).json({ error: error.message });
    }
    next(error);
  }
});

issueCenterRouter.post('/vehicle-submissions/:id/request-info', async (req, res, next) => {
  try {
    res.json(await issueCenterService.requestVehicleSubmissionInfo(req.user, req.params.id, req.body || {}));
  } catch (error) {
    if (/not found|required|not available/i.test(String(error?.message || ''))) {
      return res.status(400).json({ error: error.message });
    }
    next(error);
  }
});

issueCenterRouter.post('/vehicle-submissions/:id/approve', async (req, res, next) => {
  try {
    res.json(await hostAppService.approveVehicleSubmission(req.user, req.params.id, req.body || {}));
  } catch (error) {
    if (/not found|required|allowed/i.test(String(error?.message || ''))) {
      return res.status(400).json({ error: error.message });
    }
    next(error);
  }
});

publicIssueCenterRouter.get('/respond/:token', publicIssueReadGuard, async (req, res, next) => {
  try {
    res.json(await issueCenterService.getPublicResponsePrompt(requireString(req.params.token, 'token')));
  } catch (error) {
    if (/invalid|expired|required/i.test(String(error?.message || ''))) {
      return res.status(400).json({ error: error.message });
    }
    next(error);
  }
});

publicIssueCenterRouter.post('/respond/:token', publicIssueWriteGuard, async (req, res, next) => {
  try {
    assertPlainObject(req.body || {}, 'public issue response payload');
    res.json(await issueCenterService.submitPublicResponse(requireString(req.params.token, 'token'), req.body || {}));
  } catch (error) {
    if (/invalid|expired|required/i.test(String(error?.message || ''))) {
      return res.status(400).json({ error: error.message });
    }
    next(error);
  }
});
