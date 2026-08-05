import { Router } from 'express';
import { prisma } from '../../lib/prisma.js';
import { cache } from '../../lib/cache.js';
import { scopeFor } from '../../lib/tenant-scope.js';
import { pricingSuggestionEngine } from './pricing-suggestion-engine.service.js';
import { runMarketAutoApplyAll, getEngineAManagedRateIds } from '../market-scraper/market-scrape-correction.service.js';

/**
 * PricingRule CRUD + PricingSuggestion inbox routes.
 *
 *   GET    /api/pricing-rules/by-rate/:rateId         (fetch the rule for a Rate)
 *   POST   /api/pricing-rules                         (upsert by rateId)
 *   PATCH  /api/pricing-rules/:id
 *   DELETE /api/pricing-rules/:id
 *   POST   /api/pricing-rules/:id/preview             (dry-run for the UI live preview)
 *
 *   GET    /api/pricing-suggestions?status=PENDING    (inbox feed)
 *   GET    /api/pricing-suggestions/:id               (detail)
 *   POST   /api/pricing-suggestions/:id/apply
 *   POST   /api/pricing-suggestions/:id/reject
 *
 * Internal-only (called by the droplet cron after the scrape finishes):
 *   POST   /api/internal/pricing-engine/run           (run engine for all active rules)
 *
 * All routes tenant-scoped. The /internal route requires a shared secret
 * header (Authorization: Bearer $BACKEND_INTERNAL_TOKEN).
 */

export const pricingRulesRouter = Router();
export const pricingSuggestionsRouter = Router();
export const pricingEngineInternalRouter = Router();

function handle(err, res, next) {
  if (err?.httpStatus) return res.status(err.httpStatus).json({ error: err.message });
  return next(err);
}

function tenantWhere(scope) {
  if (scope.tenantId === '__no_tenant__') return { tenantId: '__no_tenant__' };
  if (scope.tenantId) return { tenantId: scope.tenantId };
  return {};
}

// ============================================================================
// Pricing Rules
// ============================================================================

pricingRulesRouter.get('/by-rate/:rateId', async (req, res, next) => {
  try {
    const where = { rateId: req.params.rateId, ...tenantWhere(scopeFor(req)) };
    const rule = await prisma.pricingRule.findFirst({ where });
    if (!rule) return res.status(404).json({ error: 'No rule set for this rate' });
    res.json(rule);
  } catch (e) { handle(e, res, next); }
});

pricingRulesRouter.post('/', async (req, res, next) => {
  try {
    const scope = scopeFor(req);
    const body = req.body || {};
    if (!body.rateId) return res.status(400).json({ error: 'rateId is required' });

    // Verify the rate belongs to the tenant before letting them attach a rule.
    const rate = await prisma.rate.findFirst({
      where: { id: body.rateId, ...tenantWhere(scope) },
      select: { id: true, tenantId: true },
    });
    if (!rate) return res.status(404).json({ error: 'Rate not found in your tenant' });

    const data = {
      rateId: body.rateId,
      tenantId: rate.tenantId,
      mode: body.mode || 'SUGGEST',
      strategy: body.strategy || 'NTH_CHEAPEST',
      sipp: body.sipp ?? null,
      targetN: body.targetN ?? null,
      targetVendor: body.targetVendor ?? null,
      paddingPct: body.paddingPct ?? 0,
      floorPrice: body.floorPrice,
      ceilingPrice: body.ceilingPrice,
      autoMaxDeltaPct: body.autoMaxDeltaPct ?? null,
      active: body.active ?? true,
      createdBy: req.user?.id ?? null,
      updatedBy: req.user?.id ?? null,
    };

    // Upsert by rateId (one rule per rate).
    const rule = await prisma.pricingRule.upsert({
      where: { rateId: body.rateId },
      create: data,
      update: { ...data, updatedBy: req.user?.id ?? null },
    });
    res.status(201).json(rule);
  } catch (e) { handle(e, res, next); }
});

pricingRulesRouter.patch('/:id', async (req, res, next) => {
  try {
    const where = { id: req.params.id, ...tenantWhere(scopeFor(req)) };
    const existing = await prisma.pricingRule.findFirst({ where });
    if (!existing) return res.status(404).json({ error: 'Rule not found' });
    const body = req.body || {};
    const data = { updatedBy: req.user?.id ?? null };
    for (const k of ['sipp', 'mode', 'strategy', 'targetN', 'targetVendor', 'paddingPct', 'floorPrice', 'ceilingPrice', 'autoMaxDeltaPct', 'active']) {
      if (k in body) data[k] = body[k];
    }
    const rule = await prisma.pricingRule.update({ where: { id: existing.id }, data });
    res.json(rule);
  } catch (e) { handle(e, res, next); }
});

pricingRulesRouter.delete('/:id', async (req, res, next) => {
  try {
    const where = { id: req.params.id, ...tenantWhere(scopeFor(req)) };
    const existing = await prisma.pricingRule.findFirst({ where });
    if (!existing) return res.status(404).json({ error: 'Rule not found' });
    await prisma.pricingRule.delete({ where: { id: existing.id } });
    res.status(204).send();
  } catch (e) { handle(e, res, next); }
});

/**
 * POST /api/pricing-rules/:id/preview
 *
 * Run the engine for this single rule in dry-run mode — no DB writes, just
 * return what the suggestion *would* be right now. Powers the live preview
 * on the rate edit page.
 */
pricingRulesRouter.post('/:id/preview', async (req, res, next) => {
  try {
    const where = { id: req.params.id, ...tenantWhere(scopeFor(req)) };
    const rule = await prisma.pricingRule.findFirst({
      where,
      include: {
        rate: {
          select: {
            id: true, tenantId: true, rateCode: true, daily: true,
            locationId: true, location: { select: { id: true, code: true } },
          },
        },
      },
    });
    if (!rule) return res.status(404).json({ error: 'Rule not found' });

    // Apply any pending body overrides for the preview (so the user can tweak
    // sliders without saving first).
    const overrides = req.body?.overrides || {};
    const previewRule = { ...rule, ...overrides };

    // Hack: call evaluateRule with a special "preview" flag. Easiest way is to
    // wrap it inside a transaction we always roll back, but Prisma rollback
    // requires interactive tx. Simpler: re-implement the math here without
    // writing. For V1 we shell out to evaluateRule and rollback by hand —
    // but to keep this stub clean we just NotImplemented preview for now and
    // return a static stub. Frontend can call POST /api/pricing-rules without
    // saving to compute, or call the inner math in JS.
    return res.status(501).json({ error: 'Preview endpoint pending — UI computes locally for now' });
  } catch (e) { handle(e, res, next); }
});

// ============================================================================
// Pricing Suggestions Inbox
// ============================================================================

pricingSuggestionsRouter.get('/', async (req, res, next) => {
  try {
    const where = { ...tenantWhere(scopeFor(req)) };
    if (req.query.status) where.status = String(req.query.status).toUpperCase();
    const items = await prisma.pricingSuggestion.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: 200,
      include: {
        rule: { select: { id: true, strategy: true, targetN: true, targetVendor: true, mode: true } },
        rate: { select: { id: true, rateCode: true, name: true, location: { select: { code: true } } } },
      },
    });
    res.json(items);
  } catch (e) { handle(e, res, next); }
});

pricingSuggestionsRouter.get('/:id', async (req, res, next) => {
  try {
    const where = { id: req.params.id, ...tenantWhere(scopeFor(req)) };
    const item = await prisma.pricingSuggestion.findFirst({
      where,
      include: {
        rule: true,
        rate: { select: { id: true, rateCode: true, name: true, daily: true, location: { select: { code: true } } } },
      },
    });
    if (!item) return res.status(404).json({ error: 'Suggestion not found' });
    res.json(item);
  } catch (e) { handle(e, res, next); }
});

pricingSuggestionsRouter.post('/:id/apply', async (req, res, next) => {
  try {
    const where = { id: req.params.id, ...tenantWhere(scopeFor(req)) };
    const item = await prisma.pricingSuggestion.findFirst({ where });
    if (!item) return res.status(404).json({ error: 'Suggestion not found' });
    if (item.status !== 'PENDING') {
      return res.status(409).json({ error: `Cannot apply suggestion in status ${item.status}` });
    }
    // One engine per rate: if Market Intelligence auto-apply (Engine A) owns this
    // rate, a human must not move its base via a stale Engine B suggestion either.
    const managed = await getEngineAManagedRateIds({ tenantId: item.tenantId });
    if (managed.has(item.rateId)) {
      return res.status(409).json({ error: 'This rate is managed by Market Intelligence auto-apply; Engine B suggestions are retired for it.' });
    }
    const [updated] = await prisma.$transaction([
      prisma.pricingSuggestion.update({
        where: { id: item.id },
        data: { status: 'APPLIED', appliedAt: new Date(), appliedBy: req.user?.id ?? null },
      }),
      prisma.rate.update({
        where: { id: item.rateId },
        data: { daily: item.suggestedPrice },
      }),
      // Mirror Rate.daily into RateItem.daily — resolveForRental
      // (rates.service.js:817) reads `item?.daily ?? chosen.daily`, so
      // without this the manual approve would update a field the booking
      // engine ignores. Same pattern as the engine service AUTO_APPLY tx.
      prisma.rateItem.updateMany({
        where: { rateId: item.rateId },
        data: { daily: item.suggestedPrice },
      }),
    ]);
    // Mirror of the engine cache-invalidation: clear the tenant's quote
    // caches so the new Rate.daily flows through to fresh search results.
    // See pricing-suggestion-engine.service.js for the same pattern.
    cache.invalidate(`t:${item.tenantId}:booking:`);
    cache.invalidate(`t:${item.tenantId}:public:`);
    res.json(updated);
  } catch (e) { handle(e, res, next); }
});

pricingSuggestionsRouter.post('/:id/reject', async (req, res, next) => {
  try {
    const where = { id: req.params.id, ...tenantWhere(scopeFor(req)) };
    const item = await prisma.pricingSuggestion.findFirst({ where });
    if (!item) return res.status(404).json({ error: 'Suggestion not found' });
    if (item.status !== 'PENDING') {
      return res.status(409).json({ error: `Cannot reject suggestion in status ${item.status}` });
    }
    const updated = await prisma.pricingSuggestion.update({
      where: { id: item.id },
      data: {
        status: 'REJECTED',
        rejectedReason: req.body?.reason || null,
        appliedBy: req.user?.id ?? null,
      },
    });
    res.json(updated);
  } catch (e) { handle(e, res, next); }
});

// ============================================================================
// Internal trigger from droplet cron
// ============================================================================

function requireInternalToken(req, res, next) {
  const expected = process.env.BACKEND_INTERNAL_TOKEN;
  if (!expected) return res.status(503).json({ error: 'Internal endpoints disabled (no BACKEND_INTERNAL_TOKEN)' });
  const got = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (got !== expected) return res.status(401).json({ error: 'Invalid internal token' });
  next();
}

pricingEngineInternalRouter.post('/run', requireInternalToken, async (req, res, next) => {
  try {
    const opts = req.body || {};
    // Engine B (PricingRule → Rate.daily). Retires from any rate Engine A owns.
    const out = await pricingSuggestionEngine.runPricingEngine(opts);
    // Engine A (Market Intelligence → live RateDailyPrice). This is the real
    // post-scrape hook in prod (the droplet cron POSTs here after scraping).
    // DARK unless MARKET_AUTOAPPLY_ENABLED is on AND a profile has autoApply=true;
    // every write goes through the money guardrails. Best-effort — a bad apply
    // must not fail the pricing-engine run.
    let marketAutoApply = null;
    try {
      marketAutoApply = await runMarketAutoApplyAll({ tenantId: opts.tenantId || null });
    } catch (e) {
      marketAutoApply = { error: e.message };
    }
    // Outbound MEX rate push, QUEUED behind the reservation sync (2026-08-06,
    // Hector: "que se haga despues del motor de pricing"). Enqueue-only here:
    // the push drives the same single-window TSD account as the sync, so it
    // runs on the mex.sync queue (concurrency 1) where they can never collide.
    // Best-effort — pricing must never fail because the push could not queue.
    let mexRatePush = null;
    try {
      const { enqueueRatePushForEnabledTenants } = await import('../integrations/mex/mex.worker.js');
      mexRatePush = await enqueueRatePushForEnabledTenants({ tenantId: opts.tenantId || null });
    } catch (e) {
      mexRatePush = { error: e.message };
    }
    res.json({ ...out, marketAutoApply, mexRatePush });
  } catch (e) { handle(e, res, next); }
});
