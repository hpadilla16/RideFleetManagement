/**
 * The billing webhook endpoint — public, unauthenticated BY DESIGN.
 *
 * THE SIGNATURE IS THE AUTHENTICATION. There is no token in the URL, no
 * session, no IP allowlist, and there cannot be: Authorize.Net calls this from
 * their own infrastructure with no credential of ours except the HMAC. So the
 * route is a thin shell — every decision, starting with "is this real", lives
 * in ingestBillingWebhook and happens before a single byte of the body is
 * parsed.
 *
 * WHY THIS IS A SEPARATE ROUTER FROM billing-public.routes.js, AND A SEPARATE
 * ENDPOINT FROM THE RENTAL RECEIVER
 * ---------------------------------------------------------------------------
 * The rental receiver (customer-portal.routes.js) resolves its Signature Key
 * from per-tenant `paymentGatewayConfig` AppSettings and tries EVERY tenant's
 * key in turn until one verifies. Ride's billing account has exactly one key,
 * from env. Putting both on one route would mean a single endpoint holding two
 * credential sets and guessing which world an event came from — and guessing
 * wrong means attributing Ride's subscription revenue to a tenant's merchant
 * account, which is precisely the confusion authorize-net.js:9-13 exists to
 * prevent. The keys never share a route and never share a lookup.
 *
 * It is also separate from the autopay enrollment router next door because the
 * threat models do not match: those routes authenticate a customer by a
 * tokenized link and answer a bare 404 to everything unusable; this one
 * authenticates a machine by an HMAC and answers a bare 401. Different
 * credential, different rate budget, different response vocabulary.
 */
import { Router } from 'express';
import {
  attachPublicRequestMeta,
  createPublicRateLimitGuard,
} from '../../middleware/public-endpoint-guards.js';
import { ingestBillingWebhook } from './billing-webhooks.service.js';
import logger from '../../lib/logger.js';

export const billingWebhookRouter = Router();

const webhookGuards = [
  attachPublicRequestMeta('billing-authnet-webhook'),
  /**
   * 120/min per IP, matching the rental receiver's budget.
   *
   * Ride has a handful of tenants, so real traffic is a few events a day; this
   * is not a capacity limit, it is a floor on how much work an attacker who
   * has found the URL can make us do. The HMAC is the real gate — the limiter
   * only bounds the volume of signature checks.
   *
   * NOTE THE GUARD FAILS OPEN when Redis is unreachable
   * (public-endpoint-guards.js). That is the right trade here and would not be
   * elsewhere: failing CLOSED would mean a Redis blip silently rejects genuine
   * Authorize.Net deliveries, burning their finite retries and losing money
   * events permanently. An unbounded number of requests that all fail an HMAC
   * check is a much cheaper problem than a lost `subscription.suspended`.
   */
  createPublicRateLimitGuard({
    name: 'billing-authnet-webhook',
    maxRequests: 120,
    windowMs: 60 * 1000,
  }),
];

billingWebhookRouter.post('/authorizenet/webhook', webhookGuards, async (req, res) => {
  try {
    const { status, body } = await ingestBillingWebhook(req);
    // No caching, ever — and no ETag for an attacker to correlate.
    res.setHeader('Cache-Control', 'no-store');
    return res.status(status).json(body);
  } catch (err) {
    // Reaching here means the ingest itself broke in a way it did not expect —
    // typically the database being unreachable, i.e. BEFORE the event could be
    // made durable. This is the ONE case where a non-2xx is right: we have not
    // stored the event, so Authorize.Net's retry is the only thing that can
    // still save it. Everywhere past the insert, ingest answers 200 on purpose.
    logger.error('[billing-webhook] ingest failed before the event was durable', {
      message: err?.message || String(err),
    });
    return res.status(503).json({ error: 'Temporarily unavailable' });
  }
});
