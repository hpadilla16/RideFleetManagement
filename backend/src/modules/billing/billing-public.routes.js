/**
 * Public autopay enrollment endpoints — mounted at /api/public/billing.
 *
 * NO auth: the token in the URL is the credential, exactly like the public
 * shuttle tracker and the T&C signing surface. So the shape is deliberately
 * small — one GET, two POSTs, a whitelisted payload on each, and the SAME bare
 * 404 for every unusable token.
 *
 * ONE 404 FOR MISSING, EXPIRED, USED AND REVOKED ALIKE. A distinct "this link
 * expired" response is an oracle: it tells an enumerator which tokens were ever
 * real. The proven groundwork got this right and it is kept.
 *
 * NOTHING HERE EVER RETURNS OR LOGS THE TOKEN. It is hashed on arrival, matched
 * on the hash, and the plaintext leaves this process only inside the returnUrl
 * we hand Authorize.Net — which has to carry it, because Authorize.Net must send
 * the customer back to their own link.
 */
import { Router } from 'express';
import {
  attachPublicRequestMeta,
  createPublicRateLimitGuard,
} from '../../middleware/public-endpoint-guards.js';
import logger from '../../lib/logger.js';
import { billingService } from './billing.service.js';

export const billingPublicRouter = Router();

/** The one answer any unusable token gets. */
function notFound(res) {
  return res.status(404).json({ error: 'Not found' });
}

const readGuards = [
  attachPublicRequestMeta('public-autopay-invite'),
  // A real enrollment is ONE read. 10/min per IP leaves room for a refresh and
  // a shared office NAT while being useless for enumeration.
  createPublicRateLimitGuard({ name: 'public-autopay-invite', maxRequests: 10, windowMs: 60 * 1000 }),
];

const writeGuards = [
  attachPublicRequestMeta('public-autopay-write'),
  // A real enrollment is one start and one return. 5/min per IP.
  createPublicRateLimitGuard({ name: 'public-autopay-write', maxRequests: 5, windowMs: 60 * 1000 }),
];

/**
 * The disclosure payload. Everything the customer must see BEFORE any card is
 * typed: who is charging, how much, how often, and the exact first-charge date.
 */
billingPublicRouter.get('/autopay/:token', readGuards, async (req, res, next) => {
  try {
    const view = await billingService.resolvePublicInvite(req.params.token);
    if (!view) return notFound(res);
    // The plan and price of a named company. Never let a proxy hold a copy.
    res.setHeader('Cache-Control', 'no-store');
    res.json(view);
  } catch (e) { next(e); }
});

/**
 * Mint the ~15-minute Authorize.Net hosted-page token. Called BEHIND THE BUTTON,
 * so the clock starts when the customer is done reading rather than when they
 * arrived. Returns the form target and the token; the browser POSTs both
 * straight to Authorize.Net, and the card never touches this origin.
 */
billingPublicRouter.post('/autopay/:token/start', writeGuards, async (req, res) => {
  try {
    const session = await billingService.startHostedSession(req.params.token);
    if (!session) return notFound(res);
    res.setHeader('Cache-Control', 'no-store');
    res.json(session);
  } catch (e) {
    // An Authorize.Net failure here is OUR problem, not a dead token.
    //
    // THE CODE ONLY, NEVER THE MESSAGE. This is the one call that sends
    // Authorize.Net a URL containing the invite token (it has to — that is
    // where the customer must be returned to), and Authorize.Net echoes
    // offending setting values back inside its error text. Logging the message
    // would therefore write a live enrollment token into the log stream, which
    // is exactly what storing only a hash was meant to prevent. The shared
    // redactor masks a field NAMED token; it cannot see one embedded in prose.
    logger.error('[billing] hosted session mint failed', {
      code: e?.code || null,
      name: e?.name || null,
    });
    res.status(502).json({ error: 'No pudimos abrir el formulario seguro. Intenta de nuevo.' });
  }
});

/**
 * The return leg. Authorize.Net has redirected the customer back to the Next
 * page, which POSTs here to finish the job: read what was saved, start the ARB
 * subscription, and write the subscription + ledger rows.
 *
 * Idempotent by construction (see completeEnrollment) — a refresh or a
 * double-click re-renders the receipt instead of creating a second subscription.
 */
billingPublicRouter.post('/autopay/:token/return', writeGuards, async (req, res, next) => {
  try {
    const result = await billingService.completeEnrollment(req.params.token, {
      ip: req.publicRequestMeta?.ip || req.ip || null,
      userAgent: req.get('user-agent') || null,
    });
    if (!result) return notFound(res);
    res.setHeader('Cache-Control', 'no-store');
    res.json(result);
  } catch (e) { next(e); }
});
