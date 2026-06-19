/**
 * Utilization-based dynamic pricing (Fase 2).
 *
 * Projected utilization per (vehicle-type code = SIPP) per PICKUP DAY, computed with the
 * EXACT same math as the "Availability Forecast per Vehicle Type" report — we literally
 * reuse its `computeData` so the two can never disagree:
 *
 *   utilization[type][day] = reserved / capacity
 *     capacity = vehicles of the type, status NOT IN (OUT_OF_SERVICE, SOLD), at the location
 *     reserved = confirmed-set reservations (NEW/CONFIRMED/CHECKED_OUT/PENDING_FRANCHISE_IMPORT)
 *                whose pickup ≤ day < return, at the location (pickupLocationId)
 *
 * The rule is a table of tiers (per location, on MarketPricingConfig.utilizationRules):
 *   [{ maxPct, adjustAmount?, adjustPct? }, ...]  e.g.
 *   < 40% → −$3 · 40–70% → −$1 · 70–90% → match (0) · > 90% → +5%
 *
 * The tier ADJUSTS ON TOP of the base margin (Hector, 2026-06-19): we apply the base
 * strategy to the competitor all-in first, then nudge that target by the tier before the
 * gross-up → base conversion. Everything stays on the all-in plane.
 */

import { prisma } from '../../lib/prisma.js';
import { _availabilityInternal } from '../reports/availability-forecast.report.js';

async function resolveLocationId(tenantId, locationCode) {
  if (!tenantId || !locationCode) return null;
  try {
    const loc = await prisma.location.findFirst({
      where: { tenantId, code: String(locationCode).toUpperCase() },
      select: { id: true },
    });
    return loc?.id || null;
  } catch { return null; }
}

/**
 * Build a utilization lookup for a (tenant, location) over a date window.
 * Returns { utilOf(sipp, dayISO) -> 0..1 | null }. null = no capacity / out of window.
 * Best-effort: any failure yields a lookup that returns null (→ no adjustment).
 */
export async function buildUtilizationLookup({ tenantId, locationCode, fromISO, toISO }) {
  const empty = { utilOf: () => null };
  if (!tenantId || !fromISO) return empty;
  try {
    const locationId = await resolveLocationId(tenantId, locationCode);
    const data = await _availabilityInternal.computeData({
      tenantId,
      from: new Date(`${fromISO}T00:00:00.000Z`),
      to: new Date(`${(toISO || fromISO)}T00:00:00.000Z`),
      query: { locationId, _isExport: '1' }, // fast path: skip sold-out / last-year scans
    });
    const dayIndex = new Map((data.days || []).map((d, i) => [d.iso, i]));
    const byType = new Map((data.types || []).map((t) => [t.code, t]));
    return {
      utilOf(sipp, dayISO) {
        const t = byType.get(sipp);
        if (!t || !(t.capacity > 0)) return null;
        const i = dayIndex.get(dayISO);
        if (i == null) return null;
        const reserved = t.reservedByDay?.[i] || 0;
        return Math.min(1, Math.max(0, reserved / t.capacity));
      },
    };
  } catch { return empty; }
}

// Positional tier logic (pickUtilizationTier / resolveTierTarget) lives in the pure
// module ./pricing-tiers.js so it can be unit-tested without the prisma/report import.
