/**
 * Authorize.Net — Hosted Customer Profile (CIM) + Automated Recurring Billing (ARB).
 *
 * This is RIDE'S OWN billing: charging a tenant for their Ride Fleet Manager
 * subscription. It is NOT the per-tenant rental gateway in
 * backend/src/modules/public-booking/authnet-accept-hosted.js — that one bills a renter
 * on the TENANT's merchant account. Two different merchants, two different directions of
 * money, two different credential sets.
 *
 * Hence BILLING_AUTHNET_* here versus AUTHNET_* there. Mixing them up would deposit our
 * subscription revenue into the tenant's account, so the names are deliberately unalike.
 * Every credential read in this file is BILLING_AUTHNET_*; if you ever find yourself
 * typing AUTHNET_* in this module you are in the wrong file.
 *
 * The card is typed by the customer ON Authorize.Net's servers. Nothing in this file ever
 * receives a PAN — that is what keeps our PCI scope where it is (SAQ C; a PAN in one of
 * our tables moves the whole platform to SAQ D). Do not add a code path that accepts a raw
 * card number.
 *
 * PORTED FROM THE FRONTEND (2026-08-27, billing Phase 1). It lived at
 * frontend/src/lib/authorize-net.js on feat/autopay-groundwork, where it had been proven
 * end to end against the production Authorize.Net account. It could not stay there: the
 * Next app has no Prisma client and no database access at all, which is the actual reason
 * the invite store ended up in memory. Behaviour is preserved byte-for-byte except for the
 * three changes called out below (env fail-closed, TEST_VALIDATION removed, withTimeout).
 *
 * BACKEND-ONLY. This module reads the transaction key from the environment; it must never
 * be imported from anything that is bundled for a browser.
 */
import logger from '../../lib/logger.js';
import { withTimeout } from '../../lib/with-timeout.js';

const API_ENDPOINT = {
  production: 'https://api.authorize.net/xml/v1/request.api',
  sandbox: 'https://apitest.authorize.net/xml/v1/request.api',
};

/**
 * Where the customer's browser is POSTed with the hosted-page token.
 *
 *  addPayment — first enrollment: adds a method to an empty profile.
 *  manage     — returning customer: lets them replace or delete the method on file.
 *
 * They are different endpoints, not a flag, so the caller has to say which one it wants.
 */
const HOSTED_BASE = {
  production: 'https://accept.authorize.net/customer',
  sandbox: 'https://test.authorize.net/customer',
};

/**
 * No network call on a request path may be unbounded (lib/with-timeout.js, 2026-08-08
 * incident). Authorize.Net is a third party on the far side of the internet and has no
 * business holding a worker open forever.
 *
 * NOTE THE DIFFERENCE FROM THE RATE LIMITER: withTimeout's own doc says infrastructure
 * that merely accelerates work must fail OPEN. This is the opposite case. A timeout here
 * means we DO NOT KNOW whether the call took effect — never "it failed". Callers must
 * treat a timeout as an unknown state and resolve it by asking Authorize.Net what
 * happened, never by retrying blindly. That is how a customer gets charged twice.
 */
const CALL_TIMEOUT_MS = Number(process.env.BILLING_AUTHNET_TIMEOUT_MS || 20000);

/**
 * FAIL CLOSED (changed on the port, 2026-08-27).
 *
 * The frontend version returned 'sandbox' whenever BILLING_AUTHNET_ENV !== 'production'.
 * On the droplet a missing or misspelled variable therefore meant every enrollment quietly
 * went to the SANDBOX and nobody was ever billed — with no error anywhere, on any surface,
 * for as long as it took someone to audit revenue by hand. A misconfigured deploy must be
 * a loud startup-time failure, not silent free service.
 */
export function billingEnv() {
  const value = String(process.env.BILLING_AUTHNET_ENV || '').trim();
  if (value === 'production' || value === 'sandbox') return value;
  throw new Error(
    'BILLING_AUTHNET_ENV must be set to exactly "production" or "sandbox". '
    + 'Refusing to guess: guessing "sandbox" is how a tenant silently never gets billed.',
  );
}

export function hostedPageUrl(mode = 'enroll') {
  return `${HOSTED_BASE[billingEnv()]}/${mode === 'update' ? 'manage' : 'addPayment'}`;
}

/**
 * How Authorize.Net validates a card as it is added.
 *
 *   testMode — format checks only. NO transaction reaches the card networks.
 *   liveMode — a small authorization, immediately voided.
 *
 * REMOVED ON THE PORT (2026-08-27): BILLING_AUTHNET_TEST_VALIDATION, which forced testMode
 * even on a production gateway so the flow could be rehearsed on a live account without
 * moving money. It is on the design's pre-production checklist for a reason — left in, an
 * env var set once for a rehearsal and never unset means a dead card is only discovered on
 * the first billing run, weeks later, on a customer who thinks they are enrolled. The
 * rehearsal affordance belongs to a sandbox gateway (BILLING_AUTHNET_ENV=sandbox), which
 * cannot be confused with the real one.
 *
 * PHASE 3 RECONSIDERED AND KEPT THE REMOVAL. The first real enrollment is exactly the
 * moment the flag would have been reached for, so the argument was re-run with a live
 * customer in front of it and came out the same way: the rehearsal is a full end-to-end run
 * against BILLING_AUTHNET_ENV=sandbox with sandbox credentials, verified in the sandbox
 * portal, after which all three BILLING_AUTHNET_* values move to production together. One
 * source of truth for which gateway we are on, and no setting that can quietly outlive its
 * rehearsal. authorize-net.test.mjs pins the variable's absence; that test stays.
 */
function cardValidationMode() {
  return billingEnv() === 'production' ? 'liveMode' : 'testMode';
}

function auth() {
  const name = process.env.BILLING_AUTHNET_LOGIN_ID;
  const transactionKey = process.env.BILLING_AUTHNET_TRANSACTION_KEY;
  if (!name || !transactionKey) {
    throw new Error(
      'BILLING_AUTHNET_LOGIN_ID / BILLING_AUTHNET_TRANSACTION_KEY are not set.',
    );
  }
  return { name, transactionKey };
}

export class AuthorizeNetError extends Error {
  constructor(message, code, duplicateProfileId) {
    super(message);
    this.name = 'AuthorizeNetError';
    this.code = code;
    /** Authorize.Net buries the existing profile id inside E00039's message text. */
    this.duplicateProfileId = duplicateProfileId;
  }
}

/**
 * Low-level JSON call.
 *
 * Two Authorize.Net quirks are handled here, and both cost an afternoon if you meet them
 * cold:
 *  1. Responses carry a UTF-8 BOM that makes JSON.parse throw on a perfectly good body.
 *  2. HTTP is 200 even for application errors — the real status is messages.resultCode.
 *
 * Exported for tests ONLY (`_call`): the bug fixes above are the payload of this module
 * and each one is pinned by a test that drives a fake fetch through this function.
 */
export async function _call(requestName, body, deps = {}) {
  const doFetch = deps.fetch || fetch;
  const payload = { [requestName]: { merchantAuthentication: auth(), ...body } };

  const res = await withTimeout(
    doFetch(API_ENDPOINT[billingEnv()], {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      cache: 'no-store',
    }),
    deps.timeoutMs || CALL_TIMEOUT_MS,
    `authorize-net ${requestName}`,
  );

  if (!res.ok) {
    throw new AuthorizeNetError(`Authorize.Net HTTP ${res.status}`, 'HTTP_ERROR');
  }

  // The BOM strip is the whole point of reading text() instead of json(). Authorize.Net
  // prefixes its JSON with a UTF-8 BOM (U+FEFF); res.json() and a bare JSON.parse both
  // throw "Unexpected token" on a response that is otherwise perfectly well formed.
  const raw = (await res.text()).replace(/^﻿/, '').trim();
  let json;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new AuthorizeNetError('Authorize.Net returned a malformed response.', 'PARSE_ERROR');
  }

  // HTTP 200 is NOT success. Authorize.Net answers 200 for application errors too, and the
  // real status lives in messages.resultCode. Trusting res.ok alone reads a decline, a bad
  // credential and a duplicate profile as if they had all worked.
  const messages = json.messages;
  if (messages && messages.resultCode !== 'Ok') {
    const first = messages.message?.[0];
    const code = first?.code ?? 'UNKNOWN';
    const text = first?.text ?? 'Unknown Authorize.Net error.';
    // "A duplicate record with ID 123456789 already exists."
    const dup = code === 'E00039' ? /ID (\d+)/.exec(text)?.[1] : undefined;
    throw new AuthorizeNetError(text, code, dup);
  }

  return json;
}

/**
 * Create the customer profile, or hand back the one that already exists.
 *
 * Authorize.Net dedupes on (merchantCustomerId, description, email) and rejects an exact
 * repeat with E00039 rather than returning the original — so "ensure" means
 * create-then-recover-from-the-error.
 */
export async function ensureCustomerProfile({ merchantCustomerId, email, description }, deps = {}) {
  // Authorize.Net's schema caps merchantCustomerId at 20 chars and rejects the whole
  // request otherwise — a cuid or a prefixed id overflows this easily. Truncating keeps
  // the value stable for a given subscriber, which is what the dedupe key needs.
  // (AutopayInvite.merchantCustomerId is declared VARCHAR(20) so the cap is a schema fact
  // and not only a runtime hope — but the truncation stays here too, because this is the
  // function that talks to the API.)
  const customerId = String(merchantCustomerId).slice(0, 20);

  try {
    const res = await _call('createCustomerProfileRequest', {
      profile: {
        merchantCustomerId: customerId,
        // description maxes out at 255; email at 255.
        description: String(description).slice(0, 255),
        email: String(email).slice(0, 255),
      },
      validationMode: 'none',
    }, deps);
    return res.customerProfileId;
  } catch (e) {
    // E00039 idempotency: the profile already exists and Authorize.Net told us its id
    // inside the error text rather than returning it. Recovering it here is what makes
    // this function safe to call twice — a customer who reopens the enrollment link must
    // not create a second profile, or the subscription hangs off the wrong one.
    if (e instanceof AuthorizeNetError && e.duplicateProfileId) return e.duplicateProfileId;
    throw e;
  }
}

/**
 * Mint a hosted-page token so the customer can enter their card on Authorize.Net.
 *
 * This token dies in ~15 minutes, which is why it can never be the thing we email. Mint it
 * on the request that is about to redirect, not when the invitation is sent — and, since
 * the port, not on page render either: the enrollment page mints it BEHIND THE BUTTON, so
 * the clock starts when the customer is done reading rather than when they arrive.
 */
export async function getHostedProfilePageToken({
  customerProfileId,
  returnUrl,
  returnUrlText,
  mode = 'enroll',
}, deps = {}) {
  const settings = [
    { settingName: 'hostedProfileReturnUrl', settingValue: returnUrl },
    { settingName: 'hostedProfileReturnUrlText', settingValue: returnUrlText || 'Continuar' },
    { settingName: 'hostedProfilePageBorderVisible', settingValue: 'false' },
    // The only branding Authorize.Net's hosted profile page accepts. It takes no logo and
    // no custom copy, which is why the identity and the disclosure live on our interstitial.
    { settingName: 'hostedProfileHeadingBgColor', settingValue: '#8752FE' },
    { settingName: 'hostedProfileBillingAddressRequired', settingValue: 'true' },
    { settingName: 'hostedProfileCardCodeRequired', settingValue: 'true' },
    { settingName: 'hostedProfileValidationMode', settingValue: cardValidationMode() },
  ];

  // The manage page would otherwise also offer shipping addresses, which mean nothing for
  // a software subscription and just invite confusion.
  if (mode === 'update') {
    settings.push({ settingName: 'hostedProfileManageOptions', settingValue: 'showPayment' });
  }

  const res = await _call('getHostedProfilePageRequest', {
    customerProfileId,
    hostedProfileSettings: { setting: settings },
  }, deps);
  return res.token;
}

/**
 * Repoint a live subscription at a different stored method.
 *
 * Only needed when the customer ADDS a new method rather than editing the one on file:
 * an in-place edit keeps the same customerPaymentProfileId, so ARB follows it with no
 * action from us. Adding creates a new id, and the subscription would happily keep
 * charging the old — and eventually failing — card until it is moved.
 */
export async function updateSubscriptionPaymentMethod({
  subscriptionId,
  customerProfileId,
  customerPaymentProfileId,
}, deps = {}) {
  await _call('ARBUpdateSubscriptionRequest', {
    subscriptionId,
    subscription: { profile: { customerProfileId, customerPaymentProfileId } },
  }, deps);
}

/**
 * Read back what the customer saved. Required on the return leg: the hosted page redirects
 * the browser home but tells us nothing about what was stored.
 */
export async function getPaymentMethods(customerProfileId, deps = {}) {
  const res = await _call('getCustomerProfileRequest', {
    customerProfileId,
    unmaskExpirationDate: false,
    includeIssuerInfo: false,
  }, deps);

  return (res.profile?.paymentProfiles ?? []).map((p) => ({
    customerPaymentProfileId: p.customerPaymentProfileId,
    // Already masked by Authorize.Net ("XXXX1111") — safe to persist and show. We store
    // only the brand and the last four derived from it; the masked string itself is not
    // a PAN and is never kept in a column of its own.
    maskedNumber: p.payment?.creditCard?.cardNumber ?? p.payment?.bankAccount?.accountNumber ?? null,
    cardType: p.payment?.creditCard?.cardType ?? null,
    accountType: p.payment?.bankAccount?.accountType ?? null,
  }));
}

/** The most recently added method — what the customer just typed in. */
export async function getNewestPaymentMethod(customerProfileId, deps = {}) {
  const all = await getPaymentMethods(customerProfileId, deps);
  return all.length ? all[all.length - 1] : null;
}

/**
 * Start the recurring charge against the stored profile.
 * `startDate` is YYYY-MM-DD and cannot be in the past — Authorize.Net rejects it outright.
 * That is also why every billing date in this module's schema is VARCHAR(10) rather than a
 * DateTime: the value we send, the value we store and the value we render are the same
 * bytes, so no formatter can shift the day.
 */
export async function createSubscription({
  name,
  amount,
  startDate,
  intervalLength,
  intervalUnit,
  customerProfileId,
  customerPaymentProfileId,
  totalOccurrences,
  trialOccurrences = 0,
  trialAmount = null,
}, deps = {}) {
  const trials = Number(trialOccurrences || 0);
  // ARB is documented to accept trialAmount only alongside trialOccurrences, and whether
  // it accepts a ZERO trialAmount is unverified against a live account. Rather than let an
  // unverified assumption decide what a customer is charged, refuse the ambiguous shape:
  // a genuinely free trial is expressed as a DEFERRED startDate with trialOccurrences 0,
  // which is the path that has actually been exercised end to end.
  if (trials > 0 && (trialAmount == null || Number.isNaN(Number(trialAmount)))) {
    throw new Error(
      'createSubscription: trialOccurrences > 0 requires an explicit trialAmount. '
      + 'For a free trial use a deferred startDate with trialOccurrences = 0.',
    );
  }

  const paymentSchedule = {
    interval: { length: intervalLength, unit: intervalUnit },
    startDate,
    // 9999 is Authorize.Net's idiom for "until cancelled".
    totalOccurrences: totalOccurrences ?? 9999,
  };
  if (trials > 0) {
    paymentSchedule.trialOccurrences = trials;
  }

  const subscription = {
    name,
    paymentSchedule,
    amount: Number(Number(amount).toFixed(2)),
    profile: { customerProfileId, customerPaymentProfileId },
  };
  if (trials > 0) {
    subscription.trialAmount = Number(Number(trialAmount).toFixed(2));
  }

  const res = await _call('ARBCreateSubscriptionRequest', { subscription }, deps);
  return res.subscriptionId;
}

export async function cancelSubscription(subscriptionId, deps = {}) {
  await _call('ARBCancelSubscriptionRequest', { subscriptionId }, deps);
}

/**
 * ARB's OWN vocabulary for a subscription's state. Stored verbatim in
 * `arbStatusSnapshot` and mapped to ours at exactly one place (billing-events.js
 * ARB_STATUS_TO_SUBSCRIPTION), so nothing translates at call time and a value
 * Authorize.Net adds later shows up as an unmapped string we can see rather than
 * as a silent no-op.
 */
export const ARB_STATUS = Object.freeze({
  ACTIVE: 'active',
  EXPIRED: 'expired',
  SUSPENDED: 'suspended',
  CANCELED: 'canceled', // ARB spells it with one L. Do not "fix" it.
  TERMINATED: 'terminated',
});

/**
 * What Authorize.Net thinks this subscription's status is — DETECTOR 2.
 *
 * The cheapest authoritative answer to "is this still charging?", and the one
 * that does not depend on any webhook having arrived. ARB is the source of truth
 * about whether money moves; when it disagrees with us, it wins.
 *
 * Returns the raw lowercase string (see ARB_STATUS), or null when ARB answers
 * without one — a shape change we must notice rather than read as "fine".
 */
export async function getSubscriptionStatus(subscriptionId, deps = {}) {
  const res = await _call('ARBGetSubscriptionStatusRequest', { subscriptionId }, deps);
  const status = res?.status;
  return status ? String(status).trim().toLowerCase() : null;
}

/**
 * The full subscription, optionally with its transaction history — DETECTOR 3.
 *
 * `includeTransactions` is what lets the silence detector answer "did a charge
 * happen for the period that should have billed?" without a single webhook ever
 * having arrived. That is the whole reason this call exists: the endpoint can be
 * unreachable for a week and this still finds the truth.
 *
 * NOTE: ARB returns `arbTransactions` as an ARRAY when there are several and as
 * a BARE OBJECT when there is exactly one — the standard XML-to-JSON collapse.
 * Normalising here means no caller has to remember, and a one-transaction
 * subscription cannot read as zero.
 */
export async function getSubscription(subscriptionId, { includeTransactions = false } = {}, deps = {}) {
  const res = await _call('ARBGetSubscriptionRequest', {
    subscriptionId,
    includeTransactions: !!includeTransactions,
  }, deps);

  const sub = res?.subscription || {};
  const rawTx = sub.arbTransactions?.arbTransaction ?? sub.arbTransactions ?? [];
  const transactions = (Array.isArray(rawTx) ? rawTx : [rawTx]).filter(Boolean);

  return {
    name: sub.name ?? null,
    status: sub.status ? String(sub.status).trim().toLowerCase() : null,
    amount: sub.amount ?? null,
    paymentSchedule: sub.paymentSchedule ?? null,
    // Authorize.Net's count of payments already taken. The reconciler uses it to
    // spot "ARB has billed more times than we have charge rows".
    pastOccurrences: numberOrNull(sub.arbTransactions?.pastOccurrences ?? sub.pastOccurrences),
    transactions: transactions.map((t) => ({
      transId: t.transId != null ? String(t.transId) : null,
      // 1 = the first payment of the subscription, and so on.
      payNum: numberOrNull(t.payNum),
      // 1 approved | 2 declined | 3 error | 4 held for review. A DECLINE IS NOT
      // AN ERROR: it means the card said no, which is exactly the signal
      // detector 3 exists to find.
      responseCode: numberOrNull(t.response?.code ?? t.responseCode),
      responseReasonCode: numberOrNull(t.response?.reasonCode ?? t.responseReasonCode),
      // Deliberately NOT carrying response text out of this function. See the
      // note on logAuthnetFailure below: Authorize.Net echoes offending values
      // back inside message text, and this is the money path.
      submitTimeUTC: t.submitTimeUTC ?? null,
    })),
  };
}

function numberOrNull(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Log a billing call's failure WITHOUT leaking a credential.
 *
 * The rental-side Authorize.Net webhook route logs key fingerprints and HMAC prefixes on a
 * verification failure — a useful debugging affordance and a bad idea on a route guarding
 * Ride's own revenue. Same rule here: codes and ids, never keys, never tokens, never a
 * masked card number.
 *
 * THE FREE-TEXT MESSAGE IS NOT LOGGED (tightened 2026-08-27, billing Phase 2).
 * As shipped in Phase 1 this function's comment promised "codes and ids" while the body
 * logged `err.message`, and Authorize.Net ECHOES THE OFFENDING VALUE BACK INSIDE ITS ERROR
 * TEXT — the same hazard billing-public.routes.js:75-81 already refuses to take on the
 * hosted-session mint, where the echoed value would be a live enrollment token. Phase 2 adds
 * reconciler and webhook call sites that run unattended against every live subscription, so
 * the number of chances for a value to ride out in prose goes from two to continuous. The
 * shared redactor masks a field NAMED token; it cannot see one embedded in a sentence.
 *
 * `code` (Authorize.Net's own EXXXXX) plus `name` is what actually gets used when debugging
 * one of these, and neither can carry a secret. If a specific message is ever genuinely
 * needed, read it from the caught error at the call site and decide there — do not widen
 * this function, which every billing path shares.
 */
export function logAuthnetFailure(scope, err, meta = {}) {
  logger.error(`[billing-authnet] ${scope} failed`, {
    ...meta,
    code: err instanceof AuthorizeNetError ? err.code : null,
    name: err instanceof Error ? err.name : null,
    // A timeout means WE DO NOT KNOW whether the call took effect (see
    // CALL_TIMEOUT_MS). That distinction drives real branching in callers, so it
    // is surfaced as a boolean rather than left to be re-derived from prose.
    timedOut: err instanceof Error && /timed out after/.test(String(err.message || '')),
  });
}

export const authorizeNet = {
  billingEnv,
  hostedPageUrl,
  ensureCustomerProfile,
  getHostedProfilePageToken,
  updateSubscriptionPaymentMethod,
  getPaymentMethods,
  getNewestPaymentMethod,
  createSubscription,
  cancelSubscription,
  getSubscriptionStatus,
  getSubscription,
};
