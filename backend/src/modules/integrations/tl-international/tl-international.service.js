/**
 * TL International franchise back-office client.
 *
 * Wraps fetch() calls against newadmin.tlinternationalgroup.com. All
 * network I/O lives here so the worker, routes, and bootstrap CLI can
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
 * See doc/tl-integration-design-2026-05-19.md.
 */

import { prisma } from '../../../lib/prisma.js';
import logger from '../../../lib/logger.js';
import { decrypt, encrypt } from '../../../lib/integration-crypto.js';

export const SOURCE_SYSTEM = 'TL_INTERNATIONAL';

const BASE_URL = process.env.TL_INTERNATIONAL_BASE_URL
  ?? 'https://newadmin.tlinternationalgroup.com';
const USER_AGENT = process.env.TL_INTERNATIONAL_USER_AGENT
  ?? 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Edg/120';
export const DETAIL_DELAY_MS = Number(process.env.TL_INTERNATIONAL_DETAIL_DELAY_MS ?? 2000);

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
// HTTP plumbing
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

export async function fetchDashboardPickups(tenantId) {
  const res = await tlFetch(tenantId, '/dashboard.php');
  const html = await res.text();
  const cheerioMod = await loadCheerio();
  let rows;
  if (cheerioMod && typeof cheerioMod.load === 'function') {
    const $ = cheerioMod.load(html);
    const seen = new Set();
    rows = [];
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
  } else {
    rows = parseDashboardHtmlFallback(html);
  }
  logger.info('[tl-international] dashboard fetched', { tenantId, pickup_count: rows.length });
  return rows;
}

// ---------------------------------------------------------------------------
// Detail fetch
// ---------------------------------------------------------------------------

export async function fetchReservationDetail(tenantId, externalRef) {
  if (!/^ZE\d+[A-Z]{1,3}$/.test(externalRef)) {
    throw new Error(`Invalid externalRef format: ${externalRef}`);
  }
  const res = await tlFetch(
    tenantId,
    `/get-reservation-details.php?resnumber=${encodeURIComponent(externalRef)}`,
    { acceptJson: true }
  );
  let payload;
  try {
    payload = await res.json();
  } catch (e) {
    logger.warn('[tl-international] detail JSON parse failed', { tenantId, externalRef, message: e.message });
    return null;
  }
  if (payload && payload.success === false) {
    logger.warn('[tl-international] detail non-success', { tenantId, externalRef });
    return null;
  }
  return payload?.reservation ?? payload?.data ?? payload ?? null;
}

/**
 * Map the TL detail JSON onto an ExternalReservation create/update shape.
 * Pure function — exported for tests.
 */
export function mapDetailToRow(d, externalRef) {
  if (!d || typeof d !== 'object') {
    return { externalRef, rawJson: { error: 'detail-null' } };
  }
  const parseDate = (v) => {
    if (!v) return null;
    const d2 = new Date(v);
    return Number.isNaN(d2.getTime()) ? null : d2;
  };
  return {
    externalRef,
    channel: d.channel ?? d.supplier ?? d.bookedBy ?? null,
    supplierRef: d.supplierRef ?? d.supplier_ref ?? null,
    status: d.status ?? null,
    customerFirstName: d.firstname ?? d.firstName ?? d.first_name ?? null,
    customerLastName: d.lastname ?? d.lastName ?? d.last_name ?? null,
    customerEmail: d.email ?? null,
    customerPhone: d.phone ?? d.telephone ?? d.mobile ?? null,
    customerCountry: d.country ?? null,
    flightNumber: d.flight ?? d.flightNumber ?? d.flight_number ?? null,
    vehicleAcriss: d.vehicleClass ?? d.acriss ?? d.vehicle_acriss ?? d.car_class ?? null,
    vehicleDescription: d.vehicleDescription ?? d.vehicle_description ?? d.car_description ?? null,
    pickupAt: parseDate(d.pickup ?? d.pickupAt ?? d.pickup_date),
    pickupLocation: d.pickupLocation ?? d.pickup_location ?? d.pickup_loc ?? null,
    dropoffAt: parseDate(d.dropoff ?? d.dropoffAt ?? d.dropoff_date ?? d.return ?? d.returnAt),
    dropoffLocation: d.dropoffLocation ?? d.dropoff_location ?? d.return_location ?? null,
    totalAmount: d.total ?? d.totalAmount ?? d.total_amount ?? null,
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
