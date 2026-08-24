/**
 * Quotes module routes (2026-07-17) — doc/quotes-module-plan-2026-07-17.md.
 * Mounted in main.js behind requireAuth + tenantRateLimit +
 * requireModuleAccess('quotes').
 *
 * Service-account (VozIA) surface — enforced by lib/service-account-allowlist.js:
 *   GET /preview · POST / · GET / · GET /:id · POST /:id/convert   → allowed
 *   POST /:id/cancel                                               → humans only
 *
 * POST / additionally runs requireRateOverrideRole FIRST (before idempotency),
 * so a forbidden override never reserves an idempotency key. It engages ONLY
 * when the body carries a staff daily-rate override (2026-08-24).
 *
 * POST / and POST /:id/convert run the idempotency middleware (kind 'quote' is
 * benign/recyclable like 'note' — re-creating the same quote or re-converting is
 * caught by the service's own idempotent convert; keys are still REQUIRED for
 * service accounts by the middleware).
 */
import { Router } from 'express';
import { scopeFor } from '../../lib/tenant-scope.js';
import { idempotency } from '../../middleware/idempotency.js';
import { auditIpFromReq, auditUserAgentFromReq } from '../audit/audit.service.js';
import { quotesService, canOverrideRate, hasRateOverrideIntent } from './quotes.service.js';

export const quotesRouter = Router();

const quoteIdempotency = idempotency({ kind: 'quote' });

function fail(res, e) {
  const status = Number.isInteger(e?.status) ? e.status : 500;
  if (status >= 500) return null; // let the global handler log it
  res.status(status).json({ error: e.message, ...(e.code ? { code: e.code } : {}) });
  return true;
}

function actorFor(req) {
  return {
    userId: req.user?.id || null,
    // Role + request identity ride along so the service can gate the rate
    // override and the audit row can name who did it. Additive: every existing
    // caller of actorFor (convert, setAddOns) only ever reads userId/author.
    role: req.user?.role || null,
    email: req.user?.email || null,
    ip: auditIpFromReq(req),
    userAgent: auditUserAgentFromReq(req)
  };
}

/**
 * Rate-override role gate (2026-08-24). POST /api/quotes stays open to every
 * authenticated staff role — an AGENT must keep creating ordinary quotes — so
 * the gate cannot be a blanket requireRole() at the mount. Instead it engages
 * ONLY when the body actually carries an override, and then applies the same
 * shape requireRole() uses in middleware/auth.js: 401 with no user, 403 when
 * the role is not allowed (SUPER_ADMIN passes via RATE_OVERRIDE_ROLES).
 *
 * The service re-checks this independently — this middleware is the consistent
 * route-level surface, not the only line of defence.
 */
function requireRateOverrideRole(req, res, next) {
  if (!hasRateOverrideIntent(req.body || {})) return next();
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  if (!canOverrideRate(req.user.role)) {
    return res.status(403).json({
      error: 'Your role cannot override the quoted daily rate',
      code: 'RATE_OVERRIDE_FORBIDDEN'
    });
  }
  return next();
}

// Compute WITHOUT saving (also answers availability). Params via query string.
quotesRouter.get('/preview', async (req, res, next) => {
  try {
    const { pickupLocationId, returnLocationId, vehicleTypeId, pickupAt, returnAt } = req.query || {};
    const out = await quotesService.preview(
      { pickupLocationId, returnLocationId, vehicleTypeId, pickupAt, returnAt },
      scopeFor(req)
    );
    res.json(out);
  } catch (e) {
    if (!fail(res, e)) next(e);
  }
});

quotesRouter.get('/', async (req, res, next) => {
  try {
    const { customerId, status, limit } = req.query || {};
    res.json(await quotesService.list({ customerId, status, limit }, scopeFor(req)));
  } catch (e) {
    if (!fail(res, e)) next(e);
  }
});

// Create. Body may carry `dailyRateOverride` (number > 0) + `rateOverrideReason`
// (non-empty) — ADMIN/OPS/SUPER_ADMIN + STAFF source only; see the service.
quotesRouter.post('/', requireRateOverrideRole, quoteIdempotency, async (req, res, next) => {
  try {
    const {
      pickupLocationId, returnLocationId, vehicleTypeId, pickupAt, returnAt,
      customerId, contactName, contactPhone, contactEmail,
      source, author, ticketId,
      dailyRateOverride, rateOverrideReason
    } = req.body || {};
    const row = await quotesService.create(
      {
        pickupLocationId, returnLocationId, vehicleTypeId, pickupAt, returnAt,
        customerId, contactName, contactPhone, contactEmail,
        source, author, ticketId,
        dailyRateOverride, rateOverrideReason
      },
      scopeFor(req),
      actorFor(req)
    );
    res.status(201).json(row);
  } catch (e) {
    if (!fail(res, e)) next(e);
  }
});

quotesRouter.get('/:id', async (req, res, next) => {
  try {
    const row = await quotesService.getById(req.params.id, scopeFor(req));
    if (!row) return res.status(404).json({ error: 'Quote not found' });
    res.json(row);
  } catch (e) {
    if (!fail(res, e)) next(e);
  }
});

// ---------------------------------------------------------------------------
// Staff editing (Hector 2026-08-06): add-ons + contact details. ALL humans-only
// — deliberately absent from the VozIA service-account allowlist, so the phone
// quoting flow cannot reach them and keeps its exact shape.
// ---------------------------------------------------------------------------

// The priced add-on catalog for this quote (services + insurance for its
// location/class/days) plus the current selection.
quotesRouter.get('/:id/add-on-options', async (req, res, next) => {
  try {
    res.json(await quotesService.addOnOptions(req.params.id, scopeFor(req)));
  } catch (e) {
    if (!fail(res, e)) next(e);
  }
});

// Replace the add-on selection. Body: { addOns: [{kind, code}] }. Codes only —
// prices resolve server-side; [] clears back to the original spoken price.
quotesRouter.put('/:id/add-ons', async (req, res, next) => {
  try {
    res.json(await quotesService.setAddOns(req.params.id, req.body || {}, scopeFor(req), actorFor(req)));
  } catch (e) {
    if (!fail(res, e)) next(e);
  }
});

// Contact-detail edit (name/phone/email). Never money.
quotesRouter.patch('/:id/contact', async (req, res, next) => {
  try {
    res.json(await quotesService.updateContact(req.params.id, req.body || {}, scopeFor(req)));
  } catch (e) {
    if (!fail(res, e)) next(e);
  }
});

// Re-quote (Hector 2026-07-17): duplicate with fresh engine prices. Humans-only
// (not allowlisted for service accounts).
quotesRouter.post('/:id/requote', async (req, res, next) => {
  try {
    const row = await quotesService.requote(req.params.id, scopeFor(req), actorFor(req));
    res.status(201).json(row);
  } catch (e) {
    if (!fail(res, e)) next(e);
  }
});

quotesRouter.post('/:id/cancel', async (req, res, next) => {
  try {
    res.json(await quotesService.cancel(req.params.id, scopeFor(req)));
  } catch (e) {
    if (!fail(res, e)) next(e);
  }
});

quotesRouter.post('/:id/convert', quoteIdempotency, async (req, res, next) => {
  try {
    const out = await quotesService.convert(req.params.id, req.body || {}, scopeFor(req), actorFor(req));
    res.status(out.alreadyConverted ? 200 : 201).json(out);
  } catch (e) {
    if (!fail(res, e)) next(e);
  }
});
