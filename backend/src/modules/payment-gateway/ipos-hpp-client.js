import { prisma } from '../../lib/prisma.js';
import logger from '../../lib/logger.js';
import { decryptSettingSecret } from '../../lib/setting-secret-crypto.js';
import { maskTpn } from './tenant-terminal-config.js';

/**
 * iPOSpays Hosted Payment Page (HPP) client.
 *
 * Docs: https://docs.ipospays.com/hosted-payment-page/apidocs
 *       (sandbox variant: https://uatdocs.ipospays.tech/hosted-payment-page/apidocs)
 *
 * This is the THIRD Dejavoo API surface in this repo, and the first one that
 * serves a CUSTOMER-facing page:
 *
 *   • SPIn API     (spin-client.js)          → physical terminal, card-present.
 *   • Transact API (ipos-transact-client.js) → cloud CNP with a stored iPOS token.
 *   • HPP API      (this file)               → Dejavoo-hosted CARD ENTRY page.
 *     We mint a URL, the customer types their card on ipospays.com, Dejavoo
 *     redirects back, and we verify server-side with queryPaymentStatus.
 *
 * WHY IT EXISTS (2026-08-29): customer payment links must settle into the
 * TENANT's merchant account. International Rental Corp transacts through iPOS;
 * their payment links were opening Ride's Authorize.Net hosted page — the
 * wrong-merchant problem, again. When a tenant's gateway is 'ipos', links now
 * open the tenant's own iPOSpays HPP.
 *
 * ─── Contract (from the docs, captured 2026-08-29) ────────────────────────
 * getHostedPaymentPage:
 *   POST {host}/api/v1/external-payment-transaction
 *   headers: { token: <ecom auth token>, Content-Type: application/json }
 *   body: {
 *     merchantAuthentication: { merchantId: <TPN, 12 digits>,
 *                               transactionReferenceId: <alnum ≤20, unique> },
 *     transactionRequest: { transactionType: 1 (SALE),
 *                           amount: "<cents>",     // $100.00 → "10000"
 *                           calculateFee, calculateTax, tipsInputPrompt,
 *                           expiry: <days 1–31> },
 *     notificationOption: { notifyBySMS, notifyByPOST, notifyByRedirect,
 *                           returnUrl, failureUrl, cancelUrl },
 *     preferences: { integrationType: 1 (E-Commerce), avsVerification,
 *                    eReceipt, eReceiptInputPrompt, requestCardToken, ... },
 *     personalization: { merchantName, description, ... }   // optional
 *   }
 *   success → { message: "URL generated successfully", information: "<url>" }
 *   failure → { errors: [{ field, message }] }
 *
 * queryPaymentStatus:
 *   GET {apiHost}/v1/queryPaymentStatus?tpn=<TPN>&transactionReferenceId=<ref>
 *   headers: { token: <ecom auth token> }
 *   → { iposHPResponse: { responseCode (200 approved / 400 declined /
 *       401 cancelled / 402 rejected), transactionId, transactionReferenceId,
 *       amount, tips, customFee, localTax, stateTax, totalAmount,
 *       cardType, cardLast4Digit, responseApprovalCode, rrn, ... } }
 *
 * The redirect back to returnUrl is NEVER trusted: recording only happens
 * after a server-side queryPaymentStatus round trip (see
 * ipos-hpp-payment.service.js).
 *
 * ─── Config: THE ONE HOME, and NO env fallback ─────────────────────────────
 * Same AppSetting row the terminal resolver reads —
 * `tenant:<id>:paymentGatewayConfig` — new `ipos` block:
 *
 *   { ipos: { enabled, environment ('production'|'sandbox'),
 *             tpn,              // CloudPOS TPN; falls back to spin.tpn
 *             hppToken,         // ecom auth token — `enci:` ciphertext at rest
 *             expiryDays } }    // hosted-link expiry, 1–31, default 3
 *
 * There is DELIBERATELY no env fallback here (unlike the SPIn terminal): the
 * platform env credentials belong to Ride's merchant accounts, and pairing a
 * tenant payment link with a platform credential is exactly the wrong-merchant
 * settlement this module exists to end. Unconfigured resolves to NONE and the
 * caller fails closed with an operator-facing message — never a silent
 * Authorize.Net fallback.
 */

const HPP_ENDPOINTS = {
  // TWO credentials, one per endpoint — learned live on the owner's first real
  // payment (2026-08-29, $1.12 charged at iPOSpays and stuck unrecordable):
  //   - the MINT authenticates with the ecom token in a `token` header;
  //   - queryPaymentStatus authenticates with the merchant API KEY in the
  //     `Authorization` header. Sending it the token is the 401 we shipped.
  // A detour through POST /iposTransactStatus (Transaction Status Check API)
  // got 400 — that API belongs to Transact, not HPP. The HPP's own GET below
  // is the documented contract (uatdocs.ipospays.tech/hosted-payment-page).
  production: {
    hpp: 'https://payment.ipospays.com/api/v1/external-payment-transaction',
    query: 'https://api.ipospays.com/v1/queryPaymentStatus',
  },
  sandbox: {
    hpp: 'https://payment.ipospays.tech/api/v1/external-payment-transaction',
    query: 'https://api.ipospays.tech/v1/queryPaymentStatus',
  },
};

/** Dry-run flag. Shares SPIN_DRY_RUN so dev mode stays a single toggle. */
export function isHppDryRun() {
  return String(process.env.IPOS_HPP_DRY_RUN || '').toLowerCase() === 'true'
    || String(process.env.SPIN_DRY_RUN || '').toLowerCase() === 'true';
}

export function hppEndpoints(resolved = {}) {
  const env = String(resolved?.environment || 'production').toLowerCase();
  return env === 'sandbox' ? HPP_ENDPOINTS.sandbox : HPP_ENDPOINTS.production;
}

function toCents(amountDollars) {
  const num = Number(amountDollars);
  if (!Number.isFinite(num) || num <= 0) {
    throw new Error('amount must be a positive finite number');
  }
  return String(Math.round(num * 100));
}

function clampExpiryDays(raw, fallback = 3) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(31, Math.max(1, Math.round(n)));
}

/**
 * A customer name iPOSpays will accept, or null to omit the field.
 *
 * HPP rejects the ENTIRE mint — "preferences.customerName - Invalid Customer
 * Name" — over characters this market's names are made of. Héctor, José,
 * Muñoz: found on the first live link (2026-08-29), whose customer was the
 * owner himself. So: strip diacritics via NFD (é→e, ñ→n), drop everything
 * that is not an ASCII letter or a space (O'Brien → OBrien, hyphens close
 * up), collapse whitespace, cap at 25 like the Transact client. If nothing
 * survives — a name written entirely in another script — return null and
 * send no name at all: the field is optional, and a missing courtesy label
 * must never cost a customer the ability to pay.
 */
export function hppSafeCustomerName(raw) {
  const cleaned = String(raw ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z ]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 25)
    .trim();
  return cleaned || null;
}

/** Digits only for customerMobile, or null to omit — same defensive posture. */
export function hppSafeMobile(raw) {
  const digits = String(raw ?? '').replace(/[^0-9]/g, '');
  return digits.length >= 10 ? digits.slice(-10) : null;
}

const HPP_AUTH_ENDPOINTS = {
  production: 'https://auth.ipospays.com/v1/authenticate-token',
  sandbox: 'https://auth.ipospays.tech/v1/authenticate-token',
};

/**
 * API Key + Secret Key → short-lived JWT (the Authentication Token API).
 *
 * Scope `ExternalApi` — the HPP is iPOSpays' "external payment" product and
 * this is the only listed scope that fits it. If iPOSpays ever rejects the
 * scope, their error names the valid ones and lands in the log, scrubbed.
 * The JWT and the secret never appear in any log line.
 */
export async function mintHppAuthJwt(resolved = {}, deps = {}, { scope = null } = {}) {
  const env = String(resolved?.environment || 'production').toLowerCase();
  const url = env === 'sandbox' ? HPP_AUTH_ENDPOINTS.sandbox : HPP_AUTH_ENDPOINTS.production;
  // Credentials go in the HEADERS — ipos-auth.js learned this for Transact
  // (body-only returns AUTH_ERR_001 "API Key is required"), and a live probe
  // on 2026-08-30 confirmed it here.
  //
  // DEFAULT IS SCOPELESS, and that is the finding: HPP's own generateAuthToken
  // spec (docs.ipospays.com/hosted-payment-page/api-docs/generateAuthToken)
  // declares exactly three headers — apiKey, secretKey, TokenExpiryMinutes —
  // and NO scope. The scoped tokens minted the Transact way (scope +
  // jwtTokenExpiryMinutes) authenticate fine but are then 401'd by
  // queryPaymentStatus in every header spelling. A scope is only sent when a
  // caller asks for one, Transact-style, as the probe's fallback.
  const fields = {
    apiKey: resolved.apiKey,
    secretKey: resolved.secretKey,
    ...(scope
      ? { scope, jwtTokenExpiryMinutes: 30 }
      : { TokenExpiryMinutes: 30 }),
  };
  const { res, data } = await hppFetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, String(v)])),
    },
    body: JSON.stringify(scope ? fields : {}),
  }, deps);
  const token = String(data?.token || '').trim();
  if (!res.ok || !token) {
    const err = new Error(
      `iPOSpays auth token request failed (${res.status}): ${String(data?.responseMessage || data?.message || 'no token returned').slice(0, 120)}`,
    );
    err.code = 'GATEWAY_ERROR';
    throw err;
  }
  return token;
}

/**
 * transactionReferenceId: strictly alphanumeric, ≤20 chars (same 904 FORMAT
 * ERROR history as the Transact client's shortRef — hyphens are echoed to the
 * processor host and rejected). `PL` = payment link.
 *
 * In dry-run the reference ENCODES the amount (`DRY<cents>X<rand>`) so the
 * synthetic queryPaymentStatus can echo a coherent total back without any
 * server-side state — the whole flow is exercisable with zero credentials.
 */
export function hppReferenceId(seed = '', { dryRun = isHppDryRun(), amount = 0 } = {}) {
  if (dryRun) {
    const cents = String(Math.round(Number(amount || 0) * 100)).replace(/[^0-9]/g, '') || '0';
    const rand = Math.random().toString(36).replace(/[^a-z0-9]/gi, '');
    return `DRY${cents}X${rand}`.slice(0, 20);
  }
  const head = `PL${String(seed || 'NA')}`.replace(/[^A-Za-z0-9]/g, '').slice(0, 12);
  const tail = Date.now().toString(36).replace(/[^a-z0-9]/gi, '')
    + Math.random().toString(36).slice(2);
  return `${head}${tail}`.replace(/[^A-Za-z0-9]/g, '').slice(0, 20);
}

export function isValidHppReferenceId(value = '') {
  return /^[A-Za-z0-9]{1,20}$/.test(String(value || ''));
}

/**
 * Resolve a tenant's HPP configuration from the canonical AppSetting row.
 * NEVER throws — a missing row, dead DB, bad JSON or failed decrypt all
 * degrade to `{ source: 'NONE' }`, which callers turn into an explicit
 * fail-closed refusal. There is NO env fallback here on purpose (see header).
 */
export async function resolveTenantHppConfig(tenantId, { prismaClient = prisma } = {}) {
  const none = (reason) => ({
    source: 'NONE', reason,
    tenantId: tenantId || null,
    environment: 'production', tpn: '', hppToken: '', apiKey: '', secretKey: '', expiryDays: 3,
    enabled: false, maskedTpn: maskTpn(''),
  });
  if (!tenantId) return none('NO_TENANT_ID');

  let parsed = null;
  try {
    const row = await prismaClient.appSetting.findUnique({
      where: { key: `tenant:${tenantId}:paymentGatewayConfig` },
    });
    parsed = row?.value ? JSON.parse(row.value) : null;
  } catch (err) {
    logger.warn('[ipos-hpp] could not read tenant payment config — treating as unconfigured', {
      tenantId, err: String(err?.message || err),
    });
    return none('READ_FAILED');
  }
  if (!parsed) return none('NO_CONFIG');

  const block = parsed?.ipos && typeof parsed.ipos === 'object' ? parsed.ipos : {};
  // The HPP is tied to a CloudPOS TPN; when the operator leaves ipos.tpn blank
  // we fall back to the tenant's OWN spin.tpn (same tenant, same merchant —
  // never a platform value).
  const tpn = String(block.tpn || parsed?.spin?.tpn || '').trim();
  // Dual-read decrypt: `enci:` ciphertext decrypts, legacy plaintext passes
  // through, an undecryptable value collapses to '' (never raw bytes).
  const hppToken = String(decryptSettingSecret(block.hppToken) || '').trim();
  // The status-check credentials (exchanged for a JWT). Optional for the MINT
  // — a tenant without them can still issue links; verification refuses loudly.
  const apiKey = String(decryptSettingSecret(block.apiKey) || '').trim();
  const secretKey = String(decryptSettingSecret(block.secretKey) || '').trim();

  if (!tpn || !hppToken) {
    return {
      ...none(!tpn && !hppToken ? 'NOT_CONFIGURED' : 'INCOMPLETE_CONFIG'),
      environment: String(block.environment || 'production').toLowerCase(),
      maskedTpn: maskTpn(tpn),
    };
  }

  return {
    source: 'TENANT',
    reason: 'TENANT_CONFIG',
    tenantId,
    environment: String(block.environment || 'production').toLowerCase() === 'sandbox' ? 'sandbox' : 'production',
    tpn,
    hppToken,
    apiKey,
    secretKey,
    expiryDays: clampExpiryDays(block.expiryDays, 3),
    // Informational — resolution does not route on the checkbox (same rule as
    // the terminal resolver: an unchecked box must never reroute money).
    enabled: !!block.enabled,
    maskedTpn: maskTpn(tpn),
  };
}

export function hppConfigured(resolved = {}) {
  return resolved?.source === 'TENANT' && !!resolved?.tpn && !!resolved?.hppToken;
}

async function hppFetch(url, options, { fetchImpl = fetch, timeoutMs = 30000 } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetchImpl(url, { ...options, signal: controller.signal });
  } catch (err) {
    clearTimeout(timeout);
    if (err?.name === 'AbortError') {
      const e = new Error(`iPOSpays HPP request timed out after ${Math.round(timeoutMs / 1000)}s`);
      e.iposHppTimeout = true;
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

/**
 * Mint a hosted payment page URL.
 *
 * @returns {Promise<{ url: string, transactionReferenceId: string }>}
 * Throws a coded error (`GATEWAY_ERROR`) on refusal. NEVER logs the auth
 * token, the minted URL's token parameter, or any card data.
 */
export async function mintHostedPaymentPage({
  amount,
  transactionReferenceId,
  returnUrl,
  cancelUrl,
  failureUrl,
  customer = {},
  merchantName = '',
  description = '',
}, resolved = {}, deps = {}) {
  if (!transactionReferenceId || !isValidHppReferenceId(transactionReferenceId)) {
    throw new Error('transactionReferenceId must be 1–20 alphanumeric characters');
  }
  if (!returnUrl) throw new Error('returnUrl is required');

  if (isHppDryRun()) {
    logger.info(`[ipos-hpp] DRY-RUN mint ref=${transactionReferenceId}`);
    const base = hppEndpoints({ environment: 'sandbox' }).hpp.replace('/api/v1/external-payment-transaction', '');
    return {
      url: `${base}/api/v1/externalPay?t=dry-run&ref=${encodeURIComponent(transactionReferenceId)}`,
      transactionReferenceId,
    };
  }
  if (!hppConfigured(resolved)) {
    const err = new Error('iPOSpays HPP is not configured for this tenant');
    err.code = 'GATEWAY_NOT_CONFIGURED';
    throw err;
  }

  const body = {
    merchantAuthentication: {
      merchantId: String(resolved.tpn),
      transactionReferenceId,
    },
    transactionRequest: {
      transactionType: 1, // SALE
      amount: toCents(amount),
      // The link is for an EXACT balance we computed — no gateway-side
      // add-ons. STEAM fees/taxes and tip prompts are all off.
      calculateFee: false,
      calculateTax: false,
      tipsInputPrompt: false,
      expiry: clampExpiryDays(resolved.expiryDays, 3),
    },
    notificationOption: {
      notifyBySMS: false,
      notifyByPOST: false,
      notifyByRedirect: true,
      returnUrl: String(returnUrl),
      // A failed/declined attempt must not land on the success return URL —
      // point it at the cancel surface when the caller gave one.
      failureUrl: String(failureUrl || cancelUrl || returnUrl),
      ...(cancelUrl ? { cancelUrl: String(cancelUrl) } : {}),
    },
    preferences: {
      integrationType: 1, // E-Commerce
      avsVerification: false,
      eReceipt: false,
      eReceiptInputPrompt: false,
      requestCardToken: false,
      // Sanitized, and OMITTED rather than sent when nothing survives: the
      // customer fields are optional, and iPOSpays rejects the whole mint over
      // an "Invalid Customer Name" — found live 2026-08-29 on the very first
      // production link, whose customer was named Héctor. The é was the whole
      // problem; in this market that is not an edge case, it is the customer
      // base. Their page shows "Hector" — an accent traded for a working link.
      ...(hppSafeCustomerName(customer?.name)
        ? { customerName: hppSafeCustomerName(customer.name) }
        : {}),
      ...(customer?.email ? { customerEmail: String(customer.email) } : {}),
      ...(hppSafeMobile(customer?.phone)
        ? { customerMobile: hppSafeMobile(customer.phone) }
        : {}),
    },
    ...(merchantName || description
      ? {
          personalization: {
            ...(merchantName ? { merchantName: String(merchantName).slice(0, 35) } : {}),
            ...(description ? { description: String(description).slice(0, 150) } : {}),
          },
        }
      : {}),
  };

  const { res, data } = await hppFetch(hppEndpoints(resolved).hpp, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', token: resolved.hppToken },
    body: JSON.stringify(body),
  }, deps);

  if (Array.isArray(data?.errors) && data.errors.length) {
    const first = data.errors[0];
    const err = new Error(`iPOSpays HPP validation error: ${first?.field || ''} - ${first?.message || 'invalid request'}`);
    err.code = 'GATEWAY_ERROR';
    err.iposHppErrors = data.errors;
    throw err;
  }

  const url = String(data?.information || '').trim();
  if (!res.ok || !/^https:\/\//i.test(url)) {
    logger.warn('[ipos-hpp] mint refused', {
      status: res.status,
      maskedTpn: resolved.maskedTpn,
      message: String(data?.message || '').slice(0, 120),
    });
    const err = new Error(String(data?.message || `iPOSpays HPP URL creation failed (${res.status})`));
    err.code = 'GATEWAY_ERROR';
    throw err;
  }

  logger.info('[ipos-hpp] hosted page minted', {
    maskedTpn: resolved.maskedTpn,
    ref: transactionReferenceId,
    host: (() => { try { return new URL(url).host; } catch { return ''; } })(),
  });
  return { url, transactionReferenceId };
}

/**
 * Normalize a queryPaymentStatus payload. Accepts both `iposHPResponse` (docs)
 * and `iposhpresponse` (the live-API casing the Transact client already had to
 * learn about the hard way, 2026-06-03).
 */
export function normalizeHppStatus(data = {}) {
  // Envelope hunt: the documented wrappers first; failing those, if the body
  // itself carries status-shaped fields, treat IT as the record (a live 200 on
  // 2026-08-30 normalized to "code unknown", which means production answers
  // in a shape none of the documented wrappers cover).
  const bare = (data && typeof data === 'object'
    && ('responseCode' in data || 'transactionId' in data || 'totalAmount' in data))
    ? data : null;
  const r = data?.iposHPResponse || data?.iposhpresponse || data?.iposTransactResponse || bare || {};
  const responseCode = Number(r?.responseCode);
  const amount = Number(r?.totalAmount ?? r?.amount ?? 0);
  return {
    found: Object.keys(r || {}).length > 0,
    approved: responseCode === 200,
    responseCode: Number.isFinite(responseCode) ? responseCode : 0,
    responseMessage: String(r?.responseMessage || ''),
    errCode: String(r?.errResponseCode || ''),
    errMessage: String(r?.errResponseMessage || ''),
    transactionReferenceId: String(r?.transactionReferenceId || ''),
    transactionId: String(r?.transactionId || ''),
    approvalCode: String(r?.responseApprovalCode || r?.approvalCode || ''),
    rrn: String(r?.rrn || r?.RRN || ''),
    cardType: String(r?.cardType || ''),
    cardLast4: String(r?.cardLast4Digit || ''),
    amount: Number.isFinite(amount) ? Number(amount.toFixed(2)) : 0,
  };
}

/**
 * Query the authoritative payment status for a minted reference. This is the
 * ONLY basis for recording an HPP payment — the browser redirect is UX.
 */
export async function queryHppPaymentStatus({ transactionReferenceId }, resolved = {}, deps = {}) {
  const ref = String(transactionReferenceId || '').trim();
  if (!isValidHppReferenceId(ref)) {
    throw new Error('transactionReferenceId must be 1–20 alphanumeric characters');
  }

  if (isHppDryRun() && ref.startsWith('DRY')) {
    // Echo the amount encoded in the dry-run reference (see hppReferenceId).
    const cents = Number((ref.match(/^DRY(\d+)X/) || [])[1] || 0);
    return normalizeHppStatus({
      iposHPResponse: {
        responseCode: 200,
        responseMessage: 'Successful (DryRun)',
        transactionReferenceId: ref,
        transactionId: `dry-hpp-${ref}`,
        totalAmount: cents / 100,
        amount: cents / 100,
        cardType: 'VISA',
        cardLast4Digit: '0000',
        responseApprovalCode: 'DRYRUN',
      },
    });
  }
  if (!hppConfigured(resolved)) {
    const err = new Error('iPOSpays HPP is not configured for this tenant');
    err.code = 'GATEWAY_NOT_CONFIGURED';
    throw err;
  }

  if (!resolved.apiKey || !resolved.secretKey) {
    // Verification is what stands between a browser redirect and a recorded
    // payment; without the credentials it must refuse loudly, not guess.
    const err = new Error(
      'iPOSpays status checks need the Merchant API Key AND Secret Key — Settings → Payments → iPOS Payment Links',
    );
    err.code = 'GATEWAY_NOT_CONFIGURED';
    throw err;
  }

  // Exchange API Key + Secret Key for a short-lived JWT. Probed live
  // 2026-08-30: the status API 401s the ecom token AND the raw API key in
  // every header spelling — only the authenticate-token JWT is accepted.
  // Minted per status check on purpose: checks are rare (one per payment
  // confirmation), the API's minimum expiry is 30 minutes, and statelessness
  // beats a cache for a call this infrequent.
  //
  // Neither the header NAME nor the required SCOPE is documented, so this is
  // a self-resolving probe: three header spellings per scope, two scopes,
  // stopping at the first non-401 and LOGGING the winner (header + scope) so
  // the matrix can be collapsed to one line once reality has spoken. Worst
  // case is six short requests, once, on a path exercised one time per
  // payment confirmation.
  const url = `${hppEndpoints(resolved).query}?tpn=${encodeURIComponent(resolved.tpn)}&transactionReferenceId=${encodeURIComponent(ref)}`;
  // The two doc sources CONTRADICT each other: the official
  // queryPaymentStatus page says `Authorization: <the token generated in the
  // ipospays portal>` — which reads as the per-TPN ECOM token — while the
  // API-explorer material says a generateAuthToken JWT in a bare `token`
  // header. The probe walks both stories, ecom-token-in-Authorization first
  // (the one spelling never yet tried live), and logs the winner so this
  // collapses to one line once production has spoken.
  let res; let data;
  let accepted = null;
  for (const attempt of [
    { label: 'ecom-authorization', headers: { Authorization: resolved.hppToken } },
    { label: 'ecom-bearer', headers: { Authorization: `Bearer ${resolved.hppToken}` } },
  ]) {
    ({ res, data } = await hppFetch(url, { method: 'GET', headers: attempt.headers }, deps));
    if (res.status !== 401) { accepted = attempt.label; break; }
  }
  if (!accepted) {
    outer:
    for (const scope of [null, 'ExternalApi']) {
      const jwt = await mintHppAuthJwt(resolved, deps, { scope });
      for (const headers of [
        { token: jwt },
        { Authorization: `Bearer ${jwt}` },
        { Authorization: jwt },
      ]) {
        ({ res, data } = await hppFetch(url, { method: 'GET', headers }, deps));
        if (res.status !== 401) {
          accepted = `jwt-${Object.keys(headers)[0]}${String(headers.Authorization || '').startsWith('Bearer ') ? '-bearer' : ''}-scope-${scope || 'none'}`;
          break outer;
        }
      }
    }
  }
  if (accepted) logger.info('[ipos-hpp] status auth accepted', { via: accepted });

  // Envelope discovery: when a 2xx answer still cannot be read, log its SHAPE
  // — top-level key names and one nested level, never a value — so the real
  // production envelope can be mapped from the log instead of guessed.
  // Values stay out deliberately: this response can carry card metadata.
  if (res?.ok) {
    const early = normalizeHppStatus(data);
    if (!early.found || (!early.approved && early.responseCode === 0)) {
      const shape = Object.fromEntries(
        Object.entries(data && typeof data === 'object' ? data : {})
          .map(([k, v]) => [k, v && typeof v === 'object' ? Object.keys(v) : typeof v]),
      );
      logger.warn('[ipos-hpp] unmapped status envelope', { keys: shape });
    }
  }

  const status = normalizeHppStatus(data);
  if (!res.ok && !status.found) {
    const err = new Error(String(data?.message || `iPOSpays payment status lookup failed (${res.status})`));
    err.code = 'GATEWAY_ERROR';
    throw err;
  }
  return status;
}

export const iposHppClient = {
  isHppDryRun,
  hppEndpoints,
  hppReferenceId,
  isValidHppReferenceId,
  resolveTenantHppConfig,
  hppConfigured,
  mintHostedPaymentPage,
  queryHppPaymentStatus,
  normalizeHppStatus,
};
