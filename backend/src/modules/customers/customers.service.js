import crypto from 'node:crypto';
import { prisma } from '../../lib/prisma.js';

function parseLocationConfig(raw) {
  try {
    if (!raw) return {};
    if (typeof raw === 'string') return JSON.parse(raw);
    if (typeof raw === 'object') return raw;
  } catch {}
  return {};
}

function ageOnDate(dob, onDate) {
  if (!dob || !onDate) return null;
  const birth = new Date(dob);
  const ref = new Date(onDate);
  if (Number.isNaN(birth.getTime()) || Number.isNaN(ref.getTime())) return null;
  let age = ref.getFullYear() - birth.getFullYear();
  const m = ref.getMonth() - birth.getMonth();
  if (m < 0 || (m === 0 && ref.getDate() < birth.getDate())) age--;
  return age;
}


async function applyCreditToUnpaidAgreements(customerId, scope = {}) {
  const customer = await prisma.customer.findFirst({ where: { id: customerId, ...(scope?.tenantId ? { tenantId: scope.tenantId } : {}) }, select: { creditBalance: true, notes: true } });
  let credit = Number(customer?.creditBalance || 0);
  if (credit <= 0) return;

  const agreements = await prisma.rentalAgreement.findMany({
    where: {
      ...(scope?.tenantId ? { tenantId: scope.tenantId } : {}),
      reservation: { customerId },
      balance: { gt: 0 }
    },
    orderBy: { createdAt: 'asc' }
  });

  for (const a of agreements) {
    if (credit <= 0) break;
    const bal = Number(a.balance || 0);
    if (bal <= 0) continue;
    const used = Math.min(credit, bal);
    const nextBal = Number((bal - used).toFixed(2));

    await prisma.rentalAgreement.update({ where: { id: a.id }, data: { balance: nextBal } });
    await prisma.rentalAgreementPayment.create({
      data: {
        rentalAgreementId: a.id,
        method: 'OTHER',
        amount: used,
        reference: 'CUSTOMER_CREDIT_AUTO_APPLIED',
        status: 'PAID',
        notes: 'Automatically applied from customer credit balance'
      }
    });

    credit = Number((credit - used).toFixed(2));
  }

  if (credit !== Number(customer?.creditBalance || 0)) {
    const consumed = Number((Number(customer?.creditBalance || 0) - credit).toFixed(2));
    const note = `[CREDIT AUTO-APPLIED ${new Date().toISOString()}] -${consumed.toFixed(2)} applied to unpaid agreements`;
    await prisma.customer.update({
      where: { id: customerId },
      data: {
        creditBalance: credit,
        notes: customer?.notes ? `${customer.notes}\n${note}` : note
      }
    });
  }
}

export const customersService = {
  list(scope = {}) {
    return prisma.customer.findMany({ where: scope?.tenantId ? { tenantId: scope.tenantId } : undefined, orderBy: { createdAt: 'desc' } });
  },

  async getById(id, scope = {}) {
    const customer = await prisma.customer.findFirst({
      where: { id, ...(scope?.tenantId ? { tenantId: scope.tenantId } : {}) },
      include: {
        reservations: {
          orderBy: { createdAt: 'desc' },
          include: { vehicle: true, pickupLocation: true, returnLocation: true }
        }
      }
    });
    if (!customer) return null;

    const agreements = await prisma.rentalAgreement.findMany({
      where: { ...(scope?.tenantId ? { tenantId: scope.tenantId } : {}), reservation: { customerId: id } },
      orderBy: { createdAt: 'desc' },
      include: { reservation: true }
    });

    const reservations = (customer.reservations || []).map((r) => {
      const cfg = parseLocationConfig(r?.pickupLocation?.locationConfig);
      const enabled = !!cfg?.underageAlertEnabled;
      const threshold = Number(cfg?.underageAlertAge ?? cfg?.chargeAgeMin ?? 21);
      const age = ageOnDate(customer.dateOfBirth, r.pickupAt);
      const underageAlert = !!enabled && Number.isFinite(threshold) && threshold >= 16 && age != null && age < threshold;
      return { ...r, underageAlert, underageAlertAge: age, underageAlertThreshold: threshold };
    });

    const unpaidBalance = agreements.reduce((s, a) => s + Number(a.balance || 0), 0);
    return { ...customer, reservations, agreements, unpaidBalance };
  },

  create(data, scope = {}) {
    return prisma.customer.create({
      data: {
        tenantId: scope?.tenantId || data.tenantId || null,
        firstName: data.firstName,
        lastName: data.lastName,
        email: data.email ?? null,
        phone: data.phone,
        licenseNumber: data.licenseNumber ?? null,
        licenseState: data.licenseState ?? null,
        dateOfBirth: data.dateOfBirth ? new Date(data.dateOfBirth) : null,
        insurancePolicyNumber: data.insurancePolicyNumber ?? null,
        insuranceDocumentUrl: data.insuranceDocumentUrl ?? null,
        address1: data.address1 ?? null,
        address2: data.address2 ?? null,
        city: data.city ?? null,
        state: data.state ?? null,
        zip: data.zip ?? null,
        country: data.country ?? null,
        idPhotoUrl: data.idPhotoUrl ?? null,
        creditBalance: data.creditBalance ?? 0,
        doNotRent: !!data.doNotRent,
        doNotRentReason: data.doNotRentReason ?? null,
        notes: data.notes ?? null
      }
    });
  },

  async update(id, patch, scope = {}) {
    const current = await prisma.customer.findFirst({ where: { id, ...(scope?.tenantId ? { tenantId: scope.tenantId } : {}) } });
    if (!current) throw new Error('Customer not found');
    const data = { ...(patch || {}) };
    delete data.tenantId;
    if (Object.prototype.hasOwnProperty.call(data, 'dateOfBirth')) {
      data.dateOfBirth = data.dateOfBirth ? new Date(data.dateOfBirth) : null;
    }
    if (Object.prototype.hasOwnProperty.call(data, 'creditBalance')) {
      data.creditBalance = Number(data.creditBalance || 0);
    }
    const row = await prisma.customer.update({ where: { id }, data });
    await applyCreditToUnpaidAgreements(id, scope);
    return prisma.customer.findFirst({ where: { id, ...(scope?.tenantId ? { tenantId: scope.tenantId } : {}) } });
  },

  async issuePasswordReset(id, baseUrl = 'http://localhost:3000', scope = {}) {
    const current = await prisma.customer.findFirst({ where: { id, ...(scope?.tenantId ? { tenantId: scope.tenantId } : {}) }, select: { id: true } });
    if (!current) throw new Error('Customer not found');
    const token = crypto.randomBytes(24).toString('hex');
    const expiresAt = new Date(Date.now() + 1000 * 60 * 60); // 1h

    const row = await prisma.customer.update({
      where: { id },
      data: { portalResetToken: token, portalResetExpiresAt: expiresAt },
      select: { id: true, email: true, firstName: true, lastName: true }
    });

    const resetLink = `${baseUrl.replace(/\/$/, '')}/customer/reset-password?token=${token}`;
    return { ...row, resetLink, expiresAt };
  },

  async remove(id, scope = {}) {
    const current = await prisma.customer.findFirst({ where: { id, ...(scope?.tenantId ? { tenantId: scope.tenantId } : {}) }, select: { id: true } });
    if (!current) throw new Error('Customer not found');
    return prisma.customer.delete({ where: { id } });
  }
};
