/**
 * Billing webhook ingest — Authorize.Net tells us what happened to Ride's own
 * subscription revenue.
 *
 * THIS PHASE OBSERVES AND RECORDS. IT NEVER CHARGES ANYBODY. There is no code
 * path from here to a `createTransactionRequest`, deliberately: an endpoint
 * reachable by anyone on the internet that could also move money is a different
 * and much worse thing than one that can only write rows.
 *
 * ORDER OF OPERATIONS, AND WHY IT IS THIS ORDER
 * ---------------------------------------------------------------------------
 *  1. VERIFY THE SIGNATURE OVER THE RAW BYTES. Before parsing. Before logging
 *     anything from the body. Before touching the database. The signature IS
 *     the authentication on this route — there is no token, no session, no IP
 *     allowlist — so everything downstream of it is a privilege granted by it.
 *  2. Only then parse.
 *  3. Reject anything older than the staleness window, so a captured event
 *     cannot be replayed months later even by someone who has the bytes.
 *  4. INSERT the event keyed on the provider's notificationId. A unique-
 *     violation here IS the replay defence: the row cannot exist twice, so the
 *     handler cannot run twice.
 *  5. Resolve, plan, apply, stamp.
 *
 * WHY WE PERSIST NOTHING FOR AN UNVERIFIED BODY. Storing unverified payloads
 * would make this URL a free write primitive for anyone who finds it: unbounded
 * rows, attacker-chosen content, in the same table an operator reads to decide
 * what happened to a customer's money.
 *
 * WHY A FAILED HANDLER STILL ANSWERS 200. Authorize.Net's retries are FINITE;
 * when they run out the event is gone forever. Our own sweeper retries against
 * a durable row for as long as it takes. So the instant the event is safely on
 * disk (step 4), "got it" is the safest possible answer, and finishing the work
 * becomes our problem rather than a countdown we do not control. A 500 here
 * would trade a retry we own for one we do not.
 *
 * CREDENTIALS: BILLING_AUTHNET_* ONLY. The per-tenant rental gateway's
 * receiver lives in customer-portal.routes.js with its own key material read
 * from per-tenant AppSettings. The two must never meet on one route: a single
 * endpoint holding both credential sets would have to GUESS which world an
 * event came from, and guessing wrong on the money path means attributing
 * Ride's subscription revenue to a tenant's merchant account.
 */
import { prisma } from '../../lib/prisma.js';
import logger from '../../lib/logger.js';
import {
  verifyAuthnetWebhookSignature,
  rawWebhookBody,
  authnetSignatureHeader,
} from '../../lib/authnet-webhook-signature.js';
import { recordAudit, AUDIT_ACTIONS } from '../audit/audit.service.js';
import {
  SUBSCRIPTION_STATUS,
  CHARGE_SOURCE,
  CHARGE_KIND,
  CHARGE_STATUS,
  buildScheduledChargeDescription,
} from './billing.service.js';
import {
  parseEventEnvelope,
  planEventEffect,
  isLateEvent,
  assertNoPan,
  STATE_AFFECTING_EVENTS,
  BILLING_EVENT,
} from './billing-events.js';
import { notifyOwner } from './billing-notify.js';
import { todayCalendarDate } from './billing-dates.js';

/**
 * How old an event may be and still be acted on.
 *
 * Authorize.Net's own redelivery attempts are measured in hours, so seven days
 * is generous for every legitimate case and still closes the window on a
 * captured-and-replayed event. Note this is a SECOND line of defence: the
 * notificationId unique index already makes a replay of an event we have seen a
 * no-op. This one covers a replay of an event we somehow never recorded.
 */
const STALE_AFTER_MS = Number(process.env.BILLING_WEBHOOK_STALE_DAYS || 7) * 24 * 60 * 60 * 1000;

/** The signature key. ENV, never an AppSetting — see the design's §4.2 note. */
export function billingSignatureKey() {
  return String(process.env.BILLING_AUTHNET_SIGNATURE_KEY || '').trim();
}

function deps(overrides = {}) {
  return {
    prisma: overrides.prisma || prisma,
    logger: overrides.logger || logger,
    now: overrides.now || (() => new Date()),
    recordAudit: overrides.recordAudit || recordAudit,
    notifyOwner: overrides.notifyOwner || notifyOwner,
    signatureKey: overrides.signatureKey || billingSignatureKey(),
    ...overrides,
  };
}

/**
 * THE TWO ANSWERS THIS ENDPOINT GIVES, AND NOTHING ELSE.
 *
 * Every unverified request gets byte-identical 401s — missing header, malformed
 * header, wrong key, empty body, unset server key, all the same. Every verified
 * request gets a byte-identical 200 whether the event was handled, ignored,
 * duplicated, unlinked or threw. An attacker holding no key can never reach the
 * 200, and can learn nothing from the 401 about which of their guesses was
 * closer — no reason codes, no field names, no timing branch before the HMAC.
 */
const UNAUTHORIZED = Object.freeze({ status: 401, body: { error: 'Unauthorized' } });
const ACCEPTED = Object.freeze({ status: 200, body: { received: true } });

/**
 * Ingest one webhook delivery.
 *
 * Returns `{ status, body, outcome }`. `outcome` is for tests and logs ONLY and
 * never reaches the wire — the route sends `status`/`body` verbatim.
 */
export async function ingestBillingWebhook(req, overrides = {}) {
  const d = deps(overrides);
  const now = d.now();

  // ── 1. Signature, over the RAW BYTES, before anything else ───────────────
  const rawBody = rawWebhookBody(req);
  const header = authnetSignatureHeader(req);
  const verified = verifyAuthnetWebhookSignature(rawBody, header, d.signatureKey);

  if (!verified.ok) {
    // DELIBERATE DEVIATION FROM THE DESIGN (§4.4 step 1), and it is the safer
    // direction. The design says to log { eventType, notificationId,
    // signatureOk:false } — but both of those fields can only be obtained by
    // PARSING A BODY WE JUST REFUSED TO TRUST, and then writing attacker-chosen
    // strings into our own log stream. So we log the fact and the size, and
    // nothing that came out of the body. Also nothing derived from the KEY: no
    // fingerprint, no expected-HMAC prefix. The rental endpoint logs both of
    // those and it is a bad idea there too; on the route guarding Ride's
    // revenue it is not happening.
    d.logger.warn('[billing-webhook] rejected: signature not valid', {
      signatureOk: false,
      hasHeader: !!header,
      bodyBytes: rawBody.length,
      keyConfigured: !!d.signatureKey,
    });
    return { ...UNAUTHORIZED, outcome: 'bad-signature' };
  }

  // ── 2. Parse. Verified bytes, so this is Authorize.Net's own JSON ────────
  let json;
  try {
    json = JSON.parse(rawBody.toString('utf8'));
  } catch {
    d.logger.error('[billing-webhook] verified body was not JSON', { bodyBytes: rawBody.length });
    return { ...ACCEPTED, outcome: 'unparseable' };
  }

  const event = parseEventEnvelope(json);

  if (!event.notificationId) {
    // No idempotency key means no replay protection, and a table anyone can
    // append to without a dedupe key is a table that can be filled up.
    d.logger.error('[billing-webhook] verified event carries no notificationId', {
      eventType: event.eventType || null,
    });
    return { ...ACCEPTED, outcome: 'no-notification-id' };
  }

  // ── 3. Staleness ─────────────────────────────────────────────────────────
  if (event.eventDate && (now.getTime() - event.eventDate.getTime()) > STALE_AFTER_MS) {
    d.logger.warn('[billing-webhook] ignored stale event', {
      eventType: event.eventType,
      notificationId: event.notificationId,
      ageDays: Math.round((now.getTime() - event.eventDate.getTime()) / 86400000),
    });
    return { ...ACCEPTED, outcome: 'stale' };
  }

  // ── 4. PAN assertion, before the payload becomes a durable row ───────────
  // Authorize.Net does not send card numbers in webhooks; it sends masked
  // values. This asserts that rather than assuming it, because being wrong once
  // moves the whole platform from PCI SAQ C to SAQ D on the strength of one
  // JSON column. On a hit we keep the event (the state change still matters)
  // and drop the payload.
  const panCheck = assertNoPan(json);
  const storedPayload = panCheck.clean
    ? json
    : { _redacted: true, reason: 'payload withheld: PAN assertion failed', eventType: event.eventType };
  if (!panCheck.clean) {
    d.logger.error('[billing-webhook] PAYLOAD WITHHELD — PAN assertion failed', {
      eventType: event.eventType,
      notificationId: event.notificationId,
      // The reason describes the shape of what was found and never quotes it.
      reason: panCheck.reason,
    });
  }

  // ── 5. Insert the event. The unique index IS the replay defence ──────────
  const subscription = await resolveSubscription(event, d);

  let row;
  try {
    row = await d.prisma.tenantSubscriptionEvent.create({
      data: {
        notificationId: event.notificationId,
        eventType: event.eventType || 'unknown',
        eventDate: event.eventDate,
        arbSubscriptionId: event.arbSubscriptionId,
        transId: event.transId,
        subscriptionId: subscription?.id ?? null,
        payload: storedPayload,
        signatureOk: true, // only verified bodies are stored at all
        attempts: 1,
      },
    });
  } catch (err) {
    if (err?.code === 'P2002') {
      // A REDELIVERY. Authorize.Net resends when it does not see a 2xx fast
      // enough, and this is the single most likely "weird" thing to happen on
      // this route. Return immediately: re-running the handler is exactly the
      // double mutation the unique index exists to prevent.
      d.logger.info('[billing-webhook] duplicate delivery ignored', {
        eventType: event.eventType,
        notificationId: event.notificationId,
      });
      return { ...ACCEPTED, outcome: 'duplicate' };
    }
    throw err;
  }

  // From here on the event is DURABLE. Everything below may fail without
  // losing it, which is why every failure below still answers 200.
  const outcome = await processStoredEvent(row, { event, subscription, now }, overrides);
  return { ...ACCEPTED, outcome };
}

/**
 * Resolve which of our subscriptions an event is about.
 *
 * Three routes, in descending order of certainty:
 *   1. The ARB subscription id, when the event carries one.
 *   2. An existing charge row with the same transId — which is how a payment
 *      event gets attributed at all once the first charge for that
 *      subscription is on file.
 *   3. Nothing. The event is stored UNLINKED and alerted on, because an event
 *      about a subscription we do not know exists is a real problem: either
 *      something is charging at Authorize.Net that we never recorded, or our
 *      records lost a reference. Both are worse in silence.
 *
 * The honest limit: Authorize.Net's PAYMENT webhook payload does not reliably
 * carry a subscription reference (this is INFERRED — see the report). When it
 * does not, and no charge row exists yet, a payment event is unresolvable here.
 * That gap is exactly what detector 3 covers, and it is why detector 3 is not
 * optional.
 */
async function resolveSubscription(event, d) {
  if (event.arbSubscriptionId) {
    const bySub = await d.prisma.tenantSubscription.findUnique({
      where: { arbSubscriptionId: event.arbSubscriptionId },
    });
    if (bySub) return bySub;
  }
  if (event.transId) {
    const charge = await d.prisma.tenantSubscriptionCharge.findUnique({
      where: { transId: event.transId },
    });
    if (charge?.subscriptionId) {
      return d.prisma.tenantSubscription.findUnique({ where: { id: charge.subscriptionId } });
    }
  }
  return null;
}

/**
 * Apply one stored event. Reused verbatim by the reconciler's unprocessed-event
 * sweep, which is why it takes a row rather than a request: a retry a day later
 * must do exactly what the original attempt would have done.
 */
export async function processStoredEvent(row, context = {}, overrides = {}) {
  const d = deps(overrides);
  const now = context.now || d.now();
  const event = context.event || parseEventEnvelope(row.payload);
  let subscription = context.subscription;
  if (subscription === undefined) {
    subscription = row.subscriptionId
      ? await d.prisma.tenantSubscription.findUnique({ where: { id: row.subscriptionId } })
      : await resolveSubscription(event, d);
  }

  try {
    const plan = planEventEffect(subscription, event, now);

    // ── ORDERING GUARD ────────────────────────────────────────────────────
    // Webhooks arrive out of order. The case that matters: a delayed
    // `.created` landing after a `.suspended` would replay "this subscription
    // exists" over "the card was declined" and silently un-suspend a
    // delinquent account.
    //
    // The watermark is the newest eventDate among STATE-AFFECTING events
    // already PROCESSED for this subscription. It is derived from the event
    // ledger rather than stored on the subscription, so it cannot disagree
    // with the events themselves and it needed no schema change.
    //
    // NOTE WHAT IS AND IS NOT SUPPRESSED. Only `subscriptionPatch` — the
    // conclusion. The `charge` row is written regardless: money that moved,
    // moved, and a transaction that arrives late is still a real transaction.
    // Dropping it would lose revenue history to a network hiccup, and it is
    // uniquely keyed on transId so it cannot be written twice anyway.
    const watermark = subscription ? await stateWatermark(subscription.id, row.id, d) : null;
    const late = isLateEvent(event, watermark);

    let statusChangedTo = null;
    let previousStatus = subscription?.status ?? null;

    if (plan.charge && subscription) {
      await upsertCharge(plan.charge, subscription, row, now, d);
    }

    if (plan.subscriptionPatch && subscription && !late) {
      const patch = { ...plan.subscriptionPatch, lastWebhookAt: now };
      delete patch._statusUnchanged;
      const updated = await d.prisma.tenantSubscription.update({
        where: { id: subscription.id },
        data: patch,
      });
      if (updated.status !== previousStatus) statusChangedTo = updated.status;
      subscription = updated;
    } else if (subscription) {
      // Even a no-op event proves the pipe is alive. `lastWebhookAt` feeds the
      // 72-hour heartbeat, so it must be stamped on EVERY verified event, not
      // only on ones that changed something.
      await d.prisma.tenantSubscription.update({
        where: { id: subscription.id },
        data: { lastWebhookAt: now },
      });
    }

    if (late) {
      d.logger.warn('[billing-webhook] LATE event — state change suppressed', {
        eventType: event.eventType,
        notificationId: row.notificationId,
        subscriptionId: subscription?.id || null,
        eventDate: event.eventDate?.toISOString() || null,
        watermark: watermark ? new Date(watermark).toISOString() : null,
      });
    }

    if (plan.alert) {
      d.logger[plan.alert.level === 'error' ? 'error' : 'warn'](
        `[billing-webhook] ${plan.alert.code}`,
        {
          message: plan.alert.message,
          subscriptionId: subscription?.id || null,
          tenantId: subscription?.tenantId || null,
          eventType: event.eventType,
          notificationId: row.notificationId,
        },
      );
    }

    // ── ONCE PER TRANSITION, NOT ONCE PER EVENT ───────────────────────────
    // The gate is `statusChangedTo` — a value that only exists when the stored
    // status actually moved. A second `.suspended` against an already-PAST_DUE
    // row produces no change and therefore no mail. Deriving this from the row
    // rather than from a dedupe cache is what makes it correct across every
    // API worker and across restarts.
    if (statusChangedTo && plan.notify) {
      await d.notifyOwner(plan.notify, subscription, {
        detectedBy: `webhook ${event.eventType}`,
      });
      await d.recordAudit({
        tenantId: subscription.tenantId,
        action: AUDIT_ACTIONS.SUBSCRIPTION_STATE_CHANGE,
        targetType: 'TenantSubscription',
        targetId: subscription.id,
        metadata: {
          from: previousStatus,
          to: statusChangedTo,
          source: 'WEBHOOK',
          eventType: event.eventType,
          notificationId: row.notificationId,
          arbSubscriptionId: subscription.arbSubscriptionId,
        },
      });
    }

    await d.prisma.tenantSubscriptionEvent.update({
      where: { id: row.id },
      data: {
        processedAt: now,
        processingError: null,
        subscriptionId: subscription?.id ?? row.subscriptionId ?? null,
        // An event suppressed as late is still PROCESSED — it is finished, and
        // its answer was "do nothing". It cannot displace the watermark it lost
        // to, because the watermark is a MAX over eventDate and a late event is
        // by definition older than the mark it failed to beat.
      },
    });

    return late ? 'late-suppressed' : (plan.subscriptionPatch ? 'applied' : 'noted');
  } catch (err) {
    // The event stays on disk with processedAt NULL, and the reconciler's
    // sweep will try again. This is the whole reason we answer 200.
    await d.prisma.tenantSubscriptionEvent.update({
      where: { id: row.id },
      data: {
        attempts: { increment: 1 },
        // The error is OURS (a Prisma failure, a bug), not Authorize.Net prose,
        // so it is safe to keep — and it is the only way to debug a row that
        // keeps failing. Truncated because processingError is read in a panel.
        processingError: String(err?.message || err).slice(0, 800),
      },
    }).catch(() => {});
    d.logger.error('[billing-webhook] processing failed; event kept for retry', {
      eventType: row.eventType,
      notificationId: row.notificationId,
      message: err?.message || String(err),
    });
    return 'error';
  }
}

/**
 * The newest eventDate among state-affecting events already processed for this
 * subscription, EXCLUDING the one being processed now.
 */
async function stateWatermark(subscriptionId, excludeEventId, d) {
  const newest = await d.prisma.tenantSubscriptionEvent.findFirst({
    where: {
      subscriptionId,
      processedAt: { not: null },
      eventType: { in: [...STATE_AFFECTING_EVENTS] },
      id: { not: excludeEventId },
      // UNDATED EVENTS ARE EXCLUDED, AND THIS LINE IS LOAD-BEARING. Postgres
      // sorts NULLs FIRST on `ORDER BY x DESC`, so without it a single event
      // with an unparseable eventDate would win the ordering, the watermark
      // would read back as null, and `isLateEvent` would answer "not late" for
      // everything from then on — the guard would be silently off. An event we
      // cannot place in time must not be allowed to place anything else.
      eventDate: { not: null },
    },
    orderBy: { eventDate: 'desc' },
  });
  return newest?.eventDate || null;
}

/**
 * Write the ledger row for a money event.
 *
 * UPSERT ON transId — THE SECOND INDEPENDENT IDEMPOTENCY LAYER. Even if an
 * event reached us through a path that bypassed the notificationId check
 * entirely (the reconciler materialising a charge it found at ARB, say), the
 * money still cannot be counted twice, because the transaction id is unique in
 * the table. The two layers are deliberately not the same key: one protects
 * against a duplicated MESSAGE, the other against a duplicated FACT.
 *
 * A charge with no transId is not written at all. A ledger row with no
 * idempotency key is a row that will eventually be duplicated.
 */
async function upsertCharge(charge, subscription, eventRow, now, d) {
  if (!charge.transId) {
    d.logger.warn('[billing-webhook] money event with no transaction id — no ledger row written', {
      subscriptionId: subscription.id,
      notificationId: eventRow.notificationId,
    });
    return null;
  }

  const chargeDate = todayCalendarDate(now);
  const description = charge.description || buildScheduledChargeDescription({
    planName: subscription.planNameSnapshot,
    amount: charge.amount ?? subscription.amount,
    currency: subscription.currency,
    intervalUnit: subscription.intervalUnit,
    intervalLength: subscription.intervalLength,
    chargeDate: charge.periodStart || chargeDate,
    periodStart: charge.periodStart || chargeDate,
    periodEnd: charge.periodEnd || chargeDate,
  });

  const common = {
    kind: charge.kind || CHARGE_KIND.RECURRING,
    status: charge.status || CHARGE_STATUS.PENDING,
    // Falling back to the SNAPSHOT amount, never to the plan catalog: the
    // catalog is editable and would re-price history.
    amount: charge.amount == null ? subscription.amount : charge.amount,
    currency: subscription.currency,
    arbSubscriptionId: subscription.arbSubscriptionId,
    authCode: charge.authCode ?? null,
    responseCode: charge.responseCode || null,
    cardBrand: subscription.cardBrand,
    cardLast4: subscription.cardLast4,
    settledAt: charge.settledAt ?? null,
    periodStart: charge.periodStart ?? null,
    periodEnd: charge.periodEnd ?? null,
    description,
    source: CHARGE_SOURCE.WEBHOOK,
    sourceEventId: eventRow.id,
  };

  return d.prisma.tenantSubscriptionCharge.upsert({
    where: { transId: charge.transId },
    create: {
      ...common,
      transId: charge.transId,
      subscriptionId: subscription.id,
      tenantId: subscription.tenantId,
      chargeDate: charge.periodStart || chargeDate,
    },
    // On the update leg the identity columns are deliberately absent: a
    // transId belongs to exactly one subscription forever, and letting an
    // event move an existing charge to a different tenant would be the worst
    // imaginable outcome of a malformed payload.
    update: {
      status: common.status,
      settledAt: common.settledAt,
      authCode: common.authCode,
      responseCode: common.responseCode,
      sourceEventId: eventRow.id,
    },
  });
}

export const billingWebhooks = {
  ingestBillingWebhook,
  processStoredEvent,
  billingSignatureKey,
  BILLING_EVENT,
  SUBSCRIPTION_STATUS,
};
