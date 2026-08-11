import crypto from 'node:crypto';
import { Router } from 'express';
import Stripe from 'stripe';
import { prisma } from '../../lib/prisma.js';
import { decideAmountDue } from './amount-due.js';
import { buildGatewayReference } from '../../lib/payment-references.js';
import { sendEmail } from '../../lib/mailer.js';
import { renderBrandedEmail, resolveEmailBrand } from '../../lib/email-template.js';
import { rentalAgreementsService } from '../rental-agreements/rental-agreements.service.js';
import { reservationPricingService } from '../reservations/reservation-pricing.service.js';
import { settingsService } from '../settings/settings.service.js';
import { enrichPrecheckinCatalog } from '../../lib/precheckin-catalog.js';
import { buildSelfServiceSnapshot } from './customer-portal-self-service.js';
import { parseLocationConfig } from '../../lib/location-config.js';
import { parseDepositRules, evaluateDepositRule, parseDepositRuleDecision } from '../../lib/deposit-rules.js';
import logger from '../../lib/logger.js';
import { normalizeDob } from '../../lib/dob.js';
import { getEffectiveTermsHtml } from '../../lib/terms/index.js';
import { TC_VERSION } from '../../lib/terms/version.js';
import { analyzeSignatureInk } from '../../lib/signature-ink.js';
import {
  attachPublicRequestMeta,
  createPublicRateLimitGuard
} from '../../middleware/public-endpoint-guards.js';
import {
  materializeDocumentRef,
  maybeUploadCustomerDocument
} from '../customers/customer-documents.js';

export const customerPortalRouter = Router();

// Per-IP rate-limit guards for public token-based portal endpoints. Token
// entropy is 192 bits so brute force is infeasible, but these guards cap
// DoS amplification and token-existence enumeration probes. See
// doc/security-audit-2026-05-19.md §H1.
const portalRead = [
  attachPublicRequestMeta('customer-portal-read'),
  createPublicRateLimitGuard({ name: 'customer-portal-read', maxRequests: 120, windowMs: 60 * 1000 })
];
const portalWrite = [
  attachPublicRequestMeta('customer-portal-write'),
  createPublicRateLimitGuard({ name: 'customer-portal-write', maxRequests: 30, windowMs: 60 * 1000 })
];
const portalWebhook = [
  attachPublicRequestMeta('customer-portal-webhook'),
  createPublicRateLimitGuard({ name: 'customer-portal-webhook', maxRequests: 120, windowMs: 60 * 1000 })
];

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
function authNetPortalReady(config = {}) {
  return authNetEnabled(config);
}
function authNetWebhookReady(config = {}) {
  return !!(authNetEnabled(config) && String(config?.authorizenet?.signatureKey || '').trim());
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

function extractAuthNetMessage(payload) {
  const roots = [
    payload?.getHostedPaymentPageResponse,
    payload?.createTransactionResponse,
    payload?.createCustomerProfileFromTransactionResponse,
    payload?.createCustomerProfileResponse,
    payload
  ].filter(Boolean);

  for (const root of roots) {
    const direct = root?.messages?.message;
    const list = Array.isArray(direct) ? direct : direct ? [direct] : [];
    const text = list.map((item) => String(item?.text || '').trim()).find(Boolean);
    if (text) return text;

    const errorList = Array.isArray(root?.transactionResponse?.errors?.error)
      ? root.transactionResponse.errors.error
      : root?.transactionResponse?.errors?.error
        ? [root.transactionResponse.errors.error]
        : [];
    const errorText = errorList.map((item) => String(item?.errorText || item?.text || '').trim()).find(Boolean);
    if (errorText) return errorText;
  }

  return '';
}

async function authNetRequest(payload, config = {}) {
  const r = await fetch(authNetApiForConfig(config), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  const raw = await r.text();
  let parsed = null;
  try {
    parsed = raw ? JSON.parse(raw) : {};
  } catch {
    parsed = { raw };
  }
  return {
    ok: r.ok,
    status: r.status,
    raw,
    body: parsed
  };
}

async function trySaveAuthNetCardOnFileFromTransaction({ reservation, reference }) {
  const config = await paymentGatewayConfigForTenant(reservation?.tenantId || null);
  if (!authNetEnabled(config)) return false;
  if (!reservation?.customerId) return false;
  const customer = await prisma.customer.findUnique({
    where: { id: reservation.customerId },
    select: {
      authnetCustomerProfileId: true,
      authnetPaymentProfileId: true
    }
  });
  if (customer?.authnetCustomerProfileId && customer?.authnetPaymentProfileId) {
    return true;
  }
  const rawRef = String(reference || '').trim();
  const transId = rawRef.startsWith('AUTHNET:') ? rawRef.slice('AUTHNET:'.length).trim() : rawRef;
  if (!transId) return false;

  const buildRequest = () => ({
      createCustomerProfileFromTransactionRequest: {
        merchantAuthentication: {
          name: config.authorizenet.loginId,
          transactionKey: config.authorizenet.transactionKey
        },
        transId
      }
    });

  let out = await authNetRequest(buildRequest(), config);
  const payload = out?.body || {};
  let resp = payload?.createCustomerProfileResponse || payload?.createCustomerProfileFromTransactionResponse || payload;
  let message = extractAuthNetMessage(resp);
  if (
    resp?.messages?.resultCode !== 'Ok'
    && /customer info is missing/i.test(String(message || ''))
    && reservation?.customerId
  ) {
    const customerProfileId = await authNetEnsureCustomerProfileForReservation(reservation, config);
    out = await authNetRequest({
      createCustomerProfileFromTransactionRequest: {
        merchantAuthentication: {
          name: config.authorizenet.loginId,
          transactionKey: config.authorizenet.transactionKey
        },
        transId,
        customerProfileId
      }
    }, config);
    const retryPayload = out?.body || {};
    resp = retryPayload?.createCustomerProfileResponse || retryPayload?.createCustomerProfileFromTransactionResponse || retryPayload;
    message = extractAuthNetMessage(resp);
  }
  const ok = resp?.messages?.resultCode === 'Ok';
  if (!ok) {
    const duplicateProfileId = authNetDuplicateProfileId(message);
    if (!duplicateProfileId) return false;
    try {
      const profileResp = await authNetCustomerProfile(duplicateProfileId, config);
      const paymentProfileId = authNetExtractPaymentProfileId(profileResp);
      if (!paymentProfileId) return false;
      await prisma.customer.update({
        where: { id: reservation.customerId },
        data: {
          authnetCustomerProfileId: String(duplicateProfileId),
          authnetPaymentProfileId: String(paymentProfileId)
        }
      });
      return true;
    } catch {
      return false;
    }
  }

  const customerProfileId = resp?.customerProfileId || null;
  const paymentProfileId = Array.isArray(resp?.customerPaymentProfileIdList?.numericString)
    ? resp.customerPaymentProfileIdList.numericString[0]
    : (resp?.customerPaymentProfileIdList?.numericString || null);

  const resolvedCustomerProfileId = String(customerProfileId || '').trim();
  let resolvedPaymentProfileId = String(paymentProfileId || '').trim();
  if (resolvedCustomerProfileId && !resolvedPaymentProfileId) {
    const profileResp = await authNetCustomerProfile(resolvedCustomerProfileId, config);
    resolvedPaymentProfileId = authNetExtractPaymentProfileId(profileResp);
  }

  if (!resolvedCustomerProfileId || !resolvedPaymentProfileId) return false;

  await prisma.customer.update({
    where: { id: reservation.customerId },
    data: {
      authnetCustomerProfileId: resolvedCustomerProfileId,
      authnetPaymentProfileId: resolvedPaymentProfileId
    }
  });
  return true;
}

async function getAuthNetTransactionDetails(transId, config = {}) {
  const cleanTransId = String(transId || '').trim();
  if (!cleanTransId) throw new Error('Authorize.Net transId is required');
  const out = await authNetRequest({
    getTransactionDetailsRequest: {
      merchantAuthentication: {
        name: config.authorizenet.loginId,
        transactionKey: config.authorizenet.transactionKey
      },
      transId: cleanTransId
    }
  }, config);
  return out?.body?.getTransactionDetailsResponse || out?.body || {};
}

function authNetDuplicateProfileId(message = '') {
  const text = String(message || '').trim();
  const match = text.match(/\bduplicate record with ID\s+(\d+)\b/i) || text.match(/\brecord with ID\s+(\d+)\b/i);
  return match?.[1] ? String(match[1]).trim() : '';
}

async function authNetEnsureCustomerProfileForReservation(reservation, config = {}) {
  const customerId = String(reservation?.customer?.id || reservation?.customerId || '').trim();
  if (!customerId) throw new Error('Customer not found');

  const existing = await prisma.customer.findUnique({
    where: { id: customerId },
    select: { authnetCustomerProfileId: true }
  });
  const existingProfileId = String(existing?.authnetCustomerProfileId || '').trim();
  if (existingProfileId) return existingProfileId;

  const profilePayload = authNetCompactObject({
    merchantCustomerId: authNetCustomerIdValue(customerId, reservation?.id || ''),
    email: authNetCleanValue(reservation?.customer?.email || '', ''),
    description: authNetCleanValue([reservation?.customer?.firstName, reservation?.customer?.lastName].filter(Boolean).join(' '), '')
  });

  const out = await authNetRequest({
    createCustomerProfileRequest: {
      merchantAuthentication: {
        name: config.authorizenet.loginId,
        transactionKey: config.authorizenet.transactionKey
      },
      profile: profilePayload
    }
  }, config);
  const resp = out?.body?.createCustomerProfileResponse || out?.body || {};

  if (String(resp?.messages?.resultCode || '').trim() !== 'Ok') {
    const duplicateProfileId = authNetDuplicateProfileId(extractAuthNetMessage(resp));
    if (!duplicateProfileId) throw new Error(extractAuthNetMessage(resp) || 'Unable to create Authorize.Net customer profile');
    await prisma.customer.update({
      where: { id: customerId },
      data: { authnetCustomerProfileId: String(duplicateProfileId) }
    });
    return String(duplicateProfileId);
  }

  const customerProfileId = String(resp?.customerProfileId || '').trim();
  if (!customerProfileId) throw new Error('Authorize.Net did not return a customer profile ID');
  await prisma.customer.update({
    where: { id: customerId },
    data: { authnetCustomerProfileId: customerProfileId }
  });
  return customerProfileId;
}

async function authNetCustomerProfile(profileId, config = {}) {
  const cleanProfileId = String(profileId || '').trim();
  if (!cleanProfileId) throw new Error('Authorize.Net customerProfileId is required');
  const out = await authNetRequest({
    getCustomerProfileRequest: {
      merchantAuthentication: {
        name: config.authorizenet.loginId,
        transactionKey: config.authorizenet.transactionKey
      },
      customerProfileId: cleanProfileId
    }
  }, config);
  return out?.body?.getCustomerProfileResponse || out?.body || {};
}

function authNetExtractPaymentProfileId(profileResp = {}) {
  const profile = profileResp?.profile || profileResp?.customerProfile || null;
  const paymentProfiles = Array.isArray(profile?.paymentProfiles)
    ? profile.paymentProfiles
    : profile?.paymentProfiles
      ? [profile.paymentProfiles]
      : [];
  return paymentProfiles
    .map((row) => row?.customerPaymentProfileId || row?.paymentProfileId || '')
    .map((value) => String(value || '').trim())
    .find(Boolean) || '';
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

function parseAuditMetadata(raw) {
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

async function getSelfServiceConfirmations(reservationId) {
  if (!reservationId) {
    return {
      pickup: { confirmedAt: null, reason: '', note: '' },
      dropoff: { confirmedAt: null, reason: '', note: '' }
    };
  }
  const logs = await prisma.auditLog.findMany({
    where: {
      reservationId,
      action: 'UPDATE'
    },
    orderBy: { createdAt: 'desc' },
    take: 50,
    select: {
      createdAt: true,
      metadata: true
    }
  });
  const out = {
    pickup: { confirmedAt: null, reason: '', note: '' },
    dropoff: { confirmedAt: null, reason: '', note: '' }
  };
  for (const log of logs) {
    const metadata = parseAuditMetadata(log.metadata);
    if (!out.pickup.confirmedAt && metadata?.selfServiceEvent === 'PICKUP_CONFIRMED') {
      out.pickup = {
        confirmedAt: metadata?.confirmedAt || log.createdAt?.toISOString?.() || log.createdAt || null,
        reason: String(metadata?.reason || '').trim(),
        note: String(metadata?.note || '').trim()
      };
    }
    if (!out.dropoff.confirmedAt && metadata?.selfServiceEvent === 'DROPOFF_CONFIRMED') {
      out.dropoff = {
        confirmedAt: metadata?.confirmedAt || log.createdAt?.toISOString?.() || log.createdAt || null,
        reason: String(metadata?.reason || '').trim(),
        note: String(metadata?.note || '').trim()
      };
    }
  }
  return out;
}

function mergePayments(reservation, agreement) {
  const seen = new Set();
  const rows = [...(Array.isArray(reservation?.payments) ? reservation.payments : []), ...(Array.isArray(agreement?.payments) ? agreement.payments : [])];
  return rows.filter((payment) => {
    const reference = String(payment?.reference || '').trim().toUpperCase();
    const amount = Number(payment?.amount || 0).toFixed(2);
    const paidAt = payment?.paidAt || payment?.createdAt || null;
    const paidAtKey = paidAt ? new Date(paidAt).toISOString() : '';
    const fallbackId = String(payment?.id || '').trim();
    const dedupeKey = reference
      ? `ref:${reference}|amt:${amount}`
      : `row:${fallbackId}|amt:${amount}|at:${paidAtKey}`;
    if (seen.has(dedupeKey)) return false;
    seen.add(dedupeKey);
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

function authNetCleanValue(value, fallback = '') {
  const text = String(value ?? fallback ?? '').trim();
  return text.replace(/\s+/g, ' ').slice(0, 255);
}

function authNetInvoiceNumberValue(value = '') {
  return String(value || '')
    .trim()
    .replace(/\s+/g, ' ')
    .slice(0, 20);
}

function authNetCustomerIdValue(customerId = '', reservationId = '') {
  const seed = String(customerId || reservationId || '').trim();
  if (!seed) return '';
  const compact = seed.replace(/[^a-z0-9]/gi, '').slice(0, 20);
  if (compact.length >= 6 && compact.length <= 20) return compact;
  return `RF${crypto.createHash('sha1').update(seed).digest('hex').slice(0, 18)}`;
}

function authNetCompactObject(obj = {}) {
  return Object.fromEntries(
    Object.entries(obj).filter(([, value]) => String(value ?? '').trim() !== '')
  );
}

function authNetSignatureKeyHex(value = '') {
  return String(value || '').replace(/[^a-fA-F0-9]/g, '').trim();
}

function authNetSafeHexEqual(expectedHex = '', actualHex = '') {
  if (!expectedHex || !actualHex || expectedHex.length !== actualHex.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(expectedHex, 'hex'), Buffer.from(actualHex, 'hex'));
  } catch {
    return false;
  }
}

function authNetVerifyWebhookSignature(rawBody = '', header = '', signatureKey = '') {
  const payloadBuffer = Buffer.isBuffer(rawBody)
    ? rawBody
    : Buffer.from(String(rawBody || ''), 'utf8');
  const signatureHex = authNetSignatureKeyHex(signatureKey);
  const signatureText = String(signatureKey || '').trim();
  const rawHeader = String(header || '').trim();
  if (!payloadBuffer.length || !signatureHex || !rawHeader) return { ok: false, expectedHex: '', actualHex: '' };

  const actualHex = String(rawHeader.toLowerCase().startsWith('sha512=') ? rawHeader.slice(7) : rawHeader)
    .trim()
    .toLowerCase();
  if (!actualHex || actualHex.length % 2 !== 0) return { ok: false, expectedHex: '', actualHex };

  try {
    const expectedHexBinary = crypto
      .createHmac('sha512', Buffer.from(signatureHex, 'hex'))
      .update(payloadBuffer)
      .digest('hex')
      .toLowerCase();
    const expectedHexLatin1 = signatureText
      ? crypto.createHmac('sha512', Buffer.from(signatureText, 'latin1')).update(payloadBuffer).digest('hex').toLowerCase()
      : '';

    const matchesBinary = authNetSafeHexEqual(expectedHexBinary, actualHex);
    const matchesLatin1 = authNetSafeHexEqual(expectedHexLatin1, actualHex);

    return {
      ok: matchesBinary || matchesLatin1,
      expectedHex: expectedHexBinary,
      expectedHexAlt: expectedHexLatin1,
      actualHex,
      method: matchesBinary ? 'hex-bytes' : matchesLatin1 ? 'latin1-text' : ''
    };
  } catch {
    return { ok: false, expectedHex: '', actualHex };
  }
}

async function authNetWebhookConfigs() {
  const rows = await prisma.appSetting.findMany({
    where: {
      OR: [
        { key: 'paymentGatewayConfig' },
        { key: { endsWith: ':paymentGatewayConfig' } }
      ]
    },
    select: {
      key: true,
      value: true
    }
  });

  const configs = [];
  for (const row of rows) {
    try {
      const parsed = JSON.parse(row.value || '{}') || {};
      if (!authNetWebhookReady(parsed)) continue;
      const key = String(row.key || '').trim();
      const tenantId = key.startsWith('tenant:') ? key.split(':')[1] || null : null;
      configs.push({
        tenantId,
        config: parsed,
        signatureKey: String(parsed?.authorizenet?.signatureKey || '').trim()
      });
    } catch {}
  }

  if (!configs.some((row) => !row.tenantId)) {
    try {
      const rootConfig = await settingsService.getPaymentGatewayConfig({});
      if (authNetWebhookReady(rootConfig)) {
        configs.push({
          tenantId: null,
          config: rootConfig,
          signatureKey: String(rootConfig?.authorizenet?.signatureKey || '').trim()
        });
      }
    } catch {}
  }

  return configs;
}

function authNetSignatureFingerprint(value = '') {
  const hex = authNetSignatureKeyHex(value);
  if (!hex) return '';
  return `${hex.slice(0, 6)}...${hex.slice(-6)} (${hex.length})`;
}

async function authNetWebhookConfigForRequest(req) {
  const rawBody = Buffer.isBuffer(req.rawBodyBuffer) && req.rawBodyBuffer.length
    ? req.rawBodyBuffer
    : Buffer.from(String(req.rawBody || ''), 'utf8');
  const signatureHeader = String(req.get('X-ANET-Signature') || req.get('x-anet-signature') || '').trim();
  if (!rawBody.length || !signatureHeader) return null;
  const configs = await authNetWebhookConfigs();
  const attempts = configs.map((row) => ({
    row,
    result: authNetVerifyWebhookSignature(rawBody, signatureHeader, row.signatureKey)
  }));
  const match = attempts.find((entry) => entry.result?.ok)?.row || null;
  if (match) return match;
  return {
    _invalidSignature: true,
    debug: {
      configCount: configs.length,
      headerPrefix: String(signatureHeader || '').slice(0, 24),
      tenants: attempts.map((entry) => ({
        tenantId: entry.row.tenantId || 'global',
        fingerprint: authNetSignatureFingerprint(entry.row.signatureKey),
        expectedPrefix: String(entry.result?.expectedHex || '').slice(0, 24),
        expectedAltPrefix: String(entry.result?.expectedHexAlt || '').slice(0, 24),
        actualPrefix: String(entry.result?.actualHex || '').slice(0, 24)
      }))
    }
  };
}

async function findReservationByAuthNetInvoiceNumber(invoiceNumber = '') {
  const normalized = authNetInvoiceNumberValue(invoiceNumber);
  if (!normalized) return null;
  return prisma.reservation.findFirst({
    where: { reservationNumber: normalized },
    include: { customer: true }
  });
}

async function postAuthNetPaymentToReservation({ reservation, transId, gatewayConfig, token = '', origin = 'WEBHOOK' }) {
  const cleanTransId = String(transId || '').trim();
  if (!reservation?.id || !cleanTransId) throw new Error('Reservation and Authorize.Net transId are required');

  const reference = buildGatewayReference('AUTHNET', cleanTransId);
  const existing = await prisma.reservationPayment.findFirst({
    where: {
      reservationId: reservation.id,
      reference
    }
  });
  if (existing) {
    let savedCardOnFile = !!(reservation?.customer?.authnetCustomerProfileId && reservation?.customer?.authnetPaymentProfileId);
    if (!savedCardOnFile) {
      try {
        savedCardOnFile = await trySaveAuthNetCardOnFileFromTransaction({ reservation, reference });
      } catch {}
    }
    let portal = null;
    if (token) {
      try {
        const refreshed = await findReservationByToken('payment', token);
        portal = refreshed ? await buildPortalSummary(refreshed, 'payment', token) : null;
      } catch {}
    }
    return {
      ok: true,
      duplicate: true,
      reference,
      amount: Number(existing.amount || 0),
      savedCardOnFile,
      portal
    };
  }

  const details = await getAuthNetTransactionDetails(cleanTransId, gatewayConfig);
  const tx = details?.transaction || {};
  const resultCode = String(details?.messages?.resultCode || '').trim();
  const responseCode = String(tx?.responseCode || '').trim();
  const txStatus = String(tx?.transactionStatus || '').trim();
  const allowedStatuses = new Set(['capturedPendingSettlement', 'settledSuccessfully']);
  if (resultCode !== 'Ok' || responseCode !== '1' || !allowedStatuses.has(txStatus)) {
    throw new Error(extractAuthNetMessage(details) || `Authorize.Net payment is not yet captured (${txStatus || 'unknown'})`);
  }

  const paidAmount = Number(tx?.authAmount || tx?.settleAmount || 0);
  if (!(paidAmount > 0)) throw new Error('Authorize.Net payment amount is missing');

  await reservationPricingService.postPayment(reservation.id, {
    amount: paidAmount,
    method: 'CARD',
    reference,
    status: 'PAID',
    origin,
    gateway: 'authorizenet',
    paidAt: tx?.submitTimeUTC || tx?.submitTimeLocal || undefined,
    notes: origin === 'WEBHOOK'
      ? 'Posted from Authorize.Net webhook'
      : 'Posted from Authorize.Net confirmation'
  }, reservation?.tenantId ? { tenantId: reservation.tenantId } : {});

  let savedCardOnFile = false;
  try {
    savedCardOnFile = await trySaveAuthNetCardOnFileFromTransaction({ reservation, reference });
  } catch {}

  let portal = null;
  if (token) {
    try {
      const refreshed = await findReservationByToken('payment', token);
      portal = refreshed ? await buildPortalSummary(refreshed, 'payment', token) : null;
    } catch {}
  }

  return {
    ok: true,
    duplicate: false,
    reference,
    amount: paidAmount,
    savedCardOnFile,
    portal
  };
}

function isSecurityDepositCharge(row = {}) {
  const source = String(row?.source || '').trim().toUpperCase();
  const name = String(row?.name || '').trim().toUpperCase();
  return source === 'SECURITY_DEPOSIT' || name === 'SECURITY DEPOSIT' || name === 'SECURITY DEPOSIT HOLD';
}

async function buildPortalSummary(reservation, kind, token) {
  const agreement = await latestAgreementForReservation(reservation.id);
  const selfServiceConfig = reservation?.tenantId
    ? await settingsService.getSelfServiceConfig({ tenantId: reservation.tenantId }).catch(() => null)
    : null;
  const selfServiceConfirmations = await getSelfServiceConfirmations(reservation.id);
  const payments = mergePayments(reservation, agreement);
  const paidAmount = paidFromStructuredPayments(payments);
  const balanceDue = await amountDueForReservation(reservation.id, reservation.estimatedTotal);
  const lastPaymentAt = payments
    .map((payment) => payment?.paidAt || payment?.createdAt || null)
    .filter(Boolean)
    .sort((a, b) => new Date(b).getTime() - new Date(a).getTime())[0] || null;
  const customerInfoComplete = !!reservation.customerInfoCompletedAt;
  const signatureComplete = !!reservation.signatureSignedAt;
  const paymentComplete = balanceDue <= 0; // $0 / hold-only bookings complete after signing without a gateway charge
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
  const selfService = buildSelfServiceSnapshot({
    reservation,
    agreement,
    selfServiceConfig,
    confirmations: selfServiceConfirmations,
    customerInfoComplete,
    signatureComplete,
    paymentComplete
  });

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
    selfService,
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

function paymentReceiptText({ reservation, agreement, payments, companyName }) {
  const customerName = `${reservation?.customer?.firstName || ''} ${reservation?.customer?.lastName || ''}`.trim() || 'Customer';
  const lines = [
    `${companyName || 'Payment'} Receipt`,
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

async function serializeCustomerInfoReservation(reservation) {
  // Blob -> Storage (Phase 1): sign Storage paths for client rendering.
  // Legacy inline base64 / external http URLs pass through unchanged; signing
  // failures collapse to '' (best-effort).
  const [insuranceDocumentUrl, idPhotoUrl, licenseBackUrl] = await Promise.all([
    materializeDocumentRef(reservation.customer?.insuranceDocumentUrl || ''),
    materializeDocumentRef(reservation.customer?.idPhotoUrl || ''),
    materializeDocumentRef(reservation.customer?.licenseBackUrl || '')
  ]);
  return {
    id: reservation.id,
    reservationNumber: reservation.reservationNumber,
    status: reservation.status,
    pickupAt: reservation.pickupAt,
    returnAt: reservation.returnAt,
    estimatedTotal: reservation.estimatedTotal,
    // Lets the portal show a dash instead of a figure for a booking the
    // customer already paid the partner for.
    isPrepaid: reservation.isPrepaid ?? null,
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
      insuranceExpiry: reservation.customer?.insuranceExpiry || null,
      insuranceDocumentUrl,
      address1: reservation.customer?.address1 || '',
      address2: reservation.customer?.address2 || '',
      city: reservation.customer?.city || '',
      state: reservation.customer?.state || '',
      zip: reservation.customer?.zip || '',
      country: reservation.customer?.country || '',
      idPhotoUrl,
      licenseBackUrl
    }
  };
}

function paidFromStructuredPayments(payments) {
  const rows = Array.isArray(payments) ? payments : [];
  return Number(rows
    // 2026-06-06: count REAL captured money only. Exclude VOID, and exclude
    // AUTH_HOLD (security-deposit authorizations are not settled funds) so the
    // portal balance / pay-link reflect the true amount owed.
    .filter((p) => String(p?.status || '').toUpperCase() !== 'VOID')
    .filter((p) => String(p?.method || '').toUpperCase() !== 'AUTH_HOLD')
    .reduce((sum, p) => sum + Number(p?.amount || 0), 0)
    .toFixed(2));
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
    const visibleCharges = structuredCharges.filter((c) => !isSecurityDepositCharge(c));
    const lines = visibleCharges.map((c) => ({
      name: c.name,
      qty: Number(c.quantity || 0),
      rate: Number(c.rate || 0),
      total: Number(c.total || 0)
    }));
    const subtotal = Number(visibleCharges
      .filter((c) => String(c?.chargeType || '').toUpperCase() !== 'TAX')
      .reduce((sum, c) => sum + Number(c.total || 0), 0)
      .toFixed(2));
    const tax = Number(visibleCharges
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
  const mandatoryLocation = reservation?.pickupLocationId
    ? await prisma.location.findFirst({
        where: { id: reservation.pickupLocationId, ...tenantWhere },
        include: {
          locationFees: {
            include: {
              fee: { select: { id: true, isActive: true, mandatory: true } }
            }
          }
        }
      })
    : null;
  const mandatoryLocationFeeIds = (mandatoryLocation?.locationFees || [])
    .map((row) => row.fee)
    .filter((fee) => fee?.id && fee?.isActive && fee?.mandatory)
    .map((fee) => fee.id);
  const mergedFeeIds = [...new Set([...selectedFeeIds, ...underageAutoFees.map((f) => f.id), ...addlDriverAutoFees.map((f) => f.id), ...mandatoryLocationFeeIds])];

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
  const paid = paidFromStructuredPayments(reservation?.payments);
  return decideAmountDue({ agreement: latestAgreement, reservation, breakdown, paid, fallbackEstimated });
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

  try {
    await prisma.auditLog.create({
      data: {
        reservationId: reservation.id,
        action: 'UPDATE',
        metadata: JSON.stringify({ paymentPortalCompleted: true, reference, amount: paidAmount, gateway })
      }
    });
  } catch {}

  try {
    const to = String(reservation.customer?.email || '').trim();
    if (to) {
      const _brand = await resolveEmailBrand(reservation.tenantId ? { tenantId: reservation.tenantId } : {});
      const _rows = [
        ['Reservation', reservation.reservationNumber],
        ['Amount paid', `$${Number(paidAmount || 0).toFixed(2)}`],
        ['Reference', String(reference || '')],
        ['Date', new Date().toLocaleString()],
      ];
      const _bodyHtml = `<p style="margin:0 0 12px">Hello ${reservation.customer?.firstName || 'Customer'}, thank you — we received your payment.</p>`
        + '<table style="width:100%;font-size:14px;border-collapse:collapse">'
        + _rows.map(([k, v]) => `<tr><td style="padding:4px 0;color:#6f668f">${k}</td><td style="padding:4px 0;text-align:right;font-weight:600">${v}</td></tr>`).join('')
        + '</table>';
      const _bodyText = [
        `Hello ${reservation.customer?.firstName || 'Customer'},`, '', 'Thank you. We received your payment.',
        ..._rows.map(([k, v]) => `${k}: ${v}`), '', 'This is your payment receipt.',
      ].join('\n');
      const _email = renderBrandedEmail({ brand: _brand, heading: 'Payment received', bodyHtml: _bodyHtml, bodyText: _bodyText });
      await sendEmail({ fromName: _brand?.companyName, fromEmail: _brand?.fromEmail || undefined,
        to,
        subject: `Payment Receipt - ${reservation.reservationNumber}`,
        html: _email.html,
        text: _email.text,
      });
    }
  } catch {}
}

customerPortalRouter.get('/signature/:token', portalRead, async (req, res, next) => {
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
        // Lets the portal show a dash instead of a figure for a booking the
        // customer already paid the partner for.
        isPrepaid: reservation.isPrepaid ?? null,
        customerName: `${reservation.customer?.firstName || ''} ${reservation.customer?.lastName || ''}`.trim(),
        customerEmail: reservation.customer?.email || null,
        vehicle: reservation.vehicle ? `${reservation.vehicle.year || ''} ${reservation.vehicle.make || ''} ${reservation.vehicle.model || ''}`.trim() : null,
        pickupLocation: reservation.pickupLocation?.name || null,
        returnLocation: reservation.returnLocation?.name || null
      },
      breakdown,
      portal: await buildPortalSummary(reservation, 'signature', token),
      // 16g — bilingual T&C HTML (version TC_VERSION). termsText is kept for
      // backward compatibility with old portals that only render plain text.
      //
      // Resolved location → tenant → canonical (2026-07-24) — the SAME chain
      // renderAgreementHtml uses. This endpoint is a real ACCEPTANCE surface:
      // the customer reads this body, ticks "I accept" and signs (see the POST
      // handler below, which stamps signatureSignedAt/By and termsVersion). It
      // served the canonical text while the agreement of record printed the
      // tenant's override, so the customer accepted one document and received
      // another. The per-branch override would have widened that to a second
      // axis, and Corpusa's LAX — on Rightcars' California agreement — is the
      // first branch to use it.
      termsText: agreementCfg?.termsText || 'Standard rental terms apply.',
      termsHtml: await getEffectiveTermsHtml(
        { tenantId: reservation.tenantId || null, locationId: reservation.pickupLocationId || null },
        { prisma }
      ),
      termsVersion: TC_VERSION
    });
  } catch (e) { next(e); }
});

customerPortalRouter.get('/customer-info/:token', portalRead, async (req, res, next) => {
  try {
    const token = String(req.params.token || '');
    if (!token) return res.status(400).json({ error: 'token required' });

    const reservation = await findReservationByToken('customer-info', token);
    if (!reservation) return res.status(404).json({ error: 'Invalid or expired customer info token' });

    // Load insurance plans and additional services for this reservation's tenant
    const tenantId = reservation.tenantId;
    const [insurancePlans, precheckinDiscount] = await Promise.all([
      tenantId ? settingsService.getInsurancePlans({ tenantId }) : [],
      tenantId ? settingsService.getPrecheckinDiscount({ tenantId }) : { enabled: false, type: 'PERCENTAGE', value: 0 }
    ]);
    const additionalServices = tenantId
      ? await prisma.additionalService.findMany({
          where: { tenantId, isActive: true, displayOnline: true },
          orderBy: { sortOrder: 'asc' },
          // dailyRate/weeklyRate must be returned so the portal UI can show per-day pricing
          // and the POST handler can honor PER_DAY services instead of treating them as flat.
          select: {
            id: true, code: true, name: true, description: true,
            rate: true, dailyRate: true, weeklyRate: true, monthlyRate: true,
            chargeType: true, unitLabel: true, mandatory: true, taxable: true, defaultQty: true
          }
        })
      : [];

    // Also load existing charges on the reservation
    const existingCharges = await prisma.reservationCharge.findMany({
      where: { reservationId: reservation.id },
      select: { id: true, source: true, sourceRefId: true, name: true, rate: true, total: true, quantity: true, selected: true }
    });

    const catalog = enrichPrecheckinCatalog({ insurancePlans, additionalServices, existingCharges, precheckinDiscount });
    res.json({
      reservation: await serializeCustomerInfoReservation(reservation),
      expiresAt: reservation.customerInfoTokenExpiresAt,
      portal: await buildPortalSummary(reservation, 'customer-info', token),
      insurancePlans: catalog.insurancePlans,
      additionalServices: catalog.additionalServices,
      existingCharges,
      precheckinDiscount: precheckinDiscount?.enabled ? precheckinDiscount : null
    });
  } catch (e) {
    next(e);
  }
});

customerPortalRouter.post('/customer-info/:token', portalWrite, async (req, res, next) => {
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
    const insuranceSelection = body.insuranceSelection || null;
    const customerSelectedOurInsurance = insuranceSelection?.selectedPlanCode && !insuranceSelection?.declinedCoverage;
    // Field policy: keep in lockstep with lib/precheckin-fields.js
    // (REQUIRED_CUSTOMER_FIELDS) — all mandatory except insurance; the
    // insurance DOCUMENT stays conditionally required by the decline flow.
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
      ...(customerSelectedOurInsurance ? [] : [['insuranceDocumentUrl', String(body.insuranceDocumentUrl || '').trim(), 'Insurance Document']])
    ];
    const missing = requiredChecks.filter(([, value]) => !value).map(([, , label]) => label);
    if (missing.length) {
      return res.status(400).json({ error: `Complete the required pre-check-in items first: ${missing.join(', ')}` });
    }

    // Blob -> Storage (Phase 1): when the flag is ON, route inline base64 doc
    // values to Storage and persist the returned PATH. Fail-safe -- on any
    // upload error the original base64 is kept (KYC docs are never lost). Flag
    // OFF -> byte-identical to before.
    const _insuranceDocValue = body.insuranceDocumentUrl ? String(body.insuranceDocumentUrl).trim() : null;
    const _idPhotoValue = body.idPhotoUrl ? String(body.idPhotoUrl).trim() : null;
    const _docCtx = { tenantId: reservation.tenantId || null, customerId: reservation.customerId };
    const [_insuranceDocStored, _idPhotoStored] = await Promise.all([
      maybeUploadCustomerDocument(_insuranceDocValue, { ..._docCtx, kind: 'insurance' }),
      maybeUploadCustomerDocument(_idPhotoValue, { ..._docCtx, kind: 'id-photo' })
    ]);

    await prisma.customer.update({
      where: { id: reservation.customerId },
      data: {
        firstName,
        lastName,
        email,
        phone,
        dateOfBirth: body.dateOfBirth ? normalizeDob(body.dateOfBirth) : null,
        licenseNumber: body.licenseNumber ? String(body.licenseNumber).trim() : null,
        licenseState: body.licenseState ? String(body.licenseState).trim() : null,
        insurancePolicyNumber: body.insurancePolicyNumber ? String(body.insurancePolicyNumber).trim() : null,
        // LAX #5 — optional insurance expiration ("Exp Date"). Invalid dates
        // collapse to null rather than 500ing (mirrors the DOB guard's intent).
        insuranceExpiry: (() => {
          if (!body.insuranceExpiry) return null;
          const d = new Date(body.insuranceExpiry);
          return Number.isNaN(d.getTime()) ? null : d;
        })(),
        insuranceDocumentUrl: _insuranceDocStored,
        address1: body.address1 ? String(body.address1).trim() : null,
        address2: body.address2 ? String(body.address2).trim() : null,
        city: body.city ? String(body.city).trim() : null,
        state: body.state ? String(body.state).trim() : null,
        zip: body.zip ? String(body.zip).trim() : null,
        country: body.country ? String(body.country).trim() : null,
        idPhotoUrl: _idPhotoStored
      }
    });

    // 2026-07-25 — local vs non-local deposit rule (MONEY). Website bookings
    // freeze the decision as UNKNOWN → LOCAL because the licence isn't known
    // at booking time. Pre-check-in is the moment the real licence arrives,
    // so re-evaluate — but ONLY when the frozen basis is UNKNOWN (a decision
    // made on real licence/address data stays frozen) and only while the
    // agent hasn't taken over the pricing (UI_MANUAL always wins). Deposit
    // and mileage update TOGETHER so the hold and the check-in billing can
    // never disagree about which tier the renter is. Fail-soft: pre-check-in
    // must never break because of the rule.
    try {
      const snapshot = await prisma.reservationPricingSnapshot.findUnique({
        where: { reservationId: reservation.id },
        select: { securityDepositRuleJson: true, source: true, securityDepositAmount: true }
      });
      const frozen = parseDepositRuleDecision(snapshot?.securityDepositRuleJson);
      // UI_MANUAL normally freezes the decision (the agent decided). But
      // EVERY Save Override stamps UI_MANUAL — including a mileage-only
      // exception — which would freeze an UNKNOWN deposit at the
      // conservative $2,000 forever (QA MAJOR A-2). Heuristic: if the
      // snapshot's deposit still EQUALS what the rule froze, the agent
      // never touched the deposit — only then may the re-evaluation refresh
      // the deposit tier (manual mileage is preserved below either way).
      const sourceIsManual = String(snapshot?.source || '').toUpperCase() === 'UI_MANUAL';
      const depositUntouched = frozen
        && Number(snapshot?.securityDepositAmount) === Number(frozen.securityDepositAmount);
      if (frozen && frozen.basis === 'UNKNOWN' && (!sourceIsManual || depositUntouched)) {
        const cfg = parseLocationConfig(reservation.pickupLocation?.locationConfig);
        const rules = parseDepositRules(cfg, { locationId: reservation.pickupLocationId || null });
        const fresh = rules ? evaluateDepositRule({
          rules,
          renter: {
            licenseState: body.licenseState ? String(body.licenseState).trim() : null,
            addressState: body.state ? String(body.state).trim() : null
          }
        }) : null;
        if (fresh && fresh.basis !== 'UNKNOWN') {
          // An agent's per-reservation mileage exception (mileageSource
          // UI_MANUAL, set via Edit pricing) survives the re-evaluation —
          // only the locality/deposit half refreshes.
          const manualMileage = frozen.mileageSource === 'UI_MANUAL'
            ? {
                milesPerDay: frozen.milesPerDay ?? null,
                unlimitedMileage: !!frozen.unlimitedMileage,
                mileageSource: 'UI_MANUAL'
              }
            : {};
          await prisma.reservationPricingSnapshot.update({
            where: { reservationId: reservation.id },
            data: {
              securityDepositRuleJson: JSON.stringify({ ...fresh, ...manualMileage, evaluatedAt: new Date().toISOString() }),
              securityDepositRequired: Number(fresh.securityDepositAmount) > 0,
              securityDepositAmount: Number(fresh.securityDepositAmount) || 0
            }
          });
          logger.info('[customer-portal] deposit rule re-evaluated at pre-check-in (was UNKNOWN)', {
            reservationId: reservation.id,
            locality: fresh.locality,
            basis: fresh.basis,
            securityDepositAmount: fresh.securityDepositAmount
          });
        }
      }
    } catch (err) {
      logger.warn('[customer-portal] deposit rule re-evaluation failed — frozen decision kept', {
        reservationId: reservation.id,
        err: String(err?.message || err)
      });
    }

    // Load pre-checkin discount for this tenant
    const discount = reservation.tenantId
      ? await settingsService.getPrecheckinDiscount({ tenantId: reservation.tenantId })
      : null;
    const applyDiscount = (amount) => {
      if (!discount?.enabled || !amount) return amount;
      if (discount.type === 'PERCENTAGE') return Number((amount * (1 - discount.value / 100)).toFixed(2));
      return Number(Math.max(0, amount - discount.value).toFixed(2));
    };
    const money = (value) => Number(Number(value || 0).toFixed(2));

    // Rental length in days (mirrors backend/src/modules/reservations/reservation-pricing.service.js#rentalDays)
    // Used to scale PER_DAY insurance plans and daily-rated additional services correctly.
    const rentalDays = (() => {
      const start = new Date(reservation.pickupAt || Date.now());
      const end = new Date(reservation.returnAt || Date.now());
      const diffMs = end.getTime() - start.getTime();
      return Math.max(1, Math.ceil(diffMs / (1000 * 60 * 60 * 24)) || 1);
    })();

    // Base amount for PERCENTAGE insurance plans: sum of existing taxable non-tax, non-insurance charges
    // (daily rate + selected services + mandatory fees) at the time the customer submits the pre-checkin.
    const chargesForBase = await prisma.reservationCharge.findMany({
      where: { reservationId: reservation.id, selected: true }
    });
    const insuranceBaseAmount = chargesForBase
      .filter(c => String(c.source || '').toUpperCase() !== 'INSURANCE'
        && String(c.chargeType || '').toUpperCase() !== 'TAX'
        && String(c.chargeType || '').toUpperCase() !== 'DEPOSIT')
      .reduce((sum, c) => sum + Number(c.total || 0), 0);

    // Process insurance selection
    if (insuranceSelection) {
      await prisma.reservationCharge.deleteMany({
        where: { reservationId: reservation.id, source: 'INSURANCE' }
      });

      if (insuranceSelection.selectedPlanCode) {
        const plans = reservation.tenantId ? await settingsService.getInsurancePlans({ tenantId: reservation.tenantId }) : [];
        const plan = plans.find(p => String(p.code).toUpperCase() === String(insuranceSelection.selectedPlanCode).toUpperCase());
        if (plan) {
          // Respect the plan's pricing mode. Mirrors computeInsuranceLine() in booking-engine.service.js
          // so a PER_DAY plan is charged days×rate instead of being collapsed to a single unit.
          const mode = String(plan.chargeBy || plan.mode || 'FIXED').toUpperCase();
          const amount = Number(plan.amount || plan.rate || plan.total || 0);
          const discountedAmount = applyDiscount(amount);

          let chargeQuantity = 1;
          let chargeRate = money(discountedAmount);
          let chargeTotal = money(discountedAmount);
          let counterTotal = money(amount);
          let counterNote = null;

          if (mode === 'PER_DAY') {
            chargeQuantity = rentalDays;
            chargeRate = money(discountedAmount);
            chargeTotal = money(discountedAmount * rentalDays);
            counterTotal = money(amount * rentalDays);
            counterNote = `Counter price: $${amount.toFixed(2)}/day × ${rentalDays} day(s)`;
          } else if (mode === 'PERCENTAGE') {
            // Percentage plans are always a single line whose value is the pct of the base.
            chargeQuantity = 1;
            chargeRate = money(insuranceBaseAmount * (discountedAmount / 100));
            chargeTotal = chargeRate;
            counterTotal = money(insuranceBaseAmount * (amount / 100));
            counterNote = `Counter price: ${amount.toFixed(2)}% of $${insuranceBaseAmount.toFixed(2)}`;
          } else {
            // FIXED
            counterNote = `Counter price: $${amount.toFixed(2)}`;
          }

          const discounted = chargeTotal < counterTotal;
          await prisma.reservationCharge.create({
            data: {
              reservationId: reservation.id,
              source: 'INSURANCE',
              sourceRefId: plan.code,
              name: discounted ? `${plan.name} (Pre-checkin rate)` : plan.name,
              rate: chargeRate,
              total: chargeTotal,
              quantity: chargeQuantity,
              selected: true,
              sortOrder: 0,
              notes: discounted ? `${counterNote}, pre-checkin discount applied` : null
            }
          });
        }
      } else if (insuranceSelection.declinedCoverage) {
        // Persist the decline signature (captured on the pre-check-in page) onto
        // the agreement if one exists; initials + signature also live in the
        // AuditLog insuranceSelection blob the admin slot reads.
        const declineSig = insuranceSelection.signatureDataUrl;
        const declAg = await prisma.rentalAgreement.findUnique({ where: { reservationId: reservation.id }, select: { id: true } });
        if (declAg) {
          await prisma.rentalAgreement.update({
            where: { id: declAg.id },
            data: {
              declinedInsurance: true,
              ...(declineSig && String(declineSig).length > 200
                ? { declinedInsuranceSignatureDataUrl: declineSig, declinedInsuranceSignedAt: new Date() }
                : {}),
            },
          });
        }
      }
    }

    // Process additional services selection
    const selectedServices = body.selectedServices || null;
    if (selectedServices && Array.isArray(selectedServices)) {
      await prisma.reservationCharge.deleteMany({
        where: { reservationId: reservation.id, source: 'ADDITIONAL_SERVICE_PRECHECKIN' }
      });

      for (const svc of selectedServices) {
        if (!svc.serviceId || !svc.selected) continue;
        const service = await prisma.additionalService.findFirst({
          where: { id: svc.serviceId, tenantId: reservation.tenantId, isActive: true }
        });
        if (!service) continue;
        const qty = Math.max(1, Number(svc.quantity || service.defaultQty || 1));

        // Respect the service's pricing mode. Mirrors computeAdditionalServiceLine() in
        // booking-engine.service.js: dailyRate (when >0) is the per-day price and total
        // scales with rental days; otherwise the flat rate applies.
        const perDay = Number(service.dailyRate || 0);
        const isPerDay = perDay > 0 || String(service.chargeType || '').toUpperCase() === 'DAILY';
        const counterRate = isPerDay && perDay > 0 ? perDay : Number(service.rate || 0);
        const discountedRate = applyDiscount(counterRate);

        const chargeTotal = isPerDay
          ? money(discountedRate * rentalDays * qty)
          : money(discountedRate * qty);
        const counterTotal = isPerDay
          ? money(counterRate * rentalDays * qty)
          : money(counterRate * qty);
        const discounted = discountedRate < counterRate;
        const counterNote = isPerDay
          ? `Counter price: $${counterRate.toFixed(2)}/day × ${rentalDays} day(s) × ${qty} unit(s)`
          : `Counter price: $${counterRate.toFixed(2)}/unit × ${qty} unit(s)`;

        await prisma.reservationCharge.create({
          data: {
            reservationId: reservation.id,
            source: 'ADDITIONAL_SERVICE_PRECHECKIN',
            sourceRefId: service.id,
            name: discounted ? `${service.name} (Pre-checkin rate)` : service.name,
            rate: money(discountedRate),
            total: chargeTotal,
            quantity: isPerDay ? rentalDays * qty : qty,
            selected: true,
            sortOrder: 10,
            notes: discounted ? `${counterNote}, pre-checkin discount applied` : null
          }
        });
      }
    }

    // Process third-party / OTA prepaid voucher
    const thirdPartyBooking = body.thirdPartyBooking || null;
    if (thirdPartyBooking?.isThirdParty) {
      // Remove daily-rate related charges only — keep insurance, services, and their taxes
      await prisma.reservationCharge.deleteMany({
        where: { reservationId: reservation.id, source: { in: ['DAILY', 'FEE', 'SERVICE_LINKED_FEE'] } }
      });

      // Recalculate tax on remaining taxable charges (insurance + services)
      const remainingCharges = await prisma.reservationCharge.findMany({
        where: { reservationId: reservation.id, selected: true }
      });
      // Delete old tax rows (chargeType TAX) so we can recalculate
      await prisma.reservationCharge.deleteMany({
        where: { reservationId: reservation.id, chargeType: 'TAX' }
      });
      const taxableTotal = remainingCharges
        .filter(c => c.taxable && String(c.chargeType || '').toUpperCase() !== 'TAX')
        .reduce((sum, c) => sum + Number(c.total || 0), 0);
      if (taxableTotal > 0) {
        // Get tax rate from pricing snapshot or pickup location
        const loc = reservation.pickupLocationId
          ? await prisma.location.findUnique({ where: { id: reservation.pickupLocationId }, select: { taxRate: true } })
          : null;
        const taxRate = Number(reservation.pricingSnapshot?.taxRate ?? loc?.taxRate ?? 0);
        if (taxRate > 0) {
          const taxAmount = Number((taxableTotal * taxRate / 100).toFixed(2));
          await prisma.reservationCharge.create({
            data: {
              reservationId: reservation.id,
              source: 'TAX_RECALC',
              name: `Sales Tax (${taxRate.toFixed(2)}%)`,
              chargeType: 'TAX',
              quantity: 1,
              rate: taxAmount,
              total: taxAmount,
              taxable: false,
              selected: true,
              sortOrder: 999
            }
          });
        }
      }

      // Store a voucher charge marker so the agreement knows this is prepaid
      const existingVoucher = await prisma.reservationCharge.findFirst({
        where: { reservationId: reservation.id, source: 'OTA_PREPAID_VOUCHER' }
      });
      if (!existingVoucher) {
        await prisma.reservationCharge.create({
          data: {
            reservationId: reservation.id,
            source: 'OTA_PREPAID_VOUCHER',
            sourceRefId: 'third-party-voucher',
            name: 'Prepaid Third-Party Voucher',
            chargeType: 'UNIT',
            quantity: 1,
            rate: 0,
            total: 0,
            taxable: false,
            selected: true,
            sortOrder: -1,
            notes: thirdPartyBooking.voucherUrl ? 'Voucher document attached' : 'No voucher document uploaded'
          }
        });
      }

      // Update reservation notes/pricing snapshot to flag prepaid status
      const currentNotes = reservation.notes || '';
      const prepaidNote = '[OTA PREPAID] Customer indicated third-party prepaid booking during pre-check-in.';
      if (!currentNotes.includes('[OTA PREPAID]')) {
        await prisma.reservation.update({
          where: { id: reservation.id },
          data: { notes: currentNotes ? `${currentNotes}\n${prepaidNote}` : prepaidNote }
        });
      }

      // Store voucher URL on the customer record
      if (thirdPartyBooking.voucherUrl) {
        await prisma.customer.update({
          where: { id: reservation.customerId },
          data: { notes: `[VOUCHER] Third-party voucher uploaded during pre-check-in` }
        });
      }
    }

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
          ip: req.ip || null,
          insuranceSelection: insuranceSelection || null,
          selectedServices: selectedServices || null,
          thirdPartyBooking: thirdPartyBooking || null
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

customerPortalRouter.post('/signature/:token', portalWrite, async (req, res, next) => {
  try {
    const token = String(req.params.token || '');
    const signerName = String(req.body?.signerName || '').trim();
    const signatureDataUrl = String(req.body?.signatureDataUrl || '').trim();
    if (!signerName) return res.status(400).json({ error: 'signerName is required' });
    if (!signatureDataUrl) return res.status(400).json({ error: 'signatureDataUrl is required' });
    // An untouched signature pad is still a valid PNG (RA-20260701152550: the
    // customer submitted a blank canvas and a WHITE BOX printed in the
    // agreement's Customer Signature block while her real T&C stroke sat on
    // the appendix page). Reject the blank HERE, where the customer can simply
    // sign again. Fail-open on formats the analyzer cannot read.
    const ink = analyzeSignatureInk(signatureDataUrl);
    if (ink.analyzable && !ink.hasInk) {
      return res.status(400).json({ error: 'The signature is blank — please sign before submitting' });
    }

    const reservation = await findReservationByToken('signature', token);
    if (!reservation) return res.status(404).json({ error: 'Invalid or expired signature link' });

    const note = `[SIGNATURE ${new Date().toISOString()}] signed by ${signerName}`;
    await prisma.reservation.update({
      where: { id: reservation.id },
      data: {
        signatureSignedAt: new Date(),
        signatureSignedBy: signerName,
        signatureDataUrl,
        // 16g — capture which version of the T&C was in effect when the
        // customer accepted. Pre-update reservations (terms < TC_VERSION)
        // remain autochargeBlocked until the unblock script runs.
        termsVersion: TC_VERSION,
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

customerPortalRouter.post('/self-service/:kind/:token/confirm', portalWrite, async (req, res, next) => {
  try {
    const kind = String(req.params.kind || '').trim();
    const token = String(req.params.token || '').trim();
    if (!['customer-info', 'signature', 'payment'].includes(kind)) {
      return res.status(400).json({ error: 'Unsupported portal kind' });
    }

    const stage = String(req.body?.stage || '').trim().toUpperCase();
    if (!['PICKUP', 'DROPOFF'].includes(stage)) {
      return res.status(400).json({ error: 'stage must be PICKUP or DROPOFF' });
    }

    const reservation = await findReservationByToken(kind, token);
    if (!reservation) return res.status(404).json({ error: 'Invalid or expired self-service link' });

    const portal = await buildPortalSummary(reservation, kind, token);
    const selfService = portal?.selfService || null;
    if (!selfService?.enabled) {
      return res.status(400).json({ error: 'Self-service is not enabled for this reservation.' });
    }

    if (stage === 'PICKUP' && !selfService.readyForPickup) {
      return res.status(400).json({ error: selfService.pickup?.blockers?.[0] || 'Pickup is not ready for self-service confirmation.' });
    }
    if (stage === 'DROPOFF' && !selfService.readyForDropoff) {
      return res.status(400).json({ error: selfService.dropoff?.blockers?.[0] || 'Drop-off is not ready for self-service confirmation.' });
    }
    if (stage === 'PICKUP' && selfService.confirmations?.pickup?.confirmedAt) {
      return res.json({ ok: true, duplicate: true, portal });
    }
    if (stage === 'DROPOFF' && selfService.confirmations?.dropoff?.confirmedAt) {
      return res.json({ ok: true, duplicate: true, portal });
    }

    const confirmedAt = new Date().toISOString();
    await prisma.auditLog.create({
      data: {
        tenantId: reservation.tenantId || null,
        reservationId: reservation.id,
        action: 'UPDATE',
        reason: stage === 'PICKUP' ? 'Self-service pickup confirmed' : 'Self-service drop-off confirmed',
        metadata: JSON.stringify({
          selfServiceEvent: stage === 'PICKUP' ? 'PICKUP_CONFIRMED' : 'DROPOFF_CONFIRMED',
          confirmedAt,
          note: String(req.body?.note || '').trim(),
          source: 'CUSTOMER_PORTAL',
          ip: req.ip || null
        })
      }
    });

    const refreshed = await findReservationByToken(kind, token);
    res.json({
      ok: true,
      duplicate: false,
      confirmedAt,
      portal: refreshed ? await buildPortalSummary(refreshed, kind, token) : portal
    });
  } catch (e) { next(e); }
});

customerPortalRouter.post('/payment-gateway/authorizenet/webhook', portalWebhook, async (req, res, next) => {
  try {
    const payload = req.body || {};
    const eventType = String(payload?.eventType || '').trim();
    const rawTransId = String(payload?.payload?.id || payload?.payload?.entityId || payload?.id || '').trim();
    console.log('[authnet webhook] received', {
      eventType: eventType || null,
      transId: rawTransId || null
    });

    const webhookConfig = await authNetWebhookConfigForRequest(req);
    if (!webhookConfig || webhookConfig?._invalidSignature) {
      console.warn('[authnet webhook] rejected invalid signature', {
        eventType: eventType || null,
        transId: rawTransId || null,
        ...(webhookConfig?.debug || {})
      });
      return res.status(401).json({ error: 'Invalid Authorize.Net webhook signature' });
    }

    console.log('[authnet webhook] signature verified', {
      eventType: eventType || null,
      transId: rawTransId || null,
      tenantId: webhookConfig?.tenantId || null
    });

    const supportedEvents = new Set([
      'net.authorize.payment.authcapture.created',
      'net.authorize.payment.capture.created',
      'net.authorize.payment.authorization.created'
    ]);
    if (!supportedEvents.has(eventType)) {
      console.log('[authnet webhook] ignored unsupported event', {
        eventType: eventType || null,
        transId: rawTransId || null
      });
      return res.json({ ok: true, ignored: true, reason: `Unsupported event ${eventType || 'unknown'}` });
    }

    const transId = rawTransId;
    if (!transId) {
      console.warn('[authnet webhook] ignored missing transaction id', {
        eventType: eventType || null
      });
      return res.json({ ok: true, ignored: true, reason: 'Missing transaction id' });
    }

    const details = await getAuthNetTransactionDetails(transId, webhookConfig.config);
    const invoiceNumber = authNetInvoiceNumberValue(
      details?.transaction?.order?.invoiceNumber ||
      details?.transaction?.invoiceNumber ||
      payload?.payload?.invoiceNumber ||
      ''
    );
    if (!invoiceNumber) {
      console.warn('[authnet webhook] ignored missing invoice number', {
        eventType,
        transId
      });
      return res.json({ ok: true, ignored: true, reason: 'Missing reservation invoice number' });
    }

    const reservation = await findReservationByAuthNetInvoiceNumber(invoiceNumber);
    if (!reservation) {
      console.warn('[authnet webhook] ignored reservation not found', {
        eventType,
        transId,
        invoiceNumber
      });
      return res.json({ ok: true, ignored: true, reason: `Reservation not found for ${invoiceNumber}` });
    }

    const tenantGatewayConfig = await paymentGatewayConfigForTenant(reservation.tenantId || webhookConfig.tenantId || null);
    const result = await postAuthNetPaymentToReservation({
      reservation,
      transId,
      gatewayConfig: tenantGatewayConfig,
      origin: 'PORTAL'
    });

    console.log('[authnet webhook] posted payment', {
      eventType,
      transId,
      invoiceNumber,
      reservationId: reservation.id,
      reservationNumber: reservation.reservationNumber,
      duplicate: !!result?.duplicate,
      amount: Number(result?.amount || 0)
    });

    return res.json({
      ok: true,
      eventType,
      reservationId: reservation.id,
      reservationNumber: reservation.reservationNumber,
      ...result
    });
  } catch (e) { next(e); }
});

customerPortalRouter.get('/payment/:token', portalRead, async (req, res, next) => {
  try {
    const token = String(req.params.token || '');
    if (!token) return res.status(400).json({ error: 'token required' });
    const reservation = await findReservationByToken('payment', token);
    if (!reservation) return res.status(404).json({ error: 'Invalid or expired payment link' });

    // NO REFUSAL HERE. This GET renders the payment page; it does not move
    // money. Returning 409 when nothing is due collapses the page to an error
    // banner for every settled reservation — losing "your payment step is
    // complete", the signed-agreement download and the receipt — and breaks the
    // post-checkout poller, which reads amountDue to detect that the payment
    // landed. It also hid the prepaid copy from the population it was written
    // for, since prepaid bookings sit at 0 by construction. The refusal belongs
    // on the two POSTs that mint a hosted page or charge a card.
    const amountDue = await amountDueForReservation(reservation.id, reservation.estimatedTotal);
    const breakdown = await buildReservationBreakdown(reservation);
    const gatewayConfig = await paymentGatewayConfigForTenant(reservation.tenantId || null);
    const gateway = currentGateway(gatewayConfig);
    const gatewayReady = gateway === 'authorizenet'
      ? authNetPortalReady(gatewayConfig)
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
        // Lets the portal show a dash instead of a figure for a booking the
        // customer already paid the partner for.
        isPrepaid: reservation.isPrepaid ?? null,
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

customerPortalRouter.post('/payment/:token/create-session', portalWrite, async (req, res, next) => {
  try {
    const token = String(req.params.token || '');
    const reservation = await findReservationByToken('payment', token);
    if (!reservation) return res.status(404).json({ error: 'Invalid or expired payment link' });
    const amountDue = await amountDueForReservation(reservation.id, reservation.estimatedTotal);
    // NOTHING DUE IS NOT A PAYMENT. The public path refuses this explicitly
    // (assertPayable → ALREADY_PAID); this one had no equivalent and instead
    // floored the amount to $0.50, minting a real hosted payment page for a
    // customer who owes nothing. Prepaid bookings land here by design now, so
    // the floor is no longer a theoretical edge.
    if (!(Number(amountDue) > 0)) {
      return res.status(409).json({ error: 'Nothing is due on this reservation', code: 'ALREADY_PAID' });
    }
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
    const requestPayload = {
      getHostedPaymentPageRequest: {
        merchantAuthentication: { name: gatewayConfig.authorizenet.loginId, transactionKey: gatewayConfig.authorizenet.transactionKey },
        transactionRequest: {
          transactionType: 'authCaptureTransaction',
          amount,
          order: {
            invoiceNumber: authNetInvoiceNumberValue(reservation.reservationNumber || reservation.id)
          }
        },
        hostedPaymentSettings: {
          setting: [
            {
              settingName: 'hostedPaymentPaymentOptions',
              settingValue: JSON.stringify({
                showCreditCard: true,
                showBankAccount: false,
                cardCodeRequired: false
              })
            },
            {
              settingName: 'hostedPaymentVisaCheckoutOptions',
              settingValue: JSON.stringify({ apiKey: '', displayName: '', message: '' })
            }
          ]
        }
      }
    };

    const authnet = await authNetRequest(requestPayload, gatewayConfig);
    const payload = authnet?.body || {};
    const response = payload?.getHostedPaymentPageResponse || payload;
    const hostedToken = response?.token || payload?.token;
    const resultCode = response?.messages?.resultCode || payload?.messages?.resultCode;
    if (resultCode !== 'Ok' || !hostedToken) {
      const detail = extractAuthNetMessage(payload) || extractAuthNetMessage(response) || '';
      const fallback = authnet?.raw && !String(authnet.raw || '').trim().startsWith('{')
        ? `Authorize.Net token creation failed (${authnet.status || 400})`
        : 'Authorize.Net token creation failed';
      return res.status(400).json({ error: detail || fallback });
    }

    const hostedBase = authNetHostedBaseForConfig(gatewayConfig);
    res.json({
      gateway,
      checkoutUrl: hostedBase,
      checkoutMethod: 'POST',
      checkoutToken: hostedToken
    });
  } catch (e) { next(e); }
});

customerPortalRouter.post('/payment/:token/confirm', portalWrite, async (req, res, next) => {
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
    } else if (gateway === 'authorizenet' && req.body?.opaqueData?.dataDescriptor && req.body?.opaqueData?.dataValue) {
      if (!authNetEnabled(gatewayConfig)) return res.status(400).json({ error: 'Authorize.Net not configured for this tenant' });
      const opaqueData = {
        dataDescriptor: String(req.body.opaqueData.dataDescriptor || '').trim(),
        dataValue: String(req.body.opaqueData.dataValue || '').trim()
      };
      if (!opaqueData.dataDescriptor || !opaqueData.dataValue) {
        return res.status(400).json({ error: 'Authorize.Net opaque payment data is required' });
      }

      const chargeAmount = Number(await amountDueForReservation(reservation.id, reservation.estimatedTotal));
      // Same refusal as above: never charge a card for a balance that is zero.
      if (!(chargeAmount > 0)) {
        return res.status(409).json({ error: 'Nothing is due on this reservation', code: 'ALREADY_PAID' });
      }
      const billingZip = authNetCleanValue(req.body?.billingZip || reservation.customer?.zip || '', '');
      const customerPayload = authNetCompactObject({
        id: authNetCustomerIdValue(reservation.customer?.id || '', reservation.id || ''),
        email: authNetCleanValue(reservation.customer?.email || '', '')
      });
      const billToPayload = authNetCompactObject({
        firstName: authNetCleanValue(reservation.customer?.firstName || '', ''),
        lastName: authNetCleanValue(reservation.customer?.lastName || '', ''),
        address: authNetCleanValue(reservation.customer?.address1 || '', ''),
        city: authNetCleanValue(reservation.customer?.city || '', ''),
        state: authNetCleanValue(reservation.customer?.state || '', ''),
        zip: billingZip,
        country: authNetCleanValue(reservation.customer?.country || 'USA', ''),
        phoneNumber: authNetCleanValue(reservation.customer?.phone || '', '')
      });
      const authnet = await authNetRequest({
        createTransactionRequest: {
          merchantAuthentication: {
            name: gatewayConfig.authorizenet.loginId,
            transactionKey: gatewayConfig.authorizenet.transactionKey
          },
          transactionRequest: {
            transactionType: 'authCaptureTransaction',
            amount: Number(Math.max(0.5, chargeAmount)).toFixed(2),
            payment: {
              opaqueData
            },
            ...(Object.keys(customerPayload).length ? { customer: customerPayload } : {}),
            ...(Object.keys(billToPayload).length ? { billTo: billToPayload } : {})
          }
        }
      }, gatewayConfig);
      const authnetBody = authnet?.body || {};
      const authnetResponse = authnetBody?.createTransactionResponse || authnetBody;
      const tx = authnetResponse?.transactionResponse || {};
      const ok = String(authnetResponse?.messages?.resultCode || '').trim() === 'Ok' && String(tx?.responseCode || '').trim() === '1';
      if (!ok) {
        return res.status(400).json({ error: extractAuthNetMessage(authnetResponse) || extractAuthNetMessage(authnetBody) || 'Authorize.Net payment failed' });
      }
      paidAmount = Number(tx?.authAmount || tx?.settleAmount || chargeAmount || 0);
      reference = buildGatewayReference('AUTHNET', tx.transId || 'UNKNOWN');
      const existing = await prisma.reservationPayment.findFirst({
        where: {
          reservationId: reservation.id,
          reference
        }
      });
      if (existing) {
        let portal = null;
        try {
          const refreshed = await findReservationByToken('payment', token);
          portal = refreshed ? await buildPortalSummary(refreshed, 'payment', token) : null;
        } catch {}
        return res.json({
          ok: true,
          paidAmount: Number(existing.amount || 0),
          savedCardOnFile: false,
          duplicate: true,
          portal
        });
      }
    } else if (gateway === 'authorizenet') {
      if (!authNetEnabled(gatewayConfig)) return res.status(400).json({ error: 'Authorize.Net not configured for this tenant' });
      const transId = String(
        req.body?.transId ||
        req.body?.transactionId ||
        req.body?.xTransId ||
        req.body?.x_trans_id ||
        req.body?.reference ||
        ''
      ).trim();
      if (!transId) {
        return res.status(400).json({ error: 'Authorize.Net transId is required' });
      }

      reference = buildGatewayReference('AUTHNET', transId);
      const existing = await prisma.reservationPayment.findFirst({
        where: {
          reservationId: reservation.id,
          reference
        }
      });
      if (existing) {
        const refreshed = await findReservationByToken('payment', token);
        return res.json({
          ok: true,
          paidAmount: Number(existing.amount || 0),
          savedCardOnFile: false,
          duplicate: true,
          portal: refreshed ? await buildPortalSummary(refreshed, 'payment', token) : null
        });
      }
      const result = await postAuthNetPaymentToReservation({
        reservation,
        transId,
        gatewayConfig,
        token,
        origin: 'PORTAL'
      });
      return res.json({
        ok: true,
        paidAmount: Number(result.amount || 0),
        savedCardOnFile: !!result.savedCardOnFile,
        duplicate: !!result.duplicate,
        portal: result.portal || null,
        reference: result.reference || null
      });
    } else {
      return res.status(400).json({
        error: gateway === 'stripe'
          ? 'Stripe sessionId is required'
          : gateway === 'authorizenet'
            ? 'Authorize.Net payment confirmation requires a hosted payment transId'
            : `Public payment confirmation is disabled for ${String(gateway || 'this gateway').toUpperCase()}. Use verified gateway callbacks or internal reconciliation.`
      });
    }

    try {
      await postPayment({ reservation, paidAmount, reference, gateway });
    } catch (postErr) {
      const message = String(postErr?.message || postErr || 'Unable to record payment');
      return res.status(500).json({
        error: `Payment captured but the system could not record it yet: ${message}`,
        captured: true,
        reference,
        paidAmount
      });
    }

    let savedCardOnFile = false;
    try {
      if (gateway === 'authorizenet') {
        savedCardOnFile = await trySaveAuthNetCardOnFileFromTransaction({ reservation, reference });
      }
    } catch {}

    let portal = null;
    try {
      const refreshed = await findReservationByToken('payment', token);
      portal = refreshed ? await buildPortalSummary(refreshed, 'payment', token) : null;
    } catch {}
    res.json({ ok: true, paidAmount, savedCardOnFile, portal });
  } catch (e) { next(e); }
});

customerPortalRouter.get('/payment/:token/confirm', portalRead, async (req, res, next) => {
  try {
    const token = String(req.params.token || '').trim();
    if (!token) return res.status(400).send('token required');

    const params = new URLSearchParams();
    params.set('token', token);

    const success = String(req.query?.success || req.query?.approved || '1').trim();
    if (success) params.set('success', success);

    const canceled = String(req.query?.canceled || '').trim();
    if (canceled) params.set('canceled', canceled);

    const transId = String(
      req.query?.transId ||
      req.query?.transactionId ||
      req.query?.x_trans_id ||
      req.query?.xTransId ||
      ''
    ).trim();
    if (transId) params.set('transId', transId);

    return res.redirect(`${portalBase().replace(/\/$/, '')}/customer/pay?${params.toString()}`);
  } catch (e) {
    next(e);
  }
});

customerPortalRouter.get('/document/:kind/:token/:asset', portalRead, async (req, res, next) => {
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
      const _receiptBrand = await resolveEmailBrand(reservation.tenantId ? { tenantId: reservation.tenantId } : {}).catch(() => null);
      const text = paymentReceiptText({ reservation, agreement, payments, companyName: _receiptBrand?.companyName });
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${reservation.reservationNumber || 'receipt'}-receipt.txt"`);
      return res.send(text);
    }

    return res.status(404).json({ error: 'Document not available' });
  } catch (e) {
    next(e);
  }
});
