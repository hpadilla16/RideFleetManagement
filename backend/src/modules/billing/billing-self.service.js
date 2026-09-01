/**
 * The tenant's OWN view of their Ride Fleet Manager subscription — the page
 * they are never locked out of. Tenant Subscriptions Phase 5 (2026-08-28).
 *
 * ── WHY THIS FILE EXISTS AT ALL ────────────────────────────────────────────
 *
 * Phase 5's allowlist promises that a suspended tenant can always reach "the
 * billing pages". Phase 4 built the SUPER_ADMIN panel and nothing tenant-facing,
 * so before this file that promise pointed at nothing: the hold screen would
 * have said "update your payment method" over a button with no endpoint behind
 * it. An allowlist entry for a route that does not exist is not a carve-out, it
 * is a comment. So the minimum viable tenant-facing surface ships WITH the gate
 * rather than in Phase 7 — the gate is not safe to switch on without it.
 *
 * ── SCOPING ────────────────────────────────────────────────────────────────
 *
 * Every read here is scoped to `req.user.tenantId` from the VERIFIED SESSION.
 * There is no tenantId parameter, in the path, the query or the body — not
 * "validated", ABSENT, so no future edit can forget to check it. A tenant
 * looking up another tenant's billing is not a bug this surface can have.
 *
 * ── WHAT IT SHOWS AND WHAT IT REFUSES TO SHOW ──────────────────────────────
 *
 * Shows: status, plan, amount, cycle, next charge, card brand + last4, the day
 * the delinquency started, and the deadline. That is what somebody needs to
 * decide "do I need to go find a card right now".
 *
 * Refuses: `arbSubscriptionId`, `customerProfileId`, the consent archive, the
 * IP that authorised it, invite tokens. The SUPER_ADMIN panel shows the raw
 * Authorize.Net handles because support needs to paste them into the portal;
 * the customer has no use for them and every identifier we hand out is one more
 * thing that can be replayed at us.
 */
import { prisma } from '../../lib/prisma.js';
import logger from '../../lib/logger.js';
import { SUBSCRIPTION_STATUS, LIVE_SUBSCRIPTION_STATUSES } from './billing.service.js';
import { sendUpdatePaymentLink } from './billing-admin.service.js';
import { dunningGraceDays } from './billing-dunning.service.js';
import { formatMoney } from './billing-dates.js';

function deps(overrides = {}) {
  return {
    prisma: overrides.prisma || prisma,
    logger: overrides.logger || logger,
    now: overrides.now || (() => new Date()),
    sendUpdatePaymentLink: overrides.sendUpdatePaymentLink || sendUpdatePaymentLink,
    sendEmail: overrides.sendEmail || null,
    env: overrides.env || process.env,
    ...overrides,
  };
}

function badRequest(message) {
  const e = new Error(message);
  e.status = 400;
  return e;
}

/**
 * How many days until access is cut, given a delinquency that started at
 * `pastDueSince`. Null when nothing is overdue.
 *
 * Clamped at zero rather than going negative: "-2 days remaining" on a customer
 * screen is a bug wearing a number.
 */
export function daysUntilSuspension(pastDueSince, now, graceDays) {
  if (!pastDueSince) return null;
  const elapsedMs = now.getTime() - new Date(pastDueSince).getTime();
  const remaining = graceDays - Math.floor(elapsedMs / 86400000);
  return Math.max(0, remaining);
}

/**
 * THE DAY-0 NOTICE — the thing that appears on their dashboard the moment a
 * payment declines, before anything is cut off.
 *
 * Returned as STRUCTURED DATA, not a sentence: `{ level, code, daysRemaining,
 * … }`. The frontend renders it in the viewer's own language from the i18n
 * catalog. Building the sentence here would hard-code Spanish (or English) into
 * an API response and put the copy somewhere the translators cannot see it —
 * the exact mistake the bilingual rule exists to prevent.
 *
 * Three levels, and only three, because a banner with five severities is a
 * banner nobody reads:
 *   PAST_DUE   a payment failed; access is fine; here is the deadline.
 *   SUSPENDED  access is cut; contact Ride.
 *   null       nothing to say. Say nothing.
 */
export function buildBillingNotice(subscription, tenant, now, graceDays) {
  if (!subscription) return null;

  if (subscription.status === SUBSCRIPTION_STATUS.SUSPENDED || tenant?.status === 'SUSPENDED') {
    return {
      level: 'error',
      code: 'BILLING_SUSPENDED',
      suspendedAt: tenant?.billingSuspendedAt || subscription.suspendedAt || null,
      amount: subscription.amount == null ? null : String(subscription.amount),
      currency: subscription.currency || 'USD',
      cardBrand: subscription.cardBrand || null,
      cardLast4: subscription.cardLast4 || null,
    };
  }

  if (subscription.status === SUBSCRIPTION_STATUS.PAST_DUE) {
    return {
      level: 'warning',
      code: 'BILLING_PAST_DUE',
      pastDueSince: subscription.pastDueSince || null,
      daysRemaining: daysUntilSuspension(subscription.pastDueSince, now, graceDays),
      graceDays,
      amount: subscription.amount == null ? null : String(subscription.amount),
      currency: subscription.currency || 'USD',
      cardBrand: subscription.cardBrand || null,
      cardLast4: subscription.cardLast4 || null,
    };
  }

  return null;
}

/**
 * GET /api/billing/self — everything the hold screen and the dashboard banner
 * are made of, and nothing else.
 *
 * A tenant with NO subscription row is a normal, expected answer, not a 404:
 * most tenants are not enrolled yet, and their dashboard should render a quiet
 * "no subscription on file" rather than an error the user cannot act on.
 */
export async function getSelfBilling({ tenantId }, overrides = {}) {
  const d = deps(overrides);
  const now = d.now();
  const graceDays = dunningGraceDays(d.env);

  const tenant = await d.prisma.tenant.findUnique({ where: { id: String(tenantId) } });
  if (!tenant) {
    // The session said this tenant exists. If it does not, that is a data
    // problem, not something to explain to a customer.
    const e = new Error('Tenant not found');
    e.status = 404;
    throw e;
  }

  const subscription = await d.prisma.tenantSubscription.findFirst({
    where: { tenantId: tenant.id, status: { in: LIVE_SUBSCRIPTION_STATUSES } },
    orderBy: { createdAt: 'desc' },
  });

  return {
    tenant: {
      id: tenant.id,
      name: tenant.name,
      status: tenant.status,
      // WHETHER BILLING SWITCHED THEM OFF, not just that they are off. A tenant
      // suspended by hand for a compliance hold must not be shown a "pay us"
      // screen — the remedy would be wrong and the message insulting.
      suspendedForNonPayment: tenant.status === 'SUSPENDED' && !!tenant.billingSuspendedAt,
      billingSuspendedAt: tenant.billingSuspendedAt || null,
    },
    subscription: subscription ? {
      status: subscription.status,
      planName: subscription.planNameSnapshot,
      amount: String(subscription.amount),
      amountFormatted: formatMoney(subscription.amount),
      currency: subscription.currency,
      intervalUnit: subscription.intervalUnit,
      intervalLength: subscription.intervalLength,
      nextChargeDate: subscription.nextChargeDate,
      currentPeriodStart: subscription.currentPeriodStart,
      currentPeriodEnd: subscription.currentPeriodEnd,
      cardBrand: subscription.cardBrand,
      cardLast4: subscription.cardLast4,
      pastDueSince: subscription.pastDueSince,
      // The billing contact the update link would be emailed to, so the button
      // can say WHERE it is going. Nobody should press "email me a link" and
      // then wonder which inbox to check.
      billingEmail: subscription.authorizedEmail || null,
      // Deliberately absent: arbSubscriptionId, customerProfileId,
      // customerPaymentProfileId, the consent archive, lastFailureText.
    } : null,
    notice: buildBillingNotice(subscription, tenant, now, graceDays),
  };
}

/**
 * How long a tenant must wait between self-service link requests.
 *
 * Minting a link REVOKES the previous one (sendUpdatePaymentLink does this so
 * two live links cannot repoint the same subscription at two different cards).
 * Without a cooldown, an anxious customer clicking the button three times would
 * invalidate the link in the email they are about to open — and then report
 * that the link is broken, which it now is, because of them, because of us.
 */
const SELF_LINK_COOLDOWN_MS = 5 * 60 * 1000;

/**
 * POST /api/billing/self/payment-link — email THEM a fresh autopay update link.
 *
 * IT EMAILS. IT DOES NOT RETURN THE URL. Design §3.3: the link goes to the
 * billing address on the subscription, so there is exactly one enrollment path
 * in the system and a suspended session never becomes a card-entry context.
 * Returning the token to the caller would mean a stolen staff session could
 * repoint the tenant's subscription at an attacker's card without ever
 * controlling the billing inbox.
 */
export async function requestSelfPaymentLink({ tenantId, actorUserId, actorEmail }, overrides = {}) {
  const d = deps(overrides);
  const now = d.now();

  const subscription = await d.prisma.tenantSubscription.findFirst({
    where: { tenantId: String(tenantId), status: { in: LIVE_SUBSCRIPTION_STATUSES } },
    orderBy: { createdAt: 'desc' },
  });
  if (!subscription) {
    throw badRequest('There is no active subscription on this account. Contact Ride to get set up.');
  }
  if (!subscription.arbSubscriptionId) {
    throw badRequest('This subscription has no payment method on file yet. Contact Ride for an enrollment link.');
  }

  const recent = await d.prisma.autopayInvite.findFirst({
    where: {
      subscriptionId: subscription.id,
      mode: 'update',
      usedAt: null,
      revokedAt: null,
      createdAt: { gte: new Date(now.getTime() - SELF_LINK_COOLDOWN_MS) },
    },
    orderBy: { createdAt: 'desc' },
  });
  if (recent) {
    // NOT an error the caller can retry away — a fact. The link they want is
    // already in their inbox, and saying so is more useful than sending a
    // second one that kills the first.
    return {
      sent: false,
      reason: 'ALREADY_SENT',
      email: subscription.authorizedEmail || null,
      expiresAt: recent.expiresAt,
    };
  }

  const { url, invite } = await d.sendUpdatePaymentLink({
    subscriptionId: subscription.id,
    actorUserId: actorUserId ?? null,
    actorEmail: actorEmail ?? null,
    actorRole: 'TENANT_SELF_SERVICE',
  }, overrides);

  const to = invite.email;
  const sendEmail = d.sendEmail || (await import('../../lib/mailer.js')).sendEmail;
  await sendEmail({
    to,
    subject: 'Actualiza tu método de pago — Ride Fleet Manager',
    text: [
      'Hola,',
      '',
      'Recibimos tu solicitud para actualizar el método de pago de tu suscripción a Ride Fleet Manager.',
      'Abre este enlace para registrar la tarjeta. Es de un solo uso y vence pronto:',
      '',
      url,
      '',
      'Si no lo pediste, ignora este correo — el enlace no sirve si no se usa.',
    ].join('\n'),
  });

  d.logger.info('[billing-self] update-payment link emailed on tenant request', {
    tenantId: String(tenantId),
    subscriptionId: subscription.id,
    // THE PREFIX, NEVER THE TOKEN, NEVER THE URL. The URL contains the token.
    tokenPrefix: invite.tokenPrefix,
  });

  return { sent: true, email: to, expiresAt: invite.expiresAt };
}

export const billingSelf = {
  getSelfBilling,
  requestSelfPaymentLink,
  buildBillingNotice,
  daysUntilSuspension,
};
