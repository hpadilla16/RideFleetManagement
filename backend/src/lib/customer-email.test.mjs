/**
 * The gate that closes the 2026-08-31 sealed-without-sending incident at the
 * CAPTURE end. 54 contracts sealed with nothing sent; 20 of them carried a
 * present-but-invalid address that MailerSend answered with 422 / MS42208, the
 * best specimen being a contract addressed to `GERENTE VOLVO`.
 *
 * Pure — no Prisma, no Express, no mailer. Run:
 *   node --test src/lib/customer-email.test.mjs
 * Wired as `npm run test:customer-email`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeCustomerEmail,
  assertCustomerEmail,
  importCustomerEmailOrNull,
  maskCustomerEmail,
  messageFor,
  CustomerEmailError,
  CUSTOMER_EMAIL_INVALID,
} from './customer-email.js';
import { AppError, ValidationError, appErrorHandler } from './errors.js';

// ---------------------------------------------------------------------------
// The specimen. Everything else in this file is scaffolding around this line.
// ---------------------------------------------------------------------------
const GERENTE_VOLVO = 'GERENTE VOLVO';

test('the incident: "GERENTE VOLVO" is not an email address', () => {
  const verdict = normalizeCustomerEmail(GERENTE_VOLVO);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.email, null);
  assert.equal(verdict.code, CUSTOMER_EMAIL_INVALID);
});

// ---------------------------------------------------------------------------
// REJECTED. Every one of these is a shape MailerSend answers with MS42208 — or
// a shape that would silently address the wrong mailbox.
// ---------------------------------------------------------------------------
const REJECTED = [
  ['free text with a space', GERENTE_VOLVO],
  ['a bare name', 'Juan Perez'],
  ['a phone number typed into the email box', '787-555-1234'],
  ['no @ at all', 'juanperez.com'],
  ['no domain', 'juan@'],
  ['no local part', '@example.com'],
  ['two @', 'juan@@example.com'],
  ['two addresses joined by a comma', 'a@example.com,b@example.com'],
  ['a display-name header', 'Juan Perez <juan@example.com>'],
  ['a space inside the local part', 'juan perez@example.com'],
  ['a tab', 'juan\t@example.com'],
  ['a newline (header injection)', 'juan@example.com\nbcc: x@y.com'],
  ['no dot in the domain', 'juan@localhost'],
  ['a one-letter TLD', 'juan@example.c'],
  ['a numeric TLD', 'juan@example.123'],
  ['a leading dot in the domain', 'juan@.example.com'],
  ['a trailing dot', 'juan@example.com.'],
  ['a double dot in the domain', 'juan@example..com'],
  ['a leading dot in the local part', '.juan@example.com'],
  ['a hyphen-led domain label', 'juan@-example.com'],
  ['a local part over 64 chars', `${'a'.repeat(65)}@example.com`],
  ['an address over 254 chars', `juan@${'a'.repeat(250)}.com`],
];

for (const [why, value] of REJECTED) {
  test(`rejected — ${why}: ${JSON.stringify(value)}`, () => {
    const verdict = normalizeCustomerEmail(value);
    assert.equal(verdict.ok, false, `expected ${JSON.stringify(value)} to be refused`);
    assert.equal(verdict.email, null);
  });
}

// ---------------------------------------------------------------------------
// ACCEPTED. The other half of the job: this must NOT become a purist parser
// that turns a mail bug into a booking-refusal bug. Odd-but-legal passes.
// ---------------------------------------------------------------------------
const ACCEPTED = [
  ['the plus-tag + subdomain case named in the brief', 'user+tag@sub.dominio.co', 'user+tag@sub.dominio.co'],
  ['uppercase is normalized', 'Jane.Doe@Example.COM', 'jane.doe@example.com'],
  ['surrounding whitespace is trimmed', '  jane@example.com  ', 'jane@example.com'],
  ['the shortest realistic address', 'a@b.co', 'a@b.co'],
  ['a long TLD', 'curator@museum-of-cars.museum', 'curator@museum-of-cars.museum'],
  ['a hyphenated domain', 'jane@rent-a-ride.com', 'jane@rent-a-ride.com'],
  ['underscores and digits', 'jane_doe99@example.com', 'jane_doe99@example.com'],
  ['apostrophes (O\'Brien signs up)', "j.o'brien@example.com", "j.o'brien@example.com"],
  ['several subdomains', 'ops@mail.corp.example.co.uk', 'ops@mail.corp.example.co.uk'],
  ['a dashed local part', 'jane-doe@example.com', 'jane-doe@example.com'],
  // Not hypothetical: a read-only sweep of production on 2026-09-01 found an
  // accented character inside a real, working local part. This deployment is in
  // Puerto Rico — an ASCII-only rule would refuse live customers.
  ['an accented local part (Spanish names are the norm here)', 'nuñez@example.com', 'nuñez@example.com'],
];

for (const [why, value, expected] of ACCEPTED) {
  test(`accepted — ${why}: ${JSON.stringify(value)}`, () => {
    const verdict = normalizeCustomerEmail(value);
    assert.equal(verdict.ok, true, `expected ${JSON.stringify(value)} to be accepted`);
    assert.equal(verdict.email, expected);
  });
}

// ---------------------------------------------------------------------------
// Empty is not an error. Capturing an address is optional today; this module's
// job is to reject non-addresses, not to invent a requirement. But it must
// collapse to an explicit null — "" is what let a blank field reach the mailer
// as a present-but-unusable recipient.
// ---------------------------------------------------------------------------
for (const empty of [null, undefined, '', '   ', '\t\n']) {
  test(`empty passes as an explicit null: ${JSON.stringify(empty)}`, () => {
    const verdict = normalizeCustomerEmail(empty);
    assert.equal(verdict.ok, true);
    assert.equal(verdict.email, null);
  });
}

test('normalization is idempotent — normalizing twice changes nothing', () => {
  for (const [, value] of ACCEPTED) {
    const once = normalizeCustomerEmail(value).email;
    const twice = normalizeCustomerEmail(once).email;
    assert.equal(twice, once);
  }
});

// ---------------------------------------------------------------------------
// STAFF and CUSTOMER: one rule, one machine code, two sentences.
// ---------------------------------------------------------------------------
test('staff capture: assert throws 400 + CUSTOMER_EMAIL_INVALID', () => {
  assert.throws(
    () => assertCustomerEmail(GERENTE_VOLVO, { audience: 'staff' }),
    (err) => {
      assert.ok(err instanceof CustomerEmailError);
      assert.equal(err.status, 400);
      assert.equal(err.statusCode, 400);
      assert.equal(err.code, CUSTOMER_EMAIL_INVALID);
      assert.equal(err.message, messageFor('staff'));
      return true;
    },
  );
});

test('customer capture: same code, its own sentence', () => {
  assert.throws(
    () => assertCustomerEmail(GERENTE_VOLVO, { audience: 'customer' }),
    (err) => {
      assert.equal(err.code, CUSTOMER_EMAIL_INVALID);
      assert.equal(err.message, messageFor('customer'));
      return true;
    },
  );
});

test('the two audiences really say different things', () => {
  assert.notEqual(messageFor('staff'), messageFor('customer'));
  // Both have to name the shape, since that is the only actionable part.
  for (const audience of ['staff', 'customer']) {
    assert.match(messageFor(audience), /name@example\.com/);
  }
  // No internal vocabulary in the sentence the CUSTOMER reads.
  assert.doesNotMatch(messageFor('customer'), /null|column|MailerSend|422|invalid input/i);
});

test('an unknown audience falls back to the staff wording, it does not throw', () => {
  assert.equal(messageFor('martian'), messageFor('staff'));
  assert.equal(messageFor(), messageFor('staff'));
});

test('assert returns the normalized address, and null for empty', () => {
  assert.equal(assertCustomerEmail('  Jane@Example.COM '), 'jane@example.com');
  assert.equal(assertCustomerEmail(''), null);
  assert.equal(assertCustomerEmail(null), null);
});

test('assert defaults to the STAFF audience when none is given', () => {
  assert.throws(
    () => assertCustomerEmail(GERENTE_VOLVO),
    (err) => err.message === messageFor('staff'),
  );
});

// ---------------------------------------------------------------------------
// The error has to reach the client as a 400 with its code — that is the whole
// point of routes being able to just `next(e)`.
// ---------------------------------------------------------------------------
test('CustomerEmailError is an AppError, so appErrorHandler answers 400 with the code', () => {
  const err = new CustomerEmailError('customer');
  assert.ok(err instanceof AppError);
  assert.ok(err instanceof ValidationError);

  let status = null; let body = null;
  const res = { status(s) { status = s; return this; }, json(b) { body = b; return this; }, set() { return this; } };
  appErrorHandler(err, {}, res, () => { throw new Error('must not fall through to the 500 handler'); });

  assert.equal(status, 400);
  assert.equal(body.error, messageFor('customer'));
  assert.equal(body.code, CUSTOMER_EMAIL_INVALID);
});

test('appErrorHandler still omits `code` for AppErrors that carry none', () => {
  let body = null;
  const res = { status() { return this; }, json(b) { body = b; return this; }, set() { return this; } };
  appErrorHandler(new ValidationError('plain'), {}, res, () => {});
  assert.deepEqual(body, { error: 'plain' });
});

// ---------------------------------------------------------------------------
// IMPORT / OTA: never throws, always leaves a trace.
// ---------------------------------------------------------------------------
function captureLog() {
  const warns = [];
  return { log: { warn: (msg, meta) => warns.push({ msg, meta }) }, warns };
}

test('OTA: an invalid address is stored as null, and the batch survives', () => {
  const { log, warns } = captureLog();
  const out = importCustomerEmailOrNull(GERENTE_VOLVO, {
    log, source: 'tl-international', tenantId: 't1', externalRef: 'TL-9911',
  });
  assert.equal(out, null);
  assert.equal(warns.length, 1);
});

test('OTA: the warning names the tenant and the row, and masks the address', () => {
  const { log, warns } = captureLog();
  importCustomerEmailOrNull('GERENTE VOLVO', {
    log, source: 'mex', tenantId: 'tenant-7', externalRef: 'MX-42',
  });
  const { meta } = warns[0];
  assert.equal(meta.source, 'mex');
  assert.equal(meta.tenantId, 'tenant-7');
  assert.equal(meta.externalRef, 'MX-42');
  assert.equal(meta.code, CUSTOMER_EMAIL_INVALID);
  // Masked, and NOT under a key named `email` — lib/logger.js blanks that key,
  // which would make the warning say nothing at all.
  assert.equal(meta.emailMasked, 'G***');
  assert.equal(meta.email, undefined);
});

test('OTA: a valid address passes through normalized and logs nothing', () => {
  const { log, warns } = captureLog();
  assert.equal(importCustomerEmailOrNull(' Ana@Example.COM ', { log }), 'ana@example.com');
  assert.equal(warns.length, 0);
});

test('OTA: an EMPTY address is not an anomaly — null, no warning', () => {
  const { log, warns } = captureLog();
  assert.equal(importCustomerEmailOrNull(null, { log }), null);
  assert.equal(importCustomerEmailOrNull('', { log }), null);
  assert.equal(warns.length, 0, 'a source that simply has no email must not spam the log');
});

test('OTA: the odd-but-legal address is accepted here too, not only at the counter', () => {
  const { log, warns } = captureLog();
  assert.equal(importCustomerEmailOrNull('user+tag@sub.dominio.co', { log }), 'user+tag@sub.dominio.co');
  assert.equal(warns.length, 0);
});

test('OTA: it never throws, even with no logger and a hostile value', () => {
  for (const value of [GERENTE_VOLVO, {}, [], 0, false, Symbol.iterator ? 'a@b' : 'a@b']) {
    assert.doesNotThrow(() => importCustomerEmailOrNull(value));
  }
  assert.equal(importCustomerEmailOrNull(GERENTE_VOLVO), null);
});

// ---------------------------------------------------------------------------
// Masking. A log line is only useful if ops can recognise the row in the source
// system, and only safe if it is not PII.
// ---------------------------------------------------------------------------
test('maskCustomerEmail keeps the domain and one letter', () => {
  assert.equal(maskCustomerEmail('jane@acme.com'), 'j***@acme.com');
  assert.equal(maskCustomerEmail('GERENTE VOLVO'), 'G***');
  assert.equal(maskCustomerEmail(''), '');
  assert.equal(maskCustomerEmail(null), '');
  assert.equal(maskCustomerEmail(undefined), '');
});

test('maskCustomerEmail never leaks the local part beyond its first character', () => {
  const masked = maskCustomerEmail('averylongandidentifiablelocalpart@example.com');
  assert.equal(masked, 'a***@example.com');
  assert.doesNotMatch(masked, /verylong/);
});

// ---------------------------------------------------------------------------
// Non-string inputs must not crash a write path.
// ---------------------------------------------------------------------------
test('non-string inputs are refused, not thrown on', () => {
  for (const value of [{}, [], 42, true, () => {}]) {
    const verdict = normalizeCustomerEmail(value);
    assert.equal(verdict.ok, false, `expected ${String(value)} to be refused`);
  }
});
