import crypto from 'node:crypto';
import { prisma } from '../../lib/prisma.js';
import { LOANER_PROGRAM_FILTER } from '../../lib/program-category.js';

/**
 * Public loaner self-service (2026-06-25). Powers the website's lookup / reserve / request flows.
 * Plan: doc/public-loaner-selfservice-plan-2026-06-25.md. Scoped by tenantId (the X-Tenant-Token
 * middleware resolves it on /api/public/loaner). All fail-closed: no tenant → '__never__' matches
 * nothing.
 */
function err(message, statusCode = 400) {
  const e = new Error(message);
  e.statusCode = statusCode;
  return e;
}

function loanerVehicleWhere(tenantId) {
  return {
    tenantId: tenantId || '__never__',
    status: { notIn: ['IN_MAINTENANCE', 'OUT_OF_SERVICE'] },
    programCategory: LOANER_PROGRAM_FILTER, // LOANER_ONLY or BOTH
  };
}

// vehicle row (with vehicleType profile) → LoanerOption shape the website expects.
function toLoanerOption(v) {
  const vt = v.vehicleType || {};
  return {
    id: v.id, // a specific loaner vehicle instance (used by /reserve as loanerId)
    name: [v.year, v.make, v.model].filter(Boolean).join(' ') || vt.name || 'Loaner',
    classLabel: vt.name || null,
    imageUrl: vt.imageUrl || null,
    passengers: vt.passengers ?? null,
    bags: vt.bags ?? null,
    transmission: vt.transmission || null,
    costPerDay: 0, // 0 = covered by the service (courtesy). Advisor can bill otherwise at intake.
    recommended: false,
  };
}

const LOANER_VEHICLE_SELECT = {
  id: true, year: true, make: true, model: true, internalNumber: true, plate: true, status: true,
  vehicleType: {
    select: { id: true, name: true, code: true, imageUrl: true, passengers: true, bags: true, transmission: true },
  },
};

export const publicLoanerService = {
  /** Available loaner vehicles for a tenant, mapped to LoanerOption[]. */
  async getLoanerOptions(tenantId) {
    const vehicles = await prisma.vehicle.findMany({
      where: loanerVehicleWhere(tenantId),
      orderBy: [{ make: 'asc' }, { model: 'asc' }, { internalNumber: 'asc' }],
      select: LOANER_VEHICLE_SELECT,
    });
    return vehicles.map(toLoanerOption);
  },

  /** Find the service appointment (an existing loaner reservation) by RO/lastName/phone + loaners. */
  async lookup({ tenantId, repairOrderNumber, lastName, phone }) {
    const ro = String(repairOrderNumber || '').trim();
    const ln = String(lastName || '').trim();
    const ph = String(phone || '').trim();

    let appointment = null;
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
          id: true, repairOrderNumber: true, pickupAt: true, estimatedServiceCompletionAt: true,
          serviceVehicleYear: true, serviceVehicleMake: true, serviceVehicleModel: true, serviceVehiclePlate: true,
          serviceAdvisorName: true,
          pickupLocation: { select: { name: true, city: true, state: true } },
        },
      });
      if (res) {
        const veh = [res.serviceVehicleYear, res.serviceVehicleMake, res.serviceVehicleModel].filter(Boolean).join(' ');
        const dt = res.estimatedServiceCompletionAt || res.pickupAt;
        const loc = res.pickupLocation;
        appointment = {
          id: res.id,
          vehicle: veh || (res.serviceVehiclePlate || null),
          dateTime: dt ? new Date(dt).toISOString() : null,
          location: loc ? [loc.name, loc.city, loc.state].filter(Boolean).join(', ') : null,
          advisor: res.serviceAdvisorName || null,
          repairOrderNumber: res.repairOrderNumber || null,
        };
      }
    }

    const loaners = await this.getLoanerOptions(tenantId);
    return { appointment, loaners };
  },

  /** "Request a courtesy car" lead (no reservation) → advisor works it from the dashboard. */
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
   * Self-service reserve: the customer picked a loaner + signed online. (A) UPDATE the appointment
   * reservation (assign the loaner + flag self-service PENDING approval); (B) create/refresh the
   * LoanerAgreement DRAFT with the inline signature. The advisor approves + checks out (DRAFT→ACTIVE).
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

    const vehicle = await prisma.vehicle.findFirst({
      where: { id: loaner, ...loanerVehicleWhere(tenantId) },
      select: { id: true },
    });
    if (!vehicle) throw err('Selected loaner is not available', 409);

    const now = new Date();
    const signerName = [reservation.customer?.firstName, reservation.customer?.lastName]
      .filter(Boolean).join(' ').trim() || 'Customer';

    await prisma.reservation.update({
      where: { id: reservation.id },
      data: { vehicleId: vehicle.id, loanerSelfServiceSubmittedAt: now },
    });

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

    return { confirmationNumber: reservation.reservationNumber, reservationId: reservation.id };
  },
};
