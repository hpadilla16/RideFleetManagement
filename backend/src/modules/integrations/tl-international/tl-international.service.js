/**
 * TL International franchise back-office client.
 *
 * Wraps fetch() / Puppeteer calls against newadmin.tlinternationalgroup.com.
 * All network I/O lives here so the worker, routes, and bootstrap CLI can
 * remain thin and testable.
 *
 * Public API:
 *   - fetchDashboardPickups(tenantId)      → [{ externalRef, cells, raw_text }]
 *   - fetchReservationDetail(tenantId, ze) → mapped JSON detail (or null)
 *   - testAuth(tenantId)                   → boolean (updates lastTestStatus)
 *   - getCookie(tenantId)                  → plaintext cookie (decrypted)
 *   - setCookie(tenantId, plaintext, uid)  → encrypts + upserts credential
 *
 * Authentication: TL admin doesn't expose a session API — we ship the
 * full Cookie header (PHPSESSID + auxiliary cookies) that Hector copies
 * out of Edge DevTools after logging in. Stored encrypted in
 * IntegrationCredential.encryptedPayload (AES-256-GCM, see
 * lib/integration-crypto.js). The cookie expires every 30-60 min idle;
 * worker catches `TLAuthExpiredError` and surfaces the expired-cookie
 * banner.
 *
 * CloudFlare pivot (2026-05-20): /dashboard.php is fronted by CloudFlare
 * with a fingerprint-bound `__cf_logged_in` + `CF_VERIFIED_DEVICE_*`
 * cookie pair. Raw fetch() with the stored cookie is rejected (302 →
 * login.php) because the server-side TLS/header fingerprint doesn't
 * match the browser that earned the cookie. We now load the dashboard
 * in the shared Puppeteer Chromium so the request looks like a real
 * browser. session_check.php still works over raw fetch (cheaper).
 *
 * See doc/tl-integration-design-2026-05-19.md.
 */

import { prisma } from '../../../lib/prisma.js';
import logger from '../../../lib/logger.js';
import { decrypt, encrypt } from '../../../lib/integration-crypto.js';
import { getBrowser } from '../../../lib/puppeteer-browser.js';

export const SOURCE_SYSTEM = 'TL_INTERNATIONAL';

const BASE_URL = process.env.TL_INTERNATIONAL_BASE_URL
  ?? 'https://newadmin.tlinternationalgroup.com';
const USER_AGENT = process.env.TL_INTERNATIONAL_USER_AGENT
  ?? 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Edg/120';
export const DETAIL_DELAY_MS = Number(process.env.TL_INTERNATIONAL_DETAIL_DELAY_MS ?? 2000);

const PUPPETEER_TIMEOUT_MS = Number(process.env.TL_PUPPETEER_TIMEOUT_MS ?? 30000);
const PUPPETEER_VIEWPORT_WIDTH = Number(process.env.TL_PUPPETEER_VIEWPORT_WIDTH ?? 1366);
const PUPPETEER_VIEWPORT_HEIGHT = Number(process.env.TL_PUPPETEER_VIEWPORT_HEIGHT ?? 900);

export class TLAuthExpiredError extends Error {
  constructor(message = 'TL International session cookie expired or invalid') {
    super(message);
    this.name = 'TLAuthExpiredError';
  }
}

/**
 * Lazily load cheerio. If the package isn't installed, fall back to a
 * regex-based HTML row extractor. The fallback parses fewer cells but
 * still extracts every ZE# present in the dashboard markup.
 */
let cheerioPromise = null;
async function loadCheerio() {
  if (cheerioPromise) return cheerioPromise;
  cheerioPromise = import('cheerio')
    .then((m) => m)
    .catch((err) => {
      logger.warn('[tl-international] cheerio not available, falling back to regex parser', {
        message: err.message,
      });
      return null;
    });
  return cheerioPromise;
}

// ---------------------------------------------------------------------------
// Credential storage (Postgres-backed)
// ---------------------------------------------------------------------------

export async function getCookie(tenantId) {
  if (!tenantId) {
    throw new TLAuthExpiredError('tenantId required to load TL cookie');
  }
  const row = await prisma.integrationCredential.findUnique({
    where: { tenantId_sourceSystem: { tenantId, sourceSystem: SOURCE_SYSTEM } },
  });
  if (!row) {
    throw new TLAuthExpiredError(`No IntegrationCredential row for tenant ${tenantId}`);
  }
  if (!row.encryptedPayload) {
    throw new TLAuthExpiredError(`IntegrationCredential.encryptedPayload empty for tenant ${tenantId}`);
  }
  let cookie;
  try {
    cookie = decrypt(row.encryptedPayload);
  } catch (err) {
    throw new TLAuthExpiredError(`Failed to decrypt TL cookie for tenant ${tenantId}: ${err.message}`);
  }
  if (!cookie || cookie.length < 20) {
    throw new TLAuthExpiredError(`Decrypted TL cookie is too short for tenant ${tenantId}`);
  }
  return cookie;
}

export async function setCookie(tenantId, plaintext, userId = null) {
  if (!tenantId) throw new Error('tenantId required');
  if (typeof plaintext !== 'string' || plaintext.trim().length < 20) {
    throw new Error('cookie value too short or not a string');
  }
  const encryptedPayload = encrypt(plaintext.trim());
  const row = await prisma.integrationCredential.upsert({
    where: { tenantId_sourceSystem: { tenantId, sourceSystem: SOURCE_SYSTEM } },
    create: {
      tenantId,
      sourceSystem: SOURCE_SYSTEM,
      encryptedPayload,
      rotatedAt: new Date(),
      rotatedByUserId: userId,
    },
    update: {
      encryptedPayload,
      rotatedAt: new Date(),
      rotatedByUserId: userId,
      // Reset test status — caller should re-test after rotation.
      lastTestedAt: null,
      lastTestStatus: null,
    },
  });
  logger.info('[tl-international] cookie rotated', { tenantId, credentialId: row.id });
  return row;
}

async function recordTestStatus(tenantId, status) {
  await prisma.integrationCredential.update({
    where: { tenantId_sourceSystem: { tenantId, sourceSystem: SOURCE_SYSTEM } },
    data: { lastTestedAt: new Date(), lastTestStatus: status },
  }).catch(() => {/* swallow — caller already failing */});
}

// ---------------------------------------------------------------------------
// HTTP plumbing — raw fetch (still used for session_check.php)
// ---------------------------------------------------------------------------

async function tlFetch(tenantId, path, opts = {}) {
  const cookie = await getCookie(tenantId);
  const url = path.startsWith('http') ? path : `${BASE_URL}${path}`;
  const res = await globalThis.fetch(url, {
    redirect: 'manual',
    headers: {
      Cookie: cookie,
      'User-Agent': USER_AGENT,
      Accept: opts.acceptJson ? 'application/json,*/*' : 'text/html,*/*',
      ...(opts.headers ?? {}),
    },
    method: opts.method ?? 'GET',
    body: opts.body,
    signal: opts.signal,
  });

  if (res.status === 301 || res.status === 302) {
    const loc = res.headers.get('location') ?? '';
    if (/login|auth|signin/i.test(loc)) {
      throw new TLAuthExpiredError(`Redirect to login: ${loc}`);
    }
  }
  if (res.status === 401 || res.status === 403) {
    throw new TLAuthExpiredError(`HTTP ${res.status}`);
  }
  if (!res.ok) {
    throw new Error(`TL fetch ${url} failed: HTTP ${res.status}`);
  }
  return res;
}

// ---------------------------------------------------------------------------
// Cookie parsing for Puppeteer
// ---------------------------------------------------------------------------

/**
 * Parse a `Cookie:` header value ("k1=v1; k2=v2") into the array shape
 * `page.setCookie()` expects. Domain/path are NOT set here — callers
 * add those based on the target URL.
 *
 * Exported for tests.
 */
export function parseCookieString(s) {
  if (typeof s !== 'string' || !s.trim()) return [];
  return s
    .split(';')
    .map((kv) => {
      const trimmed = kv.trim();
      if (!trimmed) return null;
      const idx = trimmed.indexOf('=');
      if (idx < 0) return null;
      const name = trimmed.slice(0, idx).trim();
      const value = trimmed.slice(idx + 1).trim();
      if (!name) return null;
      return { name, value };
    })
    .filter(Boolean);
}

// ---------------------------------------------------------------------------
// Puppeteer plumbing — used for /dashboard.php (CloudFlare-protected)
// ---------------------------------------------------------------------------

/**
 * Load a TL admin page in the shared headless Chromium, with the
 * tenant's cookie injected first. Returns the page HTML.
 *
 * Throws TLAuthExpiredError when the final URL ends up on login.php or
 * /auth (CloudFlare/TL bounced us).
 *
 * The caller MUST be tolerant of a `getBrowser()` failure — when
 * Chromium can't launch (no executable, sandbox issue), we let the
 * underlying error bubble so the worker marks the run failed and the
 * next run gets a fresh browser.
 */
async function tlPuppeteerLoad(tenantId, path) {
  const cookieString = await getCookie(tenantId);
  const browser = await getBrowser();
  const page = await browser.newPage();

  try {
    const target = new URL(path, BASE_URL);
    const cookies = parseCookieString(cookieString).map((c) => ({
      ...c,
      domain: target.hostname,
      path: '/',
    }));
    if (cookies.length === 0) {
      throw new TLAuthExpiredError(`Cookie payload for tenant ${tenantId} is empty after parse`);
    }
    await page.setCookie(...cookies);
    await page.setUserAgent(USER_AGENT);
    await page.setViewport({
      width: PUPPETEER_VIEWPORT_WIDTH,
      height: PUPPETEER_VIEWPORT_HEIGHT,
    });

    // networkidle2: wait for ≤2 in-flight requests so the CloudFlare JS
    // challenge has time to settle. 30s is conservative — challenges
    // typically resolve in 3-5s.
    const response = await page.goto(target.toString(), {
      waitUntil: 'networkidle2',
      timeout: PUPPETEER_TIMEOUT_MS,
    });

    const finalUrl = page.url();
    if (/login\.php|\/auth(\b|\/)|signin/i.test(finalUrl)) {
      throw new TLAuthExpiredError(`Redirected to ${finalUrl}`);
    }
    const status = response?.status?.();
    if (status === 401 || status === 403) {
      throw new TLAuthExpiredError(`HTTP ${status} on ${path}`);
    }

    const html = await page.content();
    return { html, finalUrl, status };
  } finally {
    // ALWAYS close the page — leaked pages eat memory.
    await page.close().catch((err) => {
      logger.warn('[tl-international] page.close() failed', { message: err?.message });
    });
  }
}

// Test seam: tests swap in a stub via __setPuppeteerLoader. Production
// code path is unchanged.
let _puppeteerLoad = tlPuppeteerLoad;

export const __test = {
  setPuppeteerLoader(fn) {
    if (fn === null || fn === undefined) {
      _puppeteerLoad = tlPuppeteerLoad;
      return;
    }
    if (typeof fn !== 'function') {
      throw new Error('setPuppeteerLoader expects a function or null');
    }
    _puppeteerLoad = fn;
  },
};

// ---------------------------------------------------------------------------
// Dashboard scrape
// ---------------------------------------------------------------------------

const ZE_REGEX = /ZE\d+[A-Z]{1,3}/g;

/**
 * Regex fallback for when cheerio is unavailable. Walks every <tr>
 * block, requires "PICKUP" + a ZE# in the same row, extracts <td> text
 * positionally.
 */
export function parseDashboardHtmlFallback(html) {
  const out = [];
  const seen = new Set();
  const rowRe = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
  let m;
  while ((m = rowRe.exec(html)) !== null) {
    const rowHtml = m[1];
    if (!/PICKUP/i.test(rowHtml)) continue;
    const ze = rowHtml.match(/ZE\d+[A-Z]{1,3}/);
    if (!ze) continue;
    if (seen.has(ze[0])) continue;
    seen.add(ze[0]);
    const cells = [];
    const cellRe = /<td\b[^>]*>([\s\S]*?)<\/td>/gi;
    let c;
    while ((c = cellRe.exec(rowHtml)) !== null) {
      cells.push(stripTags(c[1]).trim());
    }
    out.push({
      externalRef: ze[0],
      cells,
      raw_text: stripTags(rowHtml).replace(/\s+/g, ' ').trim().slice(0, 200),
    });
  }
  return out;
}

function stripTags(s) {
  return String(s).replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
}

/**
 * Parse already-loaded dashboard HTML into row objects. Pure function —
 * exported for tests + reused by both the Puppeteer and (legacy) fetch
 * code paths.
 */
export async function parseDashboardHtml(html) {
  const cheerioMod = await loadCheerio();
  if (cheerioMod && typeof cheerioMod.load === 'function') {
    const $ = cheerioMod.load(html);
    const seen = new Set();
    const rows = [];
    $('tr').each((_i, el) => {
      const text = $(el).text().toUpperCase();
      if (!text.includes('PICKUP')) return;
      const rowHtml = $(el).html() || '';
      const ze = rowHtml.match(ZE_REGEX);
      if (!ze || !ze.length) return;
      const externalRef = ze[0];
      if (seen.has(externalRef)) return;
      seen.add(externalRef);
      const cells = $(el).find('td').map((_j, td) => $(td).text().trim()).get();
      rows.push({
        externalRef,
        cells,
        raw_text: text.trim().slice(0, 200),
      });
    });
    return rows;
  }
  return parseDashboardHtmlFallback(html);
}

export async function fetchDashboardPickups(tenantId) {
  // CloudFlare blocks raw fetch on /dashboard.php — go straight to
  // Puppeteer. Keep the parser pure so unit tests can exercise HTML
  // without spinning up Chromium.
  const { html } = await _puppeteerLoad(tenantId, '/dashboard.php');
  const rows = await parseDashboardHtml(html);
  logger.info('[tl-international] dashboard fetched', {
    tenantId,
    pickup_count: rows.length,
    transport: 'puppeteer',
  });
  return rows;
}

// ---------------------------------------------------------------------------
// Detail fetch
// ---------------------------------------------------------------------------

/**
 * Try raw fetch() first (fast). If CloudFlare bounces us to login,
 * retry the same URL through Puppeteer and parse the JSON out of the
 * page body. Returns parsed JSON (or null if non-success).
 */
async function fetchJsonOrPuppeteer(tenantId, path) {
  try {
    const res = await tlFetch(tenantId, path, { acceptJson: true });
    return await res.json();
  } catch (err) {
    if (!(err instanceof TLAuthExpiredError)) throw err;
    logger.info('[tl-international] raw fetch hit login redirect, retrying via puppeteer', {
      tenantId,
      path,
    });
    // Fall through to Puppeteer.
  }

  const { html, finalUrl } = await _puppeteerLoad(tenantId, path);
  // Puppeteer wraps JSON responses in <html><body><pre>…</pre></body></html>.
  // Strip tags and pull the longest plausible JSON object/array out.
  const text = stripTags(html).trim();
  const start = text.search(/[\[{]/);
  if (start < 0) {
    logger.warn('[tl-international] puppeteer JSON path returned no JSON', { tenantId, path, finalUrl });
    return null;
  }
  const slice = text.slice(start);
  try {
    return JSON.parse(slice);
  } catch (e) {
    // Try to repair by trimming trailing garbage — locate last matching brace.
    const last = Math.max(slice.lastIndexOf('}'), slice.lastIndexOf(']'));
    if (last > 0) {
      try { return JSON.parse(slice.slice(0, last + 1)); } catch { /* fall through */ }
    }
    logger.warn('[tl-international] puppeteer JSON parse failed', {
      tenantId,
      path,
      message: e.message,
    });
    return null;
  }
}

export async function fetchReservationDetail(tenantId, externalRef) {
  if (!/^ZE\d+[A-Z]{1,3}$/.test(externalRef)) {
    throw new Error(`Invalid externalRef format: ${externalRef}`);
  }
  let payload;
  try {
    payload = await fetchJsonOrPuppeteer(
      tenantId,
      `/get-reservation-details.php?resnumber=${encodeURIComponent(externalRef)}`
    );
  } catch (e) {
    if (e instanceof TLAuthExpiredError) throw e;
    logger.warn('[tl-international] detail fetch failed', {
      tenantId,
      externalRef,
      message: e.message,
    });
    return null;
  }
  if (!payload) return null;
  if (payload.success === false) {
    logger.warn('[tl-international] detail non-success', { tenantId, externalRef });
    return null;
  }
  return payload.reservation ?? payload.data ?? payload ?? null;
}

/**
 * Map the TL detail JSON onto an ExternalReservation create/update shape.
 * Pure function — exported for tests.
 *
 * Keys verified against production data 2026-05-20 (sample ZE40774901BA).
 * TL's JSON uses lowercase, terse field names: `firstname`, `lastname`,
 * `tele`, `mobile`, `flight`, `acriss`, `pickupdate` (UNIX seconds),
 * `pickuploc`, `dropoffdate`, `dropoffloc`, `amount`, `currency`, `sourcex`,
 * `yourref`. We keep older guessed keys as fallbacks for backwards compat
 * (the helper is reused by tests and may be reused by another source
 * system in the future).
 *
 * NOTE: TL returns `royalty` (e.g., "3.77") which is the per-booking
 * commission TL retains. Not stored as a column to avoid a schema
 * migration; extract from rawJson when computing the monthly payout:
 * SUM(rawJson->>'royalty') for billable rows.
 */
export function mapDetailToRow(d, externalRef) {
  if (!d || typeof d !== 'object') {
    return { externalRef, rawJson: d ?? { error: 'detail-null' } };
  }

  const toDate = (v) => {
    if (v == null || v === '') return null;
    if (typeof v === 'number') {
      // TL uses UNIX seconds. Anything < 10^12 is seconds, otherwise ms.
      const ms = v < 1e12 ? v * 1000 : v;
      const dt = new Date(ms);
      return Number.isFinite(dt.valueOf()) ? dt : null;
    }
    // Numeric string from TL? Coerce.
    if (typeof v === 'string' && /^\d+$/.test(v.trim())) {
      const n = Number(v.trim());
      const ms = n < 1e12 ? n * 1000 : n;
      const dt = new Date(ms);
      return Number.isFinite(dt.valueOf()) ? dt : null;
    }
    const dt = new Date(v);
    return Number.isFinite(dt.valueOf()) ? dt : null;
  };

  const toDecimalString = (v) => {
    if (v == null) return null;
    const s = String(v).trim();
    if (s === '' || s === '0' || s === '0.00') return null;
    return s;
  };

  const pickPhone = () => {
    const tele = d.tele != null ? String(d.tele).trim() : '';
    if (tele) return tele;
    const mobile = d.mobile != null ? String(d.mobile).trim() : '';
    if (mobile) return mobile;
    const phone = d.phone != null ? String(d.phone).trim() : '';
    if (phone) return phone;
    const telephone = d.telephone != null ? String(d.telephone).trim() : '';
    if (telephone) return telephone;
    return null;
  };

  return {
    externalRef,
    channel: d.sourcex ?? d.channel ?? d.supplier ?? d.bookedBy ?? null,
    supplierRef: d.yourref ?? d.supplierRef ?? d.supplier_ref ?? null,
    status: d.status ?? null,
    customerFirstName: d.firstname ?? d.firstName ?? d.first_name ?? null,
    customerLastName: d.lastname ?? d.lastName ?? d.last_name ?? null,
    customerEmail: d.email ?? null,
    customerPhone: pickPhone(),
    customerCountry: d.country ?? null,
    flightNumber: d.flight ?? d.flightNumber ?? d.flight_number ?? null,
    vehicleAcriss: d.acriss ?? d.vehicleClass ?? d.vehicle_acriss ?? d.car_class ?? null,
    vehicleDescription:
      d.vehname ?? d.vmake ?? d.vehicleDescription ?? d.vehicle_description ?? d.car_description ?? null,
    pickupAt: toDate(d.pickupdate ?? d.pickup ?? d.pickupAt ?? d.pickup_date),
    pickupLocation: d.pickuploc ?? d.pickupLocation ?? d.pickup_location ?? d.pickup_loc ?? null,
    dropoffAt: toDate(d.dropoffdate ?? d.dropoff ?? d.dropoffAt ?? d.dropoff_date ?? d.return ?? d.returnAt),
    dropoffLocation: d.dropoffloc ?? d.dropoffLocation ?? d.dropoff_location ?? d.return_location ?? null,
    totalAmount: toDecimalString(d.amount ?? d.total ?? d.totalAmount ?? d.total_amount),
    currency: d.currency ?? 'USD',
    rawJson: d,
  };
}

// ---------------------------------------------------------------------------
// Auth probe
// ---------------------------------------------------------------------------

/**
 * Cheap auth check — hits /session_check.php?action=get_timeout. Updates
 * IntegrationCredential.lastTestStatus + lastTestedAt as a side effect.
 *
 * Stays on raw fetch() because session_check.php is NOT CloudFlare
 * protected (verified 2026-05-19) and Puppeteer would add 1-3s of
 * overhead to what is supposed to be a fast health check.
 *
 * @returns {Promise<{ok: boolean, status: 'OK'|'EXPIRED'|'ERROR', message?: string}>}
 */
export async function testAuth(tenantId) {
  try {
    await tlFetch(tenantId, '/session_check.php?action=get_timeout');
    await recordTestStatus(tenantId, 'OK');
    return { ok: true, status: 'OK' };
  } catch (err) {
    if (err instanceof TLAuthExpiredError) {
      await recordTestStatus(tenantId, 'EXPIRED');
      return { ok: false, status: 'EXPIRED', message: err.message };
    }
    await recordTestStatus(tenantId, 'ERROR');
    return { ok: false, status: 'ERROR', message: err.message };
  }
}

// ---------------------------------------------------------------------------
// Tiny helpers
// ---------------------------------------------------------------------------

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export { BASE_URL };
