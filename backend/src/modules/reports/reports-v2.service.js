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
    status: 'AVAILABLE',
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
  {
    slug: 'commission',
    title: 'Commission Payouts',
    category: 'OPERATIONS',
    icon: 'receipt-2',
    description: 'Commission paid + accrued per period, per employee',
    status: 'AVAILABLE',
  },
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
 *   1. Month-to-date revenue (sum of RentalAgreementPayment.amount in window)
 *   2. Reservations checked out in window (status CHECKED_OUT / IN_PROGRESS)
 *   3. Available vehicles right now (Vehicle.status = AVAILABLE)
 */
export async function getSnapshot({ tenantId, from, to, deps = {} } = {}) {
  if (!tenantId) throw new ReportsServiceError('tenantId required', 403);
  const prisma = deps.prisma || (await resolveDefaultPrisma());
  const fromDate = from ? new Date(from) : startOfMonth(new Date());
  const toDate = to ? new Date(to) : new Date();

  // 1. MTD revenue — sum of payment amounts in the window for this tenant.
  let revenue = 0;
  try {
    const payments = await prisma.rentalAgreementPayment.findMany({
      where: {
        rentalAgreement: { tenantId },
        paidAt: { gte: fromDate, lte: toDate },
      },
      select: { amount: true },
    });
    for (const p of payments) {
      const n = Number(p.amount);
      if (Number.isFinite(n)) revenue += n;
    }
  } catch { /* table or relation may not exist in older envs */ }

  // 2. Reservations checked out in window.
  let checkedOut = 0;
  try {
    checkedOut = await prisma.reservation.count({
      where: {
        tenantId,
        status: { in: ['CHECKED_OUT', 'IN_PROGRESS'] },
        OR: [
          { signingCompletedAt: { gte: fromDate, lte: toDate } },
          { updatedAt: { gte: fromDate, lte: toDate } },
        ],
      },
    });
  } catch { /* ignore */ }

  // 3. Available vehicles right now (snapshot, not windowed).
  let available = 0;
  try {
    available = await prisma.vehicle.count({
      where: { tenantId, status: 'AVAILABLE' },
    });
  } catch { /* ignore */ }

  // 4. Total fleet (for the utilization computation in the UI).
  let totalFleet = 0;
  try {
    totalFleet = await prisma.vehicle.count({
      where: { tenantId, status: { not: 'RETIRED' } },
    });
  } catch { /* ignore */ }

  return {
    tenantId,
    range: { from: fromDate.toISOString(), to: toDate.toISOString() },
    revenue: Math.round(revenue * 100) / 100,
    revenueCents: Math.round(revenue * 100),
    reservationsCheckedOut: checkedOut,
    availableVehicles: available,
    totalFleet,
    utilizationPct: totalFleet > 0 ? Math.round(((totalFleet - available) / totalFleet) * 100) : 0,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function startOfMonth(d) {
  const x = new Date(d.getFullYear(), d.getMonth(), 1, 0, 0, 0, 0);
  return x;
}

export const _internal = {
  REPORT_REGISTRY,
  startOfMonth,
};
