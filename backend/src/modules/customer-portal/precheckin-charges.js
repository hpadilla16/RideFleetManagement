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
 * charges standing on the reservation when the customer submits.
 *
 * ADDITIONAL_SERVICE_PRECHECKIN rows are excluded, which is NOT a pricing
 * change — it is what makes a re-submission price the same as the first one.
 * Only this handler ever writes that source, and it writes it AFTER the
 * insurance line is computed, so on a genuine first submission there are none
 * and the exclusion is a no-op. On a second submission (a double-tap, or a
 * customer coming back to fix their address) the first run's service rows WOULD
 * be sitting here, inflating the base, and the customer's insurance would be
 * re-priced upward for having pressed the button twice. Same reason `source`
 * INSURANCE is excluded, which the original already did.
 */
export function insuranceBaseFrom(charges) {
  return charges
    .filter((c) => {
      const source = String(c.source || '').toUpperCase();
      const type = String(c.chargeType || '').toUpperCase();
      return source !== 'INSURANCE'
        && source !== 'ADDITIONAL_SERVICE_PRECHECKIN'
        && type !== 'TAX'
        && type !== 'DEPOSIT';
    })
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
 * 20s is not a guess at how long this takes — it takes milliseconds. It is
 * headroom over Prisma's 5s default so that a slow-but-alive database rolls
 * nothing back on a timeout; the work inside is pure Postgres, with every
 * network call hoisted out by the caller.
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
    // ONE SUBMISSION PER RESERVATION AT A TIME.
    //
    // portalWrite is a per-IP rate limit and nothing else, so a customer who
    // double-taps Submit — or whose phone retries on a flaky connection — gets
    // two of these running at once. A transaction alone does NOT fix that:
    // under READ COMMITTED both runs read "no voucher yet" and both INSERT one,
    // and the second run's `deleteMany({chargeType:'TAX'})` can be evaluated
    // before the first run's replacement tax row is visible, leaving TWO tax
    // lines on the reservation. Duplicated money rows on a customer-driven
    // route are worse than the 500 this change set out to remove.
    //
    // A transaction-scoped advisory lock serializes them with no schema change
    // and no client-supplied idempotency key: the second run waits, then
    // re-executes against the first run's committed state, and every block here
    // is delete-then-recreate, so it lands on the same end state. The lock is
    // released by COMMIT or ROLLBACK — there is no path that leaks it.
    //
    // Namespaced because pg_advisory_xact_lock's keyspace is database-wide; a
    // bare hash of the reservation id would collide with any other feature that
    // later decides to lock "a reservation".
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`customer-portal:precheckin:${reservation.id}`})::bigint)`;

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
        // Tax rate from the pricing snapshot, else the pickup location.
        //
        // NOTE, not a fix: findReservationByToken('customer-info') does NOT
        // include pricingSnapshot, so on this path the first operand is always
        // undefined and the location's rate is what actually applies. Left
        // exactly as it was — changing which rate a customer is taxed at is its
        // own decision with its own review, not a rider on an atomicity fix.
        const loc = reservation.pickupLocationId
          ? await tx.location.findUnique({ where: { id: reservation.pickupLocationId }, select: { taxRate: true } })
          : null;
        const taxRate = Number(reservation.pricingSnapshot?.taxRate ?? loc?.taxRate ?? 0);
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
        metadata: JSON.stringify({
          customerInfoCompleted: true,
          completedAt: completedAt.toISOString(),
          source: 'PUBLIC_PRECHECKIN',
          insuranceSelection: insuranceSelection || null,
          selectedServices: selectedServices || null,
          thirdPartyBooking: thirdPartyBooking || null,
          ...auditMetadata
        })
      }
    });
  }, { timeout: 20_000, maxWait: 10_000 });
}
