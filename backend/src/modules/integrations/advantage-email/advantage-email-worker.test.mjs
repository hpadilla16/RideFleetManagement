/**
 * advantage-email-worker.test.mjs — HANDLER-level guards for the inbound-mail
 * pipeline.
 *
 * NO DATABASE, NO NETWORK, and the whole real stack under test: the prisma
 * singleton is monkey-patched per test (advantage-worker.test.mjs's style) and
 * the IMAP layer is replaced through the service's `__testHooks.setImapFactory`
 * seam with a fake mailbox that hands back real RFC 822 messages. So the MIME
 * extractor, the parser, the router, the staging upsert and the shared matcher
 * are all the production ones.
 *
 * WHAT IS LOCKED HERE — each case is a way this could quietly do the wrong
 * thing to somebody's rental:
 *
 *   1. MONEY. estimatedTotal is 73.60 (14.72 x 5), never the 381.80 card
 *      deposit that is printed on the same document, and the reservation's
 *      notes SAY the estimate is pre-tax and pre-extras. Nothing in the upsert
 *      is a charge, a fee, a card or a vehicle assignment.
 *   2. THE AGENCY PHONE. `Phone : 1404728-8787` belongs to EXPEDIA.COM. It must
 *      never reach customerPhone, where it would become a matcher key shared by
 *      every booking that agency sold.
 *   3. AN UNKNOWN BANNER IS REFUSED, NOT READ AS A CONFIRMATION. Nothing is
 *      staged, the run goes ATTENTION, and the reason is in the run notes.
 *   4. AN UNCONFIGURED (tsdNumber, branch) IS REFUSED. This is also the only
 *      thing standing between a stranger who emails the mailbox and a
 *      reservation, so it is a security case as much as a routing one.
 *   5. IDEMPOTENCY BOTH WAYS. An identical re-delivery does nothing; the SAME
 *      Message-ID with a CHANGED body re-parses, because the supplied sample is
 *      itself a regenerated snapshot (booked 2026/08/07, but already carrying
 *      the 2026/09/03 pickup, the assigned unit and the deposit).
 *   6. A CANCELLATION FOR AN ALREADY-PROMOTED ROW LEAVES THE LIVE RESERVATION
 *      ALONE — and says so out loud. Cancelling a live rental is an ops/money
 *      decision; the importer's job is to make the inaction legible.
 *   7. A MESSAGE THAT BLOWS UP IS NOT FLAGGED \Seen, so it comes back next run.
 *      A duplicate import is free; a lost reservation is not.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

process.env.INTEGRATION_ENC_KEY ||= crypto.randomBytes(32).toString('base64');
process.env.DATABASE_URL ||= 'postgresql://u:p@localhost:5432/db?schema=public';

const { prisma } = await import('../../../lib/prisma.js');
const svc = await import('./advantage-email.service.js');
const worker = await import('./advantage-email.worker.js');
const {
  advantageEmailSyncHandler,
  mapDocToExternalReservation,
  advantageEmailSourceSpec,
  estimateCaveat,
  routeKey,
  buildRouteMap,
  hashBody,
  messageKey,
} = worker;
const { parseAdvantageEmail } = await import('./advantage-email.parser.js');

// ---------------------------------------------------------------------------
// The document. Same scrubbing as advantage-email-parse.test.mjs: the real
// sample's layout, with the renter's name, phone and address replaced.
// ---------------------------------------------------------------------------

const BODY = `Advantage Orlando (61302)
AMADEUS ***CONFIRMATION***

Confirmation #    : AEXP141D54
Transmission      : XML.20260807135316.10.1.4.98-128
Renter IP         : SSEA
Renter Name       : SAMPLE, TESTER
Home Phone        : 17875550142
Email Address     : TESTER.SAMPLE@EXAMPLE.COM
Date Booked       : 2026/08/07 13:52 (ET)
Booked By         : : Amadeus
Pickup Date       : 2026/09/03 09:00
Return Date       : 2026/09/07 18:30
Pickup/Return     : MCO - MCO
Vehicle Type      : IFAR
Rate Code         : D5
PNR Locator       : A8CDJM
Confirmed Rate    : 14.72/Day  for 5 day(s) , 14.72/Extra Day  UNL
Booking Source    : 11617270
                  EXPEDIA.COM
                  STE 107
                  ATLANTA, GA 30329-2132
Phone             : 1404728-8787

Notes/Comments    :

RENTAL AGREEMENT DETAILS
Contract Number: MCO-8845
Date Out       : 9/3/2026 10:22:00 AM
Expected Date  : 9/7/2026 6:30:00 PM
Date In        :
Rate           : 14.72/DAY
Unit Number    : RASU33
Year/Make/Model: 2024 NISSAN ROGUE
Mileage Out/In : 48880 - 48880
Fuel Out/In    : F -

RENTAL.NET CHARGE DETAILS
TOTAL CHARGES: 0.00

RENTAL.NET PAYMENT DETAILS
2026/09/03 10:23     381.80 CARD DEPOSIT
TOTAL PAYMENTS: 381.80

RENTAL.NET ACTIVITY
2026/09/03 10:22:31 7 PSP / PRE-PAID SUNPASS / Kit / Daily / 16.99
2026/09/03 10:22:51 7 DW / DEPOSIT WAIVER / Coupon / Daily / 39.99
2026/09/03 10:24:55 7 381.80 / CARD DEPOSIT / DRIVER
`;

/** Wrap a body in a plausible RFC 822 envelope. */
function message(body, {
  messageId = '<rez-1@advantage.com>',
  from = '"Advantage Rez" <rez@advantage.com>',
  subject = 'Advantage Confirmation AEXP141D54',
} = {}) {
  return Buffer.from(
    `Message-ID: ${messageId}\r\n`
    + `From: ${from}\r\n`
    + `To: imports@ride.test\r\n`
    + `Subject: ${subject}\r\n`
    + 'Date: Fri, 07 Aug 2026 13:53:16 -0400\r\n'
    + 'Content-Type: text/plain; charset=us-ascii\r\n'
    + '\r\n'
    + body.replace(/\n/g, '\r\n'),
    'binary',
  );
}

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

/** A mailbox that hands back the given messages, and records what happened. */
function installFakeMailbox(messages, { failFetchOn = null } = {}) {
  const seen = [];
  const moved = [];
  svc.__testHooks.setCredentialsResolver(async () => ({
    username: 'imports@ride.test', password: 'x', host: 'imap.test', port: '993',
    secure: 'true', mailbox: 'INBOX', processedMailbox: '',
  }));
  svc.__testHooks.setImapFactory(() => ({
    async connect() { return this; },
    async login() { return { ok: true }; },
    async select() { return { exists: messages.length }; },
    async searchUnseen() { return messages.map((_, i) => i + 1); },
    async fetchRaw(uid) {
      if (failFetchOn === uid) throw new Error('simulated transport hiccup');
      return messages[uid - 1];
    },
    async markSeen(uid) { seen.push(uid); },
    async move(uid, folder) { moved.push([uid, folder]); return true; },
    async logout() {},
    close() {},
  }));
  return { seen, moved };
}

function installFakePrisma({
  configs = [{ tsdNumber: '61302', branch: 'MCO', locationId: 'loc-mco' }],
  existingExternal = null,
  priorInbound = null,
} = {}) {
  const captured = { runUpdate: null, upserts: [], updates: [], inbound: [] };
  const saved = {};
  const patch = (key, value) => { saved[key] = prisma[key]; prisma[key] = value; };

  patch('advantageLocationConfig', { findMany: async () => configs });
  patch('externalSyncRun', {
    create: async () => ({ id: 'run1' }),
    update: async (args) => { captured.runUpdate = args.data; return args.data; },
  });
  patch('externalReservation', {
    findUnique: async () => existingExternal,
    upsert: async ({ create, update, where }) => {
      captured.upserts.push({ create, update });
      return {
        id: 'ext1',
        tenantId: 't1',
        externalRef: where.source_ref_unique.externalRef,
        promotionStatus: existingExternal?.promotionStatus || 'PENDING',
        rejectedReason: existingExternal?.rejectedReason || null,
        ...create,
      };
    },
    update: async (args) => { captured.updates.push(args.data); return args.data; },
  });
  patch('advantageInboundEmail', {
    findUnique: async () => priorInbound,
    upsert: async ({ create, update, where }) => {
      captured.inbound.push({ messageId: where.tenantId_messageId.messageId, ...(create || update) });
      return { id: 'aie1' };
    },
  });
  // Nothing to match against → every row lands in MANUAL_REVIEW
  // (customer_not_found), which keeps the promotion path out of the way of the
  // things these cases are actually about.
  patch('customer', { findMany: async () => [], findFirst: async () => null });
  patch('acrissCategoryMap', { findUnique: async () => null, findFirst: async () => null });
  patch('vehicleType', { findFirst: async () => null });
  patch('reservation', { findMany: async () => [], findFirst: async () => null });
  patch('integrationCredential', { updateMany: async () => ({ count: 0 }) });

  return { captured, restore: () => { for (const [k, v] of Object.entries(saved)) prisma[k] = v; } };
}

async function run(messages, prismaPlan = {}, mailboxPlan = {}) {
  const mailbox = installFakeMailbox(messages, mailboxPlan);
  const db = installFakePrisma(prismaPlan);
  try {
    const result = await advantageEmailSyncHandler({ data: { tenantId: 't1', triggeredBy: 'test' } });
    return { result, notes: db.captured.runUpdate?.notes || '', captured: db.captured, mailbox };
  } finally {
    db.restore();
    svc.__testHooks.setImapFactory(null);
    svc.__testHooks.setCredentialsResolver(null);
    delete process.env.ADVANTAGE_EMAIL_ALLOWED_SENDERS;
  }
}

// ---------------------------------------------------------------------------
// 1. The happy path, and the money posture inside it.
// ---------------------------------------------------------------------------

test('a confirmation email stages one reservation, routed on (tsdNumber, branch)', async () => {
  const { result, captured, mailbox } = await run([message(BODY)]);

  assert.equal(result.messagesSeen, 1);
  assert.equal(result.pickupsFound, 1);
  assert.equal(result.newlyInserted, 1);
  assert.equal(result.quarantined, 0);
  assert.equal(result.needsReview, 1, 'no customer to match → review, not a silent drop');
  assert.equal(result.status, 'OK');

  const staged = captured.upserts[0].create;
  assert.equal(staged.externalRef, 'AEXP141D54');
  assert.equal(staged.sourceSystem, 'ADVANTAGE', 'shares the portal path\'s staging identity');
  assert.equal(staged.pickupLocation, '61302.MCO');
  assert.equal(staged.vehicleAcriss, 'IFAR');
  assert.equal(staged.channel, 'AMADEUS');
  assert.equal(staged.supplierRef, 'A8CDJM');
  assert.equal(staged.pickupAt.toISOString(), '2026-09-03T13:00:00.000Z');

  // The message is flagged read only AFTER it was recorded.
  assert.deepEqual(mailbox.seen, [1]);
  assert.equal(captured.inbound[0].status, 'IMPORTED');
});

test('MONEY: estimatedTotal is the rate x days, never the card deposit on the same page', async () => {
  const { captured } = await run([message(BODY)]);
  const staged = captured.upserts[0].create;

  assert.equal(Number(staged.totalAmount), 73.6);
  assert.notEqual(Number(staged.totalAmount), 381.8);
  assert.equal(staged.currency, 'USD');
  assert.equal(staged.isPrepaid, false);

  // Nothing that moves money or a car may appear on a staged import.
  for (const forbidden of ['charges', 'fees', 'paidAmount', 'deposit', 'vehicleId', 'cardToken', 'paymentReference']) {
    assert.equal(forbidden in staged, false, `${forbidden} must never be written by an import`);
  }

  // The deposit and the extras ARE recorded — read-only, in rawJson.
  assert.equal(staged.rawJson.payments.total, 381.8);
  assert.deepEqual(staged.rawJson.activity.extras.map((e) => e.code), ['PSP', 'DW']);
  assert.equal(staged.rawJson.agreement.unitNumber, 'RASU33');
  assert.equal(staged.rawJson.estimatedTotalBasis, 'daily_rate_x_days_pre_tax');
});

test('the reservation notes SAY what the estimate is, so 73.60 is not read as the price', () => {
  const extras = advantageEmailSourceSpec.buildReservationExtras({
    externalRef: 'AEXP141D54',
    rawJson: { estimatedTotalBasis: 'daily_rate_x_days_pre_tax' },
  });
  assert.equal(
    extras.notes,
    'Imported from Advantage (email) — AEXP141D54 (pay-at-destination)'
    + ' — estimate is the daily rate x days, BEFORE tax and any counter extras',
  );
  assert.equal(extras.isPrepaid, false);
  assert.equal(estimateCaveat('unavailable'), ' — no rate estimate available from the email');
  assert.equal(estimateCaveat(undefined), ' — no rate estimate available from the email');
});

test('the travel agency\'s Phone never becomes the renter\'s phone', async () => {
  const { captured } = await run([message(BODY)]);
  const staged = captured.upserts[0].create;

  assert.equal(staged.customerPhone, '17875550142', 'Home Phone — the renter');
  assert.notEqual(staged.customerPhone, '1404728-8787', 'that is EXPEDIA.COM\'s switchboard');
  assert.equal(staged.rawJson.bookingSource.phone, '1404728-8787');
  assert.equal(staged.customerEmail, 'TESTER.SAMPLE@EXAMPLE.COM');
  assert.equal(staged.customerFirstName, 'TESTER');
  assert.equal(staged.customerLastName, 'SAMPLE');
});

// ---------------------------------------------------------------------------
// 2-4. The refusals.
// ---------------------------------------------------------------------------

test('an unrecognised banner is QUARANTINED, not read as a confirmation', async () => {
  const { result, captured, notes, mailbox } = await run([
    message(BODY.replace('***CONFIRMATION***', '***NO SHOW***')),
  ]);

  assert.equal(result.quarantined, 1);
  assert.equal(result.pickupsFound, 0);
  assert.equal(captured.upserts.length, 0, 'nothing may be staged from a document we cannot classify');
  assert.equal(result.status, 'ATTENTION', 'a refusal is unfinished work, not a green run');
  assert.match(notes, /QUARANTINED 1 message\(s\) — unknown_doc_type x1/);
  assert.match(notes, /NO SHOW/);
  assert.equal(captured.inbound[0].status, 'QUARANTINED');
  assert.equal(captured.inbound[0].failureReason, 'unknown_doc_type');
  // Still flagged read: it is recorded, and re-reading it every 15 minutes
  // would only re-refuse it.
  assert.deepEqual(mailbox.seen, [1]);
});

test('an email for a branch nobody mapped is QUARANTINED', async () => {
  // Also the security case: a stranger who finds the mailbox address still has
  // to guess a (tsdNumber, branch) pair this tenant has explicitly enabled.
  const { result, captured, notes } = await run(
    [message(BODY)],
    { configs: [{ tsdNumber: '99999', branch: 'TPA', locationId: 'loc-tpa' }] },
  );

  assert.equal(result.quarantined, 1);
  assert.equal(captured.upserts.length, 0);
  assert.equal(captured.inbound[0].failureReason, 'location_not_configured');
  assert.match(notes, /no enabled AdvantageLocationConfig for 61302\.MCO/);
});

test('a sender outside the allowlist is QUARANTINED before the body is even parsed', async () => {
  process.env.ADVANTAGE_EMAIL_ALLOWED_SENDERS = 'advantage.com';
  const { result, captured } = await run([
    message(BODY, { from: 'attacker@elsewhere.test' }),
  ]);
  assert.equal(result.quarantined, 1);
  assert.equal(captured.upserts.length, 0);
  assert.equal(captured.inbound[0].failureReason, 'sender_not_allowed');
});

test('with no allowlist set the run notes SAY the mailbox is unrestricted', async () => {
  const { notes } = await run([message(BODY)]);
  assert.match(notes, /senders UNRESTRICTED/);
});

test('a message with no text/plain part is QUARANTINED rather than guessed at', async () => {
  const html = Buffer.from(
    'Message-ID: <h1@advantage.com>\r\nFrom: rez@advantage.com\r\n'
    + 'Content-Type: text/html; charset=utf-8\r\n\r\n<html><body>nope</body></html>',
    'binary',
  );
  const { result, captured } = await run([html]);
  assert.equal(result.quarantined, 1);
  assert.equal(captured.inbound[0].failureReason, 'no_text_body');
});

test('a document missing required fields is QUARANTINED with the layout reason', async () => {
  const gutted = BODY.replace(/^Pickup Date.*$/m, 'Pickup Date       :');
  const { result, captured, notes } = await run([message(gutted)]);
  assert.equal(result.quarantined, 1);
  assert.equal(captured.inbound[0].failureReason, 'layout');
  assert.match(notes, /Pickup Date/);
});

// ---------------------------------------------------------------------------
// 5. Idempotency, both directions.
// ---------------------------------------------------------------------------

test('an identical re-delivery does nothing at all', async () => {
  const raw = message(BODY);
  const { text } = await import('./mime-text.js').then((m) => ({ text: m.extractMessage(raw).text }));
  const { result, captured } = await run([raw], {
    priorInbound: { bodyHash: hashBody(text), status: 'IMPORTED' },
  });
  assert.equal(result.duplicates, 1);
  assert.equal(result.pickupsFound, 0);
  assert.equal(captured.upserts.length, 0, 'a byte-identical re-send must not touch the staged row');
});

test('the SAME Message-ID with a CHANGED body is re-parsed — the document is a snapshot', async () => {
  // The supplied sample proves this happens: it is banner-dated at booking time
  // (2026/08/07) yet already carries the 2026/09/03 pickup, the assigned unit
  // and the deposit. A later copy has to be allowed to enrich the row.
  const { result, captured } = await run([message(BODY)], {
    priorInbound: { bodyHash: 'a-different-hash', status: 'IMPORTED' },
  });
  assert.equal(result.duplicates, 0);
  assert.equal(captured.upserts.length, 1);
});

test('a second copy of a row we already promoted refreshes staging and leaves the Reservation alone', async () => {
  const { result, captured } = await run([message(BODY)], {
    existingExternal: { tenantId: 't1', promotionStatus: 'AUTO_PROMOTED' },
  });
  assert.equal(result.updatedExisting, 1);
  assert.equal(result.newlyInserted, 0);
  assert.equal(result.autoPromoted, 0);
  assert.equal(result.needsReview, 0);
  assert.equal(captured.updates.length, 0, 'the live Reservation is not touched');
});

test('a confirmation already staged under ANOTHER tenant is refused, never overwritten', async () => {
  const { result, captured } = await run([message(BODY)], {
    existingExternal: { tenantId: 'someone-else', promotionStatus: 'PENDING' },
  });
  assert.equal(result.skippedCrossTenant, 1);
  assert.equal(captured.upserts.length, 0);
  assert.equal(captured.inbound[0].failureReason, 'cross_tenant');
});

// ---------------------------------------------------------------------------
// 6. Cancellation.
// ---------------------------------------------------------------------------

test('a cancellation email stages the row and REJECTS it', async () => {
  const { result, captured } = await run([
    message(BODY.replace('***CONFIRMATION***', '***CANCELLATION***')),
  ]);
  assert.equal(result.rejectedCancelled, 1);
  assert.equal(result.needsReview, 0);
  assert.equal(result.autoPromoted, 0);
  assert.equal(captured.updates[0].promotionStatus, 'REJECTED');
  assert.equal(captured.updates[0].rejectedReason, 'source_cancelled');
});

test('a cancellation for an ALREADY-PROMOTED reservation leaves it live — and says so', async () => {
  // Cancelling a live rental is an ops/money decision, not an importer's. The
  // point is that "we deliberately did nothing" is a number and a sentence, not
  // a log line nobody reads.
  const { result, captured, notes } = await run(
    [message(BODY.replace('***CONFIRMATION***', '***CANCELLATION***'))],
    { existingExternal: { tenantId: 't1', promotionStatus: 'PROMOTED' } },
  );
  assert.equal(result.cancelledAfterPromote, 1);
  assert.equal(result.rejectedCancelled, 0);
  assert.equal(captured.updates.length, 0, 'the live Reservation must not be touched');
  assert.match(notes, /cancellation email\(s\) arrived for reservation\(s\) already promoted/);
  assert.match(notes, /was NOT touched/);
});

// ---------------------------------------------------------------------------
// 7. Failure leaves work to redo, never work lost.
// ---------------------------------------------------------------------------

test('a message that blows up is NOT flagged read, so the next run retries it', async () => {
  const { result, mailbox } = await run(
    [message(BODY, { messageId: '<one@advantage.com>' }), message(BODY, { messageId: '<two@advantage.com>' })],
    {},
    { failFetchOn: 1 },
  );
  assert.equal(result.errorsCount, 1);
  assert.deepEqual(mailbox.seen, [2], 'only the message that succeeded is flagged');
  assert.equal(result.status, 'PARTIAL', 'one worked, one did not');
});

// ---------------------------------------------------------------------------
// The pure helpers.
// ---------------------------------------------------------------------------

test('routing helpers normalize the pair the way AdvantageLocationConfig stores it', () => {
  assert.equal(routeKey('61302', 'mco'), '61302.MCO');
  assert.equal(routeKey(' 61302 ', ' MCO '), '61302.MCO');
  const map = buildRouteMap([
    { tsdNumber: '61302', branch: 'MCO', locationId: 'loc-mco' },
    { tsdNumber: '61302', branch: 'TPA', locationId: null }, // no location → not routable
  ]);
  assert.equal(map.get('61302.MCO'), 'loc-mco');
  assert.equal(map.has('61302.TPA'), false);
});

test('messageKey falls back to a stable synthetic id when the server sends none', () => {
  assert.equal(messageKey('<a@b>', { mailbox: 'INBOX', uid: 7 }), '<a@b>');
  assert.equal(messageKey('', { mailbox: 'INBOX', uid: 7 }), 'uid:INBOX:7');
  assert.equal(messageKey(null, { mailbox: 'Advantage', uid: 12 }), 'uid:Advantage:12');
});

test('hashBody ignores the line-ending the transport happened to use', () => {
  assert.equal(hashBody('a\r\nb'), hashBody('a\nb'));
  assert.notEqual(hashBody('a\nb'), hashBody('a\nc'));
});

test('mapDocToExternalReservation keeps the whole document, and only the estimate as money', () => {
  const doc = parseAdvantageEmail(BODY);
  const mapped = mapDocToExternalReservation(doc);
  assert.equal(mapped.totalAmount, 73.6);
  assert.equal(mapped.subBrand, 'ADVANTAGE');
  assert.equal(mapped.status, 'CONFIRMATION');
  assert.equal(mapped.rawJson.transport, 'email');
  assert.equal(mapped.rawJson.bookingSource.name, 'EXPEDIA.COM');
  assert.equal(mapped.vehicleDescription, '2024 NISSAN ROGUE');
});
