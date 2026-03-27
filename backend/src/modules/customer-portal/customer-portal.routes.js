import { Router } from 'express';
import Stripe from 'stripe';
import { prisma } from '../../lib/prisma.js';
import { sendEmail } from '../../lib/mailer.js';
import { rentalAgreementsService } from '../rental-agreements/rental-agreements.service.js';
import { reservationPricingService } from '../reservations/reservation-pricing.service.js';
import { settingsService } from '../settings/settings.service.js';

export const customerPortalRouter = Router();

function portalBase() {
  return process.env.CUSTOMER_PORTAL_BASE_URL || 'http://localhost:3000';
}

async function paymentGatewayConfigForTenant(tenantId = null) {
  const cfg = await settingsService.getPaymentGatewayConfig(tenantId ? { tenantId } : {});
  return cfg || {};
}

function authNetApiForConfig(config = {}) {
  const env = String(config?.authorizenet?.environment || 'sandbox').toLowerCase();
  return env === 'production' ? 'https://api2.authorize.net/xml/v1/request.api' : 'https://apitest.authorize.net/xml/v1/request.api';
}

function authNetHostedBaseForConfig(config = {}) {
  const env = String(config?.authorizenet?.environment || 'sandbox').toLowerCase();
  return env === 'production' ? 'https://accept.authorize.net/payment/payment' : 'https://test.authorize.net/payment/payment';
}

function authNetEnabled(config = {}) {
  return !!(config?.authorizenet?.enabled !== false && config?.authorizenet?.loginId && config?.authorizenet?.transactionKey);
}
function stripeEnabled(config = {}) {
  return !!(config?.stripe?.enabled && config?.stripe?.secretKey);
}
function squareEnabled(config = {}) {
  return !!(config?.square?.enabled && config?.square?.accessToken && config?.square?.locationId);
}

function currentGateway(config = {}) {
  const gateway = String(config?.gateway || 'authorizenet').toLowerCase();
  return ['authorizenet', 'stripe', 'square'].includes(gateway) ? gateway : 'authorizenet';
}

async function authNetRequest(payload, config = {}) {
  const r = await fetch(authNetApiForConfig(config), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  return r.json();
}

async function trySaveAuthNetCardOnFileFromTransaction({ reservation, reference }) {
  const config = await paymentGatewayConfigForTenant(reservation?.tenantId || null);
  if (!authNetEnabled(config)) return false;
  const rawRef = String(reference || '').trim();
  const transId = rawRef.startsWith('AUTHNET:') ? rawRef.slice('AUTHNET:'.length).trim() : rawRef;
  if (!transId) return false;

  const reqPayload = {
    createCustomerProfileFromTransactionRequest: {
      merchantAuthentication: {
        name: config.authorizenet.loginId,
        transactionKey: config.authorizenet.transactionKey
      },
      transId
    }
  };

  const out = await authNetRequest(reqPayload, config);
  const resp = out?.createCustomerProfileResponse || out?.createCustomerProfileFromTransactionResponse || out;
  const ok = resp?.messages?.resultCode === 'Ok';
  if (!ok) return false;

  const customerProfileId = resp?.customerProfileId || null;
  const paymentProfileId = Array.isArray(resp?.customerPaymentProfileIdList?.numericString)
    ? resp.customerPaymentProfileIdList.numericString[0]
    : (resp?.customerPaymentProfileIdList?.numericString || null);

  if (!customerProfileId || !paymentProfileId || !reservation?.customerId) return false;

  await prisma.customer.update({
    where: { id: reservation.customerId },
    data: {
      authnetCustomerProfileId: String(customerProfileId),
      authnetPaymentProfileId: String(paymentProfileId)
    }
  });
  return true;
}

async function findReservationByToken(kind, token) {
  if (kind === 'customer-info') {
    return prisma.reservation.findFirst({
      where: { customerInfoToken: token, customerInfoTokenExpiresAt: { gt: new Date() } },
      include: {
        customer: true,
        pickupLocation: true,
        returnLocation: true,
        vehicle: true,
        payments: { orderBy: { paidAt: 'desc' } }
      }
    });
  }
  if (kind === 'signature') {
    return prisma.reservation.findFirst({
      where: { signatureToken: token, signatureTokenExpiresAt: { gt: new Date() } },
      include: {
        customer: true,
        pickupLocation: true,
        returnLocation: true,
        vehicle: true,
        pricingSnapshot: true,
        charges: { where: { selected: true }, orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] },
        payments: { orderBy: { paidAt: 'desc' } },
        additionalDrivers: { orderBy: { createdAt: 'asc' } }
      }
    });
  }
  if (kind === 'payment') {
    return prisma.reservation.findFirst({
      where: { paymentRequestToken: token, paymentRequestTokenExpiresAt: { gt: new Date() } },
      include: {
        customer: true,
        pickupLocation: true,
        returnLocation: true,
        vehicle: true,
        pricingSnapshot: true,
        charges: { where: { selected: true }, orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] },
        payments: { orderBy: { paidAt: 'desc' } },
        additionalDrivers: { orderBy: { createdAt: 'asc' } }
      }
    });
  }
  return null;
}

async function latestAgreementForReservation(reservationId) {
  return prisma.rentalAgreement.findFirst({
    where: { reservationId },
    orderBy: { createdAt: 'desc' },
    include: {
      payments: { orderBy: { paidAt: 'desc' } }
    }
  });
}

function mergePayments(reservation, agreement) {
  const seen = new Set();
  const rows = [...(Array.isArray(reservation?.payments) ? reservation.payments : []), ...(Array.isArray(agreement?.payments) ? agreement.payments : [])];
  return rows.filter((payment) => {
    const id = String(payment?.id || '');
    if (!id || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

function portalTimelineEntry(key, label, at, status, description) {
  return {
    key,
    label,
    at: at || null,
    status,
    description
  };
}

function customerPortalBaseUrl() {
  return (process.env.CUSTOMER_PORTAL_BASE_URL || process.env.APP_BASE_URL || process.env.FRONTEND_BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
}

function customerPortalPath(kind) {
  if (kind === 'signature') return '/customer/sign-agreement';
  if (kind === 'payment') return '/customer/pay';
  return '/customer/precheckin';
}

function customerPortalLink(kind, token) {
  if (!token) return null;
  return `${customerPortalBaseUrl()}${customerPortalPath(kind)}?token=${encodeURIComponent(token)}`;
}

async function buildPortalSummary(reservation, kind, token) {
  const agreement = await latestAgreementForReservation(reservation.id);
  const payments = mergePayments(reservation, agreement);
  const paidAmount = paidFromStructuredPayments(payments);
  const balanceDue = await amountDueForReservation(reservation.id, reservation.estimatedTotal);
  const lastPaymentAt = payments
    .map((payment) => payment?.paidAt || payment?.createdAt || null)
    .filter(Boolean)
    .sort((a, b) => new Date(b).getTime() - new Date(a).getTime())[0] || null;
  const customerInfoComplete = !!reservation.customerInfoCompletedAt;
  const signatureComplete = !!reservation.signatureSignedAt;
  const paymentComplete = balanceDue <= 0 && paidAmount > 0;
  const paymentPartial = paidAmount > 0 && balanceDue > 0;
  const paymentRequested = !!reservation.paymentRequestToken;
  const agreementActive = !!agreement;
  const agreementClosed = !!agreement?.closedAt;
  const paymentStatus = paymentComplete
    ? 'completed'
    : paymentPartial
      ? 'active'
      : paymentRequested
        ? 'requested'
        : 'pending';
  const paymentStatusLabel = paymentComplete
    ? 'Paid in Full'
    : paymentPartial
      ? 'Partial Payment'
      : paymentRequested
        ? 'Payment Requested'
        : 'Payment Pending';

  const docs = [
    {
      key: 'agreement',
      label: 'Signed Agreement PDF',
      available: !!agreement?.id && !!(reservation?.signatureSignedAt || agreement?.signatureDataUrl || agreement?.locked),
      downloadPath: `/api/public/document/${encodeURIComponent(kind)}/${encodeURIComponent(token)}/agreement`
    },
    {
      key: 'receipt',
      label: 'Payment Receipt',
      available: payments.length > 0,
      downloadPath: `/api/public/document/${encodeURIComponent(kind)}/${encodeURIComponent(token)}/receipt`
    }
  ];

  const timeline = [
    portalTimelineEntry(
      'reservation',
      'Reservation Created',
      reservation.createdAt,
      'completed',
      `Reservation ${reservation.reservationNumber} is active.`
    ),
    portalTimelineEntry(
      'customerInfo',
      'Customer Information',
      reservation.customerInfoCompletedAt || reservation.customerInfoTokenExpiresAt || null,
      customerInfoComplete ? 'completed' : reservation.customerInfoToken ? 'requested' : 'pending',
      customerInfoComplete ? 'Customer information submitted.' : reservation.customerInfoToken ? 'Waiting for customer pre-check-in.' : 'Customer info request not sent.'
    ),
    portalTimelineEntry(
      'signature',
      'Agreement Signature',
      reservation.signatureSignedAt || reservation.signatureTokenExpiresAt || null,
      signatureComplete ? 'completed' : reservation.signatureToken ? 'requested' : 'pending',
      signatureComplete ? `Signed by ${reservation.signatureSignedBy || 'customer'}.` : reservation.signatureToken ? 'Waiting for customer signature.' : 'Signature request not sent.'
    ),
    portalTimelineEntry(
      'payment',
      'Payment',
      lastPaymentAt || reservation.paymentRequestTokenExpiresAt || null,
      paymentStatus,
      paymentComplete
        ? `Collected $${paidAmount.toFixed(2)}.`
        : paymentPartial
          ? `Collected $${paidAmount.toFixed(2)} so far. Remaining balance: $${balanceDue.toFixed(2)}.`
          : reservation.paymentRequestToken
            ? `Waiting for payment. Current balance: $${balanceDue.toFixed(2)}.`
            : 'Payment request not sent.'
    ),
    portalTimelineEntry(
      'agreement',
      'Rental Agreement',
      agreement?.closedAt || agreement?.createdAt || null,
      agreementClosed ? 'completed' : agreementActive ? 'active' : 'pending',
      agreementClosed ? `Agreement ${agreement.agreementNumber} closed.` : agreementActive ? `Agreement ${agreement.agreementNumber} is available.` : 'Agreement not generated yet.'
    )
  ];

  const progressSteps = [
    { key: 'customerInfo', label: 'Pre-check-in', done: customerInfoComplete },
    { key: 'signature', label: 'Signature', done: signatureComplete },
    { key: 'payment', label: 'Payment', done: paymentComplete },
    { key: 'agreement', label: 'Agreement Ready', done: agreementActive }
  ];
  const completedSteps = progressSteps.filter((step) => step.done).length;
  const currentStep = progressSteps.find((step) => !step.done) || null;
  const nextActionLabel = !customerInfoComplete
    ? 'Complete pre-check-in'
    : !signatureComplete
      ? 'Sign agreement'
      : !paymentComplete
        ? 'Complete payment'
        : agreementClosed
          ? 'Rental complete'
          : agreementActive
          ? 'Agreement available for pickup'
          : 'Wait for agreement generation';
  const links = {
    customerInfo: customerPortalLink('customer-info', reservation.customerInfoToken),
    signature: customerPortalLink('signature', reservation.signatureToken),
    payment: customerPortalLink('payment', reservation.paymentRequestToken)
  };
  const nextStep = !customerInfoComplete
    ? { key: 'customerInfo', label: 'Complete pre-check-in', link: links.customerInfo }
    : !signatureComplete
      ? { key: 'signature', label: 'Sign agreement', link: links.signature }
      : !paymentComplete
        ? { key: 'payment', label: 'Complete payment', link: links.payment }
        : agreementActive
          ? { key: 'agreement', label: 'Agreement ready for pickup', link: links.signature || links.customerInfo || links.payment || null }
          : null;

  return {
    kind,
    reservationStatus: reservation.status,
    agreement: agreement
      ? {
          id: agreement.id,
          agreementNumber: agreement.agreementNumber,
          status: agreement.status,
          createdAt: agreement.createdAt,
          closedAt: agreement.closedAt || null
        }
      : null,
    payment: {
      paidAmount,
      balanceDue: Number(balanceDue.toFixed(2)),
      lastPaymentAt,
      count: payments.length,
      status: paymentStatus,
      statusLabel: paymentStatusLabel
    },
    documents: docs,
    links,
    nextStep,
    timeline,
    progress: {
      totalSteps: progressSteps.length,
      completedSteps,
      percent: Math.round((completedSteps / progressSteps.length) * 100),
      isComplete: completedSteps === progressSteps.length,
      currentStep: currentStep ? currentStep.label : 'Complete',
      nextAction: nextActionLabel,
      steps: progressSteps
    }
  };
}

function paymentReceiptText({ reservation, agreement, payments }) {
  const customerName = `${reservation?.customer?.firstName || ''} ${reservation?.customer?.lastName || ''}`.trim() || 'Customer';
  const lines = [
    'Ride Fleet Payment Receipt',
    '',
    `Reservation: ${reservation?.reservationNumber || '-'}`,
    `Agreement: ${agreement?.agreementNumber || '-'}`,
    `Customer: ${customerName}`,
    `Status: ${reservation?.status || '-'}`,
    ''
  ];

  payments.forEach((payment, idx) => {
    lines.push(
      `Payment ${idx + 1}: $${Number(payment?.amount || 0).toFixed(2)} | ${String(payment?.status || 'PAID').toUpperCase()} | ${payment?.reference || '-'} | ${payment?.paidAt ? new Date(payment.paidAt).toLocaleString() : '-'}`
    );
  });

  lines.push('');
  lines.push(`Total Paid: $${paidFromStructuredPayments(payments).toFixed(2)}`);
  return lines.join('\n');
}

function serializeCustomerInfoReservation(reservation) {
  return {
    id: reservation.id,
    reservationNumber: reservation.reservationNumber,
    status: reservation.status,
    pickupAt: reservation.pickupAt,
    returnAt: reservation.returnAt,
    estimatedTotal: reservation.estimatedTotal,
    pickupLocation: reservation.pickupLocation?.name || '',
    returnLocation: reservation.returnLocation?.name || '',
    vehicle: [reservation.vehicle?.year, reservation.vehicle?.make, reservation.vehicle?.model].filter(Boolean).join(' ') || '',
    customerInfoCompletedAt: reservation.customerInfoCompletedAt || null,
    customer: {
      firstName: reservation.customer?.firstName || '',
      lastName: reservation.customer?.lastName || '',
      email: reservation.customer?.email || '',
      phone: reservation.customer?.phone || '',
      dateOfBirth: reservation.customer?.dateOfBirth || null,
      licenseNumber: reservation.customer?.licenseNumber || '',
      licenseState: reservation.customer?.licenseState || '',
      insurancePolicyNumber: reservation.customer?.insurancePolicyNumber || '',
      insuranceDocumentUrl: reservation.customer?.insuranceDocumentUrl || '',
      address1: reservation.customer?.address1 || '',
      address2: reservation.customer?.address2 || '',
      city: reservation.customer?.city || '',
      state: reservation.customer?.state || '',
      zip: reservation.customer?.zip || '',
      country: reservation.customer?.country || '',
      idPhotoUrl: reservation.customer?.idPhotoUrl || ''
    }
  };
}

function paidFromStructuredPayments(payments) {
  const rows = Array.isArray(payments) ? payments : [];
  return Number(rows
    .filter((p) => String(p?.status || '').toUpperCase() !== 'VOID')
    .reduce((sum, p) => sum + Number(p?.amount || 0), 0)
    .toFixed(2));
}

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

function isUnderageReservation(reservation) {
  const cfg = parseLocationConfig(reservation?.pickupLocation?.locationConfig);
  if (!cfg?.underageAlertEnabled) return false;
  const threshold = Number(cfg?.underageAlertAge ?? cfg?.chargeAgeMin ?? 21);
  const age = ageOnDate(reservation?.customer?.dateOfBirth, reservation?.pickupAt);
  return Number.isFinite(threshold) && threshold >= 16 && age != null && age < threshold;
}

async function buildReservationBreakdown(reservation) {
  const structuredCharges = Array.isArray(reservation?.charges) ? reservation.charges : [];
  if (structuredCharges.length) {
    const lines = structuredCharges.map((c) => ({
      name: c.name,
      qty: Number(c.quantity || 0),
      rate: Number(c.rate || 0),
      total: Number(c.total || 0)
    }));
    const subtotal = Number(structuredCharges
      .filter((c) => String(c?.chargeType || '').toUpperCase() !== 'TAX')
      .reduce((sum, c) => sum + Number(c.total || 0), 0)
      .toFixed(2));
    const tax = Number(structuredCharges
      .filter((c) => String(c?.chargeType || '').toUpperCase() === 'TAX')
      .reduce((sum, c) => sum + Number(c.total || 0), 0)
      .toFixed(2));
    const total = Number((subtotal + tax).toFixed(2));
    return { lines, subtotal, tax, total };
  }

  const tenantWhere = reservation?.tenantId ? { tenantId: reservation.tenantId } : {};
  const pickupAt = new Date(reservation?.pickupAt || Date.now());
  const returnAt = new Date(reservation?.returnAt || Date.now());
  const days = Math.max(1, Math.ceil((returnAt - pickupAt) / (1000 * 60 * 60 * 24)));
  const dailyRate = Number(reservation?.pricingSnapshot?.dailyRate ?? reservation?.dailyRate ?? 0);
  const lines = [{ name: 'Daily', qty: days, rate: dailyRate, total: Number((dailyRate * days).toFixed(2)) }];
  const base = Number((dailyRate * days).toFixed(2));
  const hasAdditionalDrivers = Array.isArray(reservation?.additionalDrivers) && reservation.additionalDrivers.length > 0;
  const selectedFeeIds = [];
  const discounts = [];

  const underageAutoFees = isUnderageReservation(reservation)
    ? await prisma.fee.findMany({ where: { ...tenantWhere, isActive: true, isUnderageFee: true }, select: { id: true } })
    : [];
  const addlDriverAutoFees = hasAdditionalDrivers
    ? await prisma.fee.findMany({ where: { ...tenantWhere, isActive: true, isAdditionalDriverFee: true }, select: { id: true } })
    : [];
  const mergedFeeIds = [...new Set([...selectedFeeIds, ...underageAutoFees.map((f) => f.id), ...addlDriverAutoFees.map((f) => f.id)])];

  const [services, fees] = await Promise.all([
    Promise.resolve([]),
    mergedFeeIds.length ? prisma.fee.findMany({ where: { ...tenantWhere, id: { in: mergedFeeIds } } }) : Promise.resolve([])
  ]);

  const taxRate = Number(reservation?.pricingSnapshot?.taxRate ?? reservation?.pickupLocation?.taxRate ?? 0);

  let servicesTotal = 0;
  for (const s of services || []) {
    const qty = Number(s?.defaultQty || 1) || 1;
    const perDay = Number(s?.dailyRate || 0);
    const flat = Number(s?.rate || 0);
    const total = Number((perDay > 0 ? perDay * days * qty : flat * qty).toFixed(2));
    servicesTotal += total;
    lines.push({ name: s.name, qty, rate: perDay > 0 ? perDay : flat, total });
  }

  let feesTotal = 0;
  for (const f of fees || []) {
    const amt = Number(f?.amount || 0);
    const mode = String(f?.mode || 'FIXED').toUpperCase();
    const total = Number((mode === 'PERCENTAGE' ? ((base + servicesTotal) * (amt / 100)) : amt).toFixed(2));
    feesTotal += total;
    lines.push({ name: f.name, qty: 1, rate: mode === 'PERCENTAGE' ? `${amt}%` : amt, total });
  }

  const beforeDiscount = base + servicesTotal + feesTotal;
  let discountTotal = 0;
  for (const d of discounts) {
    const val = Number(d?.value || 0);
    if (!Number.isFinite(val) || val <= 0) continue;
    const dTotal = Number((String(d?.mode || 'FIXED').toUpperCase() === 'PERCENTAGE' ? (beforeDiscount * (val / 100)) : val).toFixed(2));
    discountTotal += dTotal;
    lines.push({ name: d?.label || 'Discount', qty: 1, rate: `-${String(d?.mode || 'FIXED').toUpperCase() === 'PERCENTAGE' ? `${val}%` : `$${val.toFixed(2)}`}`, total: -dTotal });
  }

  const subtotal = Math.max(0, Number((beforeDiscount - discountTotal).toFixed(2)));
  const tax = Number((subtotal * (taxRate / 100)).toFixed(2));
  const total = Number((subtotal + tax).toFixed(2));
  return { lines, subtotal, tax, total };
}

async function amountDueForReservation(reservationId, fallbackEstimated = 0) {
  const [latestAgreement, reservation] = await Promise.all([
    prisma.rentalAgreement.findFirst({ where: { reservationId }, orderBy: { createdAt: 'desc' } }),
    prisma.reservation.findUnique({
      where: { id: reservationId },
      include: {
        customer: { select: { dateOfBirth: true } },
        pickupLocation: { select: { locationConfig: true, taxRate: true } },
        pricingSnapshot: true,
        charges: { where: { selected: true }, orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] },
        payments: { orderBy: { paidAt: 'desc' } }
      }
    })
  ]);

  const breakdown = reservation ? await buildReservationBreakdown(reservation) : null;
  const est = Number(breakdown?.total ?? reservation?.estimatedTotal ?? fallbackEstimated ?? 0);
  const paid = paidFromStructuredPayments(reservation?.payments);
  const reservationOutstanding = Math.max(0, Number((est - paid).toFixed(2)));

  let depositDueNow = null;
  if (reservation?.pricingSnapshot) {
    const dep = Number(reservation.pricingSnapshot.depositAmountDue || 0);
    if (reservation.pricingSnapshot.depositRequired && Number.isFinite(dep) && dep > 0) {
      depositDueNow = Math.max(0, Number((dep - paid).toFixed(2)));
    }
  }

  if (latestAgreement) {
    const balance = Number(latestAgreement.balance ?? 0);
    const total = Number(latestAgreement.total ?? 0);
    if (Number.isFinite(balance) && balance > 0) return balance;
    if (reservationOutstanding > 0) return reservationOutstanding;
    if (Number.isFinite(total) && total > 0) return total;
  }

  if (depositDueNow != null && depositDueNow > 0) {
    return Math.min(reservationOutstanding || depositDueNow, depositDueNow);
  }

  return reservationOutstanding;
}

async function postPayment({ reservation, paidAmount, reference, gateway }) {
  await reservationPricingService.postPayment(reservation.id, {
    amount: paidAmount,
    method: 'CARD',
    reference,
    status: 'PAID',
    origin: 'PORTAL',
    gateway,
    notes: `Paid via ${gateway} customer payment portal`
  }, {}, null);

  await prisma.auditLog.create({ data: { reservationId: reservation.id, action: 'UPDATE', metadata: JSON.stringify({ paymentPortalCompleted: true, reference, amount: paidAmount, gateway }) } });

  try {
    const to = String(reservation.customer?.email || '').trim();
    if (to) {
      await sendEmail({
        to,
        subject: `Payment Receipt - ${reservation.reservationNumber}`,
        text: [
          `Hello ${reservation.customer?.firstName || 'Customer'},`,
          '',
          `Thank you. We received your payment.`,
          `Reservation: ${reservation.reservationNumber}`,
          `Amount Paid: $${Number(paidAmount || 0).toFixed(2)}`,
          `Reference: ${reference}`,
          `Date: ${new Date().toLocaleString()}`,
          '',
          `This is your payment receipt.`
        ].join('\n')
      });
    }
  } catch {}
}

customerPortalRouter.get('/signature/:token', async (req, res, next) => {
  try {
    const token = String(req.params.token || '');
    if (!token) return res.status(400).json({ error: 'token required' });

    const reservation = await findReservationByToken('signature', token);
    if (!reservation) return res.status(404).json({ error: 'Invalid or expired signature link' });

    const { settingsService } = await import('../settings/settings.service.js');
    const agreementCfg = await settingsService.getRentalAgreementConfig(reservation?.tenantId ? { tenantId: reservation.tenantId } : {});
    const latestAgreement = await prisma.rentalAgreement.findFirst({
      where: { reservationId: reservation.id },
      include: { charges: { orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] } },
      orderBy: { createdAt: 'desc' }
    });
    const reservationBreakdown = latestAgreement ? null : await buildReservationBreakdown(reservation);
    const reservationPaid = latestAgreement ? 0 : paidFromStructuredPayments(reservation?.payments);
    const reservationTotal = Number(reservationBreakdown?.total || reservation.estimatedTotal || 0);
    const reservationBalance = Math.max(0, Number((reservationTotal - reservationPaid).toFixed(2)));

    const breakdown = latestAgreement
      ? {
          subtotal: Number(latestAgreement.subtotal || 0),
          taxes: Number(latestAgreement.taxes || 0),
          total: Number(latestAgreement.total || 0),
          paidAmount: Number(latestAgreement.paidAmount || 0),
          balance: Number(latestAgreement.balance || 0),
          charges: (latestAgreement.charges || []).map((c) => ({
            name: c.name,
            quantity: Number(c.quantity || 0),
            rate: Number(c.rate || 0),
            total: Number(c.total || 0)
          }))
        }
      : {
          subtotal: Number(reservationBreakdown?.subtotal || reservationTotal),
          taxes: Number(reservationBreakdown?.tax || 0),
          total: reservationTotal,
          paidAmount: reservationPaid,
          balance: reservationBalance,
          charges: (reservationBreakdown?.lines || []).map((line) => ({
            name: line.name,
            quantity: Number(line.qty || 0),
            rate: line.rate,
            total: Number(line.total || 0)
          }))
        };

    res.json({
      reservation: {
        id: reservation.id,
        reservationNumber: reservation.reservationNumber,
        pickupAt: reservation.pickupAt,
        returnAt: reservation.returnAt,
        estimatedTotal: reservation.estimatedTotal,
        customerName: `${reservation.customer?.firstName || ''} ${reservation.customer?.lastName || ''}`.trim(),
        customerEmail: reservation.customer?.email || null,
        vehicle: reservation.vehicle ? `${reservation.vehicle.year || ''} ${reservation.vehicle.make || ''} ${reservation.vehicle.model || ''}`.trim() : null,
        pickupLocation: reservation.pickupLocation?.name || null,
        returnLocation: reservation.returnLocation?.name || null
      },
      breakdown,
      portal: await buildPortalSummary(reservation, 'signature', token),
      termsText: agreementCfg?.termsText || 'Standard rental terms apply.'
    });
  } catch (e) { next(e); }
});

customerPortalRouter.get('/customer-info/:token', async (req, res, next) => {
  try {
    const token = String(req.params.token || '');
    if (!token) return res.status(400).json({ error: 'token required' });

    const reservation = await findReservationByToken('customer-info', token);
    if (!reservation) return res.status(404).json({ error: 'Invalid or expired customer info token' });

    res.json({
      reservation: serializeCustomerInfoReservation(reservation),
      expiresAt: reservation.customerInfoTokenExpiresAt,
      portal: await buildPortalSummary(reservation, 'customer-info', token)
    });
  } catch (e) {
    next(e);
  }
});

customerPortalRouter.post('/customer-info/:token', async (req, res, next) => {
  try {
    const token = String(req.params.token || '');
    if (!token) return res.status(400).json({ error: 'token required' });

    const reservation = await findReservationByToken('customer-info', token);
    if (!reservation) return res.status(404).json({ error: 'Invalid or expired customer info token' });

    const body = req.body || {};
    const firstName = String(body.firstName || '').trim();
    const lastName = String(body.lastName || '').trim();
    const email = String(body.email || '').trim().toLowerCase();
    const phone = String(body.phone || '').trim();
    const requiredChecks = [
      ['firstName', firstName, 'First Name'],
      ['lastName', lastName, 'Last Name'],
      ['email', email, 'Email'],
      ['phone', phone, 'Phone'],
      ['dateOfBirth', String(body.dateOfBirth || '').trim(), 'Date of Birth'],
      ['licenseNumber', String(body.licenseNumber || '').trim(), 'Driver License Number'],
      ['licenseState', String(body.licenseState || '').trim(), 'Driver License State'],
      ['address1', String(body.address1 || '').trim(), 'Address Line 1'],
      ['city', String(body.city || '').trim(), 'City'],
      ['state', String(body.state || '').trim(), 'State'],
      ['zip', String(body.zip || '').trim(), 'ZIP'],
      ['country', String(body.country || '').trim(), 'Country'],
      ['idPhotoUrl', String(body.idPhotoUrl || '').trim(), 'ID / License Photo'],
      ['insuranceDocumentUrl', String(body.insuranceDocumentUrl || '').trim(), 'Insurance Document']
    ];
    const missing = requiredChecks.filter(([, value]) => !value).map(([, , label]) => label);
    if (missing.length) {
      return res.status(400).json({ error: `Complete the required pre-check-in items first: ${missing.join(', ')}` });
    }

    await prisma.customer.update({
      where: { id: reservation.customerId },
      data: {
        firstName,
        lastName,
        email,
        phone,
        dateOfBirth: body.dateOfBirth ? new Date(body.dateOfBirth) : null,
        licenseNumber: body.licenseNumber ? String(body.licenseNumber).trim() : null,
        licenseState: body.licenseState ? String(body.licenseState).trim() : null,
        insurancePolicyNumber: body.insurancePolicyNumber ? String(body.insurancePolicyNumber).trim() : null,
        insuranceDocumentUrl: body.insuranceDocumentUrl ? String(body.insuranceDocumentUrl).trim() : null,
        address1: body.address1 ? String(body.address1).trim() : null,
        address2: body.address2 ? String(body.address2).trim() : null,
        city: body.city ? String(body.city).trim() : null,
        state: body.state ? String(body.state).trim() : null,
        zip: body.zip ? String(body.zip).trim() : null,
        country: body.country ? String(body.country).trim() : null,
        idPhotoUrl: body.idPhotoUrl ? String(body.idPhotoUrl).trim() : null
      }
    });

    const completedAt = new Date();
    await prisma.reservation.update({
      where: { id: reservation.id },
      data: {
        customerInfoCompletedAt: completedAt
      }
    });

    await prisma.auditLog.create({
      data: {
        tenantId: reservation.tenantId || null,
        reservationId: reservation.id,
        action: 'UPDATE',
        metadata: JSON.stringify({
          customerInfoCompleted: true,
          completedAt: completedAt.toISOString(),
          source: 'PUBLIC_PRECHECKIN',
          ip: req.ip || null
        })
      }
    });

    const refreshed = await findReservationByToken('customer-info', token);
    res.json({
      ok: true,
      completedAt,
      message: 'Pre-check-in completed successfully.',
      portal: refreshed ? await buildPortalSummary(refreshed, 'customer-info', token) : null
    });
  } catch (e) {
    next(e);
  }
});

customerPortalRouter.post('/signature/:token', async (req, res, next) => {
  try {
    const token = String(req.params.token || '');
    const signerName = String(req.body?.signerName || '').trim();
    const signatureDataUrl = String(req.body?.signatureDataUrl || '').trim();
    if (!signerName) return res.status(400).json({ error: 'signerName is required' });
    if (!signatureDataUrl) return res.status(400).json({ error: 'signatureDataUrl is required' });

    const reservation = await findReservationByToken('signature', token);
    if (!reservation) return res.status(404).json({ error: 'Invalid or expired signature link' });

    const note = `[SIGNATURE ${new Date().toISOString()}] signed by ${signerName}`;
    await prisma.reservation.update({
      where: { id: reservation.id },
      data: {
        signatureSignedAt: new Date(),
        signatureSignedBy: signerName,
        signatureDataUrl,
        notes: reservation.notes ? `${reservation.notes}\n${note}` : note
      }
    });
    const latestAgreement = await prisma.rentalAgreement.findFirst({ where: { reservationId: reservation.id }, orderBy: { createdAt: 'desc' }, select: { id: true } });
    if (latestAgreement?.id) {
      await prisma.rentalAgreement.update({ where: { id: latestAgreement.id }, data: { locked: true } });
    }

    await prisma.auditLog.create({ data: { reservationId: reservation.id, action: 'UPDATE', metadata: JSON.stringify({ signatureCompleted: true, signerName, agreementLocked: !!latestAgreement?.id }) } });

    let emailedSignedAgreement = false;
    try {
      const latestAgreement = await prisma.rentalAgreement.findFirst({ where: { reservationId: reservation.id }, orderBy: { createdAt: 'desc' }, select: { id: true } });
      const to = String(reservation.customer?.email || '').trim();
      if (latestAgreement?.id && to) {
        await rentalAgreementsService.emailAgreement(latestAgreement.id, {
          to,
          subject: `Signed Rental Agreement ${reservation.reservationNumber}`,
          text: `Hello ${signerName},\n\nYour signed rental agreement is attached as a PDF.\n\nThank you.`
        }, null);
        emailedSignedAgreement = true;
      }
    } catch {}

    const refreshed = await findReservationByToken('signature', token);
    res.json({
      ok: true,
      emailedSignedAgreement,
      message: emailedSignedAgreement ? 'Signature captured. Signed agreement has been sent to your email.' : 'Signature captured successfully.',
      portal: refreshed ? await buildPortalSummary(refreshed, 'signature', token) : null
    });
  } catch (e) { next(e); }
});

customerPortalRouter.get('/payment/:token', async (req, res, next) => {
  try {
    const token = String(req.params.token || '');
    if (!token) return res.status(400).json({ error: 'token required' });
    const reservation = await findReservationByToken('payment', token);
    if (!reservation) return res.status(404).json({ error: 'Invalid or expired payment link' });

    const amountDue = await amountDueForReservation(reservation.id, reservation.estimatedTotal);
    const breakdown = await buildReservationBreakdown(reservation);
    const gatewayConfig = await paymentGatewayConfigForTenant(reservation.tenantId || null);
    const gateway = currentGateway(gatewayConfig);
    const gatewayReady = gateway === 'authorizenet'
      ? authNetEnabled(gatewayConfig)
      : gateway === 'stripe'
        ? stripeEnabled(gatewayConfig)
        : squareEnabled(gatewayConfig);

    res.json({
      reservation: {
        id: reservation.id,
        reservationNumber: reservation.reservationNumber,
        pickupAt: reservation.pickupAt,
        returnAt: reservation.returnAt,
        estimatedTotal: reservation.estimatedTotal,
        customerName: `${reservation.customer?.firstName || ''} ${reservation.customer?.lastName || ''}`.trim(),
        customerEmail: reservation.customer?.email || null,
        vehicle: reservation.vehicle ? `${reservation.vehicle.year || ''} ${reservation.vehicle.make || ''} ${reservation.vehicle.model || ''}`.trim() : null,
        pickupLocation: reservation.pickupLocation?.name || null,
        returnLocation: reservation.returnLocation?.name || null
      },
      amountDue: Number(amountDue.toFixed(2)),
      breakdown,
      portal: await buildPortalSummary(reservation, 'payment', token),
      gateway,
      gatewayReady
    });
  } catch (e) { next(e); }
});

customerPortalRouter.post('/payment/:token/create-session', async (req, res, next) => {
  try {
    const token = String(req.params.token || '');
    const reservation = await findReservationByToken('payment', token);
    if (!reservation) return res.status(404).json({ error: 'Invalid or expired payment link' });
    const amountDue = await amountDueForReservation(reservation.id, reservation.estimatedTotal);
    const gatewayConfig = await paymentGatewayConfigForTenant(reservation.tenantId || null);
    const gateway = currentGateway(gatewayConfig);

    if (gateway === 'stripe') {
      if (!stripeEnabled(gatewayConfig)) return res.status(400).json({ error: 'Stripe is not configured for this tenant' });
      const stripe = new Stripe(gatewayConfig.stripe.secretKey);
      const base = portalBase().replace(/\/$/, '');
      const session = await stripe.checkout.sessions.create({
        mode: 'payment',
        success_url: `${base}/customer/pay?token=${encodeURIComponent(token)}&success=1&session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${base}/customer/pay?token=${encodeURIComponent(token)}&canceled=1`,
        customer_email: reservation.customer?.email || undefined,
        line_items: [{ quantity: 1, price_data: { currency: 'usd', product_data: { name: `Reservation ${reservation.reservationNumber} Payment` }, unit_amount: Math.round(Number(amountDue || 0) * 100) } }],
        metadata: { reservationId: reservation.id, paymentToken: token }
      });
      return res.json({ checkoutUrl: session.url, gateway });
    }

    if (gateway === 'square') {
      if (!squareEnabled(gatewayConfig)) return res.status(400).json({ error: 'Square is not configured for this tenant' });
      const squareApiBase = String(gatewayConfig.square?.environment || 'production').toLowerCase() === 'sandbox'
        ? 'https://connect.squareupsandbox.com'
        : 'https://connect.squareup.com';
      const resp = await fetch(`${squareApiBase}/v2/online-checkout/payment-links`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${gatewayConfig.square.accessToken}`,
          'Square-Version': '2024-12-18'
        },
        body: JSON.stringify({
          idempotency_key: `${reservation.id}-${Date.now()}`,
          quick_pay: {
            name: `Reservation ${reservation.reservationNumber} Payment`,
            price_money: { amount: Math.round(Number(amountDue || 0) * 100), currency: 'USD' },
            location_id: gatewayConfig.square.locationId
          },
          checkout_options: {
            redirect_url: `${portalBase().replace(/\/$/, '')}/customer/pay?token=${encodeURIComponent(token)}&success=1`
          }
        })
      });
      const j = await resp.json();
      const url = j?.payment_link?.url;
      if (!resp.ok || !url) return res.status(400).json({ error: j?.errors?.[0]?.detail || 'Square checkout creation failed' });
      return res.json({ checkoutUrl: url, gateway });
    }

    // Authorize.Net
    if (!authNetEnabled(gatewayConfig)) return res.status(400).json({ error: 'Authorize.Net is not configured for this tenant' });
    const amount = Number(Math.max(0.5, Number(amountDue || 0))).toFixed(2);
    const returnUrl = `${portalBase().replace(/\/$/, '')}/customer/pay?token=${encodeURIComponent(token)}&success=1`;
    const cancelUrl = `${portalBase().replace(/\/$/, '')}/customer/pay?token=${encodeURIComponent(token)}&canceled=1`;

    const requestPayload = {
      getHostedPaymentPageRequest: {
        merchantAuthentication: { name: gatewayConfig.authorizenet.loginId, transactionKey: gatewayConfig.authorizenet.transactionKey },
        transactionRequest: {
          transactionType: 'authCaptureTransaction',
          amount,
          order: { invoiceNumber: reservation.reservationNumber, description: `Reservation ${reservation.reservationNumber} payment` }
        },
        hostedPaymentSettings: {
          setting: [
            { settingName: 'hostedPaymentReturnOptions', settingValue: JSON.stringify({ showReceipt: false, url: returnUrl, urlText: 'Return to Reservation', cancelUrl, cancelUrlText: 'Cancel' }) },
            { settingName: 'hostedPaymentButtonOptions', settingValue: JSON.stringify({ text: 'Pay Now' }) }
          ]
        }
      }
    };

    const authnet = await authNetRequest(requestPayload, gatewayConfig);
    const response = authnet?.getHostedPaymentPageResponse;
    const hostedToken = response?.token;
    if (response?.messages?.resultCode !== 'Ok' || !hostedToken) {
      return res.status(400).json({ error: response?.messages?.message?.[0]?.text || 'Authorize.Net token creation failed' });
    }

    const hostedBase = authNetHostedBaseForConfig(gatewayConfig);
    res.json({ checkoutUrl: `${hostedBase}?token=${encodeURIComponent(hostedToken)}`, gateway });
  } catch (e) { next(e); }
});

customerPortalRouter.post('/payment/:token/confirm', async (req, res, next) => {
  try {
    const token = String(req.params.token || '');
    const reservation = await findReservationByToken('payment', token);
    if (!reservation) return res.status(404).json({ error: 'Invalid or expired payment link' });
    const gatewayConfig = await paymentGatewayConfigForTenant(reservation.tenantId || null);
    const gateway = currentGateway(gatewayConfig);

    let paidAmount = 0;
    let reference = String(req.body?.reference || '').trim();

    if (gateway === 'stripe' && req.body?.sessionId) {
      if (!stripeEnabled(gatewayConfig)) return res.status(400).json({ error: 'Stripe not configured for this tenant' });
      const stripe = new Stripe(gatewayConfig.stripe.secretKey);
      const session = await stripe.checkout.sessions.retrieve(String(req.body.sessionId));
      if (!session || session.payment_status !== 'paid') return res.status(400).json({ error: 'Stripe payment not completed' });
      paidAmount = Number(((session.amount_total || 0) / 100).toFixed(2));
      reference = `STRIPE:${session.id}`;
    } else {
      return res.status(400).json({
        error: gateway === 'stripe'
          ? 'Stripe sessionId is required'
          : `Public payment confirmation is disabled for ${String(gateway || 'this gateway').toUpperCase()}. Use verified gateway callbacks or internal reconciliation.`
      });
    }

    await postPayment({ reservation, paidAmount, reference, gateway });

    let savedCardOnFile = false;
    try {
      if (gateway === 'authorizenet') {
        savedCardOnFile = await trySaveAuthNetCardOnFileFromTransaction({ reservation, reference });
      }
    } catch {}

    const refreshed = await findReservationByToken('payment', token);
    res.json({ ok: true, paidAmount, savedCardOnFile, portal: refreshed ? await buildPortalSummary(refreshed, 'payment', token) : null });
  } catch (e) { next(e); }
});

customerPortalRouter.get('/document/:kind/:token/:asset', async (req, res, next) => {
  try {
    const kind = String(req.params.kind || '').trim();
    const token = String(req.params.token || '').trim();
    const asset = String(req.params.asset || '').trim().toLowerCase();
    if (!['customer-info', 'signature', 'payment'].includes(kind)) {
      return res.status(400).json({ error: 'Unsupported portal kind' });
    }

    const reservation = await findReservationByToken(kind, token);
    if (!reservation) return res.status(404).json({ error: 'Invalid or expired portal link' });

    const agreement = await latestAgreementForReservation(reservation.id);
    const payments = mergePayments(reservation, agreement);

    if (asset === 'agreement') {
      if (!agreement?.id) return res.status(404).json({ error: 'Agreement not available' });
      const pdf = await rentalAgreementsService.agreementPdfBuffer(agreement.id);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${agreement.agreementNumber || reservation.reservationNumber || 'agreement'}.pdf"`);
      return res.send(pdf);
    }

    if (asset === 'receipt') {
      if (!payments.length) return res.status(404).json({ error: 'Receipt not available yet' });
      const text = paymentReceiptText({ reservation, agreement, payments });
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${reservation.reservationNumber || 'receipt'}-receipt.txt"`);
      return res.send(text);
    }

    return res.status(404).json({ error: 'Document not available' });
  } catch (e) {
    next(e);
  }
});
