/**
 * The money half of POST /customer-info/:token — applied ATOMICALLY.
 *
 * WHY THIS MODULE EXISTS (2026-08-17, innovation review)
 * The pre-check-in handler rewrote a reservation's charge sheet as a run of
 * bare, unwrapped statements: `deleteMany({source:'INSURANCE'})` and then, a
 * settings lookup and a pricing branch later, the `create()` that put the line
 * back. Anything that threw in between — a settings blob that priced to NaN, a
 * dropped connection, a plan the catalog no longer has — left the reservation
 * with NO insurance line and answered the customer with a 500. The same
 * delete-then-recreate shape appears four times in the handler (INSURANCE,
 * ADDITIONAL_SERVICE_PRECHECKIN, the OTA daily/fee sweep, and the TAX
 * recalculation), so there were four windows, not one. This is a money path
 * that an unsupervised customer drives from their phone.
 *
 * It lives in its own file rather than inline in the route for the reason
 * amount-due.js does: customer-portal.routes.js cannot be imported by a test —
 * its transitive imports hang — so logic that stays in there can only ever be
 * tested by a copy of itself, and this repo has been bitten by that four times.
 * See precheckin-charges.embedded.test.mjs, which drives THIS function against
 * a real Postgres and goes red the moment the transaction wrapper is removed.
 *
 * WHAT IS IN THE TRANSACTION AND WHAT IS DELIBERATELY NOT
 *   IN — every charge-row mutation, the agreement's declinedInsurance write,
 *   the OTA notes, `customerInfoCompletedAt`, and the audit row. Either the
 *   submission is recorded in full or the reservation is untouched; a charge
 *   sheet that is half-rewritten and NOT marked complete is the state that
 *   bills a customer wrong.
 *   OUT — the KYC document uploads (network I/O), the Customer PII update, the
 *   fail-soft deposit-rule re-evaluation, and the settings/insurance-plan
 *   lookups. Two reasons. Holding a Postgres transaction open across a Storage
 *   upload is how a connection pool dies, and — the sharper one — a query that
 *   throws inside a transaction poisons it at the SERVER: every later statement
 *   comes back "current transaction is aborted". The deposit re-evaluation is
 *   explicitly fail-soft ("pre-check-in must never break because of the rule"),
 *   so moving it inside would silently convert its swallowed error into a total
 *   loss of the submission. Its caller keeps it outside, before this call.
 *
 * @see customer-portal.routes.js — the only caller.
 */

import { ConflictError } from '../../lib/errors.js';

/**
 * Advisory-lock class id for "a customer pre-check-in submission". Arbitrary
 * but reserved: any future advisory lock in this codebase takes a different
 * one, so the (class, object) pairs cannot collide across features.
 */
const PRECHECKIN_LOCK_CLASS = 7301;

/** Rounds to cents the way the route always has. */
const money = (value) => Number(Number(value || 0).toFixed(2));

/**
 * Rental length in days — mirrors reservation-pricing.service.js#rentalDays.
 * Scales PER_DAY insurance plans and daily-rated additional services.
 */
export function rentalDaysFor(reservation, now = Date.now()) {
  const start = new Date(reservation?.pickupAt || now);
  const end = new Date(reservation?.returnAt || now);
  const diffMs = end.getTime() - start.getTime();
  return Math.max(1, Math.ceil(diffMs / (1000 * 60 * 60 * 24)) || 1);
}

/** The tenant's pre-check-in discount, as a function. Null/disabled → identity. */
export function discountApplier(discount) {
  return (amount) => {
    if (!discount?.enabled || !amount) return amount;
    if (discount.type === 'PERCENTAGE') return Number((amount * (1 - discount.value / 100)).toFixed(2));
    return Number(Math.max(0, amount - discount.value).toFixed(2));
  };
}

/**
 * Base for PERCENTAGE insurance plans: the non-tax, non-deposit, non-insurance
 * charges standing on the reservation when the customer submits. UNCHANGED from
 * what the route computed inline — this is a lift, not a re-decision.
 *
 * A KNOWN NON-IDEMPOTENCY LIVES HERE, and it is deliberately left alone.
 * The handler writes ADDITIONAL_SERVICE_PRECHECKIN rows AFTER this base is
 * computed, so a customer who submits, then comes back to fix their address and
 * submits again, has the first run's service rows sitting in the base the
 * second time — and a PERCENTAGE policy re-prices UPWARD for it.
 *
 * Excluding that source would fix it, and the first draft of this module did.
 * It is not a safe rider: this handler is NOT the only writer of that source —
 * reservation-pricing.service.js:1037 writes it when an agent adds an extra to
 * an already-priced reservation, and the reservation editor sends the same
 * value. So an agent-created row can be on the sheet at the FIRST submission,
 * and dropping it lowers what live tenants are quoted today. That is a pricing
 * decision with Hector's name on it, not a side effect of an atomicity fix.
 *
 * The concurrent case — the double-tap this module was hardened against — is
 * closed a different way: the second submission is refused with a 409 and never
 * re-derives anything. What is left is the sequential re-submission, which
 * behaves exactly as it did before this change. Raised separately.
 */
export function insuranceBaseFrom(charges) {
  return charges
    .filter((c) => String(c.source || '').toUpperCase() !== 'INSURANCE'
      && String(c.chargeType || '').toUpperCase() !== 'TAX'
      && String(c.chargeType || '').toUpperCase() !== 'DEPOSIT')
    .reduce((sum, c) => sum + Number(c.total || 0), 0);
}

/**
 * The charge row for a chosen insurance plan. Pure — the pricing is worth
 * reading without a database in the way. Respects the plan's mode exactly as
 * computeInsuranceLine() does in booking-engine.service.js, so a PER_DAY plan
 * is days×rate and not collapsed to a single unit.
 */
export function insuranceChargeFor({ plan, applyDiscount, rentalDays, insuranceBaseAmount }) {
  const mode = String(plan.chargeBy || plan.mode || 'FIXED').toUpperCase();
  const amount = Number(plan.amount || plan.rate || plan.total || 0);
  const discountedAmount = applyDiscount(amount);

  let chargeQuantity = 1;
  let chargeRate = money(discountedAmount);
  let chargeTotal = money(discountedAmount);
  let counterTotal = money(amount);
  let counterNote = null;

  if (mode === 'PER_DAY') {
    chargeQuantity = rentalDays;
    chargeRate = money(discountedAmount);
    chargeTotal = money(discountedAmount * rentalDays);
    counterTotal = money(amount * rentalDays);
    counterNote = `Counter price: $${amount.toFixed(2)}/day × ${rentalDays} day(s)`;
  } else if (mode === 'PERCENTAGE') {
    // Percentage plans are always a single line whose value is the pct of the base.
    chargeQuantity = 1;
    chargeRate = money(insuranceBaseAmount * (discountedAmount / 100));
    chargeTotal = chargeRate;
    counterTotal = money(insuranceBaseAmount * (amount / 100));
    counterNote = `Counter price: ${amount.toFixed(2)}% of $${insuranceBaseAmount.toFixed(2)}`;
  } else {
    // FIXED
    counterNote = `Counter price: $${amount.toFixed(2)}`;
  }

  const discounted = chargeTotal < counterTotal;
  return {
    source: 'INSURANCE',
    sourceRefId: plan.code,
    name: discounted ? `${plan.name} (Pre-checkin rate)` : plan.name,
    rate: chargeRate,
    total: chargeTotal,
    quantity: chargeQuantity,
    selected: true,
    sortOrder: 0,
    notes: discounted ? `${counterNote}, pre-checkin discount applied` : null
  };
}

/**
 * The charge row for one selected additional service. Pure. Mirrors
 * computeAdditionalServiceLine() in booking-engine.service.js: dailyRate (when
 * > 0) is the per-day price and the total scales with rental days; otherwise
 * the flat rate applies.
 */
export function serviceChargeFor({ service, quantity, applyDiscount, rentalDays }) {
  const qty = Math.max(1, Number(quantity || service.defaultQty || 1));
  const perDay = Number(service.dailyRate || 0);
  const isPerDay = perDay > 0 || String(service.chargeType || '').toUpperCase() === 'DAILY';
  const counterRate = isPerDay && perDay > 0 ? perDay : Number(service.rate || 0);
  const discountedRate = applyDiscount(counterRate);

  const chargeTotal = isPerDay
    ? money(discountedRate * rentalDays * qty)
    : money(discountedRate * qty);
  const counterTotal = isPerDay
    ? money(counterRate * rentalDays * qty)
    : money(counterRate * qty);
  const discounted = discountedRate < counterRate;
  const counterNote = isPerDay
    ? `Counter price: $${counterRate.toFixed(2)}/day × ${rentalDays} day(s) × ${qty} unit(s)`
    : `Counter price: $${counterRate.toFixed(2)}/unit × ${qty} unit(s)`;

  return {
    source: 'ADDITIONAL_SERVICE_PRECHECKIN',
    sourceRefId: service.id,
    name: discounted ? `${service.name} (Pre-checkin rate)` : service.name,
    rate: money(discountedRate),
    total: chargeTotal,
    quantity: isPerDay ? rentalDays * qty : qty,
    selected: true,
    sortOrder: 10,
    notes: discounted ? `${counterNote}, pre-checkin discount applied` : null
  };
}

/**
 * A whole pre-check-in submission's effect on the books, in one transaction.
 *
 * Throws ConflictError (409) when another submission for the same reservation
 * is already in flight; every other failure rolls the whole unit back.
 *
 * 20s is not a guess at how long this takes — it takes milliseconds. It is
 * headroom over Prisma's 5s default so a slow-but-alive database does not have
 * the whole unit rolled back from under it; the work inside is pure Postgres,
 * with every network call hoisted out by the caller. It is not the only ceiling:
 * lib/prisma-url.js sets statement_timeout=15s and
 * idle_in_transaction_session_timeout=30s, which cap any single statement and
 * any stall between them. Nothing here waits on a lock, so none of the three is
 * expected to be reached.
 *
 * @param {object} args
 * @param {object} args.client             Prisma client (the shared singleton).
 * @param {object} args.reservation        Row loaded by findReservationByToken().
 * @param {object|null} args.insuranceSelection
 * @param {Array|null}  args.selectedServices
 * @param {object|null} args.thirdPartyBooking
 * @param {Array}  args.insurancePlans     Pre-fetched catalog (settings I/O stays outside).
 * @param {object|null} args.discount      Tenant pre-check-in discount.
 * @param {Date}   args.completedAt
 * @param {object} args.auditMetadata      Extra keys merged into the AuditLog blob.
 * @returns {Promise<void>}
 */
export async function applyPrecheckinCharges({
  client,
  reservation,
  insuranceSelection = null,
  selectedServices = null,
  thirdPartyBooking = null,
  insurancePlans = [],
  discount = null,
  completedAt = new Date(),
  auditMetadata = {}
}) {
  const applyDiscount = discountApplier(discount);
  const rentalDays = rentalDaysFor(reservation);

  await client.$transaction(async (tx) => {
    // ONE SUBMISSION PER RESERVATION AT A TIME — AND THE SECOND ONE IS TOLD SO,
    // NOT MADE TO QUEUE.
    //
    // portalWrite is a per-IP rate limit and nothing else, so a customer who
    // double-taps Submit — or whose phone retries on a flaky connection — gets
    // two of these running at once. A transaction alone does NOT fix that:
    // under READ COMMITTED neither run can see the other's uncommitted INSERT,
    // so each one's deleteMany matches nothing and each inserts its own row.
    // MEASURED against a real Postgres: two concurrent submissions leave TWO
    // insurance lines, and on the OTA path two vouchers and two tax rows.
    // Duplicated money rows on a customer-driven route are worse than the 500
    // this change set out to remove.
    //
    // TRY, DO NOT WAIT. The blocking form would park the second request's
    // connection for the duration of the first, and this pool is 6 per worker
    // (lib/prisma-url.js) shared by every route in the process — six taps on one
    // valid token, no auth required, and the worker is out of connections while
    // five of them sit idle. `pg_try_advisory_xact_lock` bounds the cost at one
    // connection per in-flight request and answers the duplicate with a 409,
    // which is also better for the customer than making tap #2 wait to redo
    // work tap #1 is already doing. The lock is released by COMMIT or ROLLBACK,
    // so there is no path that leaks it.
    //
    // Two-argument form. The single-argument keyspace is one flat bigint space
    // shared by every advisory lock in the database, so hashing a prefixed
    // string into it lowers collision odds without partitioning anything. The
    // (classId, objectId) form gives a real namespace. This is the repo's first
    // advisory lock; the next one picks a DIFFERENT class id and both belong in
    // a shared registry once there are two.
    const gotLock = await tx.$queryRaw`
      SELECT pg_try_advisory_xact_lock(${PRECHECKIN_LOCK_CLASS}::int, hashtext(${reservation.id})::int) AS locked
    `;
    if (!gotLock?.[0]?.locked) {
      throw new ConflictError(
        'Your pre-check-in is already being submitted. Give it a moment, then reload the page to see the result.'
      );
    }

    const chargesForBase = await tx.reservationCharge.findMany({
      where: { reservationId: reservation.id, selected: true }
    });
    const insuranceBaseAmount = insuranceBaseFrom(chargesForBase);

    // ---- Insurance selection ------------------------------------------------
    if (insuranceSelection) {
      await tx.reservationCharge.deleteMany({
        where: { reservationId: reservation.id, source: 'INSURANCE' }
      });

      if (insuranceSelection.selectedPlanCode) {
        const plan = insurancePlans.find(
          (p) => String(p.code).toUpperCase() === String(insuranceSelection.selectedPlanCode).toUpperCase()
        );
        if (plan) {
          await tx.reservationCharge.create({
            data: {
              reservationId: reservation.id,
              ...insuranceChargeFor({ plan, applyDiscount, rentalDays, insuranceBaseAmount })
            }
          });
        }
      } else if (insuranceSelection.declinedCoverage) {
        // Persist the decline signature (captured on the pre-check-in page) onto
        // the agreement if one exists; initials + signature also live in the
        // AuditLog insuranceSelection blob the admin slot reads.
        const declineSig = insuranceSelection.signatureDataUrl;
        const declAg = await tx.rentalAgreement.findUnique({
          where: { reservationId: reservation.id }, select: { id: true }
        });
        if (declAg) {
          // UNCHANGED from the inline original, deliberately. A `tcSignedAt`
          // fence belongs here — writing these columns after the contract is
          // signed replaces the signature buildDeclinedInsuranceBlock prints on
          // the addendum and re-dates it to after the signing — but the fence
          // needs the signed/unsigned verdict, which arrives with the insurance
          // gate on fix/insurance-flag-and-terms-url and does not exist on this
          // branch. An earlier revision of this file carried the fence anyway,
          // guarded by a parameter no caller passed; that is not a control, and
          // its only real effect was to silently drop a legitimate decline
          // signature whenever staff signed at the counter first. See
          // doc/precheckin-atomicity-merge-notes-2026-08-17.md — the fence lands
          // with that merge, where the verdict it needs is on hand.
          await tx.rentalAgreement.update({
            where: { id: declAg.id },
            data: {
              declinedInsurance: true,
              ...(declineSig && String(declineSig).length > 200
                ? { declinedInsuranceSignatureDataUrl: declineSig, declinedInsuranceSignedAt: new Date() }
                : {}),
            },
          });
        }
      }
    }

    // ---- Additional services ------------------------------------------------
    if (selectedServices && Array.isArray(selectedServices)) {
      await tx.reservationCharge.deleteMany({
        where: { reservationId: reservation.id, source: 'ADDITIONAL_SERVICE_PRECHECKIN' }
      });

      for (const svc of selectedServices) {
        if (!svc.serviceId || !svc.selected) continue;
        const service = await tx.additionalService.findFirst({
          where: { id: svc.serviceId, tenantId: reservation.tenantId, isActive: true }
        });
        if (!service) continue;

        await tx.reservationCharge.create({
          data: {
            reservationId: reservation.id,
            ...serviceChargeFor({ service, quantity: svc.quantity, applyDiscount, rentalDays })
          }
        });
      }
    }

    // ---- Third-party / OTA prepaid voucher ----------------------------------
    if (thirdPartyBooking?.isThirdParty) {
      // Remove daily-rate related charges only — keep insurance, services, and their taxes
      await tx.reservationCharge.deleteMany({
        where: { reservationId: reservation.id, source: { in: ['DAILY', 'FEE', 'SERVICE_LINKED_FEE'] } }
      });

      // Recalculate tax on remaining taxable charges (insurance + services)
      const remainingCharges = await tx.reservationCharge.findMany({
        where: { reservationId: reservation.id, selected: true }
      });
      // Delete old tax rows (chargeType TAX) so we can recalculate
      await tx.reservationCharge.deleteMany({
        where: { reservationId: reservation.id, chargeType: 'TAX' }
      });
      const taxableTotal = remainingCharges
        .filter((c) => c.taxable && String(c.chargeType || '').toUpperCase() !== 'TAX')
        .reduce((sum, c) => sum + Number(c.total || 0), 0);
      if (taxableTotal > 0) {
        // Tax rate from the pricing snapshot, else the pickup location — the
        // snapshot is the rate the customer was quoted at booking, so it wins.
        //
        // 2026-08-17 (MONEY, Hector's call): this used to be unreachable. The
        // atomicity refactor inherited it with a note that
        // findReservationByToken('customer-info') did not include
        // pricingSnapshot, making the first operand undefined on every OTA
        // pre-check-in and quietly applying the location's rate. That include is
        // now present, so the snapshot rate actually applies here — matching
        // every other tax site in the codebase and, crucially, matching
        // buildReservationBreakdown, which computes the amount the customer is
        // SHOWN from the snapshot and so used to disagree with the TAX row this
        // block wrote for the same reservation.
        //
        // The fallback tests FALSY, not nullish, deliberately. With `??`, a
        // snapshot carrying taxRate = 0 would win, fail the `taxRate > 0` guard
        // below, and write no tax row at all rather than falling through to the
        // location — a revenue hole in place of the old bug. This mirrors
        // recomputeTaxRow() in reservation-extend.service.js, the canonical
        // version of this same recalculation.
        let taxRate = Number(reservation.pricingSnapshot?.taxRate ?? 0);
        if (!taxRate && reservation.pickupLocationId) {
          const loc = await tx.location.findUnique({
            where: { id: reservation.pickupLocationId },
            select: { taxRate: true }
          });
          taxRate = Number(loc?.taxRate ?? 0);
        }
        if (taxRate > 0) {
          const taxAmount = Number((taxableTotal * taxRate / 100).toFixed(2));
          await tx.reservationCharge.create({
            data: {
              reservationId: reservation.id,
              source: 'TAX_RECALC',
              name: `Sales Tax (${taxRate.toFixed(2)}%)`,
              chargeType: 'TAX',
              quantity: 1,
              rate: taxAmount,
              total: taxAmount,
              taxable: false,
              selected: true,
              sortOrder: 999
            }
          });
        }
      }

      // Store a voucher charge marker so the agreement knows this is prepaid
      const existingVoucher = await tx.reservationCharge.findFirst({
        where: { reservationId: reservation.id, source: 'OTA_PREPAID_VOUCHER' }
      });
      if (!existingVoucher) {
        await tx.reservationCharge.create({
          data: {
            reservationId: reservation.id,
            source: 'OTA_PREPAID_VOUCHER',
            sourceRefId: 'third-party-voucher',
            name: 'Prepaid Third-Party Voucher',
            chargeType: 'UNIT',
            quantity: 1,
            rate: 0,
            total: 0,
            taxable: false,
            selected: true,
            sortOrder: -1,
            notes: thirdPartyBooking.voucherUrl ? 'Voucher document attached' : 'No voucher document uploaded'
          }
        });
      }

      // Update reservation notes to flag prepaid status.
      //
      // Read INSIDE the transaction. `reservation.notes` was loaded before the
      // advisory lock was taken, so on a serialized second submission it is the
      // pre-first-run text and the "already contains the marker" guard would
      // look straight past a note the first run had just written — stamping
      // [OTA PREPAID] onto the reservation twice.
      const fresh = await tx.reservation.findUnique({
        where: { id: reservation.id }, select: { notes: true }
      });
      const currentNotes = fresh?.notes || '';
      const prepaidNote = '[OTA PREPAID] Customer indicated third-party prepaid booking during pre-check-in.';
      if (!currentNotes.includes('[OTA PREPAID]')) {
        await tx.reservation.update({
          where: { id: reservation.id },
          data: { notes: currentNotes ? `${currentNotes}\n${prepaidNote}` : prepaidNote }
        });
      }

      // Store voucher URL on the customer record.
      //
      // BEHAVIOR PRESERVED, AND IT IS WRONG: this OVERWRITES Customer.notes
      // rather than appending, so an OTA pre-check-in erases whatever an agent
      // had written on that customer. Not changed here — it is a data-loss bug
      // with its own blast radius, not an atomicity one, and quietly rewriting
      // it under cover of this change is how a fix ships unreviewed. Raised
      // separately.
      if (thirdPartyBooking.voucherUrl) {
        await tx.customer.update({
          where: { id: reservation.customerId },
          data: { notes: `[VOUCHER] Third-party voucher uploaded during pre-check-in` }
        });
      }
    }

    // ---- Completion marker + audit ------------------------------------------
    // Inside the transaction on purpose: `customerInfoCompletedAt` is what the
    // rest of the app reads to mean "this customer's charge sheet is final".
    // Stamped outside, a rolled-back submission would still look complete.
    await tx.reservation.update({
      where: { id: reservation.id },
      data: { customerInfoCompletedAt: completedAt }
    });

    await tx.auditLog.create({
      data: {
        tenantId: reservation.tenantId || null,
        reservationId: reservation.id,
        action: 'UPDATE',
        // Caller keys FIRST. This is the audit row for a money submission; a
        // caller blob spread last could overwrite `customerInfoCompleted`,
        // `completedAt` or `source` and make the record disagree with what
        // actually happened. Only `{ ip }` is passed today — the ordering is
        // what keeps that true.
        metadata: JSON.stringify({
          ...auditMetadata,
          customerInfoCompleted: true,
          completedAt: completedAt.toISOString(),
          source: 'PUBLIC_PRECHECKIN',
          insuranceSelection: insuranceSelection || null,
          selectedServices: selectedServices || null,
          thirdPartyBooking: thirdPartyBooking || null
        })
      }
    });
  }, { timeout: 20_000, maxWait: 10_000 });
}
