import logger from '../../lib/logger.js';
import { getAuthToken, invalidateCache as invalidateAuthCache, hasAutoRefresh, hasStaticToken } from './ipos-auth.js';

/**
 * iPOSpays Transact REST API client.
 *
 * Docs: https://docs.ipospays.com/ipos-transact/apidocs
 *
 * This is the SECOND of two Dejavoo APIs we use. The split:
 *
 *   • SPIn API  (spin-client.js)  → drives the physical Dejavoo terminal.
 *     Used for the initial card-present SALE in checkout-wizard-v2 step 3.
 *     The sale response includes an iPOS Token that represents the
 *     customer's card.
 *
 *   • Transact API (this file)    → cloud CNP using that iPOS Token.
 *     Used for:
 *       1. Deposit hold (PreAuth) using cardToken — no second card tap.
 *       2. Card-on-file charges from View Payments (toll, damage, etc.).
 *       3. Voiding the deposit hold to release it.
 *
 * Per the docs: "A Card Token (also called an iPOS Token) ... can be
 * obtained from: SPIn API ... Once generated, this token can be used to
 * perform tokenized transactions in the Transact API for future Sale
 * or Pre-Authorizations."
 *
 * Architecture chosen 2026-05-29 after auditing the Dejavoo docs;
 * replaces the earlier (undocumented) SPIn-with-Token workaround.
 *
 * ─── Auth ─────────────────────────────────────────────────────────────
 * Header: { token: "<JWT auth token>" }
 *
 * For V1/V2 endpoints the auth token is generated manually from the
 * iPOSpays portal (Settings → Generate Ecom/TOP Merchant Keys → Copy
 * Token). It's valid for 24h with a 30-min grace period.
 *
 * For V3 the token is generated from apiKey + secretKey via the
 * Authentication Token API. Not implemented in this client yet — for
 * tonight's launch we use a static token from env. Auto-refresh is a
 * follow-up.
 *
 * ─── Amounts ──────────────────────────────────────────────────────────
 * Amounts are sent as STRINGS in CENTS. $500.00 → "50000". We accept
 * a JavaScript number for the public API and convert internally.
 *
 * ─── Success detection ────────────────────────────────────────────────
 * Response success is `iposTransactResponse.responseCode === 200` (a
 * number; the docs use "200 - Successful, 400 - Declined"). Different
 * from SPIn's GeneralResponse.StatusCode === "0000" success signal —
 * the two clients are kept separate so the shapes don't bleed.
 */

// Endpoint matrix — V1/V2/V3 all support the full operation set; the
// only difference is V3 supports encrypted card data and API-based
// token generation (vs portal-generated tokens). The auth-token JWT
// carries a "version" claim that pins which endpoint accepts it, so
// we read IPOS_TRANSACT_VERSION (default v2 since that's what Hector's
// portal-generated token uses).
const TRANSACT_ENDPOINTS = {
  v1: 'https://payment.ipospays.com/api/v1/iposTransact',
  v2: 'https://payment.ipospays.com/api/v2/iposTransact',
  v3: 'https://payment.ipospays.com/api/v3/iposTransact',
};

function resolveEndpoint(tenantConfig = {}) {
  const v = String(
    tenantConfig.iposTransactVersion
      || process.env.IPOS_TRANSACT_VERSION
      || 'v2',
  ).toLowerCase();
  return TRANSACT_ENDPOINTS[v] || TRANSACT_ENDPOINTS.v2;
}

// V3 endpoint when auto-refresh is active. Auto-refresh uses the
// V3 Authentication Token API which mints tokens scoped to V3
// (PaymentTokenization scope → V3 iposTransact). Static-token mode
// keeps the user-configured version.
function resolveEndpointForMode(tenantConfig = {}) {
  if (hasAutoRefresh(tenantConfig) && !hasStaticToken(tenantConfig)) {
    return TRANSACT_ENDPOINTS.v3;
  }
  return resolveEndpoint(tenantConfig);
}

function getConfig(tenantConfig = {}) {
  return {
    baseUrl: resolveEndpointForMode(tenantConfig),
    // merchantId is the TPN (same TPN registered with SPIn).
    merchantId: tenantConfig.iposTransactMerchantId
      || tenantConfig.spinTpn
      || process.env.IPOS_TRANSACT_MERCHANT_ID
      || process.env.SPIN_TPN
      || '',
    clientTimeoutMs: Number(
      tenantConfig.iposTransactClientTimeoutMs
        || process.env.IPOS_TRANSACT_CLIENT_TIMEOUT_MS
        || 30000,
    ),
    // Auto Rental flag — when true we send Level 3 / VISA CEDP data
    // with PurchaseIdFormatCode "3" (Auto Rental Agreement Number) on
    // every sale + pre-auth. Qualifies for better interchange.
    autoRental: tenantConfig.iposTransactAutoRental !== false
      && String(process.env.IPOS_TRANSACT_AUTO_RENTAL || 'true').toLowerCase() !== 'false',
  };
}

function isDryRun(tenantConfig = {}) {
  // Share the SPIN_DRY_RUN flag so dev mode is a single toggle.
  return tenantConfig.iposTransactDryRun === true
    || String(process.env.SPIN_DRY_RUN || '').toLowerCase() === 'true'
    || String(process.env.IPOS_TRANSACT_DRY_RUN || '').toLowerCase() === 'true';
}

function syntheticResponse(transactionType, payload) {
  const txRefId = payload?.merchantAuthentication?.transactionReferenceId
    || `dry-${Date.now()}`;
  return {
    iposTransactResponse: {
      responseCode: 200,
      responseMessage: 'Successful (DryRun)',
      errResponseCode: '00',
      errResponseMessage: 'Approval',
      transactionReferenceId: txRefId,
      transactionType,
      amount: Number(payload?.transactionRequest?.amount || 0) / 100,
      responseApprovalCode: `DR${Math.floor(Math.random() * 900000 + 100000)}`,
      RRN: String(Date.now()).slice(-12),
      transactionId: `dry-tx-${txRefId}`,
      approvalCode: 'TAS-DRY',
    },
  };
}

function toCents(amountDollars) {
  const num = Number(amountDollars);
  if (!Number.isFinite(num)) throw new Error('amount must be a finite number');
  return String(Math.round(num * 100));
}

function shortRef(prefix, agreementNumber, ts = Date.now()) {
  // transactionReferenceId is capped at 20 chars per the spec.
  const head = `${prefix}-${agreementNumber || 'NA'}`.slice(0, 12);
  const tail = ts.toString(36).slice(-7);
  return `${head}-${tail}`.slice(0, 20);
}

// Errors that mean "the auth token is invalid — get a fresh one and
// retry". These come back from the V3 Transact API when the token
// expired between cache-lookup and request-send, or was rotated
// out-of-band in the portal.
const TOKEN_INVALID_CODES = new Set(['AUTH_ERR_006', 'AUTH_ERR_007', 'AUTH_ERR_008']);

function looksLikeTokenInvalidError(data) {
  const code = String(data?.errorCode || '').trim();
  if (TOKEN_INVALID_CODES.has(code)) return true;
  const msg = String(data?.errorMessage || data?.responseMessage || '').toLowerCase();
  return /invalid token|invalid signature|unauthor/i.test(msg);
}

async function performTransactCall({ token, config, body }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.clientTimeoutMs);
  let res;
  try {
    res = await fetch(config.baseUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        token,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timeout);
    if (err?.name === 'AbortError') {
      const msg = `iPOSpays Transact request timed out after ${Math.round(config.clientTimeoutMs / 1000)}s`;
      logger.warn(msg);
      const e = new Error(msg);
      e.iposTransactTimeout = true;
      throw e;
    }
    throw err;
  }
  clearTimeout(timeout);

  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  return { res, data };
}

async function transactRequest(transactionType, payload, tenantConfig = {}) {
  if (isDryRun(tenantConfig)) {
    logger.info(`Transact API DRY-RUN tt=${transactionType}`);
    return syntheticResponse(transactionType, payload);
  }
  const config = getConfig(tenantConfig);
  if (!config.merchantId) throw new Error('iPOSpays Transact merchantId (TPN) is not configured');

  // Inject the TPN as merchantId so callers don't have to remember.
  const body = {
    ...payload,
    merchantAuthentication: {
      ...payload.merchantAuthentication,
      merchantId: String(config.merchantId),
    },
  };

  // Resolve a fresh-enough token. Throws a clear error if neither
  // static-token nor auto-refresh credentials are configured.
  let token = await getAuthToken(tenantConfig);

  // First attempt.
  let { res, data } = await performTransactCall({ token, config, body });

  // Token-invalid mid-request → bust the cache, mint a new one, retry
  // ONCE. Only meaningful in auto-refresh mode (static-token mode has
  // no way to "get a new one" so the retry would loop pointlessly).
  if (looksLikeTokenInvalidError(data) && hasAutoRefresh(tenantConfig) && !hasStaticToken(tenantConfig)) {
    logger.warn('[ipos-transact] auth token rejected mid-request — invalidating cache and retrying once');
    invalidateAuthCache();
    token = await getAuthToken(tenantConfig);
    ({ res, data } = await performTransactCall({ token, config, body }));
  }

  // Validation-style error response (the docs show this shape too)
  if (Array.isArray(data?.errors) && data.errors.length) {
    const firstErr = data.errors[0];
    const msg = `iPOSpays Transact validation error: ${firstErr?.field || ''} - ${firstErr?.message || 'invalid request'}`;
    logger.warn(msg, { errors: data.errors });
    const err = new Error(msg);
    err.iposTransactValidation = true;
    err.iposTransactResponse = data;
    throw err;
  }

  // Grace-period header signal — fire-and-forget warn; auto-refresh
  // mode will catch this on the next cache check, but logging it
  // surfaces the rotation event in our boot logs.
  if (res.headers.get('AuthenticationRefreshRequired') === 'true') {
    logger.warn('[ipos-transact] AuthenticationRefreshRequired=true — auto-refresh will rotate the token on next call.');
    if (hasAutoRefresh(tenantConfig) && !hasStaticToken(tenantConfig)) {
      invalidateAuthCache();
    }
  }

  const txResp = data?.iposTransactResponse || {};
  const responseCode = Number(txResp.responseCode);
  const isApproved = responseCode === 200;

  if (!isApproved) {
    const msg = txResp.errResponseMessage
      || txResp.responseMessage
      || `iPOSpays Transact request failed (responseCode=${responseCode || res.status})`;
    logger.warn('iPOSpays Transact decline', {
      responseCode, errResponseCode: txResp.errResponseCode, errResponseMessage: txResp.errResponseMessage,
    });
    const err = new Error(msg);
    err.iposTransactResponseCode = responseCode;
    err.iposTransactResponse = data;
    throw err;
  }

  return data;
}

/**
 * Build the Auto Rental Level-3 / VISA CEDP block for a charge.
 * PurchaseIdFormatCode "3" = Auto Rental Agreement Number per the spec —
 * the right value for car rental and unlocks better interchange rates.
 */
function autoRentalL3Data({ amount, agreementNumber, description, today = new Date() }) {
  const isoDate = today.toISOString().slice(0, 10);
  return {
    L3Data: {
      Header: {
        TaxAmount: 0,
        LocalTaxFlag: 0,
        NationalTaxAmount: 0,
        TotalDiscountAmount: 0,
        FreightAmount: 0,
        DutyAmount: 0,
        LineItemCount: 1,
        PurchaseIdentifier: String(agreementNumber || '').slice(0, 25),
        PurchaseIdFormatCode: '3',
        OrderDate: isoDate,
      },
      items: [{
        Description: String(description || 'Vehicle rental').slice(0, 35),
        Quantity: 1,
        UnitOfMeasure: 'EA',
        UnitCost: Number(Number(amount).toFixed(2)),
        TaxAmount: 0,
        TaxRate: 0,
        DiscountAmount: 0,
        ExtLineAmount: Number(Number(amount).toFixed(2)),
        // 2026-06-03 — we originally sent the STRING 'N' per the iPOSpays field
        // table (String, Optional, N/Y), but Dejavoo support flagged it as "not
        // a valid attribute" — their validator apparently expects the BOOLEAN
        // form shown in their sample payload ("NetGrossIndicator": false).
        // false = amount does not include tax (the 'N' equivalent; correct for
        // US merchants per their docs). Their L3 validation can hard-fail
        // transactions (l2l3Flag "E"), so the string form may have contributed
        // to DEJ_ERR_003 on tokenized PreAuth/Sale. Support is reviewing the
        // docs discrepancy; if boolean still fails, remove the field entirely.
        NetGrossIndicator: false,
        TaxIndicator: 0,
      }],
    },
  };
}

export const iposTransactClient = {
  /**
   * PreAuth using a stored cardToken (iPOS Token from a prior SPIn
   * sale). This is the documented path for the security-deposit hold.
   *
   * transactionType: 5 (PreAuth using token) per docs.
   *
   * Customer info (name/email/phone) is optional but recommended for
   * the iPOSpays Transactions portal so support staff can identify
   * the hold. eReceipt is false — we own the receipt UX in our PDF.
   */
  async preAuthDeposit({
    amount, agreementNumber, cardToken, customer, autoRental,
  }, tenantConfig = {}) {
    if (!cardToken) throw new Error('preAuthDeposit requires cardToken');
    const cfg = getConfig(tenantConfig);
    const includeL3 = autoRental !== false && cfg.autoRental;
    const body = {
      merchantAuthentication: {
        merchantId: '',  // injected in transactRequest
        transactionReferenceId: shortRef('DEP', agreementNumber),
      },
      transactionRequest: {
        transactionType: 5,
        amount: toCents(amount),
        cardToken: String(cardToken),
        applySteamSettingTipFeeTax: false,
      },
      preferences: {
        eReceipt: false,
        ...(customer?.name ? { customerName: String(customer.name).slice(0, 25) } : {}),
        ...(customer?.email ? { customerEmail: String(customer.email) } : {}),
        ...(customer?.phone ? { customerMobile: String(customer.phone) } : {}),
      },
      ...(includeL3 ? autoRentalL3Data({
        amount, agreementNumber, description: 'Security deposit hold',
      }) : {}),
    };
    return transactRequest(5, body, tenantConfig);
  },

  /**
   * Sale using a stored cardToken (CNP charge on saved card). Powers
   * the "Charge Card on File" button in View Payments — used for tolls,
   * damage, late fees, etc.
   *
   * transactionType: 1 (Sale using token) per docs.
   */
  async chargeWithToken({
    amount, agreementNumber, cardToken, customer, autoRental, description,
  }, tenantConfig = {}) {
    if (!cardToken) throw new Error('chargeWithToken requires cardToken');
    const cfg = getConfig(tenantConfig);
    const includeL3 = autoRental !== false && cfg.autoRental;
    const body = {
      merchantAuthentication: {
        merchantId: '',
        transactionReferenceId: shortRef('COF', agreementNumber),
      },
      transactionRequest: {
        transactionType: 1,
        amount: toCents(amount),
        cardToken: String(cardToken),
        applySteamSettingTipFeeTax: false,
      },
      preferences: {
        eReceipt: false,
        ...(customer?.name ? { customerName: String(customer.name).slice(0, 25) } : {}),
        ...(customer?.email ? { customerEmail: String(customer.email) } : {}),
        ...(customer?.phone ? { customerMobile: String(customer.phone) } : {}),
        requestCardToken: false,
      },
      ...(includeL3 ? autoRentalL3Data({
        amount, agreementNumber, description: description || 'Card on file charge',
      }) : {}),
    };
    return transactRequest(1, body, tenantConfig);
  },

  /**
   * Void a prior Transact transaction by its RRN (Retrieval Reference
   * Number) returned in the original PreAuth or Sale response.
   *
   * Per docs ("For Void / Refund Transactions"): "Simply pass the
   * original transaction's RRN in the request".
   *
   * transactionType: 2 (Void) per response spec.
   */
  async voidByRrn({ rrn, agreementNumber }, tenantConfig = {}) {
    if (!rrn) throw new Error('voidByRrn requires rrn');
    const body = {
      merchantAuthentication: {
        merchantId: '',
        transactionReferenceId: shortRef('VOID', agreementNumber),
      },
      transactionRequest: {
        transactionType: 2,
        amount: '0',
        RRN: String(rrn),
        applySteamSettingTipFeeTax: false,
      },
      preferences: { eReceipt: false },
    };
    return transactRequest(2, body, tenantConfig);
  },

  /**
   * Normalize a Transact response into the same shape rest of the
   * code uses for Spin responses. Lets the existing UI / payment
   * persistence stay unchanged.
   */
  normalizeResponse(transactResponse) {
    const r = transactResponse?.iposTransactResponse || {};
    return {
      approved: Number(r.responseCode) === 200,
      responseCode: Number(r.responseCode) || 0,
      message: r.responseMessage || '',
      errCode: r.errResponseCode || '',
      errMessage: r.errResponseMessage || '',
      authCode: r.responseApprovalCode || r.approvalCode || '',
      referenceId: r.transactionReferenceId || '',
      transactionId: r.transactionId || '',
      rrn: r.RRN || r.rrn || '',
      amount: Number(r.amount || r.totalAmount || 0),
    };
  },
};

// Boot-time audit so misconfig surfaces in logs rather than at the
// first card tap. Mirrors auditSpinConfig().
let auditLogged = false;
export function auditIposTransactConfig() {
  if (auditLogged) return;
  auditLogged = true;
  const cfg = getConfig();
  const dry = isDryRun();
  if (dry) {
    logger.warn('[ipos-transact] DRY-RUN active — calls return synthetic approvals.');
  }
  const autoRefresh = hasAutoRefresh();
  const staticToken = hasStaticToken();
  if (!autoRefresh && !staticToken) {
    logger.warn('[ipos-transact] No auth credentials configured', {
      hint: 'Set IPOS_TRANSACT_AUTH_TOKEN (static) OR IPOS_TRANSACT_API_KEY + IPOS_TRANSACT_SECRET_KEY (auto-refresh).',
    });
  }
  if (!cfg.merchantId) {
    logger.warn('[ipos-transact] merchantId (TPN) missing', {
      hint: 'Set IPOS_TRANSACT_MERCHANT_ID (defaults to SPIN_TPN).',
    });
  } else if (autoRefresh || staticToken) {
    logger.info('[ipos-transact] Transact API ready', {
      endpoint: cfg.baseUrl,
      merchantId: cfg.merchantId.slice(0, 4) + '****' + cfg.merchantId.slice(-4),
      authMode: autoRefresh && !staticToken ? 'AUTO_REFRESH (V3)' : 'STATIC_TOKEN',
      autoRental: cfg.autoRental,
      clientTimeoutMs: cfg.clientTimeoutMs,
    });
  }
}
