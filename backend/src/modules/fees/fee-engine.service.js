/**
 * Pillar 2 — Fee Engine Service
 *
 * Computes checkin fees from inspection deltas (mileage, fuel, cleanliness,
 * smoking) and writes them as RentalAgreementCharge rows. By writing to the
 * existing charges table, the engine plugs into:
 *   - agreement print/email rendering (reads charges automatically)
 *   - balance / paid / due rollups (already use charges sum)
 *   - invoice email line items
 *
 * Resolution order for rates:
 *   1. Location-specific FeeRate (locationId = X, feeType = Y)
 *   2. Tenant-default FeeRate (locationId = NULL, feeType = Y)
 *   3. Hardcoded fallback (HARDCODED_RATES below)
 *
 * The hardcoded fallback ensures a fresh tenant with no FeeRate rows still
 * computes fees correctly. The seeded tenant-default rows mirror these values
 * exactly — they exist mostly so tenants can edit them later without code change.
 *
 * Usage:
 *   const result = await feeEngine.computeCheckinFees({
 *     reservationId: 'cmp...',
 *     odometerOut: 12345, odometerIn: 12567,
 *     fuelOut: 1.0, fuelIn: 0.5,
 *     cleanlinessOut: 5, cleanlinessIn: 3,
 *     smokingDetected: false,
 *     includedMilesPerDay: 200,
 *     tankCapacityGallons: 15,
 *     persist: true  // false = dry run, returns items without DB write
 *   });
 *   // → { items: [...], total: 87.5, breakdown: {...} }
 */

import { prisma } from '../../lib/prisma.js';
import logger from '../../lib/logger.js';

// =============================================================================
// Hardcoded fallback rates — mirror seeded values in pillar2-migration-phase-a.sql
// Update both if either changes.
// =============================================================================

export const HARDCODED_RATES = {
  EXCESS_MILEAGE:   { unit: 'PER_MILE',   amount: 0.50 },
  FUEL_REFILL:      { unit: 'PER_GALLON', amount: 7.00 },
  CLEANING_LIGHT:   { unit: 'FLAT',       amount: 50.00 },
  CLEANING_MEDIUM:  { unit: 'FLAT',       amount: 100.00 },
  CLEANING_HEAVY:   { unit: 'FLAT',       amount: 200.00 },
  SMOKING:          { unit: 'FLAT',       amount: 250.00 },
  LATE_RETURN:      { unit: 'PER_HOUR',   amount: 25.00 }
};

// Grace window (in minutes) before LATE_RETURN starts billing. Partial hours
// after the grace window count as a full hour (ceil). Kept as a separate const
// rather than a HARDCODED_RATES field so resolveRate stays purely a {unit, amount}
// shape — and so we don't have to teach FeeRate rows about the grace concept.
export const LATE_RETURN_GRACE_MINUTES = 30;

// =============================================================================
// Rate resolution
// =============================================================================

/**
 * Resolve the active rate for a single feeType in this tenant/location.
 * Returns { unit, amount, source } where source is one of:
 *   'location' | 'tenant_default' | 'hardcoded'.
 */
export async function resolveRate({ tenantId, locationId, feeType }) {
  if (!tenantId) {
    throw new Error('resolveRate requires tenantId');
  }
  if (!HARDCODED_RATES[feeType]) {
    throw new Error(`Unknown feeType: ${feeType}`);
  }

  // 1. Location-specific override
  if (locationId) {
    const locRate = await prisma.feeRate.findFirst({
      where: { tenantId, locationId, feeType, isActive: true }
    });
    if (locRate) {
      return {
        unit: locRate.unit,
        amount: Number(locRate.amount),
        source: 'location',
        rateId: locRate.id
      };
    }
  }

  // 2. Tenant default
  const tenantRate = await prisma.feeRate.findFirst({
    where: { tenantId, locationId: null, feeType, isActive: true }
  });
  if (tenantRate) {
    return {
      unit: tenantRate.unit,
      amount: Number(tenantRate.amount),
      source: 'tenant_default',
      rateId: tenantRate.id
    };
  }

  // 3. Hardcoded fallback
  const fb = HARDCODED_RATES[feeType];
  return { unit: fb.unit, amount: fb.amount, source: 'hardcoded', rateId: null };
}

// =============================================================================
// Per-fee computation logic
//
// Each function is pure (no DB, no side effects) for easy unit testing.
// They return { quantity, total, description } or null if no fee applies.
// =============================================================================

export function computeExcessMileage({ odometerOut, odometerIn, includedMiles, rate }) {
  const out = Number(odometerOut || 0);
  const inn = Number(odometerIn || 0);
  if (inn <= out) return null;  // safety — no negative deltas
  const driven = inn - out;
  const excess = Math.max(0, driven - includedMiles);
  if (excess === 0) return null;
  return {
    quantity: excess,
    rate: rate.amount,
    total: round2(excess * rate.amount),
    description: `Excess mileage (${excess} miles over ${includedMiles} included)`
  };
}

export function computeFuelRefill({ fuelOut, fuelIn, tankCapacityGallons, rate }) {
  const out = Number(fuelOut || 0);
  const inn = Number(fuelIn || 0);
  // fuel is 0..1 fraction. gap = how much fuel customer used below their pickup level
  const gap = Math.max(0, out - inn);
  if (gap === 0) return null;
  const gallons = round2(gap * tankCapacityGallons);
  if (gallons === 0) return null;
  return {
    quantity: gallons,
    rate: rate.amount,
    total: round2(gallons * rate.amount),
    description: `Fuel refill (${gallons.toFixed(2)} gal — returned at ${pct(inn)} vs ${pct(out)} at pickup)`
  };
}

/**
 * Cleanliness scale: 1..5 where 5 = pristine, 1 = filthy.
 * Delta = cleanlinessOut - cleanlinessIn (positive = customer made it worse).
 *
 *   delta >= 3 → HEAVY    (e.g., picked up at 5, returned at 1 or 2)
 *   delta == 2 → MEDIUM
 *   delta == 1 → LIGHT
 *   delta <= 0 → no fee
 *
 * Returns the appropriate fee type + tier amount.
 */
export function computeCleaningFee({ cleanlinessOut, cleanlinessIn, ratesByTier }) {
  const out = Number(cleanlinessOut || 0);
  const inn = Number(cleanlinessIn || 0);
  if (out === 0 || inn === 0) return null;  // missing data — no fee
  const delta = out - inn;
  if (delta <= 0) return null;
  let tier = null;
  if (delta >= 3) tier = 'HEAVY';
  else if (delta === 2) tier = 'MEDIUM';
  else tier = 'LIGHT';
  const tierKey = `CLEANING_${tier}`;
  const rate = ratesByTier[tierKey];
  if (!rate) return null;  // shouldn't happen
  return {
    feeType: tierKey,
    quantity: 1,
    rate: rate.amount,
    total: round2(rate.amount),
    description: `Cleaning fee — ${tier.toLowerCase()} (cleanliness ${out}/5 → ${inn}/5)`
  };
}

export function computeSmokingFee({ smokingDetected, rate }) {
  if (!smokingDetected) return null;
  return {
    quantity: 1,
    rate: rate.amount,
    total: round2(rate.amount),
    description: 'Smoking / tobacco residue cleaning'
  };
}

/**
 * Late-return fee. Charged per hour AFTER a grace window has elapsed.
 *
 *   minutesLate     = max(0, returnedAt - dueBackAt) in minutes
 *   billableMinutes = max(0, minutesLate - graceMinutes)
 *   billableHours   = ceil(billableMinutes / 60)   — partial hours bill as full hour
 *
 * Examples (grace = 30 min):
 *   on-time / early           → 0 hours, no charge
 *   15 min late (under grace) → 0 hours, no charge
 *   35 min late (5 over grace)→ 1 hour billed
 *   90 min late (60 over)     → 1 hour billed
 *   2h 10m late (1h 40m over) → 2 hours billed (ceil 100min / 60)
 *
 * Defensive: missing dueBackAt or returnedAt → null (no fee). Future-dated
 * dueBackAt (returnedAt < dueBackAt) → null.
 */
export function computeLateReturnFee({ dueBackAt, returnedAt, graceMinutes = LATE_RETURN_GRACE_MINUTES, rate }) {
  if (!dueBackAt || !returnedAt) return null;
  const due = new Date(dueBackAt).getTime();
  const ret = new Date(returnedAt).getTime();
  if (!Number.isFinite(due) || !Number.isFinite(ret)) return null;
  const minutesLate = Math.max(0, (ret - due) / 60000);
  const billableMinutes = Math.max(0, minutesLate - Number(graceMinutes || 0));
  const billableHours = Math.ceil(billableMinutes / 60);
  if (billableHours <= 0) return null;
  return {
    quantity: billableHours,
    rate: rate.amount,
    total: round2(billableHours * rate.amount),
    description: `Late return — ${billableHours} hour(s) past ${graceMinutes}-minute grace period`
  };
}

// =============================================================================
// Orchestration
// =============================================================================

/**
 * Compute all checkin fees for a reservation. Optionally persist as
 * RentalAgreementCharge rows.
 *
 * Inputs:
 *   reservationId            — required, used for FK on charges
 *   tenantId, locationId     — required, used for rate resolution
 *   rentalAgreementId        — required if persist=true (charges FK)
 *   odometerOut/In           — integers (miles)
 *   fuelOut/In               — 0..1 (fraction of tank)
 *   cleanlinessOut/In        — 1..5
 *   smokingDetected          — boolean
 *   includedMilesPerDay      — number; multiplied by rental days
 *   rentalDays               — number; required if includedMilesPerDay > 0
 *   tankCapacityGallons      — number; required if fuel delta > 0
 *   persist                  — boolean (default false)
 *   actorUserId              — optional, for audit
 *
 * Returns:
 *   { items: FeeItem[], total: number, breakdown: { byType, rateSources } }
 */
export async function computeCheckinFees(params) {
  const {
    reservationId,
    rentalAgreementId,
    tenantId,
    locationId,
    odometerOut, odometerIn,
    fuelOut, fuelIn,
    cleanlinessOut, cleanlinessIn,
    smokingDetected,
    dueBackAt = null,
    returnedAt = null,
    includedMilesPerDay = 200,
    rentalDays = 1,
    tankCapacityGallons = 15,
    persist = false,
    actorUserId = null
  } = params;

  if (!reservationId) throw new Error('computeCheckinFees requires reservationId');
  if (!tenantId)      throw new Error('computeCheckinFees requires tenantId');
  if (persist && !rentalAgreementId) {
    throw new Error('computeCheckinFees requires rentalAgreementId when persist=true');
  }

  // Resolve all rates in parallel — 7 queries become 1 round-trip wave.
  const [
    mileageRate,
    fuelRate,
    cleaningLight,
    cleaningMedium,
    cleaningHeavy,
    smokingRate,
    lateReturnRate
  ] = await Promise.all([
    resolveRate({ tenantId, locationId, feeType: 'EXCESS_MILEAGE' }),
    resolveRate({ tenantId, locationId, feeType: 'FUEL_REFILL' }),
    resolveRate({ tenantId, locationId, feeType: 'CLEANING_LIGHT' }),
    resolveRate({ tenantId, locationId, feeType: 'CLEANING_MEDIUM' }),
    resolveRate({ tenantId, locationId, feeType: 'CLEANING_HEAVY' }),
    resolveRate({ tenantId, locationId, feeType: 'SMOKING' }),
    resolveRate({ tenantId, locationId, feeType: 'LATE_RETURN' })
  ]);

  const ratesByTier = {
    CLEANING_LIGHT:  cleaningLight,
    CLEANING_MEDIUM: cleaningMedium,
    CLEANING_HEAVY:  cleaningHeavy
  };

  const includedMiles = Math.max(0, Number(includedMilesPerDay) * Number(rentalDays));

  // Run pure computations
  const items = [];
  const rateSources = {};

  const mileage = computeExcessMileage({ odometerOut, odometerIn, includedMiles, rate: mileageRate });
  if (mileage) {
    items.push({ feeType: 'EXCESS_MILEAGE', ...mileage });
    rateSources.EXCESS_MILEAGE = mileageRate.source;
  }

  const fuel = computeFuelRefill({ fuelOut, fuelIn, tankCapacityGallons, rate: fuelRate });
  if (fuel) {
    items.push({ feeType: 'FUEL_REFILL', ...fuel });
    rateSources.FUEL_REFILL = fuelRate.source;
  }

  const cleaning = computeCleaningFee({ cleanlinessOut, cleanlinessIn, ratesByTier });
  if (cleaning) {
    items.push(cleaning);
    rateSources[cleaning.feeType] = ratesByTier[cleaning.feeType].source;
  }

  const smoking = computeSmokingFee({ smokingDetected, rate: smokingRate });
  if (smoking) {
    items.push({ feeType: 'SMOKING', ...smoking });
    rateSources.SMOKING = smokingRate.source;
  }

  // LATE_RETURN — skips silently if dueBackAt or returnedAt is missing so
  // existing 6-fee-type callers keep working unchanged.
  const lateReturn = computeLateReturnFee({
    dueBackAt,
    returnedAt,
    graceMinutes: LATE_RETURN_GRACE_MINUTES,
    rate: lateReturnRate
  });
  if (lateReturn) {
    items.push({ feeType: 'LATE_RETURN', ...lateReturn });
    rateSources.LATE_RETURN = lateReturnRate.source;
  }

  const total = round2(items.reduce((sum, item) => sum + item.total, 0));

  const breakdown = {
    byType: Object.fromEntries(items.map((i) => [i.feeType, i.total])),
    rateSources
  };

  // Persist as RentalAgreementCharge rows
  if (persist && items.length > 0) {
    await persistFeesAsCharges({
      rentalAgreementId,
      items,
      actorUserId
    });
    logger.info('[fee-engine] persisted checkin fees', {
      reservationId,
      rentalAgreementId,
      total,
      itemCount: items.length,
      breakdown: breakdown.byType
    });
  }

  return { items, total, breakdown };
}

// =============================================================================
// Persistence helpers
// =============================================================================

async function persistFeesAsCharges({ rentalAgreementId, items, actorUserId }) {
  // Order them after existing charges so they appear at the bottom of the
  // agreement charges list and the invoice email line items.
  const lastCharge = await prisma.rentalAgreementCharge.findFirst({
    where: { rentalAgreementId },
    orderBy: { sortOrder: 'desc' },
    select: { sortOrder: true }
  });
  const baseSortOrder = (Number(lastCharge?.sortOrder) || 0) + 100;

  // Use chargeType: 'UNIT' (valid enum value) + source: 'FEE_ENGINE_CHECKIN'
  // + sourceRefId: feeType. This distinguishes engine-computed fees from
  // pre-existing subtotal items / TAX items without needing a new enum value.
  await prisma.$transaction(
    items.map((item, idx) => prisma.rentalAgreementCharge.create({
      data: {
        rentalAgreementId,
        name: item.description,
        chargeType: 'UNIT',
        quantity: item.quantity,
        rate: item.rate,
        total: item.total,
        taxable: false,
        selected: true,
        sortOrder: baseSortOrder + idx,
        source: 'FEE_ENGINE_CHECKIN',
        sourceRefId: item.feeType
      }
    }))
  );

  // Recompute agreement totals (subtotal/fees/total/balance) so the new fees
  // are reflected immediately. Reuses the same logic that runs after manual
  // charge additions in rental-agreements.service.js.
  await recomputeAgreementTotals(rentalAgreementId);
}

async function recomputeAgreementTotals(rentalAgreementId) {
  // Pull all SELECTED charges for this agreement.
  // Bucketing:
  //   TAX         → taxes
  //   source startsWith FEE_ENGINE  → fees   (checkin-computed fees from the engine)
  //   everything else                → subtotal
  // This matches the existing schema fields on RentalAgreement and the
  // convention in rental-agreements.service.js (taxable, taxes, fees split).
  const charges = await prisma.rentalAgreementCharge.findMany({
    where: { rentalAgreementId, selected: true },
    select: { chargeType: true, total: true, source: true }
  });

  let subtotal = 0;
  let taxes = 0;
  let fees = 0;

  for (const c of charges) {
    const t = Number(c.total || 0);
    const type = String(c.chargeType || '').toUpperCase();
    const src = String(c.source || '').toUpperCase();
    if (type === 'TAX') {
      taxes += t;
    } else if (src.startsWith('FEE_ENGINE')) {
      fees += t;
    } else {
      subtotal += t;
    }
  }

  const total = round2(subtotal + taxes + fees);

  // Get currently paid amount
  const payments = await prisma.rentalAgreementPayment.findMany({
    where: { rentalAgreementId, status: 'PAID' },
    select: { amount: true }
  });
  const paidAmount = round2(payments.reduce((s, p) => s + Number(p.amount || 0), 0));
  const balance = round2(total - paidAmount);

  await prisma.rentalAgreement.update({
    where: { id: rentalAgreementId },
    data: {
      subtotal: round2(subtotal),
      taxes: round2(taxes),
      fees: round2(fees),
      total,
      paidAmount,
      balance
    }
  });

  return { subtotal: round2(subtotal), taxes: round2(taxes), fees: round2(fees), total, paidAmount, balance };
}

// =============================================================================
// Utilities
// =============================================================================

function round2(n) {
  return Math.round(Number(n || 0) * 100) / 100;
}

function pct(fraction) {
  return `${Math.round(Number(fraction || 0) * 100)}%`;
}

// =============================================================================
// Public API
// =============================================================================

export const feeEngineService = {
  resolveRate,
  computeExcessMileage,
  computeFuelRefill,
  computeCleaningFee,
  computeSmokingFee,
  computeLateReturnFee,
  computeCheckinFees,
  HARDCODED_RATES,
  LATE_RETURN_GRACE_MINUTES
};
