/**
 * THE RATCHET behind lib/customer-email.js.
 *
 * A shared validator is only a control if every writer actually calls it. The
 * 2026-08-31 incident is what a partial fix looks like: three files in this
 * backend already carried their own "is this an address?" regex, and eleven
 * others carried none — so `GERENTE VOLVO` walked in through one of the eleven
 * and out through MailerSend as a 422. This project has paid for that shape
 * before (lib/tenant-provider-credential.js: the inherited-credential bug
 * shipped TWICE because the fix was applied per call site).
 *
 * So the inventory in lib/customer-email.js is not a comment that has to keep
 * itself honest. This suite:
 *   1. re-derives the set of files that write Customer.email /
 *      RentalAgreement.customerEmail and fails when it stops matching the
 *      declared list — a NEW writer cannot ship unclassified;
 *   2. asserts every declared capture site still imports the shared gate — so
 *      reverting any ONE of them fails the build;
 *   3. asserts the POLICY marker each site is supposed to carry (reject vs.
 *      null-and-warn), so swapping one policy for the other fails too;
 *   4. exercises the two writers that can be run without a database, end to
 *      end, against the specimen.
 *
 * No DB, no network. Run: node --test src/lib/customer-email-writers.test.mjs
 * Wired as `npm run test:customer-email-writers`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, sep, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = fileURLToPath(new URL('../', import.meta.url));
const GERENTE_VOLVO = 'GERENTE VOLVO';
const GATE = 'lib/customer-email.js';

// ---------------------------------------------------------------------------
// The declared inventory. Keep in lockstep with the header of
// lib/customer-email.js — the numbering is the same.
// ---------------------------------------------------------------------------

/** Sites that CAPTURE from a keyboard and must call the shared gate. */
const CAPTURE_WRITERS = {
  // n: [path, policy marker that must appear in the file]
  1: ['modules/customers/customers.service.js', 'assertCustomerEmail'],
  2: ['modules/customers/customers.service.js', 'assertCustomerEmail'],
  3: ['modules/customers/vozia-customer-patch.js', 'normalizeCustomerEmail'],
  4: ['modules/reservations/reservations.routes.js', 'CUSTOMER_EMAIL_INVALID'],
  5: ['modules/rental-agreements/rental-agreements.service.js', 'assertCustomerEmail'],
  6: ['modules/dealership-loaner/dealership-loaner.service.js', 'assertCustomerEmail'],
  7: ['modules/quotes/quotes.service.js', 'CUSTOMER_EMAIL_INVALID'],
  8: ['modules/customer-portal/customer-portal.routes.js', "messageFor('customer')"],
  9: ['modules/public-booking/public-booking.service.js', "audience: 'customer'"],
  10: ['modules/booking-engine/booking-engine.service.js', "audience: 'customer'"],
  16: ['modules/customers/customers.service.js', 'normalizeCustomerEmail'],
};

/** Sites that IMPORT and must NEVER reject the batch. */
const IMPORT_WRITERS = {
  11: 'modules/integrations/booking-source/customer-autocreate.js',
  12: 'modules/integrations/economy/economy.worker.js',
  13: 'modules/integrations/nu/nu.worker.js',
  14: 'modules/integrations/tl-international/tl-international.worker.js',
  15: 'modules/reservations/reservations.service.js',
};

/**
 * Files that write one of the two columns but are NOT capture — a copy, a
 * snapshot, or a clear. Each is argued in the header of lib/customer-email.js.
 * They are listed so the scan below has a complete picture and an UNEXPLAINED
 * hit is what fails, not merely an unguarded one.
 */
const NOT_CAPTURE = new Set([
  // Snapshots reservation.customer.email onto the contract. Guarding it would
  // refuse to open an agreement for the customers whose STORED address is
  // already bad — a mail bug turned into a counter outage.
  'modules/rental-agreements/rental-agreements.service.js',
  // Clones an existing row's email during a kiosk name correction.
  'modules/kiosk/kiosk-name-update.service.js',
  // The anonymiser: writes `email: null`.
  'modules/public-booking/account-deletion.service.js',
]);

// ---------------------------------------------------------------------------
// The scan. Same shape as the one that produced the inventory: a Prisma write
// on Customer / RentalAgreement whose payload names email or customerEmail.
// Deliberately not an AST parse — a guard that is expensive to keep is a guard
// that gets deleted.
// ---------------------------------------------------------------------------
const WRITE_CALL = /\b(?:tx|db|prisma|prismaClient|client)\.(customer|rentalAgreement)\.(create|update|upsert|createMany|updateMany)\b/;
const EMAIL_KEY = /(^|[\s{,])(email|customerEmail)\s*(:|,|\r?\n|\})/m;
const PAYLOAD_WINDOW = 45;

function sourceFiles(dir = SRC, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules') continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) { sourceFiles(full, out); continue; }
    if (!name.endsWith('.js')) continue;              // .mjs here is tests only
    if (name.includes('.test.')) continue;
    out.push(full);
  }
  return out;
}

function rel(full) {
  return relative(SRC, full).split(sep).join('/');
}

function scanWriters() {
  const found = new Set();
  for (const full of sourceFiles()) {
    const lines = readFileSync(full, 'utf8').split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      if (!WRITE_CALL.test(lines[i])) continue;
      const window = lines.slice(i, i + PAYLOAD_WINDOW).join('\n');
      if (!EMAIL_KEY.test(window)) continue;
      found.add(rel(full));
    }
  }
  return found;
}

const DECLARED = new Set([
  ...Object.values(CAPTURE_WRITERS).map(([path]) => path),
  ...Object.values(IMPORT_WRITERS),
  ...NOT_CAPTURE,
]);

test('RATCHET: no file writes a customer email without being classified', () => {
  const found = scanWriters();
  const unclassified = [...found].filter((f) => !DECLARED.has(f)).sort();
  assert.deepEqual(
    unclassified,
    [],
    'These files write Customer.email or RentalAgreement.customerEmail and are not in the '
    + `inventory in ${GATE}. Classify each one there (staff / customer / import / not-capture) `
    + `and add it to this test — do not delete this assertion:\n  ${unclassified.join('\n  ')}`,
  );
});

/**
 * Writers the scan CANNOT see, and why. Both build their Prisma payload
 * indirectly, so no literal `email:` key ever sits near the write call:
 *   - vozia-customer-patch.js writes `data: { [field]: value }` — a computed key.
 *   - reservations.routes.js accumulates `customerUpdate[key]` in a loop and
 *     passes the object.
 * This is not trivia. It is the reason a grep-only census is not a census: both
 * of these DO write Customer.email from a keyboard, and a scan-only inventory
 * would have shipped with two staff doors still open. They stay declared, they
 * are still covered by the per-writer import/marker assertions above, and they
 * are named here so nobody "prunes" them back out.
 */
const SCAN_INVISIBLE = new Set([
  'modules/customers/vozia-customer-patch.js',
  'modules/reservations/reservations.routes.js',
]);

test('RATCHET: the inventory has no stale entries either', () => {
  const found = scanWriters();
  for (const path of SCAN_INVISIBLE) found.add(path);
  // A declared path that no longer writes an email is not harmless: it means the
  // inventory is describing a world that has moved, which is how the NEXT
  // reader stops trusting the whole list.
  const stale = [...DECLARED].filter((f) => !found.has(f)).sort();
  assert.deepEqual(
    stale,
    [],
    `Declared in ${GATE} but no longer writing a customer email — re-check and prune:\n  ${stale.join('\n  ')}`,
  );
});

// ---------------------------------------------------------------------------
// Reverting ANY single site has to fail the build. That is what these two do.
// ---------------------------------------------------------------------------
for (const [n, [path, marker]] of Object.entries(CAPTURE_WRITERS)) {
  test(`writer #${n} (${path}) still routes through the shared gate`, () => {
    const src = readFileSync(join(SRC, path), 'utf8');
    assert.match(src, /customer-email\.js/, `${path} must import ${GATE}`);
    assert.ok(
      src.includes(marker),
      `${path} lost its policy marker ${JSON.stringify(marker)} — writer #${n} is no longer `
      + 'refusing a bad address at capture.',
    );
  });
}

for (const [n, path] of Object.entries(IMPORT_WRITERS)) {
  test(`writer #${n} (${path}) drops-and-warns instead of refusing the batch`, () => {
    const src = readFileSync(join(SRC, path), 'utf8');
    assert.match(src, /customer-email\.js/, `${path} must import ${GATE}`);
    assert.ok(
      src.includes('importCustomerEmailOrNull'),
      `${path} must use importCustomerEmailOrNull. A reservation from an OTA with NO email is `
      + 'worth more than a reservation we refused to import.',
    );
    assert.ok(
      !src.includes('assertCustomerEmail'),
      `${path} must NOT use assertCustomerEmail — one bad cell would cost the whole batch.`,
    );
  });
}

test('no customer-email writer grows its own local regex again', () => {
  // vozia-customer-patch.js used to carry its own copy of this exact regex,
  // which is how the rule drifted: three independent copies, eleven writers with
  // none. If a copy comes back inside a WRITER, it will drift again.
  //
  // Scoped to the declared writers on purpose. The same shape still lives in
  // incident-report.service.js, public-booking.service.js (submitBookingDocuments)
  // and shuttle-zone-alerts.js — those validate an ad-hoc RECIPIENT for one send,
  // not a customer address being captured into a column, so they are a separate
  // consolidation and not this incident.
  //
  // One declared writer is exempt, with its reason spelled out rather than by
  // quietly narrowing the scan: public-booking.service.js also hosts
  // submitContactMessage(), the website contact form. That regex checks a
  // VISITOR's reply-to address for a one-off message to the tenant's admins; it
  // is never written to Customer.email and has nothing to do with a sealed
  // contract. Consolidating the ad-hoc recipient checks is its own change.
  const REGEX_ALLOWED = new Set(['modules/public-booking/public-booking.service.js']);

  const offenders = [];
  for (const path of DECLARED) {
    if (REGEX_ALLOWED.has(path)) continue;
    const src = readFileSync(join(SRC, path), 'utf8');
    // The exact shape that existed in triplicate: a bare local@domain.tld regex.
    if (/\[\^\\s@\]\+@\[\^\\s@\]\+\\\.\[\^\\s@\]\+/.test(src)
      || /\[\^@\\s\]\+@\[\^@\\s\]\+\\\.\[\^@\\s\]\+/.test(src)) {
      offenders.push(path);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `A local email regex reappeared. Import ${GATE} instead:\n  ${offenders.join('\n  ')}`,
  );
});

// ---------------------------------------------------------------------------
// End-to-end against the specimen, for the two writers that need no database.
// ---------------------------------------------------------------------------

const { validateVoziaCustomerPatch } = await import('../modules/customers/vozia-customer-patch.js');
const { messageFor } = await import('./customer-email.js');

test('STAFF path (writer #3, VozIA customer patch): "GERENTE VOLVO" is refused', () => {
  const { errors } = validateVoziaCustomerPatch({
    email: GERENTE_VOLVO, author: 'Ana', ticketId: 'T-1',
  });
  assert.ok(errors.includes(messageFor('staff')), `expected the staff sentence, got: ${errors.join(' | ')}`);
});

test('STAFF path (writer #3): the odd-but-legal address passes, normalized', () => {
  const { errors, value } = validateVoziaCustomerPatch({
    email: 'User+Tag@Sub.Dominio.CO', author: 'Ana', ticketId: 'T-1',
  });
  assert.deepEqual(errors, []);
  assert.equal(value.value, 'user+tag@sub.dominio.co');
});

test('STAFF path (writer #3): a blank email is still refused as EMPTY, not as invalid', () => {
  const { errors } = validateVoziaCustomerPatch({ email: '  ', author: 'Ana', ticketId: 'T-1' });
  // This endpoint requires a value for `email`; the point is that it says so in
  // its own words rather than borrowing the invalid-address sentence.
  assert.ok(errors.some((e) => /requires a non-empty string/.test(e)));
  assert.ok(!errors.includes(messageFor('staff')));
});

const { maybeCreateCustomerFromSource } = await import(
  '../modules/integrations/booking-source/customer-autocreate.js'
);

function fakeCustomerPrisma(capture, { existing = null } = {}) {
  return {
    customer: {
      findFirst: async (args) => { capture.findFirst = args; return existing; },
      create: async (args) => { capture.create = args; return { id: 'cust-new', ...args.data }; },
    },
  };
}

test('OTA path (writer #11): "GERENTE VOLVO" becomes null — the reservation survives', async () => {
  const cap = {};
  const out = await maybeCreateCustomerFromSource(
    fakeCustomerPrisma(cap),
    {
      tenantId: 't1', externalRef: 'MX-42',
      customerFirstName: 'Gerente', customerLastName: 'Volvo',
      customerEmail: GERENTE_VOLVO, customerPhone: '7875551234',
    },
    { logPrefix: '[mex-sync]', sourceName: 'MEX' },
  );
  assert.ok(out, 'the customer must still be created');
  assert.equal(cap.create.data.email, null, 'the invalid address must not reach the column');
  assert.equal(cap.create.data.phone, '7875551234');
  // And the bad address must not have been used to look for an existing row.
  assert.equal(cap.findFirst, undefined);
});

test('OTA path (writer #11): the odd-but-legal address is kept and deduped on', async () => {
  const cap = {};
  await maybeCreateCustomerFromSource(
    fakeCustomerPrisma(cap),
    {
      tenantId: 't1', externalRef: 'MX-43',
      customerFirstName: 'Ana', customerLastName: 'Rivera',
      customerEmail: 'User+Tag@Sub.Dominio.CO', customerPhone: '',
    },
    { sourceName: 'MEX' },
  );
  assert.equal(cap.create.data.email, 'user+tag@sub.dominio.co');
  assert.equal(cap.findFirst.where.email.equals, 'user+tag@sub.dominio.co');
});

test('OTA path (writer #11): a row with ONLY a bad email is skipped, not created blank', async () => {
  // firstName + lastName but no phone and no usable email: this row carries no
  // way to reach the person, and the pre-existing contract for that is `null`.
  const cap = {};
  const out = await maybeCreateCustomerFromSource(
    fakeCustomerPrisma(cap),
    {
      tenantId: 't1', externalRef: 'MX-44',
      customerFirstName: 'Gerente', customerLastName: 'Volvo',
      customerEmail: GERENTE_VOLVO, customerPhone: '',
    },
    { sourceName: 'MEX' },
  );
  assert.equal(out, null);
  assert.equal(cap.create, undefined);
});
