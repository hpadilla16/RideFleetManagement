/**
 * The Authorize.Net client's bug fixes, each pinned.
 *
 * This file exists because the client was proven end to end against the
 * PRODUCTION Authorize.Net account and every quirk below cost somebody a
 * debugging session to find. Moving the module from the Next app to the backend
 * is exactly the kind of change that quietly drops one of them, so each is a
 * test rather than only a comment:
 *
 *   1. the UTF-8 BOM that makes JSON.parse throw on a good body;
 *   2. HTTP 200 carrying an application ERROR in messages.resultCode;
 *   3. E00039 — the duplicate-profile id buried in the message TEXT, which is
 *      what makes ensureCustomerProfile idempotent;
 *   4. the 20-character merchantCustomerId cap, which rejects the whole request
 *      when exceeded;
 *   5. env() failing CLOSED, so a misconfigured deploy cannot silently bill
 *      nobody through the sandbox;
 *   6. the PAN rule: this module must never construct a card-number request.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

process.env.BILLING_AUTHNET_ENV = 'sandbox';
process.env.BILLING_AUTHNET_LOGIN_ID = 'test-login';
process.env.BILLING_AUTHNET_TRANSACTION_KEY = 'test-key';

const {
  _call,
  billingEnv,
  hostedPageUrl,
  ensureCustomerProfile,
  createSubscription,
  getNewestPaymentMethod,
  AuthorizeNetError,
} = await import('./authorize-net.js');

/** A fetch stand-in that records what was sent and replays a canned body. */
function fakeFetch(body, { ok = true, status = 200 } = {}) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return { ok, status, text: async () => body };
  };
  fn.calls = calls;
  return fn;
}

const OK = (extra = {}) => JSON.stringify({ messages: { resultCode: 'Ok' }, ...extra });

// ── 1. The BOM ─────────────────────────────────────────────────────────────

test('a UTF-8 BOM on the response does not break the parse', async () => {
  // Authorize.Net prefixes its JSON with U+FEFF. res.json() and a bare
  // JSON.parse both throw "Unexpected token" on an otherwise perfect body.
  const withBom = '﻿' + OK({ customerProfileId: '9111' });
  const res = await _call('createCustomerProfileRequest', {}, { fetch: fakeFetch(withBom) });
  assert.equal(res.customerProfileId, '9111');
});

test('the BOM strip is the only reason it parses — the raw body really has one', async () => {
  // Guards against someone "simplifying" the strip away after switching to
  // res.json(): this asserts the untouched body is genuinely unparseable.
  assert.throws(() => JSON.parse('﻿' + OK()));
});

// ── 2. HTTP 200 with an application error ──────────────────────────────────

test('HTTP 200 with resultCode Error still throws', async () => {
  const body = JSON.stringify({
    messages: { resultCode: 'Error', message: [{ code: 'E00027', text: 'The transaction was unsuccessful.' }] },
  });
  await assert.rejects(
    () => _call('ARBCreateSubscriptionRequest', {}, { fetch: fakeFetch(body, { ok: true, status: 200 }) }),
    (err) => {
      assert.ok(err instanceof AuthorizeNetError);
      assert.equal(err.code, 'E00027');
      assert.match(err.message, /unsuccessful/);
      return true;
    },
  );
});

test('a genuine HTTP failure is its own error code', async () => {
  await assert.rejects(
    () => _call('x', {}, { fetch: fakeFetch('', { ok: false, status: 503 }) }),
    (err) => err.code === 'HTTP_ERROR',
  );
});

test('a malformed body is PARSE_ERROR, not a raw SyntaxError', async () => {
  await assert.rejects(
    () => _call('x', {}, { fetch: fakeFetch('<html>maintenance</html>') }),
    (err) => err.code === 'PARSE_ERROR',
  );
});

// ── 3. E00039 duplicate-profile idempotency ────────────────────────────────

test('E00039 hands back the EXISTING profile id instead of failing', async () => {
  // Authorize.Net dedupes on (merchantCustomerId, description, email) and
  // rejects an exact repeat rather than returning the original. Recovering the
  // id from the message text is what makes a reopened enrollment link safe:
  // without it, a second profile is created and the subscription hangs off the
  // wrong one.
  const dup = JSON.stringify({
    messages: {
      resultCode: 'Error',
      message: [{ code: 'E00039', text: 'A duplicate record with ID 51234567 already exists.' }],
    },
  });
  const id = await ensureCustomerProfile(
    { merchantCustomerId: 'tenant1', email: 'a@b.com', description: 'Acme' },
    { fetch: fakeFetch(dup) },
  );
  assert.equal(id, '51234567');
});

test('a non-E00039 error is NOT swallowed by the duplicate path', async () => {
  const bad = JSON.stringify({
    messages: { resultCode: 'Error', message: [{ code: 'E00007', text: 'Authentication failed.' }] },
  });
  await assert.rejects(
    () => ensureCustomerProfile(
      { merchantCustomerId: 'x', email: 'a@b.com', description: 'Acme' },
      { fetch: fakeFetch(bad) },
    ),
    (err) => err.code === 'E00007',
  );
});

// ── 4. The 20-character merchantCustomerId cap ─────────────────────────────

test('merchantCustomerId is truncated to 20 characters before it is sent', async () => {
  // Authorize.Net's schema caps this at 20 and rejects the WHOLE request on an
  // overflow. A cuid is 25 characters, so an untruncated tenant id fails every
  // enrollment. Truncation is also stable per tenant, which is what the dedupe
  // key needs.
  const f = fakeFetch(OK({ customerProfileId: '1' }));
  const long = 'clz9abcdefghijklmnopqrstu'; // 25 chars, cuid-shaped
  await ensureCustomerProfile(
    { merchantCustomerId: long, email: 'a@b.com', description: 'Acme' },
    { fetch: f },
  );
  const sent = f.calls[0].body.createCustomerProfileRequest.profile.merchantCustomerId;
  assert.equal(sent.length, 20);
  assert.equal(sent, long.slice(0, 20));
});

test('description and email are capped at 255 too', async () => {
  const f = fakeFetch(OK({ customerProfileId: '1' }));
  await ensureCustomerProfile(
    { merchantCustomerId: 'x', email: `${'e'.repeat(300)}@b.com`, description: 'd'.repeat(300) },
    { fetch: f },
  );
  const p = f.calls[0].body.createCustomerProfileRequest.profile;
  assert.equal(p.description.length, 255);
  assert.equal(p.email.length, 255);
});

// ── 5. env() fails CLOSED ──────────────────────────────────────────────────

test('a missing or misspelled BILLING_AUTHNET_ENV throws instead of defaulting to sandbox', () => {
  // The frontend version returned 'sandbox' for anything that was not exactly
  // 'production'. On the droplet that meant a typo sent every enrollment to the
  // sandbox and NOBODY WAS EVER BILLED, with no error on any surface.
  const saved = process.env.BILLING_AUTHNET_ENV;
  try {
    for (const bad of ['', 'PRODUCTION', 'prod', 'Sandbox', undefined]) {
      if (bad === undefined) delete process.env.BILLING_AUTHNET_ENV;
      else process.env.BILLING_AUTHNET_ENV = bad;
      assert.throws(() => billingEnv(), /must be set to exactly/);
    }
    process.env.BILLING_AUTHNET_ENV = 'production';
    assert.equal(billingEnv(), 'production');
    process.env.BILLING_AUTHNET_ENV = 'sandbox';
    assert.equal(billingEnv(), 'sandbox');
  } finally {
    process.env.BILLING_AUTHNET_ENV = saved;
  }
});

test('enroll and update are different hosted endpoints, not a flag', () => {
  assert.match(hostedPageUrl('enroll'), /\/addPayment$/);
  assert.match(hostedPageUrl('update'), /\/manage$/);
});

// ── 6. The PAN rule, enforced ──────────────────────────────────────────────

test('the client never constructs a raw card-number request', () => {
  // The card is typed on Authorize.Net's own origin; nothing here may accept a
  // PAN. The module header states this in prose — this makes it enforceable.
  // The platform is PCI SAQ C certified and a PAN in our request path moves it
  // to SAQ D.
  const src = readFileSync(new URL('./authorize-net.js', import.meta.url), 'utf8');
  // Strip comments first: the prose deliberately NAMES the thing it forbids.
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  // CONSTRUCTION, not mention. `p.payment?.creditCard?.cardNumber` is a READ of
  // the value Authorize.Net already masked ("XXXX1111") on the way back, and
  // that is allowed — it is where brand and last4 come from. What must never
  // appear is one of these as an object KEY, i.e. a field we are SENDING.
  for (const forbidden of ['cardNumber', 'cardCode', 'creditCard', 'expirationDate', 'pan']) {
    const asKey = new RegExp(`(^|[{,\\s])${forbidden}\\s*:`, 'm');
    assert.ok(
      !asKey.test(code),
      `authorize-net.js SENDS a "${forbidden}" field — a PAN must never reach a Ride server`,
    );
  }
});

test('BILLING_AUTHNET_TEST_VALIDATION is gone from the ported client', () => {
  // Pre-production checklist item. Left in, an env var set once for a rehearsal
  // and never unset means testMode validation on a LIVE gateway — so a dead
  // card is only discovered on the first billing run, weeks later, on a
  // customer who believes they are enrolled.
  const src = readFileSync(new URL('./authorize-net.js', import.meta.url), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!code.includes('BILLING_AUTHNET_TEST_VALIDATION'));
});

test('only BILLING_AUTHNET_* credentials are read — never the tenant gateway AUTHNET_*', () => {
  // Mixing the two would deposit Ride's subscription revenue into a tenant's
  // own merchant account. The names are deliberately unalike; this keeps them
  // that way.
  const src = readFileSync(new URL('./authorize-net.js', import.meta.url), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const reads = [...code.matchAll(/process\.env\.([A-Z0-9_]+)/g)].map((m) => m[1]);
  assert.ok(reads.length > 0, 'expected the client to read env credentials');
  for (const name of reads) {
    assert.ok(
      name.startsWith('BILLING_'),
      `authorize-net.js reads ${name}; RIDE's billing account uses BILLING_AUTHNET_* only`,
    );
  }
});

// ── Subscription creation ──────────────────────────────────────────────────

test('createSubscription sends the calendar startDate untouched', async () => {
  const f = fakeFetch(OK({ subscriptionId: '7788' }));
  const id = await createSubscription({
    name: 'Pro — Acme',
    amount: 199,
    startDate: '2026-09-30',
    intervalLength: 1,
    intervalUnit: 'months',
    customerProfileId: '1',
    customerPaymentProfileId: '2',
  }, { fetch: f });
  assert.equal(id, '7788');
  const sub = f.calls[0].body.ARBCreateSubscriptionRequest.subscription;
  // Byte-identical to what we stored. No Date object ever touches it, so no
  // formatter can shift the day the customer is charged.
  assert.equal(sub.paymentSchedule.startDate, '2026-09-30');
  assert.equal(sub.paymentSchedule.totalOccurrences, 9999);
  assert.equal(sub.amount, 199);
  // A free trial is a deferred startDate, not ARB trial occurrences, so the
  // trial fields must be ABSENT rather than zero.
  assert.ok(!('trialOccurrences' in sub.paymentSchedule));
  assert.ok(!('trialAmount' in sub));
});

test('trialOccurrences without an explicit trialAmount is refused', async () => {
  // Whether ARB accepts trialAmount: 0 is unverified against a live account.
  // Rather than let an unverified assumption decide what a customer is charged,
  // the ambiguous shape is refused outright.
  await assert.rejects(
    () => createSubscription({
      name: 'x', amount: 10, startDate: '2026-09-30',
      intervalLength: 1, intervalUnit: 'months',
      customerProfileId: '1', customerPaymentProfileId: '2',
      trialOccurrences: 1,
    }, { fetch: fakeFetch(OK({ subscriptionId: '1' })) }),
    /requires an explicit trialAmount/,
  );
});

test('getNewestPaymentMethod returns the LAST profile — what they just typed', async () => {
  const body = OK({
    profile: {
      paymentProfiles: [
        { customerPaymentProfileId: '10', payment: { creditCard: { cardNumber: 'XXXX1111', cardType: 'Visa' } } },
        { customerPaymentProfileId: '11', payment: { creditCard: { cardNumber: 'XXXX4242', cardType: 'MasterCard' } } },
      ],
    },
  });
  const m = await getNewestPaymentMethod('9111', { fetch: fakeFetch(body) });
  assert.equal(m.customerPaymentProfileId, '11');
  assert.equal(m.cardType, 'MasterCard');
  // Already masked by Authorize.Net — this is not a PAN.
  assert.equal(m.maskedNumber, 'XXXX4242');
});

test('an empty profile yields null, not a crash', async () => {
  const m = await getNewestPaymentMethod('9111', { fetch: fakeFetch(OK({ profile: {} })) });
  assert.equal(m, null);
});

test('a hung Authorize.Net call is bounded, and says so', async () => {
  // No network call on a request path may be unbounded (2026-08-08 incident).
  const hang = () => new Promise(() => {});
  await assert.rejects(
    () => _call('x', {}, { fetch: hang, timeoutMs: 20 }),
    /timed out after 20ms/,
  );
});

// ── 7. Phase 6: the amount update and the proration charge ─────────────────

const { updateSubscriptionAmount, chargeCustomerProfile } = await import('./authorize-net.js');

test('updateSubscriptionAmount sends ARBUpdateSubscriptionRequest with a 2dp amount', async () => {
  const fetch = fakeFetch(OK());
  await updateSubscriptionAmount('arb_9', 199.999, { fetch });
  const sent = fetch.calls[0].body.ARBUpdateSubscriptionRequest;
  assert.equal(sent.subscriptionId, 'arb_9');
  assert.equal(sent.subscription.amount, 200);
});

test('chargeCustomerProfile: an approval carries the transId out', async () => {
  const fetch = fakeFetch(OK({
    transactionResponse: { responseCode: '1', transId: '40098', authCode: 'A7X' },
  }));
  const v = await chargeCustomerProfile({
    customerProfileId: 'c1', customerPaymentProfileId: 'p1', amount: 50, refId: 'pr-abc', description: 'ajuste',
  }, { fetch });
  assert.equal(v.approved, true);
  assert.equal(v.transId, '40098');
  assert.equal(v.authCode, 'A7X');

  // The request shape: refId travels (it is what makes an unanswered call
  // findable), the stored profile is charged, and NOTHING card-shaped is sent.
  const sent = fetch.calls[0].body.createTransactionRequest;
  assert.equal(sent.refId, 'pr-abc');
  assert.equal(sent.transactionRequest.transactionType, 'authCaptureTransaction');
  assert.equal(sent.transactionRequest.profile.customerProfileId, 'c1');
  assert.equal(sent.transactionRequest.profile.paymentProfile.paymentProfileId, 'p1');
  assert.ok(!JSON.stringify(sent).match(/cardNumber|creditCard|cardCode/));
});

test('chargeCustomerProfile: BOTH decline spellings land on declined, never a throw', async () => {
  // Envelope-level: resultCode Error + E00027.
  const envelope = JSON.stringify({
    messages: { resultCode: 'Error', message: [{ code: 'E00027', text: 'The transaction was unsuccessful.' }] },
  });
  const v1 = await chargeCustomerProfile({
    customerProfileId: 'c1', customerPaymentProfileId: 'p1', amount: 50, refId: 'pr-a',
  }, { fetch: fakeFetch(envelope) });
  assert.equal(v1.approved, false);
  assert.equal(v1.declined, true);

  // Transaction-level: Ok envelope, responseCode 2.
  const v2 = await chargeCustomerProfile({
    customerProfileId: 'c1', customerPaymentProfileId: 'p1', amount: 50, refId: 'pr-b',
  }, { fetch: fakeFetch(OK({ transactionResponse: { responseCode: '2', transId: '0' } })) });
  assert.equal(v2.approved, false);
  assert.equal(v2.declined, true);
  assert.equal(v2.transId, null, 'transId "0" is Authorize.Net for "none" and must not be stored as one');
});

test('chargeCustomerProfile: held-for-review is NOT approved — the money is not ours yet', async () => {
  const v = await chargeCustomerProfile({
    customerProfileId: 'c1', customerPaymentProfileId: 'p1', amount: 50, refId: 'pr-c',
  }, { fetch: fakeFetch(OK({ transactionResponse: { responseCode: '4', transId: '40100' } })) });
  assert.equal(v.approved, false);
  assert.equal(v.held, true);
});

test('chargeCustomerProfile: a timeout STILL THROWS — unknown state is not a decline', async () => {
  const hang = () => new Promise(() => {});
  await assert.rejects(
    () => chargeCustomerProfile({
      customerProfileId: 'c1', customerPaymentProfileId: 'p1', amount: 50, refId: 'pr-d',
    }, { fetch: hang, timeoutMs: 20 }),
    /timed out after 20ms/,
  );
});
