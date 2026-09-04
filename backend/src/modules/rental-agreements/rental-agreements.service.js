import crypto from 'node:crypto';
import { parseDateTimeInTz } from '../../lib/date-utils.js';
import { parseOdometerInput } from '../../lib/odometer-input.js';
import { resolveTenantTimeZone } from '../../lib/tenant-tz.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { withPage } from '../../lib/puppeteer-browser.js';
import { sectionsForAgreement } from '../checkout-session/terms-content.js';
import { prisma } from '../../lib/prisma.js';
import { hostReviewsService } from '../host-reviews/host-reviews.service.js';
import { reservationPricingService } from '../reservations/reservation-pricing.service.js';
import { settingsService } from '../settings/settings.service.js';
import { buildInspectionIntelligence } from '../vehicles/vehicle-intelligence.service.js';
import { syncVehicleStatusForReservation } from '../vehicles/vehicle-status-sync.js';
import { recordMileageEntry } from '../vehicles/mileage-history.service.js';
import { recordFuelReadingSafe } from '../vehicles/fuel-history.service.js';
import { normalizeDob, isImplausibleAge } from '../../lib/dob.js';
import { assertCustomerEmail } from '../../lib/customer-email.js';
import {
  isStorageEnabled as inspectionPhotosStorageEnabled,
  uploadInspectionPhotosDetailed,
  materializeStorageRefs as materializeInspectionStorageRefs
} from './inspection-photos.js';
import { downloadObject as inspectionDownloadObject } from '../../lib/storage/supabase-storage.js';
import { normalizeInspectionPhotos, canonicalPhotoKey, fuelLevelToFraction } from './inspection-photos-normalize.js';
import { parseLocationConfig } from '../../lib/location-config.js';
import { getEffectiveTermsHtml } from '../../lib/terms/index.js';
import { TC_VERSION } from '../../lib/terms/version.js';
import { refundCharge as payarcRefundCharge } from '../public-booking/payarc-hosted-fields.js';
import {
  materializeDocumentRef,
  maybeUploadCustomerDocument
} from '../customers/customer-documents.js';
import { userProgramScope } from '../../lib/tenant-scope.js';
import { reservationProgramWhereForScope } from '../../lib/program-category.js';
import { resolveCatalogEntry } from '../../lib/commission-catalog.js';
import { isSoldItemCharge, SERVICE_CHARGE_SOURCES } from '../../lib/sold-items.js';
import { normalizeReviewTiers, tierPercentFor } from '../../lib/review-tiers.js';
import { spinClient } from '../payment-gateway/spin-client.js';
import { resolveTenantTerminalConfig, toSpinClientConfig } from '../payment-gateway/tenant-terminal-config.js';
import { iposTransactClient } from '../payment-gateway/ipos-transact-client.js';
import { paymentOpsQueue } from '../payment-gateway/payment-ops-queue.service.js';
import logger from '../../lib/logger.js';
import { autoCompleteShuttleRequestsOnCheckout } from '../shuttle/shuttle-requests.service.js';
import { pickInkedSignature } from '../../lib/signature-ink.js';

/**
 * Tenant SPIn config for this module's three money paths
 * (spinChargeCardOnFile, spinReleaseDepositHold, spinReauthDepositHold).
 *
 * FIXED 2026-09-04. This used to be a stub that read a Tenant row and then
 * returned an empty object on both branches of the ternary, dating from when
 * Tenant.spin* columns did not exist. An empty object makes spin-client fall
 * back to the PLATFORM env terminal, so a tenant with a terminal of their own
 * was charged through somebody else's. It only ever looked fine because IRC
 * was the single live merchant and the env terminal was theirs; LAX is exactly
 * the second tenant that would have found it.
 *
 * Now it delegates to the one resolver — the same call
 * payment-gateway.service.js and checkout-session/spin-charge.service.js make.
 * `toSpinClientConfig` still returns `{}` when the resolver reports a
 * non-TENANT source, so the deliberate, logged env fallback is unchanged; what
 * disappears is the silent one.
 */
async function loadTenantSpinConfig(tenantId) {
  if (!tenantId) return {};
  try {
    return toSpinClientConfig(await resolveTenantTerminalConfig(tenantId));
  } catch (e) {
    logger.warn?.({ tenantId, err: e?.message }, 'spin tenant config resolve failed; falling back');
    return {};
  }
}

/**
 * ⚠️ MONEY (2026-07-25, QA MAJOR). The one window in spinReauthDepositHold
 * where a customer can silently end up with NO deposit hold at all.
 *
 * spinReauthDepositHold is: void-the-old-hold → pre-auth-the-new-one → persist.
 * Until today's voidByRrn contract fix (it was sending uppercase `RRN` and
 * amount '0'), step 1 never actually succeeded at the gateway — verified in
 * prod: zero successful release/re-auth rows, ever. So a declined re-auth was
 * harmless: the old hold stayed live and the merchant stayed covered.
 *
 * Now that the void really works, that inverts. Void succeeds → re-auth is
 * declined (a routine card event) → the throw fires BEFORE the persist step, so
 * the agreement is left pointing at a hold that no longer exists with
 * `depositHoldVoidedAt` still null. Both the DB and the staff panel
 * (`depositHoldActive = depositHoldId && !depositHoldVoidedAt`) claim a live
 * hold while the card carries nothing. Silently unprotected.
 *
 * So before the error propagates: persist the truth about the OLD hold and make
 * the gap loud. NOTHING in here may throw — the agent must see the real gateway
 * error, never a bookkeeping failure that happened while recording it.
 */
async function recordDepositHoldVoidedWithoutReplacement(agreement, {
  voidedRef = null, amount = null, error = null, actorUserId = null,
} = {}) {
  // No GATEWAY void happened — nothing attempted, a swallowed failure, or the
  // MANUAL- bookkeeping shortcut (no gateway hold exists to lose). The old hold
  // is untouched, so there is nothing to correct. Never stamp on an assumption:
  // that is exactly the false-stamp bug beta.343 removed from the nightly
  // sweep, where `depositHoldVoidedAt` was set without any gateway call.
  if (!voidedRef) return;

  const errMessage = error?.message || String(error || 'iPOSpays re-auth failed');

  try {
    // The SAME field triple spinReleaseDepositHold writes after a successful
    // gateway void — because that is exactly what happened here; the release
    // just has no replacement. `depositHoldId` is deliberately RETAINED: it is
    // the RRN staff and the audit trail need to trace what was voided, and the
    // paired `depositHoldVoidedAt` is what every read path (the payments panel,
    // the nightly stale-preauth sweep) uses to know the hold is dead.
    // `securityDepositCaptured:false` + `securityDepositReleasedAt` are what
    // stop the Security Deposit block still rendering "Authorized".
    await prisma.rentalAgreement.update({
      where: { id: agreement.id },
      data: {
        depositHoldVoidedAt: new Date(),
        securityDepositReleasedAt: new Date(),
        securityDepositCaptured: false,
      },
    });
  } catch (err) {
    logger.error('[spin-reauth] FAILED to stamp a voided deposit hold — the record still claims a live hold', {
      agreementId: agreement.id, voidedRef, err: err.message,
    });
  }

  try {
    if (!agreement.tenantId) {
      // paymentOpsQueue.raise() requires a tenant; a flagless gap must still be
      // loud somewhere rather than disappearing into a swallowed catch.
      logger.error('[spin-reauth] deposit hold voided with no replacement and no tenantId — cannot raise a staff flag', {
        agreementId: agreement.id, voidedRef,
      });
    } else {
      await paymentOpsQueue.raise({
        tenantId: agreement.tenantId,
        // Reusing an existing kind on purpose — this ship stays migration-free.
        // The old hold was surrendered as one leg of a replace that then failed,
        // so the outstanding work is a compensating action that did not
        // complete. STRANDED_DEPOSIT_HOLD is the OPPOSITE problem ("hold still
        // live on the card") and would send staff to void something already
        // voided; ORPHAN_PAYMENT/CARD_ON_FILE_FAILED/NAME_MISMATCH_REVIEW all
        // presuppose money that moved, and no money moved here.
        kind: 'ROLLBACK_FAILED',
        // A gateway call WAS made and refused — never NOT_ATTEMPTED.
        status: 'GATEWAY_FAILED',
        reservationId: agreement.reservationId || null,
        rentalAgreementId: agreement.id,
        gatewayRef: voidedRef,
        amount,
        note: `Deposit hold ${voidedRef} was VOIDED at the gateway but its replacement `
          + `$${Number(amount || 0).toFixed(2)} re-auth failed. There is NO deposit hold on this `
          + 'rental — place a new hold on the card.',
        lastError: errMessage,
      });
    }
  } catch (err) {
    logger.error('[spin-reauth] FAILED to raise the payment ops flag for a released deposit hold', {
      agreementId: agreement.id, voidedRef, err: err.message,
    });
  }

  try {
    await prisma.auditLog.create({
      data: {
        tenantId: agreement.tenantId || null,
        reservationId: agreement.reservationId,
        actorUserId: actorUserId || null,
        action: 'UPDATE',
        reason: 'Spin deposit hold voided but the re-auth failed — no hold in place',
        metadata: JSON.stringify({
          voidedRef,
          attemptedAmount: amount,
          previousHoldId: agreement.depositHoldId || null,
          error: errMessage,
        }),
      },
    });
  } catch {}
}

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

function authNetMessage(payload = {}) {
  const nestedBody = payload?.body || null;
  const nestedResponse = payload?.createTransactionResponse || nestedBody?.createTransactionResponse || null;
  if (nestedResponse && nestedResponse !== payload) {
    const nestedMessage = authNetMessage(nestedResponse);
    if (nestedMessage) return nestedMessage;
  }
  const directMessages = Array.isArray(payload?.messages?.message)
    ? payload.messages.message
    : payload?.messages?.message
      ? [payload.messages.message]
      : [];
  const direct = directMessages.map((row) => String(row?.text || '').trim()).find(Boolean);
  if (direct) return direct;

  const txErrors = Array.isArray(payload?.transactionResponse?.errors?.error)
    ? payload.transactionResponse.errors.error
    : payload?.transactionResponse?.errors?.error
      ? [payload.transactionResponse.errors.error]
      : [];
  return txErrors.map((row) => String(row?.errorText || row?.text || '').trim()).find(Boolean) || '';
}

function authNetTransactionEnvelope(payload = {}) {
  const body = payload?.body || null;
  return payload?.createTransactionResponse || body?.createTransactionResponse || body || payload || {};
}

function authNetInvoiceNumberValue(value = '') {
  return String(value || '')
    .trim()
    .replace(/\s+/g, ' ')
    .slice(0, 20)
    .toUpperCase();
}

function authNetCleanValue(value, fallback = '') {
  const text = String(value ?? fallback ?? '').trim();
  return text.replace(/\s+/g, ' ').slice(0, 255);
}

function authNetCompactObject(obj = {}) {
  return Object.fromEntries(
    Object.entries(obj).filter(([, value]) => String(value ?? '').trim() !== '')
  );
}

function authNetCustomerIdValue(customerId = '', reservationId = '') {
  return String(customerId || reservationId || '')
    .trim()
    .replace(/[^a-z0-9]/gi, '')
    .slice(0, 20);
}

function authNetCustomerSupplement(customer = null, reservationId = '') {
  const customerPayload = authNetCompactObject({
    merchantCustomerId: authNetCustomerIdValue(customer?.id || '', reservationId || ''),
    email: authNetCleanValue(customer?.email || '', '')
  });
  const billToPayload = authNetCompactObject({
    firstName: authNetCleanValue(customer?.firstName || '', ''),
    lastName: authNetCleanValue(customer?.lastName || '', ''),
    address: authNetCleanValue(customer?.address1 || '', ''),
    city: authNetCleanValue(customer?.city || '', ''),
    state: authNetCleanValue(customer?.state || '', ''),
    zip: authNetCleanValue(customer?.zip || '', ''),
    country: authNetCleanValue(customer?.country || 'USA', ''),
    phoneNumber: authNetCleanValue(customer?.phone || '', '')
  });
  return { customerPayload, billToPayload };
}

function authNetTransIdValue(value = '') {
  const raw = String(value || '').trim();
  if (!raw) return '';
  return raw.toUpperCase().startsWith('AUTHNET:')
    ? raw.slice('AUTHNET:'.length).trim()
    : raw;
}

async function authNetTransactionDetails(transId, scope = {}) {
  const cfg = await authNetConfig(scope);
  if (!cfg.loginId || !cfg.transactionKey) throw new Error('Authorize.Net is not configured');
  const out = await authNetRequest({
    getTransactionDetailsRequest: {
      merchantAuthentication: {
        name: cfg.loginId,
        transactionKey: cfg.transactionKey
      },
      transId: String(transId || '').trim()
    }
  }, scope);
  return out?.getTransactionDetailsResponse || out || {};
}

function authNetDuplicateProfileId(message = '') {
  const text = String(message || '').trim();
  const match = text.match(/\bduplicate record with ID\s+(\d+)\b/i) || text.match(/\brecord with ID\s+(\d+)\b/i);
  return match?.[1] ? String(match[1]).trim() : '';
}

async function authNetEnsureCustomerProfile({ customer, reservationId = '', scope = {} }) {
  const customerId = String(customer?.id || '').trim();
  if (!customerId) throw new Error('Customer not found');

  const existing = await prisma.customer.findUnique({
    where: { id: customerId },
    select: { authnetCustomerProfileId: true }
  });
  const existingProfileId = String(existing?.authnetCustomerProfileId || '').trim();
  if (existingProfileId) return existingProfileId;

  const cfg = await authNetConfig(scope);
  if (!cfg.loginId || !cfg.transactionKey) throw new Error('Authorize.Net is not configured');

  const profilePayload = authNetCompactObject({
    merchantCustomerId: authNetCustomerIdValue(customerId, reservationId),
    description: authNetCleanValue([customer?.firstName, customer?.lastName].filter(Boolean).join(' '), ''),
    email: authNetCleanValue(customer?.email || '', '')
  });

  const out = await authNetRequest({
    createCustomerProfileRequest: {
      merchantAuthentication: {
        name: cfg.loginId,
        transactionKey: cfg.transactionKey
      },
      profile: profilePayload
    }
  }, scope);

  const resp = out?.createCustomerProfileResponse || out || {};
  if (String(resp?.messages?.resultCode || '').trim() !== 'Ok') {
    const duplicateProfileId = authNetDuplicateProfileId(authNetMessage(resp));
    if (!duplicateProfileId) {
      throw new Error(authNetMessage(resp) || 'Unable to create Authorize.Net customer profile');
    }
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

async function authNetCustomerProfile(profileId, scope = {}) {
  const cfg = await authNetConfig(scope);
  if (!cfg.loginId || !cfg.transactionKey) throw new Error('Authorize.Net is not configured');
  const out = await authNetRequest({
    getCustomerProfileRequest: {
      merchantAuthentication: {
        name: cfg.loginId,
        transactionKey: cfg.transactionKey
      },
      customerProfileId: String(profileId || '').trim()
    }
  }, scope);
  return out?.getCustomerProfileResponse || out || {};
}

/**
 * GDPR sub-processor erasure: delete an Authorize.Net CIM customer profile.
 *
 * BEST-EFFORT. Called by the customer-erasure service AFTER the DB transaction
 * commits, so a gateway hiccup never rolls back the local erasure. Never throws:
 * returns { ok, code, message } so the caller can log + continue. Deleting the
 * customer profile removes its payment profiles (stored cards) upstream too.
 *
 * A 'E00040' (record not found) is treated as success — the profile is already
 * gone, which is exactly the desired end state and keeps re-runs idempotent.
 */
export async function authNetDeleteCustomerProfile(profileId, scope = {}) {
  const customerProfileId = String(profileId || '').trim();
  if (!customerProfileId) return { ok: true, code: 'NOOP', message: 'no profile id' };
  try {
    const cfg = await authNetConfig(scope);
    if (!cfg.loginId || !cfg.transactionKey) {
      return { ok: false, code: 'NOT_CONFIGURED', message: 'Authorize.Net is not configured' };
    }
    const out = await authNetRequest({
      deleteCustomerProfileRequest: {
        merchantAuthentication: {
          name: cfg.loginId,
          transactionKey: cfg.transactionKey
        },
        customerProfileId
      }
    }, scope);
    const resp = out?.deleteCustomerProfileResponse || out || {};
    const resultCode = String(resp?.messages?.resultCode || '').trim();
    if (resultCode === 'Ok') return { ok: true, code: 'DELETED', message: '' };
    const firstMsg = Array.isArray(resp?.messages?.message)
      ? resp.messages.message[0]
      : resp?.messages?.message;
    const errCode = String(firstMsg?.code || '').trim();
    // Already-absent profile — the desired end state.
    if (errCode === 'E00040') return { ok: true, code: 'ALREADY_ABSENT', message: authNetMessage(resp) };
    return { ok: false, code: errCode || 'ERROR', message: authNetMessage(resp) || 'delete failed' };
  } catch (err) {
    return { ok: false, code: 'EXCEPTION', message: err?.message || String(err) };
  }
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

// Pillar 2 — Extract denormalized card metadata from a getCustomerProfile
// response so we can render "card ending in XXXX" without a per-display
// API call. Returns null fields when the response is masked / absent.
//
// AuthNet response shape (relevant portion):
//   profileResp.profile.paymentProfiles[0].payment.creditCard = {
//     cardNumber: 'XXXX1111',     // last 4 visible
//     expirationDate: 'XXXX' | 'MM/YYYY',  // masked in prod by default
//     cardType: 'Visa' | 'MasterCard' | ...
//   }
function authNetExtractCardMetadata(profileResp = {}) {
  const profile = profileResp?.profile || profileResp?.customerProfile || null;
  const paymentProfiles = Array.isArray(profile?.paymentProfiles)
    ? profile.paymentProfiles
    : profile?.paymentProfiles
      ? [profile.paymentProfiles]
      : [];
  const first = paymentProfiles[0] || null;
  const cc = first?.payment?.creditCard || null;
  if (!cc) return { cardLast4: null, cardBrand: null, cardExpiresMonth: null, cardExpiresYear: null };

  // cardNumber is masked like 'XXXX1111' — pull the trailing 4 digits.
  const last4Match = String(cc.cardNumber || '').match(/(\d{4})\s*$/);
  const cardLast4 = last4Match ? last4Match[1] : null;

  const cardBrand = String(cc.cardType || '').trim() || null;

  // expirationDate may be 'XXXX' (masked, prod default), 'MM/YYYY', or
  // 'YYYY-MM'. We only persist when we get something parseable.
  const exp = String(cc.expirationDate || '').trim();
  let cardExpiresMonth = null;
  let cardExpiresYear = null;
  const mmYY = exp.match(/^(\d{1,2})\/(\d{2}|\d{4})$/);
  const yyMM = exp.match(/^(\d{4})-(\d{1,2})$/);
  if (mmYY) {
    cardExpiresMonth = Number(mmYY[1]);
    const yr = Number(mmYY[2]);
    cardExpiresYear = yr < 100 ? 2000 + yr : yr;
  } else if (yyMM) {
    cardExpiresYear = Number(yyMM[1]);
    cardExpiresMonth = Number(yyMM[2]);
  }

  return { cardLast4, cardBrand, cardExpiresMonth, cardExpiresYear };
}

async function authNetResolveStoredCustomerProfile(customerId, scope = {}) {
  if (!customerId) return null;
  const customer = await prisma.customer.findUnique({
    where: { id: customerId },
    select: {
      authnetCustomerProfileId: true,
      authnetPaymentProfileId: true
    }
  });
  const customerProfileId = String(customer?.authnetCustomerProfileId || '').trim();
  const paymentProfileId = String(customer?.authnetPaymentProfileId || '').trim();
  if (customerProfileId && paymentProfileId) {
    return { customerProfileId, paymentProfileId, alreadySaved: true };
  }
  if (!customerProfileId) return null;
  const profileResp = await authNetCustomerProfile(customerProfileId, scope);
  const resolvedPaymentProfileId = authNetExtractPaymentProfileId(profileResp);
  if (!resolvedPaymentProfileId) return null;
  const cardMeta = authNetExtractCardMetadata(profileResp);
  await prisma.customer.update({
    where: { id: customerId },
    data: {
      authnetCustomerProfileId: customerProfileId,
      authnetPaymentProfileId: resolvedPaymentProfileId,
      ...(cardMeta.cardLast4 ? {
        cardLast4: cardMeta.cardLast4,
        cardBrand: cardMeta.cardBrand,
        cardExpiresMonth: cardMeta.cardExpiresMonth,
        cardExpiresYear: cardMeta.cardExpiresYear,
        cardUpdatedAt: new Date()
      } : {})
    }
  });
  return {
    customerProfileId,
    paymentProfileId: resolvedPaymentProfileId,
    alreadySaved: true,
    cardLast4: cardMeta.cardLast4,
    cardBrand: cardMeta.cardBrand
  };
}

async function authNetUnsettledTransactions(scope = {}) {
  const cfg = await authNetConfig(scope);
  if (!cfg.loginId || !cfg.transactionKey) throw new Error('Authorize.Net is not configured');
  const out = await authNetRequest({
    getUnsettledTransactionListRequest: {
      merchantAuthentication: {
        name: cfg.loginId,
        transactionKey: cfg.transactionKey
      },
      sorting: {
        orderBy: 'submitTimeUTC',
        orderDescending: true
      },
      paging: {
        limit: 100,
        offset: 1
      }
    }
  }, scope);
  const resp = out?.getUnsettledTransactionListResponse || out || {};
  const transactions = Array.isArray(resp?.transactions?.transaction)
    ? resp.transactions.transaction
    : resp?.transactions?.transaction
      ? [resp.transactions.transaction]
      : [];
  return transactions;
}

async function authNetSettledBatchTransactions(scope = {}, daysBack = 3) {
  const cfg = await authNetConfig(scope);
  if (!cfg.loginId || !cfg.transactionKey) throw new Error('Authorize.Net is not configured');

  const now = new Date();
  const firstSettlementDate = new Date(now.getTime() - Math.max(1, Number(daysBack || 1)) * 24 * 60 * 60 * 1000);
  const out = await authNetRequest({
    getSettledBatchListRequest: {
      merchantAuthentication: {
        name: cfg.loginId,
        transactionKey: cfg.transactionKey
      },
      includeStatistics: false,
      firstSettlementDate: firstSettlementDate.toISOString(),
      lastSettlementDate: now.toISOString()
    }
  }, scope);
  const resp = out?.getSettledBatchListResponse || out || {};
  const batches = Array.isArray(resp?.batchList?.batch)
    ? resp.batchList.batch
    : resp?.batchList?.batch
      ? [resp.batchList.batch]
      : [];

  const recentBatches = batches
    .map((batch) => {
      const settledAt = batch?.settlementTimeUTC || batch?.settlementTimeLocal || batch?.settlementTime || null;
      const settledMs = settledAt ? new Date(settledAt).getTime() : 0;
      return {
        batchId: String(batch?.batchId || '').trim(),
        settledMs: Number.isFinite(settledMs) ? settledMs : 0
      };
    })
    .filter((row) => row.batchId)
    .sort((a, b) => b.settledMs - a.settledMs)
    .slice(0, 6);

  const transactions = [];
  for (const batch of recentBatches) {
    const txOut = await authNetRequest({
      getTransactionListRequest: {
        merchantAuthentication: {
          name: cfg.loginId,
          transactionKey: cfg.transactionKey
        },
        batchId: batch.batchId,
        sorting: {
          orderBy: 'submitTimeUTC',
          orderDescending: true
        },
        paging: {
          limit: 100,
          offset: 1
        }
      }
    }, scope);
    const txResp = txOut?.getTransactionListResponse || txOut || {};
    const batchTransactions = Array.isArray(txResp?.transactions?.transaction)
      ? txResp.transactions.transaction
      : txResp?.transactions?.transaction
        ? [txResp.transactions.transaction]
        : [];
    transactions.push(...batchTransactions);
  }

  return transactions;
}

async function authNetRecentTransactions(scope = {}) {
  const [unsettled, settled] = await Promise.all([
    authNetUnsettledTransactions(scope).catch(() => []),
    authNetSettledBatchTransactions(scope).catch(() => [])
  ]);

  const seen = new Set();
  return [...unsettled, ...settled].filter((row) => {
    const transId = String(row?.transId || '').trim();
    if (!transId || seen.has(transId)) return false;
    seen.add(transId);
    return true;
  });
}

async function authNetEnrichRecentTransactions(transactions = [], scope = {}, limit = 12) {
  const rows = Array.isArray(transactions) ? transactions : [];
  if (!rows.length) return [];
  const recent = rows
    .map((row) => {
      const submittedAt = row?.submitTimeUTC || row?.submitTimeLocal || row?.submitTime || null;
      const submittedMs = submittedAt ? new Date(submittedAt).getTime() : 0;
      return {
        row,
        transId: String(row?.transId || '').trim(),
        submittedMs: Number.isFinite(submittedMs) ? submittedMs : 0
      };
    })
    .filter((entry) => entry.transId)
    .sort((a, b) => b.submittedMs - a.submittedMs)
    .slice(0, Math.max(1, Number(limit || 12)));

  const enriched = await Promise.all(recent.map(async (entry) => {
    try {
      const details = await authNetTransactionDetails(entry.transId, scope);
      const tx = details?.transaction || {};
      return {
        ...entry.row,
        ...tx,
        order: tx?.order || entry.row?.order || null,
        invoiceNumber: tx?.order?.invoiceNumber || tx?.invoiceNumber || entry.row?.invoiceNumber || entry.row?.order?.invoiceNumber || '',
        authAmount: tx?.authAmount || entry.row?.authAmount || '',
        settleAmount: tx?.settleAmount || entry.row?.settleAmount || '',
        amount: tx?.authAmount || tx?.settleAmount || entry.row?.authAmount || entry.row?.settleAmount || entry.row?.amount || '',
        transactionStatus: tx?.transactionStatus || entry.row?.transactionStatus || '',
        submitTimeUTC: tx?.submitTimeUTC || entry.row?.submitTimeUTC || '',
        submitTimeLocal: tx?.submitTimeLocal || entry.row?.submitTimeLocal || ''
      };
    } catch {
      return entry.row;
    }
  }));

  const seen = new Set();
  return enriched.filter((row) => {
    const transId = String(row?.transId || '').trim();
    if (!transId || seen.has(transId)) return false;
    seen.add(transId);
    return true;
  });
}

async function saveAuthNetCardProfileFromReference({ customerId, reference, scope = {}, customer = null, reservationId = '' }) {
  const existing = await authNetResolveStoredCustomerProfile(customerId, scope);
  if (existing) return existing;

  const cfg = await authNetConfig(scope);
  if (!cfg.loginId || !cfg.transactionKey) throw new Error('Authorize.Net is not configured');
  const rawRef = String(reference || '').trim();
  const transId = rawRef.startsWith('AUTHNET:') ? rawRef.slice('AUTHNET:'.length).trim() : rawRef;
  if (!transId) throw new Error('Authorize.Net transaction reference is required');

  const buildRequest = () => ({
    createCustomerProfileFromTransactionRequest: {
      merchantAuthentication: {
        name: cfg.loginId,
        transactionKey: cfg.transactionKey
      },
      transId
    }
  });

  let out = await authNetRequest(buildRequest(), scope);
  let resp = out?.createCustomerProfileResponse || out?.createCustomerProfileFromTransactionResponse || out || {};
  let message = authNetMessage(resp) || 'Unable to save card on file from Authorize.Net transaction';

  if (
    String(resp?.messages?.resultCode || '').trim() !== 'Ok'
    && /customer info is missing/i.test(message)
    && customer
  ) {
    const customerProfileId = await authNetEnsureCustomerProfile({ customer, reservationId, scope });
    out = await authNetRequest({
      createCustomerProfileFromTransactionRequest: {
        merchantAuthentication: {
          name: cfg.loginId,
          transactionKey: cfg.transactionKey
        },
        transId,
        customerProfileId
      }
    }, scope);
    resp = out?.createCustomerProfileResponse || out?.createCustomerProfileFromTransactionResponse || out || {};
    message = authNetMessage(resp) || message;
  }

  if (String(resp?.messages?.resultCode || '').trim() !== 'Ok') {
    const retryExisting = await authNetResolveStoredCustomerProfile(customerId, scope);
    if (retryExisting) return retryExisting;
    const duplicateProfileId = authNetDuplicateProfileId(message);
    if (duplicateProfileId) {
      const profileResp = await authNetCustomerProfile(duplicateProfileId, scope);
      const paymentProfileId = authNetExtractPaymentProfileId(profileResp);
      if (paymentProfileId) {
        const cardMeta = authNetExtractCardMetadata(profileResp);
        await prisma.customer.update({
          where: { id: customerId },
          data: {
            authnetCustomerProfileId: String(duplicateProfileId),
            authnetPaymentProfileId: String(paymentProfileId),
            ...(cardMeta.cardLast4 ? {
              cardLast4: cardMeta.cardLast4,
              cardBrand: cardMeta.cardBrand,
              cardExpiresMonth: cardMeta.cardExpiresMonth,
              cardExpiresYear: cardMeta.cardExpiresYear,
              cardUpdatedAt: new Date()
            } : {})
          }
        });
        return {
          customerProfileId: String(duplicateProfileId),
          paymentProfileId: String(paymentProfileId),
          alreadySaved: true
        };
      }
    }
    throw new Error(message);
  }

  const customerProfileId = resp?.customerProfileId || null;
  const paymentProfileId = Array.isArray(resp?.customerPaymentProfileIdList?.numericString)
    ? resp.customerPaymentProfileIdList.numericString[0]
    : (resp?.customerPaymentProfileIdList?.numericString || null);
  let resolvedPaymentProfileId = String(paymentProfileId || '').trim();
  const resolvedCustomerProfileId = String(customerProfileId || '').trim();
  // Pillar 2 — fetch the profile so we can extract card metadata for the
  // card-on-file invoice notice. Even if we already have paymentProfileId,
  // we still need the GET to access creditCard fields.
  let cardMeta = { cardLast4: null, cardBrand: null, cardExpiresMonth: null, cardExpiresYear: null };
  if (resolvedCustomerProfileId) {
    try {
      const profileResp = await authNetCustomerProfile(resolvedCustomerProfileId, scope);
      if (!resolvedPaymentProfileId) {
        resolvedPaymentProfileId = authNetExtractPaymentProfileId(profileResp);
      }
      cardMeta = authNetExtractCardMetadata(profileResp);
    } catch (err) {
      // Non-fatal — card metadata is best-effort. If we can't fetch it,
      // we still save the profile IDs so the charge path works.
    }
  }
  if (!resolvedCustomerProfileId || !resolvedPaymentProfileId) {
    throw new Error('Authorize.Net did not return a reusable customer payment profile');
  }

  await prisma.customer.update({
    where: { id: customerId },
    data: {
      authnetCustomerProfileId: resolvedCustomerProfileId,
      authnetPaymentProfileId: resolvedPaymentProfileId,
      ...(cardMeta.cardLast4 ? {
        cardLast4: cardMeta.cardLast4,
        cardBrand: cardMeta.cardBrand,
        cardExpiresMonth: cardMeta.cardExpiresMonth,
        cardExpiresYear: cardMeta.cardExpiresYear,
        cardUpdatedAt: new Date()
      } : {})
    }
  });

  return {
    customerProfileId: resolvedCustomerProfileId,
    paymentProfileId: resolvedPaymentProfileId,
    cardLast4: cardMeta.cardLast4,
    cardBrand: cardMeta.cardBrand
  };
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

// Default tenant timezone for agreement HTML / PDF rendering.
// 2026-05-26: bare `toLocaleString()` here picked up the backend container's
// TZ=UTC and rendered 15:19 (UTC storage) as 3:19 PM on the agreement PDF,
// even after the reservation list/detail and check-in wizard were fixed.
// A future multi-tenant pass should resolve this from
// settingsService.getReservationOptions({tenantId}) per agreement, but the
// existing fmtDate callers don't have scope threaded through them; defaulting
// to America/Puerto_Rico matches our only production tenant today and keeps
// the change surgical.
const AGREEMENT_RENDER_TZ = 'America/Puerto_Rico';

function fmtDate(v, tenantTz = AGREEMENT_RENDER_TZ) {
  if (!v) return '-';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return '-';
  return d.toLocaleString('en-US', { timeZone: tenantTz });
}

function esc(s) {
  return String(s ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function companyInitials(name = '') {
  const words = String(name || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!words.length) return 'RF';
  return words
    .slice(0, 2)
    .map((part) => String(part || '').charAt(0).toUpperCase())
    .join('') || 'RF';
}

function buildCompanyLogoBlock(companyName = '', companyLogoUrl = '') {
  const logoUrl = String(companyLogoUrl || '').trim();
  if (logoUrl) {
    return `<img src="${esc(logoUrl)}" alt="${esc(companyName || 'Company Logo')}" />`;
  }
  return `<div class="logo-fallback">${esc(companyInitials(companyName))}</div>`;
}

function applyTemplate(html, vars = {}) {
  let out = String(html || '');
  for (const [k, v] of Object.entries(vars)) {
    out = out.replaceAll(`{{${k}}}`, String(v ?? ''));
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Addendum print rendering
//
// Both the agreement print AND the standalone addendum print converge on the
// same modern dark-theme styling so the output looks like one cohesive
// document set instead of an upmarket agreement plus a 2002-era addendum.
// We do this by:
//
//   - reusing the agreement-modern.html template's chrome (doctype, head,
//     <style>, opening <body>) as a "shell" wrapper for standalone addendums,
//     so any future style change in agreement-modern.html flows through to
//     addendums automatically (no CSS duplication);
//   - exposing a body-only builder that the agreement print can splice in
//     right before its </body>, producing a multi-page PDF where each
//     addendum gets its own page-break section that visually matches the
//     parent agreement (same .hero, .tile, .section, .sig-row, .verify-box).
// ─────────────────────────────────────────────────────────────────────────────

function statusLabel(s) {
  switch (String(s || '').toUpperCase()) {
    case 'PENDING_SIGNATURE': return 'Pending Signature';
    case 'SIGNED': return 'Signed';
    case 'VOID': return 'Void';
    default: return s || '-';
  }
}

function reasonCategoryLabel(c) {
  return String(c || '-').replace(/_/g, ' ').replace(/\b\w/g, (l) => l.toUpperCase());
}

/**
 * Returns the agreement-modern.html template split at <body> so callers can
 * sandwich custom body content between a fully-styled head and a closing
 * `</body></html>`. Callers pass the company-context vars they need (logo,
 * company name) since the head still references some `{{...}}` placeholders.
 */
function getModernShell(templateVars = {}) {
  const tpl = applyTemplate(getModernAgreementTemplate(), templateVars);
  const bodyOpenIdx = tpl.indexOf('<body>');
  const bodyCloseIdx = tpl.lastIndexOf('</body>');
  if (bodyOpenIdx < 0 || bodyCloseIdx < 0) {
    return { head: tpl, foot: '' };
  }
  const head = tpl.slice(0, bodyOpenIdx + '<body>'.length);
  const foot = tpl.slice(bodyCloseIdx);
  return { head, foot };
}

/**
 * Builds the inner-body markup for one addendum. Reuses CSS classes already
 * defined in agreement-modern.html (.page, .hero, .tile, .section, .sig-row,
 * .verify-box) so this renders identically whether spliced into the agreement
 * print or used as the only body content of a standalone addendum print.
 *
 * `idx` is the 1-based ordinal in the agreement's addendum series.
 * `total` is the count of non-VOID addendums on the agreement (footer label).
 */
function buildAddendumPageHtml(addendum, idx, total, ctx) {
  const status = String(addendum.status || '').toUpperCase();
  const sigImage = addendum.signatureDataUrl
    ? `<img src="${addendum.signatureDataUrl}" alt="Signature" style="max-height:45px;max-width:280px;width:auto;height:auto;object-fit:contain;display:block" />`
    : `<div class="sig-meta">${
        status === 'PENDING_SIGNATURE'
          ? 'Awaiting customer signature'
          : status === 'VOID'
            ? 'Voided'
            : 'No signature on file'
      }</div>`;

  const companyName = esc(ctx.cfg?.companyName || '');
  const agreementNumber = esc(ctx.agreement?.agreementNumber || '');
  const initiatedBy = addendum.initiatedByRole
    ? `${esc(addendum.initiatedByRole)}${addendum.initiatedBy ? ` · ${esc(String(addendum.initiatedBy).slice(0, 8))}` : ''}`
    : '-';

  return `
<div class="page page-break">

  <div class="hero">
    <div class="brand">
      <div class="logo">${ctx.companyLogoBlock || ''}</div>
      <div>
        <div class="co-name">${companyName}</div>
        <div class="co-sub">Agreement ${agreementNumber} &mdash; Addendum ${idx} of ${total}</div>
      </div>
    </div>
    <div class="ag-badge">${esc(statusLabel(status))}</div>
  </div>

  <div class="g g4">
    <div class="tile"><div class="k">Updated Pickup</div><div class="v vs">${esc(fmtDate(addendum.pickupAt))}</div></div>
    <div class="tile"><div class="k">Updated Return</div><div class="v vs">${esc(fmtDate(addendum.returnAt))}</div></div>
    <div class="tile"><div class="k">Created</div><div class="v vs">${esc(fmtDate(addendum.createdAt))}</div></div>
    <div class="tile"><div class="k">Status</div><div class="v vs">${esc(statusLabel(status))}</div></div>
  </div>

  <div class="section">
    <h3>Reason for Change</h3>
    <div class="g g4">
      <div class="tile span2"><div class="k">Reason</div><div class="v vs">${esc(addendum.reason || '-')}</div></div>
      <div class="tile"><div class="k">Category</div><div class="v vs">${esc(reasonCategoryLabel(addendum.reasonCategory))}</div></div>
      <div class="tile"><div class="k">Initiated By</div><div class="v vs">${initiatedBy}</div></div>
    </div>
  </div>

  <div class="section">
    <h3>Customer Signature</h3>
    <div class="sig-row">
      <div class="sig-box">
        <div class="sig-meta">
          Signed by: <strong>${esc(addendum.signatureSignedBy || '-')}</strong> &nbsp;&middot;&nbsp;
          Date: <strong>${esc(addendum.signatureSignedAt ? fmtDate(addendum.signatureSignedAt) : '-')}</strong> &nbsp;&middot;&nbsp;
          IP: <strong>${esc(addendum.signatureIp || '-')}</strong>
        </div>
        <div class="sig-img">${sigImage}</div>
        <div class="sig-line">
          <div class="sig-line-label">Customer Signature</div>
        </div>
      </div>
      <div class="verify-box">
        <h4>Verification</h4>
        <div class="vline">Agreement:<br/><code>${agreementNumber}</code></div>
        <div class="vline">Addendum:<br/><code>${idx} of ${total}</code></div>
        <div class="vline">Issuer:<br/>${companyName}</div>
        <div class="vline">Status:<br/>${esc(statusLabel(status))}</div>
      </div>
    </div>
  </div>

  <div class="footer">
    ${companyName} &bull; Agreement ${agreementNumber} &bull; Addendum ${idx} of ${total}
  </div>

</div>
`;
}

/**
 * Builds the body content for one or more addendums. VOID addendums are
 * intentionally included so the legal record is complete (the addendum
 * print is consumed by audit reviews, not just operational). Pass an empty
 * array to get an empty string back (callers can short-circuit).
 */
function buildAddendumPagesHtml(addendums, ctx) {
  const list = Array.isArray(addendums) ? addendums : [];
  if (list.length === 0) return '';
  const total = list.length;
  return list.map((a, i) => buildAddendumPageHtml(a, i + 1, total, ctx)).join('\n');
}

// 2026-05-28 — Strip the Section 4 "I voluntarily DECLINE all such
// optional coverage" bilingual acknowledgement from the canonical T&C
// body when the customer did NOT decline counter insurance.
//
// The canonical tc-<version>.html contains five tc-initials-block
// divs. The FIRST one (around line 189 of tc-2026-05-19.html) is the
// decline-coverage statement; the other four (card-on-file, CNP,
// no-chargeback, post-rental) apply to every agreement and must stay.
//
// We identify the decline block by content match ("DECLINE all such
// optional coverage" appears in the English column) and walk forward
// using a balanced-div counter so the nested tc-bilingual + two
// tc-col divs don't trip up a naive non-greedy regex.
//
// Returns the input HTML unchanged when:
//   - the customer DID decline insurance (declined === true)
//   - no matching block is found (legacy templates, custom T&C)
function stripDeclineCoverageIfNotApplicable(html, declined) {
  if (declined) return html;
  const opener = '<div class="tc-initials-block">';
  let start = html.indexOf(opener);
  while (start !== -1) {
    let depth = 1;
    let i = start + opener.length;
    while (i < html.length && depth > 0) {
      const nextOpen = html.indexOf('<div', i);
      const nextClose = html.indexOf('</div>', i);
      if (nextClose === -1) break;
      if (nextOpen !== -1 && nextOpen < nextClose) {
        depth += 1;
        i = nextOpen + 4;
      } else {
        depth -= 1;
        i = nextClose + 6;
      }
    }
    const end = i;
    const block = html.slice(start, end);
    if (/DECLINE all such optional coverage/i.test(block)) {
      // Found the decline block. Excise it (plus any trailing whitespace
      // up to the next non-space character so we don't leave a blank
      // gap on the rendered page).
      let trim = end;
      while (trim < html.length && /\s/.test(html[trim])) trim += 1;
      return html.slice(0, start) + html.slice(trim);
    }
    start = html.indexOf(opener, end);
  }
  return html;
}

// 2026-05-28 — Phase 3.3 + 3.4 — Append the customer's signed T&C
// section (with each subsection's initial image embedded inline) plus
// the optional declined-insurance addendum to the agreement PDF.
//
// Reads TC_SECTIONS from terms-content.js to build the section list
// dynamically. The customer's per-section initials live on
// agreement.sectionInitials[]; the final consolidated signature is on
// agreement.tcSignatureDataUrl.
function buildSignedTermsBlock(agreement, ctx) {
  // Same override source the signing flows used (2026-07-24). These pages carry
  // the customer's own initials next to each section's text, so printing the
  // canonical text here while they initialled the branch's would put a
  // contradiction inside one signed document — a $500 deposit acknowledgement
  // beside a $2,000 branch body.
  const sections = sectionsForAgreement({
    declinedInsurance: !!agreement.declinedInsurance,
    sectionOverrides: agreement.pickupLocation?.termsSectionsJson,
  });
  const initials = Array.isArray(agreement.sectionInitials) ? agreement.sectionInitials : [];
  const initialsByKey = new Map(initials.map((i) => [i.sectionKey, i]));

  if (!agreement.tcSignatureDataUrl && initials.length === 0) {
    // Nothing to render — agreement was created via the legacy flow,
    // not the new checkout-wizard-v2.
    return '';
  }

  const tcSignedAt = agreement.tcSignedAt
    ? new Date(agreement.tcSignedAt).toLocaleString('en-US', { timeZone: 'America/Puerto_Rico' })
    : '—';
  const signerName = esc(agreement.tcSignerName || `${agreement.customerFirstName || ''} ${agreement.customerLastName || ''}`.trim() || '—');

  const sectionRows = sections.map((s) => {
    const recorded = initialsByKey.get(s.key);
    const initialImg = recorded?.initialDataUrl
      ? `<img src="${recorded.initialDataUrl}" alt="Initial" style="max-height:40px;max-width:80px;border:0.5px solid #D1D5DB;border-radius:4px;padding:2px;background:#fff" />`
      : '<span style="color:#9CA3AF;font-size:11px">(no initial)</span>';
    const recordedAt = recorded?.signedAt
      ? new Date(recorded.signedAt).toLocaleString('en-US', { timeZone: 'America/Puerto_Rico' })
      : '';
    return `
      <div style="margin:0 0 18px;padding:14px;border:0.5px solid #E5E7EB;border-radius:8px;background:#FFF;page-break-inside:avoid">
        <div style="font-size:13px;font-weight:600;color:#111827;margin:0 0 6px">${esc(s.label)}</div>
        <div style="font-size:12px;color:#374151;line-height:1.55;margin:0 0 10px">${esc(s.body)}</div>
        <div style="display:flex;justify-content:flex-end;align-items:center;gap:12px">
          <span style="font-size:10.5px;color:#6B7280">${esc(recordedAt)}</span>
          ${initialImg}
        </div>
      </div>`;
  }).join('');

  const finalSignatureBlock = agreement.tcSignatureDataUrl
    ? `<img src="${agreement.tcSignatureDataUrl}" alt="Customer signature" style="max-height:80px;max-width:360px;display:block;border-bottom:1px solid #111827" />`
    : '<div style="color:#9CA3AF;font-size:12px">(no final signature)</div>';

  const logo = ctx?.companyLogoBlock || '';
  const cfg = ctx?.cfg || {};
  const companyName = esc(cfg.companyName || '');

  // 2026-05-28 — wrap in a light-theme container so the appended page
  // renders white regardless of the tenant's base template colors.
  // The outer div carries inline `all: revert` to break inheritance
  // from the tenant CSS, then we re-establish a clean print stylesheet.
  return `
    <div style="page-break-before:always;background:#FFFFFF;color:#111827;padding:40px;font-family:-apple-system,BlinkMacSystemFont,'Helvetica Neue',Arial,sans-serif;all:revert">
      <div style="display:flex;justify-content:space-between;align-items:center;margin:0 0 24px;padding:0 0 16px;border-bottom:1px solid #111827;background:#FFFFFF">
        <div>
          <div style="font-size:11px;color:#6B7280;letter-spacing:.08em;text-transform:uppercase">Signed acknowledgement</div>
          <div style="font-size:18px;font-weight:600;margin-top:4px;color:#111827">Terms &amp; Conditions</div>
          <div style="font-size:11px;color:#6B7280;margin-top:2px">Agreement ${esc(agreement.agreementNumber)} · ${companyName}</div>
        </div>
        ${logo}
      </div>
      <p style="font-size:12px;color:#374151;margin:0 0 18px;line-height:1.5">
        The renter initialed each section below and signed at the bottom on
        ${esc(tcSignedAt)}. The full Terms &amp; Conditions document is incorporated by
        reference and was made available at the time of signing.
      </p>
      ${sectionRows}
      <div style="margin-top:28px;padding-top:18px;border-top:1px solid #111827;page-break-inside:avoid;background:#FFFFFF">
        <div style="font-size:11px;color:#6B7280;letter-spacing:.06em;text-transform:uppercase;margin:0 0 8px">Renter signature</div>
        ${finalSignatureBlock}
        <div style="font-size:12px;margin-top:6px;color:#111827">${signerName}</div>
        <div style="font-size:10.5px;color:#6B7280;margin-top:2px">Signed ${esc(tcSignedAt)}${agreement.tcCustomerIp ? ` · ${esc(agreement.tcCustomerIp)}` : ''}</div>
      </div>
    </div>`;
}

// Phase 3.4 — Declined insurance addendum page. Only emitted when the
// agent flipped the "Customer declines counter insurance" toggle in
// step 1 of the wizard. Reads agreement.declinedInsuranceSignatureDataUrl
// for the customer's separate signature on the addendum.
function buildDeclinedInsuranceBlock(agreement, ctx) {
  if (!agreement.declinedInsurance) return '';
  const logo = ctx?.companyLogoBlock || '';
  const cfg = ctx?.cfg || {};
  const companyName = esc(cfg.companyName || '');
  const signedAt = agreement.declinedInsuranceSignedAt
    ? new Date(agreement.declinedInsuranceSignedAt).toLocaleString('en-US', { timeZone: 'America/Puerto_Rico' })
    : '—';
  // The declined-insurance ACK uses the same initial captured during
  // T&C signing (sectionKey = 'declined_insurance'). Fall back to the
  // dedicated declinedInsuranceSignatureDataUrl column if present.
  const initials = Array.isArray(agreement.sectionInitials) ? agreement.sectionInitials : [];
  const ackInitial = initials.find((i) => i.sectionKey === 'declined_insurance');
  const sigBlock = agreement.declinedInsuranceSignatureDataUrl
    ? `<img src="${agreement.declinedInsuranceSignatureDataUrl}" alt="Declined insurance signature" style="max-height:80px;max-width:360px;display:block;border-bottom:1px solid #111827" />`
    : ackInitial?.initialDataUrl
      ? `<img src="${ackInitial.initialDataUrl}" alt="Declined insurance initial" style="max-height:60px;max-width:120px;display:block;border-bottom:1px solid #111827" />`
      : '<div style="color:#9CA3AF;font-size:12px">(no signature on file)</div>';

  return `
    <div style="page-break-before:always;background:#FFFFFF;color:#111827;padding:40px;font-family:-apple-system,BlinkMacSystemFont,'Helvetica Neue',Arial,sans-serif;all:revert">
      <div style="display:flex;justify-content:space-between;align-items:center;margin:0 0 24px;padding:0 0 16px;border-bottom:1px solid #111827;background:#FFFFFF">
        <div>
          <div style="font-size:11px;color:#6B7280;letter-spacing:.08em;text-transform:uppercase">Addendum</div>
          <div style="font-size:18px;font-weight:600;margin-top:4px;color:#111827">Declined insurance</div>
          <div style="font-size:11px;color:#6B7280;margin-top:2px">Agreement ${esc(agreement.agreementNumber)} · ${companyName}</div>
        </div>
        ${logo}
      </div>
      <p style="font-size:13px;line-height:1.6;color:#1F2937;margin:0 0 14px">
        Renter acknowledges that counter insurance was offered and declined.
        Renter agrees that all damage, theft, third-party claims, and
        related costs arising from the rental period are renter's sole
        responsibility under the rental agreement. Renter has confirmed
        coverage through a personal auto policy or other source.
      </p>
      <p style="font-size:13px;line-height:1.6;color:#1F2937;margin:0 0 24px">
        Renter further understands that any damage or theft will be
        billed to the card on file in accordance with the deposit
        authorization section of the rental agreement.
      </p>
      <div style="margin-top:32px;padding-top:18px;border-top:1px solid #111827;background:#FFFFFF">
        <div style="font-size:11px;color:#6B7280;letter-spacing:.06em;text-transform:uppercase;margin:0 0 8px">Renter signature</div>
        ${sigBlock}
        <div style="font-size:12px;margin-top:6px;color:#111827">${esc(agreement.tcSignerName || `${agreement.customerFirstName || ''} ${agreement.customerLastName || ''}`.trim() || '—')}</div>
        <div style="font-size:10.5px;color:#6B7280;margin-top:2px">Signed ${esc(signedAt)}</div>
      </div>
    </div>`;
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
  return { requireDeposit: false, depositAmountDue: 0 };
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
  return { requireSecurityDeposit: false, securityDepositAmount: 0 };
}

function resolveInsuranceSource(reservation) {
  const charges = Array.isArray(reservation?.charges) ? reservation.charges : [];
  const insuranceCharge = charges.find((c) => c.source === 'INSURANCE' && c.selected);
  if (insuranceCharge) return 'PLAN';
  if (reservation?.customer?.insurancePolicyNumber) return 'DECLINED_OWN';
  const snapshot = reservation?.pricingSnapshot;
  if (snapshot?.selectedInsuranceCode) return 'PLAN';
  return null;
}

function resolveInsurancePlanField(reservation, field) {
  const charges = Array.isArray(reservation?.charges) ? reservation.charges : [];
  const insuranceCharge = charges.find((c) => c.source === 'INSURANCE' && c.selected);
  if (insuranceCharge) {
    if (field === 'code') return insuranceCharge.sourceRefId || insuranceCharge.code || null;
    if (field === 'name') return insuranceCharge.name || insuranceCharge.description || null;
    if (field === 'rate') return Number(insuranceCharge.rate || insuranceCharge.total || insuranceCharge.amount || 0) || null;
  }
  const snapshot = reservation?.pricingSnapshot;
  if (snapshot) {
    if (field === 'code') return snapshot.selectedInsuranceCode || null;
    if (field === 'name') return snapshot.selectedInsuranceName || null;
  }
  return null;
}

// Exported for the duplicate-charges regression test. Keep this helper as the
// single source of truth for projecting reservation.charges → row shape used
// by every startFromReservation write path. If a caller forgets to copy
// `source` and `sourceRefId` from these rows into its createMany payload,
// the duplicate-charges bug recurs (see duplicate-charges.test.mjs).
export function structuredReservationChargeRows(reservation) {
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

// 2026-06-06 deposit-balance fix: ALL deposit charges (Deposit Due + Security
// Deposit, both chargeType DEPOSIT) are excluded from agreement
// subtotal/total/balance. The prior helper only caught SECURITY_DEPOSIT, so
// "Deposit Due" leaked into total and inflated balance on 100+ agreements.
function isDepositCharge(row = {}) {
  const type = String(row?.chargeType || '').trim().toUpperCase();
  const source = String(row?.source || '').trim().toUpperCase();
  const name = String(row?.name || '').trim().toUpperCase();
  return type === 'DEPOSIT'
    || source === 'DEPOSIT_DUE'
    || source === 'SECURITY_DEPOSIT'
    || name === 'SECURITY DEPOSIT'
    || name === 'DEPOSIT (DUE NOW)';
}

// 2026-06-06 Option B: agreement paidAmount counts REAL captured money only
// (AUTH_HOLD deposit authorizations excluded), and balance = max(0, total -
// paid) never goes negative. Canonical recompute used after payment mutations
// and on re-sync, so paidAmount/balance self-heal regardless of the path.
async function recomputeAgreementPaidAndBalance(client, agreementId) {
  const agr = await client.rentalAgreement.findUnique({
    where: { id: agreementId },
    select: { total: true }
  });
  if (!agr) return null;
  const rows = await client.rentalAgreementPayment.findMany({
    where: { rentalAgreementId: agreementId, status: 'PAID', method: { not: 'AUTH_HOLD' } },
    select: { amount: true }
  });
  const paidAmount = Number(rows.reduce((s, p) => s + Number(p.amount || 0), 0).toFixed(2));
  const balance = Math.max(0, Number((Number(agr.total || 0) - paidAmount).toFixed(2)));
  await client.rentalAgreement.update({
    where: { id: agreementId },
    data: { paidAmount, balance }
  });
  return { paidAmount, balance };
}

function structuredReservationTotals(rows = []) {
  const normalized = Array.isArray(rows) ? rows : [];
  const subtotal = Number(normalized
    .filter((row) => String(row?.chargeType || '').toUpperCase() !== 'TAX' && !isDepositCharge(row))
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

// Pillar 2 wizards (2026-05-19): Prisma Decimal fields serialize as strings
// via JSON.stringify (e.g. balance: "0" instead of balance: 0). This trips up
// frontend code that compares to numeric zero or does math. Coerce all the
// money fields on an agreement (and its nested charges/payments) to numbers
// before returning from the service so consumers always see numbers.
function coerceAgreementMoney(agreement) {
  if (!agreement) return agreement;
  const moneyFields = ['subtotal', 'taxes', 'fees', 'total', 'deposit',
    'securityDepositAmount', 'paidAmount', 'balance', 'insurancePlanRate'];
  for (const f of moneyFields) {
    if (f in agreement && agreement[f] != null) {
      agreement[f] = Number(agreement[f]);
    }
  }
  if (Array.isArray(agreement.charges)) {
    for (const c of agreement.charges) {
      if (c?.quantity != null) c.quantity = Number(c.quantity);
      if (c?.rate != null) c.rate = Number(c.rate);
      if (c?.total != null) c.total = Number(c.total);
    }
  }
  if (Array.isArray(agreement.payments)) {
    for (const p of agreement.payments) {
      if (p?.amount != null) p.amount = Number(p.amount);
    }
  }
  return agreement;
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

  // ──────────────────────────────────────────────────────────────────────────
  // SERVICE_CATALOG is the canonical source of truth for commission. Try it
  // FIRST so the flat-rate catalog rates ($1 Tolls, $2 Liability, $3 Insurance,
  // etc.) always win for known services — matching what the Sales Performance
  // and Agent Track Record reports compute inline, and what Hector's
  // hand-built April 2026 PDF uses. The CommissionPlan/AdditionalService/
  // InsurancePlan overrides below only apply to charges that DON'T match a
  // catalog entry (custom services, weird one-offs, etc.).
  //
  // FIXED_PER_AGREEMENT (not _PER_UNIT) so we credit the flat rate once even
  // when an agreement has multiple charge lines that map to the same service
  // (e.g. two toll charges, multi-day insurance). The reports walk
  // SERVICE_CATALOG and count each attached service exactly once per rental.
  // ──────────────────────────────────────────────────────────────────────────
  const catalogEntry = resolveCatalogEntry(charge);
  if (catalogEntry) {
    return {
      id: `catalog:${catalogEntry.slug}`,
      name: catalogEntry.label,
      valueType: 'FIXED_PER_AGREEMENT',
      percentValue: null,
      fixedAmount: catalogEntry.commPerSale,
      isActive: true,
      source: 'CATALOG',
    };
  }

  // Non-catalog overrides — only consulted when the charge isn't a catalog
  // service. Kept for forward compatibility with future per-service /
  // per-insurance / per-plan commission configurations.
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

// 2026-07-25 (LAX #4) — virtual-agent commission lines. Pure so the money
// math is unit-testable. The rule Hector gave: a virtual agent earns the
// plan's percent of EVERYTHING they sell — additional services (all four
// source spellings) + insurance — excluding taxes, fees and deposits. The
// flat-rate SERVICE_CATALOG is deliberately NOT consulted: it would
// short-circuit the percent (its entries win by design for standard
// employees), and virtual-agent economics are percent-based.
export function percentSoldItemLines(charges = [], percent) {
  const pct = Number(percent);
  if (!Number.isFinite(pct) || !(pct > 0)) return [];
  return (Array.isArray(charges) ? charges : [])
    .filter(isSoldItemCharge)
    .map((charge) => ({
      rentalAgreementChargeId: charge.id || null,
      serviceId: String(charge?.source || '').toUpperCase() === 'ADDITIONAL_SERVICE' && charge?.sourceRefId
        ? String(charge.sourceRefId)
        : null,
      description: String(charge?.name || 'Line Item'),
      quantity: Number(charge?.quantity || 1),
      lineRevenue: roundMoney(charge?.total || 0),
      valueType: 'PERCENT',
      percentValue: percent,
      fixedAmount: null,
      commissionAmount: roundMoney(Number(charge?.total || 0) * (percent / 100))
    }));
}

// Virtual-agent lines: the plan's default percent over sold items.
export function virtualAgentCommissionLines(charges = [], plan = null) {
  if (String(plan?.defaultValueType || '').toUpperCase() !== 'PERCENT') return [];
  return percentSoldItemLines(charges, Number(plan?.defaultPercentValue));
}

// LAX #5 — does this agreement's reservation qualify for the plan's
// review-tier sources (e.g. EXPEDIA / PRICELINE)? Case-insensitive PREFIX
// match on the reservation's bookingChannel AND (for franchise-promoted
// rows) the linked ExternalReservation.channel — TL rows carry 'EXPEDIA02'
// there and nothing propagates it to Reservation today.
export function channelMatchesReviewSources(channelValues = [], sources = []) {
  const wanted = (Array.isArray(sources) ? sources : [])
    .map((s) => String(s || '').trim().toUpperCase())
    .filter(Boolean);
  if (!wanted.length) return false;
  return (Array.isArray(channelValues) ? channelValues : []).some((raw) => {
    const value = String(raw || '').trim().toUpperCase();
    return value && wanted.some((w) => value === w || value.startsWith(w));
  });
}

// Resolve the plan a VIRTUAL_AGENT earns under: their individually assigned
// plan IF it is an active virtual-agent plan, else the tenant's active plan
// tagged personKind VIRTUAL_AGENT. No plan → no commission (fail-closed:
// never fall back to a standard plan whose catalog/default semantics were
// designed for counter employees).
async function resolveVirtualAgentPlan(tenantId, user) {
  const assigned = user?.commissionPlan;
  if (assigned?.isActive && String(assigned?.personKind || '').toUpperCase() === 'VIRTUAL_AGENT') {
    return assigned;
  }
  return prisma.commissionPlan.findFirst({
    where: {
      tenantId: tenantId || null,
      isActive: true,
      personKind: 'VIRTUAL_AGENT'
    },
    orderBy: { createdAt: 'asc' }
  });
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

  // 2026-06-06 Option B: recompute from real (non-AUTH_HOLD) payments so an
  // imported deposit hold never inflates paidAmount / understates balance.
  const { paidAmount, balance } = await recomputeAgreementPaidAndBalance(prisma, rentalAgreementId);
  return { importedCount: pending.length, paidAmount, balance };
}

export async function syncAgreementCommissionSnapshot(rentalAgreementId) {
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
          actorUserId: true,
          capturedAt: true,
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
      },
      // LAX #5: the review-tier qualifier reads the booking channel.
      reservation: { select: { id: true, bookingChannel: true } }
    }
  });
  if (!agreement) throw new Error('Rental agreement not found');
  // 2026-05-26: commission is earned at CHECKOUT, not at CLOSE. Skip the
  // snapshot if no CHECKOUT inspection exists yet — there's no canonical
  // commission earner before the car has been released. Status-based guard
  // was removed so FINALIZED + CHECKED_OUT + CHECKED_IN + CLOSED all get a
  // snapshot written.
  const checkoutInspectionRow = (agreement?.inspections || []).find((row) => row?.actorUserId);
  if (!checkoutInspectionRow) return null;

  const commissionEmployeeUserId = String(
    checkoutInspectionRow?.actorUserId
    || agreement.salesOwnerUserId
    || ''
  ).trim();
  if (!commissionEmployeeUserId) return null;
  const checkoutCapturedAt = checkoutInspectionRow?.capturedAt || null;

  // 2026-05-26: dropped the user.tenantId === agreement.tenantId scope.
  // Multi-tenant operators (Super Admin / system owner) often have
  // tenantId=null on their User row but still do CHECKOUT inspections on
  // tenant-scoped agreements. The old strict scope made findFirst return
  // null → sync bailed → the snapshot was never written, so those rentals
  // disappeared from Commission Payouts even though Sales Performance
  // (which doesn't go through sync) attributed them correctly.
  const commissionEmployee = await prisma.user.findFirst({
    where: { id: commissionEmployeeUserId },
    select: {
      id: true,
      personKind: true,
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

  // 2026-07-25 (LAX #4): a VIRTUAL_AGENT sales owner earns their percent
  // ALONGSIDE the checkout employee — a second AgreementCommission row, not
  // a replacement. Loaded up front so the prune below can keep both.
  const salesOwnerId = String(agreement.salesOwnerUserId || '').trim();
  const virtualAgentUser = salesOwnerId && salesOwnerId !== commissionEmployeeUserId
    ? await prisma.user.findFirst({
        where: { id: salesOwnerId, personKind: 'VIRTUAL_AGENT', isActive: true },
        select: {
          id: true,
          personKind: true,
          commissionPlan: { select: { id: true, isActive: true, personKind: true, defaultValueType: true, defaultPercentValue: true } }
        }
      })
    : null;

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

  const counterIsVirtualAgent = String(commissionEmployee?.personKind || '').toUpperCase() === 'VIRTUAL_AGENT';
  const eligibleCharges = commissionChargeRows(agreement.charges);

  let plan = null;
  let lines = [];
  if (counterIsVirtualAgent) {
    // The checkout employee is themselves a VIRTUAL_AGENT (remote/own
    // checkout): their row uses the percent-of-sold-items math — the
    // flat-rate catalog was designed for counter staff and would
    // short-circuit the percent (LAX #4).
    plan = await resolveVirtualAgentPlan(agreement.tenantId, commissionEmployee);
    lines = virtualAgentCommissionLines(agreement.charges, plan);
  } else {
    const employeePlan = commissionEmployee?.commissionPlan?.isActive
      && String(commissionEmployee?.commissionPlan?.personKind || '').toUpperCase() !== 'VIRTUAL_AGENT'
      ? commissionEmployee.commissionPlan
      : null;
    const tenantPlan = employeePlan
      ? null
      : await prisma.commissionPlan.findFirst({
          where: {
            tenantId: agreement.tenantId || null,
            isActive: true,
            // Never resolve a virtual-agent plan for a standard employee.
            OR: [{ personKind: null }, { personKind: { not: 'VIRTUAL_AGENT' } }]
          },
          include: {
            rules: {
              where: { isActive: true },
              orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }]
            }
          },
          orderBy: { createdAt: 'asc' }
        });
    plan = employeePlan || tenantPlan;

    const reviewTiers = normalizeReviewTiers(plan?.reviewTiersJson);
    if (plan && reviewTiers) {
      // LAX #5 — review-tier commissions REPLACE the flat-rate catalog for
      // counter staff on tenants that configure tiers: tierPct(validated
      // reviews this month) × sold items, and ONLY on qualifying booking
      // sources (Expedia/Priceline per the plan). Non-qualifying contracts
      // earn nothing under tiers — "ONLY EXPEDIA/PRICELINE" is Hector's
      // table verbatim. Tenants without tiers keep the catalog untouched.
      const sources = Array.isArray(plan?.reviewTierSourcesJson) ? plan.reviewTierSourcesJson : [];
      const channels = [agreement.reservation?.bookingChannel];
      if (String(agreement.reservation?.bookingChannel || '').toUpperCase().startsWith('FRANCHISE')) {
        const ext = await prisma.externalReservation.findFirst({
          where: { promotedToReservationId: agreement.reservation.id },
          select: { channel: true }
        }).catch(() => null);
        if (ext?.channel) channels.push(ext.channel);
      }
      if (channelMatchesReviewSources(channels, sources)) {
        const month = monthKey(checkoutCapturedAt || agreement.closedAt || new Date());
        const validatedReviews = await prisma.reviewProof.count({
          where: {
            tenantId: agreement.tenantId || null,
            employeeUserId: commissionEmployeeUserId,
            monthKey: month,
            status: 'VALIDATED'
          }
        });
        lines = percentSoldItemLines(agreement.charges, tierPercentFor(validatedReviews, reviewTiers));
      } else {
        lines = [];
      }
    } else {
      const appliedFixedAgreementRules = new Set();
      lines = eligibleCharges
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
    }
  }

  // Virtual-agent SECOND row (sales owner ≠ checkout employee): computed
  // BEFORE the prune so the keep-list is exact — a VA with no active plan
  // writes no row, and any stale row of theirs is pruned like anyone else's.
  const vaPlan = virtualAgentUser ? await resolveVirtualAgentPlan(agreement.tenantId, virtualAgentUser) : null;
  const vaLines = virtualAgentUser ? virtualAgentCommissionLines(agreement.charges, vaPlan) : [];
  const writeVaRow = !!(virtualAgentUser && vaPlan && vaLines.length);

  const grossRevenue = roundMoney(agreement.total || 0);
  // serviceRevenue is a reporting metric (never a commission base). It used
  // to count only source ADDITIONAL_SERVICE, silently under-counting
  // services sold via the booking engine, pre-check-in and kiosk — now it
  // uses the shared service-source list (2026-07-25; insurance stays out —
  // this is the SERVICES metric).
  const serviceRevenue = roundMoney(
    eligibleCharges
      .filter((charge) => SERVICE_CHARGE_SOURCES.includes(String(charge?.source || '').toUpperCase()))
      .reduce((sum, charge) => sum + Number(charge?.total || 0), 0)
  );
  const eligibleRevenue = roundMoney(lines.reduce((sum, line) => sum + Number(line.lineRevenue || 0), 0));
  const commissionAmount = roundMoney(lines.reduce((sum, line) => sum + Number(line.commissionAmount || 0), 0));

  // Keep the checkout employee's row AND (when earned) the virtual-agent
  // sales owner's row. The old prune deleted everything but one owner — that
  // exclusivity is exactly what LAX #4 removes. STATUS GUARD (QA M1): money
  // already APPROVED/PAID is NEVER deleted by a re-sync — deactivating a VA
  // plan or overriding the owner must not erase paid payout records (the
  // nightly resync sweep would otherwise do it fleet-wide overnight).
  const keepEmployeeIds = writeVaRow
    ? [commissionEmployeeUserId, virtualAgentUser.id]
    : [commissionEmployeeUserId];
  await prisma.agreementCommission.deleteMany({
    where: {
      rentalAgreementId: agreement.id,
      employeeUserId: { notIn: keepEmployeeIds },
      status: { in: ['PENDING', 'VOID'] }
    }
  });

  // QA M1 (LAX #5): a PAID row's dollars are FROZEN — what was paid is a
  // historical fact. Pre-tiers this was a latent hazard (config edits
  // re-priced paid history); with tiers it becomes routine (the percent
  // moves as the month's validated-review count grows, and the nightly
  // resync sweep touches every agreement). PENDING/APPROVED rows keep
  // refreshing — the retroactive whole-month tier bump is the intended
  // semantics of Hector's table.
  const paidStatuses = await prisma.agreementCommission.findMany({
    where: { rentalAgreementId: agreement.id, employeeUserId: { in: keepEmployeeIds }, status: 'PAID' },
    select: { employeeUserId: true }
  });
  const paidEmployeeIds = new Set(paidStatuses.map((r) => r.employeeUserId));

  let snapshot;
  if (paidEmployeeIds.has(commissionEmployeeUserId)) {
    // Frozen: the paid counter row (and its lines) stay untouched. The VA
    // block below still runs — each row freezes independently.
    snapshot = await prisma.agreementCommission.findUnique({
      where: {
        rentalAgreementId_employeeUserId: {
          rentalAgreementId: agreement.id,
          employeeUserId: commissionEmployeeUserId
        }
      }
    });
  } else {
  snapshot = await prisma.agreementCommission.upsert({
    where: {
      rentalAgreementId_employeeUserId: {
        rentalAgreementId: agreement.id,
        employeeUserId: commissionEmployeeUserId
      }
    },
    update: {
      // Preserve workflow status (PAID/APPROVED) on re-sync. The status is
      // only updated by the explicit approve/mark-paid endpoints — sync
      // just refreshes the calculated dollar amounts.
      tenantId: agreement.tenantId || null,
      commissionPlanId: plan?.id || null,
      monthKey: monthKey(checkoutCapturedAt || agreement.closedAt || new Date()),
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
      monthKey: monthKey(checkoutCapturedAt || agreement.closedAt || new Date()),
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
  }

  // 2026-07-25 (LAX #4) — the virtual-agent sales owner's SECOND row.
  // Status semantics identical to the main row: sync refreshes amounts,
  // approve/mark-paid own the workflow status. PAID rows are frozen (QA M1).
  if (writeVaRow && !paidEmployeeIds.has(virtualAgentUser.id)) {
    const vaEligibleRevenue = roundMoney(vaLines.reduce((sum, line) => sum + Number(line.lineRevenue || 0), 0));
    const vaCommissionAmount = roundMoney(vaLines.reduce((sum, line) => sum + Number(line.commissionAmount || 0), 0));
    const vaSnapshot = await prisma.agreementCommission.upsert({
      where: {
        rentalAgreementId_employeeUserId: {
          rentalAgreementId: agreement.id,
          employeeUserId: virtualAgentUser.id
        }
      },
      update: {
        tenantId: agreement.tenantId || null,
        commissionPlanId: vaPlan.id,
        monthKey: monthKey(checkoutCapturedAt || agreement.closedAt || new Date()),
        grossRevenue,
        serviceRevenue,
        eligibleRevenue: vaEligibleRevenue,
        commissionAmount: vaCommissionAmount,
        calculatedAt: new Date()
      },
      create: {
        tenantId: agreement.tenantId || null,
        rentalAgreementId: agreement.id,
        employeeUserId: virtualAgentUser.id,
        commissionPlanId: vaPlan.id,
        status: 'PENDING',
        monthKey: monthKey(checkoutCapturedAt || agreement.closedAt || new Date()),
        grossRevenue,
        serviceRevenue,
        eligibleRevenue: vaEligibleRevenue,
        commissionAmount: vaCommissionAmount,
        calculatedAt: new Date()
      }
    });
    await prisma.agreementCommissionLine.deleteMany({ where: { agreementCommissionId: vaSnapshot.id } });
    await prisma.agreementCommissionLine.createMany({
      data: vaLines.map((line) => ({
        agreementCommissionId: vaSnapshot.id,
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
    photos = row.photosJson ? normalizeInspectionPhotos(JSON.parse(row.photosJson)) : {};
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
    photos,
    photoStorageRefs: Array.isArray(row.photoStorageRefs) ? row.photoStorageRefs : null
  };
}

// 16l: Async variant that resolves photo storage refs into signed URLs for
// client consumption. Always backward-compatible — when a row has only the
// legacy `photosJson` blob, we return it untouched in the `photos` field.
async function normalizeInspectionRowAsync(row) {
  const base = normalizeInspectionRow(row);
  if (!base) return null;
  if (base.photoStorageRefs && base.photoStorageRefs.length > 0) {
    try {
      const resolved = await materializeInspectionStorageRefs(base.photoStorageRefs);
      // Overlay any resolved URLs on top of the legacy photos map. Legacy
      // entries (still in photosJson) survive — useful during the migration
      // window when a single row could have both. Canonicalize the resolved
      // keys through the same aliases so storage-backed mobile photos align.
      const resolvedAligned = {};
      for (const [k, v] of Object.entries(resolved || {})) {
        resolvedAligned[canonicalPhotoKey(k)] = v;
      }
      base.photos = { ...(base.photos || {}), ...resolvedAligned };
    } catch {
      // Best effort — leave legacy photos in place if signing fails.
    }
  }
  // Don't leak internal storage paths to clients.
  delete base.photoStorageRefs;
  return base;
}

function normalizeSwapInspectionPayload(raw, at = null) {
  if (!raw) return null;
  let parsed = raw;
  try {
    if (typeof raw === 'string') parsed = JSON.parse(raw);
  } catch {
    parsed = {};
  }
  if (!parsed || typeof parsed !== 'object') return null;
  return {
    at: at || null,
    exterior: parsed.exterior || null,
    interior: parsed.interior || null,
    tires: parsed.tires || null,
    lights: parsed.lights || null,
    windshield: parsed.windshield || null,
    fuelLevel: parsed.fuelLevel ?? null,
    odometer: parsed.odometer ?? null,
    cleanliness: parsed.cleanliness ?? null,
    damages: parsed.damages || null,
    notes: parsed.notes || null,
    photos: parsed.photos && typeof parsed.photos === 'object' ? parsed.photos : {},
    // Mandatory swap photos (2026-07-16): swaps persist REFS, not base64.
    // Legacy swap rows (pre-2026-07-16) only have `photos` and pass through.
    photoStorageRefs: Array.isArray(parsed.photoStorageRefs) ? parsed.photoStorageRefs : null
  };
}

function normalizeVehicleSwapRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    previousVehicleId: row.previousVehicleId || null,
    previousVehicleLabel: row.previousVehicleLabel || null,
    nextVehicleId: row.nextVehicleId || null,
    nextVehicleLabel: row.nextVehicleLabel || null,
    note: row.note || null,
    previousInspection: normalizeSwapInspectionPayload(row.previousInspectionJson, row.previousCheckedInAt),
    nextInspection: normalizeSwapInspectionPayload(row.nextInspectionJson, row.nextCheckedOutAt),
    createdAt: row.createdAt || null
  };
}

/**
 * Resolve a swap inspection's storage refs into signed URLs, mirroring
 * normalizeInspectionRowAsync. Swap photos became mandatory + storage-backed on
 * 2026-07-16; without this the 16 photos would be stored but never viewable in
 * the inspection report.
 */
async function resolveSwapInspectionPhotos(inspection) {
  if (!inspection) return null;
  const refs = inspection.photoStorageRefs;
  if (Array.isArray(refs) && refs.length > 0) {
    try {
      const resolved = await materializeInspectionStorageRefs(refs);
      const aligned = {};
      for (const [k, v] of Object.entries(resolved || {})) aligned[canonicalPhotoKey(k)] = v;
      inspection.photos = { ...(inspection.photos || {}), ...aligned };
    } catch {
      // Best effort — a signing failure must not break the report.
    }
  }
  // Don't leak internal storage paths to clients.
  delete inspection.photoStorageRefs;
  return inspection;
}

async function normalizeVehicleSwapRowAsync(row) {
  const base = normalizeVehicleSwapRow(row);
  if (!base) return null;
  await Promise.all([
    resolveSwapInspectionPhotos(base.previousInspection),
    resolveSwapInspectionPhotos(base.nextInspection)
  ]);
  return base;
}

async function inspectionReportFromAgreement(agreement) {
  const structured = Array.isArray(agreement?.inspections) ? agreement.inspections : [];
  const swaps = Array.isArray(agreement?.vehicleSwaps) ? agreement.vehicleSwaps : [];
  const checkout = structured.find((row) => String(row.phase || '').toUpperCase() === 'CHECKOUT') || null;
  const checkin = structured.find((row) => String(row.phase || '').toUpperCase() === 'CHECKIN') || null;
  const [checkoutNorm, checkinNorm] = await Promise.all([
    normalizeInspectionRowAsync(checkout),
    normalizeInspectionRowAsync(checkin)
  ]);
  return {
    checkout: checkoutNorm,
    checkin: checkinNorm,
    intelligence: buildInspectionIntelligence({
      checkout: checkoutNorm,
      checkin: checkinNorm
    }),
    swaps: (await Promise.all(swaps.map(normalizeVehicleSwapRowAsync))).filter(Boolean)
  };
}

// Test-surface helper: the body of the finalize() $transaction callback,
// extracted so we can verify with a fake `tx` that all writes go through the
// transaction client (never through the global prisma) and that the steps
// fire in the right order with the right conditional branches. Production
// code calls this from inside prisma.$transaction(...).
//
// This function MUST only touch `tx.*`, never `prisma.*`. If you find
// yourself wanting to read something here, do it BEFORE calling this helper
// and pass the value through `ctx`.
export async function applyFinalizeWritesTx(tx, ctx) {
  if (ctx.creditApplied > 0 && ctx.customerIdForCredit) {
    await tx.customer.update({
      where: { id: ctx.customerIdForCredit },
      data: {
        creditBalance: ctx.nextCustomerCredit,
        notes: ctx.creditNoteForCustomer
      }
    });
  }

  const updated = await tx.rentalAgreement.update({
    where: { id: ctx.id },
    data: {
      status: 'FINALIZED',
      paymentMethod: ctx.paymentMethod || null,
      paymentReference: ctx.payload?.paymentReference ?? ctx.priorPaymentReference,
      customerFirstName: ctx.customerFirstName,
      customerLastName: ctx.customerLastName,
      licenseNumber: ctx.licenseNumber,
      dateOfBirth: ctx.dateOfBirth,
      odometerOut: ctx.odometerOut,
      fuelOut: ctx.fuelOut,
      paidAmount: ctx.paidAmount,
      balance: ctx.balance,
      finalizedAt: new Date()
    }
  });

  await tx.reservation.update({
    where: { id: updated.reservationId },
    data: { status: 'CHECKED_OUT' }
  });

  // Shuttle arc (2026-08-05): the customer is holding the keys, so any open
  // shuttle request closes itself — same tx, nobody has to remember anything.
  await autoCompleteShuttleRequestsOnCheckout(tx, updated.reservationId);

  // Bug #44 — keep Vehicle.status in step: checkout flips the car to ON_RENT
  // (respects IN_MAINTENANCE/OUT_OF_SERVICE/SOLD). In the same tx for atomicity.
  await syncVehicleStatusForReservation(tx, {
    reservationId: updated.reservationId,
    vehicleId: updated.vehicleId,
    toStatus: 'CHECKED_OUT'
  });

  // Mileage history (2026-06-09). Until now check-out wrote odometerOut on the
  // agreement but NEVER touched Vehicle.mileage — only check-in did — so a car's
  // profile showed a stale number with no hint of where it came from. Append a
  // CHECKOUT entry and mirror it onto the vehicle ("last entry wins"), in this
  // same tx so the timeline and the agreement commit atomically.
  if (updated.vehicleId && ctx.odometerOut != null) {
    await recordMileageEntry(tx, {
      vehicleId: updated.vehicleId,
      tenantId: ctx.tenantId,
      mileage: ctx.odometerOut,
      source: 'CHECKOUT',
      reservationId: updated.reservationId,
      rentalAgreementId: ctx.id,
      reservationNumber: ctx.reservationNumber,
      actorUserId: ctx.actorUserId
    });
  }

  // Fuel history (2026-06-29): mirror the CHECKOUT odometer entry above for the
  // fuel level captured at checkout, so the vehicle profile shows the fuel
  // out->in timeline paired by reservation. Fail-open (recordFuelReadingSafe
  // swallows its own errors) so a fuel-logging hiccup never breaks checkout.
  if (updated.vehicleId && ctx.fuelOut != null) {
    await recordFuelReadingSafe(tx, {
      vehicleId: updated.vehicleId,
      tenantId: ctx.tenantId,
      fuelFraction: ctx.fuelOut,
      source: 'CHECKOUT',
      reservationId: updated.reservationId,
      rentalAgreementId: ctx.id,
      reservationNumber: ctx.reservationNumber,
      actorUserId: ctx.actorUserId
    });
  }

  if (ctx.hasExplicitPaidAmount && ctx.paidAmount > 0 && ctx.paymentMethod) {
    await tx.rentalAgreementPayment.create({
      data: {
        rentalAgreementId: ctx.id,
        method: ctx.paymentMethod,
        amount: ctx.paidAmount,
        reference: ctx.payload?.paymentReference ?? null,
        status: 'PAID'
      }
    });
  }

  if (ctx.creditApplied > 0) {
    await tx.rentalAgreementPayment.create({
      data: {
        rentalAgreementId: ctx.id,
        method: 'OTHER',
        amount: ctx.creditApplied,
        reference: 'CUSTOMER_CREDIT_AUTO_APPLIED',
        status: 'PAID',
        notes: 'Automatically applied from customer credit balance'
      }
    });
  }

  return updated;
}

// Test-surface helper: the body of the startFromReservation() chargesync
// $transaction callback (the structuredRows path; the other 2 paths follow
// the same shape). Same contract as applyFinalizeWritesTx — touch only `tx`.
export async function applyChargesSyncTx(tx, { agreementId, normalizedRows, agreementUpdate }) {
  await tx.rentalAgreementCharge.deleteMany({ where: { rentalAgreementId: agreementId } });
  if (normalizedRows.length > 0) {
    await tx.rentalAgreementCharge.createMany({ data: normalizedRows });
  }
  return tx.rentalAgreement.update({ where: { id: agreementId }, data: agreementUpdate });
}

// Program scoping (2026-07-02): agreements partition through their (required)
// reservation's workflowMode — rental contracts hang off RENTAL/CAR_SHARING
// reservations, loaner companion agreements off DEALERSHIP_LOANER ones. The
// routes here pass req.user (session user) as `scope`, so resolve the ADMIN/
// SUPER_ADMIN bypass via userProgramScope (it accepts both a session user and
// an already-resolved scope). RENTAL_ONLY employees lose loaner companion
// agreements; LOANER_ONLY employees keep ONLY those (their loaner check-out
// wizard runs through these same routes), so rental contracts 404 for them.
function agreementProgramWhere(scope) {
  const fragment = reservationProgramWhereForScope({ programScope: userProgramScope(scope) });
  return Object.keys(fragment).length ? { reservation: fragment } : {};
}

// Vehicle-inspection QR block for the printed rental agreement (2026-08-22
// security redesign). When the tenant has customer-led inspection enabled AND
// the agreement has a reservation, render a reservation-bound, expiring QR the
// renter can scan to self-inspect / report damage. The QR encodes a signed,
// time-boxed resolver URL (/inspect/r/<reservationId>.<expMs>.<sig>) and is
// embedded as an inline data-URL so Puppeteer renders it with NO network fetch.
// Returns '' when inspection is disabled (or on any failure) so other tenants'
// contracts are byte-unchanged and a QR hiccup never breaks a print.
export async function buildInspectionQrBlockHtml({ reservationId, tenantId, returnAt } = {}) {
  try {
    if (!reservationId) return '';
    const inspCfg = await settingsService.getCustomerInspectionConfig({ tenantId: tenantId || undefined });
    if (!inspCfg?.enabled) return '';
    const { customerInspectionService } = await import('../customer-inspection/customer-inspection.service.js');
    const graceH = Number(process.env.CUSTOMER_INSPECTION_RESOLVER_GRACE_HOURS);
    const graceMs = (Number.isFinite(graceH) && graceH > 0 ? graceH : 48) * 60 * 60 * 1000;
    const base = returnAt ? new Date(returnAt).getTime() : Date.now();
    const expiresAt = new Date((Number.isFinite(base) ? base : Date.now()) + graceMs);
    const resolverUrl = customerInspectionService.inspectionResolverUrlForReservation(reservationId, { expiresAt });
    const QRCode = (await import('qrcode')).default;
    const qrDataUrl = await QRCode.toDataURL(resolverUrl, { margin: 1, width: 220 });
    return `
        <section class="inspection-qr-block" style="page-break-inside:avoid;margin-top:24px;padding:16px;border:1px solid #d8d5ea;border-radius:10px;text-align:center;font-family:Arial,Helvetica,sans-serif">
          <h3 style="margin:0 0 6px;color:#5b3df5;font-size:15px">Vehicle inspection — scan to inspect / report damage</h3>
          <p style="margin:0 0 12px;font-size:12px;color:#555">Scan this code with your phone to walk around the vehicle and report any damage. Reporting existing damage protects you.</p>
          <img src="${qrDataUrl}" alt="Vehicle inspection QR code" style="width:200px;height:200px;display:block;margin:0 auto" />
          <p style="margin:10px 0 0;font-size:10px;color:#888;word-break:break-all">${esc(resolverUrl)}</p>
        </section>`;
  } catch (e) {
    return '';
  }
}

export const rentalAgreementsService = {
  getAccessibleAgreement(id, scope = null) {
    return prisma.rentalAgreement.findFirst({
      where: { id, ...(scope?.tenantId ? { tenantId: scope.tenantId } : {}), ...agreementProgramWhere(scope) },
      select: {
        id: true,
        tenantId: true,
        reservationId: true,
        status: true
      }
    });
  },

  async resolveLatestAgreementId(id, scope = null) {
    const current = await prisma.rentalAgreement.findFirst({ where: { id, ...(scope?.tenantId ? { tenantId: scope.tenantId } : {}) }, select: { id: true, reservationId: true } });
    if (!current) throw new Error('Rental agreement not found');
    const latest = await prisma.rentalAgreement.findFirst({ where: { reservationId: current.reservationId, ...(scope?.tenantId ? { tenantId: scope.tenantId } : {}) }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], select: { id: true } });
    return latest?.id || current.id;
  },

  list(scope = null) {
    return prisma.rentalAgreement.findMany({
    where: { ...(scope?.tenantId ? { tenantId: scope.tenantId } : {}), ...agreementProgramWhere(scope) },
      orderBy: { createdAt: 'desc' },
      include: {
        reservation: { include: { customer: true, vehicle: true, vehicleType: true } },
        drivers: true,
        charges: true,
        payments: true
      }
    });
  },

  // Loaner companion agreement (2026-06-26): a DEALERSHIP_LOANER reservation runs through the SAME
  // checkout-session + QR inspection flow as a rental. It needs a RentalAgreement for the session,
  // but with NO rental rates / mandatory fees / deposit (loaner billing lives on the reservation).
  // This creates a minimal $0 agreement (customer + vehicle + locations + dates) so the unified
  // wizard, QR inspection, and finalize cascade all work unchanged.
  async startLoanerAgreementForCheckout(reservationId, scope = null) {
    const reservation = await prisma.reservation.findFirst({
      where: { id: reservationId, ...(scope?.tenantId ? { tenantId: scope.tenantId } : {}) },
      include: { customer: true }
    });
    if (!reservation) { const e = new Error('Reservation not found'); e.status = 404; throw e; }
    if (reservation.status === 'CANCELLED' || reservation.status === 'NO_SHOW') {
      throw new Error('Cannot start checkout for cancelled/no-show reservation');
    }
    const existing = await prisma.rentalAgreement.findUnique({ where: { reservationId } });
    if (existing) return this.getById(existing.id);

    // LAX #4 (QA B1): seed the sales owner from the ORIGINATOR when the
    // reservation was created by a virtual agent. Non-VA originators seed
    // nothing — the checkout inspector claims ownership exactly as before,
    // so legacy attribution is byte-identical.
    const vaOriginatorId = reservation.createdByUserId
      ? (await prisma.user.findFirst({
          where: { id: reservation.createdByUserId, personKind: 'VIRTUAL_AGENT' },
          select: { id: true }
        }))?.id || null
      : null;

    let agreement;
    try {
      agreement = await prisma.rentalAgreement.create({
        data: {
          tenantId: reservation.tenantId || null,
          agreementNumber: agreementNumber(),
          reservationId,
          salesOwnerUserId: vaOriginatorId,
          vehicleId: reservation.vehicleId ?? null,
          pickupAt: reservation.pickupAt,
          returnAt: reservation.returnAt,
          pickupLocationId: reservation.pickupLocationId,
          returnLocationId: reservation.returnLocationId,
          customerFirstName: reservation.customer?.firstName ?? 'Customer',
          customerLastName: reservation.customer?.lastName ?? '-',
          customerEmail: reservation.customer?.email ?? null,
          customerPhone: reservation.customer?.phone ?? null,
          dateOfBirth: reservation.customer?.dateOfBirth ?? null,
          licenseNumber: reservation.customer?.licenseNumber ?? null,
          licenseState: reservation.customer?.licenseState ?? null,
          notes: reservation.notes
          // No charges, fees, deposit, or rate: loaner billing is tracked on the reservation
          // (loanerBillingMode + estimatedTotal). subtotal/taxes/total/balance default to 0.
        }
      });
    } catch (e) {
      if (String(e?.code || '') === 'P2002') {
        const after = await prisma.rentalAgreement.findUnique({ where: { reservationId } });
        if (after) return this.getById(after.id);
      }
      throw e;
    }
    await prisma.agreementDriver.create({
      data: {
        rentalAgreementId: agreement.id,
        firstName: reservation.customer?.firstName ?? 'Customer',
        lastName: reservation.customer?.lastName ?? '-',
        email: reservation.customer?.email ?? null,
        phone: reservation.customer?.phone ?? null,
        licenseNumber: reservation.customer?.licenseNumber ?? null,
        licenseState: reservation.customer?.licenseState ?? null,
        dateOfBirth: reservation.customer?.dateOfBirth ?? null,
        isPrimary: true
      }
    }).catch(() => {});
    return this.getById(agreement.id);
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

    if (!reservation) { const e = new Error('Reservation not found'); e.status = 404; throw e; }
    if (reservation.status === 'CANCELLED' || reservation.status === 'NO_SHOW') {
      throw new Error('Cannot start rental for cancelled/no-show reservation');
    }

    const existing = await prisma.rentalAgreement.findUnique({ where: { reservationId } });
    if (existing) {
      // Pillar 2 (2026-05-18): once the reservation has been checked-in (paid
      // or unpaid), the fee engine has posted final charges onto the agreement
      // (fuel/cleaning/smoking/late). Re-syncing from reservation pricing now
      // would wipe those — Print Agreement and Email Agreement both hit
      // /start-rental, which would erase fees seconds after they were posted.
      // Skip re-sync entirely for post-checkin states and just return the
      // existing agreement as-is.
      const reservationStatusUpper = String(reservation.status || '').toUpperCase();
      if (reservationStatusUpper === 'CHECKED_IN' || reservationStatusUpper === 'CHECKED_IN_UNPAID') {
        return this.getById(existing.id);
      }
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
          // BUG-FIX 2026-05-19 (RES-083011): preserve `source` and
          // `sourceRefId` on the agreement charges. Without these, this
          // writer produced source=null rows while the parallel writer
          // (reservation-pricing.service.js#syncAgreementCharges) produced
          // rows with typed source (DAILY, SERVICE, INSURANCE, TAX,
          // SECURITY_DEPOSIT). The two outputs were treated as different
          // row sets by downstream code paths, leading to duplicate
          // RentalAgreementCharge entries (one source=null + one typed)
          // that doubled agreement.total. Aligning the shape lets either
          // writer cleanly replace the other via its deleteMany+createMany.
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
            sortOrder: row.sortOrder,
            source: row.source || null,
            sourceRefId: row.sourceRefId || null
          }));
          const { subtotal, taxes, total } = structuredReservationTotals(normalizedRows);

          // Atomic re-sync: charges wipe + insert + agreement totals must
          // commit together. Without the transaction, a failure between
          // deleteMany and createMany would leave the agreement with no
          // line items, a state the UI doesn't handle gracefully.
          //
          // MONEY-FIX 2026-07-09 (Print Agreement wiped misc/damage charges):
          // the delete MUST preserve the agreement-only rows. FEE_ENGINE_* fees,
          // ADMIN_CORRECTION manual charges, and DAMAGE_CHARGE damage charges live
          // ONLY on the agreement (no ReservationCharge to re-sync from), so an
          // UNCONDITIONAL deleteMany erased them here — Print Agreement on a
          // CHECKED_OUT rental (handlePrintAgreement → /start-rental) deleted the
          // just-added misc/damage charge and reverted total/balance, and the void
          // then couldn't find the chargeId. Mirror the EXACT carve-out predicate
          // reservation-pricing.service.js#syncAgreementCharges uses so the two
          // writers stay consistent.
          await prisma.$transaction([
            prisma.rentalAgreementCharge.deleteMany({
              where: {
                rentalAgreementId: existing.id,
                // 2026-07-13 (RES-213665): NULL-SAFE — negated string filters
                // never match source:null in Prisma/Postgres, so legacy
                // null-source mirror rows survived this delete and duplicated
                // the agreement on every re-sync. Same fix in ALL writers
                // (syncAgreementCharges + both start-rental branches) — the
                // predicates MUST stay identical.
                OR: [
                  { source: null },
                  {
                    AND: [
                      { NOT: { source: { startsWith: 'FEE_ENGINE_' } } },
                      { NOT: { source: 'ADMIN_CORRECTION' } },
                      { NOT: { source: 'DAMAGE_CHARGE' } }
                    ]
                  }
                ]
              }
            }),
            prisma.rentalAgreementCharge.createMany({ data: normalizedRows }),
            prisma.rentalAgreement.update({
              where: { id: existing.id },
              data: {
                notes: reservation.notes,
                subtotal,
                taxes,
                total,
                balance: Number((total - paid).toFixed(2))
              }
            })
          ], { timeout: 10000 });
          // The inline totals above sum ONLY the recreated reservation rows, so
          // they exclude the preserved carve-out rows. Delegate the authoritative
          // subtotal/taxes/fees/total/balance recompute to the proven reconciler:
          // it re-mirrors the reservation rows (net exactly one row per charge — its
          // own carve-out deleteMany drops the rows we just recreated and rebuilds
          // them from the reservation, so no duplication) AND folds the preserved
          // agreement-only rows back into the totals. Consistent with every other
          // money mutation, which recomputes through this same function.
          await reservationPricingService.syncAgreementCharges(reservationId, scope || {}, { allowClosed: true });
          return this.getById(existing.id);
        }

        const tenantWhere = reservation.tenantId ? { tenantId: reservation.tenantId } : {};
        const selectedServiceIds = [];
        const selectedFeeIds = [];
        const discounts = [];

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

        const incomingRows = structuredReservationChargeRows(reservation);
        if (incomingRows && incomingRows.length) {
          const normalizedRows = incomingRows.map((r) => ({
            name: String(r?.name || 'Line Item'),
            source: r?.source || null,
            sourceRefId: r?.sourceRefId || null,
            chargeType: String(r?.chargeType || 'UNIT').toUpperCase(),
            quantity: Number(r?.quantity || 1),
            rate: Number(r?.rate || 0),
            total: Number(r?.total != null ? r.total : (Number(r?.quantity || 1) * Number(r?.rate || 0))),
            taxable: !!r?.taxable,
          }));
          const { subtotal, taxes, total } = structuredReservationTotals(normalizedRows);

          // Atomic re-sync (incomingRows path).
          // MONEY-FIX 2026-07-09: same carve-out as the structuredRows path above —
          // never delete the agreement-only FEE_ENGINE_/ADMIN_CORRECTION/DAMAGE_CHARGE
          // rows, then delegate the total/balance recompute to syncAgreementCharges so
          // the preserved rows are folded back in exactly once.
          await prisma.$transaction([
            prisma.rentalAgreementCharge.deleteMany({
              where: {
                rentalAgreementId: existing.id,
                // 2026-07-13 (RES-213665): NULL-SAFE — negated string filters
                // never match source:null in Prisma/Postgres, so legacy
                // null-source mirror rows survived this delete and duplicated
                // the agreement on every re-sync. Same fix in ALL writers
                // (syncAgreementCharges + both start-rental branches) — the
                // predicates MUST stay identical.
                OR: [
                  { source: null },
                  {
                    AND: [
                      { NOT: { source: { startsWith: 'FEE_ENGINE_' } } },
                      { NOT: { source: 'ADMIN_CORRECTION' } },
                      { NOT: { source: 'DAMAGE_CHARGE' } }
                    ]
                  }
                ]
              }
            }),
            prisma.rentalAgreementCharge.createMany({
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
                source: r.source || null,
                sourceRefId: r.sourceRefId || null
              }))
            }),
            prisma.rentalAgreement.update({
              where: { id: existing.id },
              data: { notes: reservation.notes, subtotal, taxes, total, balance: Number((total - paid).toFixed(2)) }
            })
          ], { timeout: 10000 });
          await reservationPricingService.syncAgreementCharges(reservationId, scope || {}, { allowClosed: true });
          return this.getById(existing.id);
        }

        const chargeRows = [];
        // Long-Term P1 (2026-06-03): when the reservation has an EXPLICIT
        // monthly plan, the base charge is one locked cycle, not days x rate.
        // Daily reservations NEVER auto-convert (plan only exists via opt-in).
        const ltPlan = await prisma.longTermPlan.findUnique({
          where: { reservationId: reservation.id },
          select: { cycleRate: true },
        }).catch(() => null);
        const base = ltPlan ? Number(ltPlan.cycleRate) : dailyRate * days;
        if (ltPlan) {
          // chargeType MUST be a valid ChargeType enum — there is NO 'MONTHLY' (would throw at
          // finalize). Monthly meaning is carried by source MONTHLY_CYCLE + the name.
          chargeRows.push({ rentalAgreementId: existing.id, name: 'Monthly Cycle 1', chargeType: 'UNIT', quantity: 1, rate: base, total: base, taxable: true, selected: true, sortOrder: 0, source: 'MONTHLY_CYCLE' });
        } else {
          chargeRows.push({ rentalAgreementId: existing.id, name: 'Daily', chargeType: 'DAILY', quantity: days, rate: dailyRate, total: base, taxable: true, selected: true, sortOrder: 0 });
        }

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
          // 2026-06-06 deposit-balance fix: push the row for the record but do
          // NOT add it to feesTotal — deposits are excluded from total/balance.
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

        // Pillar 2 wizards rounding-consistency fix (2026-05-19): round every
        // intermediate at the boundary so the agreement's stored total matches
        // the reservation page's displayed total byte-for-byte. Without these,
        // the wizard's balance check sees phantom $0.01–$0.10 drifts after
        // startFromReservation reruns mid-flow (e.g. before finalize).
        const subtotal = roundMoney(Math.max(0, base + servicesTotal + feesTotal - discountTotal));
        const taxRate = Number(reservation?.pricingSnapshot?.taxRate ?? reservation.pickupLocation?.taxRate ?? 0);
        const taxes = roundMoney(subtotal * (taxRate / 100));
        // NOTE: subtotal/taxes here only shape the SYNTHESIZED chargeRows (daily/tax);
        // the authoritative agreement subtotal/taxes/fees/total/balance are recomputed
        // below from the FULL persisted set (synthesized + preserved carve-out rows).

        if (discountTotal > 0) {
          const discountRounded = roundMoney(discountTotal);
          chargeRows.push({ rentalAgreementId: existing.id, name: 'Discount', chargeType: 'UNIT', quantity: 1, rate: -discountRounded, total: -discountRounded, taxable: false, selected: true, sortOrder: chargeRows.length });
        }
        chargeRows.push({ rentalAgreementId: existing.id, name: `Tax (${taxRate.toFixed(2)}%)`, chargeType: 'TAX', quantity: 1, rate: taxes, total: taxes, taxable: false, selected: true, sortOrder: chargeRows.length });

        // Atomic re-sync (default chargeRows path — auto-fees + services + tax).
        //
        // MONEY-FIX 2026-07-09 (branch 3 — synthesized charges, no ReservationCharge
        // rows): this is the ONLY startFromReservation branch reached when the
        // reservation has NO selected ReservationCharge rows (staff/imported/
        // snapshot-priced), so structuredReservationChargeRows returns null and we
        // synthesize daily/service/fee/tax rows above. The prior deleteMany here was
        // UNCONDITIONAL and wiped the agreement-only rows — ADMIN_CORRECTION misc
        // charges, DAMAGE_CHARGE damage charges, FEE_ENGINE_ fees — that have no
        // ReservationCharge to re-sync from, so Print/GET agreement made them vanish
        // and the later void 404'd. We CANNOT delegate to syncAgreementCharges here
        // (branches 1/2 do): it re-mirrors from reservation.charges which is EMPTY on
        // this path, so it would delete the synthesized daily/tax rows and never
        // recreate them, zeroing the agreement. Instead we apply the SAME carve-out
        // (preserve FEE_ENGINE_/ADMIN_CORRECTION/DAMAGE_CHARGE) and recompute totals by
        // reading back the FULL persisted set (synthesized rows just created + preserved
        // carve-out rows) and re-bucketing them EXACTLY the way syncAgreementCharges does
        // (TAX -> taxes, deposits excluded, FEE_ENGINE_* -> fees, everything else ->
        // subtotal; total = subtotal+taxes+fees; paidAmount = real PAID non-AUTH_HOLD
        // payments; balance = max(0, total - paid)). Each row is counted exactly once.
        //
        // NULL-SAFE DELETE (branch 3 only): unlike branches 1/2 (whose re-synced rows
        // all carry a TYPED source: DAILY/SERVICE/TAX/…), branch 3 SYNTHESIZES several
        // rows with a NULL source (Daily, plain Fees, Discount, Tax above). Postgres
        // evaluates `NULL NOT LIKE 'FEE_ENGINE_%'` (and `NULL <> 'ADMIN_CORRECTION'`) to
        // NULL, so the plain triple-NOT predicate branches 1/2 use would NOT match those
        // null-source rows and would leave them behind — every startFromReservation would
        // then ADD a second Daily/Tax, doubling the total. So here we explicitly ALSO
        // delete null-source rows (`{ source: null }`) alongside the non-preserved typed
        // rows. Net effect matches the intended carve-out: keep ONLY the agreement-only
        // FEE_ENGINE_/ADMIN_CORRECTION/DAMAGE_CHARGE rows, delete everything else.
        await prisma.$transaction(async (tx) => {
          await tx.rentalAgreementCharge.deleteMany({
            where: {
              rentalAgreementId: existing.id,
              OR: [
                { source: null },
                {
                  AND: [
                    { NOT: { source: { startsWith: 'FEE_ENGINE_' } } },
                    { NOT: { source: 'ADMIN_CORRECTION' } },
                    { NOT: { source: 'DAMAGE_CHARGE' } }
                  ]
                }
              ]
            }
          });
          await tx.rentalAgreementCharge.createMany({ data: chargeRows });

          // Recompute from the FULL persisted set so the preserved agreement-only
          // rows are folded into the totals exactly once (chargeRows alone would
          // omit them and understate the total). Bucketing mirrors
          // reservation-pricing.service.js#syncAgreementCharges (~259-300).
          const allCharges = await tx.rentalAgreementCharge.findMany({
            where: { rentalAgreementId: existing.id, selected: true },
            select: { chargeType: true, total: true, source: true, name: true }
          });
          let recSubtotal = 0;
          let recTaxes = 0;
          let recFees = 0;
          for (const c of allCharges) {
            const t = Number(c.total || 0);
            const type = String(c.chargeType || '').toUpperCase();
            const src = String(c.source || '').toUpperCase();
            if (type === 'TAX') {
              recTaxes += t;
            } else if (isDepositCharge(c)) {
              // Deposits (Deposit Due + Security Deposit) are held/collected
              // separately and excluded from total/balance.
              continue;
            } else if (src.startsWith('FEE_ENGINE')) {
              recFees += t;
            } else {
              recSubtotal += t;
            }
          }
          const recSubtotalR = roundMoney(recSubtotal);
          const recTaxesR = roundMoney(recTaxes);
          const recFeesR = roundMoney(recFees);
          const recTotal = roundMoney(recSubtotalR + recTaxesR + recFeesR);
          // paidAmount = REAL captured money only (AUTH_HOLD authorizations excluded),
          // balance clamped to >= 0 — same as syncAgreementCharges / recomputeAgreementPaidAndBalance.
          const paidRows = await tx.rentalAgreementPayment.findMany({
            where: { rentalAgreementId: existing.id, status: 'PAID', method: { not: 'AUTH_HOLD' } },
            select: { amount: true }
          });
          const recPaid = roundMoney(paidRows.reduce((s, p) => s + Number(p.amount || 0), 0));
          const recBalance = Math.max(0, roundMoney(recTotal - recPaid));

          await tx.rentalAgreement.update({
            where: { id: existing.id },
            data: {
              tenantId: existing.tenantId || reservation.tenantId || null,
              notes: reservation.notes,
              subtotal: recSubtotalR,
              taxes: recTaxesR,
              fees: recFeesR,
              total: recTotal,
              paidAmount: recPaid,
              balance: recBalance
            }
          });
        }, { timeout: 10000 });
      }
      return this.getById(existing.id);
    }

    // LAX #4 (QA B1): same originator seeding as the sibling create above.
    const vaOriginatorId = reservation.createdByUserId
      ? (await prisma.user.findFirst({
          where: { id: reservation.createdByUserId, personKind: 'VIRTUAL_AGENT' },
          select: { id: true }
        }))?.id || null
      : null;

    let agreement;
    try {
      agreement = await prisma.rentalAgreement.create({
        data: {
          tenantId: reservation.tenantId || null,
          agreementNumber: agreementNumber(),
          reservationId,
          salesOwnerUserId: vaOriginatorId,
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
          insuranceSource: resolveInsuranceSource(reservation),
          insurancePolicyNumber: reservation.customer.insurancePolicyNumber,
          // Blob -> Storage (Phase 1): when the flag is ON and the snapshotted
          // value is inline base64, upload to Storage and persist the PATH.
          // Fail-safe: any error keeps the inline value. Flag OFF -> unchanged.
          insuranceDocumentUrl: await maybeUploadCustomerDocument(
            reservation.customer.insuranceDocumentUrl,
            { tenantId: reservation.tenantId || null, customerId: reservation.customerId, kind: 'insurance' }
          ),
          insurancePlanCode: resolveInsurancePlanField(reservation, 'code'),
          insurancePlanName: resolveInsurancePlanField(reservation, 'name'),
          insurancePlanRate: resolveInsurancePlanField(reservation, 'rate'),
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
    // 2026-06-06 Option B: exclude AUTH_HOLD deposit authorizations from paid.
    const prePayments = structuredReservationPayments(reservation);
    const prePaidTotal = prePayments
      .filter((p) => String(p.method || '').toUpperCase() !== 'AUTH_HOLD')
      .reduce((sum, p) => sum + Number(p.amount || 0), 0);

    const days = rentalDays(reservation.pickupAt, reservation.returnAt);
    const dailyRate = Number(reservation?.pricingSnapshot?.dailyRate ?? reservation.dailyRate ?? 0);
    const tenantWhere = reservation.tenantId ? { tenantId: reservation.tenantId } : {};

    const incomingRows = structuredReservationChargeRows(reservation);
    if (incomingRows && incomingRows.length) {
      const normalizedRows = incomingRows.map((r) => ({
        name: String(r?.name || 'Line Item'),
        code: r?.code || null,
        source: r?.source || null,
        sourceRefId: r?.sourceRefId || null,
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
          source: r.source || null,
          sourceRefId: r.sourceRefId || null
        }))
      });

      if (prePayments.length) {
        await importStructuredReservationPaymentsToAgreement(agreement.id, prePayments);
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

    const selectedServiceIds = [];
    const selectedFeeIds = [];
    const discounts = [];

    // Always include auto fees computed on reservation side (underage/additional-driver).
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
      // 2026-06-06 deposit-balance fix: push the row for the record but do NOT
      // add it to feesTotal — deposits are excluded from total/balance.
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

    // Pillar 2 wizards rounding-consistency fix (2026-05-19): see matching
    // comment on the existing-agreement re-sync path above. Same reason.
    const subtotal = roundMoney(Math.max(0, base + servicesTotal + feesTotal - discountTotal));
    const taxRate = Number(reservation?.pricingSnapshot?.taxRate ?? reservation.pickupLocation?.taxRate ?? 0);
    const taxes = roundMoney(subtotal * (taxRate / 100));
    const total = roundMoney(subtotal + taxes);

    if (discountTotal > 0) {
      const discountRounded = roundMoney(discountTotal);
      chargeRows.push({
        rentalAgreementId: agreement.id,
        name: 'Discount',
        chargeType: 'UNIT',
        quantity: 1,
        rate: -discountRounded,
        total: -discountRounded,
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
      await importStructuredReservationPaymentsToAgreement(agreement.id, prePayments);
    }

    await prisma.rentalAgreement.update({
      where: { id: agreement.id },
      data: {
        total,
        subtotal,
        taxes,
        paidAmount: roundMoney(prePaidTotal),
        balance: roundMoney(total - prePaidTotal)
      }
    });

    const finalRow = await prisma.rentalAgreement.findUnique({
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
    return coerceAgreementMoney(finalRow);
  },

  async getById(id, scope = null) {
    const agreement = await prisma.rentalAgreement.findFirst({
      // Program guard (2026-07-02): scoped user can't open an agreement from
      // the other program (null → route 404). Admins/BOTH → no filter.
      where: { id, ...(scope?.tenantId ? { tenantId: scope.tenantId } : {}), ...agreementProgramWhere(scope) },
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
        inspections: { orderBy: { createdAt: 'asc' } },
        // 2026-05-28 — checkout-wizard-v2 T&C signing.
        // tcSignature*, declinedInsurance*, sectionInitials. The print
        // template uses these to render the signed terms acknowledgement
        // pages + declined-insurance addendum after the standard layout.
        sectionInitials: { orderBy: { signedAt: 'asc' } }
      }
    });
    // Blob -> Storage (Phase 1): sign Storage-path doc refs for client render.
    // Per-field, best-effort. Legacy inline base64 / http URLs pass through.
    if (agreement) {
      agreement.insuranceDocumentUrl = await materializeDocumentRef(agreement.insuranceDocumentUrl);
      if (agreement.reservation?.customer) {
        const cust = agreement.reservation.customer;
        const [idPhotoUrl, custInsuranceUrl] = await Promise.all([
          materializeDocumentRef(cust.idPhotoUrl),
          materializeDocumentRef(cust.insuranceDocumentUrl)
        ]);
        cust.idPhotoUrl = idPhotoUrl;
        cust.insuranceDocumentUrl = custInsuranceUrl;
      }
    }
    return coerceAgreementMoney(agreement);
  },

  async agreementPrintContext(id) {
    const latestId = await this.resolveLatestAgreementId(id);
    const agreement = await prisma.rentalAgreement.findFirst({
      where: { id: latestId },
      select: {
        id: true,
        tenantId: true,
        reservationId: true,
        agreementNumber: true,
        customerFirstName: true,
        customerLastName: true,
        customerEmail: true,
        customerPhone: true,
        customerAddress1: true,
        customerAddress2: true,
        customerCity: true,
        customerState: true,
        customerZip: true,
        customerCountry: true,
        dateOfBirth: true,
        licenseNumber: true,
        licenseState: true,
        licenseExpiry: true,
        insuranceSource: true,
        insurancePolicyNumber: true,
        insurancePlanName: true,
        pickupAt: true,
        returnAt: true,
        pickupLocationId: true,
        // termsSectionsJson: the branch's acknowledgement text. buildSignedTermsBlock
        // re-prints those sections beside the customer's captured initials, so it
        // has to resolve them exactly as the phone/kiosk flow did when the
        // customer signed — otherwise the PDF shows text they never agreed to.
        pickupLocation: { select: { id: true, name: true, address: true, termsSectionsJson: true } },
        returnLocationId: true,
        returnLocation: { select: { id: true, name: true, address: true } },
        vehicleId: true,
        vehicle: {
          select: {
            id: true,
            internalNumber: true,
            make: true,
            model: true,
            year: true,
            color: true,
            plate: true,
            vin: true,
            mileage: true,
            vehicleType: { select: { name: true } }
          }
        },
        odometerOut: true,
        odometerIn: true,
        fuelOut: true,
        fuelIn: true,
        cleanlinessOut: true,
        cleanlinessIn: true,
        // 2026-06-10 — the wizard-v2/mobile flow saves odometer+fuel on the
        // inspection rows and (until beta.152) never wrote the agreement
        // columns. Pull the SLIM inspection fields (never photosJson — that
        // can be MBs of base64) so the contract can fall back to them.
        inspections: {
          select: { phase: true, odometer: true, fuelLevel: true }
        },
        subtotal: true,
        taxes: true,
        fees: true,
        total: true,
        deposit: true,
        securityDepositAmount: true,
        paidAmount: true,
        balance: true,
        // 2026-05-28 — checkout-wizard-v2 T&C signing fields. Used by
        // buildSignedTermsBlock + buildDeclinedInsuranceBlock when
        // appending the post-baseline pages to the PDF.
        tcSignatureDataUrl: true,
        tcSignedAt: true,
        tcSignerName: true,
        tcCustomerIp: true,
        declinedInsurance: true,
        declinedInsuranceSignatureDataUrl: true,
        declinedInsuranceSignedAt: true,
        // 2026-05-28 — per-section initial PNGs captured by the customer
        // on /sign/:token. buildSignedTermsBlock matches them to TC_SECTIONS
        // by sectionKey, and the inline regex replacement in
        // renderAgreementHtml uses the first one to fill the legacy
        // "( ___ Initials )" placeholders. Without this select the print
        // path quietly renders "(no initial)" for every section even when
        // the customer signed.
        sectionInitials: {
          orderBy: { signedAt: 'asc' },
          select: { sectionKey: true, initialDataUrl: true, signedAt: true, customerIp: true }
        },
        charges: {
          orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
          select: {
            id: true,
            name: true,
            chargeType: true,
            quantity: true,
            rate: true,
            total: true
          }
        },
        payments: {
          orderBy: { paidAt: 'desc' },
          select: {
            id: true,
            paidAt: true,
            createdAt: true,
            method: true,
            reference: true,
            status: true,
            amount: true
          }
        },
        reservation: {
          select: {
            id: true,
            reservationNumber: true,
            franchiseId: true,
            notes: true,
            // pickupAt / returnAt / originalReturnAt added 2026-05-12 — print
            // template needs the *current* reservation returnAt (and the
            // original pre-extension returnAt) to render
            // "Originally returned X · Now returns Y" on page 1 when the
            // reservation has been extended past the signed agreement date.
            // See renderAgreementHtml's returnAtDisplay builder.
            pickupAt: true,
            returnAt: true,
            originalReturnAt: true,
            signatureSignedAt: true,
            signatureSignedBy: true,
            signatureDataUrl: true,
            pickupLocation: {
              select: {
                id: true,
                name: true,
                address: true,
                locationConfig: true
              }
            },
            customer: {
              select: {
                id: true,
                email: true,
                firstName: true,
                lastName: true,
                phone: true,
                address1: true,
                address2: true,
                city: true,
                state: true,
                zip: true,
                country: true,
                dateOfBirth: true,
                licenseNumber: true,
                licenseState: true
              }
            },
            payments: {
              orderBy: { paidAt: 'desc' },
              select: {
                id: true,
                paidAt: true,
                method: true,
                reference: true,
                status: true,
                amount: true
              }
            }
          }
        }
      }
    });
    if (!agreement) throw new Error('Rental agreement not found');

    const { settingsService } = await import('../settings/settings.service.js');
    const { franchiseService } = await import('../settings/franchise.service.js');
    const agreementScope = agreement?.tenantId ? { tenantId: agreement.tenantId } : {};
    const globalCfg = await settingsService.getRentalAgreementConfig(agreementScope);
    const franchiseCfg = await franchiseService.getAgreementConfig(
      agreement?.reservation?.franchiseId, { tenantId: agreement?.tenantId }
    );
    const locCfg = parseLocationConfig(agreement?.reservation?.pickupLocation?.locationConfig);
    const cfg = {
      ...globalCfg,
      ...(franchiseCfg ? {
        companyName: franchiseCfg.companyName || globalCfg.companyName,
        companyAddress: franchiseCfg.companyAddress || globalCfg.companyAddress,
        companyPhone: franchiseCfg.companyPhone || globalCfg.companyPhone,
        companyLogoUrl: franchiseCfg.companyLogoUrl || globalCfg.companyLogoUrl,
        termsText: franchiseCfg.termsText || globalCfg.termsText,
        returnInstructionsText: franchiseCfg.returnInstructionsText || globalCfg.returnInstructionsText,
        agreementHtmlTemplate: franchiseCfg.agreementHtmlTemplate || globalCfg.agreementHtmlTemplate,
      } : {}),
      // Location config has highest priority (overrides franchise + tenant)
      companyName: locCfg.companyName || (franchiseCfg?.companyName) || agreement?.reservation?.pickupLocation?.name || globalCfg.companyName,
      companyAddress: locCfg.companyAddress || (franchiseCfg?.companyAddress) || agreement?.reservation?.pickupLocation?.address || globalCfg.companyAddress,
      companyPhone: locCfg.companyPhone || (franchiseCfg?.companyPhone) || globalCfg.companyPhone,
      companyLogoUrl: locCfg.companyLogoUrl || (franchiseCfg?.companyLogoUrl) || globalCfg.companyLogoUrl,
      termsText: locCfg.termsText || (franchiseCfg?.termsText) || globalCfg.termsText,
      returnInstructionsText: locCfg.returnInstructionsText || (franchiseCfg?.returnInstructionsText) || globalCfg.returnInstructionsText
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
    const seen = new Set();
    const paymentsForPrint = [...dbPayments, ...structuredReservationPrintPayments].filter((p) => {
      const k = `${new Date(p.paidAt || p.createdAt || Date.now()).toISOString().slice(0,19)}|${Number(p.amount || 0).toFixed(2)}|${String(p.reference || '').trim()}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    }).sort((a, b) => Number(new Date(b.paidAt || b.createdAt || 0)) - Number(new Date(a.paidAt || a.createdAt || 0)));

    // 2026-06-06 Option B: the printed "Amount Paid" counts REAL captured money
    // only (AUTH_HOLD deposit authorizations excluded — they still appear as
    // rows in the payments table for the record), and "Amount Due" never prints
    // negative. Matches agreement.balance and the reservation page.
    // 2026-07-02 (RES-756256): VOIDED payments must not count either — the
    // rollup (recomputeAgreementPaidAndBalance) and the fee engine both query
    // status: 'PAID', but this print-side sum only excluded AUTH_HOLD, so a
    // voided sale printed as money collected while the same document showed
    // the balance still due. Mirror the authoritative filter exactly: only
    // status PAID rows count (VOID rows still print in the table with their
    // status, for the record — same treatment as AUTH_HOLD).
    const paidAmountForPrint = Number(paymentsForPrint
      .filter((p) => String(p.method || '').toUpperCase() !== 'AUTH_HOLD'
        && String(p.status || 'PAID').toUpperCase() === 'PAID')
      .reduce((s, p) => s + Number(p.amount || 0), 0).toFixed(2));
    const amountDueForPrint = Math.max(0, Number((Number(agreement?.total || 0) - paidAmountForPrint).toFixed(2)));

    return { agreement, cfg, signatureIp, signatureTime, paymentsForPrint, paidAmountForPrint, amountDueForPrint };
  },

  async renderAgreementHtml(id) {
    const { agreement, cfg, signatureIp, signatureTime, paymentsForPrint, paidAmountForPrint, amountDueForPrint } = await this.agreementPrintContext(id);
    const chargesRows = (agreement.charges || []).map((c) => `<tr><td>${esc(c.name)}</td><td>${Number(c.quantity || 0).toFixed(2)}</td><td>$${Number(c.rate || 0).toFixed(2)}</td><td>$${Number(c.total || 0).toFixed(2)}</td></tr>`).join('');
    const paymentsRows = (paymentsForPrint || []).map((p) => `<tr><td>${esc(fmtDate(p.paidAt || p.createdAt))}</td><td>${esc(p.method || '-')}</td><td>${esc(p.reference || '-')}</td><td>${esc(String(p.status || '-'))}</td><td>$${Number(p.amount || 0).toFixed(2)}</td></tr>`).join('');
    const companyLogoUrl = String(cfg.companyLogoUrl || '').trim();
    const companyLogoBlock = buildCompanyLogoBlock(cfg.companyName || '', companyLogoUrl);

    const chargesRowsHtml = chargesRows || '<tr><td colspan="4">No charges recorded</td></tr>';
    const paymentsRowsHtml = paymentsForPrint.length ? paymentsRows : '<tr><td colspan="5">No payments recorded</td></tr>';

    // WHICH signature is the customer's, and it is not the one this block
    // used to show.
    //
    // Two different marks exist on a rental. The T&C signature is the
    // customer's assent to the contract: they signed it themselves, on their
    // own device, before driving away. The reservation signature is captured
    // when the rental is CLOSED — a different act, often days later, on staff
    // hardware at the counter.
    //
    // Until 2026-08-27 the close signature was tried FIRST here, so it won
    // whenever both existed — 835 of 1,573 agreements — and printed under the
    // heading "Customer Signature", carrying whatever name the closing agent
    // typed. A customer queried exactly that: an agreement showing "Signed by"
    // an employee. The stored data was right all along; only this block lied.
    //
    // Order flipped. pickInkedSignature (not ||) still does the picking, so
    // both original properties survive: a blank-but-valid PNG from an
    // untouched pad cannot mask real ink, and an agreement with no T&C
    // signature still falls through to the close signature rather than
    // printing an empty box (RA-20260701152550).
    const tcSigRaw = String(agreement.tcSignatureDataUrl || '').trim();
    const closeSigRaw = String(agreement.reservation?.signatureDataUrl || '').trim();
    const rawSigUrl = pickInkedSignature(tcSigRaw, closeSigRaw);

    // Name, timestamp and IP must describe the mark actually rendered.
    // Showing the customer's signature beside the closer's name and the
    // counter's IP would just relocate the defect rather than fix it.
    const showingTcSignature = !!rawSigUrl && rawSigUrl === tcSigRaw;
    const customerFullName = `${agreement.customerFirstName || ''} ${agreement.customerLastName || ''}`.trim();
    const signatureSignedByName = showingTcSignature
      ? (agreement.tcSignerName || customerFullName || '-')
      : (agreement.reservation?.signatureSignedBy || customerFullName || '-');
    const signatureTimeShown = showingTcSignature
      ? (agreement.tcSignedAt || signatureTime)
      : signatureTime;
    const signatureIpShown = showingTcSignature
      ? (agreement.tcCustomerIp || signatureIp)
      : signatureIp;
    const signatureImageBlock = rawSigUrl
      ? `<img src="${rawSigUrl}" alt="Signature" style="max-height:60px;max-width:320px;width:auto;height:auto;display:block;object-fit:contain" />`
      : '<div class="sig-meta">No signature on file</div>';

    // Build customer address line (read from live customer, fallback to snapshot)
    const liveCustomer = agreement.reservation?.customer;
    const customerAddress1 = liveCustomer?.address1 ?? agreement.customerAddress1;
    const customerAddress2 = liveCustomer?.address2 ?? agreement.customerAddress2;
    const customerCity = liveCustomer?.city ?? agreement.customerCity;
    const customerState = liveCustomer?.state ?? agreement.customerState;
    const customerZip = liveCustomer?.zip ?? agreement.customerZip;
    const customerCountry = liveCustomer?.country ?? agreement.customerCountry;
    const addrParts = [customerAddress1, customerAddress2, customerCity, customerState, customerZip, customerCountry].filter(Boolean);
    const customerAddress = addrParts.join(', ') || '-';

    // Build vehicle description
    const v = agreement.vehicle;
    const vehicleDesc = v ? [v.year, v.make, v.model].filter(Boolean).join(' ') : '-';
    const vehiclePlate = v?.plate || '-';
    const vehicleVin = v?.vin || '-';
    const vehicleColor = v?.color || '-';
    const vehicleType = v?.vehicleType?.name || '-';
    const vehicleInternal = v?.internalNumber || '-';
    const vehicleMileage = v?.mileage != null ? Number(v.mileage).toLocaleString() : '-';

    // Inspection data. 2026-06-10: the wizard-v2/mobile flow saves odometer +
    // fuel on the RentalAgreementInspection rows; until beta.152 the cascade
    // finalize never copied them onto the agreement columns, so contracts
    // printed "-". Coalesce: agreement column (canonical when present) ??
    // inspection row. Retroactive — fixes contracts already finalized.
    const inspRows = Array.isArray(agreement.inspections) ? agreement.inspections : [];
    const checkoutInsp = inspRows.find((r) => String(r.phase || '').toUpperCase() === 'CHECKOUT') || null;
    const checkinInsp = inspRows.find((r) => String(r.phase || '').toUpperCase() === 'CHECKIN') || null;
    const odoOutNum = agreement.odometerOut ?? checkoutInsp?.odometer ?? null;
    const odoInNum = agreement.odometerIn ?? checkinInsp?.odometer ?? null;
    const fuelOutNum = agreement.fuelOut ?? fuelLevelToFraction(checkoutInsp?.fuelLevel);
    const fuelInNum = agreement.fuelIn ?? fuelLevelToFraction(checkinInsp?.fuelLevel);

    const odometerOut = odoOutNum != null ? Number(odoOutNum).toLocaleString() : '-';
    const odometerIn = odoInNum != null ? Number(odoInNum).toLocaleString() : '-';
    const fuelOutVal = fuelOutNum != null ? `${Math.round(Number(fuelOutNum) * 100)}%` : '-';
    const fuelInVal = fuelInNum != null ? `${Math.round(Number(fuelInNum) * 100)}%` : '-';
    const cleanlinessOutVal = agreement.cleanlinessOut != null ? `${agreement.cleanlinessOut}/5` : '-';
    const cleanlinessInVal = agreement.cleanlinessIn != null ? `${agreement.cleanlinessIn}/5` : '-';

    // Financial summary
    const subtotal = Number(agreement.subtotal || 0).toFixed(2);
    const taxesAmount = Number(agreement.taxes || 0).toFixed(2);
    const feesAmount = Number(agreement.fees || 0).toFixed(2);
    const depositAmount = Number(agreement.deposit || 0).toFixed(2);
    const securityDeposit = Number(agreement.securityDepositAmount || 0).toFixed(2);
    const balanceAmount = Number(agreement.balance || 0).toFixed(2);

    const templateVars = {
      companyName: esc(cfg.companyName || ''),
      companyAddress: esc(cfg.companyAddress || ''),
      companyPhone: esc(cfg.companyPhone || ''),
      companyLogoUrl: esc(companyLogoUrl),
      companyLogoBlock,
      agreementNumber: esc(agreement.agreementNumber || ''),
      reservationNumber: esc(agreement.reservation?.reservationNumber || '-'),
      // Customer info (read from live customer, fallback to snapshot)
      customerName: esc(`${(liveCustomer?.firstName ?? agreement.customerFirstName) || ''} ${(liveCustomer?.lastName ?? agreement.customerLastName) || ''}`.trim()),
      customerEmail: esc((liveCustomer?.email ?? agreement.customerEmail) || '-'),
      customerPhone: esc((liveCustomer?.phone ?? agreement.customerPhone) || '-'),
      customerAddress: esc(customerAddress),
      customerDob: esc((liveCustomer?.dateOfBirth ?? agreement.dateOfBirth) ? fmtDate(liveCustomer?.dateOfBirth ?? agreement.dateOfBirth) : '-'),
      licenseNumber: esc((liveCustomer?.licenseNumber ?? agreement.licenseNumber) || '-'),
      licenseState: esc((liveCustomer?.licenseState ?? agreement.licenseState) || '-'),
      licenseExpiry: esc(agreement.licenseExpiry ? fmtDate(agreement.licenseExpiry) : '-'),
      insuranceProvider: esc(agreement.insuranceSource || agreement.insurancePlanName || '-'),
      insurancePolicy: esc(agreement.insurancePolicyNumber || '-'),
      // Dates & locations
      pickupAt: esc(fmtDate(agreement.pickupAt)),
      // returnAt on the print page (2026-05-12 per Hector): show both the
      // originally signed return date AND the current (extended) return
      // date when they differ. The reservation tracks the post-extension
      // value on returnAt and the pre-extension value on originalReturnAt
      // (set on the FIRST extension). agreement.returnAt is locked at
      // signing, so any drift between agreement.returnAt and
      // reservation.returnAt means the rental has been extended at least
      // once. Detection: any of (originalReturnAt is set) OR
      // (reservation.returnAt differs from agreement.returnAt). Display
      // is inline HTML in the existing {{returnAt}} template slot, so no
      // template changes are required (custom tenant templates still
      // render the original date; ours adds the "Now returns" line under
      // it).
      returnAt: (() => {
        const agreementReturn = agreement.returnAt;
        const liveReturn = agreement.reservation?.returnAt;
        const preExtensionReturn = agreement.reservation?.originalReturnAt;
        const sameMs = (a, b) => {
          if (!a || !b) return a === b;
          return new Date(a).getTime() === new Date(b).getTime();
        };
        const extended = !!preExtensionReturn && !sameMs(liveReturn, agreementReturn);
        if (!extended) {
          return esc(fmtDate(agreementReturn));
        }
        // Use agreement.returnAt as the "original" line (it is the actual
        // signed value; reservation.originalReturnAt should equal it but
        // we trust the agreement column as the legal record).
        return `${esc(fmtDate(agreementReturn))}<br><small style="color:#6b7a9a;font-weight:500">Now returns: ${esc(fmtDate(liveReturn))} (per addendum)</small>`;
      })(),
      pickupLocation: esc(agreement.pickupLocation?.name || '-'),
      pickupLocationAddress: esc(agreement.pickupLocation?.address || ''),
      returnLocation: esc(agreement.returnLocation?.name || '-'),
      returnLocationAddress: esc(agreement.returnLocation?.address || ''),
      // Vehicle info
      vehicleDesc: esc(vehicleDesc),
      vehiclePlate: esc(vehiclePlate),
      vehicleVin: esc(vehicleVin),
      vehicleColor: esc(vehicleColor),
      vehicleType: esc(vehicleType),
      vehicleInternal: esc(vehicleInternal),
      vehicleMileage: esc(vehicleMileage),
      // Inspection
      odometerOut: esc(odometerOut),
      odometerIn: esc(odometerIn),
      fuelOut: esc(fuelOutVal),
      fuelIn: esc(fuelInVal),
      cleanlinessOut: esc(cleanlinessOutVal),
      cleanlinessIn: esc(cleanlinessInVal),
      // Financial
      taxConfig: esc((agreement.charges || []).find((c) => String(c.chargeType || '').toUpperCase() === 'TAX')?.name || '-'),
      subtotal,
      taxesAmount,
      feesAmount,
      depositAmount,
      securityDeposit,
      total: Number(agreement.total || 0).toFixed(2),
      amountPaid: paidAmountForPrint.toFixed(2),
      amountDue: amountDueForPrint.toFixed(2),
      balance: balanceAmount,
      chargesRows: chargesRowsHtml,
      paymentsRows: paymentsRowsHtml,
      // Pillar 2 / 16g — canonical bilingual T&C (version TC_VERSION).
      // The configured cfg.termsText is treated as a tenant-level
      // ADDENDUM and appended below the canonical content; we no longer
      // surface the editable text as the legal terms themselves.
      // 2026-05-28 — when the customer did NOT decline counter insurance,
      // strip the "I voluntarily DECLINE all such optional coverage"
      // bilingual acknowledgement (the first tc-initials-block in the
      // canonical T&C). It only belongs on agreements where the customer
      // actually waived coverage at the counter; otherwise it misleads
      // the reader into thinking they did.
      termsText: (String(agreement.reservation?.workflowMode || '').toUpperCase() === 'DEALERSHIP_LOANER' && String(cfg.loanerTermsHtml || '').trim())
        ? cfg.loanerTermsHtml
        : stripDeclineCoverageIfNotApplicable(
            // Resolved location → tenant → canonical (2026-07-24). The PICKUP
            // location decides: that is the branch whose counter the customer
            // signs at and whose local law the agreement is written under. A
            // one-way rental returning elsewhere still signs the pickup
            // branch's terms.
            (await getEffectiveTermsHtml(
              { tenantId: agreement?.tenantId || null, locationId: agreement?.pickupLocationId || null },
              { prisma }
            )),
            !!agreement?.declinedInsurance,
          ) + (cfg.termsText ? `<div class="tc-tenant-addendum"><h2>Tenant Addendum</h2><p>${esc(cfg.termsText)}</p></div>` : ''),
      signatureSignedBy: esc(signatureSignedByName),
      signatureDateTime: esc(fmtDate(signatureTimeShown)),
      signatureIp: esc(signatureIpShown),
      signatureImageBlock,
      signatureDataUrl: rawSigUrl
    };

    const baseTemplate = String(cfg?.agreementHtmlTemplate || '').trim()
      ? cfg.agreementHtmlTemplate
      : getModernAgreementTemplate();
    let baseHtml = applyTemplate(baseTemplate, templateVars);

    // 2026-05-28 — Inject the customer's captured initial inline at every
    // legacy T&C placeholder. The bundled and many tenant-customized
    // templates contain literal strings like "( ___ Initials )" /
    // "( ___ Iniciales )" sprinkled through the T&C body (card-on-file
    // authorization, CNP, no-chargeback, post-rental charges, etc.).
    // checkout-wizard-v2 captures per-section initials on the customer's
    // phone; using the first one chronologically is the simplest way to
    // fill every placeholder since they aren't keyed to specific TC_SECTIONS.
    // Match permissively — underscores, dashes, dots, NBSPs and any case of
    // "Initials" / "Iniciales" all count.
    const _sectionInitialsForFill = Array.isArray(agreement.sectionInitials) ? agreement.sectionInitials : [];
    const _firstInitialUrl = _sectionInitialsForFill[0]?.initialDataUrl
      || agreement.tcSignatureDataUrl
      || '';
    if (_firstInitialUrl) {
      const _initialImg = `<img src="${_firstInitialUrl}" alt="Initials" style="display:inline-block;height:22px;max-width:70px;vertical-align:middle;border-bottom:0.5px solid #6B7280;margin:0 2px;padding:0 2px" />`;
      // Generic placeholder patterns. Allow ( ... Initials ), [ ... Initials ],
      // various separators (underscore, dash, dot, NBSP, plain space).
      const _placeholderRe = /[\(\[][\s_\-. ]*(Initial(?:s)?|Iniciale(?:s)?)[\s_\-. ]*[\)\]]/gi;
      baseHtml = baseHtml.replace(_placeholderRe, _initialImg);
    }

    // Pull addendums and splice their pages onto the agreement output so
    // every print/email of the agreement carries the addendums alongside
    // the original signed contract. We include VOID addendums too — the
    // legal record needs to show that an attempted change was reversed,
    // not silently disappear it. Order is creation chronological so the
    // "Addendum N of M" footer reads naturally.
    const addendums = await prisma.rentalAgreementAddendum.findMany({
      where: { rentalAgreementId: id },
      orderBy: { createdAt: 'asc' }
    });

    // Phase 3.3 + 3.4 — append the customer's signed T&C section and
    // (when applicable) the declined-insurance addendum. These run
    // INDEPENDENTLY of the legacy addendums system above so legacy
    // agreements (no tcSignatureDataUrl, no sectionInitials) get the
    // empty string back from buildSignedTermsBlock and the print stays
    // unchanged.
    const ctx = { agreement, cfg, companyLogoBlock };
    const addendumPages = addendums.length ? buildAddendumPagesHtml(addendums, ctx) : '';
    const signedTermsPages = buildSignedTermsBlock(agreement, ctx);
    const declinedInsurancePage = buildDeclinedInsuranceBlock(agreement, ctx);
    // Reservation-bound vehicle-inspection QR (2026-08-22). '' when the tenant
    // has inspection disabled → other tenants' contracts stay byte-identical.
    const inspectionQrPage = await buildInspectionQrBlockHtml({
      reservationId: agreement.reservation?.id || agreement.reservationId || null,
      tenantId: agreement.tenantId || null,
      returnAt: agreement.reservation?.returnAt || agreement.returnAt || null,
    });
    const extraPages = [addendumPages, signedTermsPages, declinedInsurancePage, inspectionQrPage].filter(Boolean).join('\n');
    if (!extraPages) return baseHtml;

    // Splice before </body>. Falls back to append if a custom tenant template
    // happens to omit the closing tag — the extra pages are still valid
    // standalone HTML and the browser/Puppeteer renderer is forgiving.
    if (/<\/body>/i.test(baseHtml)) {
      return baseHtml.replace(/<\/body>/i, `${extraPages}</body>`);
    }
    return `${baseHtml}\n${extraPages}`;
  },

  async agreementPdfBuffer(id) {
    const html = await this.renderAgreementHtml(id);
    // Reuse the singleton Chromium — avoid paying launch cost per request.
    // withPage() opens/closes a Page (never the Browser) AND enforces the
    // process-wide concurrent-page cap (PUPPETEER_MAX_CONCURRENT_PAGES) so a
    // burst of agreement prints can't stack Chromium RAM. (Phase 0 2026-06-09)
    return withPage(async (page) => {
      // `domcontentloaded` is sufficient — the agreement HTML inlines all
      // assets (CSS, images as data URLs, fonts). `networkidle0` adds 500ms+
      // of idle wait for nothing.
      await page.setContent(html, { waitUntil: 'domcontentloaded' });
      // Explicitly emulate print media so the @media print rules in the
      // canonical T&C HTML body (and any tenant-custom T&C with print-only
      // overrides) take effect during page.pdf(). Older Puppeteer versions
      // didn't default to print; calling this is cheap and removes the
      // ambiguity.
      await page.emulateMediaType('print');
      // Ensure all inline/data-URL images are decoded before PDF render
      await page.evaluate(() => Promise.all(
        Array.from(document.images)
          .filter((img) => !img.complete)
          .map((img) => new Promise((resolve) => {
            img.addEventListener('load', resolve, { once: true });
            img.addEventListener('error', resolve, { once: true });
          }))
      ));
      const pdfBuffer = await page.pdf({
        format: 'Letter',
        printBackground: true
      });
      return pdfBuffer;
    });
  },

  async emailAgreement(id, payload = {}, actorUserId = null) {
    const latestId = await this.resolveLatestAgreementId(id);
    const context = await this.agreementPrintContext(latestId);
    const agreement = context?.agreement;
    if (!agreement) throw new Error('Rental agreement not found');
    const cfg = context?.cfg || {};
    const paidAmountForPrint = Number(context?.paidAmountForPrint || 0);
    const amountDueForPrint = Number(context?.amountDueForPrint || 0);

    // Read from live customer, fallback to snapshot
    const liveCustomer = agreement.reservation?.customer;
    const to = String(payload.to || liveCustomer?.email || agreement.customerEmail || '').trim();
    if (!to) throw new Error('Customer email is required');

    const pdf = await this.agreementPdfBuffer(latestId);
    const { sendEmail } = await import('../../lib/mailer.js');
    const { renderBrandedEmail, resolveEmailBrand } = await import('../../lib/email-template.js');
    const { settingsService } = await import('../settings/settings.service.js');
    const tpl = await settingsService.getEmailTemplates();

    const base = (process.env.APP_BASE_URL || process.env.FRONTEND_BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
    const vars = {
      companyName: cfg.companyName || agreement?.reservation?.pickupLocation?.name || 'Ride Fleet',
      companyAddress: cfg.companyAddress || agreement?.reservation?.pickupLocation?.address || '',
      companyPhone: cfg.companyPhone || '',
      agreementNumber: agreement.agreementNumber,
      reservationNumber: agreement?.reservation?.reservationNumber || '-',
      customerName: `${(liveCustomer?.firstName ?? agreement.customerFirstName) || ''} ${(liveCustomer?.lastName ?? agreement.customerLastName) || ''}`.trim(),
      pickupAt: fmtDate(agreement.pickupAt),
      returnAt: fmtDate(agreement.returnAt),
      total: Number(agreement.total || 0).toFixed(2),
      amountPaid: paidAmountForPrint.toFixed(2),
      amountDue: amountDueForPrint.toFixed(2),
      portalLink: `${base}/reservations/${agreement.reservationId}`
    };

    const subject = applyTemplate(String(payload.subject || tpl?.agreementEmailSubject || 'Your Rental Agreement {{agreementNumber}}'), vars);
    const innerHtml = applyTemplate(String(payload.html || tpl?.agreementEmailHtml || ''), vars);
    const innerText = String(payload.text || `Attached is your rental agreement ${agreement.agreementNumber}.`);

    let agBrand;
    try { agBrand = await resolveEmailBrand({ tenantId: agreement.tenantId || agreement.reservation?.tenantId || null }); } catch { agBrand = undefined; }
    const { html, text } = renderBrandedEmail({
      brand: agBrand,
      heading: `Your rental agreement ${agreement.agreementNumber}`,
      bodyHtml: innerHtml || `<p>Attached is your rental agreement ${agreement.agreementNumber}.</p>`,
      bodyText: innerText,
      cta: vars.portalLink ? { label: 'View reservation', url: vars.portalLink } : undefined,
      preheader: subject,
    });

    await sendEmail({ tenantId: agreement.tenantId || agreement.reservation?.tenantId || undefined,
      to,
      subject,
      text,
      html,
      attachments: [{ filename: `${agreement.agreementNumber}.pdf`, content: pdf, contentType: 'application/pdf' }]
    });

    await prisma.auditLog.create({ data: { reservationId: agreement.reservationId, actorUserId: actorUserId || null, action: 'UPDATE', reason: `Agreement emailed to ${to}` } });
    return { ok: true, to };
  },

  // Async wrapper for emailAgreement. Returns synchronously after lightweight
  // validation (so the HTTP handler can respond 202), then runs the heavy
  // Puppeteer + SMTP work in the background. Failures land in Sentry + an
  // audit-log entry on the agreement so staff can retry from the UI.
  //
  // Interim implementation: uses `setImmediate` for fire-and-forget. When the
  // Redis/BullMQ rollout from docs/architecture/SCALING_ROADMAP.md lands, swap
  // `scheduler` to enqueue a persisted job so an SIGTERM mid-send doesn't lose
  // the mail.
  //
  // Tenant defense-in-depth: `tenantId` must be supplied by the route handler
  // (from req.user.tenantId, which came through requireAuth). The default
  // findAgreement applies a tenantId filter so even if the handler's
  // ensureAccessible guard is removed in a future refactor, this async job
  // still cannot touch another tenant's data. Super-admin requests pass
  // tenantId=null, which matches the repo's cross-tenant pattern.
  //
  // `deps` shape (all optional, for tests):
  //   runEmail: (id, payload, actorUserId) => Promise<{ ok, to }>
  //   findAgreement: (id, tenantId) => Promise<{ reservationId, tenantId, customerEmail, reservation?: { customer?: { email } } } | null>
  //   writeAudit: (data) => Promise<void>
  //   captureException: (err, ctx) => void
  //   scheduler: (cb) => void  // defaults to setImmediate
  //   logger: { info?, warn?, error? }
  scheduleEmailDelivery(id, payload = {}, actorUserId = null, tenantId = null, deps = {}) {
    const runEmail = deps.runEmail || ((aid, p, uid) => this.emailAgreement(aid, p, uid));
    const findAgreement = deps.findAgreement || ((aid, tid) => {
      // Tenant filter is defense-in-depth. The handler already guards via
      // ensureAccessible; this second layer ensures the async job can never
      // read or write across tenants. A null tenantId indicates super-admin
      // context (matches the repo's crossTenantScopeFor pattern).
      const where = tid ? { id: aid, tenantId: tid } : { id: aid };
      return prisma.rentalAgreement.findFirst({
        where,
        select: { reservationId: true, tenantId: true, customerEmail: true, reservation: { select: { customer: { select: { email: true } } } } }
      });
    });
    const writeAudit = deps.writeAudit || ((data) => prisma.auditLog.create({ data }));
    const captureException = deps.captureException || ((err, ctx) => {
      // Lazy import to avoid pulling Sentry into tests that don't need it.
      import('../../lib/sentry.js').then((m) => m.captureBackendException(err, ctx)).catch(() => {});
    });
    const scheduler = deps.scheduler || setImmediate;
    const log = deps.logger || null; // optional structured logger

    // Wrap captureException so a misbehaving dep (e.g. Sentry SDK itself
    // throwing) never turns into an unhandled rejection in the background job.
    const safeCapture = (err, ctx) => {
      try { captureException(err, ctx); } catch (captureErr) {
        log?.error?.(`[email-agreement] captureException itself failed: ${captureErr?.message || captureErr}`);
      }
    };

    const explicitTo = String(payload?.to || '').trim();
    let resolvedTo = explicitTo;

    const startJob = (toFinal) => {
      scheduler(() => {
        Promise.resolve()
          .then(() => runEmail(id, payload, actorUserId))
          .then((result) => {
            // Recipient address goes in the meta object under key `email` so the
            // Winston redactor (logger.js REDACT_KEYS) masks it — never in the
            // message string, which bypasses key-based redaction (PII-in-logs).
            log?.info?.('[email-agreement] sent', { agreementId: id, email: result?.to || toFinal });
          })
          .catch(async (err) => {
            safeCapture(err, { context: 'emailAgreement async', agreementId: id, actorUserId, tenantId });
            log?.error?.(`[email-agreement] failed for agreement ${id}: ${err?.message || err}`);
            try {
              const ag = await findAgreement(id, tenantId);
              if (ag) {
                await writeAudit({
                  reservationId: ag.reservationId,
                  tenantId: ag.tenantId || null,
                  actorUserId: actorUserId || null,
                  action: 'UPDATE',
                  reason: `Agreement email FAILED for ${toFinal}: ${err?.message || 'unknown error'}`
                });
              }
            } catch (auditErr) {
              // Best-effort audit trail — if even the audit write fails, log it
              // so ops has some visibility rather than a silent black hole.
              log?.error?.(`[email-agreement] audit write also failed for agreement ${id}: ${auditErr?.message || auditErr}`);
            }
          });
      });
    };

    // Sync validation: if we don't have an email, fail fast so the handler
    // can respond 4xx instead of 202. We resolve `to` from payload first;
    // if absent, we look it up synchronously-ish via the same findAgreement
    // dep (with tenant filter) and only then schedule.
    if (resolvedTo) {
      startJob(resolvedTo);
      return Promise.resolve({ ok: true, queued: true, to: resolvedTo });
    }

    return findAgreement(id, tenantId).then((ag) => {
      resolvedTo = String(ag?.customerEmail || ag?.reservation?.customer?.email || '').trim();
      if (!resolvedTo) {
        const err = new Error('Customer email is required');
        err.statusCode = 400;
        throw err;
      }
      startJob(resolvedTo);
      return { ok: true, queued: true, to: resolvedTo };
    });
  },

  updateCustomer(id, patch) {
    // Writer #5 of the customer-email inventory (lib/customer-email.js), and the
    // ONLY one that writes RentalAgreement.customerEmail from a keyboard instead
    // of snapshotting Customer.email. This is the exact column the contract
    // mailer addresses, so a bad string here IS the 2026-08-31 incident. STAFF
    // capture -> 400. `undefined` is passed straight through, because that is
    // Prisma's "leave this column alone" and every other field in this patch
    // depends on it — validating an absent value would turn "don't touch the
    // email" into "erase the email".
    const customerEmail = patch.customerEmail === undefined
      ? undefined
      : assertCustomerEmail(patch.customerEmail, { audience: 'staff' });
    return prisma.rentalAgreement.update({
      where: { id },
      data: {
        customerFirstName: patch.customerFirstName,
        customerLastName: patch.customerLastName,
        customerEmail,
        customerPhone: patch.customerPhone,
        customerAddress1: patch.customerAddress1,
        customerAddress2: patch.customerAddress2,
        customerCity: patch.customerCity,
        customerState: patch.customerState,
        customerZip: patch.customerZip,
        customerCountry: patch.customerCountry,
        dateOfBirth: patch.dateOfBirth === undefined ? undefined : normalizeDob(patch.dateOfBirth),
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

  // OUT OF SCOPE, DECLARED (2026-09-01). This writes AgreementDriver.email — a
  // FOURTH email column, captured from a keyboard, ungated. It is genuinely the
  // same failure mode, and it is genuinely not this change: no send path
  // addresses an additional driver today (grep for agreementDriver + sendEmail
  // returns nothing), so it cannot produce the incident this branch closes, and
  // pulling in a fourth column mid-review is how a fix stops being reviewable.
  // Named here rather than left silent, because an undeclared gap reads as an
  // overlooked one. Next batch: same lib/customer-email.js, STAFF policy.
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
      .filter((c) => c.chargeType !== 'TAX' && !isDepositCharge(c))
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
      // Bug #44 — release the car back to AVAILABLE when the agreement is voided.
      await syncVehicleStatusForReservation(prisma, { vehicleId: agreement.vehicleId, reservationId: agreement.reservationId, toStatus: 'CANCELLED' });
      await prisma.auditLog.create({ data: { reservationId: agreement.reservationId, actorUserId: actorUserId || null, action: 'STATUS_CHANGE', fromStatus: 'CHECKED_OUT', toStatus: 'CANCELLED', reason: 'Agreement voided' } });
      return row;
    }

    if (mode === 'REACTIVATE') {
      if (agreement.status !== 'CANCELLED') throw new Error('Only cancelled/voided agreements can be reactivated');
      const row = await prisma.rentalAgreement.update({ where: { id }, data: { status: 'FINALIZED' } });
      await prisma.reservation.update({ where: { id: agreement.reservationId }, data: { status: 'CHECKED_OUT' } });
      // Bug #44 — reactivating an agreement puts the car back ON_RENT.
      await syncVehicleStatusForReservation(prisma, { vehicleId: agreement.vehicleId, reservationId: agreement.reservationId, toStatus: 'CHECKED_OUT' });
      await prisma.auditLog.create({ data: { reservationId: agreement.reservationId, actorUserId: actorUserId || null, action: 'STATUS_CHANGE', fromStatus: 'CANCELLED', toStatus: 'CHECKED_OUT', reason: 'Agreement reactivated' } });
      return row;
    }

    // START_CHECK_IN
    const row = await prisma.rentalAgreement.update({ where: { id }, data: { status: 'FINALIZED' } });
    await prisma.reservation.update({ where: { id: agreement.reservationId }, data: { status: 'CHECKED_IN' } });
    // Bug #44 — starting check-in returns the car to the lot (AVAILABLE).
    await syncVehicleStatusForReservation(prisma, { vehicleId: agreement.vehicleId, reservationId: agreement.reservationId, toStatus: 'CHECKED_IN' });
    await prisma.auditLog.create({ data: { reservationId: agreement.reservationId, actorUserId: actorUserId || null, action: 'STATUS_CHANGE', fromStatus: 'CHECKED_OUT', toStatus: 'CHECKED_IN', reason: 'Check-in started from agreement' } });
    await completeLinkedCarSharingTripForReservation(agreement.reservationId, actorUserId || null, 'Trip auto-completed from agreement check-in');
    return row;
  },

  async addManualPayment(id, payload = {}, actorUserId = null) {
    const amount = Number(payload.amount || 0);
    if (!Number.isFinite(amount) || amount <= 0) throw new Error('Manual entry amount must be greater than 0');

    const entryType = String(payload.entryType || 'CHARGE').toUpperCase();
    if (!['CHARGE', 'DEPOSIT', 'REFUND'].includes(entryType)) throw new Error('entryType must be CHARGE, DEPOSIT, or REFUND');

    // Pillar 2 (2026-05-18): receipt requirement relaxed for CARD payments
    // with a reference (auth code). For card-on-counter swipes, the merchant
    // terminal slip IS the receipt and the auth code provides the audit trail.
    // CASH and CHECK still require a receipt photo because there's no other
    // proof of payment.
    const receiptDataUrl = String(payload.receiptDataUrl || '').trim();
    const method = String(payload.method || 'OTHER').toUpperCase();
    const reference = String(payload.reference || '').trim();
    const cardWithAuth = method === 'CARD' && reference.length > 0;
    // AUTH_HOLD is a security-deposit authorization swipe — no receipt to
    // attach, but the auth code in `reference` is mandatory as audit trail.
    if (method === 'AUTH_HOLD' && !reference) {
      throw new Error('reference is required for AUTH_HOLD payments (auth code)');
    }
    const authHold = method === 'AUTH_HOLD' && reference.length > 0;
    if (!receiptDataUrl && !cardWithAuth && !authHold) {
      throw new Error('Receipt is required for manual entries (CARD or AUTH_HOLD payments may skip if a reference / auth code is provided)');
    }

    const agreement = await prisma.rentalAgreement.findUnique({ where: { id } });
    if (!agreement) throw new Error('Rental agreement not found');

    const sign = entryType === 'REFUND' ? -1 : 1;
    const postedAmount = Number((amount * sign).toFixed(2));

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

    // 2026-06-06 Option B: recompute paidAmount/balance from REAL payments.
    // An AUTH_HOLD manual entry (deposit hold) is recorded as a row but does
    // NOT change paidAmount/balance; a REFUND posts as a negative-amount row.
    const { balance: nextBalance } = await recomputeAgreementPaidAndBalance(prisma, id);
    await prisma.auditLog.create({ data: { reservationId: agreement.reservationId, actorUserId: actorUserId || null, action: 'UPDATE', reason: `Manual ${entryType.toLowerCase()} added: ${postedAmount.toFixed(2)}` } });

    // Settle-on-payment: if this clears the balance on a CHECKED_IN_UNPAID
    // reservation, advance it to CHECKED_IN (mirrors the autocharge worker) so a
    // manually-collected balance doesn't leave it perpetually "unpaid".
    if (nextBalance <= 0.01) {
      const resv = await prisma.reservation.findUnique({ where: { id: agreement.reservationId }, select: { status: true } });
      if (String(resv?.status || '').toUpperCase() === 'CHECKED_IN_UNPAID') {
        await prisma.reservation.update({ where: { id: agreement.reservationId }, data: { status: 'CHECKED_IN', autochargeAt: null } });
        await syncVehicleStatusForReservation(prisma, { reservationId: agreement.reservationId, toStatus: 'CHECKED_IN' });
        await prisma.auditLog.create({ data: { reservationId: agreement.reservationId, actorUserId: actorUserId || null, action: 'STATUS_CHANGE', fromStatus: 'CHECKED_IN_UNPAID', toStatus: 'CHECKED_IN', reason: 'Balance settled via manual payment' } }).catch(() => {});
      }
    }

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

  async saveCardOnFileFromPayment(id, paymentId, actorUserId = null) {
    const agreement = await prisma.rentalAgreement.findUnique({
      where: { id },
      include: {
        reservation: {
          include: {
            customer: true
          }
        }
      }
    });
    if (!agreement) throw new Error('Rental agreement not found');
    if (!agreement.reservation?.customer?.id) throw new Error('Customer not found');

    const existingCustomerProfileId = String(agreement.reservation.customer.authnetCustomerProfileId || '').trim();
    const existingPaymentProfileId = String(agreement.reservation.customer.authnetPaymentProfileId || '').trim();
    if (existingCustomerProfileId && existingPaymentProfileId) {
      return {
        ok: true,
        customerProfileId: existingCustomerProfileId,
        paymentProfileId: existingPaymentProfileId,
        alreadySaved: true
      };
    }

    const payment = await prisma.reservationPayment.findFirst({
      where: {
        id: paymentId,
        reservationId: agreement.reservationId
      }
    });
    if (!payment) throw new Error('Payment not found');
    if (!(Number(payment.amount || 0) > 0)) throw new Error('Only positive payment transactions can be saved as card on file');
    if (!String(payment.reference || '').trim().toUpperCase().startsWith('AUTHNET:')) {
      throw new Error('Only Authorize.Net transactions can be saved as card on file');
    }

    const out = await saveAuthNetCardProfileFromReference({
      customerId: agreement.reservation.customer.id,
      reference: payment.reference,
      scope: agreement?.tenantId ? { tenantId: agreement.tenantId } : {},
      customer: agreement.reservation.customer,
      reservationId: agreement.reservationId
    });

    try {
      await prisma.auditLog.create({
        data: {
          reservationId: agreement.reservationId,
          actorUserId: actorUserId || null,
          action: 'UPDATE',
          reason: `Saved customer card on file from payment ${paymentId}`
        }
      });
    } catch {}

    return {
      ok: true,
      ...out
    };
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
          order: { invoiceNumber: authNetInvoiceNumberValue(agreement.agreementNumber || agreement.reservationId || '') || undefined }
        }
      }
    }, tenantScope);

    const authnetBody = authNetTransactionEnvelope(authnet);
    const tx = authnetBody?.transactionResponse || {};
    const ok = String(authnetBody?.messages?.resultCode || '').trim() === 'Ok' && String(tx?.responseCode || '').trim() === '1';
    if (!ok) {
      const err = authNetMessage(authnetBody) || 'Authorize.Net charge failed';
      throw new Error(err);
    }

    const reference = `AUTHNET:${tx.transId || 'UNKNOWN'}`;
    return this.addManualPayment(id, { amount, method: 'CARD', reference, notes: 'Charged card on file via Authorize.Net' }, actorUserId);
  },

  async reconcileLatestAuthNetReservationPayment(reservationId, payload = {}, scope = {}, actorUserId = null) {
    const reservation = await prisma.reservation.findFirst({
      where: {
        id: reservationId,
        ...(scope?.tenantId ? { tenantId: scope.tenantId } : {})
      },
      include: {
        customer: true,
        rentalAgreement: {
          select: {
            id: true,
            total: true,
            paidAmount: true,
            balance: true
          }
        },
        payments: {
          orderBy: { paidAt: 'desc' },
          select: {
            id: true,
            reference: true
          }
        }
      }
    });
    if (!reservation) { const e = new Error('Reservation not found'); e.status = 404; throw e; }

    const expectedAmount = Number(payload.amount || reservation.rentalAgreement?.balance || 0);
    if (!(expectedAmount > 0)) throw new Error('No unpaid Authorize.Net amount to reconcile');

    const tenantScope = reservation?.tenantId ? { tenantId: reservation.tenantId } : scope;
    const expectedInvoiceNumber = authNetInvoiceNumberValue(reservation.reservationNumber || reservationId);
    const existingReferences = new Set(
      (Array.isArray(reservation.payments) ? reservation.payments : [])
        .map((row) => String(row?.reference || '').trim().toUpperCase())
        .filter(Boolean)
    );
    const requestedTransId = authNetTransIdValue(payload?.transId || payload?.reference || '');

    if (requestedTransId) {
      const requestedReference = `AUTHNET:${requestedTransId}`;
      if (existingReferences.has(requestedReference.toUpperCase())) {
        throw new Error(`Authorize.Net payment ${requestedReference} is already recorded`);
      }

      const details = await authNetTransactionDetails(requestedTransId, tenantScope);
      const tx = details?.transaction || {};
      const txStatus = String(tx?.transactionStatus || '').trim();
      if (txStatus && !['capturedPendingSettlement', 'settledSuccessfully'].includes(txStatus)) {
        throw new Error(`Authorize.Net payment is not yet captured (${txStatus})`);
      }

      const reconciledAmount = Number(tx?.authAmount || tx?.settleAmount || tx?.amount || expectedAmount || 0);
      if (!(reconciledAmount > 0)) throw new Error('Authorize.Net transaction amount is missing');

      const invoiceNumber = authNetInvoiceNumberValue(tx?.order?.invoiceNumber || tx?.invoiceNumber || '');
      if (invoiceNumber && invoiceNumber !== expectedInvoiceNumber) {
        throw new Error(`Authorize.Net transaction belongs to ${invoiceNumber}, not ${expectedInvoiceNumber}`);
      }

      await reservationPricingService.postPayment(reservationId, {
        amount: reconciledAmount,
        method: 'CARD',
        reference: requestedReference,
        status: 'PAID',
        origin: 'PORTAL',
        gateway: 'authorizenet',
        notes: 'Reconciled from Authorize.Net transaction reference'
      }, scope, actorUserId);

      let savedCardOnFile = false;
      try {
        if (reservation?.customer?.id) {
          await saveAuthNetCardProfileFromReference({
            customerId: reservation.customer.id,
            reference: requestedReference,
            scope: tenantScope
          });
          savedCardOnFile = true;
        }
      } catch {}

      return {
        ok: true,
        amount: reconciledAmount,
        reference: requestedReference,
        transId: requestedTransId,
        savedCardOnFile
      };
    }

    const now = Date.now();
    const recentTransactions = await authNetRecentTransactions(tenantScope);
    const transactions = await authNetEnrichRecentTransactions(recentTransactions, tenantScope, 15);
    const candidates = transactions
      .map((tx) => {
        const transId = String(tx?.transId || '').trim();
        const reference = transId ? `AUTHNET:${transId}` : '';
        const amount = Number(tx?.authAmount || tx?.settleAmount || tx?.amount || 0);
        const submittedAt = tx?.submitTimeUTC || tx?.submitTimeLocal || tx?.submitTime || null;
        const submittedMs = submittedAt ? new Date(submittedAt).getTime() : 0;
        const invoiceNumber = authNetInvoiceNumberValue(tx?.invoiceNumber || tx?.order?.invoiceNumber || '');
        return {
          tx,
          transId,
          reference,
          amount,
          invoiceNumber,
          submittedMs: Number.isFinite(submittedMs) ? submittedMs : 0,
          transactionStatus: String(tx?.transactionStatus || '').trim()
        };
      })
      .filter((row) => row.transId && row.reference && !existingReferences.has(row.reference.toUpperCase()))
      .filter((row) => !row.submittedMs || Math.abs(now - row.submittedMs) <= 1000 * 60 * 60 * 24);

    const exactInvoiceMatches = candidates
      .filter((row) => row.invoiceNumber && row.invoiceNumber === expectedInvoiceNumber)
      .sort((a, b) => {
        const aExactAmount = Math.abs(a.amount - expectedAmount) < 0.01 ? 1 : 0;
        const bExactAmount = Math.abs(b.amount - expectedAmount) < 0.01 ? 1 : 0;
        if (aExactAmount !== bExactAmount) return bExactAmount - aExactAmount;
        return b.submittedMs - a.submittedMs;
      });

    const amountMatches = candidates
      .filter((row) => Math.abs(row.amount - expectedAmount) < 0.01)
      .sort((a, b) => b.submittedMs - a.submittedMs);

    const match = exactInvoiceMatches[0] || amountMatches[0] || null;

    if (!match) {
      console.info('[authnet reconcile] no match', {
        reservationId,
        reservationNumber: reservation.reservationNumber || null,
        expectedInvoiceNumber,
        expectedAmount,
        recentTransactionCount: transactions.length,
        candidateCount: candidates.length,
        candidateInvoices: candidates
          .map((row) => row.invoiceNumber || '')
          .filter(Boolean)
          .slice(0, 10),
        candidateAmounts: candidates
          .map((row) => Number(row.amount || 0))
          .filter((value) => value > 0)
          .slice(0, 10)
      });
      throw new Error(
        expectedInvoiceNumber
          ? `No recent Authorize.Net payment found for ${expectedInvoiceNumber} / $${expectedAmount.toFixed(2)}. Paste the AuthNet transId in Reference and retry reconcile.`
          : `No recent Authorize.Net payment found for $${expectedAmount.toFixed(2)}`
      );
    }

    const txStatus = String(match.transactionStatus || '').trim();
    if (txStatus && !['capturedPendingSettlement', 'settledSuccessfully'].includes(txStatus)) {
      throw new Error(`Authorize.Net payment is not yet captured (${txStatus})`);
    }

    const reconciledAmount = Number(match.amount || expectedAmount || 0);

    await reservationPricingService.postPayment(reservationId, {
      amount: reconciledAmount,
      method: 'CARD',
      reference: match.reference,
      status: 'PAID',
      origin: 'PORTAL',
      gateway: 'authorizenet',
      notes: Math.abs(reconciledAmount - expectedAmount) > 0.009
        ? `Reconciled from Authorize.Net hosted payment (expected $${expectedAmount.toFixed(2)}, matched $${reconciledAmount.toFixed(2)})`
        : 'Reconciled from Authorize.Net hosted payment'
    }, scope, actorUserId);

    let savedCardOnFile = false;
    try {
      if (reservation?.customer?.id) {
        await saveAuthNetCardProfileFromReference({
          customerId: reservation.customer.id,
          reference: match.reference,
          scope: tenantScope
        });
        savedCardOnFile = true;
      }
    } catch {}

    return {
      ok: true,
      amount: reconciledAmount,
      reference: match.reference,
      transId: match.transId,
      savedCardOnFile
    };
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
            order: { invoiceNumber: authNetInvoiceNumberValue(agreement.agreementNumber || agreement.reservationId || '') || undefined }
            }
          }
        }, tenantScope);
        const authnetBody = authNetTransactionEnvelope(authnet);
        const tx = authnetBody?.transactionResponse || {};
        const ok = String(authnetBody?.messages?.resultCode || '').trim() === 'Ok' && String(tx?.responseCode || '').trim() === '1';
        if (!ok) {
          const err = authNetMessage(authnetBody) || 'Authorize.Net deposit capture failed';
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

    const tenantScope = agreement?.tenantId ? { tenantId: agreement.tenantId } : {};
    const rawReference = String(agreement.securityDepositReference || payload.reference || '').trim();
    const authRef = rawReference.toUpperCase().startsWith('AUTHNET_AUTH:')
      ? rawReference.slice('AUTHNET_AUTH:'.length).trim()
      : '';

    if (authRef) {
      const cfg = await authNetConfig(tenantScope);
      const authnet = await authNetRequest({
        createTransactionRequest: {
          merchantAuthentication: {
            name: cfg.loginId,
            transactionKey: cfg.transactionKey
          },
          transactionRequest: {
            transactionType: 'voidTransaction',
            refTransId: authRef
          }
        }
      }, tenantScope);

      const authnetBody = authNetTransactionEnvelope(authnet);
      const tx = authnetBody?.transactionResponse || {};
      const ok = String(authnetBody?.messages?.resultCode || '').trim() === 'Ok' && String(tx?.responseCode || '').trim() === '1';
      if (!ok) {
        throw new Error(authNetMessage(authnetBody) || 'Authorize.Net security deposit release failed');
      }
    }

    await prisma.rentalAgreement.update({
      where: { id },
      data: {
        securityDepositReleasedAt: new Date(),
        securityDepositCaptured: false
      }
    });

    try {
      await prisma.auditLog.create({
        data: {
          tenantId: agreement.tenantId || null,
          reservationId: agreement.reservationId,
          actorUserId: actorUserId || null,
          action: 'UPDATE',
          reason: 'Security deposit released',
          metadata: JSON.stringify({ reference: rawReference || null })
        }
      });
    } catch {}

    const refreshed = await this.getById(id);
    if (!refreshed) throw new Error('Rental agreement not found after releasing security deposit');
    return refreshed;
  },

  // ── Spin (Dejavoo) operational tools ──────────────────────────────
  // These three methods power the View Payments operational panel.
  // They act on the iPOS token + deposit hold captured during the new
  // checkout-wizard-v2 sale/preauth flow. None of them touch the
  // physical terminal — they're all card-not-present operations against
  // the saved token / hold reference.
  //
  // Each posts a ReservationPayment row (with a TERMINAL gateway tag)
  // so the View Payments list reflects the new transaction immediately.
  // The pricing service's maybeCreateAgreementPayment mirror writes a
  // matching RentalAgreementPayment row, keeping the two ledgers in sync.

  async spinChargeCardOnFile(id, payload = {}, actorUserId = null) {
    const amount = Number(payload.amount || 0);
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new Error('Charge amount must be greater than 0');
    }

    const agreement = await prisma.rentalAgreement.findUnique({
      where: { id },
      include: {
        reservation: {
          select: {
            id: true, tenantId: true, reservationNumber: true,
            customer: { select: { firstName: true, lastName: true, email: true, phone: true } },
          },
        },
      },
    });
    if (!agreement) throw new Error('Rental agreement not found');
    if (!agreement.cardOnFileToken) {
      throw new Error('No card on file — complete a Spin sale at checkout first');
    }

    // Route through the iPOSpays Transact API per the docs — this is
    // the documented CNP path for tokenized sales (transactionType 1).
    // Replaces the earlier SPIn-with-Token workaround.
    const tenantConfig = await loadTenantSpinConfig(agreement.tenantId);
    const customer = agreement.reservation?.customer || {};
    const customerName = [
      agreement.customerFirstName || customer.firstName,
      agreement.customerLastName || customer.lastName,
    ].filter(Boolean).join(' ').trim();
    const response = await iposTransactClient.chargeWithToken({
      amount,
      agreementNumber: agreement.agreementNumber || agreement.id,
      cardToken: agreement.cardOnFileToken,
      customer: {
        name: customerName,
        email: agreement.customerEmail || customer.email || '',
        phone: agreement.customerPhone || customer.phone || '',
      },
      description: payload.notes || 'Card on file charge',
    }, tenantConfig);

    const norm = iposTransactClient.normalizeResponse(response);
    if (!norm.approved) {
      throw new Error(norm.errMessage || norm.message || 'iPOSpays card-on-file charge declined');
    }

    const reference = `IPOS_COF:${norm.authCode || norm.rrn || norm.referenceId}${agreement.cardOnFileLast4 ? ` ****${agreement.cardOnFileLast4}` : ''}`;
    const note = String(payload.notes || '').trim();
    const finalNote = note
      ? `Spin card-on-file charge · ${note}`
      : 'Spin card-on-file charge (CNP)';

    const created = await prisma.reservationPayment.create({
      data: {
        reservationId: agreement.reservationId,
        method: 'CARD',
        amount,
        reference,
        status: 'PAID',
        paidAt: new Date(),
        origin: 'OTC',
        gateway: 'SPIN',
        notes: finalNote
      }
    });

    // Mirror into RentalAgreementPayment + update agreement balance.
    // (Cannot reuse maybeCreateAgreementPayment — it lives in the
    // pricing service and expects a reservation include shape we don't
    // have here. Inline mirror is cheaper than another fetch.)
    try {
      const mirror = await prisma.rentalAgreementPayment.create({
        data: {
          rentalAgreementId: agreement.id,
          method: 'CARD',
          amount,
          reference,
          status: 'PAID',
          notes: finalNote
        }
      });
      await prisma.reservationPayment.update({
        where: { id: created.id },
        data: { rentalAgreementPaymentId: mirror.id }
      });
      // 2026-06-06 Option B: recompute paidAmount/balance from real (non-
      // AUTH_HOLD) payment rows instead of incrementing the stored field.
      await recomputeAgreementPaidAndBalance(prisma, agreement.id);
    } catch {}

    try {
      await prisma.auditLog.create({
        data: {
          tenantId: agreement.tenantId || null,
          reservationId: agreement.reservationId,
          actorUserId: actorUserId || null,
          action: 'UPDATE',
          reason: `Spin card-on-file charge: $${amount.toFixed(2)}`,
          metadata: JSON.stringify({ reference, refId, last4: agreement.cardOnFileLast4 || null })
        }
      });
    } catch {}

    return this.getById(id);
  },

  async spinReleaseDepositHold(id, payload = {}, actorUserId = null) {
    const agreement = await prisma.rentalAgreement.findUnique({
      where: { id },
      include: { reservation: { select: { id: true, tenantId: true, reservationNumber: true } } }
    });
    if (!agreement) throw new Error('Rental agreement not found');
    if (!agreement.depositHoldId) {
      throw new Error('No active deposit hold on file');
    }
    if (agreement.depositHoldVoidedAt) {
      throw new Error('Deposit hold has already been released');
    }

    const isManual = String(agreement.depositHoldId || '').startsWith('MANUAL-');
    const tenantConfig = await loadTenantSpinConfig(agreement.tenantId);
    let voidRef = agreement.depositHoldId;

    if (!isManual) {
      // The depositHoldId stored for Transact-issued pre-auths is the
      // RRN (the void key per Transact docs). For older SPIn-issued
      // holds it's the SPIn ReferenceId. We try Transact first since
      // that's the new documented path; on a clearly-malformed RRN we
      // could fall back to SPIn, but the typical case is one or the
      // other and the Transact path is the documented one.
      const response = await iposTransactClient.voidByRrn({
        rrn: agreement.depositHoldId,
        agreementNumber: agreement.agreementNumber || agreement.id,
      }, tenantConfig);
      const norm = iposTransactClient.normalizeResponse(response);
      if (!norm.approved) {
        throw new Error(norm.errMessage || norm.message || 'iPOSpays void declined');
      }
      voidRef = norm.rrn || norm.referenceId || agreement.depositHoldId;
    }

    await prisma.rentalAgreement.update({
      where: { id: agreement.id },
      data: {
        depositHoldVoidedAt: new Date(),
        securityDepositReleasedAt: new Date(),
        securityDepositCaptured: false
      }
    });

    const heldAmount = Number(agreement.depositHoldAmount || agreement.securityDepositAmount || 0);
    if (heldAmount > 0) {
      // Post a $0 informational row so the release appears in the
      // payments list. We use a zero amount because the original
      // pre-auth was never settled — the customer is whole.
      try {
        await prisma.reservationPayment.create({
          data: {
            reservationId: agreement.reservationId,
            method: 'OTHER',
            amount: 0,
            reference: `SPIN_RELEASE:${voidRef}`,
            status: 'PAID',
            paidAt: new Date(),
            origin: 'OTC',
            gateway: 'SPIN',
            notes: payload.reason
              ? `Released deposit hold $${heldAmount.toFixed(2)} · ${payload.reason}`
              : `Released deposit hold $${heldAmount.toFixed(2)}${isManual ? ' (manual entry)' : ''}`
          }
        });
      } catch {}
    }

    try {
      await prisma.auditLog.create({
        data: {
          tenantId: agreement.tenantId || null,
          reservationId: agreement.reservationId,
          actorUserId: actorUserId || null,
          action: 'UPDATE',
          reason: `Spin deposit hold released: $${heldAmount.toFixed(2)}`,
          metadata: JSON.stringify({
            originalHoldId: agreement.depositHoldId,
            voidRef,
            manual: isManual,
            reason: payload.reason || null
          })
        }
      });
    } catch {}

    return this.getById(id);
  },

  async spinReauthDepositHold(id, payload = {}, actorUserId = null) {
    const amount = Number(payload.amount || 0);
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new Error('Re-auth deposit amount must be greater than 0');
    }

    const agreement = await prisma.rentalAgreement.findUnique({
      where: { id },
      include: {
        reservation: {
          select: {
            id: true, tenantId: true, reservationNumber: true,
            customer: { select: { firstName: true, lastName: true, email: true, phone: true } },
          },
        },
      },
    });
    if (!agreement) throw new Error('Rental agreement not found');
    if (!agreement.cardOnFileToken) {
      throw new Error('No card on file — cannot reauthorize without a saved iPOS Token');
    }

    const tenantConfig = await loadTenantSpinConfig(agreement.tenantId);
    const customer = agreement.reservation?.customer || {};
    const customerInfo = {
      name: [
        agreement.customerFirstName || customer.firstName,
        agreement.customerLastName || customer.lastName,
      ].filter(Boolean).join(' ').trim(),
      email: agreement.customerEmail || customer.email || '',
      phone: agreement.customerPhone || customer.phone || '',
    };

    // 1. If there's an active (un-voided) hold, void it via Transact
    //    by RRN first. Doing it in two steps so a void failure doesn't
    //    kill the new auth — the agent can release manually if needed.
    let voidedOldRef = null;
    // Set ONLY when the gateway APPROVED a real void — i.e. the customer's hold
    // is genuinely gone and the merchant is uncovered until the new one lands.
    // The MANUAL- shortcut below (bookkeeping-only; no gateway hold exists) and
    // a swallowed void failure both leave this null on purpose. Kept separate
    // from `voidedOldRef`, which only feeds the human-readable note/audit text.
    let gatewayVoidedRef = null;
    if (agreement.depositHoldId && !agreement.depositHoldVoidedAt) {
      const isManual = String(agreement.depositHoldId).startsWith('MANUAL-');
      if (!isManual) {
        try {
          const voidResponse = await iposTransactClient.voidByRrn({
            rrn: agreement.depositHoldId,
            agreementNumber: agreement.agreementNumber || agreement.id,
          }, tenantConfig);
          const voidNorm = iposTransactClient.normalizeResponse(voidResponse);
          if (voidNorm.approved) {
            voidedOldRef = voidNorm.rrn || agreement.depositHoldId;
            gatewayVoidedRef = voidedOldRef;
          }
        } catch {
          // Swallow — surfaced via the new hold's audit log so the agent
          // can chase the orphan hold via the iPOSpays portal if needed.
        }
      } else {
        voidedOldRef = agreement.depositHoldId;
      }
    }

    // 2. New pre-auth via stored iPOS Token (CNP, no customer interaction).
    //
    // ⚠️ MONEY: if step 1 really voided the old hold, ANY failure here —
    // declined OR thrown (network/gateway error) — leaves the customer with no
    // hold at all. Record that truth and flag it for staff BEFORE the error
    // propagates, and let the original error through untouched so the failure
    // stays loud for the agent.
    let norm;
    try {
      const authResponse = await iposTransactClient.preAuthDeposit({
        amount,
        agreementNumber: agreement.agreementNumber || agreement.id,
        cardToken: agreement.cardOnFileToken,
        customer: customerInfo,
      }, tenantConfig);

      norm = iposTransactClient.normalizeResponse(authResponse);
      if (!norm.approved) {
        throw new Error(norm.errMessage || norm.message || 'iPOSpays re-auth declined');
      }
    } catch (err) {
      await recordDepositHoldVoidedWithoutReplacement(agreement, {
        voidedRef: gatewayVoidedRef,
        amount,
        error: err,
        actorUserId,
      });
      throw err;
    }

    // Store the RRN — Transact uses RRN as the void key.
    const newHoldId = norm.rrn || norm.referenceId;
    const reference = `IPOS_REAUTH:${norm.authCode || newHoldId}`;

    await prisma.rentalAgreement.update({
      where: { id: agreement.id },
      data: {
        depositHoldId: newHoldId,
        depositHoldAmount: amount,
        depositHoldVoidedAt: null,
        depositHoldExpiresAt: null,
        securityDepositAmount: amount,
        securityDepositCaptured: true,
        securityDepositCapturedAt: new Date(),
        securityDepositReleasedAt: null,
        securityDepositReference: reference
      }
    });

    try {
      await prisma.reservationPayment.create({
        data: {
          reservationId: agreement.reservationId,
          method: 'AUTH_HOLD',
          amount,
          reference,
          status: 'PAID',
          paidAt: new Date(),
          origin: 'OTC',
          gateway: 'SPIN',
          notes: voidedOldRef
            ? `Spin deposit re-authorized $${amount.toFixed(2)} (replaced hold ${voidedOldRef})`
            : `Spin deposit re-authorized $${amount.toFixed(2)}`
        }
      });
    } catch {}

    try {
      await prisma.auditLog.create({
        data: {
          tenantId: agreement.tenantId || null,
          reservationId: agreement.reservationId,
          actorUserId: actorUserId || null,
          action: 'UPDATE',
          reason: `Spin deposit reauthorized: $${amount.toFixed(2)}`,
          metadata: JSON.stringify({
            newHoldId,
            voidedOldRef,
            reference,
            previousHoldId: agreement.depositHoldId || null
          })
        }
      });
    } catch {}

    return this.getById(id);
  },

  async refundPayment(id, paymentId, payload = {}, actorUserId = null) {
    const agreement = await prisma.rentalAgreement.findUnique({
      where: { id },
      include: {
        reservation: {
          include: {
            customer: true
          }
        }
      }
    });
    if (!agreement) throw new Error('Rental agreement not found');

    const payment = await prisma.reservationPayment.findFirst({
      where: {
        id: paymentId,
        reservationId: agreement.reservationId
      }
    });
    if (!payment) throw new Error('Payment not found');
    if (!(Number(payment.amount || 0) > 0)) throw new Error('Only captured payments can be refunded');

    const refundAmount = Number(payload.amount || payment.amount || 0);
    if (!Number.isFinite(refundAmount) || refundAmount <= 0) throw new Error('Refund amount must be greater than 0');
    if (refundAmount - Number(payment.amount || 0) > 0.009) throw new Error('Refund amount cannot exceed the original payment');

    const priorRefunds = await prisma.reservationPayment.findMany({
      where: {
        reservationId: agreement.reservationId,
        notes: { contains: `Refund for payment ${paymentId}` }
      },
      select: {
        amount: true
      }
    });
    const alreadyRefunded = Math.abs(priorRefunds.reduce((sum, row) => sum + Number(row.amount || 0), 0));
    if (alreadyRefunded + refundAmount - Number(payment.amount || 0) > 0.009) {
      throw new Error('Refund amount exceeds the remaining refundable balance');
    }

    const rawReference = String(payment.reference || '').trim();
    if (rawReference.toUpperCase().startsWith('PAYARC:')) {
      // PayArc refund dispatch — hits POST /v1/charges/:id/void
      // first, falls through to /refunds for already-settled
      // charges. See payarc-hosted-fields.refundCharge().
      const chargeId = rawReference.slice('PAYARC:'.length).trim();
      const scope = agreement?.tenantId ? { tenantId: agreement.tenantId } : {};
      const cfg = await settingsService.getPaymentGatewayConfig(scope);
      if (!cfg?.payarc?.bearerToken) {
        throw new Error('PayArc is not configured for this tenant');
      }
      await payarcRefundCharge({
        chargeId,
        amountDollars: refundAmount,
        reason: 'requested_by_customer',
        config: cfg,
      });
    } else if (rawReference.toUpperCase().startsWith('AUTHNET:')) {
      const transId = rawReference.slice('AUTHNET:'.length).trim();
      const scope = agreement?.tenantId ? { tenantId: agreement.tenantId } : {};
      const details = await authNetTransactionDetails(transId, scope);
      const tx = details?.transaction || {};
      const txStatus = String(tx?.transactionStatus || '').trim();
      const cfg = await authNetConfig(scope);

      // 2026-06-10 — Authorize.Net's JSON API converts to XML and the XSD is
      // ORDER-SENSITIVE: transactionRequest children must follow the schema
      // sequence (transactionType, amount, payment, ..., refTransId, ...).
      // The old code seeded { transactionType, refTransId } and then appended
      // amount/payment AFTER refTransId (JS key-insertion order), so every
      // settled-transaction refund failed with E00003 ("invalid child element
      // 'amount'"). Voids never carried amount, which is why only refunds
      // broke. Build each request in schema order instead.
      let transactionRequest;
      if (txStatus === 'capturedPendingSettlement') {
        if (Math.abs(refundAmount - Number(payment.amount || 0)) > 0.009) {
          throw new Error('Pending Authorize.Net transactions can only be voided for the full amount');
        }
        transactionRequest = {
          transactionType: 'voidTransaction',
          refTransId: transId
        };
      } else {
        transactionRequest = {
          transactionType: 'refundTransaction',
          amount: refundAmount.toFixed(2),
          payment: {
            creditCard: {
              cardNumber: String(tx?.payment?.creditCard?.cardNumber || '').trim(),
              expirationDate: 'XXXX'
            }
          },
          refTransId: transId
        };
      }

      const gatewayPayload = {
        createTransactionRequest: {
          merchantAuthentication: {
            name: cfg.loginId,
            transactionKey: cfg.transactionKey
          },
          transactionRequest
        }
      };

      const authnet = await authNetRequest(gatewayPayload, scope);
      const txResp = authnet?.transactionResponse || {};
      const ok = String(authnet?.messages?.resultCode || '').trim() === 'Ok' && String(txResp?.responseCode || '').trim() === '1';
      if (!ok) {
        throw new Error(authNetMessage(authnet) || 'Authorize.Net refund failed');
      }
    }

    const refundReference = `REFUND:${paymentId}`;
    const refundPaidAt = new Date();
    const reservationRefund = await prisma.reservationPayment.create({
      data: {
        reservationId: agreement.reservationId,
        method: payment.method,
        amount: -refundAmount,
        reference: refundReference,
        status: 'PAID',
        paidAt: refundPaidAt,
        origin: payment.origin || 'OTC',
        gateway: payment.gateway || null,
        notes: `Refund for payment ${paymentId}`
      }
    });

    const agreementRefund = await prisma.rentalAgreementPayment.create({
      data: {
        rentalAgreementId: agreement.id,
        method: payment.method,
        amount: -refundAmount,
        reference: refundReference,
        status: 'PAID',
        paidAt: refundPaidAt,
        notes: `Refund for payment ${paymentId}`
      }
    });

    await prisma.reservationPayment.update({
      where: { id: reservationRefund.id },
      data: { rentalAgreementPaymentId: agreementRefund.id }
    });

    // 2026-06-06 Option B: recompute from real (non-AUTH_HOLD) payment rows;
    // the negative refund row created above is included in the sum.
    const { balance: nextBalance } = await recomputeAgreementPaidAndBalance(prisma, agreement.id);

    await prisma.auditLog.create({
      data: {
        reservationId: agreement.reservationId,
        actorUserId: actorUserId || null,
        action: 'UPDATE',
        reason: `Refund posted for payment ${paymentId}: ${refundAmount.toFixed(2)}`
      }
    });

    return {
      ok: true,
      refundedAmount: refundAmount,
      balance: nextBalance
    };
  },

  async saveInspection(id, payload = {}, actorUserId = null, actorIp = null, actorRole = 'AGENT') {
    // Perf (2026-06-05): saveInspection only needs to know WHICH phases
    // already exist (existence check) plus the agreement's scalar fields.
    // `inspections: true` was pulling the full photosJson base64 blobs for
    // every inspection on the agreement (multi-MB, multi-second query) just
    // to do that existence check. Slim select keeps behavior identical.
    const agreement = await prisma.rentalAgreement.findUnique({
      where: { id },
      include: {
        inspections: {
          select: { id: true, phase: true, capturedAt: true, actorUserId: true }
        }
      }
    });
    if (!agreement) throw new Error('Rental agreement not found');

    const phase = String(payload.phase || '').toUpperCase();
    if (!['CHECKOUT', 'CHECKIN'].includes(phase)) throw new Error('phase must be CHECKOUT or CHECKIN');
    // Sentry 371e0617 (2026-09-02): refuse impossible odometer values HERE,
    // with a message the agent can act on, instead of letting Number() carry
    // them into an INT4 ConnectorError 500 at the upsert.
    const odometerValue = parseOdometerInput(payload.odometer);
    const existingInspection = Array.isArray(agreement.inspections)
      ? agreement.inspections.find((row) => String(row?.phase || '').toUpperCase() === phase)
      : null;

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
      odometer: odometerValue,
      damages: payload.damages || null,
      notes: payload.notes || null,
      photos: payload.photos && typeof payload.photos === 'object' ? payload.photos : {}
    };

    // 16l: feature-flagged write path. When INSPECTION_PHOTOS_STORAGE_ENABLED
    // is truthy, decode the base64 photos, push them to Supabase Storage, and
    // persist only the slim refs array in `photoStorageRefs`. Legacy
    // `photosJson` is left null so the row stays small. When the flag is off
    // (default), behavior is unchanged: photos go into `photosJson` as before.
    const useStorage = inspectionPhotosStorageEnabled();
    let photoStorageRefs = null;
    if (useStorage && agreement?.tenantId) {
      // Pre-upsert so we have an inspection row id to scope the object path.
      const existingRow = await prisma.rentalAgreementInspection.upsert({
        where: { rentalAgreementId_phase: { rentalAgreementId: id, phase } },
        create: {
          rentalAgreementId: id,
          phase,
          capturedAt: inspectionBlock.at,
          actorUserId: inspectionBlock.actorUserId,
          actorIp: inspectionBlock.ip
        },
        update: { capturedAt: inspectionBlock.at }
      });
      try {
        // HARDENED (prod incident 2026-06): upload AND read-back byte-verify
        // every photo. We accept the storage path ONLY when EVERY input photo
        // uploaded AND verified. If ANY photo fails (decode/upload/verify), we
        // fall back to writing photosJson (base64) below — never lose, never
        // 500. This is the fail-safe that the lost-13-inspections incident
        // lacked.
        const result = await uploadInspectionPhotosDetailed({
          photos: inspectionBlock.photos,
          tenantId: agreement.tenantId,
          inspectionId: existingRow.id,
          downloader: inspectionDownloadObject, // mandatory read-back verify
          logger: console
        });
        const { refs, inputCount, uploadedCount, verifyFailed } = result;
        if (
          inputCount > 0 &&
          verifyFailed === 0 &&
          uploadedCount >= inputCount &&
          refs.length >= inputCount
        ) {
          // Fully migrated + verified — safe to store refs and null photosJson.
          photoStorageRefs = refs;
        } else {
          // Empty (no real photos) OR a shortfall — keep photosJson (base64).
          if (inputCount > 0) {
            try {
              console.warn(
                `[16l-live] inspection=${existingRow.id} tenant=${agreement.tenantId}: ` +
                  `not fully verified (input=${inputCount} uploaded=${uploadedCount} ` +
                  `verified=${refs.length} verifyFailed=${verifyFailed}); ` +
                  `falling back to photosJson (base64) — no data loss`
              );
            } catch { /* logging never throws */ }
          }
          photoStorageRefs = null;
        }
      } catch (err) {
        // If upload throws, fall back to legacy behavior for this save so the
        // user doesn't lose data. The next attempt will retry.
        try {
          console.warn(
            `[16l-live] inspection=${existingRow.id} upload threw: ${err?.message || err}; ` +
              `falling back to photosJson (base64)`
          );
        } catch { /* ignore */ }
        photoStorageRefs = null;
      }
    }

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
        odometer: inspectionBlock.odometer,
        damages: inspectionBlock.damages,
        notes: inspectionBlock.notes,
        photosJson: photoStorageRefs ? null : JSON.stringify(inspectionBlock.photos || {}),
        photoStorageRefs: photoStorageRefs || undefined
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
        odometer: inspectionBlock.odometer,
        damages: inspectionBlock.damages,
        notes: inspectionBlock.notes,
        photosJson: photoStorageRefs ? null : JSON.stringify(inspectionBlock.photos || {}),
        photoStorageRefs: photoStorageRefs || undefined
      }
    });

    if (phase === 'CHECKOUT' && inspectionBlock.actorUserId) {
      // 2026-07-25 (LAX #4, QA B1): the checkout inspector used to CLOBBER
      // salesOwnerUserId unconditionally — which meant an ORIGINATOR (the
      // virtual agent who created the reservation) lost their attribution
      // at the exact moment the commission sync ran. The inspector now only
      // claims ownership when nobody originated the sale; the inspector
      // still earns the counter row either way (sync keys the main row on
      // the inspection actor, not on salesOwner).
      await prisma.rentalAgreement.updateMany({
        where: { id, salesOwnerUserId: null },
        data: {
          salesOwnerUserId: inspectionBlock.actorUserId
        }
      });
      // 2026-05-26: commission is earned at CHECKOUT (not at CLOSE), so the
      // snapshot is written here regardless of agreement status. Status of
      // the AgreementCommission row itself starts at PENDING; the explicit
      // approve / mark-paid endpoints walk it forward.
      await syncAgreementCommissionSnapshot(id);
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
      include: {
        inspections: { orderBy: { createdAt: 'asc' } },
        vehicleSwaps: { orderBy: { createdAt: 'asc' } }
      }
    });
    return { report: await inspectionReportFromAgreement(refreshed) };
  },

  async inspectionReport(id) {
    const agreement = await prisma.rentalAgreement.findUnique({
      where: { id },
      include: {
        reservation: { include: { customer: true, vehicle: true } },
        inspections: { orderBy: { createdAt: 'asc' } },
        vehicleSwaps: { orderBy: { createdAt: 'asc' } }
      }
    });
    if (!agreement) throw new Error('Rental agreement not found');

    const report = await inspectionReportFromAgreement(agreement);
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
      checkinInspection: report.checkin,
      intelligence: report.intelligence,
      vehicleSwaps: report.swaps
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

    const report = await inspectionReportFromAgreement(agreement);
    if (!report?.checkout?.at || !report?.checkout?.ip || !report?.checkin?.at || !report?.checkin?.ip) {
      throw new Error('Both inspections are required before closing agreement: checkout + check-in (timestamp/IP missing)');
    }

    // Read signer name from live customer, fallback to snapshot, then payload
    const signerName = String(payload.signerName || agreement.reservation?.customer?.firstName || agreement.customerFirstName || '').trim();
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
        // LAX #4 (QA B1): an existing owner (VA originator) is never
        // clobbered at close — the checkout actor only fills a vacancy.
        salesOwnerUserId: agreement.salesOwnerUserId || report?.checkout?.actorUserId || actorUserId || null,
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
      const { renderBrandedEmail, resolveEmailBrand } = await import('../../lib/email-template.js');
      const tpl = await settingsService.getEmailTemplates({ tenantId: agreement.tenantId || null });
      const rentalCfg = await settingsService.getRentalAgreementConfig({ tenantId: agreement.tenantId || null });
      // Read from live customer, fallback to snapshot
      const closeLiveCustomer = agreement.reservation?.customer;
      const to = closeLiveCustomer?.email || agreement.customerEmail;
      if (to) {
        const render = (s = '') => String(s)
          .replaceAll('{{customerName}}', `${(closeLiveCustomer?.firstName ?? agreement.customerFirstName) || ''} ${(closeLiveCustomer?.lastName ?? agreement.customerLastName) || ''}`.trim())
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
        let closeBrand;
        try { closeBrand = await resolveEmailBrand({ tenantId: agreement.tenantId || null }); } catch { closeBrand = undefined; }

        const receiptSubject = render(tpl.returnReceiptSubject || 'Return Receipt - Reservation {{reservationNumber}}');
        const receiptInnerText = render(tpl.returnReceiptBody || 'Your agreement is now closed.');
        const receiptInnerHtml = render(tpl.returnReceiptHtml || String(tpl.returnReceiptBody || 'Your agreement is now closed.').replaceAll('\n', '<br/>'));
        const receiptRendered = renderBrandedEmail({
          brand: closeBrand,
          heading: 'Return receipt',
          bodyHtml: receiptInnerHtml,
          bodyText: receiptInnerText,
          preheader: receiptSubject,
        });
        await sendEmail({ tenantId: agreement.tenantId,
          to,
          subject: receiptSubject,
          text: receiptRendered.text,
          html: receiptRendered.html
        });

        if (String(agreement.reservation?.workflowMode || '').toUpperCase() !== 'CAR_SHARING') {
          const reviewSubject = render(tpl.rentalReviewRequestSubject || 'How Was Your Rental Experience? - Reservation {{reservationNumber}}');
          const reviewText = render(tpl.rentalReviewRequestBody || 'Thank you for renting with us.');
          const reviewHtml = render(tpl.rentalReviewRequestHtml || reviewText.replaceAll('\n', '<br/>'));
          if (String(reviewSubject || '').trim() || String(reviewText || '').trim() || String(reviewHtml || '').trim()) {
            const reviewRendered = renderBrandedEmail({
              brand: closeBrand,
              heading: 'How was your rental?',
              bodyHtml: reviewHtml,
              bodyText: reviewText,
              preheader: reviewSubject,
            });
            await sendEmail({ tenantId: agreement.tenantId,
              to,
              subject: reviewSubject,
              text: reviewRendered.text,
              html: reviewRendered.html
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

    const minAge = Number(locationConfig?.chargeAgeMin || 0);
    const maxAge = Number(locationConfig?.chargeAgeMax || 0);
    const age = ageOnDate(dateOfBirth, agreement.pickupAt);
    // 2026-07-28 AGE RULES (LAX): with enforcement on, "no DOB on file" is a
    // block, not a skip — a driver whose age can't be proven must not check
    // out. Locations without ageRulesEnforced keep the legacy skip.
    if (age === null && locationConfig?.ageRulesEnforced === true) {
      throw new Error('Customer date of birth is required before check-out can be finalized at this location.');
    }
    if (age !== null) {
      // Guard against a garbage DOB on file (e.g. an import storing year 0959 →
      // age ~1067). Give an actionable message instead of a confusing
      // "exceeds maximum age" so staff know to correct the date of birth.
      if (isImplausibleAge(age)) {
        throw new Error(`The date of birth on file is invalid (it computes to age ${age}). Please correct the customer's date of birth before checkout.`);
      }
      if (minAge > 0 && age < minAge) throw new Error(`Driver age ${age} is below minimum age ${minAge} for this location`);
      if (maxAge > 0 && age > maxAge) throw new Error(`Driver age ${age} exceeds maximum age ${maxAge} for this location`);
    }

    let balance = Number((Number(agreement.total) - paidAmount).toFixed(2));
    let creditApplied = 0;
    let creditNoteForCustomer = null;
    let nextCustomerCredit = null;
    let customerIdForCredit = null;

    // Read-only lookups outside the tx — they don't need atomicity with the
    // writes and keep the tx footprint small (Prisma's interactive tx holds
    // a connection open for its full duration).
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

        nextCustomerCredit = Number((availableCredit - creditApplied).toFixed(2));
        const note = `[CREDIT AUTO-APPLIED ${new Date().toISOString()}] -${creditApplied.toFixed(2)} to agreement ${agreement.agreementNumber}`;
        creditNoteForCustomer = customer?.notes ? `${customer.notes}\n${note}` : note;
        customerIdForCredit = reservationWithCustomer.customerId;
      }
    }

    // All the finalization writes go in one atomic transaction. Without this,
    // a failure between the agreement update and the reservation update would
    // leave the agreement marked FINALIZED but the reservation still
    // CONFIRMED — a state the UI presents as "checkout is half-done" with no
    // recovery path. The customer credit deduction is included so we never
    // debit a customer for a checkout that didn't actually finalize.
    const txCtx = {
      id,
      paymentMethod,
      payload,
      priorPaymentReference: agreement.paymentReference,
      customerFirstName,
      customerLastName,
      licenseNumber,
      dateOfBirth,
      odometerOut,
      fuelOut,
      paidAmount,
      balance,
      hasExplicitPaidAmount,
      creditApplied,
      customerIdForCredit,
      nextCustomerCredit,
      creditNoteForCustomer,
      // Mileage history (2026-06-09): provenance for the CHECKOUT odometer entry.
      vehicleId: agreement.vehicleId,
      tenantId: agreement.tenantId ?? null,
      reservationNumber: agreement.reservation?.reservationNumber || null,
      actorUserId: payload.actorUserId || null
    };
    let updated;
    await prisma.$transaction(async (tx) => {
      updated = await applyFinalizeWritesTx(tx, txCtx);
    }, { timeout: 10000 });

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
  },

  // ===================== Rental Agreement Addendum (BUG-001) =====================
  // Addendum flow: when reservation dates change post-signature, a new addendum
  // row captures the modified dates + its own signature lifecycle. The parent
  // agreement stays immutable (the legal record of what was originally signed).

  async createAddendum(rentalAgreementId, {
    newPickupAt,
    newReturnAt,
    reason = 'Date correction',
    reasonCategory = 'admin_correction',
    initiatedBy = null,
    initiatedByRole = 'ADMIN'
  } = {}) {
    if (!rentalAgreementId) throw new Error('rentalAgreementId is required');
    if (!newPickupAt || !newReturnAt) throw new Error('newPickupAt and newReturnAt are required');

    const agreement = await prisma.rentalAgreement.findUnique({
      where: { id: rentalAgreementId },
      include: {
        charges: true,
        reservation: {
          select: { id: true, pickupAt: true, returnAt: true, originalReturnAt: true, tenantId: true }
        }
      }
    });
    if (!agreement) throw new Error('Rental agreement not found');

    // Interpret naive "2026-08-07T19:00" values as wall-clock time in the
    // TENANT's timezone rather than the server's (which is UTC). Strings that
    // already carry a Z or an offset pass through untouched, so this is inert
    // for today's callers — it exists so a naive value can never be read as
    // UTC the way the extension path was (Hector, 2026-08-07).
    const addendumTz = await resolveTenantTimeZone(agreement.reservation?.tenantId || agreement.tenantId);
    newPickupAt = parseDateTimeInTz(newPickupAt, addendumTz) || new Date(newPickupAt);
    newReturnAt = parseDateTimeInTz(newReturnAt, addendumTz) || new Date(newReturnAt);

    // Snapshot original charges at time of addendum creation.
    const originalCharges = (agreement.charges || []).map((c) => ({
      id: c.id,
      description: c.description,
      amount: c.amount?.toString?.() ?? String(c.amount ?? ''),
      category: c.category ?? null
    }));

    // TODO (Commit 2b / Phase 2): recalculate charges via reservationPricingService
    // for the new [newPickupAt, newReturnAt] window. For MVP, admin is expected
    // to reconcile charges out-of-band; newCharges stays empty.
    const newCharges = [];
    const chargeDelta = { added: [], removed: [], modified: [] };

    // Issue a customer-portal signature token at creation time. The token is
    // embedded in the customer notification email and consumed (set to null)
    // after a successful signature submission via the public signing flow at
    // /api/public/addendum-signature/{token}.
    //
    // 24 random bytes → 32 url-safe base64 characters; collision probability
    // is negligible. The @unique index on signatureToken is belt-and-suspenders.
    const signatureToken = crypto.randomBytes(24).toString('base64url');
    const signatureTokenExpiresAt = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000); // 14 days

    const newPickupDate = new Date(newPickupAt);
    const newReturnDate = new Date(newReturnAt);

    // Wrap addendum-create + reservation-date sync in one transaction so we
    // never end up with an addendum recorded but the reservation operating on
    // the old dates (the wedge that bit RES-850355 on prod 2026-05-01:
    // planner / dashboard / billing kept showing 5/5 even after the agent had
    // executed the date change). The agreement document stays immutable as
    // the legal record of what was originally signed; the addendum row is
    // the legal record of the change; the reservation reflects the change
    // operationally so the rest of the system (planner availability, charges,
    // notifications) operates on the accepted dates.
    //
    // Skipped for the unified-extend path: that flow lives in
    // extendReservation() which updates Reservation.returnAt at extend-time
    // and stores the addendum's pickupAt = oldReturnAt for deleteExtension's
    // recovery. createAddendum is the manual-admin path; mirroring that
    // codepath here would corrupt extend-flow rows.
    return prisma.$transaction(async (tx) => {
      const created = await tx.rentalAgreementAddendum.create({
        data: {
          rentalAgreementId,
          tenantId: agreement.tenantId,
          pickupAt: newPickupDate,
          returnAt: newReturnDate,
          reason: String(reason).trim(),
          reasonCategory: String(reasonCategory).trim(),
          initiatedBy: initiatedBy ? String(initiatedBy).trim() : null,
          initiatedByRole: String(initiatedByRole).trim(),
          status: 'PENDING_SIGNATURE',
          signatureToken,
          signatureTokenExpiresAt,
          originalCharges: JSON.stringify(originalCharges),
          newCharges: JSON.stringify(newCharges),
          chargeDelta: JSON.stringify(chargeDelta)
        }
      });

      const reservation = agreement.reservation;
      if (reservation?.id) {
        const updateData = {
          pickupAt: newPickupDate,
          returnAt: newReturnDate
        };
        // Preserve the FIRST original returnAt — never overwrite. Mirrors
        // extendReservation's behavior so deleteExtension and voidAddendum
        // both have a recovery anchor even after a chain of changes.
        if (!reservation.originalReturnAt) {
          updateData.originalReturnAt = reservation.returnAt;
        }
        await tx.reservation.update({
          where: { id: reservation.id },
          data: updateData
        });
      }

      return created;
    });
  },

  async signAddendum(addendumId, { signatureDataUrl, signatureSignedBy, ip } = {}) {
    if (!addendumId) throw new Error('addendumId is required');
    const dataUrl = String(signatureDataUrl || '').trim();
    if (!dataUrl) throw new Error('Signature is required');

    const addendum = await prisma.rentalAgreementAddendum.findUnique({ where: { id: addendumId } });
    if (!addendum) throw new Error('Addendum not found');
    if (addendum.status !== 'PENDING_SIGNATURE') {
      throw new Error(`Cannot sign addendum with status ${addendum.status}`);
    }

    return prisma.rentalAgreementAddendum.update({
      where: { id: addendumId },
      data: {
        status: 'SIGNED',
        signatureSignedBy: String(signatureSignedBy || 'Unknown').trim(),
        signatureDataUrl: dataUrl,
        signatureSignedAt: new Date(),
        signatureIp: String(ip || '-').trim()
      }
    });
  },

  async listAddendums(rentalAgreementId, scope = {}) {
    if (!rentalAgreementId) throw new Error('rentalAgreementId is required');
    return prisma.rentalAgreementAddendum.findMany({
      where: {
        rentalAgreementId,
        ...(scope?.tenantId ? { tenantId: scope.tenantId } : {})
      },
      orderBy: { createdAt: 'desc' }
    });
  },

  async getAddendumById(addendumId, scope = {}) {
    if (!addendumId) throw new Error('addendumId is required');
    return prisma.rentalAgreementAddendum.findFirst({
      where: {
        id: addendumId,
        ...(scope?.tenantId ? { tenantId: scope.tenantId } : {})
      }
    });
  },

  async voidAddendum(addendumId, reason = 'Cancelled', scope = {}) {
    if (!addendumId) throw new Error('addendumId is required');
    const existing = await this.getAddendumById(addendumId, scope);
    if (!existing) throw new Error('Addendum not found');

    // Wrap the status flip + reservation date revert in a single transaction
    // so the operating system never observes a window where the addendum is
    // VOID but the reservation still carries the addendum's date.
    //
    // Manual-addendum path only. The unified-extend flow uses deleteExtension
    // for its recovery — it owns charge revert + addendum void + returnAt
    // restoration as one operation, and we must not double-revert here.
    // `extensionChargeId IS NOT NULL` is the discriminator (set by
    // extendReservation, never set by createAddendum).
    return prisma.$transaction(async (tx) => {
      const voided = await tx.rentalAgreementAddendum.update({
        where: { id: addendumId },
        data: { status: 'VOID' }
      });

      if (existing.extensionChargeId) return voided;

      const agreement = await tx.rentalAgreement.findUnique({
        where: { id: existing.rentalAgreementId },
        select: { id: true, reservationId: true }
      });
      if (!agreement?.reservationId) return voided;

      // Only revert if no other PENDING_SIGNATURE / SIGNED addendums of
      // ANY kind (manual OR extend-flow) exist on this agreement. If
      // there's still an active chain, the latest one's dates are the
      // operating dates — voiding an earlier entry must not retroactively
      // undo a still-active later change. Mixing extend-flow and manual
      // addendums on the same agreement is rare but possible; safest to
      // bail out of revert and let the admin reconcile, rather than risk
      // overwriting an extend's returnAt with the agreement's pre-extend
      // originalReturnAt.
      const otherActive = await tx.rentalAgreementAddendum.count({
        where: {
          rentalAgreementId: existing.rentalAgreementId,
          id: { not: addendumId },
          status: { in: ['PENDING_SIGNATURE', 'SIGNED'] }
        }
      });
      if (otherActive > 0) return voided;

      const reservation = await tx.reservation.findUnique({
        where: { id: agreement.reservationId },
        select: { id: true, originalReturnAt: true, returnAt: true }
      });
      if (reservation?.originalReturnAt) {
        await tx.reservation.update({
          where: { id: reservation.id },
          data: {
            returnAt: reservation.originalReturnAt,
            originalReturnAt: null
          }
        });
      }

      return voided;
    });
  },

  /**
   * Standalone print of a single addendum. Reuses the agreement-modern.html
   * chrome (head/style/body wrapper) and the same `buildAddendumPageHtml`
   * helper that the combined agreement+addendum print uses, so a standalone
   * View/Print of an addendum looks visually identical to the addendum pages
   * embedded in the parent agreement print. Same dark theme, same tile/section/
   * signature components, same print-mode overrides.
   */
  async renderAddendumHtml(addendumId) {
    if (!addendumId) throw new Error('addendumId is required');

    const addendum = await prisma.rentalAgreementAddendum.findUnique({
      where: { id: addendumId },
      include: {
        rentalAgreement: {
          select: {
            id: true,
            agreementNumber: true,
            customerFirstName: true,
            customerLastName: true,
            tenantId: true
          }
        }
      }
    });
    if (!addendum) throw new Error('Addendum not found');

    // Compute the addendum's ordinal in its parent agreement's series so the
    // "Addendum X of N" header is consistent with the combined print.
    const siblings = await prisma.rentalAgreementAddendum.findMany({
      where: { rentalAgreementId: addendum.rentalAgreementId },
      orderBy: { createdAt: 'asc' },
      select: { id: true }
    });
    const total = siblings.length || 1;
    const idx = Math.max(1, siblings.findIndex((s) => s.id === addendumId) + 1);

    const scope = addendum.rentalAgreement?.tenantId ? { tenantId: addendum.rentalAgreement.tenantId } : {};
    const cfg = await settingsService.getRentalAgreementConfig(scope);
    const companyLogoBlock = buildCompanyLogoBlock(
      cfg?.companyName || '',
      cfg?.companyLogoUrl || ''
    );

    const ctx = {
      agreement: addendum.rentalAgreement,
      cfg,
      companyLogoBlock
    };

    const shellVars = {
      // The shell template references these placeholders inside <head> and
      // the print-mode overrides, so we feed them through even though we
      // immediately replace the body with addendum-specific content.
      agreementNumber: esc(addendum.rentalAgreement?.agreementNumber || ''),
      companyName: esc(cfg?.companyName || ''),
      companyLogoBlock,
      companyAddress: esc(cfg?.companyAddress || ''),
      companyPhone: esc(cfg?.companyPhone || ''),
      reservationNumber: '-'
    };

    const { head, foot } = getModernShell(shellVars);
    const body = buildAddendumPageHtml(addendum, idx, total, ctx);
    return `${head}\n${body}\n${foot}`;
  }
};


