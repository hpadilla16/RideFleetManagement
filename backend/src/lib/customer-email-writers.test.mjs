/**
 * THE INSTRUMENT behind lib/customer-email.js — and it is a BEHAVIOURAL one,
 * because the first version of this file was not, and it lied on its debut.
 *
 * WHAT THE FIRST VERSION DID, AND WHY IT WAS WORSE THAN NOTHING. It asserted
 * two substrings per writer: that the file mentioned `customer-email.js`, and
 * that it mentioned a policy marker. Both are satisfied by an IMPORT LINE, and
 * one was satisfied by a call that could not even execute — the loaner intake
 * called assertCustomerEmail without importing it, a ReferenceError that killed
 * every walk-in with a new customer, and the suite reported 25/25 green over it.
 * QA then deleted the real call from economy.worker.js, left the unused import
 * in place, and got 25/25 again: GERENTE VOLVO through Economy with CI green.
 * A guard that a comment can satisfy is not a guard. It is a decoration that
 * costs you the belief you would otherwise have spent on a real check.
 *
 * SO: every writer below is DRIVEN. The specimen goes in; the assertion is on
 * what came out — a refusal, or a null in the payload the fake Prisma captured.
 * A missing import fails. A deleted call fails. An import kept for appearances
 * fails. Nothing here can be satisfied by text.
 *
 * The scanner is still present, but its job is now narrow and honest: catch a
 * NEW writer that ships unclassified. It cannot prove the gate is called — that
 * is Part 1's job — and it cannot see every write, which is why the blind spots
 * are enumerated rather than implied.
 *
 * No database, no network: the Prisma singleton is monkey-patched per test and
 * restored in finally, the same way nu.test.mjs / booking-source.test.mjs do it.
 *
 * Run: node --test --test-force-exit src/lib/customer-email-writers.test.mjs
 * Wired as `npm run test:customer-email-writers`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, sep, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.DATABASE_URL = process.env.DATABASE_URL
  || 'postgresql://postgres:postgres@localhost:5432/customer_email_unit_only?schema=public';
process.env.INTEGRATION_ENC_KEY = process.env.INTEGRATION_ENC_KEY
  || Buffer.alloc(32, 7).toString('base64');

const SRC = fileURLToPath(new URL('../', import.meta.url));

// EVERY dynamic import happens HERE, above the first test() call, and that
// placement is load-bearing. node:test begins running as soon as a test is
// REGISTERED; with --test-force-exit the process exits once that known set
// finishes, so an `await import(...)` sitting between two test() calls means
// every test after it is never registered and never runs. The first draft of
// this file did exactly that and reported 11 of 46 tests as a clean green run.
const { prisma } = await import('./prisma.js');
const { messageFor, CUSTOMER_EMAIL_INVALID } = await import('./customer-email.js');
const { customersService } = await import('../modules/customers/customers.service.js');
const { validateVoziaCustomerPatch } = await import('../modules/customers/vozia-customer-patch.js');
const { reservationsRouter } = await import('../modules/reservations/reservations.routes.js');
const { reservationsService } = await import('../modules/reservations/reservations.service.js');
const { rentalAgreementsService } = await import('../modules/rental-agreements/rental-agreements.service.js');
const { dealershipLoanerService } = await import('../modules/dealership-loaner/dealership-loaner.service.js');
const { createQuotesService } = await import('../modules/quotes/quotes.service.js');
const { customerPortalRouter } = await import('../modules/customer-portal/customer-portal.routes.js');
const { publicBookingService } = await import('../modules/public-booking/public-booking.service.js');
const { bookingEngineService } = await import('../modules/booking-engine/booking-engine.service.js');
const { maybeCreateCustomerFromSource } = await import('../modules/integrations/booking-source/customer-autocreate.js');
const { maybeCreateCustomerFromEconomy } = await import('../modules/integrations/economy/economy.worker.js');
const { maybeCreateCustomerFromNu } = await import('../modules/integrations/nu/nu.worker.js');
const { maybeCreateCustomerFromTl } = await import('../modules/integrations/tl-international/tl-international.worker.js');
const { loanerAgreementService } = await import('../modules/dealership-loaner/loaner-agreement.service.js');


/** The specimen. A real contract went out addressed to this string. */
const SPECIMEN = 'GERENTE VOLVO';
/** Odd-but-legal: the gate must not become a purist parser. */
const ODD_BUT_LEGAL = 'User+Tag@Sub.Dominio.CO';
const ODD_BUT_LEGAL_NORMALIZED = 'user+tag@sub.dominio.co';


/** Assert an error is THE gate's refusal, and not some other 400 on the way. */
function assertRefusal(err, audience, where) {
  assert.equal(err?.code, CUSTOMER_EMAIL_INVALID,
    `${where}: expected CUSTOMER_EMAIL_INVALID, got ${err?.code} / ${err?.message}`);
  assert.equal(Number(err?.status || err?.statusCode), 400, `${where}: expected a 400`);
  assert.equal(err?.message, messageFor(audience), `${where}: wrong audience wording`);
}

async function refuses(fn, audience, where) {
  let threw = null;
  try { await fn(); } catch (e) { threw = e; }
  assert.ok(threw, `${where}: ${JSON.stringify(SPECIMEN)} was ACCEPTED — the gate is not invoked here`);
  assertRefusal(threw, audience, where);
}

/** Swap in fake model handles, run, always restore. */
async function withPrisma(models, fn) {
  const saved = {};
  for (const k of Object.keys(models)) saved[k] = prisma[k];
  Object.assign(prisma, models);
  try { return await fn(); } finally { Object.assign(prisma, saved); }
}

function capture() {
  const seen = { creates: [], updates: [] };
  seen.model = {
    create: async (args) => { seen.creates.push(args); return { id: 'new-1', ...(args?.data || {}) }; },
    update: async (args) => { seen.updates.push(args); return { id: args?.where?.id || 'row-1', ...(args?.data || {}) }; },
    updateMany: async (args) => { seen.updates.push(args); return { count: 1 }; },
    findFirst: async () => null,
    findUnique: async () => null,
    findMany: async () => [],
    count: async () => 0,
  };
  return seen;
}

// ===========================================================================
// PART 1 — BEHAVIOUR. Every writer, driven.
// ===========================================================================

// --- #1 / #2 / #16: customers.service (STAFF) ------------------------------

test('#1 customers.create — STAFF: the specimen is refused', async () => {
  const c = capture();
  await withPrisma({ customer: c.model }, async () => {
    await refuses(
      () => customersService.create({ firstName: 'A', lastName: 'B', phone: '1', email: SPECIMEN }, { tenantId: 't1' }),
      'staff', '#1 customers.create',
    );
    assert.equal(c.creates.length, 0, 'nothing may be written when the address is refused');
  });
});

test('#1 customers.create — the odd-but-legal address is stored normalized', async () => {
  const c = capture();
  await withPrisma({ customer: c.model }, async () => {
    await customersService.create(
      { firstName: 'A', lastName: 'B', phone: '1', email: ODD_BUT_LEGAL }, { tenantId: 't1' },
    );
    assert.equal(c.creates[0].data.email, ODD_BUT_LEGAL_NORMALIZED);
  });
});

test('#1 customers.create — a blank address is stored as an explicit null', async () => {
  const c = capture();
  await withPrisma({ customer: c.model }, async () => {
    await customersService.create({ firstName: 'A', lastName: 'B', phone: '1', email: '  ' }, { tenantId: 't1' });
    assert.equal(c.creates[0].data.email, null);
  });
});

test('#2 customers.update — STAFF: the specimen is refused', async () => {
  const c = capture();
  c.model.findFirst = async () => ({ id: 'cust-1', tenantId: 't1' });
  await withPrisma({ customer: c.model, rentalAgreement: capture().model }, async () => {
    await refuses(
      () => customersService.update('cust-1', { email: SPECIMEN }, { tenantId: 't1' }),
      'staff', '#2 customers.update',
    );
    assert.equal(c.updates.length, 0);
  });
});

test('#2 customers.update — a patch that never mentions email leaves it alone', async () => {
  const c = capture();
  c.model.findFirst = async () => ({ id: 'cust-1', tenantId: 't1' });
  await withPrisma({ customer: c.model, rentalAgreement: capture().model }, async () => {
    await customersService.update('cust-1', { city: 'San Juan' }, { tenantId: 't1' });
    assert.ok(c.updates.length >= 1, 'the update should have run');
    assert.ok(!('email' in c.updates[0].data), 'email must not appear in the payload at all');
  });
});

test('#16 customers bulk import — the row is marked invalid, the batch survives', async () => {
  const c = capture();
  const tenantModel = {
    findFirst: async () => ({ id: 't1', name: 'T', slug: 't' }),
    findUnique: async () => ({ id: 't1', name: 'T', slug: 't' }),
  };
  await withPrisma({ customer: c.model, tenant: tenantModel }, async () => {
    const out = await customersService.validateBulk([
      { firstName: 'Good', lastName: 'Row', phone: '111', email: ODD_BUT_LEGAL },
      { firstName: 'Bad', lastName: 'Row', phone: '222', email: SPECIMEN },
    ], { tenantId: 't1' });

    assert.equal(out.found, 2);
    assert.equal(out.rows[0].valid, true, 'the good row must survive its neighbour');
    assert.equal(out.rows[0].normalized.email, ODD_BUT_LEGAL_NORMALIZED);
    assert.equal(out.rows[1].valid, false, 'the bad row must be refused');
    assert.ok(out.rows[1].errors.includes(messageFor('staff')),
      `expected the staff sentence, got ${out.rows[1].errors.join(' | ')}`);
    assert.equal(out.rows[1].normalized.email, null, 'the bad address must not survive into the payload');
  });
});

// --- #3: vozia-customer-patch (STAFF, pure) --------------------------------

test('#3 vozia customer patch — STAFF: the specimen is refused', () => {
  const { errors } = validateVoziaCustomerPatch({ email: SPECIMEN, author: 'Ana', ticketId: 'T-1' });
  assert.ok(errors.includes(messageFor('staff')), `got: ${errors.join(' | ')}`);
});

test('#3 vozia customer patch — the odd-but-legal address passes, normalized', () => {
  const { errors, value } = validateVoziaCustomerPatch({ email: ODD_BUT_LEGAL, author: 'Ana', ticketId: 'T-1' });
  assert.deepEqual(errors, []);
  assert.equal(value.value, ODD_BUT_LEGAL_NORMALIZED);
});

// --- Express plumbing, so routes can be driven without a server ------------
function handlerFor(router, method, path) {
  const layer = router.stack.find((l) => l.route?.path === path && l.route?.methods?.[method]);
  assert.ok(layer, `no ${method.toUpperCase()} ${path} on this router — the test needs updating, not deleting`);
  const stack = layer.route.stack;
  return stack[stack.length - 1].handle;
}

function fakeRes() {
  const out = { statusCode: null, body: null };
  const res = {
    status(s) { out.statusCode = s; return res; },
    json(b) { out.body = b; return res; },
    send(b) { out.body = b; return res; },
    set() { return res; },
    out,
  };
  return res;
}

// --- #4: reservations staff-complete (STAFF, route) ------------------------

test('#4 reservations staff-complete — STAFF: the specimen is refused with the code', async () => {
  const handler = handlerFor(reservationsRouter, 'post', '/:id/precheckin/staff-complete');
  const savedGetById = reservationsService.getById;
  reservationsService.getById = async () => ({ id: 'r1', customerId: 'c1', tenantId: 't1', customer: {} });
  const c = capture();
  try {
    await withPrisma({ customer: c.model }, async () => {
      const res = fakeRes();
      await handler(
        { params: { id: 'r1' }, body: { email: SPECIMEN }, user: { role: 'ADMIN', tenantId: 't1', sub: 'u1' } },
        res,
        (e) => { throw e; },
      );
      assert.equal(res.out.statusCode, 400, 'the specimen must be refused before anything is written');
      assert.equal(res.out.body?.code, CUSTOMER_EMAIL_INVALID);
      assert.equal(res.out.body?.error, messageFor('staff'));
      assert.equal(c.updates.length, 0);
    });
  } finally {
    reservationsService.getById = savedGetById;
  }
});

// --- #5: rentalAgreements.updateCustomer (STAFF) ---------------------------

test('#5 rentalAgreements.updateCustomer — STAFF: the specimen is refused', async () => {
  const c = capture();
  await withPrisma({ rentalAgreement: c.model }, async () => {
    await refuses(
      () => rentalAgreementsService.updateCustomer('ra1', { customerFirstName: 'A', customerEmail: SPECIMEN }),
      'staff', '#5 rentalAgreements.updateCustomer',
    );
    assert.equal(c.updates.length, 0);
  });
});

test('#5 rentalAgreements.updateCustomer — an absent email leaves the column alone', async () => {
  const c = capture();
  await withPrisma({ rentalAgreement: c.model }, async () => {
    await rentalAgreementsService.updateCustomer('ra1', { customerFirstName: 'A' });
    assert.equal(c.updates[0].data.customerEmail, undefined, 'undefined is Prisma for "do not touch"');
  });
});

// --- #6: dealership loaner intake (STAFF) ----------------------------------
// THIS is the test that would have caught the missing import. It drives the real
// intake with a VALID address, which is how QA found the ReferenceError: a
// specimen-only test passes on a module that cannot execute at all.

test('#6 loaner intake — a VALID address does not blow the module up', async () => {
  const c = capture();
  await withPrisma({ customer: c.model }, async () => {
    let err = null;
    try {
      await dealershipLoanerService.intake(
        { role: 'SUPER_ADMIN' },
        { firstName: 'Ana', lastName: 'Rivera', phone: '7875551234', email: ODD_BUT_LEGAL },
      );
    } catch (e) { err = e; }
    // It will fail later on the missing vehicleTypeId — expected, and fine.
    // What must NOT happen is a ReferenceError, which is what an un-imported
    // gate produces and what a substring ratchet cannot see.
    assert.ok(!(err instanceof ReferenceError), `intake threw a ReferenceError: ${err?.message}`);
    assert.doesNotMatch(String(err?.message || ''), /is not defined/, `intake threw: ${err?.message}`);
    assert.equal(c.creates.length, 1, 'the customer is created before the vehicle checks');
    assert.equal(c.creates[0].data.email, ODD_BUT_LEGAL_NORMALIZED);
  });
});

test('#6 loaner intake — STAFF: the specimen is refused', async () => {
  const c = capture();
  await withPrisma({ customer: c.model }, async () => {
    await refuses(
      () => dealershipLoanerService.intake(
        { role: 'SUPER_ADMIN' },
        { firstName: 'Ana', lastName: 'Rivera', phone: '7875551234', email: SPECIMEN },
      ),
      'staff', '#6 loaner intake',
    );
    assert.equal(c.creates.length, 0);
  });
});

test('#6 loaner intake — a blank form still complains about the NAME first', async () => {
  // Ordering: an intake with nothing filled in should say what is actually
  // missing, not lecture about an email nobody typed.
  const c = capture();
  await withPrisma({ customer: c.model }, async () => {
    let err = null;
    try { await dealershipLoanerService.intake({ role: 'SUPER_ADMIN' }, { email: SPECIMEN }); } catch (e) { err = e; }
    assert.match(String(err?.message || ''), /first name, last name, and phone/i);
  });
});

// --- #7 / #19 / #20: quotes (STAFF, injectable deps) -----------------------

// A quote row complete enough for convert() to reach the customer block: it
// re-checks availability first, so the engine is injected rather than stubbed
// out of existence. Anything less and the test would 'pass' on an early
// VALIDATION error, never reaching the gate it claims to be checking.
const QUOTE_WINDOW = {
  pickupLocationId: 'L1',
  returnLocationId: 'L1',
  vehicleTypeId: 'V1',
  pickupAt: '2026-09-10T10:00',
  returnAt: '2026-09-12T10:00',
};

function quotesWith(quoteRow) {
  const writes = [];
  const customerWrites = [];
  const row = quoteRow ? { ...QUOTE_WINDOW, ...quoteRow } : null;
  const db = {
    quote: {
      create: async (a) => { writes.push(a); return { id: 'q1', ...a.data }; },
      update: async (a) => { writes.push(a); return { id: 'q1', ...(row || {}), ...a.data }; },
      findFirst: async () => row,
      findUnique: async () => row,
      findMany: async () => [],
    },
    vehicleType: { findMany: async () => [], findFirst: async () => null },
    customer: {
      findFirst: async () => null,
      create: async (a) => { customerWrites.push(a); return { id: 'cust-new', ...a.data }; },
    },
  };
  const bookingEngine = {
    searchRental: async () => ({
      results: [{
        vehicleType: { id: 'V1', name: 'Economy' },
        availability: { available: true, count: 3 },
        pricing: { dailyRate: 50, days: 2, subtotal: 100, taxes: 0, fees: 0, total: 100 },

      }],
    }),
  };
  const reservations = { create: async (d) => ({ id: 'res-1', reservationNumber: 'R-1', ...d }) };
  const svc = createQuotesService({
    prisma: db,
    bookingEngine,
    reservations,
    resolveTz: async () => 'America/Puerto_Rico',
  });
  return { svc, writes, customerWrites };
}

test('#19 quotes.create — STAFF: the specimen is refused at CAPTURE', async () => {
  const { svc } = quotesWith(null);
  await refuses(
    () => svc.create(
      {
        contactName: 'Ana', contactPhone: '787', contactEmail: SPECIMEN,
        pickupLocationId: 'L1', vehicleTypeId: 'V1',
        pickupAt: '2026-09-10T10:00', returnAt: '2026-09-12T10:00',
      },
      { tenantId: 't1' }, {},
    ),
    'staff', '#19 quotes.create',
  );
});

test('#20 quotes.updateContact — STAFF: the specimen is refused', async () => {
  const { svc } = quotesWith({ id: 'q1', status: 'ACTIVE', contactEmail: 'ok@example.com' });
  await refuses(
    () => svc.updateContact('Q-1', { contactEmail: SPECIMEN }, { tenantId: 't1' }),
    'staff', '#20 quotes.updateContact',
  );
});

test('#20 quotes.updateContact — the odd-but-legal address is stored normalized', async () => {
  const { svc, writes } = quotesWith({ id: 'q1', status: 'ACTIVE', contactEmail: 'ok@example.com' });
  await svc.updateContact('Q-1', { contactEmail: ODD_BUT_LEGAL }, { tenantId: 't1' });
  assert.equal(writes[0].data.contactEmail, ODD_BUT_LEGAL_NORMALIZED);
});

// MAJOR 5's regression: convert() used to police STORED data with a remedy that
// could not work. Blanking the field re-selected the stored bad value through
// `input.contactEmail || quote.contactEmail`, so '' answered 400 while '   '
// converted by accident. Both must now mean the same thing: clear it.
test('#7 quotes.convert — a blank contactEmail CLEARS, it does not resurrect the stored one', async () => {
  for (const blank of ['', '   ']) {
    const { svc } = quotesWith({ id: 'q1', status: 'ACTIVE', contactEmail: SPECIMEN });
    let err = null;
    try { await svc.convert('Q-1', { contactEmail: blank }, { tenantId: 't1' }, {}); } catch (e) { err = e; }
    assert.notEqual(err?.code, CUSTOMER_EMAIL_INVALID,
      `convert refused a request that BLANKED the field (${JSON.stringify(blank)}) — the stored value was re-selected`);
  }
});

test('#7 quotes.convert — a request that does not mention the email is not policed', async () => {
  // The stored value is a dead zone: this request never typed it.
  const { svc } = quotesWith({ id: 'q1', status: 'ACTIVE', contactEmail: SPECIMEN });
  let err = null;
  try { await svc.convert('Q-1', {}, { tenantId: 't1' }, {}); } catch (e) { err = e; }
  assert.notEqual(err?.code, CUSTOMER_EMAIL_INVALID,
    'convert refused over a stored value the request never touched');
});

test('#7 quotes.convert — a bad STORED address is nulled, not copied into a new Customer', async () => {
  // "Do not refuse" is only half the rule. The fallback feeds a BRAND NEW
  // Customer.email row, so carrying the bad address forward would seed the very
  // column this change exists to keep clean. A dead zone means do not REJECT —
  // it never meant do not CARE.
  const { svc, customerWrites } = quotesWith({
    id: 'q1', status: 'ACTIVE', contactEmail: SPECIMEN,
    contactName: 'Ana Rivera', contactPhone: '7875551234', customerId: null,
  });
  try { await svc.convert('Q-1', {}, { tenantId: 't1' }, {}); } catch { /* later steps want more fakes */ }
  assert.ok(customerWrites.length >= 1, 'the customer should have been created from the quote contact');
  assert.equal(customerWrites[0].data.email, null, 'the bad stored address was copied into a new Customer row');
});

test('#7 quotes.convert — a NEW bad address in the request IS refused', async () => {
  const { svc } = quotesWith({ id: 'q1', status: 'ACTIVE', contactEmail: 'ok@example.com' });
  await refuses(
    () => svc.convert('Q-1', { contactEmail: SPECIMEN }, { tenantId: 't1' }, {}),
    'staff', '#7 quotes.convert',
  );
});

// --- #8: customer-portal pre-check-in (CUSTOMER, route) --------------------

test('#8 customer-portal pre-check-in — CUSTOMER: the specimen gets the gentle refusal', async () => {
  const handler = handlerFor(customerPortalRouter, 'post', '/customer-info/:token');
  const c = capture();
  await withPrisma({
    reservation: { findFirst: async () => ({ id: 'r1', customerId: 'c1', tenantId: 't1', customer: {}, payments: [] }) },
    customer: c.model,
  }, async () => {
    const res = fakeRes();
    await handler(
      { params: { token: 'tok' }, body: { firstName: 'A', lastName: 'B', email: SPECIMEN, phone: '1' } },
      res,
      (e) => { throw e; },
    );
    assert.equal(res.out.statusCode, 400);
    assert.equal(res.out.body?.code, CUSTOMER_EMAIL_INVALID);
    assert.equal(res.out.body?.error, messageFor('customer'),
      'the customer must get the CUSTOMER sentence, not the counter one');
    assert.equal(c.updates.length, 0, 'refused before the first mutation');
  });
});

// --- #9: public-booking guest signup (CUSTOMER) ----------------------------

test('#9 public-booking createGuestAccount — CUSTOMER: the specimen is refused', async () => {
  const c = capture();
  await withPrisma({ customer: c.model }, async () => {
    await refuses(
      () => publicBookingService.createGuestAccount({ firstName: 'A', lastName: 'B', phone: '1', email: SPECIMEN }),
      'customer', '#9 createGuestAccount',
    );
    assert.equal(c.creates.length, 0);
  });
});

// --- #10: booking-engine public storefront booking (CUSTOMER) --------------

test('#10 booking-engine createPublicBooking — CUSTOMER: the specimen is refused', async () => {
  const c = capture();
  const tenantRow = { id: 't1', name: 'T', slug: 't' };
  await withPrisma({
    tenant: { findFirst: async () => tenantRow, findUnique: async () => tenantRow, findMany: async () => [tenantRow] },
    customer: c.model,
  }, async () => {
    await refuses(
      () => bookingEngineService.createPublicBooking({
        tenantId: 't1', searchType: 'RENTAL',
        customer: { firstName: 'A', lastName: 'B', phone: '1', email: SPECIMEN },
      }),
      'customer', '#10 createPublicBooking',
    );
    assert.equal(c.creates.length, 0);
  });
});

// --- #11..#14: the OTA workers (IMPORT — null and a warning, never a throw) -

function fakeSourcePrisma(cap, { existing = null } = {}) {
  return {
    customer: {
      findFirst: async (args) => { cap.findFirst = args; return existing; },
      create: async (args) => { cap.create = args; return { id: 'cust-new', ...args.data }; },
    },
  };
}

// Each of the four is driven SEPARATELY. They are four copies of the same
// function, and QA deleted the call from exactly one of them to prove the old
// suite could not tell them apart.
const OTA_WRITERS = [
  ['#11 customer-autocreate (advantage/flexways/mex)', (p, r) => maybeCreateCustomerFromSource(p, r, { sourceName: 'MEX' })],
  ['#12 economy.worker', (p, r) => maybeCreateCustomerFromEconomy(p, r)],
  ['#13 nu.worker', (p, r) => maybeCreateCustomerFromNu(p, r)],
  ['#14 tl-international.worker', (p, r) => maybeCreateCustomerFromTl(p, r)],
];

for (const [name, call] of OTA_WRITERS) {
  test(`${name} — IMPORT: the specimen becomes null and the reservation survives`, async () => {
    const cap = {};
    const out = await call(fakeSourcePrisma(cap), {
      tenantId: 't1', externalRef: 'X-1', reservationId: 'res-1',
      customerFirstName: 'Gerente', customerLastName: 'Volvo',
      customerEmail: SPECIMEN, customerPhone: '7875551234',
    });
    assert.ok(out, `${name}: the customer must still be created — a bad cell may not cost us the booking`);
    assert.equal(cap.create.data.email, null, `${name}: the invalid address reached the column`);
    assert.equal(cap.findFirst, undefined, `${name}: the invalid address was used as a dedupe key`);
  });

  test(`${name} — IMPORT: it never throws on the specimen`, async () => {
    await assert.doesNotReject(() => call(fakeSourcePrisma({}), {
      tenantId: 't1', externalRef: 'X-2',
      customerFirstName: 'Gerente', customerLastName: 'Volvo',
      customerEmail: SPECIMEN, customerPhone: '7875551234',
    }), `${name}: an import path must never refuse the batch`);
  });

  test(`${name} — the odd-but-legal address is kept and deduped on`, async () => {
    const cap = {};
    await call(fakeSourcePrisma(cap), {
      tenantId: 't1', externalRef: 'X-3',
      customerFirstName: 'Ana', customerLastName: 'Rivera',
      customerEmail: ODD_BUT_LEGAL, customerPhone: '',
    });
    assert.equal(cap.create.data.email, ODD_BUT_LEGAL_NORMALIZED);
    assert.equal(cap.findFirst.where.email.equals, ODD_BUT_LEGAL_NORMALIZED);
  });
}

// --- #17 / #18: LoanerAgreement.customerEmail (STAFF) ----------------------
// The THIRD column, and the one outside the first census: it feeds the loaner
// confirmation mail and loaner-reminders.scheduler directly.

function loanerReservation(customerEmail) {
  return {
    id: 'r1', tenantId: 't1', workflowMode: 'DEALERSHIP_LOANER',
    reservationNumber: 'DL-1', vehicleId: null,
    pickupAt: new Date(), returnAt: new Date(),
    customer: { email: customerEmail, phone: '787' },
  };
}

test('#17 loanerAgreement.createForReservation — STAFF: the specimen is refused', async () => {
  const c = capture();
  await withPrisma({
    reservation: { findFirst: async () => loanerReservation('ok@example.com'), findUnique: async () => loanerReservation('ok@example.com') },
    loanerAgreement: c.model,
  }, async () => {
    await refuses(
      () => loanerAgreementService.createForReservation(
        { role: 'SUPER_ADMIN', tenantId: 't1' }, 'r1',
        { customerFirstName: 'Ana', customerLastName: 'Rivera', customerEmail: SPECIMEN },
      ),
      'staff', '#17 loanerAgreement.create',
    );
    assert.equal(c.creates.length, 0);
  });
});

test('#17 loanerAgreement.createForReservation — the SNAPSHOT fallback is not policed', async () => {
  // Dead zone, deliberately: with no email in the request the reservation's
  // stored address is copied. Refusing there would deny an agreement to a
  // customer whose stored address is already bad — a mail bug turned into a
  // counter outage, the exact trade this whole change refuses to make.
  const c = capture();
  await withPrisma({
    reservation: { findFirst: async () => loanerReservation(SPECIMEN), findUnique: async () => loanerReservation(SPECIMEN) },
    loanerAgreement: c.model,
  }, async () => {
    await loanerAgreementService.createForReservation(
      { role: 'SUPER_ADMIN', tenantId: 't1' }, 'r1',
      { customerFirstName: 'Ana', customerLastName: 'Rivera' },
    );
    assert.equal(c.creates[0].data.customerEmail, SPECIMEN, 'the snapshot must pass through untouched');
  });
});

test('#18 loanerAgreement.update — STAFF: the specimen is refused', async () => {
  const c = capture();
  c.model.findFirst = async () => ({ id: 'la1', tenantId: 't1', status: 'DRAFT', customerFirstName: 'Ana', customerLastName: 'Rivera' });
  await withPrisma({ loanerAgreement: c.model }, async () => {
    await refuses(
      () => loanerAgreementService.update({ role: 'SUPER_ADMIN', tenantId: 't1' }, 'la1', { customerEmail: SPECIMEN }),
      'staff', '#18 loanerAgreement.update',
    );
    assert.equal(c.updates.length, 0);
  });
});

test('#18 loanerAgreement.update — the odd-but-legal address is stored normalized', async () => {
  const c = capture();
  c.model.findFirst = async () => ({ id: 'la1', tenantId: 't1', status: 'DRAFT', customerFirstName: 'Ana', customerLastName: 'Rivera' });
  await withPrisma({ loanerAgreement: c.model }, async () => {
    await loanerAgreementService.update({ role: 'SUPER_ADMIN', tenantId: 't1' }, 'la1', { customerEmail: ODD_BUT_LEGAL });
    assert.equal(c.updates[0].data.customerEmail, ODD_BUT_LEGAL_NORMALIZED);
  });
});

// ===========================================================================
// PART 2 — THE SCANNER. Narrow job: no NEW writer ships unclassified.
// ===========================================================================

/**
 * Every file that writes one of the three email columns, and its class. Part 1
 * proves the CAPTURE ones actually call the gate; this list exists so a file
 * that STARTS writing an email cannot arrive unnoticed.
 */
const CAPTURE_FILES = new Set([
  'modules/customers/customers.service.js',                  // #1 #2 #16
  'modules/customers/vozia-customer-patch.js',               // #3
  'modules/reservations/reservations.routes.js',             // #4
  'modules/rental-agreements/rental-agreements.service.js',  // #5 (+ snapshots)
  'modules/dealership-loaner/dealership-loaner.service.js',  // #6
  'modules/quotes/quotes.service.js',                        // #7 #19 #20
  'modules/customer-portal/customer-portal.routes.js',       // #8
  'modules/public-booking/public-booking.service.js',        // #9
  'modules/booking-engine/booking-engine.service.js',        // #10
  'modules/dealership-loaner/loaner-agreement.service.js',   // #17 #18
]);

const IMPORT_FILES = new Set([
  'modules/integrations/booking-source/customer-autocreate.js',       // #11
  'modules/integrations/economy/economy.worker.js',                   // #12
  'modules/integrations/nu/nu.worker.js',                             // #13
  'modules/integrations/tl-international/tl-international.worker.js', // #14
  'modules/reservations/reservations.service.js',                     // #15
]);

/**
 * Writes that are NOT capture — a copy, a snapshot, or a clear — each argued in
 * the header of lib/customer-email.js. Listed so an UNEXPLAINED hit is what
 * fails, rather than merely an unguarded one.
 */
const NOT_CAPTURE_FILES = new Set([
  // --- SNAPSHOTS: an existing column copied onto a document -----------------
  // reservation.customer.email onto the rental contract.
  'modules/rental-agreements/rental-agreements.service.js',
  // The same copy onto a LoanerAgreement, when the customer signs the loaner
  // themselves from the public portal. Found only when the scanner learned
  // about LoanerAgreement — it was absent from the first census entirely.
  'modules/dealership-loaner/public-loaner.service.js',
  // Clones an existing row's email during a kiosk name correction.
  'modules/kiosk/kiosk-name-update.service.js',

  // --- ANONYMISERS: they write null / sentinels, never an address -----------
  // One class, three files. The last two were MISSING from the first inventory
  // purely because the scanner could not see `tx[spec.model].updateMany`, so
  // declaring one and not the others was arbitrary rather than considered.
  'modules/public-booking/account-deletion.service.js',
  'modules/customers/customer-erasure.service.js',
  'modules/retention/retention.service.js',

  // --- OPAQUE PAYLOADS the scanner cannot read, checked by hand -------------
  // `data: patch`, where `patch` is accumulated from a FIXED key list: licence
  // number, licence state, date of birth, and the ID-photo columns. No branch
  // of any of them can put an email in that object.
  'modules/kiosk/kiosk-checkout.service.js',
  'modules/kiosk/kiosk-staff-assist.service.js',
  // `data: { [column]: value }` with `const column = 'phone'` one line above —
  // a computed key that is only ever the phone. (The EMAIL half of the VozIA
  // surface lives in vozia-CUSTOMER-patch.js, writer #3, and is gated there.)
  'modules/reservations/vozia-reservation-patch.js',
  // A WINDOW artefact, kept rather than tuned away: the rentalAgreement write
  // here is `data: { returnAt }`, and what the 45-line window actually caught
  // was `data: extensionChargeData` from a neighbouring reservationCharge
  // write. Narrowing the window to hide it would trade a cheap false positive
  // for the false negatives this scanner was just rebuilt to stop having.
  'modules/reservations/reservation-extend.service.js',
]);

const DECLARED = new Set([...CAPTURE_FILES, ...IMPORT_FILES, ...NOT_CAPTURE_FILES]);

/**
 * WHAT THE SCANNER CANNOT SEE. Stated, not implied — an honest blind spot beats
 * a guard that quietly pretends to be exhaustive.
 *
 *   a. computed MODEL  — `tx[spec.model].updateMany(...)`: the model is a
 *                        variable, so the line cannot be attributed to a table.
 *                        This is exactly how customer-erasure and retention went
 *                        undeclared. Now flagged on sight for classification.
 *   b. computed KEY    — `data: { [field]: value }` (vozia-customer-patch).
 *   c. accumulated     — `customerUpdate[key] = …` then `data: customerUpdate`
 *                        (reservations.routes staff-complete).
 *   d. spread          — `data: { ...payload }`.
 *
 * (b), (c) and (d) are now caught by the opaque-payload scan. None of them can
 * prove the gate is CALLED — Part 1 does that, which is the whole reason Part 1
 * exists.
 */
const SCAN_INVISIBLE = new Set([
  'modules/customers/vozia-customer-patch.js',
  'modules/reservations/reservations.routes.js',
]);

const WRITE_CALL = /\b(?:tx|db|prisma|prismaClient|client)\.(customer|rentalAgreement|loanerAgreement)\.(create|update|upsert|createMany|updateMany)\b/;
/** A write on ANY model reached through a computed name: `tx[spec.model].update…`. */
const COMPUTED_MODEL_WRITE = /\b(?:tx|db|prisma|prismaClient|client)\[[^\]]+\]\.(?:create|update|upsert|createMany|updateMany)\b/;
const EMAIL_KEY = /(^|[\s{,])(email|customerEmail|contactEmail)\s*(:|,|\r?\n|\})/m;
/** A payload this scanner cannot read: a spread, a computed key, or a bare identifier. */
const OPAQUE_PAYLOAD = /\bdata:\s*(?:\{\s*(?:\.\.\.|\[)|[A-Za-z_$][\w$]*\s*[,}])/;
const PAYLOAD_WINDOW = 45;

function sourceFiles(dir = SRC, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules') continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) { sourceFiles(full, out); continue; }
    if (!name.endsWith('.js')) continue;          // .mjs under src/ is tests only
    if (name.includes('.test.')) continue;
    out.push(full);
  }
  return out;
}

const rel = (full) => relative(SRC, full).split(sep).join('/');

function lineHits(line, window) {
  const isModelWrite = WRITE_CALL.test(line);
  const isComputedWrite = COMPUTED_MODEL_WRITE.test(line);
  if (!isModelWrite && !isComputedWrite) return false;
  // A computed-model write is flagged on sight: nothing in the line says WHICH
  // table it hits, so a human has to classify it.
  return isComputedWrite || EMAIL_KEY.test(window) || OPAQUE_PAYLOAD.test(window);
}

/**
 * Full-line comments are stripped before scanning, for the reason
 * npm-test-chain.test.mjs strips them out of beta-ci.yml: otherwise a write
 * DESCRIBED in prose counts as a write that HAPPENS. It bit immediately —
 * lib/customer-email.js documents `tx[spec.model].updateMany` in its own
 * inventory and flagged itself as an unclassified writer. Getting that wrong in
 * the other direction is worse: a scanner that reads comments can be silenced
 * by deleting one, and satisfied by adding one.
 *
 * Line-level only. A trailing `//` after real code is left alone, because the
 * code before it is exactly what we are looking for.
 */
function stripCommentLines(lines) {
  return lines.map((l) => (/^\s*(\/\/|\*|\/\*)/.test(l) ? '' : l));
}

function codeLines(full) {
  return stripCommentLines(readFileSync(full, 'utf8').split(/\r?\n/));
}

/** Files whose Prisma writes either name an email or hide their payload. */
function scanWriters() {
  const found = new Set();
  for (const full of sourceFiles()) {
    const lines = codeLines(full);
    for (let i = 0; i < lines.length; i++) {
      const window = lines.slice(i, i + PAYLOAD_WINDOW).join('\n');
      if (lineHits(lines[i], window)) { found.add(rel(full)); break; }
    }
  }
  return found;
}

test('the scanner reads CODE, not comments', () => {
  // Both directions matter. A commented-out write must not be reported (it bit
  // on the first run: this module's own inventory names `tx[spec.model]`), and a
  // real write must not become invisible by growing a comment above it.
  const commented = stripCommentLines(['  // await prisma.customer.update({ data: { email: e } });']);
  assert.ok(!lineHits(commented[0], commented.join('\n')),
    'a commented-out write was counted as a write');
  const jsdoc = stripCommentLines([' * writes prisma.customer.update({ data: { email } }) somewhere']);
  assert.ok(!lineHits(jsdoc[0], jsdoc.join('\n')), 'a JSDoc mention was counted as a write');
  const real = stripCommentLines(['await prisma.customer.update({ where: { id }, data: { email: e } });']);
  assert.ok(lineHits(real[0], real.join('\n')), 'a real write stopped being seen');
});

test('RATCHET: no file writes a customer email without being classified', () => {
  const unclassified = [...scanWriters()].filter((f) => !DECLARED.has(f)).sort();
  assert.deepEqual(
    unclassified, [],
    'These files write (or may write) Customer.email / RentalAgreement.customerEmail / '
    + 'LoanerAgreement.customerEmail and are not classified in lib/customer-email.js. '
    + 'Classify each — staff, customer, import, or not-capture — add it here, and give the '
    + 'capture ones a DRIVEN test in Part 1. Do not delete this assertion:\n  '
    + unclassified.join('\n  '),
  );
});

test('RATCHET: the inventory has no stale entries either', () => {
  const found = scanWriters();
  for (const path of SCAN_INVISIBLE) found.add(path);
  const stale = [...DECLARED].filter((f) => !found.has(f)).sort();
  assert.deepEqual(
    stale, [],
    'Declared but no longer writing a customer email — re-check and prune:\n  ' + stale.join('\n  '),
  );
});

test('the scanner sees through a spread, a computed key and a computed model', () => {
  // The three shapes QA planted that the first scanner walked straight past.
  // Proving the detector on synthetic source keeps the claim honest without
  // leaving fake writers in the tree.
  const shapes = {
    spread: 'await prisma.customer.update({ where: { id }, data: { ...payload } });',
    computedKey: 'await prisma.customer.update({ where: { id }, data: { [field]: value } });',
    bareIdentifier: 'await prisma.customer.update({ where: { id }, data: patch });',
    computedModel: 'await tx[spec.model].updateMany({ where, data });',
    plainEmail: 'await prisma.customer.create({ data: { email: e } });',
  };
  for (const [name, line] of Object.entries(shapes)) {
    assert.ok(lineHits(line, line), `the scanner is blind to the ${name} shape: ${line}`);
  }
});

test('no customer-email writer grows its own local regex again', () => {
  // vozia-customer-patch.js carried its own copy of this exact regex, which is
  // how the rule drifted: three independent copies, eleven writers with none.
  //
  // public-booking.service.js is exempt with its reason spelled out, rather than
  // by quietly narrowing the scan: it also hosts submitContactMessage(), the
  // website contact form, whose regex checks a VISITOR's reply-to for a one-off
  // message to the tenant's admins. It never reaches a customer column. The same
  // shape also survives in incident-report.service.js and shuttle-zone-alerts.js
  // — both ad-hoc RECIPIENT checks, both outside this incident.
  const EXEMPT = new Set(['modules/public-booking/public-booking.service.js']);
  const offenders = [];
  for (const path of DECLARED) {
    if (EXEMPT.has(path)) continue;
    const src = readFileSync(join(SRC, path), 'utf8');
    if (/\[\^\\s@\]\+@\[\^\\s@\]\+\\\.\[\^\\s@\]\+/.test(src)
      || /\[\^@\\s\]\+@\[\^@\\s\]\+\\\.\[\^@\\s\]\+/.test(src)) {
      offenders.push(path);
    }
  }
  assert.deepEqual(offenders, [], `A local email regex reappeared. Import lib/customer-email.js:\n  ${offenders.join('\n  ')}`);
});

test('every declared CAPTURE file calls the gate OUTSIDE its imports and comments', () => {
  // Belt to Part 1's braces, and the specific hole QA opened: an import kept for
  // appearances while the call is gone. Part 1 catches that behaviourally for
  // every writer it drives; this catches a file that grows a SECOND writer
  // nobody has written a driven test for yet.
  const CALLS = /\b(?:assertCustomerEmail|normalizeCustomerEmail|assertQuoteEmail)\s*\(/;
  const missing = [];
  for (const path of CAPTURE_FILES) {
    const body = readFileSync(join(SRC, path), 'utf8')
      .split(/\r?\n/)
      .filter((l) => !/^\s*import\b/.test(l) && !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join('\n');
    if (!CALLS.test(body)) missing.push(path);
  }
  assert.deepEqual(
    missing, [],
    'Declared as a CAPTURE writer but never calling the gate outside its imports and comments:\n  '
    + missing.join('\n  '),
  );
});
