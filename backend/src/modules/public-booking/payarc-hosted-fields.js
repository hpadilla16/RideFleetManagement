import crypto from 'node:crypto';

/**
 * PayArc payment helpers — pure (no DB, no settings import) so the
 * unit tests can exercise them standalone.
 *
 * Architecture: PayArc does NOT offer an Accept-Hosted-style full-page
 * redirect checkout like Authorize.Net. Instead they give us:
 *   1. `payarc.js` Hosted Fields (card form embedded via iframe)
 *   2. `POST /v1/charges` server-side with the token the iframe returns
 *
 * For the Flutter mobile WebView flow we wrap PayArc in the same
 * gateway-agnostic contract we use for Authorize.Net: our backend
 * SERVES an HTML page at /trips/:code/payarc-bridge that embeds
 * payarc.js. The WebView loads that page, the user pays, our inline
 * JS tokenizes + POSTs the token to /trips/:code/payarc-charge, the
 * server creates the charge via this module, and on success redirects
 * the WebView to successMatchUrl. Flutter doesn't know any of this —
 * it just watches for the match URL.
 *
 * Amount unit: CENTS (unlike Authorize.Net's decimal dollars). The
 * public gateway contract still surfaces decimals; we convert at the
 * boundary in createCharge().
 *
 * TODO(payarc-dashboard): verify the exact payarc.js CDN URL and
 * webhook signature format once Hector has dashboard access at
 * https://docs.payarc.net. Current assumptions are annotated inline.
 */

// Accept Hosted mirror — 15 min for consistency with the Auth.Net flow.
// The bridge-HTML signed nonce enforces this window; PayArc itself
// issues single-use tokens via payarc.js that expire with the page.
export const PAYARC_SESSION_TTL_MS = 15 * 60 * 1000;

export const PAYABLE_STATUSES = new Set(['PENDING', 'PARTIAL']);

// Default CDN URL for payarc.js. TODO(payarc-dashboard): confirm this
// is current. The Spreedly gateway guide mentions secure.payarc.net;
// other integrations reference cdn.payarc.net. If neither is live,
// switch to whatever the docs specify — it's a single-line change.
export const PAYARC_JS_URL = 'https://secure.payarc.net/payarc.js';

export function payarcApiUrl(config = {}) {
  const env = String(config?.payarc?.environment || 'sandbox').toLowerCase();
  return env === 'production'
    ? 'https://api.payarc.net/v1'
    : 'https://testapi.payarc.net/v1';
}

export function payarcEnabled(config = {}) {
  return !!(
    config?.payarc?.enabled !== false &&
    config?.payarc?.bearerToken &&
    config?.payarc?.publicKey
  );
}

/**
 * Product rule: PR pickups ALWAYS route to Authorize.Net, regardless
 * of PayArc enablement. US pickups use PayArc when enabled, fall back
 * to Authorize.Net otherwise. Anything else (missing location,
 * unrecognized country) falls through to Authorize.Net as the
 * safe default.
 *
 * @param {object} reservation  Must have been loaded with pickupLocation included
 * @param {object} config       Tenant payment gateway config
 * @returns {'authorizenet' | 'payarc'}
 */
export function selectPaymentGateway(reservation, config = {}) {
  const country = reservation?.pickupLocation?.country;
  const normalized = String(country || '').trim().toLowerCase();
  // Puerto Rico always → Authorize.Net (product decision 2026-04-21).
  // Match on the full country name because seed locations use
  // "Puerto Rico" as the string, not ISO code. Also defend against
  // "puerto rico", "puerto-rico" typos.
  if (normalized.startsWith('puerto rico') || normalized === 'pr') {
    return 'authorizenet';
  }
  // US mainland: PayArc if the tenant has it configured.
  const isUS =
    normalized === 'usa' ||
    normalized === 'us' ||
    normalized === 'united states' ||
    normalized === 'united states of america';
  if (isUS && payarcEnabled(config)) {
    return 'payarc';
  }
  // Anything else (or US without PayArc configured) stays on Auth.Net.
  return 'authorizenet';
}

// ─── Amount + payability (mirrors authnet-accept-hosted) ──────────────────

export function paidFromPayments(payments = []) {
  if (!Array.isArray(payments)) return 0;
  return payments.reduce((acc, p) => {
    if (!p || p.voided || p.refunded) return acc;
    const amt = Number(p.amount || 0);
    return acc + (Number.isFinite(amt) ? amt : 0);
  }, 0);
}

export function computeAmountDue(reservation) {
  const estimated = Number(reservation?.estimatedTotal || 0);
  const paid = paidFromPayments(reservation?.payments);
  return Math.max(0, Number((estimated - paid).toFixed(2)));
}

export function dollarsToCents(dollars) {
  return Math.round(Number(dollars || 0) * 100);
}

// ─── Signed nonce for the bridge HTML ────────────────────────────────────

/**
 * HMAC-signed token that authorizes a WebView to load the PayArc
 * bridge HTML for a specific trip + amount. Prevents random traffic
 * from minting charge forms. Format:
 *   base64url(payload).<hex-hmac>
 * Payload fields: tripCode, reservationId, amountCents, issuedAt.
 */
export function signBridgeNonce({
  tripCode,
  reservationId,
  amountCents,
  secret,
  issuedAt = Date.now(),
}) {
  const payload = JSON.stringify({
    t: tripCode,
    r: reservationId,
    a: amountCents,
    i: issuedAt,
  });
  const payloadB64 = Buffer.from(payload, 'utf8').toString('base64url');
  const sig = crypto
    .createHmac('sha256', secret)
    .update(payloadB64)
    .digest('hex');
  return `${payloadB64}.${sig}`;
}

export function verifyBridgeNonce(token, secret, { maxAgeMs = PAYARC_SESSION_TTL_MS } = {}) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const [payloadB64, sig] = token.split('.');
  if (!payloadB64 || !sig) return null;
  const expected = crypto
    .createHmac('sha256', secret)
    .update(payloadB64)
    .digest('hex');
  // Timing-safe compare
  const a = Buffer.from(sig, 'hex');
  const b = Buffer.from(expected, 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const age = Date.now() - Number(parsed.i || 0);
  if (!Number.isFinite(age) || age < 0 || age > maxAgeMs) return null;
  return {
    tripCode: parsed.t,
    reservationId: parsed.r,
    amountCents: parsed.a,
    issuedAt: parsed.i,
  };
}

// ─── Charges API ─────────────────────────────────────────────────────────

/**
 * Call POST /v1/charges with a Hosted-Fields-issued token. Amount is
 * passed in dollars — we convert to cents at the boundary.
 *
 * @returns {Promise<{ok: boolean, chargeId: string, status: string, raw: object}>}
 */
export async function createCharge({
  tokenId,
  amountDollars,
  currency = 'usd',
  description,
  reservationNumber,
  config,
  deps = {},
} = {}) {
  if (!tokenId) {
    const err = new Error('tokenId is required');
    err.code = 'VALIDATION';
    throw err;
  }
  if (!amountDollars || amountDollars <= 0) {
    const err = new Error('amount must be > 0');
    err.code = 'VALIDATION';
    throw err;
  }
  if (!config?.payarc?.bearerToken) {
    const err = new Error('PayArc bearerToken missing');
    err.code = 'GATEWAY_NOT_CONFIGURED';
    throw err;
  }

  const body = {
    amount: dollarsToCents(amountDollars),
    currency: String(currency || 'usd').toLowerCase(),
    source: { token_id: tokenId },
    // Description is our matchback handle — the webhook uses it to
    // find the reservation without a DB round-trip through metadata.
    description: String(description || `Reservation ${reservationNumber || ''}`)
      .trim()
      .slice(0, 255),
  };

  const fetchImpl = deps.fetchImpl || fetch;
  const url = `${payarcApiUrl(config)}/charges`;
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.payarc.bearerToken}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  const raw = await response.text();
  let parsed = {};
  try {
    parsed = raw ? JSON.parse(raw) : {};
  } catch {
    parsed = { raw };
  }

  // PayArc wraps its primary payload under `data` (per their SDK).
  const data = parsed?.data || parsed;
  const chargeId = data?.id || data?.charge_id || '';
  const status = String(data?.status || '').toLowerCase();
  const successful = data?.successful === true;

  // Success semantics from the API docs:
  //   status: 'submitted_for_settlement' | 'succeeded' | 'authorized'
  //   successful: true (on ACH)
  const isSuccess =
    response.ok &&
    !!chargeId &&
    (successful ||
      status === 'submitted_for_settlement' ||
      status === 'succeeded' ||
      status === 'authorized');

  if (!isSuccess) {
    const { code, message } = extractPayArcError(parsed, response.status);
    const err = new Error(message);
    err.code = code;
    err.gateway = 'payarc';
    err.gatewayStatus = response.status;
    err.raw = parsed;
    throw err;
  }

  return {
    ok: true,
    chargeId: String(chargeId),
    status,
    amount: Number(data?.amount || body.amount) / 100,
    currency: String(data?.currency || body.currency).toUpperCase(),
    raw: parsed,
  };
}

/**
 * Refund a previously captured PayArc charge. Tries to route the
 * request correctly based on settlement state: `/void` before
 * settlement (same day), `/refunds` after.
 */
export async function refundCharge({
  chargeId,
  amountDollars,
  reason,
  config,
  preferVoid = true,
  deps = {},
} = {}) {
  if (!chargeId) {
    const err = new Error('chargeId is required');
    err.code = 'VALIDATION';
    throw err;
  }
  if (!config?.payarc?.bearerToken) {
    const err = new Error('PayArc bearerToken missing');
    err.code = 'GATEWAY_NOT_CONFIGURED';
    throw err;
  }

  const fetchImpl = deps.fetchImpl || fetch;
  const apiBase = payarcApiUrl(config);
  const headers = {
    Authorization: `Bearer ${config.payarc.bearerToken}`,
    Accept: 'application/json',
    'Content-Type': 'application/json',
  };

  // Try void first when preferVoid is set. If PayArc returns a 4xx
  // indicating the charge is already settled, fall through to refund.
  if (preferVoid) {
    const voidRes = await fetchImpl(`${apiBase}/charges/${encodeURIComponent(chargeId)}/void`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ reason: reason || 'requested_by_customer' }),
    });
    if (voidRes.ok) {
      const txt = await voidRes.text();
      let body = {};
      try { body = txt ? JSON.parse(txt) : {}; } catch {}
      return { ok: true, kind: 'void', raw: body };
    }
    // Fall through to refund on any non-2xx — /refunds handles
    // already-settled charges.
  }

  const body = {
    reason: reason || 'requested_by_customer',
  };
  if (amountDollars && amountDollars > 0) {
    body.amount = dollarsToCents(amountDollars);
  }
  const refundRes = await fetchImpl(`${apiBase}/charges/${encodeURIComponent(chargeId)}/refunds`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  const raw = await refundRes.text();
  let parsed = {};
  try { parsed = raw ? JSON.parse(raw) : {}; } catch { parsed = { raw }; }
  if (!refundRes.ok) {
    const { code, message } = extractPayArcError(parsed, refundRes.status);
    const err = new Error(message);
    err.code = code;
    err.gateway = 'payarc';
    err.gatewayStatus = refundRes.status;
    err.raw = parsed;
    throw err;
  }
  return { ok: true, kind: 'refund', raw: parsed };
}

// ─── Error mapping ───────────────────────────────────────────────────────

/**
 * Translate PayArc's error payload into a stable {code, message}
 * pair the Flutter PaymentError state can surface to the user.
 */
export function extractPayArcError(responseBody = {}, httpStatus = 400) {
  // PayArc's error shape varies. Common locations:
  //   { code: '...', message: '...' }
  //   { error: { code, message } }
  //   { errors: [ { code, message } ] }
  //   { data: { error_code, error_message } }
  const candidates = [
    responseBody,
    responseBody?.error,
    Array.isArray(responseBody?.errors) ? responseBody.errors[0] : null,
    responseBody?.data,
  ].filter(Boolean);
  let code = '';
  let message = '';
  for (const c of candidates) {
    code = code || c?.code || c?.error_code || '';
    message = message || c?.message || c?.error_message || '';
    if (code && message) break;
  }

  const normalizedCode = String(code || '').toLowerCase();
  if (normalizedCode.includes('card_declined') || normalizedCode === 'declined') {
    return {
      code: 'CARD_DECLINED',
      message: message || 'Your card was declined. Please try another payment method.',
    };
  }
  if (normalizedCode.includes('expired')) {
    return {
      code: 'CARD_EXPIRED',
      message: message || 'Your card has expired. Please use another card.',
    };
  }
  if (normalizedCode.includes('invalid_cvc') || normalizedCode.includes('cvc')) {
    return {
      code: 'CARD_INVALID_CVC',
      message: message || 'Invalid security code. Please check and try again.',
    };
  }
  if (httpStatus === 401 || normalizedCode.includes('unauthorized')) {
    return {
      code: 'GATEWAY_NOT_CONFIGURED',
      message: 'Payment service authentication failed.',
    };
  }
  if (httpStatus >= 500) {
    return {
      code: 'GATEWAY_ERROR',
      message: message || 'Our payment partner returned an error. Please try again.',
    };
  }
  return {
    code: 'GATEWAY_ERROR',
    message: message || 'Payment failed. Please try again.',
  };
}

// ─── Webhook validation ──────────────────────────────────────────────────

/**
 * Verify an inbound webhook payload came from PayArc.
 *
 * TODO(payarc-dashboard): confirm the exact header name PayArc uses for
 * the HMAC. Common conventions are:
 *   - `X-Payarc-Signature: sha256=<hex>`
 *   - `Authorization: Bearer <webhookSecret>`
 * Until we can read docs.payarc.net/reference/add-webhooks from the
 * sandbox, we support BOTH: HMAC-SHA256 over the raw body using
 * `webhookSecret`, OR a Bearer token equal to `webhookSecret`. This
 * lets Hector flip which one we accept when the real spec is known
 * by deleting the branch that doesn't apply.
 */
export function verifyWebhookSignature({
  rawBody,
  headers = {},
  webhookSecret,
}) {
  if (!webhookSecret) return false;

  // Normalize header keys — express exposes lowercased names, but
  // direct callers may not.
  const lc = {};
  for (const [k, v] of Object.entries(headers)) {
    lc[String(k).toLowerCase()] = String(v);
  }

  // Path 1 — Bearer token (simplest interpretation of the docs).
  const auth = lc['authorization'] || '';
  if (auth.toLowerCase().startsWith('bearer ')) {
    const token = auth.slice(7).trim();
    if (token && safeEq(token, webhookSecret)) return true;
  }

  // Path 2 — HMAC-SHA256 hex digest in a payarc-flavored header.
  const sigHeader =
    lc['x-payarc-signature'] ||
    lc['payarc-signature'] ||
    lc['x-webhook-signature'] ||
    '';
  if (sigHeader) {
    const provided = String(sigHeader).replace(/^sha256=/i, '').trim();
    const bodyBuf = Buffer.isBuffer(rawBody)
      ? rawBody
      : Buffer.from(String(rawBody || ''), 'utf8');
    const expected = crypto
      .createHmac('sha256', webhookSecret)
      .update(bodyBuf)
      .digest('hex');
    const a = Buffer.from(provided, 'hex');
    const b = Buffer.from(expected, 'hex');
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) return true;
  }

  return false;
}

function safeEq(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

/**
 * Extract the fields we care about from a PayArc webhook payload.
 * TODO(payarc-dashboard): confirm the exact field names once we can
 * read the webhook reference page. Current assumptions based on the
 * Hosted Fields + charge response shapes we already know.
 */
export function parseWebhookEvent(body = {}) {
  const event = body?.event || body?.type || body?.event_type || '';
  const data = body?.data || body?.object || body;
  const chargeId = data?.id || data?.charge_id || data?.chargeId || '';
  const status = String(data?.status || '').toLowerCase();
  const successful = data?.successful === true;
  const amountCents = Number(data?.amount || 0);
  const description = String(data?.description || '').trim();

  // Derive our reservation match key — we stamped the description
  // with `Reservation <reservationNumber>` in createCharge().
  let reservationNumber = '';
  const m = description.match(/Reservation\s+([A-Za-z0-9\-_]+)/i);
  if (m) reservationNumber = m[1];

  const isSuccess =
    successful ||
    status === 'submitted_for_settlement' ||
    status === 'succeeded' ||
    status === 'authorized' ||
    status === 'captured';
  const isRefund =
    status === 'refunded' ||
    status === 'partially_refunded' ||
    (event && event.toLowerCase().includes('refund'));
  const isVoid = status === 'voided' || (event && event.toLowerCase().includes('void'));

  return {
    event,
    chargeId,
    status,
    amountCents,
    amountDollars: Number((amountCents / 100).toFixed(2)),
    description,
    reservationNumber,
    isSuccess,
    isRefund,
    isVoid,
  };
}
