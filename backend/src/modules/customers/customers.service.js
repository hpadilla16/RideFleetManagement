import crypto from 'node:crypto';
import { prisma } from '../../lib/prisma.js';
import { parseLocationConfig } from '../../lib/location-config.js';

function norm(v) {
  return String(v ?? '').trim();
}

function normLower(v) {
  return norm(v).toLowerCase();
}

function parseDateInput(value) {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed;
}

function parseNumberInput(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
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

  const operations = [];
  for (const a of agreements) {
    if (credit <= 0) break;
    const bal = Number(a.balance || 0);
    if (bal <= 0) continue;
    const used = Math.min(credit, bal);
    const nextBal = Number((bal - used).toFixed(2));

    operations.push(prisma.rentalAgreement.update({ where: { id: a.id }, data: { balance: nextBal } }));
    operations.push(prisma.rentalAgreementPayment.create({
      data: {
        rentalAgreementId: a.id,
        method: 'OTHER',
        amount: used,
        reference: 'CUSTOMER_CREDIT_AUTO_APPLIED',
        status: 'PAID',
        notes: 'Automatically applied from customer credit balance'
      }
    }));

    credit = Number((credit - used).toFixed(2));
  }
  if (operations.length) await prisma.$transaction(operations);

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

async function resolveImportTenant(row, scope = {}, cache) {
  if (scope?.tenantId) {
    if (!cache.tenantById.has(scope.tenantId)) {
      const tenant = await prisma.tenant.findUnique({
        where: { id: scope.tenantId },
        select: { id: true, slug: true, name: true }
      });
      cache.tenantById.set(scope.tenantId, tenant || null);
    }
    return cache.tenantById.get(scope.tenantId);
  }

  const tenantId = norm(row.tenantId);
  const tenantSlug = norm(row.tenantSlug);
  const tenantName = norm(row.tenantName);

  if (tenantId) {
    if (!cache.tenantById.has(tenantId)) {
      const tenant = await prisma.tenant.findUnique({
        where: { id: tenantId },
        select: { id: true, slug: true, name: true }
      });
      cache.tenantById.set(tenantId, tenant || null);
    }
    return cache.tenantById.get(tenantId);
  }

  if (tenantSlug) {
    const key = tenantSlug.toLowerCase();
    if (!cache.tenantBySlug.has(key)) {
      const tenant = await prisma.tenant.findUnique({
        where: { slug: tenantSlug },
        select: { id: true, slug: true, name: true }
      });
      cache.tenantBySlug.set(key, tenant || null);
    }
    return cache.tenantBySlug.get(key);
  }

  if (tenantName) {
    const key = tenantName.toLowerCase();
    if (!cache.tenantByName.has(key)) {
      const tenant = await prisma.tenant.findFirst({
        where: { name: tenantName },
        select: { id: true, slug: true, name: true }
      });
      cache.tenantByName.set(key, tenant || null);
    }
    return cache.tenantByName.get(key);
  }

  return null;
}

async function buildCustomerImportRow(row, index, scope = {}, cache = {}) {
  const tenant = await resolveImportTenant(row || {}, scope, cache);
  const tenantId = tenant?.id || scope?.tenantId || null;

  const firstName = norm(row.firstName);
  const lastName = norm(row.lastName);
  const email = norm(row.email) || null;
  const phone = norm(row.phone);
  const licenseNumber = norm(row.licenseNumber) || null;
  const licenseState = norm(row.licenseState) || null;
  const dateOfBirth = row.dateOfBirth ? parseDateInput(row.dateOfBirth) : null;
  const creditBalance = parseNumberInput(row.creditBalance);

  const errors = [];
  const duplicateReasons = [];

  if (!tenantId) errors.push('tenantId/tenantSlug required');
  if (!firstName) errors.push('firstName required');
  if (!lastName) errors.push('lastName required');
  if (!phone) errors.push('phone required');
  if (row.dateOfBirth && !dateOfBirth) errors.push('dateOfBirth invalid');
  if (row.creditBalance && creditBalance == null) errors.push('creditBalance invalid');

  const existing = tenantId
    ? await prisma.customer.findFirst({
        where: {
          tenantId,
          OR: [
            ...(email ? [{ email }] : []),
            ...(phone ? [{ phone }] : []),
            ...(licenseNumber ? [{ licenseNumber }] : [])
          ]
        },
        select: { id: true, email: true, phone: true, licenseNumber: true }
      })
    : null;

  if (existing?.email && email && normLower(existing.email) === normLower(email)) duplicateReasons.push('email exists');
  if (existing?.phone && phone && normLower(existing.phone) === normLower(phone)) duplicateReasons.push('phone exists');
  if (existing?.licenseNumber && licenseNumber && normLower(existing.licenseNumber) === normLower(licenseNumber)) duplicateReasons.push('licenseNumber exists');

  return {
    row: index + 1,
    valid: errors.length === 0 && duplicateReasons.length === 0,
    errors,
    duplicateReasons,
    tenantId,
    tenantLabel: tenant?.name || tenant?.slug || tenantId || '',
    firstName,
    lastName,
    email,
    phone,
    normalized: {
      tenantId,
      firstName,
      lastName,
      email,
      phone,
      dateOfBirth,
      address1: norm(row.address1) || null,
      address2: norm(row.address2) || null,
      city: norm(row.city) || null,
      state: norm(row.state) || null,
      zip: norm(row.zip) || null,
      country: norm(row.country) || null,
      licenseNumber,
      licenseState,
      insurancePolicyNumber: norm(row.insurancePolicyNumber) || null,
      insuranceDocumentUrl: norm(row.insuranceDocumentUrl) || null,
      idPhotoUrl: norm(row.idPhotoUrl) || null,
      creditBalance: creditBalance ?? 0,
      doNotRent: ['1', 'true', 'yes', 'y'].includes(normLower(row.doNotRent)),
      doNotRentReason: norm(row.doNotRentReason) || null,
      notes: norm(row.notes) || null
    }
  };
}

export const customersService = {
  list(scope = {}, options = {}) {
    const query = norm(options.query);
    const limitRaw = options.limit;
    const limit = limitRaw == null || limitRaw === ''
      ? undefined
      : Math.min(250, Math.max(1, Number.parseInt(String(limitRaw), 10) || 100));

    return prisma.customer.findMany({
      where: {
        ...(scope?.tenantId ? { tenantId: scope.tenantId } : {}),
        ...(query
          ? {
              OR: [
                { firstName: { contains: query, mode: 'insensitive' } },
                { lastName: { contains: query, mode: 'insensitive' } },
                { email: { contains: query, mode: 'insensitive' } },
                { phone: { contains: query, mode: 'insensitive' } }
              ]
            }
          : {})
      },
      orderBy: { createdAt: 'desc' },
      ...(limit ? { take: limit } : {})
    });
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

  async validateBulk(rows = [], scope = {}) {
    const cache = {
      tenantById: new Map(),
      tenantBySlug: new Map(),
      tenantByName: new Map()
    };

    let validCount = 0;
    let duplicateCount = 0;
    let invalidCount = 0;
    const report = [];

    for (let idx = 0; idx < rows.length; idx += 1) {
      const built = await buildCustomerImportRow(rows[idx], idx, scope, cache);
      if (built.errors.length) invalidCount += 1;
      else if (built.duplicateReasons.length) duplicateCount += 1;
      else validCount += 1;
      report.push(built);
    }

    return {
      found: rows.length,
      valid: validCount,
      duplicates: duplicateCount,
      invalid: invalidCount,
      rows: report
    };
  },

  async importBulk(rows = [], scope = {}) {
    const validation = await this.validateBulk(rows, scope);
    const validRows = validation.rows.filter((row) => row.valid);

    if (!validRows.length) {
      return { created: 0, skipped: validation.found, validation };
    }

    await prisma.customer.createMany({
      data: validRows.map((row) => ({
        tenantId: row.normalized.tenantId,
        firstName: row.normalized.firstName,
        lastName: row.normalized.lastName,
        email: row.normalized.email,
        phone: row.normalized.phone,
        dateOfBirth: row.normalized.dateOfBirth,
        address1: row.normalized.address1,
        address2: row.normalized.address2,
        city: row.normalized.city,
        state: row.normalized.state,
        zip: row.normalized.zip,
        country: row.normalized.country,
        licenseNumber: row.normalized.licenseNumber,
        licenseState: row.normalized.licenseState,
        insurancePolicyNumber: row.normalized.insurancePolicyNumber,
        insuranceDocumentUrl: row.normalized.insuranceDocumentUrl,
        idPhotoUrl: row.normalized.idPhotoUrl,
        creditBalance: row.normalized.creditBalance,
        doNotRent: row.normalized.doNotRent,
        doNotRentReason: row.normalized.doNotRentReason,
        notes: row.normalized.notes
      }))
    });

    return {
      created: validRows.length,
      skipped: validation.found - validRows.length,
      validation
    };
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
