import ExcelJS from 'exceljs';
import { prisma } from '../../lib/prisma.js';
import { sendEmail } from '../../lib/mailer.js';
import { settingsService } from '../settings/settings.service.js';
import { isMigrationHoldType, isServiceHoldType } from '../vehicles/vehicle-blocks.js';
import { rotationStatus } from '../vehicles/vehicle-value.js';
import { parseLocationConfig } from '../../lib/location-config.js';
import { startOfDayInTz } from '../../lib/date-utils.js';
import { resolveTenantTimeZone } from '../../lib/tenant-tz.js';

function toNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function scopeWhere(scope = {}) {
  return scope?.tenantId ? { tenantId: scope.tenantId } : {};
}

function startOfDay(value) {
  const d = new Date(value);
  d.setHours(0, 0, 0, 0);
  return d;
}

function endOfDay(value) {
  const d = new Date(value);
  d.setHours(23, 59, 59, 999);
  return d;
}

function isoDay(value) {
  return new Date(value).toISOString().slice(0, 10);
}

function buildDaySeries(start, end) {
  const out = [];
  const cur = startOfDay(start);
  const stop = startOfDay(end);
  while (cur <= stop) {
    out.push(isoDay(cur));
    cur.setDate(cur.getDate() + 1);
  }
  return out;
}

function sumMoney(rows, field) {
  return Number(
    (Array.isArray(rows) ? rows : []).reduce((sum, row) => sum + toNumber(row?.[field]), 0).toFixed(2)
  );
}

function csvCell(value) {
  const text = String(value ?? '');
  if (/[",\n]/.test(text)) return `"${text.replaceAll('"', '""')}"`;
  return text;
}

function csvLine(values = []) {
  return values.map(csvCell).join(',');
}

function normalizeLocationId(query = {}) {
  const raw = String(query?.locationId || '').trim();
  return raw || null;
}

function normalizeTenantId(query = {}) {
  const raw = String(query?.tenantId || '').trim();
  return raw || null;
}

function normalizeEmployeeUserId(query = {}) {
  const raw = String(query?.employeeUserId || '').trim();
  return raw || null;
}

function money(value) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(Number(value || 0));
}

function prettyDate(value) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return String(value || '');
  return parsed.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function applyTemplate(value = '', vars = {}) {
  return Object.entries(vars || {}).reduce(
    (out, [key, next]) => out.replaceAll(`{{${key}}}`, String(next ?? '')),
    String(value || '')
  );
}

function parseRecipients(input) {
  const values = Array.isArray(input) ? input : String(input || '').split(',');
  return [...new Set(values.map((item) => String(item || '').trim()).filter(Boolean))];
}

function textSummary(rows = [], formatter) {
  const list = (Array.isArray(rows) ? rows : []).map(formatter).filter(Boolean);
  return list.length ? list.join('\n') : 'No items in this section.';
}

function htmlTableRows(rows = [], formatter, emptyColspan = 2) {
  const list = (Array.isArray(rows) ? rows : []).map(formatter).filter(Boolean);
  if (list.length) return list.join('');
  return `<tr><td colspan="${emptyColspan}" style="padding:8px;border:1px solid #e5e7eb;color:#6b7280">No items in this section.</td></tr>`;
}

async function resolveEmailRecipients(query = {}, scope = {}) {
  const direct = parseRecipients(query?.recipients);
  if (direct.length) return direct;

  const effectiveTenantId = scope?.tenantId || normalizeTenantId(query);
  const locationId = normalizeLocationId(query);
  if (!effectiveTenantId && !locationId) return [];
  const locations = await prisma.location.findMany({
    where: {
      ...(effectiveTenantId ? { tenantId: effectiveTenantId } : {}),
      ...(locationId ? { id: locationId } : {}),
      isActive: true
    },
    select: { locationConfig: true }
  });

  const derived = locations.flatMap((row) => parseRecipients(parseLocationConfig(row.locationConfig)?.locationEmail));
  return [...new Set(derived)];
}

function buildDailyOpsVars(report, companyName) {
  const kpis = report?.kpis || {};
  const fleetHoldBreakdown = report?.fleetHoldBreakdown || [];
  const topPickupLocations = report?.topPickupLocations || [];
  const reservationStatusBreakdown = report?.reservationStatusBreakdown || [];

  return {
    companyName: companyName || 'Ride Fleet',
    reportStart: prettyDate(report?.range?.start),
    reportEnd: prettyDate(report?.range?.end),
    reportDays: Number(report?.range?.days || 0),
    tenantName: report?.filters?.tenantName || 'All Tenants',
    locationName: report?.filters?.locationName || 'All Locations',
    reservationsCreated: Number(kpis.reservationsCreated || 0),
    checkedOut: Number(kpis.checkedOut || 0),
    checkedIn: Number(kpis.checkedIn || 0),
    availableFleet: Number(kpis.availableFleet || 0),
    migrationHeld: Number(kpis.migrationHeld || 0),
    washHeld: Number(kpis.washHeld || 0),
    maintenanceHeld: Number(kpis.vehiclesInMaintenance || 0),
    outOfServiceHeld: Number(kpis.vehiclesOutOfService || 0),
    utilizationPct: `${Number(kpis.utilizationPct || 0).toFixed(1)}%`,
    collectedPayments: money(kpis.collectedPayments),
    openBalance: money(kpis.openBalance),
    fleetHoldSummary: textSummary(fleetHoldBreakdown, (row) => `${row.label}: ${row.count}${row.note ? ` - ${row.note}` : ''}`),
    topPickupSummary: textSummary(topPickupLocations, (row) => `${row.name}: ${row.count}`),
    statusSummary: textSummary(reservationStatusBreakdown, (row) => `${row.status}: ${row.count}`),
    fleetHoldRowsHtml: htmlTableRows(
      fleetHoldBreakdown,
      (row) => `<tr><td style="padding:8px;border:1px solid #e5e7eb">${escapeHtml(row.label)}</td><td style="padding:8px;border:1px solid #e5e7eb">${escapeHtml(row.count)}</td><td style="padding:8px;border:1px solid #e5e7eb">${escapeHtml(row.note || '')}</td></tr>`,
      3
    ),
    topPickupRowsHtml: htmlTableRows(
      topPickupLocations,
      (row) => `<tr><td style="padding:8px;border:1px solid #e5e7eb">${escapeHtml(row.name)}</td><td style="padding:8px;border:1px solid #e5e7eb">${escapeHtml(row.count)}</td></tr>`,
      2
    ),
    statusRowsHtml: htmlTableRows(
      reservationStatusBreakdown,
      (row) => `<tr><td style="padding:8px;border:1px solid #e5e7eb">${escapeHtml(row.status)}</td><td style="padding:8px;border:1px solid #e5e7eb">${escapeHtml(row.count)}</td></tr>`,
      2
    )
  };
}

export const reportsService = {
  async overview(query = {}, scope = {}) {
    const now = new Date();
    const rawEnd = query?.end ? new Date(query.end) : now;
    const rawStart = query?.start
      ? new Date(query.start)
      : new Date(rawEnd.getTime() - (29 * 24 * 60 * 60 * 1000));

    const start = startOfDay(Number.isNaN(rawStart.getTime()) ? now : rawStart);
    const end = endOfDay(Number.isNaN(rawEnd.getTime()) ? now : rawEnd);
    const effectiveTenantId = scope?.tenantId || normalizeTenantId(query);
    const whereScope = scopeWhere({ tenantId: effectiveTenantId });
    const locationId = normalizeLocationId(query);
    // Location scoping (Fase 2c): a scoped user is limited to their allowed locations
    // (intersected with any selected locationId). Admins/unrestricted → use the selection.
    const _allowedLoc = Array.isArray(scope?.allowedLocationIds) && scope.allowedLocationIds.length
      ? scope.allowedLocationIds : null;
    const _effLocIds = _allowedLoc
      ? (locationId && _allowedLoc.includes(locationId) ? [locationId] : _allowedLoc)
      : (locationId ? [locationId] : null);
    const pickupLoc = _effLocIds ? { pickupLocationId: { in: _effLocIds } } : {};
    const homeLoc = _effLocIds ? { homeLocationId: { in: _effLocIds } } : {};
    const todayStart = startOfDay(now);
    const todayEnd = endOfDay(now);
    const reservationWhere = {
      ...whereScope,
      ...pickupLoc,
      createdAt: { gte: start, lte: end }
    };
    const agreementWhere = {
      ...whereScope,
      ...pickupLoc
    };
    const vehicleWhere = {
      ...whereScope,
      ...homeLoc
    };
    const paymentWhere = {
      reservation: {
        ...whereScope,
        ...pickupLoc
      },
      status: 'PAID',
      paidAt: { gte: start, lte: end }
    };
    const dueTodayWhere = {
      ...whereScope,
      ...pickupLoc,
      status: { notIn: ['CLOSED', 'CANCELLED'] },
      returnAt: { gte: todayStart, lte: todayEnd }
    };
    const maintenanceWhere = {
      status: { in: ['OPEN', 'IN_PROGRESS'] },
      vehicle: {
        ...whereScope,
        ...homeLoc
      }
    };
    const activeVehicleBlockWhere = {
      tenantId: effectiveTenantId || undefined,
      releasedAt: null,
      blockedFrom: { lte: now },
      availableFrom: { gt: now },
      vehicle: {
        ...(whereScope || {}),
        ...homeLoc
      }
    };

    // "Currently rented" — reservations whose vehicle is physically out of
    // the lot right now. CHECKED_IN_UNPAID is excluded (vehicle is back,
    // balance pending). Hybrid grace period (14d) on returnAt: count rows
    // that are within plan OR recently overdue (real customers running
    // late). Beyond 14 days = stale data, captured in the Overdue Returns
    // KPI for cleanup but not in the on-rent count here. Definition shared
    // with Reports Snapshot + Fleet Status + Availability.
    const GRACE_PERIOD_DAYS = 14;
    const gracePeriodStart = new Date(now.getTime() - GRACE_PERIOD_DAYS * 24 * 60 * 60 * 1000);
    const currentlyOutWhere = {
      ...whereScope,
      ...pickupLoc,
      status: 'CHECKED_OUT',
      pickupAt: { lte: now },
      returnAt: { gt: gracePeriodStart },
      vehicleId: { not: null },
      // Grandfathered rows are factually CHECKED_OUT in the DB but
      // physically returned per Hector — exclude from "currently out".
      overdueIgnored: false,
    };

    // "Active reservations" — strict definition per Hector: CHECKED_OUT
    // with returnAt still in the future (planned return not yet passed).
    // Different from currentlyOutWhere — that has a 14d overdue grace to
    // make the available-vehicle math hold up while stale data is being
    // cleaned. This count is the ops-level "who's actually on a current
    // rental right now". Excludes NEW/CONFIRMED (future) and any overdue.
    const activeReservationsWhere = {
      ...whereScope,
      ...pickupLoc,
      status: 'CHECKED_OUT',
      pickupAt: { lte: now },
      returnAt: { gt: now },
      // Same grandfather filter as currentlyOutWhere above.
      overdueIgnored: false,
    };

    // "Overdue" — two operational issue types lumped into one bucket so the
    // agent has a single triage list:
    //   (a) CHECKED_OUT past planned returnAt EOD → customer didn't return /
    //       system never got closed out.
    //   (b) NEW/CONFIRMED past planned pickupAt EOD → rental agent never
    //       did the checkout (no-show vs. data hygiene).
    // EOD = end of the scheduled day in tenant TZ. We approximate that with
    // `< startOfDayInTz(now, tenantTz)` — anything scheduled for a calendar
    // day STRICTLY BEFORE today's tenant-TZ day is overdue.
    const tenantTz = await resolveTenantTimeZone(effectiveTenantId);
    const startOfTenantToday = startOfDayInTz(now, tenantTz);
    const overdueWhere = {
      ...whereScope,
      ...pickupLoc,
      // overdueIgnored=true rows are silently excluded from the Overdue
      // Returns KPI (2026-05-27). Used to grandfather in pre-cleanup
      // stale data so the count starts fresh.
      overdueIgnored: false,
      OR: [
        { status: 'CHECKED_OUT', returnAt: { lt: startOfTenantToday } },
        { status: { in: ['NEW', 'CONFIRMED'] }, pickupAt: { lt: startOfTenantToday } },
      ],
    };

    // Stuck checkouts: CheckoutSession rows that have been sitting in a
    // non-terminal step for more than 4 hours, or that the agent has
    // explicitly marked abandoned via Save & pause. Surfaced as a
    // dashboard tile with click-through to the list. (Phase 1.8)
    const FOUR_HOURS_AGO = new Date(Date.now() - 4 * 60 * 60 * 1000);
    const stuckCheckoutsWhere = {
      ...(effectiveTenantId ? { tenantId: effectiveTenantId } : {}),
      OR: [
        { abandonedAt: { not: null } },
        { currentStep: { notIn: ['CLOSED', 'CANCELLED'] }, updatedAt: { lt: FOUR_HOURS_AGO } },
      ],
    };

    const [
      reservations,
      reservationPayments,
      agreements,
      vehicles,
      activeVehicleBlocks,
      locations,
      tenants,
      dueTodayCount,
      maintenanceJobs,
      currentlyOutReservations,
      overdueReservationCount,
      activeReservationsCount,
      stuckCheckoutsCount,
      registrationsExpiringCount,
      rotationVehicles,
      fleetRotationCfg,
      inspectionsToReviewCount,
    ] = await Promise.all([
      prisma.reservation.findMany({
        where: reservationWhere,
        select: {
          id: true,
          status: true,
          createdAt: true,
          estimatedTotal: true,
          pickupLocationId: true
        },
        orderBy: { createdAt: 'asc' }
      }),
      prisma.reservationPayment.findMany({
        where: paymentWhere,
        select: {
          id: true,
          amount: true,
          paidAt: true
        },
        orderBy: { paidAt: 'asc' }
      }),
      prisma.rentalAgreement.findMany({
        where: agreementWhere,
        select: {
          id: true,
          status: true,
          total: true,
          paidAmount: true,
          balance: true,
          createdAt: true,
          closedAt: true
        }
      }),
      prisma.vehicle.findMany({
        where: vehicleWhere,
        select: { id: true, status: true }
      }),
      prisma.vehicleAvailabilityBlock.findMany({
        where: activeVehicleBlockWhere,
        select: { vehicleId: true, blockType: true }
      }),
      prisma.location.findMany({
        where: { ...whereScope, isActive: true },
        select: { id: true, name: true }
      }),
      scope?.tenantId
        ? Promise.resolve([])
        : prisma.tenant.findMany({
            orderBy: { name: 'asc' },
            select: { id: true, name: true, status: true }
          }),
      prisma.rentalAgreement.count({
        where: dueTodayWhere
      }),
      prisma.maintenanceJob.findMany({
        where: maintenanceWhere,
        select: { vehicleId: true }
      }),
      prisma.reservation.findMany({
        where: currentlyOutWhere,
        select: { vehicleId: true }
      }),
      prisma.reservation.count({ where: overdueWhere }),
      prisma.reservation.count({ where: activeReservationsWhere }),
      // Phase 1.8 — checkout sessions abandoned or stalled. Returns 0
      // when the CheckoutSession table is empty (pre-Phase-1 deploy).
      prisma.checkoutSession.count({ where: stuckCheckoutsWhere }).catch(() => 0),
      // Vehicle Profile pack (2026-06-10) — registrations expiring within 30
      // days (or already expired). Replaces the Fee Advisories tile.
      prisma.vehicle.count({
        where: {
          ...vehicleWhere,
          registrationExpiresAt: { not: null, lte: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) },
        },
      }).catch(() => 0),
      // Rotation candidates: minimal fields, classified in JS (date math per
      // row isn't expressible in a Prisma count). Fleet-sized — cheap.
      prisma.vehicle.findMany({
        where: {
          ...vehicleWhere,
          OR: [{ targetFleetMonths: { not: null } }, { targetFleetMiles: { not: null } }],
        },
        select: { mileage: true, acquisitionDate: true, targetFleetMonths: true, targetFleetMiles: true },
      }).catch(() => []),
      settingsService.getFleetRotationConfig(scope).catch(() => ({ rule: 'TIME' })),
      // Customer-led inspection Fase B (2026-06-11): submitted inspections
      // with damage reports awaiting soft/hard approval.
      prisma.customerInspection.count({
        where: { ...(effectiveTenantId ? { tenantId: effectiveTenantId } : {}), status: 'SUBMITTED' },
      }).catch(() => 0),
    ]);

    const readyToRotateCount = rotationVehicles.reduce((count, v) => (
      rotationStatus({
        rule: fleetRotationCfg?.rule || 'TIME',
        acquisitionDate: v.acquisitionDate,
        targetFleetMonths: v.targetFleetMonths,
        mileage: v.mileage,
        targetFleetMiles: v.targetFleetMiles,
      }) === 'ready' ? count + 1 : count
    ), 0);

    const reservationsByDayMap = new Map(buildDaySeries(start, end).map((day) => [day, 0]));
    for (const row of reservations) {
      const day = isoDay(row.createdAt);
      reservationsByDayMap.set(day, (reservationsByDayMap.get(day) || 0) + 1);
    }

    const paymentsByDayMap = new Map(buildDaySeries(start, end).map((day) => [day, 0]));
    for (const row of reservationPayments) {
      const day = isoDay(row.paidAt);
      paymentsByDayMap.set(day, Number(((paymentsByDayMap.get(day) || 0) + toNumber(row.amount)).toFixed(2)));
    }

    const reservationStatusCounts = {
      NEW: 0,
      CONFIRMED: 0,
      CHECKED_OUT: 0,
      CHECKED_IN: 0,
      CANCELLED: 0,
      NO_SHOW: 0
    };
    for (const row of reservations) {
      const key = String(row.status || '').toUpperCase();
      if (key in reservationStatusCounts) reservationStatusCounts[key] += 1;
    }

    const activeAgreements = agreements.filter((row) => !['CLOSED', 'CANCELLED'].includes(String(row.status || '').toUpperCase()));
    const closedInRange = agreements.filter((row) => row.closedAt && row.closedAt >= start && row.closedAt <= end);
    const openBalance = Number(activeAgreements.reduce((sum, row) => sum + Math.max(0, toNumber(row.balance)), 0).toFixed(2));
    const migrationBlockIds = new Set((activeVehicleBlocks || []).filter((row) => isMigrationHoldType(row.blockType)).map((row) => row.vehicleId).filter(Boolean));
    const serviceBlockRows = (activeVehicleBlocks || []).filter((row) => isServiceHoldType(row.blockType));
    const serviceBlockIds = new Set(serviceBlockRows.map((row) => row.vehicleId).filter(Boolean));
    const washBlockIds = new Set((activeVehicleBlocks || []).filter((row) => String(row.blockType || '').toUpperCase() === 'WASH_HOLD').map((row) => row.vehicleId).filter(Boolean));
    const maintenanceBlockIds = new Set(serviceBlockRows.filter((row) => String(row.blockType || '').toUpperCase() === 'MAINTENANCE_HOLD').map((row) => row.vehicleId).filter(Boolean));
    const outOfServiceBlockIds = new Set(serviceBlockRows.filter((row) => String(row.blockType || '').toUpperCase() === 'OUT_OF_SERVICE_HOLD').map((row) => row.vehicleId).filter(Boolean));
    const outOfServiceStatusIds = new Set(vehicles.filter((row) => String(row.status || '').toUpperCase() === 'OUT_OF_SERVICE').map((row) => row.id));
    const maintenanceStatusIds = new Set(vehicles.filter((row) => String(row.status || '').toUpperCase() === 'IN_MAINTENANCE').map((row) => row.id));
    // 2026-05-28: fleetTotal is now the strict capacity definition —
    // every vehicle that's NOT terminally out of the fleet. SOLD and
    // OUT_OF_SERVICE are the only terminal statuses. Vehicles in the
    // shop (maintenance job, IN_MAINTENANCE status, service/wash
    // blocks) are still PART of the fleet — they're just temporarily
    // unavailable. They show up correctly in the MAINTENANCE/OOS tile
    // and in availableFleet's blocked subtraction below. This stops
    // the double-counting that made Hector's lot math go 70+45+5=120
    // when he expected 118 = 70 available + 45 rented + 3 OOS.
    const fleetTotal = vehicles.filter((row) => {
      const status = String(row.status || '').toUpperCase();
      return !['SOLD', 'OUT_OF_SERVICE'].includes(status);
    }).length;
    // 2026-05-27: derive on-rent from active CHECKED_OUT reservations
    // instead of Vehicle.status (which drifts — same fix as Fleet Status
    // and Reports Snapshot). Vehicle.status='ON_RENT' is kept as a defensive
    // fallback so vehicles that happen to be flagged ON_RENT without a
    // current reservation are still counted as not-available.
    const currentlyOutIds = new Set((currentlyOutReservations || [])
      .map((row) => row.vehicleId).filter(Boolean));
    const onRentStatusIds = new Set(vehicles.filter((row) => String(row.status || '').toUpperCase() === 'ON_RENT').map((row) => row.id));
    const onRent = new Set([...currentlyOutIds, ...onRentStatusIds, ...migrationBlockIds]).size;
    const vehiclesInMaintenance = new Set([...maintenanceStatusIds, ...maintenanceBlockIds, ...(maintenanceJobs || []).map((row) => row.vehicleId).filter(Boolean)]).size;
    const vehiclesOutOfService = new Set([...outOfServiceStatusIds, ...outOfServiceBlockIds]).size;
    const blockedIds = new Set([
      ...currentlyOutIds, ...onRentStatusIds, ...migrationBlockIds,
      ...maintenanceStatusIds, ...maintenanceBlockIds,
      ...outOfServiceStatusIds, ...outOfServiceBlockIds,
      ...serviceBlockIds, ...washBlockIds,
      ...((maintenanceJobs || []).map((row) => row.vehicleId).filter(Boolean)),
    ]);
    const availableFleet = vehicles.filter((row) => {
      const status = String(row.status || '').toUpperCase();
      // SOLD treated same as OUT_OF_SERVICE — never available (2026-05-28).
      if (['IN_MAINTENANCE', 'OUT_OF_SERVICE', 'SOLD'].includes(status)) return false;
      return !blockedIds.has(row.id);
    }).length;
    const utilizationPct = fleetTotal > 0 ? Number(((onRent / fleetTotal) * 100).toFixed(1)) : 0;

    const locationNameById = new Map(locations.map((row) => [row.id, row.name]));
    const tenantNameById = new Map((tenants || []).map((row) => [row.id, row.name]));
    const selectedLocation = locationId
      ? { id: locationId, name: locationNameById.get(locationId) || 'Unknown' }
      : null;
    const selectedTenant = effectiveTenantId
      ? { id: effectiveTenantId, name: tenantNameById.get(effectiveTenantId) || 'Current Tenant' }
      : null;
    const reservationByLocation = Object.entries(
      reservations.reduce((acc, row) => {
        const key = row.pickupLocationId || 'unknown';
        acc[key] = (acc[key] || 0) + 1;
        return acc;
      }, {})
    )
      .map(([locationId, count]) => ({
        locationId,
        name: locationNameById.get(locationId) || 'Unknown',
        count
      }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);

    return {
      range: {
        start: start.toISOString(),
        end: end.toISOString(),
        days: buildDaySeries(start, end).length
      },
      filters: {
        tenantId: effectiveTenantId,
        tenantName: selectedTenant?.name || null,
        locationId,
        locationName: selectedLocation?.name || null
      },
      locations,
      tenants,
      kpis: {
        reservationsCreated: reservations.length,
        checkedOut: reservationStatusCounts.CHECKED_OUT,
        checkedIn: reservationStatusCounts.CHECKED_IN,
        cancelled: reservationStatusCounts.CANCELLED,
        noShow: reservationStatusCounts.NO_SHOW,
        activeAgreements: activeAgreements.length,
        agreementsClosed: closedInRange.length,
        agreementsDueToday: dueTodayCount,
        projectedRevenue: sumMoney(reservations, 'estimatedTotal'),
        collectedPayments: sumMoney(reservationPayments, 'amount'),
        openBalance,
        fleetTotal,
        onRent,
        availableFleet,
        migrationHeld: migrationBlockIds.size,
        washHeld: washBlockIds.size,
        vehiclesInMaintenance,
        vehiclesOutOfService,
        utilizationPct,
        overdueReservations: overdueReservationCount || 0,
        // Strict: CHECKED_OUT with returnAt > now. Excludes NEW/CONFIRMED
        // (future bookings) AND any overdue rentals (which are counted
        // in overdueReservations above). This is the number rendered as
        // the Active Reservations KPI on the dashboard.
        activeReservations: activeReservationsCount || 0,
        // Phase 1.8 — count of checkout sessions abandoned by the agent
        // OR stuck in a non-terminal step for > 4 hours. Surfaced on
        // the dashboard with click-through to the list.
        stuckCheckouts: stuckCheckoutsCount || 0,
        // Vehicle Profile pack (2026-06-10): dashboard tiles that replace
        // Fee Advisories + Stuck Checkouts on the Ops Hub (counts above stay
        // for the reservations page filters).
        registrationsExpiring30d: registrationsExpiringCount || 0,
        readyToRotate: readyToRotateCount || 0,
        fleetRotationRule: fleetRotationCfg?.rule || 'TIME',
        // Fase B: customer inspections waiting for damage approval.
        inspectionsToReview: inspectionsToReviewCount || 0,
        // 2026-05-28: vehicleIds derived from active reservations + blocks
        // exposed so the Vehicles page can compute its Available / On Rent
        // tiles without inheriting the Vehicle.status drift (every vehicle
        // in production is stuck at AVAILABLE regardless of reality).
        // Arrays not Sets so JSON serialization works; consumer rebuilds
        // the Set on the FE.
        currentlyOutVehicleIds: Array.from(currentlyOutIds),
        blockedVehicleIds: Array.from(blockedIds),
      },
      fleetHoldBreakdown: [
        { id: 'migration', label: 'Migration Held', count: migrationBlockIds.size, note: 'Legacy-contract units still committed outside the current native workflow.' },
        { id: 'wash', label: 'Wash Held', count: washBlockIds.size, note: 'Temporary wash and turnaround buffers currently blocking units.' },
        { id: 'maintenance', label: 'Maintenance Held', count: maintenanceBlockIds.size, note: 'Units blocked by maintenance holds plus active maintenance workflow.' },
        { id: 'out_of_service', label: 'Out Of Service Held', count: outOfServiceBlockIds.size, note: 'Units blocked as out of service and unavailable for assignment.' }
      ],
      reservationStatusBreakdown: Object.entries(reservationStatusCounts).map(([status, count]) => ({ status, count })),
      reservationsByDay: Array.from(reservationsByDayMap.entries()).map(([date, count]) => ({ date, count })),
      paymentsByDay: Array.from(paymentsByDayMap.entries()).map(([date, amount]) => ({ date, amount })),
      topPickupLocations: reservationByLocation
    };
  },

  async overviewCsv(query = {}, scope = {}) {
    const report = await this.overview(query, scope);
    const lines = [];

    lines.push(csvLine(['Report', 'Reports Overview v1']));
    lines.push(csvLine(['Start', report.range.start]));
    lines.push(csvLine(['End', report.range.end]));
    lines.push(csvLine(['Days', report.range.days]));
    lines.push(csvLine(['Tenant', report.filters?.tenantName || 'All Tenants']));
    lines.push(csvLine(['Location', report.filters?.locationName || 'All Locations']));
    lines.push('');

    lines.push(csvLine(['KPI', 'Value']));
    for (const [key, value] of Object.entries(report.kpis || {})) {
      lines.push(csvLine([key, value]));
    }
    lines.push('');

    lines.push(csvLine(['Fleet Hold Breakdown', 'Count', 'Note']));
    for (const row of report.fleetHoldBreakdown || []) {
      lines.push(csvLine([row.label, row.count, row.note || '']));
    }
    lines.push('');

    lines.push(csvLine(['Reservation Status', 'Count']));
    for (const row of report.reservationStatusBreakdown || []) {
      lines.push(csvLine([row.status, row.count]));
    }
    lines.push('');

    lines.push(csvLine(['Reservations By Day', 'Count']));
    for (const row of report.reservationsByDay || []) {
      lines.push(csvLine([row.date, row.count]));
    }
    lines.push('');

    lines.push(csvLine(['Payments By Day', 'Amount']));
    for (const row of report.paymentsByDay || []) {
      lines.push(csvLine([row.date, row.amount]));
    }
    lines.push('');

    lines.push(csvLine(['Top Pickup Locations', 'Reservations']));
    for (const row of report.topPickupLocations || []) {
      lines.push(csvLine([row.name, row.count]));
    }

    return lines.join('\n');
  },

  async sendOverviewEmail(query = {}, scope = {}) {
    const effectiveTenantId = scope?.tenantId || normalizeTenantId(query);
    const recipients = await resolveEmailRecipients(query, scope);
    if (!recipients.length) {
      throw new Error('No report recipients were provided and no location email is configured for this scope');
    }

    const [report, templates, companyConfig] = await Promise.all([
      this.overview(query, scope),
      settingsService.getEmailTemplates({ tenantId: effectiveTenantId || null }),
      settingsService.getRentalAgreementConfig({ tenantId: effectiveTenantId || null })
    ]);

    const vars = buildDailyOpsVars(report, companyConfig?.companyName || 'Ride Fleet');
    const subject = applyTemplate(templates.dailyOpsReportSubject, vars);
    const text = applyTemplate(templates.dailyOpsReportBody, vars);
    const html = applyTemplate(
      templates.dailyOpsReportHtml || String(templates.dailyOpsReportBody || '').replaceAll('\n', '<br/>'),
      vars
    );

    await sendEmail({
      to: recipients,
      subject,
      text,
      html
    });

    return {
      sent: true,
      recipients,
      subject
    };
  },

  async servicesSold(query = {}, scope = {}) {
    const now = new Date();
    const rawEnd = query?.end ? new Date(query.end) : now;
    const rawStart = query?.start
      ? new Date(query.start)
      : new Date(rawEnd.getTime() - (29 * 24 * 60 * 60 * 1000));

    const start = startOfDay(Number.isNaN(rawStart.getTime()) ? now : rawStart);
    const end = endOfDay(Number.isNaN(rawEnd.getTime()) ? now : rawEnd);
    const effectiveTenantId = scope?.tenantId || normalizeTenantId(query);
    const whereScope = scopeWhere({ tenantId: effectiveTenantId });
    const locationId = normalizeLocationId(query);
    const employeeUserId = normalizeEmployeeUserId(query);
    // Location scoping (Fase 2c): limit to the user's allowed locations (∩ selection).
    const _allowedLoc = Array.isArray(scope?.allowedLocationIds) && scope.allowedLocationIds.length
      ? scope.allowedLocationIds : null;
    const _effLocIds = _allowedLoc
      ? (locationId && _allowedLoc.includes(locationId) ? [locationId] : _allowedLoc)
      : (locationId ? [locationId] : null);
    const pickupLoc = _effLocIds ? { pickupLocationId: { in: _effLocIds } } : {};

    const lineWhere = {
      agreementCommission: {
        ...whereScope,
        ...(employeeUserId ? { employeeUserId } : {}),
        calculatedAt: { gte: start, lte: end },
        rentalAgreement: {
          ...pickupLoc
        }
      },
      serviceId: { not: null }
    };

    const [lines, locations, tenants, employees] = await Promise.all([
      prisma.agreementCommissionLine.findMany({
        where: lineWhere,
        include: {
          service: { select: { id: true, name: true, code: true } },
          agreementCommission: {
            select: {
              id: true,
              tenantId: true,
              employeeUserId: true,
              commissionAmount: true,
              rentalAgreement: {
                select: {
                  id: true,
                  agreementNumber: true,
                  pickupLocationId: true,
                  closedAt: true
                }
              },
              employeeUser: {
                select: {
                  id: true,
                  fullName: true,
                  email: true
                }
              }
            }
          }
        },
        orderBy: { createdAt: 'desc' }
      }),
      prisma.location.findMany({
        where: { ...whereScope, isActive: true },
        select: { id: true, name: true }
      }),
      scope?.tenantId
        ? Promise.resolve([])
        : prisma.tenant.findMany({
            orderBy: { name: 'asc' },
            select: { id: true, name: true, status: true }
          }),
      prisma.user.findMany({
        where: {
          ...whereScope,
          isActive: true,
          role: { in: ['ADMIN', 'OPS', 'AGENT'] }
        },
        orderBy: { fullName: 'asc' },
        select: { id: true, fullName: true, email: true, role: true }
      })
    ]);

    const locationNameById = new Map(locations.map((row) => [row.id, row.name]));
    const tenantNameById = new Map((tenants || []).map((row) => [row.id, row.name]));
    const employeeNameById = new Map((employees || []).map((row) => [row.id, row.fullName]));

    const selectedTenant = effectiveTenantId
      ? { id: effectiveTenantId, name: tenantNameById.get(effectiveTenantId) || 'Current Tenant' }
      : null;
    const selectedLocation = locationId
      ? { id: locationId, name: locationNameById.get(locationId) || 'Unknown' }
      : null;
    const selectedEmployee = employeeUserId
      ? { id: employeeUserId, name: employeeNameById.get(employeeUserId) || 'Unknown Employee' }
      : null;

    const grouped = new Map();
    const agreementIds = new Set();

    for (const line of lines) {
      const serviceId = line.serviceId || 'unknown';
      const current = grouped.get(serviceId) || {
        serviceId,
        serviceName: line.service?.name || line.description || 'Unknown Service',
        serviceCode: line.service?.code || null,
        unitsSold: 0,
        serviceRevenue: 0,
        commissionAmount: 0,
        agreements: new Set(),
        employees: new Set()
      };
      current.unitsSold += Number(line.quantity || 0);
      current.serviceRevenue += Number(line.lineRevenue || 0);
      current.commissionAmount += Number(line.commissionAmount || 0);
      if (line.agreementCommission?.rentalAgreement?.id) {
        current.agreements.add(line.agreementCommission.rentalAgreement.id);
        agreementIds.add(line.agreementCommission.rentalAgreement.id);
      }
      if (line.agreementCommission?.employeeUserId) current.employees.add(line.agreementCommission.employeeUserId);
      grouped.set(serviceId, current);
    }

    const byService = Array.from(grouped.values())
      .map((row) => ({
        serviceId: row.serviceId,
        serviceName: row.serviceName,
        serviceCode: row.serviceCode,
        unitsSold: Number(row.unitsSold.toFixed ? row.unitsSold.toFixed(2) : row.unitsSold),
        serviceRevenue: Number(row.serviceRevenue.toFixed(2)),
        commissionAmount: Number(row.commissionAmount.toFixed(2)),
        agreementsClosed: row.agreements.size,
        employeesInvolved: row.employees.size
      }))
      .sort((a, b) => b.serviceRevenue - a.serviceRevenue);

    const byEmployeeMap = new Map();
    for (const line of lines) {
      const employee = line.agreementCommission?.employeeUser;
      const employeeId = employee?.id || line.agreementCommission?.employeeUserId || 'unknown';
      const current = byEmployeeMap.get(employeeId) || {
        employeeUserId: employeeId,
        employeeName: employee?.fullName || 'Unknown Employee',
        email: employee?.email || null,
        unitsSold: 0,
        serviceRevenue: 0,
        commissionAmount: 0,
        agreements: new Set()
      };
      current.unitsSold += Number(line.quantity || 0);
      current.serviceRevenue += Number(line.lineRevenue || 0);
      current.commissionAmount += Number(line.commissionAmount || 0);
      if (line.agreementCommission?.rentalAgreement?.id) current.agreements.add(line.agreementCommission.rentalAgreement.id);
      byEmployeeMap.set(employeeId, current);
    }

    const byEmployee = Array.from(byEmployeeMap.values())
      .map((row) => ({
        employeeUserId: row.employeeUserId,
        employeeName: row.employeeName,
        email: row.email,
        unitsSold: Number(row.unitsSold.toFixed ? row.unitsSold.toFixed(2) : row.unitsSold),
        serviceRevenue: Number(row.serviceRevenue.toFixed(2)),
        commissionAmount: Number(row.commissionAmount.toFixed(2)),
        agreementsClosed: row.agreements.size
      }))
      .sort((a, b) => b.commissionAmount - a.commissionAmount);

    return {
      range: {
        start: start.toISOString(),
        end: end.toISOString()
      },
      filters: {
        tenantId: effectiveTenantId,
        tenantName: selectedTenant?.name || null,
        locationId,
        locationName: selectedLocation?.name || null,
        employeeUserId,
        employeeName: selectedEmployee?.name || null
      },
      tenants,
      locations,
      employees,
      summary: {
        servicesSoldCount: byService.length,
        unitsSold: Number(lines.reduce((sum, line) => sum + Number(line.quantity || 0), 0).toFixed(2)),
        serviceRevenue: Number(lines.reduce((sum, line) => sum + Number(line.lineRevenue || 0), 0).toFixed(2)),
        commissionAmount: Number(lines.reduce((sum, line) => sum + Number(line.commissionAmount || 0), 0).toFixed(2)),
        agreementsClosed: agreementIds.size
      },
      byService,
      byEmployee
    };
  },

  // Excel export — one row per reservation in the date range, with dynamic columns for each
  // distinct service/fee/insurance name the tenant has actually used (names come from the
  // reservation charges themselves, not from hardcoded labels — so "Full Super Collision"
  // appears as its own column instead of being bucketed under a generic "Insurance" header).
  // Mirrors the "Weekly Payouts and Comms" workbook the operator has been maintaining by hand.
  async contractsExcel(query = {}, scope = {}) {
    const start = query.start ? startOfDay(query.start) : startOfDay(new Date(Date.now() - 30 * 24 * 60 * 60 * 1000));
    const end = query.end ? endOfDay(query.end) : endOfDay(new Date());
    const whereScope = scopeWhere(scope);

    const reservations = await prisma.reservation.findMany({
      where: {
        ...whereScope,
        pickupAt: { gte: start, lte: end }
      },
      select: {
        id: true,
        reservationNumber: true,
        pickupAt: true,
        returnAt: true,
        status: true,
        tenantId: true,
        pricingSnapshot: { select: { dailyRate: true, taxRate: true } },
        franchise: { select: { id: true, name: true } },
        rentalAgreement: {
          select: {
            id: true,
            agreementNumber: true,
            total: true,
            subtotal: true,
            taxes: true,
            paidAmount: true,
            balance: true
          }
        },
        charges: {
          where: { selected: true },
          select: {
            name: true,
            source: true,
            chargeType: true,
            quantity: true,
            rate: true,
            total: true
          }
        }
      },
      orderBy: { pickupAt: 'asc' }
    });

    // Categories we already know how to map explicitly. Everything else falls into the
    // dynamic "Service" / "Fee" / "Insurance" name columns based on charge.name.
    const EXCLUDED_FROM_ADDON_COLUMNS = new Set(['DAILY', 'TAX', 'DEPOSIT', 'DEPOSIT_DUE', 'SECURITY_DEPOSIT']);

    // First pass — discover every add-on column name actually used in this date range.
    const addonColumnNames = new Set();
    for (const reservation of reservations) {
      for (const charge of (reservation.charges || [])) {
        const source = String(charge.source || '').toUpperCase();
        const chargeType = String(charge.chargeType || '').toUpperCase();
        if (EXCLUDED_FROM_ADDON_COLUMNS.has(source)) continue;
        if (EXCLUDED_FROM_ADDON_COLUMNS.has(chargeType)) continue;
        const label = String(charge.name || '').replace(/^(Service|Fee|Insurance)\s*:\s*/i, '').trim();
        if (label) addonColumnNames.add(label);
      }
    }
    const addonColumns = Array.from(addonColumnNames).sort((a, b) => a.localeCompare(b));

    // Build rows.
    const rows = reservations.map((reservation) => {
      const pickup = reservation.pickupAt ? new Date(reservation.pickupAt) : null;
      const ret = reservation.returnAt ? new Date(reservation.returnAt) : null;
      const days = pickup && ret ? Math.max(1, Math.ceil((ret.getTime() - pickup.getTime()) / (24 * 60 * 60 * 1000))) : 0;
      const dailyRate = toNumber(reservation.pricingSnapshot?.dailyRate, 0);
      const tmTotal = Number((dailyRate * days).toFixed(2));

      const addonTotals = Object.fromEntries(addonColumns.map((name) => [name, 0]));
      let taxTotal = 0;
      let tollPackageSelected = false;
      let tollChargeApplied = false;

      for (const charge of (reservation.charges || [])) {
        const source = String(charge.source || '').toUpperCase();
        const chargeType = String(charge.chargeType || '').toUpperCase();
        const label = String(charge.name || '').replace(/^(Service|Fee|Insurance)\s*:\s*/i, '').trim();
        const total = toNumber(charge.total, 0);

        if (source === 'TAX' || chargeType === 'TAX') {
          taxTotal += total;
          continue;
        }
        if (EXCLUDED_FROM_ADDON_COLUMNS.has(source) || EXCLUDED_FROM_ADDON_COLUMNS.has(chargeType)) {
          continue;
        }
        if (label && Object.prototype.hasOwnProperty.call(addonTotals, label)) {
          addonTotals[label] = Number((addonTotals[label] + total).toFixed(2));
        }

        const labelLower = label.toLowerCase();
        if (labelLower.includes('toll')) {
          if (labelLower.includes('package') || labelLower.includes('pre-paid') || labelLower.includes('prepaid')) {
            tollPackageSelected = true;
          } else {
            tollChargeApplied = true;
          }
        }
      }

      const agreementTotal = toNumber(reservation.rentalAgreement?.total, 0);
      const paidAmount = toNumber(reservation.rentalAgreement?.paidAmount, 0);
      const balance = reservation.rentalAgreement?.balance != null
        ? toNumber(reservation.rentalAgreement.balance, 0)
        : Number((agreementTotal - paidAmount).toFixed(2));

      return {
        reservationNumber: reservation.reservationNumber || '',
        agreementNumber: reservation.rentalAgreement?.agreementNumber || '',
        dateOut: pickup,
        dateIn: ret,
        days,
        tm: tmTotal,
        addonTotals,
        taxTotal: Number(taxTotal.toFixed(2)),
        paid: paidAmount,
        unpaidBalance: balance,
        tollPackage: tollPackageSelected ? 'Y' : 'N',
        tollCharge: tollChargeApplied ? 'Y' : 'N',
        company: reservation.franchise?.name || ''
      };
    });

    // Build the workbook.
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Ride Fleet Management';
    workbook.created = new Date();

    const sheet = workbook.addWorksheet('Contracts', {
      views: [{ state: 'frozen', ySplit: 2 }]
    });

    const staticBefore = [
      { header: 'Reservation #', key: 'reservationNumber', width: 16 },
      { header: 'Agreement #', key: 'agreementNumber', width: 16 },
      { header: 'Date Out', key: 'dateOut', width: 12, style: { numFmt: 'yyyy-mm-dd' } },
      { header: 'Date In', key: 'dateIn', width: 12, style: { numFmt: 'yyyy-mm-dd' } },
      { header: 'Days', key: 'days', width: 6 },
      { header: 'T&M', key: 'tm', width: 10, style: { numFmt: '"$"#,##0.00' } }
    ];
    const addonColumnDefs = addonColumns.map((name) => ({
      header: name,
      key: `addon_${name}`,
      width: Math.max(10, Math.min(20, name.length + 2)),
      style: { numFmt: '"$"#,##0.00' }
    }));
    const staticAfter = [
      { header: 'Tax', key: 'taxTotal', width: 10, style: { numFmt: '"$"#,##0.00' } },
      { header: 'Paid', key: 'paid', width: 12, style: { numFmt: '"$"#,##0.00' } },
      { header: 'Unpaid Balance', key: 'unpaidBalance', width: 14, style: { numFmt: '"$"#,##0.00' } },
      { header: 'Toll Package', key: 'tollPackage', width: 12 },
      { header: 'Toll Charge', key: 'tollCharge', width: 12 },
      { header: 'Company', key: 'company', width: 14 }
    ];

    sheet.columns = [...staticBefore, ...addonColumnDefs, ...staticAfter];

    // Row 1: title (merged banner). Row 2: headers (already in sheet.columns, written at row 1 actually).
    // Actually exceljs writes the header row at row 1. Let's shift by inserting a banner above.
    sheet.spliceRows(1, 0, []);
    const headerTitle = `Rental Contracts — ${isoDay(start)} to ${isoDay(end)}`;
    sheet.getCell('A1').value = headerTitle;
    sheet.getCell('A1').font = { bold: true, size: 13 };
    const lastColLetter = sheet.getColumn(sheet.columns.length).letter;
    sheet.mergeCells(`A1:${lastColLetter}1`);
    sheet.getCell('A1').alignment = { horizontal: 'left', vertical: 'middle' };
    sheet.getRow(1).height = 22;

    // Style the header row (row 2).
    const headerRow = sheet.getRow(2);
    headerRow.font = { bold: true };
    headerRow.alignment = { vertical: 'middle', wrapText: true };
    headerRow.height = 28;
    headerRow.eachCell((cell) => {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF6E49FF' } };
      cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      cell.border = { bottom: { style: 'thin', color: { argb: 'FF3E29A0' } } };
    });

    // Data rows.
    for (const row of rows) {
      const flat = {
        reservationNumber: row.reservationNumber,
        agreementNumber: row.agreementNumber,
        dateOut: row.dateOut,
        dateIn: row.dateIn,
        days: row.days,
        tm: row.tm,
        ...Object.fromEntries(addonColumns.map((name) => [`addon_${name}`, row.addonTotals[name] || 0])),
        taxTotal: row.taxTotal,
        paid: row.paid,
        unpaidBalance: row.unpaidBalance,
        tollPackage: row.tollPackage,
        tollCharge: row.tollCharge,
        company: row.company
      };
      const added = sheet.addRow(flat);
      // Flag unpaid balances with a red font so the operator can scan quickly.
      if (row.unpaidBalance > 0.009) {
        const unpaidCell = added.getCell('unpaidBalance');
        unpaidCell.font = { color: { argb: 'FFC00000' }, bold: true };
      }
    }

    // Totals row at the bottom.
    if (rows.length) {
      const totalsRow = sheet.addRow({
        reservationNumber: 'TOTALS',
        days: rows.reduce((sum, r) => sum + (r.days || 0), 0),
        tm: Number(rows.reduce((sum, r) => sum + (r.tm || 0), 0).toFixed(2)),
        ...Object.fromEntries(addonColumns.map((name) => [
          `addon_${name}`,
          Number(rows.reduce((sum, r) => sum + (r.addonTotals[name] || 0), 0).toFixed(2))
        ])),
        taxTotal: Number(rows.reduce((sum, r) => sum + (r.taxTotal || 0), 0).toFixed(2)),
        paid: Number(rows.reduce((sum, r) => sum + (r.paid || 0), 0).toFixed(2)),
        unpaidBalance: Number(rows.reduce((sum, r) => sum + (r.unpaidBalance || 0), 0).toFixed(2))
      });
      totalsRow.font = { bold: true };
      totalsRow.eachCell((cell) => {
        cell.border = { top: { style: 'thin' } };
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF0EEFF' } };
      });
    }

    // Stream as buffer.
    return {
      buffer: await workbook.xlsx.writeBuffer(),
      filename: `rental-contracts-${isoDay(start)}-to-${isoDay(end)}.xlsx`,
      rowCount: rows.length
    };
  },

  // Per-vehicle revenue aggregation. Triangle plan item #3 — "Produce reports
  // showing how much revenue each car is generating". Groups every selected
  // charge in [start, end] by Reservation.vehicleId so operators see which
  // cars are pulling weight. Optional programCategory filter scopes the
  // report to either the rental fleet or the loaner pool.
  //
  // Sizing: a tenant with 200 vehicles × ~4 reservations/month/vehicle = 800
  // reservations / month. Loading reservations with charges into JS for
  // aggregation is fine at that volume. If the data ever doesn't fit comfortably
  // in memory we'd switch to a SQL-side GROUP BY, but for the foreseeable
  // future the JS path keeps the code simple.
  async vehicleRevenue(query = {}, scope = {}) {
    const start = query.start ? startOfDay(query.start) : startOfDay(new Date(Date.now() - 30 * 24 * 60 * 60 * 1000));
    const end = query.end ? endOfDay(query.end) : endOfDay(new Date());
    const whereScope = scopeWhere(scope);

    const programCategoryFilter = query.programCategory && ['RENTAL_ONLY', 'LOANER_ONLY', 'BOTH'].includes(String(query.programCategory))
      ? { programCategory: String(query.programCategory) }
      : {};

    const vehicles = await prisma.vehicle.findMany({
      where: {
        ...whereScope,
        ...programCategoryFilter
      },
      select: {
        id: true,
        internalNumber: true,
        plate: true,
        make: true,
        model: true,
        year: true,
        programCategory: true,
        status: true,
        vehicleType: { select: { id: true, name: true } }
      },
      orderBy: { internalNumber: 'asc' }
    });

    if (!vehicles.length) {
      return {
        range: { start, end },
        programCategory: query.programCategory || 'ALL',
        vehicles: [],
        totals: { vehicleCount: 0, reservationCount: 0, totalCharges: 0, totalPaid: 0 }
      };
    }

    const vehicleIds = vehicles.map((v) => v.id);

    const reservations = await prisma.reservation.findMany({
      where: {
        ...whereScope,
        vehicleId: { in: vehicleIds },
        pickupAt: { gte: start, lte: end }
      },
      select: {
        id: true,
        vehicleId: true,
        status: true,
        pickupAt: true,
        returnAt: true,
        charges: {
          where: { selected: true },
          select: { total: true }
        },
        rentalAgreement: {
          select: { paidAmount: true }
        }
      }
    });

    const byVehicle = new Map();
    for (const v of vehicles) {
      byVehicle.set(v.id, {
        vehicleId: v.id,
        internalNumber: v.internalNumber,
        plate: v.plate,
        make: v.make,
        model: v.model,
        year: v.year,
        vehicleTypeId: v.vehicleType?.id || null,
        vehicleTypeName: v.vehicleType?.name || null,
        programCategory: v.programCategory,
        currentStatus: v.status,
        reservationCount: 0,
        totalCharges: 0,
        totalPaid: 0
      });
    }

    for (const r of reservations) {
      const row = byVehicle.get(r.vehicleId);
      if (!row) continue;
      row.reservationCount += 1;
      const charges = (r.charges || []).reduce((sum, c) => sum + Number(c.total || 0), 0);
      row.totalCharges += charges;
      row.totalPaid += Number(r.rentalAgreement?.paidAmount || 0);
    }

    const out = [...byVehicle.values()].sort((a, b) => b.totalCharges - a.totalCharges);

    return {
      range: { start, end },
      programCategory: query.programCategory || 'ALL',
      vehicles: out.map((row) => ({
        ...row,
        totalCharges: Number(row.totalCharges.toFixed(2)),
        totalPaid: Number(row.totalPaid.toFixed(2))
      })),
      totals: {
        vehicleCount: out.length,
        reservationCount: out.reduce((s, r) => s + r.reservationCount, 0),
        totalCharges: Number(out.reduce((s, r) => s + r.totalCharges, 0).toFixed(2)),
        totalPaid: Number(out.reduce((s, r) => s + r.totalPaid, 0).toFixed(2))
      }
    };
  },

  // Reservations report — flat list of every reservation in [start, end] with
  // key fields for accounting reconciliation (invoicing, audit, exports into
  // QuickBooks/etc). Triangle plan item #7 sub-item. Differs from contractsExcel
  // (which expands a column per charge type) — this one is fixed-shape so the
  // CSV/XLSX is friendly to import into other systems.
  async reservationsReport(query = {}, scope = {}) {
    const start = query.start ? startOfDay(query.start) : startOfDay(new Date(Date.now() - 30 * 24 * 60 * 60 * 1000));
    const end = query.end ? endOfDay(query.end) : endOfDay(new Date());
    const whereScope = scopeWhere(scope);

    const programCategoryFilter = query.programCategory && ['RENTAL_ONLY', 'LOANER_ONLY', 'BOTH'].includes(String(query.programCategory))
      ? { vehicle: { programCategory: String(query.programCategory) } }
      : {};

    const workflowModeFilter = query.workflowMode && ['STANDARD_RENTAL', 'DEALERSHIP_LOANER'].includes(String(query.workflowMode))
      ? { workflowMode: String(query.workflowMode) }
      : {};

    const statusFilter = query.status && ['NEW', 'CONFIRMED', 'CHECKED_OUT', 'CANCELLED'].includes(String(query.status))
      ? { status: String(query.status) }
      : {};

    const reservations = await prisma.reservation.findMany({
      where: {
        ...whereScope,
        pickupAt: { gte: start, lte: end },
        ...workflowModeFilter,
        ...statusFilter,
        ...programCategoryFilter
      },
      select: {
        id: true,
        reservationNumber: true,
        status: true,
        workflowMode: true,
        pickupAt: true,
        returnAt: true,
        bookingChannel: true,
        customer: { select: { firstName: true, lastName: true, email: true, phone: true } },
        vehicle: {
          select: {
            id: true,
            internalNumber: true,
            plate: true,
            make: true,
            model: true,
            year: true,
            programCategory: true
          }
        },
        vehicleType: { select: { name: true } },
        pickupLocation: { select: { name: true, city: true } },
        rentalAgreement: {
          select: {
            agreementNumber: true,
            subtotal: true,
            taxes: true,
            total: true,
            paidAmount: true,
            balance: true
          }
        },
        charges: {
          where: { selected: true },
          select: { total: true, source: true, chargeType: true }
        }
      },
      orderBy: { pickupAt: 'asc' }
    });

    const rows = reservations.map((r) => {
      const pickup = r.pickupAt ? new Date(r.pickupAt) : null;
      const ret = r.returnAt ? new Date(r.returnAt) : null;
      const days = pickup && ret ? Math.max(1, Math.ceil((ret.getTime() - pickup.getTime()) / (24 * 60 * 60 * 1000))) : 0;
      const totalCharges = (r.charges || []).reduce((sum, c) => sum + Number(c.total || 0), 0);
      return {
        reservationId: r.id,
        reservationNumber: r.reservationNumber,
        agreementNumber: r.rentalAgreement?.agreementNumber || null,
        status: r.status,
        workflowMode: r.workflowMode,
        bookingChannel: r.bookingChannel,
        pickupAt: r.pickupAt,
        returnAt: r.returnAt,
        days,
        customerName: [r.customer?.firstName, r.customer?.lastName].filter(Boolean).join(' ') || null,
        customerEmail: r.customer?.email || null,
        customerPhone: r.customer?.phone || null,
        vehicleId: r.vehicle?.id || null,
        vehicleUnit: r.vehicle?.internalNumber || null,
        vehiclePlate: r.vehicle?.plate || null,
        vehicleLabel: r.vehicle ? [r.vehicle.year, r.vehicle.make, r.vehicle.model].filter(Boolean).join(' ') : null,
        vehicleProgramCategory: r.vehicle?.programCategory || null,
        vehicleTypeName: r.vehicleType?.name || null,
        pickupLocationName: r.pickupLocation?.name || null,
        pickupLocationCity: r.pickupLocation?.city || null,
        chargesTotal: Number(totalCharges.toFixed(2)),
        agreementSubtotal: Number((r.rentalAgreement?.subtotal || 0).toFixed(2)),
        agreementTaxes: Number((r.rentalAgreement?.taxes || 0).toFixed(2)),
        agreementTotal: Number((r.rentalAgreement?.total || 0).toFixed(2)),
        agreementPaid: Number((r.rentalAgreement?.paidAmount || 0).toFixed(2)),
        agreementBalance: Number((r.rentalAgreement?.balance || 0).toFixed(2))
      };
    });

    return {
      range: { start, end },
      filters: {
        programCategory: query.programCategory || 'ALL',
        workflowMode: query.workflowMode || 'ALL',
        status: query.status || 'ALL'
      },
      reservations: rows,
      totals: {
        reservationCount: rows.length,
        totalCharges: Number(rows.reduce((s, r) => s + r.chargesTotal, 0).toFixed(2)),
        totalAgreement: Number(rows.reduce((s, r) => s + r.agreementTotal, 0).toFixed(2)),
        totalPaid: Number(rows.reduce((s, r) => s + r.agreementPaid, 0).toFixed(2)),
        totalBalance: Number(rows.reduce((s, r) => s + r.agreementBalance, 0).toFixed(2))
      }
    };
  },

  async reservationsReportExcel(query = {}, scope = {}) {
    const data = await this.reservationsReport(query, scope);
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Reservations');

    sheet.columns = [
      { header: 'Reservation #', key: 'reservationNumber', width: 16 },
      { header: 'Agreement #', key: 'agreementNumber', width: 16 },
      { header: 'Status', key: 'status', width: 12 },
      { header: 'Workflow', key: 'workflowMode', width: 18 },
      { header: 'Channel', key: 'bookingChannel', width: 12 },
      { header: 'Pickup', key: 'pickupAt', width: 16 },
      { header: 'Return', key: 'returnAt', width: 16 },
      { header: 'Days', key: 'days', width: 6 },
      { header: 'Customer', key: 'customerName', width: 22 },
      { header: 'Email', key: 'customerEmail', width: 24 },
      { header: 'Phone', key: 'customerPhone', width: 14 },
      { header: 'Unit', key: 'vehicleUnit', width: 10 },
      { header: 'Plate', key: 'vehiclePlate', width: 10 },
      { header: 'Vehicle', key: 'vehicleLabel', width: 22 },
      { header: 'Type', key: 'vehicleTypeName', width: 14 },
      { header: 'Program', key: 'vehicleProgramCategory', width: 12 },
      { header: 'Location', key: 'pickupLocationName', width: 18 },
      { header: 'Charges', key: 'chargesTotal', width: 12 },
      { header: 'Subtotal', key: 'agreementSubtotal', width: 12 },
      { header: 'Taxes', key: 'agreementTaxes', width: 10 },
      { header: 'Total', key: 'agreementTotal', width: 12 },
      { header: 'Paid', key: 'agreementPaid', width: 12 },
      { header: 'Balance', key: 'agreementBalance', width: 12 }
    ];
    sheet.getRow(1).font = { bold: true };

    for (const r of data.reservations) {
      sheet.addRow({
        ...r,
        pickupAt: r.pickupAt ? new Date(r.pickupAt).toISOString().slice(0, 16).replace('T', ' ') : '',
        returnAt: r.returnAt ? new Date(r.returnAt).toISOString().slice(0, 16).replace('T', ' ') : ''
      });
    }

    const totalsRowIdx = data.reservations.length + 2;
    sheet.addRow({});
    sheet.getRow(totalsRowIdx).getCell('Days').value = data.reservations.reduce((s, r) => s + r.days, 0);
    sheet.getRow(totalsRowIdx).getCell('Charges').value = data.totals.totalCharges;
    sheet.getRow(totalsRowIdx).getCell('Total').value = data.totals.totalAgreement;
    sheet.getRow(totalsRowIdx).getCell('Paid').value = data.totals.totalPaid;
    sheet.getRow(totalsRowIdx).getCell('Balance').value = data.totals.totalBalance;
    sheet.getRow(totalsRowIdx).font = { bold: true };

    return {
      buffer: await workbook.xlsx.writeBuffer(),
      filename: `reservations-${isoDay(data.range.start)}-to-${isoDay(data.range.end)}.xlsx`,
      rowCount: data.reservations.length
    };
  },

  // Inventory report — full fleet snapshot with utilization metrics. Triangle
  // plan item #7 sub-item. Each row is a vehicle with: status, location,
  // program category, vehicle type, days since last reservation, count of
  // reservations in [start, end], total revenue in window, and utilization
  // percentage (= days under reservation in window / total window days).
  // Operators see at a glance which cars are idle vs working.
  async inventoryReport(query = {}, scope = {}) {
    const start = query.start ? startOfDay(query.start) : startOfDay(new Date(Date.now() - 30 * 24 * 60 * 60 * 1000));
    const end = query.end ? endOfDay(query.end) : endOfDay(new Date());
    const whereScope = scopeWhere(scope);
    const windowDays = Math.max(1, Math.ceil((end.getTime() - start.getTime()) / (24 * 60 * 60 * 1000)));

    const programCategoryFilter = query.programCategory && ['RENTAL_ONLY', 'LOANER_ONLY', 'BOTH'].includes(String(query.programCategory))
      ? { programCategory: String(query.programCategory) }
      : {};

    const vehicles = await prisma.vehicle.findMany({
      where: { ...whereScope, ...programCategoryFilter },
      select: {
        id: true,
        internalNumber: true,
        plate: true,
        make: true,
        model: true,
        year: true,
        color: true,
        mileage: true,
        status: true,
        fleetMode: true,
        programCategory: true,
        vehicleType: { select: { id: true, name: true } },
        homeLocation: { select: { id: true, name: true, city: true, state: true } }
      },
      orderBy: { internalNumber: 'asc' }
    });

    if (!vehicles.length) {
      return {
        range: { start, end, windowDays },
        programCategory: query.programCategory || 'ALL',
        vehicles: [],
        totals: { vehicleCount: 0, reservationCount: 0, totalRevenue: 0, avgUtilization: 0 }
      };
    }

    const vehicleIds = vehicles.map((v) => v.id);

    const reservations = await prisma.reservation.findMany({
      where: {
        ...whereScope,
        vehicleId: { in: vehicleIds },
        // Any reservation that overlaps the window — pickupAt before window end
        // AND returnAt after window start — counts toward utilization.
        pickupAt: { lt: end },
        returnAt: { gt: start }
      },
      select: {
        id: true,
        vehicleId: true,
        status: true,
        pickupAt: true,
        returnAt: true,
        charges: {
          where: { selected: true },
          select: { total: true }
        }
      },
      orderBy: { pickupAt: 'asc' }
    });

    // Most-recent reservation per vehicle for "last reservation" column.
    const latestPickupByVehicle = await prisma.reservation.groupBy({
      by: ['vehicleId'],
      where: {
        ...whereScope,
        vehicleId: { in: vehicleIds }
      },
      _max: { pickupAt: true }
    });
    const latestPickupMap = new Map();
    for (const row of latestPickupByVehicle) {
      if (row.vehicleId) latestPickupMap.set(row.vehicleId, row._max.pickupAt);
    }

    const byVehicle = new Map();
    for (const v of vehicles) {
      byVehicle.set(v.id, {
        vehicleId: v.id,
        internalNumber: v.internalNumber,
        plate: v.plate,
        year: v.year,
        make: v.make,
        model: v.model,
        color: v.color,
        mileage: v.mileage,
        status: v.status,
        fleetMode: v.fleetMode,
        programCategory: v.programCategory,
        vehicleTypeName: v.vehicleType?.name || null,
        homeLocationName: v.homeLocation?.name || null,
        homeLocationCity: v.homeLocation?.city || null,
        lastReservationAt: latestPickupMap.get(v.id) || null,
        daysSinceLastReservation: null,
        reservationCount: 0,
        utilizationDays: 0,
        utilizationPct: 0,
        totalRevenue: 0
      });
    }

    const now = Date.now();
    for (const row of byVehicle.values()) {
      if (row.lastReservationAt) {
        row.daysSinceLastReservation = Math.max(0, Math.floor((now - new Date(row.lastReservationAt).getTime()) / (24 * 60 * 60 * 1000)));
      }
    }

    // Aggregate utilization + revenue per vehicle.
    for (const r of reservations) {
      const row = byVehicle.get(r.vehicleId);
      if (!row) continue;
      row.reservationCount += 1;
      const overlapStart = new Date(Math.max(start.getTime(), new Date(r.pickupAt).getTime()));
      const overlapEnd = new Date(Math.min(end.getTime(), new Date(r.returnAt).getTime()));
      if (overlapEnd > overlapStart) {
        const days = (overlapEnd.getTime() - overlapStart.getTime()) / (24 * 60 * 60 * 1000);
        row.utilizationDays += days;
      }
      const charges = (r.charges || []).reduce((sum, c) => sum + Number(c.total || 0), 0);
      row.totalRevenue += charges;
    }

    for (const row of byVehicle.values()) {
      row.utilizationDays = Number(row.utilizationDays.toFixed(2));
      row.utilizationPct = Number(((row.utilizationDays / windowDays) * 100).toFixed(1));
      row.totalRevenue = Number(row.totalRevenue.toFixed(2));
    }

    const out = [...byVehicle.values()].sort((a, b) => b.utilizationPct - a.utilizationPct);

    return {
      range: { start, end, windowDays },
      programCategory: query.programCategory || 'ALL',
      vehicles: out,
      totals: {
        vehicleCount: out.length,
        reservationCount: out.reduce((s, r) => s + r.reservationCount, 0),
        totalRevenue: Number(out.reduce((s, r) => s + r.totalRevenue, 0).toFixed(2)),
        avgUtilization: out.length ? Number((out.reduce((s, r) => s + r.utilizationPct, 0) / out.length).toFixed(1)) : 0
      }
    };
  },

  async inventoryReportExcel(query = {}, scope = {}) {
    const data = await this.inventoryReport(query, scope);
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Inventory');

    sheet.columns = [
      { header: 'Unit ID', key: 'internalNumber', width: 14 },
      { header: 'Plate', key: 'plate', width: 12 },
      { header: 'Year', key: 'year', width: 8 },
      { header: 'Make', key: 'make', width: 14 },
      { header: 'Model', key: 'model', width: 14 },
      { header: 'Color', key: 'color', width: 12 },
      { header: 'Type', key: 'vehicleTypeName', width: 16 },
      { header: 'Status', key: 'status', width: 14 },
      { header: 'Program', key: 'programCategory', width: 14 },
      { header: 'Home Location', key: 'homeLocationName', width: 18 },
      { header: 'Mileage', key: 'mileage', width: 10 },
      { header: 'Reservations (window)', key: 'reservationCount', width: 18 },
      { header: 'Utilization Days', key: 'utilizationDays', width: 16 },
      { header: 'Utilization %', key: 'utilizationPct', width: 14 },
      { header: 'Revenue (window)', key: 'totalRevenue', width: 16 },
      { header: 'Last Reservation', key: 'lastReservationAt', width: 20 },
      { header: 'Days Idle', key: 'daysSinceLastReservation', width: 12 }
    ];
    sheet.getRow(1).font = { bold: true };

    for (const v of data.vehicles) {
      sheet.addRow({
        ...v,
        lastReservationAt: v.lastReservationAt ? new Date(v.lastReservationAt).toISOString().slice(0, 10) : ''
      });
    }

    const totalsRowIdx = data.vehicles.length + 2;
    sheet.addRow({});
    sheet.getRow(totalsRowIdx).getCell('Reservations (window)').value = data.totals.reservationCount;
    sheet.getRow(totalsRowIdx).getCell('Utilization %').value = data.totals.avgUtilization;
    sheet.getRow(totalsRowIdx).getCell('Revenue (window)').value = data.totals.totalRevenue;
    sheet.getRow(totalsRowIdx).font = { bold: true };

    return {
      buffer: await workbook.xlsx.writeBuffer(),
      filename: `inventory-${isoDay(data.range.start)}-to-${isoDay(data.range.end)}.xlsx`,
      rowCount: data.vehicles.length
    };
  },

  // Excel export of the per-vehicle revenue report.
  async vehicleRevenueExcel(query = {}, scope = {}) {
    const data = await this.vehicleRevenue(query, scope);
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Vehicle Revenue');

    sheet.columns = [
      { header: 'Unit ID', key: 'internalNumber', width: 14 },
      { header: 'Plate', key: 'plate', width: 12 },
      { header: 'Year', key: 'year', width: 8 },
      { header: 'Make', key: 'make', width: 14 },
      { header: 'Model', key: 'model', width: 14 },
      { header: 'Type', key: 'vehicleTypeName', width: 16 },
      { header: 'Program', key: 'programCategory', width: 14 },
      { header: 'Status', key: 'currentStatus', width: 14 },
      { header: 'Reservations', key: 'reservationCount', width: 14 },
      { header: 'Total Charges', key: 'totalCharges', width: 16 },
      { header: 'Total Paid', key: 'totalPaid', width: 16 }
    ];
    sheet.getRow(1).font = { bold: true };

    for (const v of data.vehicles) {
      sheet.addRow(v);
    }

    // Totals row
    const totalsRowIdx = data.vehicles.length + 2;
    sheet.addRow({});
    sheet.getRow(totalsRowIdx).getCell('Reservations').value = data.totals.reservationCount;
    sheet.getRow(totalsRowIdx).getCell('Total Charges').value = data.totals.totalCharges;
    sheet.getRow(totalsRowIdx).getCell('Total Paid').value = data.totals.totalPaid;
    sheet.getRow(totalsRowIdx).font = { bold: true };

    return {
      buffer: await workbook.xlsx.writeBuffer(),
      filename: `vehicle-revenue-${isoDay(data.range.start)}-to-${isoDay(data.range.end)}.xlsx`,
      rowCount: data.vehicles.length
    };
  }
};
