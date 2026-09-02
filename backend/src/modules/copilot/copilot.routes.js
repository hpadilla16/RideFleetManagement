// Agent Copilot — Phase 2 routes (2026-09-02).
//
// Mounted in main.js with requireAuth + tenantRateLimit and NO
// requireModuleAccess — the notifications precedent: the copilot floats over
// every staff screen for every authenticated role (AGENT included), so its
// telemetry flush and its AI fallback must not depend on any tenant module.
// The one admin-only read (top misses) is gated here at the route, beside the
// thing it guards (knowledge-base.routes precedent).
//
// Nothing here moves money or writes domain records: the panel's guardrail
// ("never acts") holds server-side too — misses in, grouped misses out, and a
// config-gated, capped, retrieval-bound model call.

import { Router } from 'express';
import { requireRole } from '../../middleware/auth.js';
import { scopeFor } from '../../lib/tenant-scope.js';
import {
  ingestMisses, flagMiss, topMisses, askCopilotAi, aiStatus,
} from './copilot.service.js';

function scopeWithUser(req) {
  // scopeFor carries tenant/location scoping only — the miss rows also stamp
  // who asked (same merge the checkin-audit dismiss route does).
  return { ...scopeFor(req), userId: req.user?.id || req.user?.sub || null };
}

export const copilotRouter = Router();

// POST /api/copilot/misses — the opportunistic ring-buffer flush.
// Fire-and-forget on the client; must stay cheap and never 500 over content.
copilotRouter.post('/misses', async (req, res, next) => {
  try {
    res.json(await ingestMisses(req.body || {}, scopeWithUser(req)));
  } catch (e) {
    next(e);
  }
});

// POST /api/copilot/misses/flag — "Avisar a un admin": flags the latest
// matching row (or records one) and emits the COPILOT notification envelope.
copilotRouter.post('/misses/flag', async (req, res, next) => {
  try {
    res.json(await flagMiss(req.body || {}, scopeWithUser(req)));
  } catch (e) {
    next(e);
  }
});

// GET /api/copilot/misses/top — the authoring backlog, grouped by normalized
// query. Admin-only: it names what the whole team cannot find.
copilotRouter.get('/misses/top', requireRole('SUPER_ADMIN', 'ADMIN'), async (req, res, next) => {
  try {
    res.json(await topMisses(req.query || {}, scopeFor(req)));
  } catch (e) {
    next(e);
  }
});

// GET /api/copilot/ai-status — the boolean the panel caches per session so a
// tenant with the AI fallback OFF (the default) never even calls /ask.
copilotRouter.get('/ai-status', async (req, res, next) => {
  try {
    res.json(await aiStatus(scopeFor(req)));
  } catch (e) {
    next(e);
  }
});

// POST /api/copilot/ask — the gated AI fallback. Refusals are 200s with an
// `unavailable` reason: the panel degrades to Phase 1 behavior on every one
// of them, and a 200 keeps retry-happy fetch wrappers quiet.
copilotRouter.post('/ask', async (req, res, next) => {
  try {
    res.json(await askCopilotAi(req.body || {}, scopeWithUser(req)));
  } catch (e) {
    next(e);
  }
});
