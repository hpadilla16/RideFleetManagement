/**
 * Emailing the enrollment link — Tenant Subscriptions Phase 7 (2026-08-28).
 *
 * Pinned here, in order of cost-of-being-wrong:
 *
 *  1. A MINTED LINK IS NEVER LOST. The token is stored hashed and shown once.
 *     If a mailer outage could take the request down with it, the operator
 *     would be left holding a live PENDING_AUTHORIZATION row whose only link
 *     exists nowhere retrievable. The send is best-effort, the URL comes back
 *     regardless, and the failure is reported rather than swallowed.
 *  2. NOTHING SENDS WHEN NOTHING IS CONFIGURED. A billing suite one forgotten
 *     stub away from mailing a real tenant is not a suite anyone can run.
 *  3. THE TOKEN LEAVES ONLY IN THE MESSAGE BODY. Not the audit trail, not a
 *     log line, not an error handed back to the caller. billing-notify already
 *     learned this from Authorize.Net quoting offending values back inside an
 *     error string.
 *  4. THE EMAIL IS BILINGUAL AND QUOTES ONE PRICE. Nothing in the data says
 *     which language the billing contact reads, so the message carries both —
 *     and two translations of one offer must never drift into two offers.
 *  5. A RESEND SAYS WHICH LINK IS LIVE. Minting revokes its predecessors, so a
 *     customer holding two of these emails holds one dead link. Which one is
 *     dead is our fact to state, not theirs to deduce.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://u:p@localhost:5432/testdb';
process.env.BILLING_AUTHNET_ENV = 'sandbox';
process.env.BILLING_AUTHNET_LOGIN_ID = 'test-login';
process.env.BILLING_AUTHNET_TRANSACTION_KEY = 'test-key';
process.env.BILLING_BASE_URL = 'https://example.test';

const { makePrisma, makeAuditSpy, silentLogger } = await import('./billing-test-prisma.mjs');
const { saveTenantPlanCatalog } = await import('../../lib/tenant-plan-limits.js');
const { issueEnrollInvite } = await import('./billing.service.js');
const {
  buildEnrollInviteEmail,
  sendEnrollInviteEmail,
  mailerConfigured,
  scrubToken,
  INVITE_EMAIL_RESULT,
} = await import('./billing-invite-email.js');
const { AUDIT_ACTIONS, AUDIT_OUTCOME } = await import('../audit/audit.service.js');
const { resolveUsableInvite } = await import('./autopay-invites.service.js');

const NOW = new Date('2026-08-28T14:00:00Z');
const CATALOG = [{ code: 'PRO', name: 'Pro', billable: true, priceMonthly: 199, trialDays: 0 }];

/** No provider keys — the send path must decline, not guess. */
const BARE_ENV = {};
const CONFIGURED_ENV = { MAILERSEND_API_KEY: 'ms_test' };

function mailbox() {
  const sent = [];
  return {
    sent,
    sendEmail: async (msg) => { sent.push(msg); return { id: 'msg_1' }; },
  };
}

async function world(over = {}) {
  const prisma = makePrisma();
  const audit = makeAuditSpy();
  await prisma.tenant.create({ data: { id: 'tenant_1', name: 'Autos del Valle', plan: 'PRO' } });
  await saveTenantPlanCatalog(CATALOG, prisma);
  const box = mailbox();
  const deps = {
    prisma,
    logger: silentLogger,
    now: () => NOW,
    recordAudit: audit.recordAudit,
    ensureCustomerProfile: async () => 'cust_1',
    getHostedProfilePageToken: async () => 'tok',
    getNewestPaymentMethod: async () => ({ customerPaymentProfileId: 'pp_1', maskedNumber: 'XXXX4242', cardType: 'Visa' }),
    createSubscription: async () => 'arb_1',
    updateSubscriptionPaymentMethod: async () => {},
    hostedPageUrl: () => 'https://test.authorize.net/customer/addPayment',
    sendEmail: box.sendEmail,
    env: CONFIGURED_ENV,
    ...over,
  };
  return { prisma, audit, deps, box };
}

const INPUT = {
  tenantId: 'tenant_1',
  planCode: 'PRO',
  cycle: 'monthly',
  amountOverride: 1650,
  startDate: '2026-09-01',
  email: 'owner@autosdelvalle.test',
  actorUserId: 'user_super',
  actorRole: 'SUPER_ADMIN',
};

const MESSAGE_INPUT = {
  companyName: 'Autos del Valle',
  planName: 'Pro',
  amount: 1650,
  currency: 'USD',
  intervalUnit: 'months',
  intervalLength: 1,
  firstChargeDate: '2026-09-01',
  url: 'https://example.test/autopay/TOKEN123',
  expiresAt: new Date('2026-09-11T14:00:00Z'),
  issuedAt: NOW,
};

// ═══ 1. THE LINK SURVIVES A MAILER OUTAGE ═══════════════════════════════════

test('a mailer outage does not lose the invite — the row lives, the URL comes back, the link works', async () => {
  // THE FAILURE THIS WHOLE SHAPE EXISTS FOR. The token is stored hashed; if the
  // send could take the request down with it, an operator whose mail provider
  // is down would end up with a minted, unrecoverable link.
  const w = await world({
    sendEmail: async () => { throw new Error('MailerSend edge 502'); },
  });

  const out = await issueEnrollInvite(INPUT, w.deps);

  assert.equal(out.emailed, false, 'a throwing mailer was reported as a successful send');
  assert.equal(out.emailResult, INVITE_EMAIL_RESULT.SEND_FAILED);
  assert.ok(out.url.includes(out.token), 'the URL was withheld after a failed send — the link is now unrecoverable');
  assert.equal(w.prisma.tenantSubscription.rows.length, 1, 'the subscription row did not survive the failed send');
  assert.ok(await resolveUsableInvite(out.token, w.deps), 'the invite was invalidated by a mail failure');
});

test('the operator is TOLD the send failed — a silent failure is the whole bug', async () => {
  const w = await world({ sendEmail: async () => { throw new Error('smtp down'); } });
  const out = await issueEnrollInvite(INPUT, w.deps);
  // Not merely "not true" — a distinguishable reason, so the UI can say
  // something better than "something went wrong".
  assert.notEqual(out.emailResult, INVITE_EMAIL_RESULT.SENT);
  assert.equal(out.emailTo, 'owner@autosdelvalle.test');
});

// ═══ 2. NOTHING SENDS WHEN NOTHING IS CONFIGURED ════════════════════════════

test('no mail provider configured: nothing is sent, and it does not pretend otherwise', async () => {
  // `sendEmail` deliberately ABSENT, so the only thing standing between this
  // test and the real mailer is the configuration check.
  const w = await world({ sendEmail: undefined, env: BARE_ENV });
  const out = await issueEnrollInvite(INPUT, w.deps);

  assert.equal(out.emailed, false);
  assert.equal(out.emailResult, INVITE_EMAIL_RESULT.MAILER_NOT_CONFIGURED);
  assert.ok(out.url.includes(out.token), 'the link was not returned, so nobody can send it by hand either');
});

test('mailerConfigured reads the environment it is given, and defaults to NO', async () => {
  assert.equal(mailerConfigured({}), false);
  assert.equal(mailerConfigured({ MAILERSEND_API_KEY: 'k' }), true);
  assert.equal(mailerConfigured({ RESEND_API_KEY: 'k' }), true);
  // A partial SMTP block is not a configured mailer — it is a misconfigured one.
  assert.equal(mailerConfigured({ SMTP_HOST: 'h' }), false);
  assert.equal(mailerConfigured({ SMTP_HOST: 'h', SMTP_USER: 'u' }), false);
  assert.equal(mailerConfigured({ SMTP_HOST: 'h', SMTP_USER: 'u', SMTP_PASS: 'p' }), true);
  assert.equal(mailerConfigured({ SMTP_HOST: '  ', SMTP_USER: 'u', SMTP_PASS: 'p' }), false);
});

test('an invite with no recipient sends nothing and says so', async () => {
  const box = mailbox();
  const res = await sendEnrollInviteEmail(
    { ...MESSAGE_INPUT, to: '   ' },
    { sendEmail: box.sendEmail, logger: silentLogger, env: CONFIGURED_ENV },
  );
  assert.equal(res.sent, false);
  assert.equal(res.reason, INVITE_EMAIL_RESULT.NO_RECIPIENT);
  assert.equal(box.sent.length, 0, 'an email went out with no recipient');
});

test('sendEnrollInviteEmail NEVER throws, whatever the mailer does', async () => {
  for (const boom of [
    async () => { throw new Error('nope'); },
    async () => { throw { weird: true }; }, // eslint-disable-line no-throw-literal
  ]) {
    const res = await sendEnrollInviteEmail(
      { ...MESSAGE_INPUT, to: 'a@b.test' },
      { sendEmail: boom, logger: silentLogger, env: CONFIGURED_ENV },
    );
    assert.equal(res.sent, false);
    assert.equal(res.reason, INVITE_EMAIL_RESULT.SEND_FAILED);
  }
});

// ═══ 3. THE TOKEN GOES IN THE BODY AND NOWHERE ELSE ═════════════════════════

test('the happy path emails the billing contact on the invite, with the link in it', async () => {
  const w = await world();
  const out = await issueEnrollInvite(INPUT, w.deps);

  assert.equal(out.emailed, true);
  assert.equal(w.box.sent.length, 1);
  const [msg] = w.box.sent;
  assert.equal(msg.to, 'owner@autosdelvalle.test', 'the link went somewhere other than the billing contact');
  assert.ok(msg.text.includes(out.url), 'the email does not contain the link');
  // The sender must resolve to the PLATFORM. Passing tenantId would make Ride's
  // own invoice arrive branded as the customer's own company.
  assert.equal(msg.tenantId, undefined, 'the invite email would be sent under the tenant brand');
});

test('the plaintext token reaches the audit trail nowhere — not even on the failure row', async () => {
  for (const sendEmail of [
    mailbox().sendEmail,
    async () => { throw new Error('boom'); },
  ]) {
    const w = await world({ sendEmail });
    const out = await issueEnrollInvite(INPUT, w.deps);
    const trail = JSON.stringify(w.audit.rows);
    assert.ok(!trail.includes(out.token), 'a plaintext token reached the audit trail');
    assert.ok(!trail.includes(out.url), 'the enrollment URL reached the audit trail');
  }
});

test('a provider error message never comes back to the caller — it quotes the body, and the body has the link', async () => {
  // The billing-notify lesson, transplanted: Authorize.Net echoed offending
  // values back inside free text. A mail provider that rejects a body does the
  // same, and this body carries the token.
  const w = await world({
    sendEmail: async (msg) => { throw new Error(`422 invalid body: ${msg.text}`); },
  });
  const out = await issueEnrollInvite(INPUT, w.deps);

  const returned = JSON.stringify({ emailed: out.emailed, emailResult: out.emailResult, emailTo: out.emailTo });
  assert.ok(!returned.includes(out.token), 'the token came back inside the reported failure');
  assert.ok(!returned.includes('invalid body'), 'the provider free text was passed through to the caller');
  assert.equal(out.emailResult, INVITE_EMAIL_RESULT.SEND_FAILED);
});

test('a token that does reach a log string is scrubbed out of it', async () => {
  const token = 'aVeryRealLookingToken';
  const scrubbed = scrubToken(`422 rejected: https://x.test/autopay/${token} is bad`, token);
  assert.ok(!scrubbed.includes(token));
  assert.match(scrubbed, /\[redacted\]/);
  // No token to scrub is not an excuse to mangle the message.
  assert.equal(scrubToken('plain', null), 'plain');
});

// ═══ THE AUDIT TRAIL ════════════════════════════════════════════════════════

test('delivery is audited as its own act, with the recipient and no token', async () => {
  const w = await world();
  const out = await issueEnrollInvite(INPUT, w.deps);

  const rows = w.audit.rows.filter((r) => r.action === AUDIT_ACTIONS.AUTOPAY_INVITE_EMAIL);
  assert.equal(rows.length, 1, 'sending the link left no trail of its own');
  const [row] = rows;
  assert.equal(row.outcome, AUDIT_OUTCOME.SUCCESS);
  assert.equal(row.targetId, out.invite.id);
  // WHERE IT WENT — the recovery path for a mistyped address is reading this.
  assert.equal(row.metadata.recipient, 'owner@autosdelvalle.test');
  assert.equal(row.metadata.tokenPrefix, out.token.slice(0, 8));
  assert.equal(row.metadata.result, INVITE_EMAIL_RESULT.SENT);
  assert.equal(row.metadata.language, 'en+es');
});

test('a FAILED send is audited too — an undelivered link must not be invisible', async () => {
  const w = await world({ sendEmail: async () => { throw new Error('down'); } });
  await issueEnrollInvite(INPUT, w.deps);

  const [row] = w.audit.rows.filter((r) => r.action === AUDIT_ACTIONS.AUTOPAY_INVITE_EMAIL);
  assert.ok(row, 'a failed send left no audit row at all');
  assert.equal(row.outcome, AUDIT_OUTCOME.FAILURE);
  assert.equal(row.metadata.result, INVITE_EMAIL_RESULT.SEND_FAILED);
});

test('minting is still audited separately — the two acts can now succeed independently', async () => {
  const w = await world({ sendEmail: async () => { throw new Error('down'); } });
  await issueEnrollInvite(INPUT, w.deps);
  const minted = w.audit.rows.filter((r) => r.action === AUDIT_ACTIONS.AUTOPAY_INVITE_SEND);
  const mailed = w.audit.rows.filter((r) => r.action === AUDIT_ACTIONS.AUTOPAY_INVITE_EMAIL);
  assert.equal(minted.length, 1);
  assert.equal(mailed.length, 1);
  assert.equal(minted[0].outcome ?? AUDIT_OUTCOME.SUCCESS, AUDIT_OUTCOME.SUCCESS,
    'a mail failure was allowed to mark the MINT as failed — the link is real and valid');
});

// ═══ 4. BILINGUAL, ONE PRICE ════════════════════════════════════════════════

test('the message carries English AND Spanish — nothing in the data says which they read', async () => {
  const { text, subject } = buildEnrollInviteEmail(MESSAGE_INPUT);
  assert.match(text, /^ENGLISH/m);
  assert.match(text, /^ESPAÑOL/m);
  // English leads, so the email and the enrollment page it opens agree on which
  // language comes first (the page defaults to English with an ES toggle).
  assert.ok(text.indexOf('ENGLISH') < text.indexOf('ESPAÑOL'), 'Spanish was silently inherited as the lead');
  assert.match(subject, /Set up automatic payment/);
  assert.match(subject, /cobro automático/);
});

test('two language blocks, ONE price and ONE link', async () => {
  const { text } = buildEnrollInviteEmail(MESSAGE_INPUT);
  const prices = text.match(/\$1,650\.00 USD/g) || [];
  assert.equal(prices.length, 2, 'the two blocks quote a different number of prices than one each');
  assert.equal(new Set(text.match(/\$[\d,]+\.\d\d USD/g)).size, 1, 'the two blocks quote two different prices');
  const links = text.match(/https:\/\/example\.test\/autopay\/\S+/g) || [];
  assert.equal(links.length, 1, 'more than one URL in the message — a reader cannot tell which to trust');
});

test('the first-charge date renders in both languages and means the same day', async () => {
  const { text } = buildEnrollInviteEmail({ ...MESSAGE_INPUT, firstChargeDate: '2026-09-01' });
  assert.match(text, /First charge: September 1, 2026/);
  assert.match(text, /Primer cobro: 1 de septiembre de 2026/);
  // The UTC rule from billing-dates.js. A locally-formatted calendar date shows
  // the day BEFORE the one Authorize.Net charges, for every reader west of UTC.
  assert.ok(!/August 31/.test(text) && !/31 de agosto/.test(text), 'the date slipped a day — check timeZone: UTC');
});

test('it says "first charge", never "next charge" and never "trial"', async () => {
  // The Phase 3 wording decision: a deferred start is not a trial, and calling
  // it one puts the wrong word in front of a customer who is not on one.
  const { text } = buildEnrollInviteEmail(MESSAGE_INPUT);
  assert.ok(!/next charge/i.test(text));
  assert.ok(!/próximo cobro/i.test(text));
  assert.ok(!/\btrial\b/i.test(text));
  assert.ok(!/prueba gratis/i.test(text));
});

test('it promises that entering the card charges nothing — because it does not', async () => {
  // Proven in production: enrollment produces a $0.01 Authorization Only, voided.
  const { text } = buildEnrollInviteEmail(MESSAGE_INPUT);
  assert.match(text, /Nothing is charged when you enter the card/);
  assert.match(text, /No se cobra nada al registrar la tarjeta/);
});

// ═══ 5. A RESEND SAYS WHICH LINK IS LIVE ════════════════════════════════════

test('a resend states, in both languages, that the older links no longer work', async () => {
  // Minting revokes its predecessors, so the customer holding two emails holds
  // one dead link. Which one is dead is our fact to state.
  const { text } = buildEnrollInviteEmail({ ...MESSAGE_INPUT, resent: true });
  assert.match(text, /REPLACES any earlier one/);
  assert.match(text, /no longer open/);
  assert.match(text, /REEMPLAZA cualquier otro/);
  assert.match(text, /ya no abren/);
});

test('the resent subject is distinguishable in an inbox of two', async () => {
  const fresh = buildEnrollInviteEmail(MESSAGE_INPUT).subject;
  const again = buildEnrollInviteEmail({ ...MESSAGE_INPUT, resent: true }).subject;
  assert.notEqual(fresh, again, 'two links produce an identical subject line');
  assert.match(again, /Updated link/);
});

test('a first send does NOT claim to replace anything', async () => {
  const { text } = buildEnrollInviteEmail(MESSAGE_INPUT);
  assert.ok(!/REPLACES/.test(text) && !/REEMPLAZA/.test(text));
  assert.match(text, /single-use/);
});

test('the real resend path reaches the recipient marked as a replacement', async () => {
  const w = await world();
  await issueEnrollInvite(INPUT, w.deps);
  await issueEnrollInvite({ ...INPUT, amountOverride: 1750 }, w.deps);

  assert.equal(w.box.sent.length, 2);
  assert.ok(!/REPLACES/.test(w.box.sent[0].text), 'the first email claimed to supersede something');
  assert.match(w.box.sent[1].text, /REPLACES any earlier one/);
  // And it quotes the corrected price, not the one that was revoked with it.
  assert.match(w.box.sent[1].text, /\$1,750\.00 USD/);
});

// ═══ THE EXPIRY, AND THE THING IT IS NOT ════════════════════════════════════

test('the expiry is stated as a calendar date in both languages, or not at all', async () => {
  const { text } = buildEnrollInviteEmail(MESSAGE_INPUT);
  assert.match(text, /expires on September 11, 2026/);
  assert.match(text, /vence el 11 de septiembre de 2026/);

  const noExpiry = buildEnrollInviteEmail({ ...MESSAGE_INPUT, expiresAt: null }).text;
  assert.ok(!/expires on/.test(noExpiry), 'an absent expiry rendered as a sentence about nothing');
  assert.ok(!/undefined/.test(noExpiry) && !/null/.test(noExpiry));
});
