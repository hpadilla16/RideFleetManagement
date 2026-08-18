/**
 * Pre-check-in charge application — atomicity, against a REAL Postgres.
 * Run via: npm run test:precheckin-charges  (see the header in
 * scripts/embedded-pg-boot.mjs for the embedded-postgres install step)
 *
 * WHAT THIS DEFENDS
 * POST /customer-info/:token used to rewrite a reservation's charge sheet with
 * unwrapped statements: deleteMany({source:'INSURANCE'}) first, and the create()
 * that put the line back only after a settings lookup and a pricing branch. Any
 * throw in between and the customer's insurance line was gone for good, with a
 * 500 on their phone and nobody at a counter to notice. Same shape four times
 * over (INSURANCE, ADDITIONAL_SERVICE_PRECHECKIN, the OTA daily/fee sweep, the
 * TAX recalculation).
 *
 * HOW THE FAILURE IS INJECTED — and why it is not a mock of the thing under test.
 * The database, the schema, the transaction and applyPrecheckinCharges() are all
 * real. The ONLY substitution is a Proxy over the Prisma client that lets the
 * Nth `reservationCharge.create` throw, standing in for the real ways this has
 * failed (a settings blob that priced to NaN, a dropped connection, a plan the
 * catalog no longer carries). The proxy wraps BOTH the client and the
 * transaction client, so deleting the `$transaction` wrapper from
 * precheckin-charges.js does not route around the injection — it just makes
 * these tests go red, which is the point. MEASURED with the wrapper removed:
 * "insurance charge survives" and "nothing is stamped complete" both fail, the
 * INSURANCE row is gone and customerInfoCompletedAt is set.
 *
 * The concurrency cases cover the OTHER half of the same route's exposure:
 * portalWrite is a per-IP rate limit with no idempotency, so a double-tapped
 * Submit runs this twice at once. A transaction alone does not make that safe —
 * see the advisory-lock comment in precheckin-charges.js.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { bootEmbeddedPg } from '../../../scripts/embedded-pg-boot.mjs';
// Imported dynamically in before(), after bootEmbeddedPg has set DATABASE_URL.
let applyPrecheckinCharges;

let pgHandle;
let prisma;

const TAG = `PCC-${Date.now()}`;
const ids = { tenant: null, location: null, customer: null, service: null };

const PLANS = [
  { code: 'BASIC', name: 'Basic Coverage', chargeBy: 'FIXED', amount: 45 },
  { code: 'PCT', name: 'Percentage Coverage', chargeBy: 'PERCENTAGE', amount: 10 },
];

/**
 * A Prisma client whose `<model>.create` throws on the Nth call.
 *
 * Wraps the client AND the transaction client handed to the callback, so the
 * injection lands whether the module runs inside a transaction or not — remove
 * the wrapper from the module and these cases go red rather than routing around
 * the failure.
 */
function clientFailingOnCreate({ nth = 1, model = 'reservationCharge' } = {}) {
  const state = { seen: 0 };

  const inject = (base) => new Proxy(base, {
    get(target, prop, receiver) {
      if (prop === '$transaction') {
        return (arg, opts) => (typeof arg === 'function'
          ? base.$transaction((tx) => arg(inject(tx)), opts)
          : base.$transaction(arg, opts));
      }
      if (prop === model) {
        const delegate = target[prop];
        return new Proxy(delegate, {
          get(dTarget, dProp) {
            const value = dTarget[dProp];
            if (dProp !== 'create') {
              return typeof value === 'function' ? value.bind(dTarget) : value;
            }
            return (...args) => {
              state.seen += 1;
              if (state.seen === nth) {
                throw new Error('INJECTED: charge write failed mid-submission');
              }
              return value.apply(dTarget, args);
            };
          },
        });
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });

  return inject(prisma);
}

/** A Prisma client that runs `hook()` after every reservationCharge.create. */
function clientWithCreateHook(hook) {
  const inject = (base) => new Proxy(base, {
    get(target, prop, receiver) {
      if (prop === '$transaction') {
        return (arg, opts) => (typeof arg === 'function'
          ? base.$transaction((tx) => arg(inject(tx)), opts)
          : base.$transaction(arg, opts));
      }
      if (prop === 'reservationCharge') {
        const delegate = target[prop];
        return new Proxy(delegate, {
          get(dTarget, dProp) {
            const value = dTarget[dProp];
            if (dProp !== 'create') {
              return typeof value === 'function' ? value.bind(dTarget) : value;
            }
            return async (...args) => {
              const out = await value.apply(dTarget, args);
              await hook();
              return out;
            };
          },
        });
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return inject(prisma);
}

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

let resSeq = 0;
/** A reservation with a charge sheet, fresh for each case. */
async function makeReservation({ charges = [], notes = null } = {}) {
  resSeq += 1;
  const reservation = await prisma.reservation.create({
    data: {
      reservationNumber: `${TAG}-${resSeq}`,
      tenantId: ids.tenant,
      customerId: ids.customer,
      pickupLocationId: ids.location,
      returnLocationId: ids.location,
      pickupAt: new Date('2026-09-01T15:00:00Z'),
      returnAt: new Date('2026-09-04T15:00:00Z'), // 3 days
      notes,
    },
  });
  for (const c of charges) {
    await prisma.reservationCharge.create({ data: { reservationId: reservation.id, ...c } });
  }
  // Shaped like findReservationByToken('customer-info') hands it over.
  return prisma.reservation.findUnique({ where: { id: reservation.id } });
}

function chargeSheet(reservationId) {
  return prisma.reservationCharge.findMany({
    where: { reservationId },
    orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
  });
}

before(async () => {
  pgHandle = await bootEmbeddedPg();
  prisma = pgHandle.prisma;
  ({ applyPrecheckinCharges } = await import('./precheckin-charges.js'));

  const tenant = await prisma.tenant.create({
    data: { name: `T ${TAG}`, slug: `t-${TAG}`.toLowerCase() },
  });
  ids.tenant = tenant.id;

  const location = await prisma.location.create({
    data: { tenantId: tenant.id, code: `L${resSeq}${TAG}`.slice(0, 20), name: `Loc ${TAG}`, taxRate: 10 },
  });
  ids.location = location.id;

  const customer = await prisma.customer.create({
    data: { tenantId: tenant.id, firstName: 'Ana', lastName: `P-${TAG}`, phone: `7870${String(Date.now()).slice(-5)}` },
  });
  ids.customer = customer.id;

  const service = await prisma.additionalService.create({
    data: { tenantId: tenant.id, name: `GPS ${TAG}`, rate: 12, isActive: true, taxable: true },
  });
  ids.service = service.id;
});

after(async () => {
  try { await pgHandle?.stop(); } catch { /* ignore */ }
});

describe('a failure mid-submission leaves the charge sheet exactly as it was', () => {
  it('does not lose the insurance line the delete removed', async () => {
    const reservation = await makeReservation({
      charges: [
        { source: 'DAILY', name: 'Daily rate', quantity: 3, rate: 100, total: 300, taxable: true },
        { source: 'INSURANCE', sourceRefId: 'BASIC', name: 'Basic Coverage', quantity: 1, rate: 45, total: 45 },
      ],
    });
    const before = await chargeSheet(reservation.id);

    await assert.rejects(
      applyPrecheckinCharges({
        client: clientFailingOnCreate({ nth: 1 }),
        reservation,
        insuranceSelection: { selectedPlanCode: 'BASIC' },
        insurancePlans: PLANS,
      }),
      /INJECTED/,
    );

    const after = await chargeSheet(reservation.id);
    assert.deepEqual(
      after.map((c) => [c.id, c.source, String(c.total)]),
      before.map((c) => [c.id, c.source, String(c.total)]),
      'the charge sheet must be byte-for-byte what it was before the failed submission',
    );
    // Named separately: the row surviving is the money, and a diff that happened
    // to match on ids would still be worth reading as "insurance is still here".
    assert.equal(after.filter((c) => c.source === 'INSURANCE').length, 1);
  });

  it('does not lose the SERVICE lines either — the same shape, three blocks down', async () => {
    const reservation = await makeReservation({
      charges: [
        { source: 'DAILY', name: 'Daily rate', quantity: 3, rate: 100, total: 300, taxable: true },
        { source: 'ADDITIONAL_SERVICE_PRECHECKIN', sourceRefId: 'old', name: 'GPS', quantity: 1, rate: 12, total: 12 },
      ],
    });
    const before = await chargeSheet(reservation.id);

    // nth: 2 — the first create is the insurance line, the second is the service.
    await assert.rejects(
      applyPrecheckinCharges({
        client: clientFailingOnCreate({ nth: 2 }),
        reservation,
        insuranceSelection: { selectedPlanCode: 'BASIC' },
        insurancePlans: PLANS,
        selectedServices: [{ serviceId: ids.service, selected: true, quantity: 1 }],
      }),
      /INJECTED/,
    );

    const after = await chargeSheet(reservation.id);
    assert.deepEqual(
      after.map((c) => [c.id, c.source, String(c.total)]),
      before.map((c) => [c.id, c.source, String(c.total)]),
    );
  });

  it('un-stamps a submission that fails AFTER the completion marker', async () => {
    // Deliberately injected on the audit row, the LAST write in the unit, which
    // lands after `customerInfoCompletedAt` has already been set. Injecting on
    // an early create would leave this assertion passing whether or not the
    // work is transactional — the stamp simply would not have been reached yet —
    // and a case that cannot fail is not covering anything.
    const reservation = await makeReservation({
      charges: [{ source: 'INSURANCE', name: 'Basic Coverage', quantity: 1, rate: 45, total: 45 }],
    });

    await assert.rejects(
      applyPrecheckinCharges({
        client: clientFailingOnCreate({ model: 'auditLog', nth: 1 }),
        reservation,
        insuranceSelection: { selectedPlanCode: 'BASIC' },
        insurancePlans: PLANS,
      }),
      /INJECTED/,
    );

    const row = await prisma.reservation.findUnique({
      where: { id: reservation.id }, select: { customerInfoCompletedAt: true },
    });
    assert.equal(
      row.customerInfoCompletedAt, null,
      'a rolled-back submission must not look complete — the rest of the app reads this to mean the charge sheet is final',
    );
    assert.equal(await prisma.auditLog.count({ where: { reservationId: reservation.id } }), 0);
  });

  it('does not flip declinedInsurance when the submission fails later on', async () => {
    const reservation = await makeReservation({
      charges: [
        { source: 'DAILY', name: 'Daily rate', quantity: 3, rate: 100, total: 300, taxable: true },
        { source: 'INSURANCE', name: 'Basic Coverage', quantity: 1, rate: 45, total: 45 },
      ],
    });
    await prisma.rentalAgreement.create({
      data: {
        agreementNumber: `AG-${TAG}-${resSeq}`,
        reservationId: reservation.id,
        tenantId: ids.tenant,
        pickupLocationId: ids.location,
        returnLocationId: ids.location,
        pickupAt: reservation.pickupAt,
        returnAt: reservation.returnAt,
        customerFirstName: 'Ana',
        customerLastName: 'P',
      },
    });

    // Decline writes the flag, then the service create blows up after it.
    await assert.rejects(
      applyPrecheckinCharges({
        client: clientFailingOnCreate({ nth: 1 }),
        reservation,
        insuranceSelection: { declinedCoverage: true },
        insurancePlans: PLANS,
        selectedServices: [{ serviceId: ids.service, selected: true, quantity: 1 }],
      }),
      /INJECTED/,
    );

    const ag = await prisma.rentalAgreement.findUnique({
      where: { reservationId: reservation.id }, select: { declinedInsurance: true },
    });
    assert.equal(
      ag.declinedInsurance, false,
      'declinedInsurance decides which sections the customer must initial — it must not survive a rolled-back submission',
    );
  });
});

describe('the submission it is meant to apply still applies', () => {
  it('replaces the insurance line, adds the service, and stamps completion', async () => {
    const reservation = await makeReservation({
      charges: [
        { source: 'DAILY', name: 'Daily rate', quantity: 3, rate: 100, total: 300, taxable: true },
        { source: 'INSURANCE', sourceRefId: 'OLD', name: 'Stale plan', quantity: 1, rate: 99, total: 99 },
      ],
    });

    await applyPrecheckinCharges({
      client: prisma,
      reservation,
      insuranceSelection: { selectedPlanCode: 'BASIC' },
      insurancePlans: PLANS,
      selectedServices: [{ serviceId: ids.service, selected: true, quantity: 2 }],
    });

    const sheet = await chargeSheet(reservation.id);
    const insurance = sheet.filter((c) => c.source === 'INSURANCE');
    assert.equal(insurance.length, 1);
    assert.equal(insurance[0].sourceRefId, 'BASIC');
    assert.equal(Number(insurance[0].total), 45);

    const services = sheet.filter((c) => c.source === 'ADDITIONAL_SERVICE_PRECHECKIN');
    assert.equal(services.length, 1);
    assert.equal(Number(services[0].total), 24); // flat 12 × 2 units

    const row = await prisma.reservation.findUnique({
      where: { id: reservation.id }, select: { customerInfoCompletedAt: true },
    });
    assert.notEqual(row.customerInfoCompletedAt, null);
    assert.equal(await prisma.auditLog.count({ where: { reservationId: reservation.id } }), 1);
  });

  it('records a decline WITH its signature on the agreement', async () => {
    // The counterpart to the rollback case above, and the reason this exists at
    // all: an earlier revision of the module carried a `tcSignedAt` fence from
    // another branch, guarded by a parameter no caller passed. Its only live
    // effect was to DROP this signature whenever staff had signed the T&C at the
    // counter first — which is legal, since requirePrecheckinBeforeCheckout is
    // off by default. buildDeclinedInsuranceBlock prints this column on the
    // contract's decline addendum; without it the PDF says "(no signature on
    // file)". This case pins that the signature is written.
    const reservation = await makeReservation({
      charges: [{ source: 'DAILY', name: 'Daily rate', quantity: 3, rate: 100, total: 300, taxable: true }],
    });
    await prisma.rentalAgreement.create({
      data: {
        agreementNumber: `AG-SIG-${TAG}-${resSeq}`,
        reservationId: reservation.id,
        tenantId: ids.tenant,
        pickupLocationId: ids.location,
        returnLocationId: ids.location,
        pickupAt: reservation.pickupAt,
        returnAt: reservation.returnAt,
        customerFirstName: 'Ana',
        customerLastName: 'P',
        // Signed at the counter BEFORE the customer finished pre-check-in.
        tcSignedAt: new Date(),
      },
    });
    const signature = `data:image/png;base64,${'A'.repeat(400)}`;

    await applyPrecheckinCharges({
      client: prisma,
      reservation,
      insuranceSelection: { declinedCoverage: true, signatureDataUrl: signature },
      insurancePlans: PLANS,
    });

    const ag = await prisma.rentalAgreement.findUnique({
      where: { reservationId: reservation.id },
      select: { declinedInsurance: true, declinedInsuranceSignatureDataUrl: true, declinedInsuranceSignedAt: true },
    });
    assert.equal(ag.declinedInsurance, true);
    assert.equal(ag.declinedInsuranceSignatureDataUrl, signature);
    assert.notEqual(ag.declinedInsuranceSignedAt, null);
  });

  it('does not write the signature columns for a blank-ish signature', async () => {
    // The length > 200 guard, unchanged. A stub value is not a signature.
    const reservation = await makeReservation({
      charges: [{ source: 'DAILY', name: 'Daily rate', quantity: 3, rate: 100, total: 300, taxable: true }],
    });
    await prisma.rentalAgreement.create({
      data: {
        agreementNumber: `AG-NOSIG-${TAG}-${resSeq}`,
        reservationId: reservation.id,
        tenantId: ids.tenant,
        pickupLocationId: ids.location,
        returnLocationId: ids.location,
        pickupAt: reservation.pickupAt,
        returnAt: reservation.returnAt,
        customerFirstName: 'Ana',
        customerLastName: 'P',
      },
    });

    await applyPrecheckinCharges({
      client: prisma,
      reservation,
      insuranceSelection: { declinedCoverage: true, signatureDataUrl: 'data:image/png;base64,AAAA' },
      insurancePlans: PLANS,
    });

    const ag = await prisma.rentalAgreement.findUnique({
      where: { reservationId: reservation.id },
      select: { declinedInsurance: true, declinedInsuranceSignatureDataUrl: true },
    });
    assert.equal(ag.declinedInsurance, true);
    assert.equal(ag.declinedInsuranceSignatureDataUrl, null);
  });
});


describe('a double-tapped Submit', () => {
  it('refuses the second submission with a 409 and leaves one of everything', async () => {
    // THE INTERLEAVE IS PINNED, NOT RACED.
    //
    // Firing both with a bare Promise.all is not a test, it is a coin flip:
    // MEASURED, the same pair produced 2 insurance lines on one run and 1 on the
    // next, because whichever statement happens to touch a row the other already
    // holds serializes them by accident. So the damaging order is pinned here.
    //
    //   A creates its insurance line and then STOPS, transaction still open.
    //   B starts. Without the lock it cannot see A's uncommitted row, so its own
    //   deleteMany(source:'INSURANCE') matches nothing and it inserts a SECOND
    //   line — which is exactly what a customer's second tap did.
    //
    // With the lock, B never reaches that: pg_try_advisory_xact_lock returns
    // false on its first statement and it is refused outright. A's wait for B
    // then falls through to its timeout and commits.
    const reservation = await makeReservation({
      // One row, and deliberately of a source nothing here deletes. With a DAILY
      // or FEE row on the sheet both runs reach the same
      // deleteMany({source:{in:[DAILY,FEE…]}}), Postgres takes row locks, and the
      // second blocks there until the first commits — serialized by accident, so
      // the case would pass with the lock deleted and prove nothing. EQUIPMENT
      // survives the OTA sweep untouched, and being taxable it gives the
      // recalculation something to tax; the rows this handler writes itself never
      // set `taxable`, so insurance and services alone total zero.
      charges: [{ source: 'EQUIPMENT', name: 'Child seat', quantity: 1, rate: 50, total: 50, taxable: true }],
    });

    const aPaused = deferred();
    const bInserted = deferred();
    let aHeld = false;
    let bSeen = false;

    const clientA = clientWithCreateHook(async () => {
      if (aHeld) return;
      aHeld = true;
      aPaused.resolve();
      // Falls through on the timeout when B is (correctly) refused the lock.
      await Promise.race([bInserted.promise, delay(500)]);
    });
    const clientB = clientWithCreateHook(async () => {
      if (bSeen) return;
      bSeen = true;
      bInserted.resolve();
    });

    const submission = (client) => applyPrecheckinCharges({
      client,
      reservation,
      insuranceSelection: { selectedPlanCode: 'BASIC' },
      insurancePlans: PLANS,
      selectedServices: [{ serviceId: ids.service, selected: true, quantity: 1 }],
      thirdPartyBooking: { isThirdParty: true, voucherUrl: null },
    });

    const first = submission(clientA);
    await aPaused.promise;
    const second = submission(clientB);
    const [firstResult, secondResult] = await Promise.allSettled([first, second]);

    assert.equal(firstResult.status, 'fulfilled', 'the customer who got there first is served');
    assert.equal(secondResult.status, 'rejected');
    assert.equal(
      secondResult.reason?.status, 409,
      'the duplicate is refused, not queued — waiting would park a pool connection on an unauthenticated route',
    );
    // The copy reaches a customer with nobody beside them to interpret it.
    assert.match(secondResult.reason.message, /already being submitted/i);
    assert.ok(
      !/lock|advisory|transaction|409/i.test(secondResult.reason.message),
      'no internal vocabulary in customer-facing copy',
    );

    const sheet = await chargeSheet(reservation.id);
    const count = (source) => sheet.filter((c) => c.source === source).length;
    assert.equal(count('INSURANCE'), 1, 'a second tap must not sell the customer two policies');
    assert.equal(count('OTA_PREPAID_VOUCHER'), 1, 'a second tap must not buy a second voucher marker');
    assert.equal(count('TAX_RECALC'), 1, 'a second tap must not tax the customer twice');
    assert.equal(count('ADDITIONAL_SERVICE_PRECHECKIN'), 1);

    const row = await prisma.reservation.findUnique({
      where: { id: reservation.id }, select: { notes: true },
    });
    assert.equal(
      (row.notes.match(/\[OTA PREPAID\]/g) || []).length, 1,
      'the prepaid marker is read by eye at the counter — it must be stamped once',
    );
  });

  it('does NOT refuse a customer who comes back later and submits again', async () => {
    // The lock only refuses submissions that OVERLAP. Re-submitting to fix an
    // address is a normal thing customers do and must keep working, or this
    // hardening would have broken the route it was protecting.
    const reservation = await makeReservation({
      charges: [{ source: 'DAILY', name: 'Daily rate', quantity: 3, rate: 100, total: 300, taxable: true }],
    });

    const submission = () => applyPrecheckinCharges({
      client: prisma,
      reservation,
      insuranceSelection: { selectedPlanCode: 'BASIC' },
      insurancePlans: PLANS,
      selectedServices: [{ serviceId: ids.service, selected: true, quantity: 1 }],
    });

    await submission();
    await submission();

    const sheet = await chargeSheet(reservation.id);
    assert.equal(sheet.filter((c) => c.source === 'INSURANCE').length, 1);
    assert.equal(sheet.filter((c) => c.source === 'ADDITIONAL_SERVICE_PRECHECKIN').length, 1);
    assert.equal(Number(sheet.find((c) => c.source === 'INSURANCE').total), 45);
  });

  it('PINS a known non-idempotency: a PERCENTAGE plan re-prices on re-submission', async () => {
    // NOT a passing grade — a pin. The base for a PERCENTAGE policy is read
    // BEFORE this handler writes its service rows, so the second submission
    // sees the first run's rows and quotes more. Unchanged by this commit,
    // which is the point of writing it down: excluding that source would fix it
    // but is a live pricing change (reservation-pricing.service.js also writes
    // ADDITIONAL_SERVICE_PRECHECKIN, so agent-created rows are in the base on a
    // FIRST submission too). Raised for Hector as its own decision. Whoever
    // makes it will have to edit this case, deliberately.
    const reservation = await makeReservation({
      charges: [{ source: 'DAILY', name: 'Daily rate', quantity: 3, rate: 100, total: 300, taxable: true }],
    });

    const submission = () => applyPrecheckinCharges({
      client: prisma,
      reservation,
      insuranceSelection: { selectedPlanCode: 'PCT' },
      insurancePlans: PLANS,
      selectedServices: [{ serviceId: ids.service, selected: true, quantity: 1 }],
    });

    await submission();
    const first = (await chargeSheet(reservation.id)).find((c) => c.source === 'INSURANCE');
    assert.equal(Number(first.total), 30); // 10% of the 300 daily rate

    await submission();
    const second = (await chargeSheet(reservation.id)).find((c) => c.source === 'INSURANCE');
    assert.equal(Number(second.total), 31.2, '10% of 300 + the 12.00 service row the first run added');
  });
});
