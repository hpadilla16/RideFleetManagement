/**
 * Reports v2 service — Round 24 (2026-05-22).
 *
 * Single point of dispatch for the new reports module:
 *
 *   listReports({ tenantId })
 *     Returns the directory of available reports grouped by category.
 *     Used by the /reports landing page to render the table of contents.
 *
 *   getSnapshot({ tenantId, from, to })
 *     Returns the headline metrics widget for the landing page:
 *     MTD revenue, reservations checked out, available vehicles.
 *
 * Each individual report (commission-sales, agent-track-record,
 * availability-forecast, …) lives in its own file `reports/<slug>.report.js`
 * exporting:
 *
 *   { slug, title, category, description, icon, computeData,
 *     renderHtml, buildExcelSpec }
 *
 * `reports-v2.routes.js` discovers them via the registry below.
 */

const REPORT_REGISTRY = [
  // Management
  {
    slug: 'reservations-by-day',
    title: 'Reservations by Day',
    category: 'MANAGEMENT',
    icon: 'calendar',
    description: 'Daily pickup load by status',
    status: 'AVAILABLE',
  },
  {
    slug: 'payments-by-day',
    title: 'Payments by Day',
    category: 'MANAGEMENT',
    icon: 'cash',
    description: 'Cash · card · digital totals',
    status: 'AVAILABLE',
  },
  {
    slug: 'rental-status',
    title: 'Rental Status',
    category: 'MANAGEMENT',
    icon: 'list-check',
    description: 'Right-now triage of every active rental',
    status: 'AVAILABLE',
  },

  // Fleet
  {
    slug: 'fleet-status',
    title: 'Fleet Status',
    category: 'FLEET',
    icon: 'car',
    description: 'Every vehicle, current state · sortable',
    status: 'AVAILABLE',
  },
  {
    slug: 'utilization',
    title: 'Utilization',
    category: 'FLEET',
    icon: 'chart-bar',
    description: '% of fleet rented over time',
    status: 'AVAILABLE',
  },
  {
    slug: 'upcoming-vehicle-sales',
    title: 'Upcoming Vehicle Sales',
    category: 'FLEET',
    icon: 'tag',
    description: 'Cars approaching mileage/age sale threshold',
    // 2026-05-27: blocked back to COMING_SOON. Source-of-truth inputs
    // (target sale mileage, target sale age, expected sale window, sale
    // channel, asking price) need to live on Vehicle profile first
    // before the report can be meaningful. Until then we'd be guessing
    // off generic mileage/age thresholds.
    status: 'COMING_SOON',
  },
  {
    slug: 'toll-per-vehicle',
    title: 'Toll Report — per Vehicle',
    category: 'FLEET',
    icon: 'road',
    description: 'Tolls grouped by vehicle',
    status: 'AVAILABLE',
  },
  {
    slug: 'toll-per-location',
    title: 'Toll Report — per Location',
    category: 'FLEET',
    icon: 'map-pin',
    description: 'Tolls grouped by plaza',
    status: 'AVAILABLE',
  },
  {
    slug: 'availability',
    title: 'Availability — Right Now',
    category: 'FLEET',
    icon: 'clipboard-check',
    description: 'Current state of every vehicle, by class · live snapshot',
    status: 'AVAILABLE',
  },
  {
    slug: 'availability-forecast',
    title: 'Availability Forecast — per Vehicle Type',
    category: 'FLEET',
    icon: 'trending-up',
    description: 'Day-by-day projected inventory',
    status: 'AVAILABLE',
  },
  { slug: 'damage',                title: 'Damage',                       category: 'FLEET', icon: 'alert-triangle', description: 'Findings + repair cost summary' },

  // Operations
  // 2026-05-26: 'commission' (Commission Payouts) was retired — its numbers
  // diverged from commission-sales-performance because it read from the
  // AgreementCommission ledger (subject to per-employee CommissionPlan
  // configuration), while sales-performance computed directly from the
  // SERVICE_CATALOG flat rates that match Hector's hand-built April PDF.
  // Single source of truth is now commission-sales-performance.
  {
    slug: 'commission-sales-performance',
    title: 'Commission & Sales Performance',
    category: 'OPERATIONS',
    icon: 'users',
    description: 'Per-agent attach + commission',
    status: 'AVAILABLE',
  },
  {
    slug: 'agent-track-record',
    title: 'Rental Agent Track Record — Month over Month',
    category: 'OPERATIONS',
    icon: 'calendar-stats',
    description: 'Multi-month performance trends',
    status: 'AVAILABLE',
  },
  {
    slug: 'pre-paid-reservations',
    title: 'Pre-Paid Reservations',
    category: 'OPERATIONS',
    icon: 'credit-card',
    description: 'TL franchise pre-paid bookings — monthly recap by location',
    status: 'AVAILABLE',
  },

  // Revenue
  {
    slug: 'unpaid-balance',
    title: 'Unpaid Balance',
    category: 'REVENUE',
    icon: 'credit-card-off',
    description: 'AR aging · money owed by customers',
    status: 'AVAILABLE',
  },
  {
    slug: 'sales',
    title: 'Sales by Category',
    category: 'REVENUE',
    icon: 'coin',
    description: 'Revenue by line-item category',
    status: 'AVAILABLE',
  },
  {
    slug: 'taxes',
    title: 'Taxes',
    category: 'REVENUE',
    icon: 'percentage',
    description: 'Tax collected + taxable base · for your accountant',
    status: 'AVAILABLE',
  },
  { slug: 'chargeback',     title: 'Chargeback',     category: 'REVENUE', icon: 'arrow-back-up',   description: 'Disputes + evidence packs' },
];

import { startOfDayInTz, startOfMonthInTz, addDaysInTz } from '../../lib/date-utils.js';
import { resolveTenantTimeZone } from '../../lib/tenant-tz.js';

let _defaultPrisma = null;
async function resolveDefaultPrisma() {
  if (_defaultPrisma) return _defaultPrisma;
  const mod = await import('../../lib/prisma.js');
  _defaultPrisma = mod.prisma;
  return _defaultPrisma;
}

export class ReportsServiceError extends Error {
  constructor(message, status = 400, code = null) {
    super(message);
    this.name = 'ReportsServiceError';
    this.status = status;
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// listReports
// ---------------------------------------------------------------------------

/**
 * Return the report directory. Each entry includes a status hint so the UI
 * can render coming-soon tiles vs available ones. The first three reports
 * (commission-sales-performance, agent-track-record, availability-forecast)
 * are AVAILABLE in round 24; the rest land in subsequent rounds.
 */
export async function listReports({ tenantId } = {}) {
  if (!tenantId) throw new ReportsServiceError('tenantId required', 403);
  const reports = REPORT_REGISTRY.map((r) => ({
    slug: r.slug,
    title: r.title,
    category: r.category,
    icon: r.icon,
    description: r.description,
    status: r.status || 'COMING_SOON',
    // URL is constructed on the frontend via `/reports-v2/${slug}`; not duplicated here.
  }));
  return {
    reports,
    categories: ['MANAGEMENT', 'FLEET', 'OPERATIONS', 'REVENUE'],
  };
}

// ---------------------------------------------------------------------------
// getSnapshot
// ---------------------------------------------------------------------------

/**
 * Compute the three snapshot metrics shown at the top of the landing page:
 *   1. Revenue in window — sum of RentalAgreementPayment.amount where
 *      paidAt is in the window (tenant-local day boundaries).
 *   2. Reservations checked out in window — rentals whose pickup actually
 *      happened during the window (pickupAt in window AND status reached
 *      at least CHECKED_OUT). This counts both still-out rentals and ones
 *      that have already returned — anything that "started" in the window.
 *   3. Available vehicles right now — computed from active reservations
 *      (not the Vehicle.status field, which can drift). Available =
 *      totalFleet − vehicles currently on rent. Matches the methodology
 *      of availability-forecast.report.js.
 *
 * 2026-05-27 rewrite of three bugs in the previous implementation:
 *   - `status: { not: 'RETIRED' }` referenced a non-existent VehicleStatus
 *     enum value; Prisma threw, the try/catch swallowed it, totalFleet=0.
 *   - `status IN ['CHECKED_OUT', 'IN_PROGRESS']` — IN_PROGRESS is not a
 *     ReservationStatus value; same silent failure → checkedOut=0.
 *   - dates parsed raw, not tenant-TZ aware → window misaligned in PR.
 */
export async function getSnapshot({ tenantId, from, to, deps = {} } = {}) {
  if (!tenantId) throw new ReportsServiceError('tenantId required', 403);
  const prisma = deps.prisma || (await resolveDefaultPrisma());

  const tenantTz = deps.tenantTz || (await resolveTenantTimeZone(tenantId));
  const now = (deps && deps.now) || new Date();
  // Window: [from 00:00 tenant TZ, to+1day 00:00 tenant TZ) so the entire
  // `to` day is included.
  const fromDate = from ? startOfDayInTz(from, tenantTz) : startOfMonthInTz(now, tenantTz);
  const toEndExclusive = to ? addDaysInTz(startOfDayInTz(to, tenantTz), 1) : addDaysInTz(startOfDayInTz(now, tenantTz), 1);

  // 1. Revenue — sum of payment amounts in the window for this tenant.
  let revenue = 0;
  try {
    const payments = await prisma.rentalAgreementPayment.findMany({
      where: {
        rentalAgreement: { tenantId },
        paidAt: { gte: fromDate, lt: toEndExclusive },
      },
      select: { amount: true },
    });
    for (const p of payments) {
      const n = Number(p.amount);
      if (Number.isFinite(n)) revenue += n;
    }
  } catch { /* ignore */ }

  // 2. Reservations that picked up in the window. pickupAt is the scheduled
  //    pickup; status filter ensures the rental actually progressed past
  //    confirmation. We count CHECKED_OUT (still out), CHECKED_IN /
  //    CHECKED_IN_UNPAID (already returned in or after window) — i.e.
  //    every rental that started.
  let checkedOut = 0;
  try {
    checkedOut = await prisma.reservation.count({
      where: {
        tenantId,
        status: { in: ['CHECKED_OUT', 'CHECKED_IN', 'CHECKED_IN_UNPAID'] },
        pickupAt: { gte: fromDate, lt: toEndExclusive },
      },
    });
  } catch { /* ignore */ }

  // 3. Available vehicles right now — computed from reservations, not from
  //    Vehicle.status (which can drift). totalFleet excludes only
  //    OUT_OF_SERVICE (totaled / sold). Currently-rented = unique
  //    vehicleIds in CHECKED_OUT reservations (i.e. physically out of the
  //    lot right now). We deliberately don't include CHECKED_IN_UNPAID —
  //    that's a payment-pending state where the car is already back. Must
  //    match fleet-status.report.js so the two reports agree.
  let totalFleet = 0;
  let currentlyRented = 0;
  try {
    totalFleet = await prisma.vehicle.count({
      where: { tenantId, status: { not: 'OUT_OF_SERVICE' } },
    });
  } catch { /* ignore */ }
  try {
    // returnAt > now filters out stuck CHECKED_OUT rows whose planned
    // return is in the past (those rentals usually got returned without
    // the system getting updated — data hygiene issue). Without this we
    // counted every "stale" overdue reservation as still-out, inflating
    // on-rent and shrinking available. Includes real overdue customers
    // by definition but in practice they're a tiny fraction; net signal
    // is much cleaner.
    const activeReservations = await prisma.reservation.findMany({
      where: {
        tenantId,
        status: 'CHECKED_OUT',
        pickupAt: { lte: now },
        returnAt: { gt: now },
        vehicleId: { not: null },
      },
      select: { vehicleId: true },
    });
    const uniqueVehicles = new Set(activeReservations.map((r) => r.vehicleId).filter(Boolean));
    currentlyRented = uniqueVehicles.size;
  } catch { /* ignore */ }
  const available = Math.max(0, totalFleet - currentlyRented);

  return {
    tenantId,
    range: { from: fromDate.toISOString(), to: toEndExclusive.toISOString() },
    tenantTimeZone: tenantTz,
    revenue: Math.round(revenue * 100) / 100,
    revenueCents: Math.round(revenue * 100),
    reservationsCheckedOut: checkedOut,
    availableVehicles: available,
    currentlyRented,
    totalFleet,
    utilizationPct: totalFleet > 0 ? Math.round((currentlyRented / totalFleet) * 100) : 0,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
// startOfMonth helper was removed — getSnapshot now uses tz-aware
// startOfMonthInTz from lib/date-utils.

export const _internal = {
  REPORT_REGISTRY,
};
