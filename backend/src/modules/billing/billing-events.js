/**
 * The webhook state machine — the PURE half. No IO, no Prisma, no clock.
 *
 * Everything here is a function of (subscription row, event envelope, now). The
 * service in ./billing-webhooks.service.js does the reading and writing; this
 * file decides WHAT should happen, so the decisions can be tested exhaustively
 * without a database and without Authorize.Net.
 *
 * THE ONE FACT THIS FILE IS BUILT AROUND
 * ---------------------------------------------------------------------------
 * With Authorize.Net's "Automatic Retry" enabled, a declined ARB payment
 * SUSPENDS the subscription; Authorize.Net then retries nightly, but ONLY after
 * the payment method has been updated, and the subscription stays suspended
 * indefinitely until it is reactivated or cancelled. There is NO fixed retry
 * count and no "attempt 2 of 4". Without Automatic Retry, a decline TERMINATES
 * the subscription at the next cycle instead.
 *
 * Consequences, and they shape every rule below:
 *   - `subscription.suspended` is the PRIMARY decline signal. Not a payment
 *     webhook, which may never arrive for a decline at all (§2.3 flags that as
 *     INFERRED, which is why there are three detectors and only one of them is
 *     a webhook).
 *   - We must never model dunning as "attempt N of M". `failedAttempts` here is
 *     a COUNT OF SIGNALS WE SAW, not a countdown Authorize.Net is running. Any
 *     UI that renders it as "3 of 4 tries left" would be inventing a number.
 *   - A suspension does not expire on its own. Time passing changes nothing;
 *     only a new card does. So the escalation clock is OURS (`pastDueSince`),
 *     and it is Phase 5 that reads it.
 *
 * ARB "suspended" IS OUR `PAST_DUE`, NOT OUR `SUSPENDED`. The words collide and
 * the meanings do not: ARB suspended = "the money stopped"; our SUSPENDED =
 * "we cut their access". Mapping ARB suspended straight onto our SUSPENDED
 * would cut a paying customer off the instant one card expired, with no grace
 * window and no human in the loop. Design §2.3 makes this mapping explicit;
 * ARB_STATUS_TO_SUBSCRIPTION below is the single place it is written down.
 */
import { SUBSCRIPTION_STATUS, CHARGE_KIND, CHARGE_STATUS } from './billing.service.js';
import { addInterval, addCalendarDays, todayCalendarDate } from './billing-dates.js';

// ───────────────────────────────────────────────────────────────────────────
// Event vocabulary
// ───────────────────────────────────────────────────────────────────────────

export const BILLING_EVENT = Object.freeze({
  SUB_CREATED: 'net.authorize.customer.subscription.created',
  SUB_UPDATED: 'net.authorize.customer.subscription.updated',
  SUB_SUSPENDED: 'net.authorize.customer.subscription.suspended',
  SUB_TERMINATED: 'net.authorize.customer.subscription.terminated',
  SUB_CANCELLED: 'net.authorize.customer.subscription.cancelled',
  SUB_EXPIRING: 'net.authorize.customer.subscription.expiring',
  SUB_EXPIRED: 'net.authorize.customer.subscription.expired',

  PAYMENT_AUTHCAPTURE: 'net.authorize.payment.authcapture.created',
  PAYMENT_CAPTURE: 'net.authorize.payment.capture.created',
  PAYMENT_PRIOR_AUTHCAPTURE: 'net.authorize.payment.priorAuthCapture.created',
  PAYMENT_REFUND: 'net.authorize.payment.refund.created',
  PAYMENT_VOID: 'net.authorize.payment.void.created',
  PAYMENT_FRAUD_HELD: 'net.authorize.payment.fraud.held',
  PAYMENT_FRAUD_APPROVED: 'net.authorize.payment.fraud.approved',
  PAYMENT_FRAUD_DECLINED: 'net.authorize.payment.fraud.declined',

  PROFILE_UPDATED: 'net.authorize.customer.paymentProfile.updated',
  PROFILE_DELETED: 'net.authorize.customer.paymentProfile.deleted',

  /**
   * SYNTHETIC — written by the reconciler, never received. It lands in the same
   * ledger as real events so a drift correction is visible in the panel next to
   * the webhooks it was compensating for, rather than only in a log line
   * somebody would have to know to go looking for.
   */
  RECONCILE_STATUS_DRIFT: 'reconcile.status-drift',
  RECONCILE_MISSING_CHARGE: 'reconcile.missing-charge',
  RECONCILE_NO_CHARGE_OBSERVED: 'reconcile.no-charge-observed',
  // Phase 6: a scheduled plan/amount change reached its boundary and the sweep
  // applied it. The notificationId is deterministic on the EFFECTIVE DATE, so
  // two workers — or two days — cannot record one apply twice.
  RECONCILE_PLAN_CHANGE_APPLIED: 'reconcile.plan-change-applied',
});

/**
 * THE EXACT LIST TO SUBSCRIBE IN THE AUTHORIZE.NET MERCHANT PORTAL, against
 * RIDE'S BILLING ACCOUNT (not a tenant's rental account).
 *
 * Order is portal order, not importance. Every VERIFIED event is persisted
 * whether or not it appears here — an unhandled type must be discoverable in
 * the event ledger rather than dropped — so subscribing to more than this is
 * harmless. Subscribing to LESS is not: dropping `.suspended` removes
 * detector 1 entirely and leaves only the daily reconciler.
 */
export const PORTAL_SUBSCRIBE_EVENTS = Object.freeze([
  BILLING_EVENT.SUB_CREATED,
  BILLING_EVENT.SUB_UPDATED,
  BILLING_EVENT.SUB_SUSPENDED,
  BILLING_EVENT.SUB_TERMINATED,
  BILLING_EVENT.SUB_CANCELLED,
  BILLING_EVENT.SUB_EXPIRING,
  BILLING_EVENT.SUB_EXPIRED,
  BILLING_EVENT.PAYMENT_AUTHCAPTURE,
  BILLING_EVENT.PAYMENT_REFUND,
  BILLING_EVENT.PAYMENT_VOID,
  BILLING_EVENT.PAYMENT_FRAUD_HELD,
  BILLING_EVENT.PAYMENT_FRAUD_APPROVED,
  BILLING_EVENT.PAYMENT_FRAUD_DECLINED,
  BILLING_EVENT.PROFILE_UPDATED,
  BILLING_EVENT.PROFILE_DELETED,
]);

/**
 * Events that may move `TenantSubscription.status`.
 *
 * This set is the ORDERING WATERMARK's domain: only these events raise the
 * "newest state decision so far" mark, and only these are suppressed when they
 * turn out to be late. An informational event like `.expiring` must not raise
 * the watermark, or a stale informational message would start blocking real
 * state changes that legitimately arrive after it.
 */
export const STATE_AFFECTING_EVENTS = new Set([
  BILLING_EVENT.SUB_CREATED,
  BILLING_EVENT.SUB_SUSPENDED,
  BILLING_EVENT.SUB_TERMINATED,
  BILLING_EVENT.SUB_CANCELLED,
  BILLING_EVENT.SUB_EXPIRED,
  BILLING_EVENT.PAYMENT_AUTHCAPTURE,
  BILLING_EVENT.PAYMENT_CAPTURE,
  BILLING_EVENT.PAYMENT_PRIOR_AUTHCAPTURE,
  BILLING_EVENT.PAYMENT_FRAUD_APPROVED,
  BILLING_EVENT.PAYMENT_FRAUD_DECLINED,
  BILLING_EVENT.RECONCILE_STATUS_DRIFT,
]);

const PAYMENT_EVENTS = new Set([
  BILLING_EVENT.PAYMENT_AUTHCAPTURE,
  BILLING_EVENT.PAYMENT_CAPTURE,
  BILLING_EVENT.PAYMENT_PRIOR_AUTHCAPTURE,
  BILLING_EVENT.PAYMENT_REFUND,
  BILLING_EVENT.PAYMENT_VOID,
  BILLING_EVENT.PAYMENT_FRAUD_HELD,
  BILLING_EVENT.PAYMENT_FRAUD_APPROVED,
  BILLING_EVENT.PAYMENT_FRAUD_DECLINED,
]);

export function isPaymentEvent(eventType) {
  return PAYMENT_EVENTS.has(String(eventType));
}

/**
 * ARB's vocabulary → ours. THE ONLY PLACE THIS MAPPING EXISTS.
 *
 * `suspended → PAST_DUE` is the load-bearing line; see the header. `canceled`
 * (ARB's one-L spelling) and `terminated` both land on CANCELLED because from
 * our side the distinction is only WHY it stopped, which `cancelReason` records.
 */
export const ARB_STATUS_TO_SUBSCRIPTION = Object.freeze({
  active: SUBSCRIPTION_STATUS.ACTIVE,
  suspended: SUBSCRIPTION_STATUS.PAST_DUE,
  canceled: SUBSCRIPTION_STATUS.CANCELLED,
  cancelled: SUBSCRIPTION_STATUS.CANCELLED, // tolerate the two-L spelling
  terminated: SUBSCRIPTION_STATUS.CANCELLED,
  expired: SUBSCRIPTION_STATUS.EXPIRED,
});

/** Statuses from which nothing may move. A terminal row is history. */
export const TERMINAL_STATUSES = new Set([
  SUBSCRIPTION_STATUS.CANCELLED,
  SUBSCRIPTION_STATUS.SUPERSEDED,
  SUBSCRIPTION_STATUS.EXPIRED,
]);

// ───────────────────────────────────────────────────────────────────────────
// Envelope parsing
// ───────────────────────────────────────────────────────────────────────────

/**
 * Pull the handful of fields we index on out of an Authorize.Net envelope.
 *
 * Defensive about shape on purpose: this runs on bytes from the public
 * internet, and a `payload.id` that is an object rather than a string must
 * produce a rejected event, not a crashed worker or a row keyed by
 * "[object Object]".
 */
export function parseEventEnvelope(json) {
  const notificationId = scalar(json?.notificationId);
  const eventType = scalar(json?.eventType);
  const payload = (json && typeof json.payload === 'object' && !Array.isArray(json.payload))
    ? json.payload
    : {};

  // For subscription.* the payload id IS the ARB subscription id. For payment.*
  // it is the transaction id, and the subscription reference — when there is
  // one at all — hides in one of several places depending on the event.
  const entityName = String(scalar(payload.entityName) || '').toLowerCase();
  const payloadId = scalar(payload.id) || scalar(payload.entityId);

  const subscriptionRef = entityName === 'subscription'
    ? payloadId
    : scalar(payload.subscription?.id)
      || scalar(payload.subscriptionId)
      || scalar(payload.subscription);

  const transId = entityName === 'transaction' || isPaymentEvent(eventType)
    ? payloadId
    : scalar(payload.transId);

  return {
    notificationId,
    eventType,
    // Authorize.Net sends .NET-style timestamps with 7 fractional digits.
    // Date handles them; an unparseable one becomes null rather than Invalid
    // Date, which would poison every ordering comparison downstream.
    eventDate: parseEventDate(json?.eventDate),
    arbSubscriptionId: subscriptionRef || null,
    transId: transId || null,
    payload,
  };
}

function scalar(value) {
  if (value == null) return null;
  if (typeof value === 'string') return value.trim() || null;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return null; // objects and arrays are never an id
}

export function parseEventDate(value) {
  if (!value) return null;
  const d = new Date(String(value));
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Authorize.Net's transaction response codes.
 * 1 approved · 2 declined · 3 error · 4 held for review.
 *
 * A DECLINE IS NOT AN ERROR. Collapsing 2 into 3 loses the only distinction
 * that matters: 2 means the card said no (a dunning event), 3 means the request
 * was malformed (our bug). And 4 means THE MONEY IS NOT OURS YET — treating a
 * held transaction as settled would clear a PAST_DUE flag on money that may
 * still be reversed.
 */
export const RESPONSE_CODE = Object.freeze({
  APPROVED: 1, DECLINED: 2, ERROR: 3, HELD: 4,
});

/**
 * Did this payment event describe money that actually moved?
 *
 * Returns `true` | `false` | `null`, and NULL IS A REAL ANSWER: the payment
 * webhook payload does not always carry a response code, and guessing
 * "approved" from silence is how a declined charge gets filed as revenue.
 * Callers must branch on all three.
 */
export function paymentOutcome(eventType, payload = {}) {
  if (eventType === BILLING_EVENT.PAYMENT_FRAUD_DECLINED) return false;
  if (eventType === BILLING_EVENT.PAYMENT_FRAUD_HELD) return null; // not ours yet
  const code = Number(payload?.responseCode ?? payload?.response?.code);
  if (!Number.isFinite(code)) return null;
  if (code === RESPONSE_CODE.APPROVED) return true;
  if (code === RESPONSE_CODE.DECLINED || code === RESPONSE_CODE.ERROR) return false;
  return null; // HELD, or a code Authorize.Net added after this was written
}

// ───────────────────────────────────────────────────────────────────────────
// PAN assertion
// ───────────────────────────────────────────────────────────────────────────

/**
 * Assert that a payload we are about to persist carries no card number.
 *
 * Authorize.Net does not send a PAN in a webhook — it sends masked values like
 * "XXXX1111" — so this should never fire. It exists because "should never" is
 * not "cannot", and the cost of being wrong is the whole platform moving from
 * PCI SAQ C to SAQ D on the strength of one column. A cheap assertion at the
 * one place untrusted bytes become a durable row is the correct place to spend
 * that paranoia.
 *
 * Luhn is the filter that makes this usable: a bare 13-19 digit run matches
 * timestamps, ids and amounts constantly, and an assertion that cries wolf gets
 * switched off. Requiring a valid check digit AND a known issuer prefix keeps
 * the false-positive rate low enough that a hit is worth waking up for.
 *
 * @returns {{clean:boolean, reason:string|null}}
 */
export function assertNoPan(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  if (!text) return { clean: true, reason: null };

  // Digit runs, tolerating spaces and dashes the way a real card number is written.
  for (const match of text.matchAll(/(?:\d[ -]?){12,22}\d/g)) {
    const digits = match[0].replace(/[^0-9]/g, '');
    if (digits.length < 13 || digits.length > 19) continue;
    if (!looksLikeIssuerPrefix(digits)) continue;
    if (!luhnValid(digits)) continue;
    return {
      clean: false,
      // The reason NEVER quotes the value it found. Reporting a suspected PAN by
      // printing it into a log or an alert would create the exact exposure the
      // check exists to prevent.
      reason: `possible PAN: ${digits.length} digits, Luhn-valid, issuer prefix ${digits.slice(0, 1)}x`,
    };
  }
  return { clean: true, reason: null };
}

function looksLikeIssuerPrefix(digits) {
  const two = Number(digits.slice(0, 2));
  const four = Number(digits.slice(0, 4));
  if (digits[0] === '4' && (digits.length === 13 || digits.length === 16 || digits.length === 19)) return true; // Visa
  if (two >= 51 && two <= 55 && digits.length === 16) return true; // Mastercard
  if (four >= 2221 && four <= 2720 && digits.length === 16) return true; // Mastercard 2-series
  if ((two === 34 || two === 37) && digits.length === 15) return true; // Amex
  if ((digits.startsWith('6011') || two === 65) && digits.length === 16) return true; // Discover
  return false;
}

function luhnValid(digits) {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let d = digits.charCodeAt(i) - 48;
    if (double) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

// ───────────────────────────────────────────────────────────────────────────
// The transition planner
// ───────────────────────────────────────────────────────────────────────────

/**
 * Decide what ONE verified event should do to ONE subscription.
 *
 * Pure. Returns a plan; the caller writes it. The split matters because it lets
 * the ordering guard be applied to exactly half of the plan:
 *
 *   subscriptionPatch — the STATE change. Suppressed when the event is late.
 *   charge            — the LEDGER row. Applied even when the event is late.
 *
 * WHY THE LEDGER IGNORES ORDERING. Money that moved, moved. A settled charge
 * that arrives out of order is still a real transaction and still belongs in
 * the ledger; only the CONCLUSION we draw from it ("therefore they are current")
 * can be wrong once a later event has already spoken. Suppressing the row too
 * would lose revenue history to a network hiccup — and the row is uniquely
 * keyed on transId, so writing it twice is impossible anyway.
 *
 * @param {object|null} subscription  our row, or null when unresolved
 * @param {object} event              a parsed envelope (see parseEventEnvelope)
 * @param {Date} now
 */
export function planEventEffect(subscription, event, now = new Date()) {
  const eventType = String(event?.eventType || '');
  const payload = event?.payload || {};

  if (!subscription) {
    // An event for a subscription we do not know about is a real problem, not
    // noise: either a subscription exists at Authorize.Net that we never
    // recorded, or somebody is probing the endpoint with a valid signature —
    // and only one of those is survivable in silence.
    return effect({
      note: 'unlinked: no TenantSubscription matches this event',
      alert: isPaymentEvent(eventType) || eventType.startsWith('net.authorize.customer.subscription')
        ? alert('warn', 'BILLING_EVENT_UNLINKED', 'Verified billing webhook for an unknown subscription.')
        : null,
    });
  }

  if (TERMINAL_STATUSES.has(subscription.status) && eventType !== BILLING_EVENT.PAYMENT_REFUND) {
    // A terminal row is history. The one exception is a refund, which can
    // legitimately land after a cancellation and must still reach the ledger.
    return effect({ note: `no-op: subscription is terminal (${subscription.status})` });
  }

  switch (eventType) {
    case BILLING_EVENT.SUB_CREATED:
      return planCreated(subscription);
    case BILLING_EVENT.SUB_UPDATED:
      return planUpdated(subscription);
    case BILLING_EVENT.SUB_SUSPENDED:
      return planSuspended(subscription, now);
    case BILLING_EVENT.SUB_TERMINATED:
      return planStopped(subscription, now, 'ARB_TERMINATED',
        alert('error', 'BILLING_SUB_TERMINATED',
          'Authorize.Net TERMINATED a subscription we did not cancel.'));
    case BILLING_EVENT.SUB_CANCELLED:
      return planStopped(subscription, now, 'ARB_CANCELLED',
        subscription.cancelRequestedByUserId
          ? null
          : alert('error', 'BILLING_SUB_CANCELLED_UNREQUESTED',
            'A subscription was cancelled at Authorize.Net without a request from us.'));
    case BILLING_EVENT.SUB_EXPIRED:
      return planExpired(subscription, now);
    case BILLING_EVENT.SUB_EXPIRING:
      // Informational by design. It is surfaced in the panel and nothing else;
      // we create with totalOccurrences 9999, so this firing at all is odd
      // enough to be worth seeing but not worth acting on automatically.
      return effect({ note: 'informational: ARB reports the subscription is expiring' });
    case BILLING_EVENT.PROFILE_UPDATED:
      return effect({
        note: 'payment profile changed at Authorize.Net — verify the subscription still points at a live method',
        alert: alert('warn', 'BILLING_PROFILE_UPDATED',
          'A billing payment profile changed. If a NEW method was added the subscription must be repointed.'),
      });
    case BILLING_EVENT.PROFILE_DELETED:
      return effect({
        note: 'payment profile DELETED at Authorize.Net',
        alert: alert('error', 'BILLING_PROFILE_DELETED',
          'A billing payment profile was deleted. This subscription is about to start failing.'),
      });
    default:
      if (isPaymentEvent(eventType)) return planPayment(subscription, event, now);
      // Stored, visible in the panel, and explicitly not acted on. An event type
      // we have never seen must not be able to move money or state.
      return effect({ note: `unhandled event type (stored for review): ${eventType || 'unknown'}` });
  }
}

/**
 * `.created` confirms an ARB subscription exists. It is the event most likely to
 * arrive LATE and out of order — Authorize.Net emits it at creation, and our own
 * return leg has usually already recorded the same fact synchronously.
 *
 * So it deliberately transitions from PENDING_AUTHORIZATION and NOTHING ELSE.
 * That is belt to the ordering watermark's braces: even if the watermark were
 * bypassed, a `.created` replayed against a PAST_DUE or SUSPENDED row cannot
 * revive it, because ACTIVE is simply not reachable from those states here.
 */
function planCreated(subscription) {
  if (subscription.status !== SUBSCRIPTION_STATUS.PENDING_AUTHORIZATION) {
    return effect({ note: `no-op: already past enrollment (${subscription.status})` });
  }
  // Phase 3 owns activation, which needs the card facts this event does not
  // carry. Recording the confirmation is all that is safe here.
  return effect({ note: 'ARB confirms the subscription exists; activation is the return leg\'s job' });
}

function planUpdated(subscription) {
  // The event says "something changed" and not what. Adopting a change we
  // cannot see would be inventing one, so this defers to the daily poll, which
  // reads the real values from ARB.
  return effect({
    note: 'ARB reports the subscription changed; the next reconcile pass reads the authoritative values',
    reconcileSoon: true,
    subscriptionPatch: { lastReconciledAt: null },
    _statusUnchanged: subscription.status,
  });
}

/**
 * DETECTOR 1 — the fast path, and the primary decline signal.
 *
 * ARB suspended the subscription, which with Automatic Retry on means a payment
 * was declined. It will retry nightly, but only once the card is replaced, and
 * it will stay suspended forever until someone acts. So this sets PAST_DUE and
 * starts OUR clock; nothing about ARB's behaviour will move it back on its own.
 */
function planSuspended(subscription, now) {
  // Our SUSPENDED is a stronger state than PAST_DUE (access already cut).
  // Never walk it backwards on a repeat signal.
  if (subscription.status === SUBSCRIPTION_STATUS.SUSPENDED) {
    return effect({
      note: 'already SUSPENDED; recording the repeat ARB suspension without downgrading',
      subscriptionPatch: {
        failedAttempts: { increment: 1 },
        lastFailureAt: now,
        lastFailureCode: 'ARB_SUSPENDED',
        arbStatusSnapshot: 'suspended',
      },
    });
  }

  return effect({
    status: SUBSCRIPTION_STATUS.PAST_DUE,
    subscriptionPatch: {
      status: SUBSCRIPTION_STATUS.PAST_DUE,
      // `pastDueSince` is set ONCE and only cleared by a settled charge. A
      // second suspension must not restart the grace window — that would make
      // an account that keeps failing look newer than one that failed once.
      ...(subscription.pastDueSince ? {} : { pastDueSince: now }),
      failedAttempts: { increment: 1 },
      lastFailureAt: now,
      // A CODE, not Authorize.Net's prose. Provider message text is where an
      // echoed value would ride into our database.
      lastFailureCode: 'ARB_SUSPENDED',
      lastFailureText: null,
      arbStatusSnapshot: 'suspended',
    },
    note: 'ARB suspended the subscription — a payment was declined (detector 1)',
    alert: alert('warn', 'BILLING_PAST_DUE',
      'A tenant subscription is PAST DUE: Authorize.Net suspended it after a declined payment.'),
    notify: 'PAST_DUE',
  });
}

function planStopped(subscription, now, cancelReason, alertRow) {
  return effect({
    status: SUBSCRIPTION_STATUS.CANCELLED,
    subscriptionPatch: {
      status: SUBSCRIPTION_STATUS.CANCELLED,
      cancelledAt: subscription.cancelledAt || now,
      cancelReason: subscription.cancelReason || cancelReason,
      arbStatusSnapshot: cancelReason === 'ARB_TERMINATED' ? 'terminated' : 'canceled',
      // The recurring charge is gone, so there is no next one. Leaving a stale
      // date here would keep feeding the silence detector a charge to look for
      // that can never happen.
      nextChargeDate: null,
    },
    note: `subscription stopped at Authorize.Net (${cancelReason})`,
    alert: alertRow,
    notify: 'CANCELLED',
  });
}

function planExpired(subscription, now) {
  return effect({
    status: SUBSCRIPTION_STATUS.EXPIRED,
    subscriptionPatch: {
      status: SUBSCRIPTION_STATUS.EXPIRED,
      cancelledAt: subscription.cancelledAt || now,
      cancelReason: subscription.cancelReason || 'ARB_EXPIRED',
      arbStatusSnapshot: 'expired',
      nextChargeDate: null,
    },
    note: 'ARB reports the subscription ran out of occurrences',
    alert: alert('error', 'BILLING_SUB_EXPIRED',
      'A subscription EXPIRED at Authorize.Net. We create with totalOccurrences 9999, so this should be impossible.'),
    notify: 'CANCELLED',
  });
}

/**
 * The money events.
 *
 * DETECTOR 2 lives in the `outcome === false` branch: a payment event that
 * reports a decline. It is written as a real detector even though §2.3 records
 * that ARB may never send one — because "may never" is a belief about a third
 * party, and if the belief is wrong this is the fastest signal we get. If the
 * belief is right, this branch simply never runs and detectors 1 and 3 carry
 * the load. Cheap insurance against being wrong about someone else's system.
 */
function planPayment(subscription, event, now) {
  const eventType = event.eventType;
  const payload = event.payload || {};
  const transId = event.transId;
  const amount = numberOrNull(payload.authAmount ?? payload.amount);
  const outcome = paymentOutcome(eventType, payload);

  if (eventType === BILLING_EVENT.PAYMENT_REFUND) {
    return effect({
      note: 'refund recorded against the subscription',
      charge: {
        transId,
        kind: CHARGE_KIND.REFUND,
        status: CHARGE_STATUS.REFUNDED,
        // A refund reduces what we kept. Stored as a NEGATIVE amount so summing
        // the ledger gives net revenue without every reader having to know the
        // sign convention for each kind.
        amount: amount == null ? null : -Math.abs(amount),
        settledAt: now,
        description: 'Reembolso registrado desde Authorize.Net sobre la suscripción de Ride Fleet Manager.',
      },
      alert: alert('warn', 'BILLING_REFUND_OBSERVED',
        'A refund was issued on a tenant subscription. Confirm it was intentional.'),
    });
  }

  if (eventType === BILLING_EVENT.PAYMENT_VOID) {
    return effect({
      note: 'charge voided at Authorize.Net',
      charge: {
        transId,
        kind: CHARGE_KIND.RECURRING,
        status: CHARGE_STATUS.VOIDED,
        amount,
        settledAt: null,
        description: 'Cargo anulado (void) en Authorize.Net antes de liquidarse.',
      },
    });
  }

  if (eventType === BILLING_EVENT.PAYMENT_FRAUD_HELD || outcome === null) {
    // HELD, or an outcome the payload did not state. THE MONEY IS NOT OURS YET.
    // Filing this as SETTLED would clear a PAST_DUE on funds that can still be
    // reversed — the ledger would say paid and the bank would disagree.
    return effect({
      note: eventType === BILLING_EVENT.PAYMENT_FRAUD_HELD
        ? 'transaction HELD for review — not settled, state unchanged'
        : 'payment event carried no response code — recorded PENDING, state unchanged',
      charge: {
        transId,
        kind: CHARGE_KIND.RECURRING,
        status: CHARGE_STATUS.PENDING,
        amount,
        settledAt: null,
        description: 'Cargo recibido de Authorize.Net pendiente de confirmación de liquidación.',
      },
      alert: eventType === BILLING_EVENT.PAYMENT_FRAUD_HELD
        ? alert('warn', 'BILLING_PAYMENT_HELD', 'A subscription payment is held for fraud review.')
        : null,
    });
  }

  if (outcome === false) {
    // DETECTOR 2. Same destination as detector 1, reached from the other side.
    const alreadyStrongerThanPastDue = subscription.status === SUBSCRIPTION_STATUS.SUSPENDED;
    return effect({
      status: alreadyStrongerThanPastDue ? undefined : SUBSCRIPTION_STATUS.PAST_DUE,
      subscriptionPatch: {
        ...(alreadyStrongerThanPastDue ? {} : { status: SUBSCRIPTION_STATUS.PAST_DUE }),
        ...(subscription.pastDueSince ? {} : { pastDueSince: now }),
        failedAttempts: { increment: 1 },
        lastFailureAt: now,
        lastFailureCode: declineCode(payload),
        lastFailureText: null,
      },
      charge: {
        transId,
        kind: CHARGE_KIND.RECURRING,
        status: CHARGE_STATUS.DECLINED,
        amount,
        settledAt: null,
        responseCode: String(payload?.responseCode ?? payload?.response?.code ?? ''),
        description: 'Cobro rechazado por el emisor de la tarjeta. La suscripción queda en mora.',
      },
      note: 'payment event reports a decline (detector 2)',
      alert: alert('warn', 'BILLING_PAST_DUE',
        'A tenant subscription is PAST DUE: a subscription payment was declined.'),
      notify: alreadyStrongerThanPastDue ? null : 'PAST_DUE',
    });
  }

  // outcome === true: money moved.
  const period = rollPeriod(subscription, now);
  const wasBehind = subscription.status === SUBSCRIPTION_STATUS.PAST_DUE
    || subscription.status === SUBSCRIPTION_STATUS.SUSPENDED;

  return effect({
    status: SUBSCRIPTION_STATUS.ACTIVE,
    subscriptionPatch: {
      status: SUBSCRIPTION_STATUS.ACTIVE,
      ...period,
      // Cleared TOGETHER. A row that is ACTIVE but still carries pastDueSince
      // reads as "currently late" to every query written later.
      pastDueSince: null,
      failedAttempts: 0,
      lastFailureCode: null,
      lastFailureText: null,
      arbStatusSnapshot: 'active',
      // Phase 5 reads suspendedAt to decide whether access must be restored.
      // Clearing it here is what makes a settled charge the thing that lets a
      // customer back in.
      ...(subscription.suspendedAt ? { suspendedAt: null } : {}),
    },
    charge: {
      transId,
      kind: subscription.status === SUBSCRIPTION_STATUS.TRIALING ? CHARGE_KIND.TRIAL : CHARGE_KIND.RECURRING,
      status: CHARGE_STATUS.SETTLED,
      amount,
      settledAt: now,
      authCode: scalar(payload.authCode),
      responseCode: String(payload?.responseCode ?? payload?.response?.code ?? ''),
      description: null, // filled by the service, which has the plan snapshot
      periodStart: period.currentPeriodStart,
      periodEnd: period.currentPeriodEnd,
    },
    note: wasBehind
      ? 'settled payment cleared the outstanding period — back to ACTIVE'
      : 'settled recurring payment',
    notify: wasBehind ? 'RECOVERED' : null,
  });
}

function declineCode(payload) {
  const reason = payload?.responseReasonCode ?? payload?.response?.reasonCode;
  // Authorize.Net's numeric reason code is a stable identifier and carries no
  // free text. That is exactly what we want in a persisted failure field.
  return reason == null || reason === '' ? 'PAYMENT_DECLINED' : `AUTHNET_${String(reason)}`;
}

/**
 * Advance the billing period after a settled charge.
 *
 * Anchored on `nextChargeDate` when we have one — that is the date ARB was
 * charging for — and only falls back to today when we do not. Anchoring on
 * today would drift the cycle by however long the webhook took to arrive, so a
 * subscription billed on the 1st would slowly slide down the month.
 */
export function rollPeriod(subscription, now) {
  const anchor = subscription.nextChargeDate || todayCalendarDate(now);
  const nextCharge = addInterval(anchor, subscription.intervalUnit, subscription.intervalLength);
  return {
    currentPeriodStart: anchor,
    // The period ENDS the day before the next charge: a monthly cycle starting
    // the 1st covers the 1st to the 30th, not the 1st to the 1st. An off-by-one
    // here is a customer being told they paid for a day they did not.
    currentPeriodEnd: addCalendarDays(nextCharge, -1),
    nextChargeDate: nextCharge,
  };
}

function numberOrNull(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function alert(level, code, message) {
  return { level, code, message };
}

function effect(fields = {}) {
  return {
    status: fields.status,
    subscriptionPatch: fields.subscriptionPatch || null,
    charge: fields.charge || null,
    alert: fields.alert || null,
    /** PAST_DUE | SUSPENDED | CANCELLED | RECOVERED | null — drives the mailer. */
    notify: fields.notify || null,
    note: fields.note || '',
    reconcileSoon: !!fields.reconcileSoon,
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Ordering
// ───────────────────────────────────────────────────────────────────────────

/**
 * Is this event LATE — i.e. has a newer state decision already been applied?
 *
 * Webhooks arrive out of order. The case that matters is a delayed `.created`
 * landing after a `.suspended`: replaying "the subscription exists" over "the
 * card was declined" would silently un-suspend a delinquent account, and
 * nothing downstream would ever question it.
 *
 * The watermark is the newest `eventDate` among STATE-AFFECTING events already
 * PROCESSED for this subscription. Deriving it from the event ledger rather
 * than from a column on the subscription means it cannot disagree with the
 * events themselves, and it needed no schema change.
 *
 * FAIL-SAFE ON A MISSING DATE: an event with no parseable `eventDate` is never
 * treated as late (we cannot order it, so we apply it and let the guarded
 * transitions catch nonsense) but also never RAISES the watermark (an undated
 * event must not start blocking dated ones).
 */
export function isLateEvent(event, watermark) {
  if (!watermark) return false;
  if (!event?.eventDate) return false;
  return event.eventDate.getTime() < new Date(watermark).getTime();
}

export function raisesWatermark(event) {
  return !!event?.eventDate && STATE_AFFECTING_EVENTS.has(String(event?.eventType || ''));
}

export const billingEvents = {
  BILLING_EVENT,
  PORTAL_SUBSCRIBE_EVENTS,
  STATE_AFFECTING_EVENTS,
  ARB_STATUS_TO_SUBSCRIPTION,
  TERMINAL_STATUSES,
  parseEventEnvelope,
  parseEventDate,
  paymentOutcome,
  assertNoPan,
  planEventEffect,
  isLateEvent,
  raisesWatermark,
  rollPeriod,
  isPaymentEvent,
};
