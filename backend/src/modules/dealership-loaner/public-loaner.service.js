import crypto from 'node:crypto';
import { prisma } from '../../lib/prisma.js';
import { LOANER_PROGRAM_FILTER } from '../../lib/program-category.js';
import { loanerRateService } from './loaner-rate.service.js';
import { RESERVABLE_STATUSES, money, daysBetween, priceUpgrade } from './loaner-pricing.js';

/**
 * Public loaner self-service (2026-06-25, extended for class-upgrade pricing + checked-out lock).
 * Powers the website's lookup / reserve / request flows. Scoped by tenantId (the X-Tenant-Token
 * middleware resolves it on /api/public/loaner). Fail-closed: no tenant -> '__never__' matches nothing.
 * Plan: doc/loaner-selfservice-class-upgrade-plan-2026-06-25.md.
 */
function err(message, statusCode = 400) {
  const e = new Error(message);
  e.statusCode = statusCode;
  return e;
}

// Public agreement view link (D5). Mirrors loaner-agreement.service.js's portal base resolution.
function loanerPortalBaseUrl() {
  return (
    process.env.CUSTOMER_PORTAL_BASE_URL ||
    process.env.APP_BASE_URL ||
    process.env.FRONTEND_BASE_URL ||
    'http://localhost:3000'
  ).replace(/\/+$/, '');
}

function loanerVehicleWhere(tenantId) {
  return {
    tenantId: tenantId || '__never__',
    status: { notIn: ['IN_MAINTENANCE', 'OUT_OF_SERVICE'] },
    programCategory: LOANER_PROGRAM_FILTER, // LOANER_ONLY or BOTH
  };
}

const LOANER_VEHICLE_SELECT = {
  id: true, year: true, make: true, model: true, internalNumber: true, plate: true, status: true,
  vehicleType: {
    select: { id: true, name: true, code: true, imageUrl: true, passengers: true, bags: true, transmission: true },
  },
};

// vehicle row -> LoanerOption shape the website expects, priced against the entitled class.
function toLoanerOption(v, rateMap, entitledRate) {
  const vt = v.vehicleType || {};
  const dailyRate = money(rateMap[vt.id] ?? 0);
  // entitledRate === null -> no entitlement anchor: everything is covered (delta 0). See D2 fallback.
  const upgradeDeltaPerDay = entitledRate === null ? 0 : Math.max(0, money(dailyRate - entitledRate));
  return {
    id: v.id, // a specific loaner vehicle instance (used by /reserve as loanerId)
    name: [v.year, v.make, v.model].filter(Boolean).join(' ') || vt.name || 'Loaner',
    classLabel: vt.name || null,
    vehicleTypeId: vt.id || null,
    imageUrl: vt.imageUrl || null,
    passengers: vt.passengers ?? null,
    bags: vt.bags ?? null,
    transmission: vt.transmission || null,
    dailyRate,
    upgradeDeltaPerDay,
    costPerDay: upgradeDeltaPerDay, // back-compat: the customer-facing cost (0 = covered)
    recommended: false,
  };
}

export const publicLoanerService = {
  /** Available loaner vehicles for a tenant, priced vs the entitled class, as LoanerOption[]. */
  async getLoanerOptions(tenantId, { rateMap = null, entitledRate = null } = {}) {
    const map = rateMap || (await loanerRateService.getLoanerRateMap(tenantId));
    const vehicles = await prisma.vehicle.findMany({
      where: loanerVehicleWhere(tenantId),
      orderBy: [{ make: 'asc' }, { model: 'asc' }, { internalNumber: 'asc' }],
      select: LOANER_VEHICLE_SELECT,
    });
    return vehicles.map((v) => toLoanerOption(v, map, entitledRate));
  },

  /** Find the service appointment (an existing loaner reservation) by RO/lastName/phone + loaners. */
  async lookup({ tenantId, repairOrderNumber, lastName, phone }) {
    const ro = String(repairOrderNumber || '').trim();
    const ln = String(lastName || '').trim();
    const ph = String(phone || '').trim();

    const rateMap = await loanerRateService.getLoanerRateMap(tenantId);

    let appointment = null;
    let entitledRate = null;
    if (ro || ln || ph) {
      const customerWhere = {};
      if (ln) customerWhere.lastName = { equals: ln, mode: 'insensitive' };
      if (ph) customerWhere.phone = { contains: ph };
      const res = await prisma.reservation.findFirst({
        where: {
          tenantId: tenantId || '__never__',
          workflowMode: 'DEALERSHIP_LOANER',
          ...(ro ? { repairOrderNumber: { equals: ro, mode: 'insensitive' } } : {}),
          ...(Object.keys(customerWhere).length ? { customer: customerWhere } : {}),
        },
        orderBy: { createdAt: 'desc' },
        select: {
          id: true, status: true, repairOrderNumber: true, pickupAt: true, returnAt: true,
          estimatedServiceCompletionAt: true,
          serviceVehicleYear: true, serviceVehicleMake: true, serviceVehicleModel: true, serviceVehiclePlate: true,
          serviceAdvisorName: true,
          serviceVehicleTypeId: true,
          serviceVehicleType: { select: { id: true, name: true, code: true } },
          vehicle: { select: { id: true, year: true, make: true, model: true, plate: true, vehicleType: { select: { id: true, name: true } } } },
          pickupLocation: { select: { name: true, city: true, state: true } },
          loanerAgreement: { select: { portalToken: true, status: true } },
        },
      });
      if (res) {
        const svLabel = [res.serviceVehicleYear, res.serviceVehicleMake, res.serviceVehicleModel].filter(Boolean).join(' ');
        const dt = res.estimatedServiceCompletionAt || res.pickupAt;
        const loc = res.pickupLocation;
        const entitledClassLabel = res.serviceVehicleType?.name || null;
        // entitlement anchor = the service vehicle's class. Null -> covered (delta 0) everywhere.
        entitledRate = res.serviceVehicleTypeId ? money(rateMap[res.serviceVehicleTypeId] ?? 0) : null;

        const agr = res.loanerAgreement;
        // Don't offer the agreement portal for terminal reservations (no active loaner to view).
        const TERMINAL_STATUSES = ['CANCELLED', 'NO_SHOW'];
        const agreementAvailable = !!(agr && agr.portalToken && agr.status !== 'VOID')
          && !TERMINAL_STATUSES.includes(String(res.status));

        appointment = {
          id: res.id,
          status: res.status,
          repairOrderNumber: res.repairOrderNumber || null,
          dateTime: dt ? new Date(dt).toISOString() : null,
          location: loc ? [loc.name, loc.city, loc.state].filter(Boolean).join(', ') : null,
          advisor: res.serviceAdvisorName || null,
          serviceVehicle: {
            label: svLabel || (res.serviceVehiclePlate || null),
            classLabel: entitledClassLabel,
          },
          entitledClassLabel,
          assignedLoaner: res.vehicle
            ? {
                id: res.vehicle.id,
                name: [res.vehicle.year, res.vehicle.make, res.vehicle.model].filter(Boolean).join(' ') || null,
                classLabel: res.vehicle.vehicleType?.name || null,
              }
            : null,
          agreement: {
            available: agreementAvailable,
            url: agreementAvailable ? `${loanerPortalBaseUrl()}/customer/loaner-status?token=${encodeURIComponent(agr.portalToken)}` : null,
          },
        };
      }
    }

    const loaners = await this.getLoanerOptions(tenantId, { rateMap, entitledRate });
    return { appointment, loaners };
  },

  /** "Request a courtesy car" lead (no reservation) -> advisor works it from the dashboard. */
  async createRequest({ tenantId, name, phone, email, repairOrderNumber, preferredDate, notes }) {
    const nm = String(name || '').trim();
    const ph = String(phone || '').trim();
    if (!nm) throw err('name is required');
    if (!ph) throw err('phone is required');
    let preferred = null;
    if (preferredDate) { const d = new Date(preferredDate); if (!Number.isNaN(d.getTime())) preferred = d; }
    const row = await prisma.loanerRequest.create({
      data: {
        tenantId: tenantId || null,
        name: nm.slice(0, 200),
        phone: ph.slice(0, 50),
        email: email ? String(email).trim().slice(0, 200) : null,
        repairOrderNumber: repairOrderNumber ? String(repairOrderNumber).trim().slice(0, 100) : null,
        preferredDate: preferred,
        notes: notes ? String(notes).slice(0, 2000) : null,
        status: 'RECEIVED',
      },
      select: { id: true, status: true },
    });
    return { requestId: row.id, status: row.status };
  },

  /**
   * Self-service reserve: customer picked a loaner + signed online.
   * Guard: only NEW/CONFIRMED appointments may change (checked-out/cancelled -> 409).
   * (A) assign the loaner + flag self-service PENDING; (B) create/refresh the LoanerAgreement DRAFT
   * with the inline signature; (C) if the chosen class is above the entitled class, record the
   * per-day differential on the reservation's loaner billing fields (CUSTOMER_PAY / PENDING_APPROVAL /
   * estimatedTotal) for the advisor to collect. No gateway is ever called.
   */
  async reserve({ tenantId, appointmentId, loanerId, signature, ip }) {
    const apptId = String(appointmentId || '').trim();
    const loaner = String(loanerId || '').trim();
    const sig = String(signature || '');
    if (!apptId) throw err('appointmentId is required');
    if (!loaner) throw err('loanerId is required');
    if (!sig.startsWith('data:image')) throw err('signature (data:image/... PNG dataURL) is required');

    const reservation = await prisma.reservation.findFirst({
      where: { id: apptId, tenantId: tenantId || '__never__', workflowMode: 'DEALERSHIP_LOANER' },
      include: { customer: true, loanerAgreement: true },
    });
    if (!reservation) throw err('Appointment not found', 404);

    // GUARD (bug fix): a checked-out / checked-in / cancelled / no-show appointment cannot change.
    if (!RESERVABLE_STATUSES.includes(String(reservation.status))) {
      throw err('This appointment is already checked out; changes are not allowed.', 409);
    }

    const vehicle = await prisma.vehicle.findFirst({
      where: { id: loaner, ...loanerVehicleWhere(tenantId) },
      select: { id: true, vehicleTypeId: true },
    });
    if (!vehicle) throw err('Selected loaner is not available', 409);

    // Class-upgrade differential: chosen class vs entitled (service vehicle) class.
    const rateMap = await loanerRateService.getLoanerRateMap(tenantId);
    const chosenRate = money(rateMap[vehicle.vehicleTypeId] ?? 0);
    // Fallback (D2): no anchor -> entitled = chosen class -> delta 0.
    const entitledRate = reservation.serviceVehicleTypeId
      ? money(rateMap[reservation.serviceVehicleTypeId] ?? 0)
      : chosenRate;
    const days = daysBetween(reservation.pickupAt, reservation.returnAt);
    const { upgradeDeltaPerDay, estimatedUpgradeTotal } = priceUpgrade({ chosenRate, entitledRate, days });

    const now = new Date();
    const signerName = [reservation.customer?.firstName, reservation.customer?.lastName]
      .filter(Boolean).join(' ').trim() || 'Customer';

    const resvUpdate = { vehicleId: vehicle.id, loanerSelfServiceSubmittedAt: now };
    if (upgradeDeltaPerDay > 0) {
      resvUpdate.loanerBillingMode = 'CUSTOMER_PAY';
      resvUpdate.loanerBillingStatus = 'PENDING_APPROVAL';
      resvUpdate.loanerBillingSubmittedAt = now;
      resvUpdate.dailyRate = upgradeDeltaPerDay;
      resvUpdate.estimatedTotal = estimatedUpgradeTotal;
      resvUpdate.loanerBillingNotes =
        `Self-service class upgrade: $${upgradeDeltaPerDay.toFixed(2)}/day x ${days} day(s) = $${estimatedUpgradeTotal.toFixed(2)} (advisor to confirm/collect at pickup).`;
    }

    await prisma.reservation.update({ where: { id: reservation.id }, data: resvUpdate });

    if (reservation.loanerAgreement) {
      await prisma.loanerAgreement.update({
        where: { id: reservation.loanerAgreement.id },
        data: { vehicleId: vehicle.id, signatureDataUrl: sig, signerName, signedAt: now, signerIp: ip || null },
      });
    } else {
      await prisma.loanerAgreement.create({
        data: {
          tenantId: reservation.tenantId ?? tenantId ?? null,
          agreementNumber: 'LA-' + now.getTime().toString(36).toUpperCase() + '-' + crypto.randomBytes(2).toString('hex').toUpperCase(),
          status: 'DRAFT',
          portalToken: crypto.randomBytes(24).toString('base64url'),
          reservationId: reservation.id,
          vehicleId: vehicle.id,
          pickupAt: reservation.pickupAt,
          returnAt: reservation.returnAt,
          customerFirstName: reservation.customer?.firstName || 'Customer',
          customerLastName: reservation.customer?.lastName || '-',
          customerEmail: reservation.customer?.email ?? null,
          customerPhone: reservation.customer?.phone ?? null,
          signatureDataUrl: sig,
          signerName,
          signedAt: now,
          signerIp: ip || null,
        },
      });
    }

    return {
      confirmationNumber: reservation.reservationNumber,
      reservationId: reservation.id,
      upgradeDeltaPerDay,
      estimatedUpgradeTotal,
    };
  },
};

export const _internal = { daysBetween, money, RESERVABLE_STATUSES, priceUpgrade };
