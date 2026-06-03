import logger from '../../lib/logger.js';

/**
 * iPOSpays Authentication Token API client.
 *
 * Docs: https://docs.ipospays.com/ipos-pays-authentication-token-api
 *
 * Two modes:
 *
 * 1. STATIC TOKEN — IPOS_TRANSACT_AUTH_TOKEN env var holds a JWT
 *    pasted from the iPOSpays portal Settings page. No auto-refresh
 *    happens; when the token expires the agent has to paste a new
 *    one. Used historically when the V3 Authentication Token API
 *    wasn't enabled on the merchant account.
 *
 * 2. AUTO-MANAGED — IPOS_TRANSACT_API_KEY + IPOS_TRANSACT_SECRET_KEY
 *    are set; this module mints a token via /v1/authenticate-token,
 *    caches it in memory with the JWT's own exp claim, and refreshes
 *    it via /v1/refresh-token a configurable safety-window before
 *    expiry. No daily portal logins.
 *
 *    For this mode, generate the keys once in the iPOSpays portal:
 *      Settings → Generate API & Secret Key → Generate Keys
 *
 * Mid-request invalidation: if a Transact call comes back with a
 * "token invalid" error (AUTH_ERR_006/007/008), the caller can
 * `invalidateCache()` and call `getAuthToken()` again; the next call
 * will regenerate from credentials and retry. The wrapper in
 * ipos-transact-client.js handles that retry automatically.
 */

const AUTH_GENERATE_URL = 'https://auth.ipospays.com/v1/authenticate-token';
const AUTH_REFRESH_URL = 'https://auth.ipospays.com/v1/refresh-token';

const DEFAULT_EXPIRY_MINUTES = 1440; // 24h — the API max
const DEFAULT_SAFETY_WINDOW_MS = 30 * 60 * 1000; // refresh 30 min early
const FETCH_TIMEOUT_MS = 15000;

// Process-wide cache. Single-tenant for now — if/when we go multi-tenant
// this becomes a Map keyed by tenantId+credentials hash.
let cached = null; // { token, expiresAt, generatedAt }
let inflight = null; // Promise<string> coalescing concurrent refreshes

function getAuthConfig(tenantConfig = {}) {
  return {
    // Manual-override token — takes precedence over auto-refresh.
    staticToken: tenantConfig.iposTransactAuthToken
      || process.env.IPOS_TRANSACT_AUTH_TOKEN
      || '',
    // Auto-refresh credentials.
    apiKey: tenantConfig.iposTransactApiKey
      || process.env.IPOS_TRANSACT_API_KEY
      || '',
    secretKey: tenantConfig.iposTransactSecretKey
      || process.env.IPOS_TRANSACT_SECRET_KEY
      || '',
    // PaymentTokenization is the scope required for V3 iposTransact
    // endpoints. Other valid scopes (per the docs): Recurring,
    // BatchReport, ExternalApi. Override if you need a different scope.
    scope: tenantConfig.iposTransactScope
      || process.env.IPOS_TRANSACT_SCOPE
      || 'PaymentTokenization',
    expiryMinutes: Number(
      tenantConfig.iposTransactExpiryMinutes
      || process.env.IPOS_TRANSACT_EXPIRY_MINUTES
      || DEFAULT_EXPIRY_MINUTES,
    ),
    safetyWindowMs: Number(
      tenantConfig.iposTransactSafetyWindowMs
      || process.env.IPOS_TRANSACT_SAFETY_WINDOW_MS
      || DEFAULT_SAFETY_WINDOW_MS,
    ),
  };
}

export function hasAutoRefresh(tenantConfig = {}) {
  const cfg = getAuthConfig(tenantConfig);
  return Boolean(cfg.apiKey && cfg.secretKey);
}

export function hasStaticToken(tenantConfig = {}) {
  const cfg = getAuthConfig(tenantConfig);
  return Boolean(cfg.staticToken);
}

/**
 * Parse the exp claim out of a JWT to know when it expires. Falls back
 * to "now + expiryMinutes" if the token can't be decoded (defensive —
 * we should always get a parseable JWT from the auth API).
 */
function parseTokenExpiry(jwt, fallbackMinutes = DEFAULT_EXPIRY_MINUTES) {
  try {
    const parts = String(jwt).split('.');
    if (parts.length !== 3) throw new Error('not a JWT');
    const payload = JSON.parse(
      Buffer.from(parts[1], 'base64url').toString('utf8'),
    );
    if (Number.isFinite(payload.exp)) {
      return Number(payload.exp) * 1000;
    }
    throw new Error('no exp claim');
  } catch {
    return Date.now() + fallbackMinutes * 60 * 1000;
  }
}

async function fetchWithTimeout(url, init) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function callAuthApi(url, body) {
  // iPOSpays' Authentication Token API reads apiKey / secretKey / scope /
  // jwtTokenExpiryMinutes (and for refresh, refreshToken / token) from HTTP
  // HEADERS — the docs label the request block a "Sample Header Request" /
  // "Post head request". Sending them only in the JSON body returns
  // AUTH_ERR_001 "API Key is required." We send them as headers (string
  // values) and also keep them in the body, so it works whichever the
  // endpoint version reads.
  const headerFields = Object.fromEntries(
    Object.entries(body)
      .filter(([, v]) => v !== undefined && v !== null && v !== '')
      .map(([k, v]) => [k, String(v)]),
  );
  const res = await fetchWithTimeout(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headerFields },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (data?.errorCode || data?.responseCode !== '00' || !data?.token) {
    const msg = data?.errorMessage
      || data?.responseMessage
      || `iPOSpays auth API error (${res.status})`;
    const err = new Error(msg);
    err.iposAuthErrorCode = data?.errorCode || '';
    err.iposAuthResponse = data;
    throw err;
  }
  return data;
}

/**
 * Generate a brand-new auth token from API Key + Secret Key.
 */
async function generateToken(cfg) {
  if (!cfg.apiKey || !cfg.secretKey) {
    throw new Error('IPOS_TRANSACT_API_KEY and IPOS_TRANSACT_SECRET_KEY required for auto-refresh');
  }
  const data = await callAuthApi(AUTH_GENERATE_URL, {
    apiKey: cfg.apiKey,
    secretKey: cfg.secretKey,
    scope: cfg.scope,
    jwtTokenExpiryMinutes: cfg.expiryMinutes,
  });
  const expiresAt = parseTokenExpiry(data.token, cfg.expiryMinutes);
  logger.info('[ipos-auth] new token generated', {
    expiresIn: Math.round((expiresAt - Date.now()) / 60000) + 'min',
  });
  return { token: data.token, expiresAt, generatedAt: Date.now() };
}

/**
 * Refresh an existing token before it expires. Slightly cheaper for
 * the API than a fresh generate (no credential check).
 */
async function refreshToken(currentToken, cfg) {
  const data = await callAuthApi(AUTH_REFRESH_URL, {
    refreshToken: true,
    token: currentToken,
  });
  const expiresAt = parseTokenExpiry(data.token, cfg.expiryMinutes);
  logger.info('[ipos-auth] token refreshed', {
    expiresIn: Math.round((expiresAt - Date.now()) / 60000) + 'min',
  });
  return { token: data.token, expiresAt, generatedAt: Date.now() };
}

/**
 * Get a valid auth token — honours static-override mode, otherwise
 * auto-refreshes via the iPOSpays Authentication Token API.
 *
 * Coalesces concurrent calls so a burst of requests on a cold cache
 * triggers exactly one network round-trip.
 */
export async function getAuthToken(tenantConfig = {}) {
  const cfg = getAuthConfig(tenantConfig);

  // Static override — caller pasted a token from the portal. No
  // refresh attempts; if it expires the next Transact call will fail
  // with AUTH_ERR_006 and the agent will see the error in the UI.
  if (cfg.staticToken) return cfg.staticToken;

  if (!cfg.apiKey || !cfg.secretKey) {
    throw new Error(
      'iPOSpays Transact auth not configured. Set either IPOS_TRANSACT_AUTH_TOKEN '
      + '(static, manual refresh) or IPOS_TRANSACT_API_KEY + IPOS_TRANSACT_SECRET_KEY '
      + '(auto-refresh).',
    );
  }

  const now = Date.now();

  // Cache hit — token still has plenty of life left.
  if (cached && cached.expiresAt - now > cfg.safetyWindowMs) {
    return cached.token;
  }

  // Coalesce concurrent refreshes (a 200ms burst of requests on a
  // cold cache would otherwise fire N parallel auth calls).
  if (inflight) return inflight;

  inflight = (async () => {
    try {
      let next;
      // If we have a not-fully-expired token, prefer the cheaper
      // refresh endpoint over a fresh generate.
      if (cached && cached.expiresAt > now) {
        try {
          next = await refreshToken(cached.token, cfg);
        } catch (err) {
          // AUTH_ERR_006/007/008 = invalid token → fall through to
          // generate. Anything else propagates so we don't silently
          // swap to a "fresh" token if the user's credentials got
          // rotated (better to surface the failure).
          const code = err?.iposAuthErrorCode || '';
          if (!['AUTH_ERR_006', 'AUTH_ERR_007', 'AUTH_ERR_008'].includes(code)) {
            throw err;
          }
          logger.warn('[ipos-auth] refresh failed, falling back to generate', { code });
          cached = null;
        }
      }
      if (!next) {
        next = await generateToken(cfg);
      }
      cached = next;
      return next.token;
    } finally {
      inflight = null;
    }
  })();

  return inflight;
}

/**
 * Clear the cached token. Called by the Transact wrapper when a
 * request comes back with a "token invalid" error code so the next
 * getAuthToken() call regenerates from scratch.
 */
export function invalidateCache() {
  cached = null;
  inflight = null;
}

/**
 * Lightweight introspection — used by the boot audit + tests. Does
 * NOT include the token value itself.
 */
export function inspectCache() {
  if (!cached) return { hasCachedToken: false };
  return {
    hasCachedToken: true,
    expiresAt: cached.expiresAt,
    generatedAt: cached.generatedAt,
    expiresInMin: Math.round((cached.expiresAt - Date.now()) / 60000),
  };
}

/**
 * Boot-time audit so misconfig surfaces in the log rather than at the
 * first card tap. Called from main.js after listen.
 */
let auditLogged = false;
export function auditIposAuth() {
  if (auditLogged) return;
  auditLogged = true;
  const cfg = getAuthConfig();
  if (cfg.staticToken) {
    logger.info('[ipos-auth] Static auth token mode (no auto-refresh). Rotate manually before expiry.');
    return;
  }
  if (cfg.apiKey && cfg.secretKey) {
    logger.info('[ipos-auth] Auto-refresh mode active', {
      scope: cfg.scope,
      expiryMinutes: cfg.expiryMinutes,
      safetyWindowMin: Math.round(cfg.safetyWindowMs / 60000),
    });
    return;
  }
  logger.warn('[ipos-auth] No auth credentials configured. Set IPOS_TRANSACT_AUTH_TOKEN OR (IPOS_TRANSACT_API_KEY + IPOS_TRANSACT_SECRET_KEY).');
}
