'use client';

/**
 * Pillar 2 — Client-side fee preview hook.
 *
 * Mirrors the backend fee-engine.service.js pure-compute functions so the
 * wizard UI can show fees "live" as staff adjusts inputs. The authoritative
 * fee computation still runs on the backend at POST /agreements/:id/checkin-close.
 *
 * Keep this file's math IN SYNC with backend/src/modules/fees/fee-engine.service.js
 * — both share the same fallback rates and same formulas.
 */

import { useMemo } from 'react';

// Hardcoded fallback rates — mirror seeded values in pillar2-migration-phase-a.sql
// AND the HARDCODED_RATES const in fee-engine.service.js.
export const FALLBACK_RATES = {
  EXCESS_MILEAGE:   { unit: 'PER_MILE',   amount: 0.50 },
  FUEL_REFILL:      { unit: 'PER_GALLON', amount: 7.00 },
  CLEANING_LIGHT:   { unit: 'FLAT',       amount: 50.00 },
  CLEANING_MEDIUM:  { unit: 'FLAT',       amount: 100.00 },
  CLEANING_HEAVY:   { unit: 'FLAT',       amount: 200.00 },
  SMOKING:          { unit: 'FLAT',       amount: 250.00 },
  LATE_RETURN:      { unit: 'PER_HOUR',   amount: 25.00 }
};

// Grace window (in minutes) before LATE_RETURN starts billing. Matches
// LATE_RETURN_GRACE_MINUTES in backend/src/modules/fees/fee-engine.service.js.
export const LATE_RETURN_GRACE_MINUTES = 30;

function round2(n) {
  return Math.round(Number(n || 0) * 100) / 100;
}

function pct(fraction) {
  return `${Math.round(Number(fraction || 0) * 100)}%`;
}

function rateOf(rates, key) {
  // Return null when the tenant has explicitly disabled this fee type
  // (isActive=false). Hook callers must skip computing the fee when this
  // returns null — mirrors the backend resolveRate() contract.
  const r = rates?.[key];
  if (r && r.disabled === true) return null;
  return r || FALLBACK_RATES[key];
}

export function computeExcessMileage({ odometerOut, odometerIn, includedMiles, rate }) {
  const out = Number(odometerOut || 0);
  const inn = Number(odometerIn || 0);
  if (inn <= out) return null;
  const driven = inn - out;
  const excess = Math.max(0, driven - includedMiles);
  if (excess === 0) return null;
  return {
    feeType: 'EXCESS_MILEAGE',
    quantity: excess,
    rate: rate.amount,
    total: round2(excess * rate.amount),
    description: `Excess mileage (${excess} miles over ${includedMiles} included)`,
    formula: `${excess} mi × $${rate.amount.toFixed(2)}/mi`
  };
}

export function computeFuelRefill({ fuelOut, fuelIn, tankCapacityGallons, rate }) {
  // 2026-06-04 — mirror of the backend fix: quantize both readings to the
  // nearest eighth (gauge resolution) so precision mismatches between
  // checkout and check-in capture can't produce phantom fuel fees.
  const toEighth = (v) => Math.round(Number(v || 0) * 8) / 8;
  const out = toEighth(fuelOut);
  const inn = toEighth(fuelIn);
  const gap = Math.max(0, out - inn);
  if (gap === 0) return null;
  const gallons = round2(gap * tankCapacityGallons);
  if (gallons === 0) return null;
  return {
    feeType: 'FUEL_REFILL',
    quantity: gallons,
    rate: rate.amount,
    total: round2(gallons * rate.amount),
    description: `Fuel refill (${gallons.toFixed(2)} gal — returned at ${pct(inn)} vs ${pct(out)} at pickup)`,
    formula: `${gallons.toFixed(2)} gal × $${rate.amount.toFixed(2)}/gal`
  };
}

export function computeCleaningFee({ cleanlinessOut, cleanlinessIn, ratesByTier }) {
  const out = Number(cleanlinessOut || 0);
  const inn = Number(cleanlinessIn || 0);
  if (out === 0 || inn === 0) return null;
  const delta = out - inn;
  if (delta <= 0) return null;
  let tier;
  if (delta >= 3) tier = 'HEAVY';
  else if (delta === 2) tier = 'MEDIUM';
  else tier = 'LIGHT';
  const tierKey = `CLEANING_${tier}`;
  const rate = ratesByTier[tierKey];
  if (!rate) return null;
  return {
    feeType: tierKey,
    quantity: 1,
    rate: rate.amount,
    total: round2(rate.amount),
    description: `Cleaning fee — ${tier.toLowerCase()} (cleanliness ${out}/5 → ${inn}/5)`,
    formula: `${tier} · ${delta}-tier drop`
  };
}

export function computeSmokingFee({ smokingDetected, rate }) {
  if (!smokingDetected) return null;
  return {
    feeType: 'SMOKING',
    quantity: 1,
    rate: rate.amount,
    total: round2(rate.amount),
    description: 'Smoking / tobacco residue cleaning',
    formula: 'Flat penalty'
  };
}

/**
 * Mirror of backend computeLateReturnFee. Keep math byte-for-byte aligned with
 * fee-engine.service.js so the wizard preview matches what /checkin-close will
 * actually charge.
 *
 * Formula (grace = 30 min by default):
 *   minutesLate     = max(0, returnedAt - dueBackAt) in minutes
 *   billableMinutes = max(0, minutesLate - graceMinutes)
 *   billableHours   = ceil(billableMinutes / 60)   — partial hours bill as full
 *
 * Defensive: missing dueBackAt/returnedAt → null. Future-dated dueBackAt
 * (returnedAt < dueBackAt) → null.
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
    feeType: 'LATE_RETURN',
    quantity: billableHours,
    rate: rate.amount,
    total: round2(billableHours * rate.amount),
    description: `Late return — ${billableHours} hour(s) past ${graceMinutes}-minute grace period`,
    formula: `${billableHours} hr × $${rate.amount.toFixed(2)}/hr`
  };
}

/**
 * The hook itself. Pass the agreement context + current input values, get
 * back a memoized fee list + totals. Re-runs on every input change.
 *
 * @param {object} params
 * @param {object} params.rates - resolved rates from backend, or null for fallbacks
 * @param {number} params.odometerOut, odometerIn
 * @param {number} params.fuelOut, fuelIn (0..1)
 * @param {number} params.cleanlinessOut, cleanlinessIn (1..5)
 * @param {boolean} params.smokingDetected
 * @param {string|Date} params.dueBackAt - reservation/agreement return-by timestamp
 * @param {string|Date} params.returnedAt - actual return timestamp (usually "now" in wizard)
 * @param {number} params.includedMilesPerDay (default 200)
 * @param {number} params.rentalDays (default 1)
 * @param {number} params.tankCapacityGallons (default 15)
 */
export function useFeePreview(params) {
  return useMemo(() => {
    const {
      rates,
      odometerOut, odometerIn,
      fuelOut, fuelIn,
      cleanlinessOut, cleanlinessIn,
      smokingDetected,
      dueBackAt, returnedAt,
      includedMilesPerDay = 200,
      rentalDays = 1,
      tankCapacityGallons = 15
    } = params;

    const mileageRate    = rateOf(rates, 'EXCESS_MILEAGE');
    const fuelRate       = rateOf(rates, 'FUEL_REFILL');
    const smokingRate    = rateOf(rates, 'SMOKING');
    const lateReturnRate = rateOf(rates, 'LATE_RETURN');
    const ratesByTier = {
      CLEANING_LIGHT:  rateOf(rates, 'CLEANING_LIGHT'),
      CLEANING_MEDIUM: rateOf(rates, 'CLEANING_MEDIUM'),
      CLEANING_HEAVY:  rateOf(rates, 'CLEANING_HEAVY')
    };

    const includedMiles = Math.max(0, Number(includedMilesPerDay) * Number(rentalDays));

    const items = [];
    // Each compute call is guarded by the rate being non-null (rateOf returns
    // null when the tenant disabled that fee type, mirroring the backend).
    if (mileageRate) {
      const mileage = computeExcessMileage({ odometerOut, odometerIn, includedMiles, rate: mileageRate });
      if (mileage) items.push(mileage);
    }
    if (fuelRate) {
      const fuel = computeFuelRefill({ fuelOut, fuelIn, tankCapacityGallons, rate: fuelRate });
      if (fuel) items.push(fuel);
    }
    // Cleaning: computeCleaningFee returns null if the matching tier rate is null,
    // so passing the tier dict directly works for partial disables.
    const cleaning = computeCleaningFee({ cleanlinessOut, cleanlinessIn, ratesByTier });
    if (cleaning) items.push(cleaning);
    if (smokingRate) {
      const smoking = computeSmokingFee({ smokingDetected, rate: smokingRate });
      if (smoking) items.push(smoking);
    }
    // LATE_RETURN — mirrors backend orchestration: skips silently if the tenant
    // disabled LATE_RETURN (rateOf → null) or if dueBackAt/returnedAt is missing.
    if (lateReturnRate) {
      const lateReturn = computeLateReturnFee({
        dueBackAt,
        returnedAt,
        graceMinutes: LATE_RETURN_GRACE_MINUTES,
        rate: lateReturnRate
      });
      if (lateReturn) items.push(lateReturn);
    }

    const total = round2(items.reduce((s, i) => s + i.total, 0));
    const byType = Object.fromEntries(items.map((i) => [i.feeType, i.total]));

    return { items, total, byType, includedMiles };
  }, [
    params.rates,
    params.odometerOut, params.odometerIn,
    params.fuelOut, params.fuelIn,
    params.cleanlinessOut, params.cleanlinessIn,
    params.smokingDetected,
    params.dueBackAt, params.returnedAt,
    params.includedMilesPerDay,
    params.rentalDays,
    params.tankCapacityGallons
  ]);
}
