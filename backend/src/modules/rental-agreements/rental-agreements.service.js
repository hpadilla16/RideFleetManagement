import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';
import { prisma } from '../../lib/prisma.js';
import { hostReviewsService } from '../host-reviews/host-reviews.service.js';
import { settingsService } from '../settings/settings.service.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
let cachedAgreementHtmlTemplate = null;
function getModernAgreementTemplate() {
  if (!cachedAgreementHtmlTemplate) {
    const templatePath = path.join(__dirname, '..', '..', 'templates', 'agreement-modern.html');
    cachedAgreementHtmlTemplate = fs.readFileSync(templatePath, 'utf8');
  }
  return cachedAgreementHtmlTemplate;
}

function toDecimal(value, fallback = 0) {
  if (value === null || value === undefined || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function agreementNumber() {
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
  const rand = Math.floor(Math.random() * 9000) + 1000;
  return `RA-${stamp}-${rand}`;
}

async function completeLinkedCarSharingTripForReservation(reservationId, actorUserId = null, reason = 'Reservation checked in') {
  if (!reservationId) return null;
  const trip = await prisma.trip.findFirst({
    where: { reservationId },
    select: {
      id: true,
      status: true
    }
  });
  if (!trip) return null;

  const currentStatus = String(trip.status || '').toUpperCase();
  if (currentStatus === 'COMPLETED') {
    try {
      await hostReviewsService.issueGuestReviewRequestForTrip(trip.id);
    } catch (error) {
      console.error('Unable to issue host review after reservation check-in', error);
    }
    return trip;
  }

  if (!['IN_PROGRESS', 'DISPUTED', 'READY_FOR_PICKUP', 'CONFIRMED', 'RESERVED'].includes(currentStatus)) {
    return trip;
  }

  await prisma.trip.update({
    where: { id: trip.id },
    data: {
      status: 'COMPLETED',
      actualReturnAt: new Date(),
      timelineEvents: {
        create: [{
          eventType: 'TRIP_COMPLETED',
          actorType: actorUserId ? 'TENANT_USER' : 'SYSTEM',
          actorRefId: actorUserId || null,
          notes: reason,
          metadata: JSON.stringify({
            source: 'reservation-checkin'
          })
        }]
      }
    }
  });

  try {
    await hostReviewsService.issueGuestReviewRequestForTrip(trip.id);
  } catch (error) {
    console.error('Unable to issue host review after trip completion sync', error);
  }

  return trip;
}

function parseLocationConfig(raw) {
  try {
    if (!raw) return {};
    if (typeof raw === 'string') return JSON.parse(raw);
    if (typeof raw === 'object') return raw;
  } catch {}
  return {};
}

async function authNetConfig(scope = {}) {
  const paymentConfig = await settingsService.getPaymentGatewayConfig(scope);
  const env = String(paymentConfig?.authorizenet?.environment || process.env.AUTHNET_ENV || 'sandbox').toLowerCase();
  const api = env === 'production' ? 'https://api2.authorize.net/xml/v1/request.api' : 'https://apitest.authorize.net/xml/v1/request.api';
  return {
    api,
    loginId: String(paymentConfig?.authorizenet?.loginId || process.env.AUTHNET_API_LOGIN_ID || '').trim(),
    transactionKey: String(paymentConfig?.authorizenet?.transactionKey || process.env.AUTHNET_TRANSACTION_KEY || '').trim()
  };
}

async function authNetRequest(payload, scope = {}) {
  const cfg = await authNetConfig(scope);
  if (!cfg.loginId || !cfg.transactionKey) throw new Error('Authorize.Net is not configured');
  const r = await fetch(cfg.api, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  return r.json();
}

function ageOnDate(dob, onDate) {
  if (!dob || !onDate) return null;
  const birth = new Date(dob);
  const ref = new Date(onDate);
  let age = ref.getFullYear() - birth.getFullYear();
  const m = ref.getMonth() - birth.getMonth();
  if (m < 0 || (m === 0 && ref.getDate() < birth.getDate())) age--;
  return age;
}

function fmtDate(v) {
  if (!v) return '-';
  return new Date(v).toLocaleString();
}

function esc(s) {
  return String(s ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function applyTemplate(html, vars = {}) {
  let out = String(html || '');
  for (const [k, v] of Object.entries(vars)) {
    out = out.replaceAll(`{{${k}}}`, String(v ?? ''));
  }
  return out;
}

function parseReservationPaymentsFromNotes(notes) {
  const txt = String(notes || '');
  const lines = txt.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
  const out = [];
  for (const line of lines) {
    // format: [PAYMENT <ISO>] GATEWAY paid 123.45 ref=XYZ
    const m = line.match(/^\[PAYMENT\s+([^\]]+)\]\s+([^\s]+)\s+paid\s+([0-9]+(?:\.[0-9]+)?)\s+ref=(.+)$/i);
    if (!m) continue;
    const paidAt = new Date(m[1]);
    const gateway = String(m[2] || 'PORTAL').toUpperCase();
    const amount = Number(m[3] || 0);
    const reference = String(m[4] || '').trim();
    if (!Number.isFinite(amount) || amount <= 0) continue;
    out.push({
      paidAt: Number.isFinite(paidAt.getTime()) ? paidAt : new Date(),
      amount,
      reference,
      notes: `Imported from reservation payment (${gateway})`
    });
  }
  return out;
}

function parseReservationChargesMeta(notes) {
  const m = String(notes || '').match(/\[RES_CHARGES_META\](\{[^\n]*\})/);
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch { return null; }
}

function rentalDays(pickupAt, returnAt) {
  const ms = Number(new Date(returnAt)) - Number(new Date(pickupAt));
  if (!Number.isFinite(ms) || ms <= 0) return 1;
  return Math.max(1, Math.ceil(ms / (24 * 60 * 60 * 1000)));
}

async function listMandatoryLocationFeeIds(reservation, tenantWhere = {}) {
  if (!reservation?.pickupLocationId) return [];
  const location = await prisma.location.findFirst({
    where: {
      id: reservation.pickupLocationId,
      ...tenantWhere
    },
    include: {
      locationFees: {
        include: {
          fee: {
            select: { id: true, isActive: true, mandatory: true }
          }
        }
      }
    }
  });
  return (location?.locationFees || [])
    .map((row) => row.fee)
    .filter((fee) => fee?.id && fee?.isActive && fee?.mandatory)
    .map((fee) => fee.id);
}

function parseAdditionalDriversFromNotes(notes) {
  const m = String(notes || '').match(/\[RES_ADDITIONAL_DRIVERS\](\{[^\n]*\})/);
  if (!m) return [];
  try {
    const j = JSON.parse(m[1]);
    return Array.isArray(j?.drivers) ? j.drivers : [];
  } catch {
    return [];
  }
}

function parseDepositMetaFromNotes(notes) {
  const legacy = String(notes || '').match(/\[RES_DEPOSIT_META\](\{[^\n]*\})/);
  if (legacy) {
    try {
      const j = JSON.parse(legacy[1]);
      const amount = Number(j?.depositAmountDue || 0);
      return { requireDeposit: !!j?.requireDeposit || amount > 0, depositAmountDue: Number.isFinite(amount) ? amount : 0 };
    } catch {}
  }

  const chargesMeta = parseReservationChargesMeta(notes);
  const amount = Number(chargesMeta?.depositMeta?.depositAmountDue || 0);
  return {
    requireDeposit: !!chargesMeta?.depositMeta?.requireDeposit || amount > 0,
    depositAmountDue: Number.isFinite(amount) ? amount : 0
  };
}

function parseSecurityDepositMetaFromNotes(notes) {
  const tagged = String(notes || '').match(/\[SECURITY_DEPOSIT_META\](\{[^\n]*\})/);
  if (tagged) {
    try {
      const j = JSON.parse(tagged[1]);
      const amount = Number(j?.securityDepositAmount || 0);
      return {
        requireSecurityDeposit: !!j?.requireSecurityDeposit || amount > 0,
        securityDepositAmount: Number.isFinite(amount) ? amount : 0
      };
    } catch {}
  }

  const chargesMeta = parseReservationChargesMeta(notes);
  const amount = Number(chargesMeta?.securityDepositMeta?.securityDepositAmount || 0);
  return {
    requireSecurityDeposit: !!chargesMeta?.securityDepositMeta?.requireSecurityDeposit || amount > 0,
    securityDepositAmount: Number.isFinite(amount) ? amount : 0
  };
}

function structuredReservationChargeRows(reservation) {
  const rows = Array.isArray(reservation?.charges) ? reservation.charges : [];
  if (!rows.length) return null;
  return rows.map((row, idx) => ({
    name: String(row?.name || 'Line Item'),
    code: row?.code || null,
    chargeType: String(row?.chargeType || 'UNIT').toUpperCase(),
    quantity: Number(row?.quantity || 1),
    rate: Number(row?.rate || 0),
    total: Number(row?.total || 0),
    taxable: !!row?.taxable,
    selected: row?.selected !== false,
    sortOrder: Number.isInteger(row?.sortOrder) ? row.sortOrder : idx,
    source: row?.source || null,
    sourceRefId: row?.sourceRefId || null
  }));
}

function isSecurityDepositCharge(row = {}) {
  const source = String(row?.source || '').trim().toUpperCase();
  const name = String(row?.name || '').trim().toUpperCase();
  return source === 'SECURITY_DEPOSIT' || name === 'SECURITY DEPOSIT';
}

function structuredReservationTotals(rows = []) {
  const normalized = Array.isArray(rows) ? rows : [];
  const subtotal = Number(normalized
    .filter((row) => String(row?.chargeType || '').toUpperCase() !== 'TAX' && !isSecurityDepositCharge(row))
    .reduce((sum, row) => sum + Number(row?.total || 0), 0)
    .toFixed(2));
  const taxes = Number(normalized
    .filter((row) => String(row?.chargeType || '').toUpperCase() === 'TAX')
    .reduce((sum, row) => sum + Number(row?.total || 0), 0)
    .toFixed(2));
  const total = Number((subtotal + taxes).toFixed(2));
  return { subtotal, taxes, total };
}

function structuredReservationPayments(reservation) {
  const payments = Array.isArray(reservation?.payments) ? reservation.payments : [];
  return payments.filter((payment) => String(payment?.status || 'PAID').toUpperCase() === 'PAID');
}

function monthKey(value = new Date()) {
  const d = new Date(value);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  return `${year}-${month}`;
}

function roundMoney(value) {
  return Number(Number(value || 0).toFixed(2));
}

function commissionChargeRows(charges = []) {
  return (Array.isArray(charges) ? charges : []).filter((row) => {
    if (row?.selected === false) return false;
    const total = Number(row?.total || 0);
    if (!(total > 0)) return false;
    const chargeType = String(row?.chargeType || '').toUpperCase();
    return chargeType !== 'TAX' && chargeType !== 'DEPOSIT';
  });
}

function resolveCommissionRule(charge, rules = [], servicesById = new Map(), insurancePlansByCode = new Map()) {
  const chargeCode = String(charge?.code || '').trim();
  const chargeType = String(charge?.chargeType || '').toUpperCase();
  const serviceId = String(charge?.source || '').toUpperCase() === 'ADDITIONAL_SERVICE' && charge?.sourceRefId
    ? String(charge.sourceRefId)
    : null;
  const insuranceCode = String(charge?.source || '').toUpperCase() === 'INSURANCE' && charge?.sourceRefId
    ? String(charge.sourceRefId).trim().toUpperCase()
    : null;

  if (serviceId && servicesById.has(serviceId)) {
    const service = servicesById.get(serviceId);
    if (service?.commissionValueType) {
      return {
        id: `service:${serviceId}`,
        name: service.name || charge?.name || 'Service Commission',
        valueType: service.commissionValueType,
        percentValue: service.commissionPercentValue,
        fixedAmount: service.commissionFixedAmount,
        isActive: true,
        source: 'SERVICE'
      };
    }
  }

  if (insuranceCode && insurancePlansByCode.has(insuranceCode)) {
    const plan = insurancePlansByCode.get(insuranceCode);
    if (plan?.commissionValueType) {
      return {
        id: `insurance:${insuranceCode}`,
        name: plan.name || plan.label || charge?.name || 'Insurance Commission',
        valueType: plan.commissionValueType,
        percentValue: plan.commissionPercentValue,
        fixedAmount: plan.commissionFixedAmount,
        isActive: true,
        source: 'INSURANCE'
      };
    }
  }

  const list = Array.isArray(rules) ? rules : [];
  return list.find((rule) => {
    if (!rule?.isActive) return false;
    if (serviceId && rule.serviceId && String(rule.serviceId) === serviceId) return true;
    if (chargeCode && rule.chargeCode && String(rule.chargeCode).trim() === chargeCode) return true;
    if (chargeType && rule.chargeType && String(rule.chargeType).toUpperCase() === chargeType) return true;
    return false;
  }) || null;
}

function calculateCommissionLine({ charge, rule, plan, appliedFixedAgreementRules }) {
  const quantity = Number(charge?.quantity || 1);
  const lineRevenue = roundMoney(charge?.total || 0);

  let valueType = rule?.valueType || plan?.defaultValueType || null;
  let percentValue = rule?.percentValue != null ? Number(rule.percentValue) : (plan?.defaultPercentValue != null ? Number(plan.defaultPercentValue) : null);
  let fixedAmount = rule?.fixedAmount != null ? Number(rule.fixedAmount) : (plan?.defaultFixedAmount != null ? Number(plan.defaultFixedAmount) : null);
  let commissionAmount = 0;

  if (valueType === 'PERCENT') {
    commissionAmount = roundMoney(lineRevenue * (Number(percentValue || 0) / 100));
  } else if (valueType === 'FIXED_PER_UNIT') {
    commissionAmount = roundMoney(quantity * Number(fixedAmount || 0));
  } else if (valueType === 'FIXED_PER_AGREEMENT') {
    const key = rule?.id || `${valueType}:${charge?.sourceRefId || charge?.code || charge?.chargeType || charge?.name || 'line'}`;
    if (appliedFixedAgreementRules.has(key)) {
      commissionAmount = 0;
    } else {
      appliedFixedAgreementRules.add(key);
      commissionAmount = roundMoney(fixedAmount || 0);
    }
  } else {
    valueType = null;
    percentValue = null;
    fixedAmount = null;
  }

  return {
    description: String(charge?.name || 'Line Item'),
    quantity,
    lineRevenue,
    valueType,
    percentValue: percentValue != null ? Number(percentValue) : null,
    fixedAmount: fixedAmount != null ? Number(fixedAmount) : null,
    commissionAmount
  };
}

function reservationAdditionalDrivers(reservation) {
  const structured = Array.isArray(reservation?.additionalDrivers) ? reservation.additionalDrivers : [];
  if (structured.length) return structured;
  return parseAdditionalDriversFromNotes(reservation?.notes);
}

function reservationDepositMeta(reservation) {
  const snapshot = reservation?.pricingSnapshot;
  if (snapshot) {
    const amount = Number(snapshot.depositAmountDue || 0);
    return {
      requireDeposit: !!snapshot.depositRequired || amount > 0,
      depositAmountDue: Number.isFinite(amount) ? amount : 0
    };
  }
  return parseDepositMetaFromNotes(reservation?.notes);
}

function reservationSecurityDepositMeta(reservation) {
  const snapshot = reservation?.pricingSnapshot;
  if (snapshot) {
    const amount = Number(snapshot.securityDepositAmount || 0);
    return {
      requireSecurityDeposit: !!snapshot.securityDepositRequired || amount > 0,
      securityDepositAmount: Number.isFinite(amount) ? amount : 0
    };
  }
  return parseSecurityDepositMetaFromNotes(reservation?.notes);
}

async function importStructuredReservationPaymentsToAgreement(rentalAgreementId, reservationPayments = []) {
  const pending = (Array.isArray(reservationPayments) ? reservationPayments : []).filter((payment) => !payment?.rentalAgreementPaymentId);
  if (!pending.length) {
    const agreement = await prisma.rentalAgreement.findUnique({
      where: { id: rentalAgreementId },
      select: { paidAmount: true, total: true, balance: true }
    });
    return {
      importedCount: 0,
      paidAmount: Number(agreement?.paidAmount || 0),
      balance: Number(agreement?.balance || 0)
    };
  }

  let importedPaid = 0;
  for (const payment of pending) {
    const created = await prisma.rentalAgreementPayment.create({
      data: {
        rentalAgreementId,
        method: payment.method || 'OTHER',
        amount: Number(payment.amount || 0),
        reference: payment.reference || null,
        status: payment.status || 'PAID',
        paidAt: payment.paidAt || new Date(),
        notes: payment.notes || null
      }
    });

    await prisma.reservationPayment.update({
      where: { id: payment.id },
      data: { rentalAgreementPaymentId: created.id }
    });

    if (String(payment.status || 'PAID').toUpperCase() === 'PAID') {
      importedPaid += Number(payment.amount || 0);
    }
  }

  const agreement = await prisma.rentalAgreement.findUnique({
    where: { id: rentalAgreementId },
    select: { total: true, paidAmount: true }
  });
  const paidAmount = Number((Number(agreement?.paidAmount || 0) + importedPaid).toFixed(2));
  const balance = Number((Number(agreement?.total || 0) - paidAmount).toFixed(2));
  await prisma.rentalAgreement.update({
    where: { id: rentalAgreementId },
    data: { paidAmount, balance }
  });

  return { importedCount: pending.length, paidAmount, balance };
}

async function syncAgreementCommissionSnapshot(rentalAgreementId) {
  const agreement = await prisma.rentalAgreement.findUnique({
    where: { id: rentalAgreementId },
    select: {
      id: true,
      tenantId: true,
      status: true,
      closedAt: true,
      total: true,
      salesOwnerUserId: true,
      inspections: {
        where: { phase: 'CHECKOUT' },
        orderBy: [{ capturedAt: 'desc' }, { updatedAt: 'desc' }],
        select: {
          actorUserId: true
        }
      },
      charges: {
        orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
        select: {
          id: true,
          code: true,
          name: true,
          chargeType: true,
          quantity: true,
          total: true,
          selected: true,
          source: true,
          sourceRefId: true
        }
      }
    }
  });
  if (!agreement) throw new Error('Rental agreement not found');
  if (String(agreement.status || '').toUpperCase() !== 'CLOSED') return null;

  const commissionEmployeeUserId = String(
    agreement?.inspections?.find((row) => row?.actorUserId)?.actorUserId
    || agreement.salesOwnerUserId
    || ''
  ).trim();
  if (!commissionEmployeeUserId) return null;

  const commissionEmployee = await prisma.user.findFirst({
    where: {
      id: commissionEmployeeUserId,
      ...(agreement.tenantId ? { tenantId: agreement.tenantId } : {})
    },
    select: {
      id: true,
      commissionPlanId: true,
      commissionPlan: {
        include: {
          rules: {
            where: { isActive: true },
            orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }]
          }
        }
      }
    }
  });
  if (!commissionEmployee) return null;

  const serviceIds = Array.from(new Set(
    (agreement.charges || [])
      .filter((charge) => String(charge?.source || '').toUpperCase() === 'ADDITIONAL_SERVICE' && charge?.sourceRefId)
      .map((charge) => String(charge.sourceRefId))
      .filter(Boolean)
  ));
  const serviceRows = serviceIds.length
    ? await prisma.additionalService.findMany({
        where: { id: { in: serviceIds } },
        select: {
          id: true,
          name: true,
          commissionValueType: true,
          commissionPercentValue: true,
          commissionFixedAmount: true
        }
      })
    : [];
  const servicesById = new Map(serviceRows.map((row) => [row.id, row]));
  const insurancePlans = await settingsService.getInsurancePlans({ tenantId: agreement.tenantId || null });
  const insurancePlansByCode = new Map(
    (Array.isArray(insurancePlans) ? insurancePlans : [])
      .filter((plan) => plan?.code)
      .map((plan) => [String(plan.code).trim().toUpperCase(), plan])
  );

  const employeePlan = commissionEmployee?.commissionPlan?.isActive ? commissionEmployee.commissionPlan : null;
  const tenantPlan = employeePlan
    ? null
    : await prisma.commissionPlan.findFirst({
        where: {
          tenantId: agreement.tenantId || null,
          isActive: true
        },
        include: {
          rules: {
            where: { isActive: true },
            orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }]
          }
        },
        orderBy: { createdAt: 'asc' }
      });
  const plan = employeePlan || tenantPlan;

  const appliedFixedAgreementRules = new Set();
  const eligibleCharges = commissionChargeRows(agreement.charges);
  const lines = eligibleCharges
    .map((charge) => {
      const rule = resolveCommissionRule(charge, plan?.rules || [], servicesById, insurancePlansByCode);
      const calc = calculateCommissionLine({ charge, rule, plan, appliedFixedAgreementRules });
      return {
        rentalAgreementChargeId: charge.id,
        serviceId: String(charge?.source || '').toUpperCase() === 'ADDITIONAL_SERVICE' && charge?.sourceRefId
          ? String(charge.sourceRefId)
          : null,
        ...calc
      };
    })
    .filter((line) => line.valueType);

  const grossRevenue = roundMoney(agreement.total || 0);
  const serviceRevenue = roundMoney(
    eligibleCharges
      .filter((charge) => String(charge?.source || '').toUpperCase() === 'ADDITIONAL_SERVICE')
      .reduce((sum, charge) => sum + Number(charge?.total || 0), 0)
  );
  const eligibleRevenue = roundMoney(lines.reduce((sum, line) => sum + Number(line.lineRevenue || 0), 0));
  const commissionAmount = roundMoney(lines.reduce((sum, line) => sum + Number(line.commissionAmount || 0), 0));

  await prisma.agreementCommission.deleteMany({
    where: {
      rentalAgreementId: agreement.id,
      employeeUserId: { not: commissionEmployeeUserId }
    }
  });

  const snapshot = await prisma.agreementCommission.upsert({
    where: {
      rentalAgreementId_employeeUserId: {
        rentalAgreementId: agreement.id,
        employeeUserId: commissionEmployeeUserId
      }
    },
    update: {
      tenantId: agreement.tenantId || null,
      commissionPlanId: plan?.id || null,
      status: 'PENDING',
      monthKey: monthKey(agreement.closedAt || new Date()),
      grossRevenue,
      serviceRevenue,
      eligibleRevenue,
      commissionAmount,
      calculatedAt: new Date()
    },
    create: {
      tenantId: agreement.tenantId || null,
      rentalAgreementId: agreement.id,
      employeeUserId: commissionEmployeeUserId,
      commissionPlanId: plan?.id || null,
      status: 'PENDING',
      monthKey: monthKey(agreement.closedAt || new Date()),
      grossRevenue,
      serviceRevenue,
      eligibleRevenue,
      commissionAmount,
      calculatedAt: new Date()
    }
  });

  await prisma.agreementCommissionLine.deleteMany({
    where: { agreementCommissionId: snapshot.id }
  });

  if (lines.length) {
    await prisma.agreementCommissionLine.createMany({
      data: lines.map((line) => ({
        agreementCommissionId: snapshot.id,
        rentalAgreementChargeId: line.rentalAgreementChargeId || null,
        serviceId: line.serviceId || null,
        description: line.description,
        quantity: line.quantity,
        lineRevenue: line.lineRevenue,
        valueType: line.valueType,
        percentValue: line.percentValue,
        fixedAmount: line.fixedAmount,
        commissionAmount: line.commissionAmount
      }))
    });
  }

  return snapshot;
}

async function syncAgreementAdditionalDrivers(rentalAgreementId, reservation) {
  const additionalDrivers = reservationAdditionalDrivers(reservation);
  await prisma.agreementDriver.deleteMany({
    where: {
      rentalAgreementId,
      isPrimary: false
    }
  });

  const rows = additionalDrivers
    .map((driver) => ({
      rentalAgreementId,
      firstName: String(driver?.firstName || '').trim(),
      lastName: String(driver?.lastName || '').trim(),
      licenseNumber: driver?.licenseNumber ? String(driver.licenseNumber).trim() : null,
      dateOfBirth: driver?.dateOfBirth ? new Date(driver.dateOfBirth) : null,
      isPrimary: false
    }))
    .filter((driver) => driver.firstName && driver.lastName);

  if (rows.length) {
    await prisma.agreementDriver.createMany({ data: rows });
  }

  return rows.length;
}

function normalizeInspectionRow(row) {
  if (!row) return null;
  let photos = {};
  try {
    photos = row.photosJson ? JSON.parse(row.photosJson) : {};
  } catch {
    photos = {};
  }
  return {
    phase: row.phase,
    at: row.capturedAt,
    ip: row.actorIp || null,
    actorUserId: row.actorUserId || null,
    exterior: row.exterior || null,
    interior: row.interior || null,
    tires: row.tires || null,
    lights: row.lights || null,
    windshield: row.windshield || null,
    fuelLevel: row.fuelLevel || null,
    odometer: row.odometer ?? null,
    damages: row.damages || null,
    notes: row.notes || null,
    photos
  };
}

function inspectionReportFromAgreement(agreement) {
  const structured = Array.isArray(agreement?.inspections) ? agreement.inspections : [];
  const checkout = structured.find((row) => String(row.phase || '').toUpperCase() === 'CHECKOUT') || null;
  const checkin = structured.find((row) => String(row.phase || '').toUpperCase() === 'CHECKIN') || null;
  return {
    checkout: normalizeInspectionRow(checkout),
    checkin: normalizeInspectionRow(checkin)
  };
}

export const rentalAgreementsService = {
  async resolveLatestAgreementId(id, scope = null) {
    const current = await prisma.rentalAgreement.findFirst({ where: { id, ...(scope?.tenantId ? { tenantId: scope.tenantId } : {}) }, select: { id: true, reservationId: true } });
    if (!current) throw new Error('Rental agreement not found');
    const latest = await prisma.rentalAgreement.findFirst({ where: { reservationId: current.reservationId, ...(scope?.tenantId ? { tenantId: scope.tenantId } : {}) }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], select: { id: true } });
    return latest?.id || current.id;
  },

  list(scope = null) {
    return prisma.rentalAgreement.findMany({
    where: scope?.tenantId ? { tenantId: scope.tenantId } : undefined,
      orderBy: { createdAt: 'desc' },
      include: {
        reservation: { include: { customer: true, vehicle: true, vehicleType: true } },
        drivers: true,
        charges: true,
        payments: true
      }
    });
  },

  async startFromReservation(reservationId, scope = null) {
    const reservation = await prisma.reservation.findFirst({
      where: { id: reservationId, ...(scope?.tenantId ? { tenantId: scope.tenantId } : {}) },
      include: {
        customer: true,
        pickupLocation: true,
        pricingSnapshot: true,
        charges: { where: { selected: true }, orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] },
        payments: { orderBy: { paidAt: 'asc' } },
        additionalDrivers: { orderBy: { createdAt: 'asc' } }
      }
    });

    if (!reservation) throw new Error('Reservation not found');
    if (reservation.status === 'CANCELLED' || reservation.status === 'NO_SHOW') {
      throw new Error('Cannot start rental for cancelled/no-show reservation');
    }

    const existing = await prisma.rentalAgreement.findUnique({ where: { reservationId } });
    if (existing) {
      // Keep agreement charges synced from reservation charge metadata whenever start-rental is invoked.
      // This guarantees reservation->agreement parity for checkout flow.
      const structuredRows = structuredReservationChargeRows(reservation);
      const structuredPaymentsList = structuredReservationPayments(reservation);
      if (existing.status !== 'CLOSED' && existing.status !== 'CANCELLED') {
        await syncAgreementAdditionalDrivers(existing.id, reservation);
        let paid = Number(existing.paidAmount || 0);
        if (structuredPaymentsList.length) {
          const paymentSync = await importStructuredReservationPaymentsToAgreement(existing.id, structuredPaymentsList);
          paid = Number(paymentSync.paidAmount || 0);
        }

        if (structuredRows?.length) {
          const normalizedRows = structuredRows.map((row) => ({
            rentalAgreementId: existing.id,
            code: row.code,
            name: row.name,
            chargeType: row.chargeType,
            quantity: row.quantity,
            rate: row.rate,
            total: row.total,
            taxable: row.taxable,
            selected: row.selected,
            sortOrder: row.sortOrder
          }));
          const { subtotal, taxes, total } = structuredReservationTotals(normalizedRows);

          await prisma.rentalAgreementCharge.deleteMany({ where: { rentalAgreementId: existing.id } });
          await prisma.rentalAgreementCharge.createMany({ data: normalizedRows });

          await prisma.rentalAgreement.update({
            where: { id: existing.id },
            data: {
              notes: reservation.notes,
              subtotal,
              taxes,
              total,
              balance: Number((total - paid).toFixed(2))
            }
          });
          return this.getById(existing.id);
        }

        const meta = parseReservationChargesMeta(reservation.notes) || {};
        const tenantWhere = reservation.tenantId ? { tenantId: reservation.tenantId } : {};
        const selectedServiceIds = Array.isArray(meta?.selectedServices) ? meta.selectedServices : [];
        const selectedFeeIds = Array.isArray(meta?.selectedFees) ? meta.selectedFees : [];
        const discounts = Array.isArray(meta?.discounts) ? meta.discounts : [];

        // Always include auto fees computed on reservation side (underage/additional-driver) even if not in meta.
        const underageFromNotes = /UNDERAGE ALERT/i.test(String(reservation.notes || ''));
        if (reservation.underageAlert || underageFromNotes) {
          const autoUnderage = await prisma.fee.findMany({ where: { ...tenantWhere, isActive: true, isUnderageFee: true }, select: { id: true } });
          selectedFeeIds.push(...autoUnderage.map((x) => x.id));
        }
        if (reservationAdditionalDrivers(reservation).length > 0) {
          const autoAddl = await prisma.fee.findMany({ where: { ...tenantWhere, isActive: true, isAdditionalDriverFee: true }, select: { id: true } });
          selectedFeeIds.push(...autoAddl.map((x) => x.id));
        }
        selectedFeeIds.push(...await listMandatoryLocationFeeIds(reservation, tenantWhere));

        const uniqueSelectedFeeIds = [...new Set(selectedFeeIds)];

        const days = rentalDays(reservation.pickupAt, reservation.returnAt);
        const dailyRate = Number(reservation?.pricingSnapshot?.dailyRate ?? reservation.dailyRate ?? 0);
        const services = selectedServiceIds.length
          ? await prisma.additionalService.findMany({ where: { ...tenantWhere, id: { in: selectedServiceIds } } })
          : [];
        const fees = uniqueSelectedFeeIds.length
          ? await prisma.fee.findMany({ where: { ...tenantWhere, id: { in: uniqueSelectedFeeIds } } })
          : [];

        const incomingRows = Array.isArray(meta?.chargeRows) ? meta.chargeRows : null;
        if (incomingRows && incomingRows.length) {
          const normalizedRows = incomingRows.map((r) => ({
            name: String(r?.name || 'Line Item'),
            source: r?.source || null,
            chargeType: String(r?.chargeType || 'UNIT').toUpperCase(),
            quantity: Number(r?.quantity || 1),
            rate: Number(r?.rate || 0),
            total: Number(r?.total != null ? r.total : (Number(r?.quantity || 1) * Number(r?.rate || 0))),
            taxable: !!r?.taxable,
          }));
          const { subtotal, taxes, total } = structuredReservationTotals(normalizedRows);

          await prisma.rentalAgreementCharge.deleteMany({ where: { rentalAgreementId: existing.id } });
          await prisma.rentalAgreementCharge.createMany({
            data: normalizedRows.map((r, idx) => ({
              rentalAgreementId: existing.id,
              code: r.code || null,
              name: r.name,
              chargeType: r.chargeType,
              quantity: r.quantity,
              rate: r.rate,
              total: r.total,
              taxable: r.taxable,
              selected: true,
              sortOrder: idx,
              source: r.source || null
            }))
          });

          await prisma.rentalAgreement.update({ where: { id: existing.id }, data: { notes: reservation.notes, subtotal, taxes, total, balance: Number((total - paid).toFixed(2)) } });
          return this.getById(existing.id);
        }

        const chargeRows = [];
        const base = dailyRate * days;
        chargeRows.push({ rentalAgreementId: existing.id, name: 'Daily', chargeType: 'DAILY', quantity: days, rate: dailyRate, total: base, taxable: true, selected: true, sortOrder: 0 });

        let servicesTotal = 0;
        services.forEach((s) => {
          const qty = Number(s.defaultQty || 1) || 1;
          const perDay = Number(s.dailyRate || 0);
          const rate = perDay > 0 ? perDay : Number(s.rate || 0);
          const lineTotal = perDay > 0 ? perDay * days * qty : Number(s.rate || 0) * qty;
          servicesTotal += lineTotal;
          chargeRows.push({
            rentalAgreementId: existing.id,
            name: s.name,
            chargeType: 'UNIT',
            quantity: qty,
            rate,
            total: lineTotal,
            taxable: !!s.taxable,
            selected: true,
            sortOrder: chargeRows.length,
            source: 'ADDITIONAL_SERVICE',
            sourceRefId: s.id
          });
        });

        let feesTotal = 0;
        fees.forEach((f) => {
          const amt = Number(f.amount || 0);
          const mode = String(f.mode || 'FIXED').toUpperCase();
          const lineTotal = mode === 'PERCENTAGE' ? ((base + servicesTotal) * (amt / 100)) : mode === 'PER_DAY' ? (amt * days) : amt;
          feesTotal += lineTotal;
          chargeRows.push({ rentalAgreementId: existing.id, name: f.name, chargeType: 'UNIT', quantity: 1, rate: mode === 'PERCENTAGE' ? amt : lineTotal, total: lineTotal, taxable: !!f.taxable, selected: true, sortOrder: chargeRows.length });
        });

        const depositMeta = reservationDepositMeta(reservation);
        const depositAmount = depositMeta.requireDeposit ? Number(depositMeta.depositAmountDue || 0) : 0;
        if (depositAmount > 0) {
          feesTotal += depositAmount;
          chargeRows.push({ rentalAgreementId: existing.id, name: 'Deposit Due', chargeType: 'DEPOSIT', quantity: 1, rate: depositAmount, total: depositAmount, taxable: false, selected: true, sortOrder: chargeRows.length, source: 'DEPOSIT_DUE' });
        }

        let securityDepositAmount = 0;
        const secMeta = reservationSecurityDepositMeta(reservation);
        if (secMeta.requireSecurityDeposit) {
          securityDepositAmount = Number(secMeta.securityDepositAmount || 0);
        }
        if (!(securityDepositAmount > 0)) {
          try {
            const cfg = reservation.pickupLocation?.locationConfig ? JSON.parse(reservation.pickupLocation.locationConfig) : {};
            if (cfg?.requireSecurityDeposit) securityDepositAmount = Number(cfg?.securityDepositAmount || 0);
          } catch {}
        }
        if (securityDepositAmount > 0) {
          chargeRows.push({ rentalAgreementId: existing.id, name: 'Security Deposit', chargeType: 'DEPOSIT', quantity: 1, rate: securityDepositAmount, total: securityDepositAmount, taxable: false, selected: true, sortOrder: chargeRows.length, source: 'SECURITY_DEPOSIT' });
        }

        const discountTotal = discounts.reduce((sum, d) => {
          const mode = String(d?.mode || 'FIXED').toUpperCase();
          const val = Number(d?.value || 0);
          if (!Number.isFinite(val) || val <= 0) return sum;
          if (mode === 'PERCENTAGE') return sum + ((base + servicesTotal + feesTotal) * (val / 100));
          return sum + val;
        }, 0);

        const subtotal = Math.max(0, base + servicesTotal + feesTotal - discountTotal);
        const taxRate = Number(reservation?.pricingSnapshot?.taxRate ?? meta?.taxRate ?? reservation.pickupLocation?.taxRate ?? 0);
        const taxes = subtotal * (taxRate / 100);
        const total = subtotal + taxes;

        if (discountTotal > 0) {
          chargeRows.push({ rentalAgreementId: existing.id, name: 'Discount', chargeType: 'UNIT', quantity: 1, rate: -discountTotal, total: -discountTotal, taxable: false, selected: true, sortOrder: chargeRows.length });
        }
        chargeRows.push({ rentalAgreementId: existing.id, name: `Tax (${taxRate.toFixed(2)}%)`, chargeType: 'TAX', quantity: 1, rate: taxes, total: taxes, taxable: false, selected: true, sortOrder: chargeRows.length });

        await prisma.rentalAgreementCharge.deleteMany({ where: { rentalAgreementId: existing.id } });
        await prisma.rentalAgreementCharge.createMany({ data: chargeRows });

        await prisma.rentalAgreement.update({
          where: { id: existing.id },
          data: {
            tenantId: existing.tenantId || reservation.tenantId || null,
            notes: reservation.notes,
            subtotal,
            taxes,
            total,
            balance: Number((total - paid).toFixed(2))
          }
        });
      }
      return this.getById(existing.id);
    }

    let agreement;
    try {
      agreement = await prisma.rentalAgreement.create({
        data: {
          tenantId: reservation.tenantId || null,
          agreementNumber: agreementNumber(),
          reservationId,
          vehicleId: reservation.vehicleId ?? null,
          pickupAt: reservation.pickupAt,
          returnAt: reservation.returnAt,
          pickupLocationId: reservation.pickupLocationId,
          returnLocationId: reservation.returnLocationId,
          customerFirstName: reservation.customer.firstName,
          customerLastName: reservation.customer.lastName,
          customerEmail: reservation.customer.email,
          customerPhone: reservation.customer.phone,
          dateOfBirth: reservation.customer.dateOfBirth,
          licenseNumber: reservation.customer.licenseNumber,
          licenseState: reservation.customer.licenseState,
          insuranceSource: reservation.customer.insurancePolicyNumber ? 'THEIRS' : null,
          insurancePolicyNumber: reservation.customer.insurancePolicyNumber,
          insuranceDocumentUrl: reservation.customer.insuranceDocumentUrl,
          insurancePlanCode: null,
          insurancePlanName: null,
          insurancePlanRate: null,
          notes: reservation.notes
        }
      });
    } catch (e) {
      if (String(e?.code || '') === 'P2002') {
        const existingAfterRace = await prisma.rentalAgreement.findUnique({ where: { reservationId } });
        if (existingAfterRace) return this.getById(existingAfterRace.id);
      }
      throw e;
    }

    await prisma.agreementDriver.create({
      data: {
        rentalAgreementId: agreement.id,
        firstName: reservation.customer.firstName,
        lastName: reservation.customer.lastName,
        email: reservation.customer.email,
        phone: reservation.customer.phone,
        licenseNumber: reservation.customer.licenseNumber,
        licenseState: reservation.customer.licenseState,
        dateOfBirth: reservation.customer.dateOfBirth,
        isPrimary: true
      }
    });

    await syncAgreementAdditionalDrivers(agreement.id, reservation);

    // Import any customer payments made before agreement creation
    const structuredPrePayments = structuredReservationPayments(reservation);
    const prePayments = structuredPrePayments.length ? structuredPrePayments : parseReservationPaymentsFromNotes(reservation.notes);
    const prePaidTotal = prePayments.reduce((sum, p) => sum + Number(p.amount || 0), 0);

    const days = rentalDays(reservation.pickupAt, reservation.returnAt);
    const dailyRate = Number(reservation?.pricingSnapshot?.dailyRate ?? reservation.dailyRate ?? 0);
    const tenantWhere = reservation.tenantId ? { tenantId: reservation.tenantId } : {};

    const structuredRows = structuredReservationChargeRows(reservation);
    const meta = structuredRows?.length ? null : (parseReservationChargesMeta(reservation.notes) || {});
    const incomingRows = structuredRows?.length ? structuredRows : (Array.isArray(meta?.chargeRows) ? meta.chargeRows : null);
    if (incomingRows && incomingRows.length) {
      const normalizedRows = incomingRows.map((r) => ({
        name: String(r?.name || 'Line Item'),
        code: r?.code || null,
        source: r?.source || null,
        chargeType: String(r?.chargeType || 'UNIT').toUpperCase(),
        quantity: Number(r?.quantity || 1),
        rate: Number(r?.rate || 0),
        total: Number(r?.total != null ? r.total : (Number(r?.quantity || 1) * Number(r?.rate || 0))),
        taxable: !!r?.taxable,
      }));
      const { subtotal, taxes, total } = structuredReservationTotals(normalizedRows);

      await prisma.rentalAgreementCharge.createMany({
        data: normalizedRows.map((r, idx) => ({
          rentalAgreementId: agreement.id,
          code: r.code || null,
          name: r.name,
          chargeType: r.chargeType,
          quantity: r.quantity,
          rate: r.rate,
          total: r.total,
          taxable: r.taxable,
          selected: true,
          sortOrder: idx,
          source: r.source || null
        }))
      });

      if (prePayments.length) {
        if (structuredPrePayments.length) {
          await importStructuredReservationPaymentsToAgreement(agreement.id, structuredPrePayments);
        } else {
          await prisma.rentalAgreementPayment.createMany({
            data: prePayments.map((p) => ({
              rentalAgreementId: agreement.id,
              method: 'CARD',
              amount: Number(p.amount),
              reference: p.reference || null,
              status: 'PAID',
              paidAt: p.paidAt,
              notes: p.notes
            }))
          });
        }
      }

      await prisma.rentalAgreement.update({
        where: { id: agreement.id },
        data: {
          total,
          subtotal,
          taxes,
          paidAmount: Number(prePaidTotal.toFixed(2)),
          balance: Number((total - prePaidTotal).toFixed(2))
        }
      });

      return prisma.rentalAgreement.findUnique({
        where: { id: agreement.id },
        include: {
          drivers: true,
          charges: true,
          payments: true,
          reservation: {
            include: {
              customer: true,
              vehicle: true,
              pickupLocation: true,
              returnLocation: true
            }
          }
        }
      });
    }

    const selectedServiceIds = Array.isArray(meta?.selectedServices) ? meta.selectedServices : [];
    const selectedFeeIds = Array.isArray(meta?.selectedFees) ? meta.selectedFees : [];
    const discounts = Array.isArray(meta?.discounts) ? meta.discounts : [];

    // Always include auto fees computed on reservation side (underage/additional-driver) even if not in meta.
    const underageFromNotes = /UNDERAGE ALERT/i.test(String(reservation.notes || ''));
    if (reservation.underageAlert || underageFromNotes) {
      const autoUnderage = await prisma.fee.findMany({ where: { ...tenantWhere, isActive: true, isUnderageFee: true }, select: { id: true } });
      selectedFeeIds.push(...autoUnderage.map((x) => x.id));
    }
    if (reservationAdditionalDrivers(reservation).length > 0) {
      const autoAddl = await prisma.fee.findMany({ where: { ...tenantWhere, isActive: true, isAdditionalDriverFee: true }, select: { id: true } });
      selectedFeeIds.push(...autoAddl.map((x) => x.id));
    }
    selectedFeeIds.push(...await listMandatoryLocationFeeIds(reservation, tenantWhere));
    const uniqueSelectedFeeIds = [...new Set(selectedFeeIds)];

    const services = selectedServiceIds.length
      ? await prisma.additionalService.findMany({ where: { ...tenantWhere, id: { in: selectedServiceIds } } })
      : [];
    const fees = uniqueSelectedFeeIds.length
      ? await prisma.fee.findMany({ where: { ...tenantWhere, id: { in: uniqueSelectedFeeIds } } })
      : [];

    const chargeRows = [];
    const base = dailyRate * days;
    chargeRows.push({
      rentalAgreementId: agreement.id,
      name: 'Daily',
      chargeType: 'DAILY',
      quantity: days,
      rate: dailyRate,
      total: base,
      taxable: true,
      selected: true,
      sortOrder: 0
    });

    let servicesTotal = 0;
    services.forEach((s, idx) => {
      const qty = Number(s.defaultQty || 1) || 1;
      const perDay = Number(s.dailyRate || 0);
      const rate = perDay > 0 ? perDay : Number(s.rate || 0);
      const lineTotal = perDay > 0 ? perDay * days * qty : Number(s.rate || 0) * qty;
      servicesTotal += lineTotal;
      chargeRows.push({
        rentalAgreementId: agreement.id,
        name: s.name,
        chargeType: 'UNIT',
        quantity: qty,
        rate,
        total: lineTotal,
        taxable: !!s.taxable,
        selected: true,
        sortOrder: chargeRows.length,
        source: 'ADDITIONAL_SERVICE',
        sourceRefId: s.id
      });
    });

    let feesTotal = 0;
    fees.forEach((f) => {
      const amt = Number(f.amount || 0);
      const mode = String(f.mode || 'FIXED').toUpperCase();
      const lineTotal = mode === 'PERCENTAGE' ? ((base + servicesTotal) * (amt / 100)) : mode === 'PER_DAY' ? (amt * days) : amt;
      feesTotal += lineTotal;
      chargeRows.push({
        rentalAgreementId: agreement.id,
        name: f.name,
        chargeType: 'UNIT',
        quantity: 1,
        rate: mode === 'PERCENTAGE' ? amt : lineTotal,
        total: lineTotal,
        taxable: !!f.taxable,
        selected: true,
        sortOrder: chargeRows.length
      });
    });

    const depositMeta = reservationDepositMeta(reservation);
    const depositAmount = depositMeta.requireDeposit ? Number(depositMeta.depositAmountDue || 0) : 0;
    if (depositAmount > 0) {
      feesTotal += depositAmount;
      chargeRows.push({
        rentalAgreementId: agreement.id,
        name: 'Deposit Due',
        chargeType: 'DEPOSIT',
        quantity: 1,
        rate: depositAmount,
        total: depositAmount,
        taxable: false,
        selected: true,
        sortOrder: chargeRows.length,
        source: 'DEPOSIT_DUE'
      });
    }

    let securityDepositAmount = 0;
    const secMeta = reservationSecurityDepositMeta(reservation);
    if (secMeta.requireSecurityDeposit) {
      securityDepositAmount = Number(secMeta.securityDepositAmount || 0);
    }
    if (!(securityDepositAmount > 0)) {
      try {
        const cfg = reservation.pickupLocation?.locationConfig ? JSON.parse(reservation.pickupLocation.locationConfig) : {};
        if (cfg?.requireSecurityDeposit) securityDepositAmount = Number(cfg?.securityDepositAmount || 0);
      } catch {}
    }
    if (securityDepositAmount > 0) {
      chargeRows.push({
        rentalAgreementId: agreement.id,
        name: 'Security Deposit',
        chargeType: 'DEPOSIT',
        quantity: 1,
        rate: securityDepositAmount,
        total: securityDepositAmount,
        taxable: false,
        selected: true,
        sortOrder: chargeRows.length,
        source: 'SECURITY_DEPOSIT'
      });
    }

    const discountTotal = discounts.reduce((sum, d) => {
      const mode = String(d?.mode || 'FIXED').toUpperCase();
      const val = Number(d?.value || 0);
      if (!Number.isFinite(val) || val <= 0) return sum;
      if (mode === 'PERCENTAGE') return sum + ((base + servicesTotal + feesTotal) * (val / 100));
      return sum + val;
    }, 0);

    const subtotal = Math.max(0, base + servicesTotal + feesTotal - discountTotal);
    const taxRate = Number(reservation?.pricingSnapshot?.taxRate ?? meta?.taxRate ?? reservation.pickupLocation?.taxRate ?? 0);
    const taxes = subtotal * (taxRate / 100);
    const total = subtotal + taxes;

    if (discountTotal > 0) {
      chargeRows.push({
        rentalAgreementId: agreement.id,
        name: 'Discount',
        chargeType: 'UNIT',
        quantity: 1,
        rate: -discountTotal,
        total: -discountTotal,
        taxable: false,
        selected: true,
        sortOrder: chargeRows.length
      });
    }

    chargeRows.push({
      rentalAgreementId: agreement.id,
      name: `Tax (${taxRate.toFixed(2)}%)`,
      chargeType: 'TAX',
      quantity: 1,
      rate: taxes,
      total: taxes,
      taxable: false,
      selected: true,
      sortOrder: chargeRows.length
    });

    await prisma.rentalAgreementCharge.createMany({ data: chargeRows });

    if (prePayments.length) {
      if (structuredPrePayments.length) {
        await importStructuredReservationPaymentsToAgreement(agreement.id, structuredPrePayments);
      } else {
        await prisma.rentalAgreementPayment.createMany({
          data: prePayments.map((p) => ({
            rentalAgreementId: agreement.id,
            method: 'CARD',
            amount: Number(p.amount),
            reference: p.reference || null,
            status: 'PAID',
            paidAt: p.paidAt,
            notes: p.notes
          }))
        });
      }
    }

    await prisma.rentalAgreement.update({
      where: { id: agreement.id },
      data: {
        total,
        subtotal,
        taxes,
        paidAmount: Number(prePaidTotal.toFixed(2)),
        balance: Number((total - prePaidTotal).toFixed(2))
      }
    });

    return prisma.rentalAgreement.findUnique({
      where: { id: agreement.id },
      include: {
        drivers: true,
        charges: true,
        payments: true,
        reservation: {
          include: {
            customer: true,
            vehicle: true,
            vehicleType: true,
            pickupLocation: true,
            returnLocation: true
          }
        }
      }
    });
  },

  getById(id, scope = null) {
    return prisma.rentalAgreement.findFirst({
    where: { id, ...(scope?.tenantId ? { tenantId: scope.tenantId } : {}) },
      include: {
        reservation: {
          include: {
            customer: true,
            vehicle: true,
            vehicleType: true,
            pickupLocation: true,
            returnLocation: true,
            pricingSnapshot: true,
            payments: { orderBy: { paidAt: 'desc' } },
            additionalDrivers: { orderBy: { createdAt: 'asc' } }
          }
        },
        drivers: true,
        charges: { orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] },
        payments: { orderBy: { paidAt: 'desc' } },
        inspections: { orderBy: { createdAt: 'asc' } }
      }
    });
  },

  async agreementPrintContext(id) {
    const latestId = await this.resolveLatestAgreementId(id);
    const agreement = await this.getById(latestId);
    if (!agreement) throw new Error('Rental agreement not found');

    const { settingsService } = await import('../settings/settings.service.js');
    const agreementScope = agreement?.tenantId ? { tenantId: agreement.tenantId } : {};
    const globalCfg = await settingsService.getRentalAgreementConfig(agreementScope);
    const locCfg = parseLocationConfig(agreement?.reservation?.pickupLocation?.locationConfig);
    const cfg = {
      ...globalCfg,
      companyName: locCfg.companyName || agreement?.reservation?.pickupLocation?.name || globalCfg.companyName,
      companyAddress: locCfg.companyAddress || agreement?.reservation?.pickupLocation?.address1 || globalCfg.companyAddress,
      companyPhone: locCfg.companyPhone || agreement?.reservation?.pickupLocation?.phone || globalCfg.companyPhone,
      termsText: locCfg.termsText || globalCfg.termsText,
      returnInstructionsText: locCfg.returnInstructionsText || globalCfg.returnInstructionsText
    };

    const sigLog = await prisma.auditLog.findFirst({
      where: { reservationId: agreement.reservationId, action: 'UPDATE', reason: { contains: 'Agreement signed' } },
      orderBy: { createdAt: 'desc' }
    });

    let signatureIp = '-';
    try {
      const m = sigLog?.metadata ? JSON.parse(sigLog.metadata) : null;
      signatureIp = m?.ip || '-';
    } catch {}

    const signatureTime = agreement?.reservation?.signatureSignedAt || sigLog?.createdAt || null;

    const dbPayments = Array.isArray(agreement?.payments) ? agreement.payments : [];
    const structuredReservationPrintPayments = structuredReservationPayments(agreement?.reservation).map((payment, idx) => ({
      id: payment.id || `reservation-${idx}`,
      paidAt: payment.paidAt,
      method: payment.method || 'OTHER',
      reference: payment.reference || null,
      status: payment.status || 'PAID',
      amount: Number(payment.amount || 0)
    }));
    const legacyReservationPrintPayments = structuredReservationPrintPayments.length
      ? []
      : parseReservationPaymentsFromNotes(agreement?.reservation?.notes).map((p, idx) => ({
      id: `note-${idx}-${Number(p.amount || 0).toFixed(2)}-${String(p.reference || '')}`,
      paidAt: p.paidAt,
      method: 'OTC',
      reference: p.reference,
      status: 'SETTLED',
      amount: Number(p.amount || 0)
    }));

    const seen = new Set();
    const paymentsForPrint = [...dbPayments, ...structuredReservationPrintPayments, ...legacyReservationPrintPayments].filter((p) => {
      const k = `${new Date(p.paidAt || p.createdAt || Date.now()).toISOString().slice(0,19)}|${Number(p.amount || 0).toFixed(2)}|${String(p.reference || '').trim()}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    }).sort((a, b) => Number(new Date(b.paidAt || b.createdAt || 0)) - Number(new Date(a.paidAt || a.createdAt || 0)));

    const paidAmountForPrint = Number(paymentsForPrint.reduce((s, p) => s + Number(p.amount || 0), 0).toFixed(2));
    const amountDueForPrint = Number((Number(agreement?.total || 0) - paidAmountForPrint).toFixed(2));

    return { agreement, cfg, signatureIp, signatureTime, paymentsForPrint, paidAmountForPrint, amountDueForPrint };
  },

  async renderAgreementHtml(id) {
    const { agreement, cfg, signatureIp, signatureTime, paymentsForPrint, paidAmountForPrint, amountDueForPrint } = await this.agreementPrintContext(id);
    const chargesRows = (agreement.charges || []).map((c) => `<tr><td>${esc(c.name)}</td><td>${Number(c.quantity || 0).toFixed(2)}</td><td>$${Number(c.rate || 0).toFixed(2)}</td><td>$${Number(c.total || 0).toFixed(2)}</td></tr>`).join('');
    const paymentsRows = (paymentsForPrint || []).map((p) => `<tr><td>${esc(fmtDate(p.paidAt || p.createdAt))}</td><td>${esc(p.method || '-')}</td><td>${esc(p.reference || '-')}</td><td>${esc(String(p.status || '-'))}</td><td>$${Number(p.amount || 0).toFixed(2)}</td></tr>`).join('');

    if (String(cfg?.agreementHtmlTemplate || '').trim()) {
      return applyTemplate(cfg.agreementHtmlTemplate, {
        companyName: esc(cfg.companyName || ''),
        companyAddress: esc(cfg.companyAddress || ''),
        companyPhone: esc(cfg.companyPhone || ''),
        agreementNumber: esc(agreement.agreementNumber || ''),
        reservationNumber: esc(agreement.reservation?.reservationNumber || '-'),
        customerName: esc(`${agreement.customerFirstName || ''} ${agreement.customerLastName || ''}`.trim()),
        pickupAt: esc(fmtDate(agreement.pickupAt)),
        returnAt: esc(fmtDate(agreement.returnAt)),
        taxConfig: esc((agreement.charges || []).find((c) => String(c.chargeType || '').toUpperCase() === 'TAX')?.name || '-'),
        total: Number(agreement.total || 0).toFixed(2),
        amountPaid: paidAmountForPrint.toFixed(2),
        amountDue: amountDueForPrint.toFixed(2),
        chargesRows,
        paymentsRows: paymentsRows || '<tr><td colspan="5">No payments recorded</td></tr>',
        termsText: esc(cfg.termsText || ''),
        signatureSignedBy: esc(agreement.reservation?.signatureSignedBy || '-'),
        signatureDateTime: esc(fmtDate(signatureTime)),
        signatureIp: esc(signatureIp),
        signatureDataUrl: agreement.reservation?.signatureDataUrl || ''
      });
    }

    const chargesRowsHtml = chargesRows || '<tr><td colspan="4">No charges recorded</td></tr>';
    const paymentsRowsHtml = paymentsForPrint.length ? paymentsRows : '<tr><td colspan="5">No payments recorded</td></tr>';
    const signatureImageBlock = agreement.reservation?.signatureDataUrl
      ? `<img src="${agreement.reservation.signatureDataUrl}" alt="Signature" />`
      : '<div class="sig-meta">No signature on file</div>';

    const templateVars = {
      companyName: esc(cfg.companyName || ''),
      companyAddress: esc(cfg.companyAddress || ''),
      companyPhone: esc(cfg.companyPhone || ''),
      agreementNumber: esc(agreement.agreementNumber || ''),
      reservationNumber: esc(agreement.reservation?.reservationNumber || '-'),
      customerName: esc(`${agreement.customerFirstName || ''} ${agreement.customerLastName || ''}`.trim()),
      pickupAt: esc(fmtDate(agreement.pickupAt)),
      returnAt: esc(fmtDate(agreement.returnAt)),
      taxConfig: esc((agreement.charges || []).find((c) => String(c.chargeType || '').toUpperCase() === 'TAX')?.name || '-'),
      total: Number(agreement.total || 0).toFixed(2),
      amountPaid: paidAmountForPrint.toFixed(2),
      amountDue: amountDueForPrint.toFixed(2),
      chargesRows: chargesRowsHtml,
      paymentsRows: paymentsRowsHtml,
      termsText: esc(cfg.termsText || ''),
      signatureSignedBy: esc(agreement.reservation?.signatureSignedBy || '-'),
      signatureDateTime: esc(fmtDate(signatureTime)),
      signatureIp: esc(signatureIp),
      signatureImageBlock
    };

    const defaultTemplate = getModernAgreementTemplate();
    return applyTemplate(defaultTemplate, templateVars);

  },

  async agreementPdfBuffer(id) {
    const html = await this.renderAgreementHtml(id);
    const browser = await puppeteer.launch({
      headless: 'new',
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    try {
      const page = await browser.newPage();
      await page.setContent(html, { waitUntil: 'networkidle0' });
      const pdfBuffer = await page.pdf({
        format: 'Letter',
        printBackground: true,
        margin: { top: '0.5in', bottom: '0.6in', left: '0.5in', right: '0.5in' }
      });
      await page.close();
      return pdfBuffer;
    } finally {
      await browser.close();
    }
  },

  async emailAgreement(id, payload = {}, actorUserId = null) {
    const latestId = await this.resolveLatestAgreementId(id);
    const agreement = await this.getById(latestId);
    if (!agreement) throw new Error('Rental agreement not found');

    const to = String(payload.to || agreement.customerEmail || agreement.reservation?.customer?.email || '').trim();
    if (!to) throw new Error('Customer email is required');

    const pdf = await this.agreementPdfBuffer(latestId);
    const { sendEmail } = await import('../../lib/mailer.js');
    const { settingsService } = await import('../settings/settings.service.js');
    const tpl = await settingsService.getEmailTemplates();

    const paidAmount = Number((agreement.paidAmount != null ? agreement.paidAmount : (agreement.payments || []).reduce((s, p) => s + Number(p.amount || 0), 0)) || 0);
    const amountDue = Number((Number(agreement.total || 0) - paidAmount).toFixed(2));
    const base = (process.env.APP_BASE_URL || process.env.FRONTEND_BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
    const vars = {
      companyName: agreement?.reservation?.pickupLocation?.name || 'Ride Fleet',
      companyAddress: agreement?.reservation?.pickupLocation?.address1 || '',
      companyPhone: agreement?.reservation?.pickupLocation?.phone || '',
      agreementNumber: agreement.agreementNumber,
      reservationNumber: agreement?.reservation?.reservationNumber || '-',
      customerName: `${agreement.customerFirstName || ''} ${agreement.customerLastName || ''}`.trim(),
      pickupAt: fmtDate(agreement.pickupAt),
      returnAt: fmtDate(agreement.returnAt),
      total: Number(agreement.total || 0).toFixed(2),
      amountPaid: paidAmount.toFixed(2),
      amountDue: amountDue.toFixed(2),
      portalLink: `${base}/reservations/${agreement.reservationId}`
    };

    const subject = applyTemplate(String(payload.subject || tpl?.agreementEmailSubject || 'Your Rental Agreement {{agreementNumber}}'), vars);
    const html = applyTemplate(String(payload.html || tpl?.agreementEmailHtml || ''), vars);
    const text = String(payload.text || `Attached is your rental agreement ${agreement.agreementNumber}.`);

    await sendEmail({
      to,
      subject,
      text,
      html,
      attachments: [{ filename: `${agreement.agreementNumber}.pdf`, content: pdf, contentType: 'application/pdf' }]
    });

    await prisma.auditLog.create({ data: { reservationId: agreement.reservationId, actorUserId: actorUserId || null, action: 'UPDATE', reason: `Agreement emailed to ${to}` } });
    return { ok: true, to };
  },

  updateCustomer(id, patch) {
    return prisma.rentalAgreement.update({
      where: { id },
      data: {
        customerFirstName: patch.customerFirstName,
        customerLastName: patch.customerLastName,
        customerEmail: patch.customerEmail,
        customerPhone: patch.customerPhone,
        customerAddress1: patch.customerAddress1,
        customerAddress2: patch.customerAddress2,
        customerCity: patch.customerCity,
        customerState: patch.customerState,
        customerZip: patch.customerZip,
        customerCountry: patch.customerCountry,
        dateOfBirth: patch.dateOfBirth ? new Date(patch.dateOfBirth) : undefined,
        licenseNumber: patch.licenseNumber,
        licenseState: patch.licenseState,
        licenseExpiry: patch.licenseExpiry ? new Date(patch.licenseExpiry) : undefined,
        insuranceSource: patch.insuranceSource,
        insurancePolicyNumber: patch.insurancePolicyNumber,
        insuranceDocumentUrl: patch.insuranceDocumentUrl,
        insurancePlanCode: patch.insurancePlanCode,
        insurancePlanName: patch.insurancePlanName,
        insurancePlanRate: patch.insurancePlanRate,
        notes: patch.notes
      }
    });
  },

  updateRentalDetails(id, patch = {}) {
    return prisma.rentalAgreement.update({
      where: { id },
      data: {
        vehicleId: patch.vehicleId === '' ? null : (patch.vehicleId ?? undefined),
        pickupAt: patch.pickupAt ? new Date(patch.pickupAt) : undefined,
        returnAt: patch.returnAt ? new Date(patch.returnAt) : undefined,
        pickupLocationId: patch.pickupLocationId || undefined,
        returnLocationId: patch.returnLocationId || undefined,
        odometerOut: patch.odometerOut === '' ? null : (patch.odometerOut ?? undefined),
        fuelOut: patch.fuelOut === '' ? null : (patch.fuelOut ?? undefined),
        cleanlinessOut: patch.cleanlinessOut === '' ? null : (patch.cleanlinessOut ?? undefined),
        odometerIn: patch.odometerIn === '' ? null : (patch.odometerIn ?? undefined),
        fuelIn: patch.fuelIn === '' ? null : (patch.fuelIn ?? undefined),
        cleanlinessIn: patch.cleanlinessIn === '' ? null : (patch.cleanlinessIn ?? undefined)
      }
    });
  },

  addDriver(id, input) {
    return prisma.agreementDriver.create({
      data: {
        rentalAgreementId: id,
        firstName: input.firstName,
        lastName: input.lastName,
        email: input.email ?? null,
        phone: input.phone ?? null,
        licenseNumber: input.licenseNumber ?? null,
        licenseState: input.licenseState ?? null,
        licenseExpiry: input.licenseExpiry ? new Date(input.licenseExpiry) : null,
        dateOfBirth: input.dateOfBirth ? new Date(input.dateOfBirth) : null,
        isPrimary: input.isPrimary ?? false
      }
    });
  },

  async replaceCharges(id, items = []) {
    await prisma.rentalAgreementCharge.deleteMany({ where: { rentalAgreementId: id } });

    if (items.length) {
      await prisma.rentalAgreementCharge.createMany({
        data: items.map((x, idx) => ({
          rentalAgreementId: id,
          code: x.code ?? null,
          name: x.name,
          chargeType: x.chargeType ?? 'UNIT',
          quantity: toDecimal(x.quantity, 1),
          rate: toDecimal(x.rate, 0),
          total: toDecimal(x.total, toDecimal(x.quantity, 1) * toDecimal(x.rate, 0)),
          taxable: !!x.taxable,
          selected: x.selected !== false,
          sortOrder: x.sortOrder ?? idx
        }))
      });
    }

    const charges = await prisma.rentalAgreementCharge.findMany({ where: { rentalAgreementId: id, selected: true } });

    const subtotal = charges
      .filter((c) => c.chargeType !== 'TAX' && !isSecurityDepositCharge(c))
      .reduce((sum, c) => sum + Number(c.total), 0);
    const taxes = charges
      .filter((c) => c.chargeType === 'TAX')
      .reduce((sum, c) => sum + Number(c.total), 0);
    const total = subtotal + taxes;

    const current = await prisma.rentalAgreement.findUnique({ where: { id }, select: { paidAmount: true } });
    const paid = Number(current?.paidAmount || 0);

    return prisma.rentalAgreement.update({
      where: { id },
      data: {
        subtotal,
        taxes,
        fees: subtotal,
        total,
        balance: Number((total - paid).toFixed(2))
      },
      include: { charges: true }
    });
  },

  async adjustCustomerCreditFromAgreement(id, amount, reason = null) {
    const agreement = await prisma.rentalAgreement.findUnique({
      where: { id },
      include: { reservation: { select: { customerId: true, reservationNumber: true } } }
    });
    if (!agreement?.reservation?.customerId) throw new Error('Rental agreement not found');

    const customer = await prisma.customer.findUnique({ where: { id: agreement.reservation.customerId }, select: { creditBalance: true, notes: true } });
    if (!customer) throw new Error('Customer not found');

    const delta = Number(amount || 0);
    const nextBalance = Number((Number(customer.creditBalance || 0) + delta).toFixed(2));
    const note = `[CREDIT ${new Date().toISOString()}] ${delta >= 0 ? '+' : ''}${delta.toFixed(2)} via agreement ${agreement.agreementNumber}${reason ? ` | ${reason}` : ''}`;

    await prisma.customer.update({
      where: { id: agreement.reservation.customerId },
      data: {
        creditBalance: nextBalance,
        notes: customer.notes ? `${customer.notes}\n${note}` : note
      }
    });

    return { customerId: agreement.reservation.customerId, creditBalance: nextBalance };
  },

  async signAgreement(id, payload = {}, actorUserId = null, actorIp = null) {
    const signerName = String(payload.signerName || '').trim();
    const signatureDataUrl = String(payload.signatureDataUrl || '').trim();
    if (!signerName) throw new Error('Signer name is required');
    if (!signatureDataUrl) throw new Error('Signature is required');

    const agreement = await prisma.rentalAgreement.findUnique({ where: { id } });
    if (!agreement) throw new Error('Rental agreement not found');

    await prisma.reservation.update({
      where: { id: agreement.reservationId },
      data: {
        signatureSignedBy: signerName,
        signatureDataUrl,
        signatureSignedAt: new Date()
      }
    });

    await prisma.auditLog.create({
      data: {
        reservationId: agreement.reservationId,
        actorUserId: actorUserId || null,
        action: 'UPDATE',
        reason: 'Agreement signed after changes',
        metadata: JSON.stringify({ ip: actorIp || null, signedAt: new Date().toISOString(), signerName })
      }
    });

    return this.getById(id);
  },

  async updateStatus(id, action, actorUserId = null) {
    const agreement = await prisma.rentalAgreement.findUnique({ where: { id } });
    if (!agreement) throw new Error('Rental agreement not found');

    const mode = String(action || '').toUpperCase();
    if (!['VOID', 'REACTIVATE', 'START_CHECK_IN'].includes(mode)) {
      throw new Error('Unsupported agreement status action');
    }

    if (mode === 'VOID') {
      const row = await prisma.rentalAgreement.update({ where: { id }, data: { status: 'CANCELLED' } });
      await prisma.reservation.update({ where: { id: agreement.reservationId }, data: { status: 'CANCELLED' } });
      await prisma.auditLog.create({ data: { reservationId: agreement.reservationId, actorUserId: actorUserId || null, action: 'STATUS_CHANGE', fromStatus: 'CHECKED_OUT', toStatus: 'CANCELLED', reason: 'Agreement voided' } });
      return row;
    }

    if (mode === 'REACTIVATE') {
      if (agreement.status !== 'CANCELLED') throw new Error('Only cancelled/voided agreements can be reactivated');
      const row = await prisma.rentalAgreement.update({ where: { id }, data: { status: 'FINALIZED' } });
      await prisma.reservation.update({ where: { id: agreement.reservationId }, data: { status: 'CHECKED_OUT' } });
      await prisma.auditLog.create({ data: { reservationId: agreement.reservationId, actorUserId: actorUserId || null, action: 'STATUS_CHANGE', fromStatus: 'CANCELLED', toStatus: 'CHECKED_OUT', reason: 'Agreement reactivated' } });
      return row;
    }

    // START_CHECK_IN
    const row = await prisma.rentalAgreement.update({ where: { id }, data: { status: 'FINALIZED' } });
    await prisma.reservation.update({ where: { id: agreement.reservationId }, data: { status: 'CHECKED_IN' } });
    await prisma.auditLog.create({ data: { reservationId: agreement.reservationId, actorUserId: actorUserId || null, action: 'STATUS_CHANGE', fromStatus: 'CHECKED_OUT', toStatus: 'CHECKED_IN', reason: 'Check-in started from agreement' } });
    await completeLinkedCarSharingTripForReservation(agreement.reservationId, actorUserId || null, 'Trip auto-completed from agreement check-in');
    return row;
  },

  async addManualPayment(id, payload = {}, actorUserId = null) {
    const amount = Number(payload.amount || 0);
    if (!Number.isFinite(amount) || amount <= 0) throw new Error('Manual entry amount must be greater than 0');

    const entryType = String(payload.entryType || 'CHARGE').toUpperCase();
    if (!['CHARGE', 'DEPOSIT', 'REFUND'].includes(entryType)) throw new Error('entryType must be CHARGE, DEPOSIT, or REFUND');

    const receiptDataUrl = String(payload.receiptDataUrl || '').trim();
    if (!receiptDataUrl) throw new Error('Receipt is required for manual entries');

    const agreement = await prisma.rentalAgreement.findUnique({ where: { id } });
    if (!agreement) throw new Error('Rental agreement not found');

    const sign = entryType === 'REFUND' ? -1 : 1;
    const postedAmount = Number((amount * sign).toFixed(2));

    const nextPaidRaw = Number(agreement.paidAmount || 0) + postedAmount;
    const nextPaid = Math.max(0, Number(nextPaidRaw.toFixed(2)));
    const nextBalance = Math.max(0, Number((Number(agreement.balance || 0) - postedAmount).toFixed(2)));

    await prisma.rentalAgreementPayment.create({
      data: {
        rentalAgreementId: id,
        method: payload.method || 'OTHER',
        amount: postedAmount,
        reference: payload.reference || null,
        status: 'PAID',
        notes: payload.notes || `Manual ${entryType.toLowerCase()} posted by agent${payload.receiptName ? ` | receipt: ${payload.receiptName}` : ''}`
      }
    });

    await prisma.rentalAgreement.update({ where: { id }, data: { paidAmount: nextPaid, balance: nextBalance } });
    await prisma.auditLog.create({ data: { reservationId: agreement.reservationId, actorUserId: actorUserId || null, action: 'UPDATE', reason: `Manual ${entryType.toLowerCase()} added: ${postedAmount.toFixed(2)}` } });

    return this.getById(id);
  },

  async captureCustomerCardOnFile(id, payload = {}, actorUserId = null) {
    const customerProfileId = String(payload.authnetCustomerProfileId || '').trim();
    const paymentProfileId = String(payload.authnetPaymentProfileId || '').trim();
    if (!customerProfileId || !paymentProfileId) {
      throw new Error('authnetCustomerProfileId and authnetPaymentProfileId are required');
    }

    const agreement = await prisma.rentalAgreement.findUnique({
      where: { id },
      include: { reservation: { include: { customer: true } } }
    });
    if (!agreement) throw new Error('Rental agreement not found');
    const customer = agreement.reservation?.customer;
    if (!customer) throw new Error('Customer not found');

    await prisma.customer.update({
      where: { id: customer.id },
      data: {
        authnetCustomerProfileId: customerProfileId,
        authnetPaymentProfileId: paymentProfileId
      }
    });

    await prisma.auditLog.create({
      data: {
        reservationId: agreement.reservationId,
        actorUserId: actorUserId || null,
        action: 'UPDATE',
        reason: 'Captured customer card profile on file (Authorize.Net)'
      }
    });

    return this.getById(id);
  },

  async chargeCardOnFile(id, payload = {}, actorUserId = null) {
    const amount = Number(payload.amount || 0);
    if (!Number.isFinite(amount) || amount <= 0) throw new Error('Charge amount must be greater than 0');

    const agreement = await prisma.rentalAgreement.findUnique({
      where: { id },
      include: { reservation: { include: { customer: true } } }
    });
    if (!agreement) throw new Error('Rental agreement not found');

    const customer = agreement.reservation?.customer;
    if (!customer?.authnetCustomerProfileId || !customer?.authnetPaymentProfileId) {
      throw new Error('Customer does not have Authorize.Net card profile on file');
    }

    const tenantScope = agreement?.tenantId ? { tenantId: agreement.tenantId } : {};
    const cfg = await authNetConfig(tenantScope);
    const authnet = await authNetRequest({
      createTransactionRequest: {
        merchantAuthentication: { name: cfg.loginId, transactionKey: cfg.transactionKey },
        transactionRequest: {
          transactionType: 'authCaptureTransaction',
          amount: amount.toFixed(2),
          profile: {
            customerProfileId: customer.authnetCustomerProfileId,
            paymentProfile: { paymentProfileId: customer.authnetPaymentProfileId }
          },
          order: { invoiceNumber: agreement.agreementNumber || undefined }
        }
      }
    }, tenantScope);

    const tx = authnet?.transactionResponse;
    const ok = authnet?.messages?.resultCode === 'Ok' && tx?.responseCode === '1';
    if (!ok) {
      const err = tx?.errors?.[0]?.errorText || authnet?.messages?.message?.[0]?.text || 'Authorize.Net charge failed';
      throw new Error(err);
    }

    const reference = `AUTHNET:${tx.transId || 'UNKNOWN'}`;
    return this.addManualPayment(id, { amount, method: 'CARD', reference, notes: 'Charged card on file via Authorize.Net' }, actorUserId);
  },

  async captureSecurityDeposit(id, payload = {}, actorUserId = null) {
    const agreement = await prisma.rentalAgreement.findUnique({
      where: { id },
      include: { reservation: { include: { customer: true } } }
    });
    if (!agreement) throw new Error('Rental agreement not found');
    if (agreement.securityDepositCaptured) throw new Error('Security deposit is already captured');

    const amount = Number(payload.amount || agreement.securityDepositAmount || 0);
    if (!Number.isFinite(amount) || amount <= 0) throw new Error('Security deposit amount must be greater than 0');

    let reference = payload.reference || null;
    const customer = agreement.reservation?.customer;
    const tenantScope = agreement?.tenantId ? { tenantId: agreement.tenantId } : {};
    const authNetCfg = await authNetConfig(tenantScope);
    if (customer?.authnetCustomerProfileId && customer?.authnetPaymentProfileId && authNetCfg.loginId) {
      const cfg = authNetCfg;
      const authnet = await authNetRequest({
        createTransactionRequest: {
          merchantAuthentication: { name: cfg.loginId, transactionKey: cfg.transactionKey },
          transactionRequest: {
            transactionType: 'authOnlyTransaction',
            amount: amount.toFixed(2),
            profile: {
              customerProfileId: customer.authnetCustomerProfileId,
              paymentProfile: { paymentProfileId: customer.authnetPaymentProfileId }
            },
            order: { invoiceNumber: agreement.agreementNumber || undefined }
          }
        }
      }, tenantScope);
      const tx = authnet?.transactionResponse;
      const ok = authnet?.messages?.resultCode === 'Ok' && tx?.responseCode === '1';
      if (!ok) {
        const err = tx?.errors?.[0]?.errorText || authnet?.messages?.message?.[0]?.text || 'Authorize.Net deposit capture failed';
        throw new Error(err);
      }
      reference = `AUTHNET_AUTH:${tx.transId || 'UNKNOWN'}`;
    }

    await prisma.rentalAgreement.update({
      where: { id },
      data: {
        securityDepositAmount: amount,
        securityDepositCaptured: true,
        securityDepositCapturedAt: new Date(),
        securityDepositReference: reference
      }
    });

    await prisma.auditLog.create({ data: { reservationId: agreement.reservationId, actorUserId: actorUserId || null, action: 'UPDATE', reason: `Security deposit captured: ${amount.toFixed(2)}` } });
    return this.getById(id);
  },

  async releaseSecurityDeposit(id, payload = {}, actorUserId = null) {
    const agreement = await prisma.rentalAgreement.findUnique({ where: { id } });
    if (!agreement) throw new Error('Rental agreement not found');
    if (!agreement.securityDepositCaptured) throw new Error('Security deposit is not captured');
    if (agreement.securityDepositReleasedAt) throw new Error('Security deposit already released');

    await prisma.rentalAgreement.update({
      where: { id },
      data: {
        securityDepositReleasedAt: new Date(),
        securityDepositCaptured: false
      }
    });
    await prisma.auditLog.create({ data: { reservationId: agreement.reservationId, actorUserId: actorUserId || null, action: 'UPDATE', reason: 'Security deposit released' } });
    return this.getById(id);
  },

  async saveInspection(id, payload = {}, actorUserId = null, actorIp = null, actorRole = 'AGENT') {
    const agreement = await prisma.rentalAgreement.findUnique({
      where: { id },
      include: { inspections: true }
    });
    if (!agreement) throw new Error('Rental agreement not found');

    const phase = String(payload.phase || '').toUpperCase();
    if (!['CHECKOUT', 'CHECKIN'].includes(phase)) throw new Error('phase must be CHECKOUT or CHECKIN');
    const isAdminActor = ['SUPER_ADMIN', 'ADMIN'].includes(String(actorRole || '').toUpperCase());
    const existingInspection = Array.isArray(agreement.inspections)
      ? agreement.inspections.find((row) => String(row?.phase || '').toUpperCase() === phase)
      : null;
    if (
      phase === 'CHECKOUT'
      && existingInspection?.actorUserId
      && actorUserId
      && String(existingInspection.actorUserId) !== String(actorUserId)
      && !isAdminActor
    ) {
      throw new Error('Only admin can reassign checkout commission ownership after checkout has been captured');
    }

    const inspectionBlock = {
      phase,
      at: new Date(),
      ip: actorIp || null,
      actorUserId: actorUserId || null,
      exterior: payload.exterior || null,
      interior: payload.interior || null,
      tires: payload.tires || null,
      lights: payload.lights || null,
      windshield: payload.windshield || null,
      fuelLevel: payload.fuelLevel || null,
      odometer: payload.odometer || null,
      damages: payload.damages || null,
      notes: payload.notes || null,
      photos: payload.photos && typeof payload.photos === 'object' ? payload.photos : {}
    };
    await prisma.rentalAgreementInspection.upsert({
      where: {
        rentalAgreementId_phase: {
          rentalAgreementId: id,
          phase
        }
      },
      create: {
        rentalAgreementId: id,
        phase,
        capturedAt: inspectionBlock.at,
        actorUserId: inspectionBlock.actorUserId,
        actorIp: inspectionBlock.ip,
        exterior: inspectionBlock.exterior,
        interior: inspectionBlock.interior,
        tires: inspectionBlock.tires,
        lights: inspectionBlock.lights,
        windshield: inspectionBlock.windshield,
        fuelLevel: inspectionBlock.fuelLevel ? String(inspectionBlock.fuelLevel) : null,
        odometer: inspectionBlock.odometer === '' || inspectionBlock.odometer == null ? null : Number(inspectionBlock.odometer),
        damages: inspectionBlock.damages,
        notes: inspectionBlock.notes,
        photosJson: JSON.stringify(inspectionBlock.photos || {})
      },
      update: {
        capturedAt: inspectionBlock.at,
        actorUserId: inspectionBlock.actorUserId,
        actorIp: inspectionBlock.ip,
        exterior: inspectionBlock.exterior,
        interior: inspectionBlock.interior,
        tires: inspectionBlock.tires,
        lights: inspectionBlock.lights,
        windshield: inspectionBlock.windshield,
        fuelLevel: inspectionBlock.fuelLevel ? String(inspectionBlock.fuelLevel) : null,
        odometer: inspectionBlock.odometer === '' || inspectionBlock.odometer == null ? null : Number(inspectionBlock.odometer),
        damages: inspectionBlock.damages,
        notes: inspectionBlock.notes,
        photosJson: JSON.stringify(inspectionBlock.photos || {})
      }
    });

    if (phase === 'CHECKOUT' && inspectionBlock.actorUserId) {
      await prisma.rentalAgreement.update({
        where: { id },
        data: {
          salesOwnerUserId: inspectionBlock.actorUserId
        }
      });
      if (String(agreement.status || '').toUpperCase() === 'CLOSED') {
        await syncAgreementCommissionSnapshot(id);
      }
    }

    await prisma.auditLog.create({
      data: {
        reservationId: agreement.reservationId,
        actorUserId: actorUserId || null,
        action: 'UPDATE',
        reason: `Inspection saved (${phase})`,
        metadata: JSON.stringify({ phase, at: inspectionBlock.at.toISOString(), ip: inspectionBlock.ip })
      }
    });

    const refreshed = await prisma.rentalAgreement.findUnique({
      where: { id },
      include: { inspections: { orderBy: { createdAt: 'asc' } } }
    });
    return { report: inspectionReportFromAgreement(refreshed) };
  },

  async inspectionReport(id) {
    const agreement = await prisma.rentalAgreement.findUnique({
      where: { id },
      include: {
        reservation: { include: { customer: true, vehicle: true } },
        inspections: { orderBy: { createdAt: 'asc' } }
      }
    });
    if (!agreement) throw new Error('Rental agreement not found');

    const report = inspectionReportFromAgreement(agreement);
    return {
      agreementId: agreement.id,
      agreementNumber: agreement.agreementNumber,
      reservationNumber: agreement.reservation?.reservationNumber || null,
      customer: {
        firstName: agreement.customerFirstName || agreement.reservation?.customer?.firstName || null,
        lastName: agreement.customerLastName || agreement.reservation?.customer?.lastName || null,
        email: agreement.customerEmail || agreement.reservation?.customer?.email || null,
        phone: agreement.customerPhone || agreement.reservation?.customer?.phone || null
      },
      vehicle: agreement.reservation?.vehicle ? {
        id: agreement.reservation.vehicle.id,
        unit: agreement.reservation.vehicle.internalNumber || null,
        plate: agreement.reservation.vehicle.plate || null,
        vin: agreement.reservation.vehicle.vin || null,
        make: agreement.reservation.vehicle.make || null,
        model: agreement.reservation.vehicle.model || null,
        year: agreement.reservation.vehicle.year || null
      } : null,
      checkoutMetrics: {
        mileage: agreement.odometerOut ?? null,
        fuelLevel: agreement.fuelOut ?? null,
        cleanliness: agreement.cleanlinessOut ?? null
      },
      checkinMetrics: {
        mileage: agreement.odometerIn ?? null,
        fuelLevel: agreement.fuelIn ?? null,
        cleanliness: agreement.cleanlinessIn ?? null
      },
      checkoutInspection: report.checkout,
      checkinInspection: report.checkin
    };
  },

  async closeAgreement(id, payload = {}, actorUserId = null, actorRole = 'AGENT', actorIp = null) {
    const agreement = await prisma.rentalAgreement.findUnique({
      where: { id },
      include: {
        reservation: { include: { customer: true } },
        inspections: { orderBy: { createdAt: 'asc' } }
      }
    });
    if (!agreement) throw new Error('Rental agreement not found');

    if (Number(agreement.balance || 0) > 0) {
      throw new Error('Agreement cannot be closed with outstanding balance');
    }

    const report = inspectionReportFromAgreement(agreement);
    if (!report?.checkout?.at || !report?.checkout?.ip || !report?.checkin?.at || !report?.checkin?.ip) {
      throw new Error('Both inspections are required before closing agreement: checkout + check-in (timestamp/IP missing)');
    }

    const signerName = String(payload.signerName || agreement.customerFirstName || '').trim();
    const signatureDataUrl = String(
      payload.signatureDataUrl
      || agreement?.reservation?.signatureDataUrl
      || ''
    ).trim();
    if (!signerName) throw new Error('Signer name is required to close agreement');
    if (!signatureDataUrl) throw new Error('Customer signature is required to close agreement');

    const row = await prisma.rentalAgreement.update({
      where: { id },
      data: {
        status: 'CLOSED',
        locked: true,
        closedAt: new Date(),
        closedByUserId: actorUserId || agreement.closedByUserId || null,
        salesOwnerUserId: report?.checkout?.actorUserId || agreement.salesOwnerUserId || actorUserId || null,
        odometerIn: payload.odometerIn ?? agreement.odometerIn,
        fuelIn: payload.fuelIn ?? agreement.fuelIn,
        cleanlinessIn: payload.cleanlinessIn ?? agreement.cleanlinessIn
      }
    });

    await prisma.reservation.update({
      where: { id: agreement.reservationId },
      data: {
        status: 'CHECKED_IN',
        signatureSignedBy: signerName,
        signatureDataUrl: signatureDataUrl,
        signatureSignedAt: new Date()
      }
    });
    await prisma.auditLog.create({
      data: {
        reservationId: agreement.reservationId,
        actorUserId: actorUserId || null,
        action: 'UPDATE',
        reason: 'Agreement signed during close',
        metadata: JSON.stringify({ ip: actorIp || null, signedAt: new Date().toISOString(), signerName })
      }
    });
    await prisma.auditLog.create({
      data: {
        reservationId: agreement.reservationId,
        actorUserId: actorUserId || null,
        action: 'STATUS_CHANGE',
        fromStatus: 'CHECKED_OUT',
        toStatus: 'CHECKED_IN',
        reason: 'Agreement closed via check-in wizard'
      }
    });
    await completeLinkedCarSharingTripForReservation(agreement.reservationId, actorUserId || null, 'Trip auto-completed from agreement closeout');

    await syncAgreementCommissionSnapshot(id);

    // Best effort return receipt and post-return review email
    try {
      const { settingsService } = await import('../settings/settings.service.js');
      const { sendEmail } = await import('../../lib/mailer.js');
      const tpl = await settingsService.getEmailTemplates({ tenantId: agreement.tenantId || null });
      const rentalCfg = await settingsService.getRentalAgreementConfig({ tenantId: agreement.tenantId || null });
      const to = agreement.customerEmail || agreement.reservation?.customer?.email;
      if (to) {
        const render = (s = '') => String(s)
          .replaceAll('{{customerName}}', `${agreement.customerFirstName || ''} ${agreement.customerLastName || ''}`.trim())
          .replaceAll('{{reservationNumber}}', String(agreement.reservation?.reservationNumber || ''))
          .replaceAll('{{pickupAt}}', String(agreement.pickupAt ? fmtDate(agreement.pickupAt) : ''))
          .replaceAll('{{returnAt}}', String(agreement.returnAt ? fmtDate(agreement.returnAt) : ''))
          .replaceAll('{{pickupLocation}}', String(agreement.reservation?.pickupLocation?.name || ''))
          .replaceAll('{{returnLocation}}', String(agreement.reservation?.returnLocation?.name || ''))
          .replaceAll('{{workflowMode}}', String(agreement.reservation?.workflowMode || ''))
          .replaceAll('{{companyName}}', String(rentalCfg?.companyName || 'Ride Fleet'))
          .replaceAll('{{companyAddress}}', String(rentalCfg?.companyAddress || ''))
          .replaceAll('{{companyPhone}}', String(rentalCfg?.companyPhone || ''))
          .replaceAll('{{paidAmount}}', Number(agreement.paidAmount || 0).toFixed(2))
          .replaceAll('{{balance}}', Number(agreement.balance || 0).toFixed(2));
        await sendEmail({
          to,
          subject: render(tpl.returnReceiptSubject || 'Return Receipt - Reservation {{reservationNumber}}'),
          text: render(tpl.returnReceiptBody || 'Your agreement is now closed.'),
          html: render(tpl.returnReceiptHtml || String(tpl.returnReceiptBody || 'Your agreement is now closed.').replaceAll('\n', '<br/>'))
        });

        if (String(agreement.reservation?.workflowMode || '').toUpperCase() !== 'CAR_SHARING') {
          const reviewSubject = render(tpl.rentalReviewRequestSubject || 'How Was Your Rental Experience? - Reservation {{reservationNumber}}');
          const reviewText = render(tpl.rentalReviewRequestBody || 'Thank you for renting with us.');
          const reviewHtml = render(tpl.rentalReviewRequestHtml || reviewText.replaceAll('\n', '<br/>'));
          if (String(reviewSubject || '').trim() || String(reviewText || '').trim() || String(reviewHtml || '').trim()) {
            await sendEmail({
              to,
              subject: reviewSubject,
              text: reviewText,
              html: reviewHtml
            });
          }
        }
      }
    } catch {}

    return row;
  },

  async overrideCommissionOwner(id, employeeUserId, actorUserId = null, actorRole = 'ADMIN', scope = null) {
    const isAdminActor = ['SUPER_ADMIN', 'ADMIN'].includes(String(actorRole || '').toUpperCase());
    if (!isAdminActor) throw new Error('Admin role required for commission reassignment');

    const agreement = await prisma.rentalAgreement.findFirst({
      where: {
        id,
        ...(scope?.tenantId ? { tenantId: scope.tenantId } : {})
      },
      include: {
        inspections: { orderBy: { createdAt: 'asc' } }
      }
    });
    if (!agreement) throw new Error('Rental agreement not found');

    const employee = await prisma.user.findFirst({
      where: {
        id: employeeUserId,
        ...(agreement.tenantId ? { tenantId: agreement.tenantId } : {})
      },
      select: { id: true, fullName: true }
    });
    if (!employee) throw new Error('Selected commission employee must belong to the same tenant');

    const checkoutInspection = (agreement.inspections || []).find((row) => String(row?.phase || '').toUpperCase() === 'CHECKOUT');

    if (checkoutInspection) {
      await prisma.rentalAgreementInspection.update({
        where: {
          rentalAgreementId_phase: {
            rentalAgreementId: agreement.id,
            phase: 'CHECKOUT'
          }
        },
        data: {
          actorUserId: employee.id
        }
      });
    }

    const updated = await prisma.rentalAgreement.update({
      where: { id: agreement.id },
      data: {
        salesOwnerUserId: employee.id
      }
    });

    await prisma.auditLog.create({
      data: {
        reservationId: agreement.reservationId,
        actorUserId: actorUserId || null,
        action: 'UPDATE',
        reason: `Commission owner reassigned to ${employee.fullName || employee.id}`,
        metadata: JSON.stringify({
          commissionOwnerOverride: true,
          employeeUserId: employee.id,
          appliedToCheckoutInspection: !!checkoutInspection
        })
      }
    });

    if (String(agreement.status || '').toUpperCase() === 'CLOSED') {
      await syncAgreementCommissionSnapshot(agreement.id);
    }

    return updated;
  },

  async commissionOwnerContext(id, scope = null) {
    const agreement = await prisma.rentalAgreement.findFirst({
      where: {
        id,
        ...(scope?.tenantId ? { tenantId: scope.tenantId } : {})
      },
      include: {
        salesOwnerUser: {
          select: {
            id: true,
            fullName: true,
            role: true,
            isActive: true
          }
        },
        inspections: {
          where: { phase: 'CHECKOUT' },
          orderBy: [{ capturedAt: 'desc' }, { updatedAt: 'desc' }],
          select: {
            actorUserId: true
          }
        }
      }
    });
    if (!agreement) throw new Error('Rental agreement not found');

    const employees = await prisma.user.findMany({
      where: {
        ...(agreement.tenantId ? { tenantId: agreement.tenantId } : {}),
        isActive: true
      },
      orderBy: [{ fullName: 'asc' }, { createdAt: 'asc' }],
      select: {
        id: true,
        fullName: true,
        email: true,
        role: true,
        isActive: true
      }
    });

    return {
      agreementId: agreement.id,
      tenantId: agreement.tenantId || null,
      currentOwnerUserId: agreement.salesOwnerUserId || null,
      currentOwner: agreement.salesOwnerUser || null,
      checkoutActorUserId: agreement.inspections?.[0]?.actorUserId || null,
      employees
    };
  },

  async finalize(id, payload = {}) {
    const agreement = await prisma.rentalAgreement.findUnique({
      where: { id },
      include: {
        reservation: {
          include: {
            customer: true,
            pickupLocation: true
          }
        },
        pickupLocation: true
      }
    });
    if (!agreement) throw new Error('Rental agreement not found');

    const odometerOut = payload.odometerOut ?? agreement.odometerOut;
    const fuelOut = payload.fuelOut ?? agreement.fuelOut;
    const hasExplicitPaymentMethod = payload.paymentMethod !== undefined && payload.paymentMethod !== null && String(payload.paymentMethod).trim() !== '';
    const hasExplicitPaidAmount = payload.paidAmount !== undefined && payload.paidAmount !== null && String(payload.paidAmount).trim() !== '';
    const paymentMethod = hasExplicitPaymentMethod ? payload.paymentMethod : agreement.paymentMethod;
    const customerFirstName = String(agreement.customerFirstName || agreement.reservation?.customer?.firstName || '').trim();
    const customerLastName = String(agreement.customerLastName || agreement.reservation?.customer?.lastName || '').trim();
    const licenseNumber = String(agreement.licenseNumber || agreement.reservation?.customer?.licenseNumber || '').trim();
    const dateOfBirth = agreement.dateOfBirth || agreement.reservation?.customer?.dateOfBirth || null;
    const pickupLocationConfigSource = agreement.pickupLocation?.locationConfig || agreement.reservation?.pickupLocation?.locationConfig || null;

    if (!customerFirstName || !customerLastName) {
      throw new Error('Customer first and last name are required before finalizing');
    }
    if (!licenseNumber) {
      throw new Error('Customer license number is required before finalizing');
    }
    if (odometerOut === null || odometerOut === undefined) {
      throw new Error('Odometer out is required before finalizing');
    }
    const selectedCharges = await prisma.rentalAgreementCharge.count({
      where: { rentalAgreementId: id, selected: true }
    });
    if (!selectedCharges) {
      throw new Error('At least one selected charge is required before finalizing');
    }

    const paidAmount = hasExplicitPaidAmount
      ? toDecimal(payload.paidAmount, agreement.paidAmount)
      : Number(agreement.paidAmount || 0);

    const locationConfig = parseLocationConfig(pickupLocationConfigSource);
    const paymentDueAction = String(locationConfig?.paymentDueAction || 'AT_BOOKING');
    if ((paymentDueAction === 'AT_BOOKING' || paymentDueAction === 'AT_PICKUP') && paidAmount <= 0) {
      throw new Error('This location requires payment at booking/pickup before finalizing');
    }

    const minAge = Number(locationConfig?.chargeAgeMin || 0);
    const maxAge = Number(locationConfig?.chargeAgeMax || 0);
    const age = ageOnDate(dateOfBirth, agreement.pickupAt);
    if (age !== null) {
      if (minAge > 0 && age < minAge) throw new Error(`Driver age ${age} is below minimum age ${minAge} for this location`);
      if (maxAge > 0 && age > maxAge) throw new Error(`Driver age ${age} exceeds maximum age ${maxAge} for this location`);
    }

    let balance = Number((Number(agreement.total) - paidAmount).toFixed(2));
    let creditApplied = 0;

    const reservationWithCustomer = await prisma.reservation.findUnique({
      where: { id: agreement.reservationId },
      select: { customerId: true }
    });

    if (balance > 0 && reservationWithCustomer?.customerId) {
      const customer = await prisma.customer.findUnique({
        where: { id: reservationWithCustomer.customerId },
        select: { creditBalance: true, notes: true }
      });
      const availableCredit = Number(customer?.creditBalance || 0);
      if (availableCredit > 0) {
        creditApplied = Math.min(availableCredit, balance);
        balance = Number((balance - creditApplied).toFixed(2));

        const nextCredit = Number((availableCredit - creditApplied).toFixed(2));
        const note = `[CREDIT AUTO-APPLIED ${new Date().toISOString()}] -${creditApplied.toFixed(2)} to agreement ${agreement.agreementNumber}`;
        await prisma.customer.update({
          where: { id: reservationWithCustomer.customerId },
          data: {
            creditBalance: nextCredit,
            notes: customer?.notes ? `${customer.notes}\n${note}` : note
          }
        });
      }
    }

    const updated = await prisma.rentalAgreement.update({
      where: { id },
      data: {
        status: 'FINALIZED',
        paymentMethod: paymentMethod || null,
        paymentReference: payload.paymentReference ?? agreement.paymentReference,
        customerFirstName,
        customerLastName,
        licenseNumber,
        dateOfBirth,
        odometerOut,
        fuelOut,
        paidAmount,
        balance,
        finalizedAt: new Date()
      }
    });

    await prisma.reservation.update({
      where: { id: updated.reservationId },
      data: { status: 'CHECKED_OUT' }
    });

    if (hasExplicitPaidAmount && paidAmount > 0 && paymentMethod) {
      await prisma.rentalAgreementPayment.create({
        data: {
          rentalAgreementId: id,
          method: paymentMethod,
          amount: paidAmount,
          reference: payload.paymentReference ?? null,
          status: 'PAID'
        }
      });
    }

    if (creditApplied > 0) {
      await prisma.rentalAgreementPayment.create({
        data: {
          rentalAgreementId: id,
          method: 'OTHER',
          amount: creditApplied,
          reference: 'CUSTOMER_CREDIT_AUTO_APPLIED',
          status: 'PAID',
          notes: 'Automatically applied from customer credit balance'
        }
      });
    }

    return this.getById(id);
  },

  async deleteDraft(id) {
    const row = await prisma.rentalAgreement.findUnique({ where: { id } });
    if (!row) throw new Error('Rental agreement not found');
    if (row.status !== 'DRAFT') throw new Error('Only draft agreements can be deleted');

    await prisma.rentalAgreementCharge.deleteMany({ where: { rentalAgreementId: id } });
    await prisma.rentalAgreementPayment.deleteMany({ where: { rentalAgreementId: id } });
    await prisma.rentalAgreement.delete({ where: { id } });
    return { ok: true };
  }
};



