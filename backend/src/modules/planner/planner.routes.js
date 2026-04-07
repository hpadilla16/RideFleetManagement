import { Router } from 'express';
import { isSuperAdmin } from '../../middleware/auth.js';
import { plannerRulesService } from './planner.rules.service.js';
import { plannerService } from './planner.service.js';
import { plannerRecommendationService } from './planner.recommendation.service.js';
import { plannerActionsService } from './planner.actions.service.js';
import { plannerCopilotService } from './planner.copilot.service.js';

export const plannerRouter = Router();

function scopeFor(req) {
  const requestedTenantId = req.query?.tenantId || req.body?.tenantId || null;
  const actorName = [req.user?.firstName, req.user?.lastName].filter(Boolean).join(' ').trim() || req.user?.name || '';
  const actorEmail = req.user?.email || '';
  if (isSuperAdmin(req.user)) {
    return requestedTenantId
      ? { allowCrossTenant: true, tenantId: String(requestedTenantId), actorUserId: req.user?.sub || null, actorName, actorEmail }
      : { allowCrossTenant: true, actorUserId: req.user?.sub || null, actorName, actorEmail };
  }
  return {
    tenantId: req.user?.tenantId || null,
    allowCrossTenant: false,
    actorUserId: req.user?.sub || null,
    actorName,
    actorEmail
  };
}

plannerRouter.get('/rules', async (req, res, next) => {
  try {
    const rules = await plannerRulesService.getRuleSet(scopeFor(req));
    res.json(rules);
  } catch (error) {
    if (/tenantId is required/i.test(String(error?.message || ''))) {
      return res.status(400).json({ error: 'tenantId is required for planner rules' });
    }
    next(error);
  }
});

plannerRouter.put('/rules', async (req, res, next) => {
  try {
    const rules = await plannerRulesService.upsertRuleSet(req.body || {}, scopeFor(req));
    res.json(rules);
  } catch (error) {
    if (error?.details?.length) {
      return res.status(400).json({ error: 'Validation failed', details: error.details });
    }
    if (/tenantId is required/i.test(String(error?.message || ''))) {
      return res.status(400).json({ error: 'tenantId is required for planner rules' });
    }
    next(error);
  }
});

plannerRouter.get('/snapshot', async (req, res, next) => {
  try {
    const out = await plannerService.getSnapshot({
      start: req.query?.start,
      end: req.query?.end,
      locationId: req.query?.locationId,
      vehicleTypeId: req.query?.vehicleTypeId
    }, scopeFor(req));
    res.json(out);
  } catch (error) {
    if (/must be a valid date|later than start/i.test(String(error?.message || ''))) {
      return res.status(400).json({ error: error.message });
    }
    if (/tenantId is required/i.test(String(error?.message || ''))) {
      return res.status(400).json({ error: 'tenantId is required for planner snapshot' });
    }
    next(error);
  }
});

plannerRouter.post('/simulate-auto-accommodate', async (req, res, next) => {
  try {
    const out = await plannerRecommendationService.simulateAutoAccommodate(req.body || {}, scopeFor(req));
    res.json(out);
  } catch (error) {
    if (/must be a valid date|later than start/i.test(String(error?.message || ''))) {
      return res.status(400).json({ error: error.message });
    }
    if (/tenantId is required/i.test(String(error?.message || ''))) {
      return res.status(400).json({ error: 'tenantId is required for planner simulation' });
    }
    next(error);
  }
});

plannerRouter.post('/simulate-maintenance', async (req, res, next) => {
  try {
    const out = await plannerRecommendationService.simulateMaintenance(req.body || {}, scopeFor(req));
    res.json(out);
  } catch (error) {
    if (/must be a valid date|later than start|tenantId is required/i.test(String(error?.message || ''))) {
      return res.status(400).json({ error: error.message });
    }
    next(error);
  }
});

plannerRouter.post('/simulate-wash-plan', async (req, res, next) => {
  try {
    const out = await plannerRecommendationService.simulateWashPlan(req.body || {}, scopeFor(req));
    res.json(out);
  } catch (error) {
    if (/must be a valid date|later than start|tenantId is required/i.test(String(error?.message || ''))) {
      return res.status(400).json({ error: error.message });
    }
    next(error);
  }
});

plannerRouter.get('/copilot-config', async (req, res, next) => {
  try {
    const out = await plannerCopilotService.getClientConfig(scopeFor(req));
    res.json(out);
  } catch (error) {
    if (/tenantId is required/i.test(String(error?.message || ''))) {
      return res.status(400).json({ error: 'tenantId is required for planner copilot' });
    }
    next(error);
  }
});

plannerRouter.post('/copilot', async (req, res, next) => {
  try {
    const out = await plannerCopilotService.advise(req.body || {}, scopeFor(req));
    res.json(out);
  } catch (error) {
    if (/monthly query cap reached/i.test(String(error?.message || ''))) {
      return res.status(429).json({ error: error.message });
    }
    if (/not included in the .* plan/i.test(String(error?.message || ''))) {
      return res.status(403).json({ error: error.message });
    }
    if (/not enabled for this tenant/i.test(String(error?.message || ''))) {
      return res.status(403).json({ error: error.message });
    }
    if (/must be a valid date|later than start|tenantId is required/i.test(String(error?.message || ''))) {
      return res.status(400).json({ error: error.message });
    }
    next(error);
  }
});

plannerRouter.post('/apply-plan', async (req, res, next) => {
  try {
    const out = await plannerActionsService.applyScenario({
      scenarioId: req.body?.scenarioId,
      actions: req.body?.actions,
      scope: scopeFor(req),
      actorUserId: req.user?.sub || null
    });
    res.json(out);
  } catch (error) {
    if (/scenarioId is required|tenantId is required|has no actions|required for planner action|required for planner block action|must be after blockedFrom|cannot be reassigned|not available for assignment|conflict|active .* during this reservation window|active .* during this planner block window/i.test(String(error?.message || ''))) {
      return res.status(400).json({ error: error.message });
    }
    if (/not found/i.test(String(error?.message || ''))) {
      return res.status(404).json({ error: error.message });
    }
    next(error);
  }
});
