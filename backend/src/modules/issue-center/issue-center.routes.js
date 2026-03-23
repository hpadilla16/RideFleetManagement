import { Router } from 'express';
import { issueCenterService } from './issue-center.service.js';
import { hostAppService } from '../host-app/host-app.service.js';

export const issueCenterRouter = Router();
export const publicIssueCenterRouter = Router();

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

publicIssueCenterRouter.get('/respond/:token', async (req, res, next) => {
  try {
    res.json(await issueCenterService.getPublicResponsePrompt(req.params.token));
  } catch (error) {
    if (/invalid|expired|required/i.test(String(error?.message || ''))) {
      return res.status(400).json({ error: error.message });
    }
    next(error);
  }
});

publicIssueCenterRouter.post('/respond/:token', async (req, res, next) => {
  try {
    res.json(await issueCenterService.submitPublicResponse(req.params.token, req.body || {}));
  } catch (error) {
    if (/invalid|expired|required/i.test(String(error?.message || ''))) {
      return res.status(400).json({ error: error.message });
    }
    next(error);
  }
});
