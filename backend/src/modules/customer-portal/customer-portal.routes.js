import { Router } from 'express';
import Stripe from 'stripe';
import { prisma } from '../../lib/prisma.js';
import { sendEmail } from '../../lib/mailer.js';
import { rentalAgreementsService } from '../rental-agreements/rental-agreements.service.js';

export const customerPortalRouter = Router();

const PAYMENT_GATEWAY = (process.env.PAYMENT_GATEWAY || 'authorizenet').toLowerCase(); // authorizenet|stripe|square

const AUTHNET_ENV = (process.env.AUTHNET_ENV || 'sandbox').toLowerCase();
const AUTHNET_API = AUTHNET_ENV === 'production' ? 'https://api2.authorize.net/xml/v1/request.api' : 'https://apitest.authorize.net/xml/v1/request.api';

const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;

function portalBase() {
  return process.env.CUSTOMER_PORTAL_BASE_URL || 'http://localhost:3000';
}

function authNetEnabled() {
  return !!(process.env.AUTHNET_API_LOGIN_ID && process.env.AUTHNET_TRANSACTION_KEY);
}
function stripeEnabled() {
  return !!stripe;
}
function squareEnabled() {
  return !!(process.env.SQUARE_ACCESS_TOKEN && process.env.SQUARE_LOCATION_ID);
}

function currentGateway() {
  return ['authorizenet', 'stripe', 'square'].includes(PAYMENT_GATEWAY) ? PAYMENT_GATEWAY : 'authorizenet';
}

async function authNetRequest(payload) {
  const r = await fetch(AUTHNET_API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  return r.json();
}

async function trySaveAuthNetCardOnFileFromTransaction({ reservation, reference }) {
  if (!authNetEnabled()) return false;
  const rawRef = String(reference || '').trim();
  const transId = rawRef.startsWith('AUTHNET:') ? rawRef.slice('AUTHNET:'.length).trim() : rawRef;
  if (!transId) return false;

  const reqPayload = {
    createCustomerProfileFromTransactionRequest: {
      merchantAuthentication: {
        name: process.env.AUTHNET_API_LOGIN_ID,
        transactionKey: process.env.AUTHNET_TRANSACTION_KEY
      },
      transId
    }
  };

  const out = await authNetRequest(reqPayload);
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
  if (kind === 'signature') {
    return prisma.reservation.findFirst({
      where: { signatureToken: token, signatureTokenExpiresAt: { gt: new Date() } },
      include: { customer: true, pickupLocation: true, returnLocation: true, vehicle: true }
    });
  }
  if (kind === 'payment') {
    return prisma.reservation.findFirst({
      where: { paymentRequestToken: token, paymentRequestTokenExpiresAt: { gt: new Date() } },
      include: { customer: true, pickupLocation: true, returnLocation: true, vehicle: true }
    });
  }
  return null;
}

function paidFromReservationNotes(notes) {
  const txt = String(notes || '');
  let sum = 0;
  const re = /^\[PAYMENT\s+[^\]]+\]\s+[^\s]+\s+paid\s+([0-9]+(?:\.[0-9]+)?)/gim;
  let m;
  while ((m = re.exec(txt)) !== null) {
    const amt = Number(m[1] || 0);
    if (Number.isFinite(amt) && amt > 0) sum += amt;
  }
  return Number(sum.toFixed(2));
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
  const tenantWhere = reservation?.tenantId ? { tenantId: reservation.tenantId } : {};
  const notes = String(reservation?.notes || '');
  const m = notes.match(/\[RES_CHARGES_META\](\{[\s\S]*\})/);
  const pickupAt = new Date(reservation?.pickupAt || Date.now());
  const returnAt = new Date(reservation?.returnAt || Date.now());
  const days = Math.max(1, Math.ceil((returnAt - pickupAt) / (1000 * 60 * 60 * 24)));

  if (!m) {
    const dailyRate = Number(reservation?.dailyRate || 0);
    const base = Number((dailyRate * days).toFixed(2));
    const lines = [{ name: 'Daily', qty: days, rate: dailyRate, total: base }];

    let feesTotal = 0;
    if (isUnderageReservation(reservation)) {
      const underageFees = await prisma.fee.findMany({ where: { ...tenantWhere, isActive: true, isUnderageFee: true } });
      for (const f of underageFees) {
        const amt = Number(f?.amount || 0);
        const mode = String(f?.mode || 'FIXED').toUpperCase();
        const total = Number((mode === 'PERCENTAGE' ? (base * (amt / 100)) : amt).toFixed(2));
        feesTotal += total;
        lines.push({ name: f.name, qty: 1, rate: mode === 'PERCENTAGE' ? `${amt}%` : amt, total });
      }
    }

    const subtotal = Number((base + feesTotal).toFixed(2));
    const taxRate = Number(reservation?.pickupLocation?.taxRate || 0);
    const tax = Number((subtotal * (taxRate / 100)).toFixed(2));
    const total = Number((subtotal + tax).toFixed(2));

    return { lines, subtotal, tax, total };
  }

  let meta;
  try { meta = JSON.parse(m[1]); } catch { meta = null; }
  if (!meta) {
    const est = Number(reservation?.estimatedTotal || 0);
    return { lines: [], subtotal: est, tax: 0, total: est };
  }

  const selectedServiceIds = Array.isArray(meta?.selectedServices) ? meta.selectedServices : [];
  const hasAdditionalDrivers = Array.isArray(readMetaBlock(reservation?.notes, "RES_ADDITIONAL_DRIVERS")?.drivers) && readMetaBlock(reservation?.notes, "RES_ADDITIONAL_DRIVERS")?.drivers?.length > 0;
  const selectedFeeIds = Array.isArray(meta?.selectedFees) ? meta.selectedFees : [];
  const discounts = Array.isArray(meta?.discounts) ? meta.discounts : [];

  const underageAutoFees = isUnderageReservation(reservation)
    ? await prisma.fee.findMany({ where: { ...tenantWhere, isActive: true, isUnderageFee: true }, select: { id: true } })
    : [];
  const addlDriverAutoFees = hasAdditionalDrivers
    ? await prisma.fee.findMany({ where: { ...tenantWhere, isActive: true, isAdditionalDriverFee: true }, select: { id: true } })
    : [];
  const mergedFeeIds = [...new Set([...selectedFeeIds, ...underageAutoFees.map((f) => f.id), ...addlDriverAutoFees.map((f) => f.id)])];

  const [services, fees] = await Promise.all([
    selectedServiceIds.length ? prisma.additionalService.findMany({ where: { ...tenantWhere, id: { in: selectedServiceIds } } }) : Promise.resolve([]),
    mergedFeeIds.length ? prisma.fee.findMany({ where: { ...tenantWhere, id: { in: mergedFeeIds } } }) : Promise.resolve([])
  ]);

  const dailyRate = Number(meta?.dailyRate ?? reservation?.dailyRate ?? 0);
  const taxRate = Number(meta?.taxRate ?? 0);
  const lines = [];

  const base = Number((dailyRate * days).toFixed(2));
  lines.push({ name: 'Daily', qty: days, rate: dailyRate, total: base });

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
    prisma.reservation.findUnique({ where: { id: reservationId }, include: { customer: { select: { dateOfBirth: true } }, pickupLocation: { select: { locationConfig: true, taxRate: true } } } })
  ]);

  const breakdown = reservation ? await buildReservationBreakdown(reservation) : null;
  const est = Number(breakdown?.total ?? reservation?.estimatedTotal ?? fallbackEstimated ?? 0);
  const paid = paidFromReservationNotes(reservation?.notes);
  const reservationOutstanding = Math.max(0, Number((est - paid).toFixed(2)));

  const depMatch = String(reservation?.notes || '').match(/\[RES_DEPOSIT_META\](\{[\s\S]*\})/);
  let depositDueNow = null;
  if (depMatch) {
    try {
      const d = JSON.parse(depMatch[1]);
      if (d?.requireDeposit) {
        const dep = Number(d?.depositAmountDue || 0);
        if (Number.isFinite(dep) && dep > 0) depositDueNow = Math.max(0, Number((dep - paid).toFixed(2)));
      }
    } catch {}
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
  const latestAgreement = await prisma.rentalAgreement.findFirst({ where: { reservationId: reservation.id }, orderBy: { createdAt: 'desc' } });
  if (latestAgreement) {
    const nextBalance = Math.max(0, Number((Number(latestAgreement.balance || 0) - paidAmount).toFixed(2)));
    await prisma.rentalAgreement.update({
      where: { id: latestAgreement.id },
      data: { balance: nextBalance, paidAmount: Number((Number(latestAgreement.paidAmount || 0) + paidAmount).toFixed(2)) }
    });
    await prisma.rentalAgreementPayment.create({
      data: {
        rentalAgreementId: latestAgreement.id,
        method: 'CARD',
        amount: paidAmount,
        reference,
        status: 'PAID',
        notes: `Paid via ${gateway} customer payment portal`
      }
    });
  }

  const note = `[PAYMENT ${new Date().toISOString()}] ${gateway} paid ${paidAmount.toFixed(2)} ref=${reference}`;
  await prisma.reservation.update({
    where: { id: reservation.id },
    data: {
      paymentRequestToken: null,
      paymentRequestTokenExpiresAt: null,
      notes: reservation.notes ? `${reservation.notes}\n${note}` : note
    }
  });

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
          subtotal: Number(reservation.estimatedTotal || 0),
          taxes: 0,
          total: Number(reservation.estimatedTotal || 0),
          paidAmount: 0,
          balance: Number(reservation.estimatedTotal || 0),
          charges: []
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
      termsText: agreementCfg?.termsText || 'Standard rental terms apply.'
    });
  } catch (e) { next(e); }
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
        signatureToken: null,
        signatureTokenExpiresAt: null,
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

    res.json({ ok: true, emailedSignedAgreement, message: emailedSignedAgreement ? 'Signature captured. Signed agreement has been sent to your email.' : 'Signature captured successfully.' });
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
    const gateway = currentGateway();
    const gatewayReady = gateway === 'authorizenet' ? authNetEnabled() : gateway === 'stripe' ? stripeEnabled() : squareEnabled();

    res.json({
      reservation: {
        id: reservation.id,
        reservationNumber: reservation.reservationNumber,
        customerName: `${reservation.customer?.firstName || ''} ${reservation.customer?.lastName || ''}`.trim(),
        customerEmail: reservation.customer?.email || null
      },
      amountDue: Number(amountDue.toFixed(2)),
      breakdown,
      gateway,
      gatewayReady
    });
  } catch (e) { next(e); }
});

customerPortalRouter.post('/payment/:token/create-session', async (req, res, next) => {
  try {
    const gateway = currentGateway();
    const token = String(req.params.token || '');
    const reservation = await findReservationByToken('payment', token);
    if (!reservation) return res.status(404).json({ error: 'Invalid or expired payment link' });
    const amountDue = await amountDueForReservation(reservation.id, reservation.estimatedTotal);

    if (gateway === 'stripe') {
      if (!stripeEnabled()) return res.status(400).json({ error: 'Stripe is not configured (STRIPE_SECRET_KEY)' });
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
      if (!squareEnabled()) return res.status(400).json({ error: 'Square is not configured (SQUARE_ACCESS_TOKEN / SQUARE_LOCATION_ID)' });
      const resp = await fetch('https://connect.squareup.com/v2/online-checkout/payment-links', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.SQUARE_ACCESS_TOKEN}`,
          'Square-Version': '2024-12-18'
        },
        body: JSON.stringify({
          idempotency_key: `${reservation.id}-${Date.now()}`,
          quick_pay: {
            name: `Reservation ${reservation.reservationNumber} Payment`,
            price_money: { amount: Math.round(Number(amountDue || 0) * 100), currency: 'USD' },
            location_id: process.env.SQUARE_LOCATION_ID
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
    if (!authNetEnabled()) return res.status(400).json({ error: 'Authorize.Net is not configured (AUTHNET_API_LOGIN_ID / AUTHNET_TRANSACTION_KEY)' });
    const amount = Number(Math.max(0.5, Number(amountDue || 0))).toFixed(2);
    const returnUrl = `${portalBase().replace(/\/$/, '')}/customer/pay?token=${encodeURIComponent(token)}&success=1`;
    const cancelUrl = `${portalBase().replace(/\/$/, '')}/customer/pay?token=${encodeURIComponent(token)}&canceled=1`;

    const requestPayload = {
      getHostedPaymentPageRequest: {
        merchantAuthentication: { name: process.env.AUTHNET_API_LOGIN_ID, transactionKey: process.env.AUTHNET_TRANSACTION_KEY },
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

    const authnet = await authNetRequest(requestPayload);
    const response = authnet?.getHostedPaymentPageResponse;
    const hostedToken = response?.token;
    if (response?.messages?.resultCode !== 'Ok' || !hostedToken) {
      return res.status(400).json({ error: response?.messages?.message?.[0]?.text || 'Authorize.Net token creation failed' });
    }

    const hostedBase = AUTHNET_ENV === 'production' ? 'https://accept.authorize.net/payment/payment' : 'https://test.authorize.net/payment/payment';
    res.json({ checkoutUrl: `${hostedBase}?token=${encodeURIComponent(hostedToken)}`, gateway });
  } catch (e) { next(e); }
});

customerPortalRouter.post('/payment/:token/confirm', async (req, res, next) => {
  try {
    const gateway = currentGateway();
    const token = String(req.params.token || '');
    const reservation = await findReservationByToken('payment', token);
    if (!reservation) return res.status(404).json({ error: 'Invalid or expired payment link' });

    let paidAmount = 0;
    let reference = String(req.body?.reference || '').trim();

    if (gateway === 'stripe' && req.body?.sessionId) {
      if (!stripeEnabled()) return res.status(400).json({ error: 'Stripe not configured' });
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

    res.json({ ok: true, paidAmount, savedCardOnFile });
  } catch (e) { next(e); }
});
