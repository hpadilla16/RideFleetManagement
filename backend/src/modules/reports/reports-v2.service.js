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

  // 3. Available vehicles right now — computed from reservations + blocks,
  //    not from Vehicle.status (which drifts heavily in production).
  //    totalFleet counts every vehicle that isn't OUT_OF_SERVICE.
  //    Available = totalFleet − (currentlyRented ∪ blocked)
  //    where blocked = vehicles with an active maintenance job OR a
  //    MAINTENANCE_HOLD / OUT_OF_SERVICE_HOLD / WASH_HOLD block.
  let totalFleet = 0;
  const rentedVehicleIds = new Set();
  const blockedVehicleIds = new Set();
  try {
    totalFleet = await prisma.vehicle.count({
      where: { tenantId, status: { notIn: ['OUT_OF_SERVICE', 'SOLD'] } },
    });
  } catch { /* ignore */ }
  try {
    // Hybrid grace period: count CHECKED_OUT rows whose returnAt is in the
    // future OR within the last 14 days (still-within-plan + recently
    // overdue). Past 14 days = assumed stale data (returned but never
    // closed in the system), shown in the Overdue Returns triage list
    // for cleanup but NOT counted as on-rent.
    const GRACE_PERIOD_DAYS = 14;
    const gracePeriodStart = new Date(now.getTime() - GRACE_PERIOD_DAYS * 24 * 60 * 60 * 1000);
    const activeReservations = await prisma.reservation.findMany({
      where: {
        tenantId,
        status: 'CHECKED_OUT',
        pickupAt: { lte: now },
        returnAt: { gt: gracePeriodStart },
        vehicleId: { not: null },
        // Grandfathered (2026-05-27) — physically returned, exclude
        // from the "currently rented" set so available-count math
        // matches the lot.
        overdueIgnored: false,
      },
      select: { vehicleId: true },
    });
    for (const r of activeReservations) {
      if (r.vehicleId) rentedVehicleIds.add(r.vehicleId);
    }
  } catch { /* ignore */ }
  try {
    // Vehicles blocked by maintenance / OOS / wash. Includes open
    // maintenance jobs and active VehicleAvailabilityBlock rows. Hector
    // observed a 3-car gap (57 reported vs 54 physical) where these
    // blocked vehicles were leaking into 'available'.
    const [activeBlocks, openMaintenanceJobs] = await Promise.all([
      prisma.vehicleAvailabilityBlock.findMany({
        where: {
          tenantId,
          releasedAt: null,
          blockedFrom: { lte: now },
          availableFrom: { gt: now },
          blockType: { in: ['MAINTENANCE_HOLD', 'OUT_OF_SERVICE_HOLD', 'WASH_HOLD'] },
        },
        select: { vehicleId: true },
      }),
      prisma.maintenanceJob.findMany({
        where: {
          status: { in: ['OPEN', 'IN_PROGRESS'] },
          vehicle: { tenantId },
        },
        select: { vehicleId: true },
      }),
    ]);
    for (const b of activeBlocks)        if (b.vehicleId) blockedVehicleIds.add(b.vehicleId);
    for (const j of openMaintenanceJobs) if (j.vehicleId) blockedVehicleIds.add(j.vehicleId);
  } catch { /* ignore */ }
  // Union rented + blocked, dedup, that's the not-available count.
  const notAvailable = new Set([...rentedVehicleIds, ...blockedVehicleIds]);
  const currentlyRented = rentedVehicleIds.size;
  const blockedCount = blockedVehicleIds.size;
  const available = Math.max(0, totalFleet - notAvailable.size);

  return {
    tenantId,
    range: { from: fromDate.toISOString(), to: toEndExclusive.toISOString() },
    tenantTimeZone: tenantTz,
    revenue: Math.round(revenue * 100) / 100,
    revenueCents: Math.round(revenue * 100),
    reservationsCheckedOut: checkedOut,
    availableVehicles: available,
    currentlyRented,
    blockedForMaintenance: blockedCount,
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
