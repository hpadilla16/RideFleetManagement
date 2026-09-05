/**
 * Partnerships — pure rules (no prisma). Unit-tested in partnerships.test.mjs.
 *
 *   - slug / program-code normalization
 *   - effective status (ACTIVE only inside validFrom/validTo)
 *   - what a program is missing before it may be published
 *   - discount math (effective daily rate, never a negative charge line)
 *   - hosted URL composition
 */

export const PARTNER_STATUSES = Object.freeze(['DRAFT', 'ACTIVE', 'PAUSED', 'EXPIRED']);
export const PARTNER_KINDS = Object.freeze(['INSURANCE', 'CORPORATE', 'COOPERATIVE', 'HOTEL', 'OTHER']);
export const VEHICLE_MODES = Object.freeze(['SHOW_INVENTORY', 'PREFERRED_TYPE', 'ASSIGN_AT_PICKUP']);
export const PREFERRED_TYPE_PRICING = Object.freeze(['CONFIRM_AT_PICKUP', 'TYPE_PRICE']);

/** Strip trailing slashes without a backtracking regex (CodeQL js/polynomial-redos on user input). */
export function stripTrailingSlashes(value) {
  let s = String(value || '').trim();
  while (s.endsWith('/')) s = s.slice(0, -1);
  return s;
}

/** "Seguros Isla" → "seguros-isla". ASCII-folds accents, max 48 chars. */
export function normalizeSlug(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

/** "isla 26" → "ISLA26". Uppercase alphanumerics, 3..16 chars (empty when invalid). */
export function normalizeProgramCode(value) {
  const code = String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 16);
  return code.length >= 3 ? code : '';
}

/** Rate code for the partner's price book — never collides with the online books. */
export function partnerRateCode(slug) {
  return `PARTNER-${normalizeSlug(slug).toUpperCase()}`;
}

/**
 * The status the PUBLIC surface should honor right now.
 *   DRAFT / PAUSED / EXPIRED → as stored.
 *   ACTIVE but now < validFrom → NOT_STARTED ; now > validTo → EXPIRED (window closed).
 */
export function effectiveStatus(partner, now = new Date()) {
  const status = String(partner?.status || 'DRAFT').toUpperCase();
  if (status !== 'ACTIVE') return status;
  const from = partner?.validFrom ? new Date(partner.validFrom) : null;
  const to = partner?.validTo ? new Date(partner.validTo) : null;
  if (from && !Number.isNaN(from.getTime()) && now < from) return 'NOT_STARTED';
  if (to && !Number.isNaN(to.getTime()) && now > to) return 'EXPIRED';
  return 'ACTIVE';
}

export function isPubliclyAvailable(partner, now = new Date()) {
  return effectiveStatus(partner, now) === 'ACTIVE';
}

/**
 * Which "steps" of the editor are complete. `pricedClassCount` = RateItems on the
 * partner rate with daily > 0 (or "any" when discount mode). The publish gate is
 * `missing.length === 0`.
 */
export function publishReadiness(partner, { pricedClassCount = 0, serviceCount = 0 } = {}) {
  const missing = [];
  const mode = String(partner?.vehicleMode || 'SHOW_INVENTORY');
  const kind = String(partner?.kind || 'OTHER');
  const hasRate = !!partner?.rateId;
  const discount = partner?.discountPct === null || partner?.discountPct === undefined ? null : Number(partner.discountPct);
  const hasDiscount = discount !== null && Number.isFinite(discount) && discount > 0;
  const termsEs = String(partner?.termsJson?.es || '').trim();

  if (!String(partner?.name || '').trim()) missing.push('name');
  if (!normalizeSlug(partner?.slug)) missing.push('slug');
  if (!normalizeProgramCode(partner?.code)) missing.push('code');
  if (!termsEs) missing.push('terms');
  if (!hasRate && !hasDiscount) missing.push('pricing');
  if (hasRate && pricedClassCount < 1) missing.push('pricing');

  if (mode === 'PREFERRED_TYPE') {
    if (kind !== 'INSURANCE') missing.push('vehicleMode'); // only insurers get the preference flow
    const allowed = Array.isArray(partner?.allowedVehicleTypeIds) ? partner.allowedVehicleTypeIds : [];
    if (allowed.length < 1) missing.push('vehicles');
    if (!String(partner?.coverageDisclosureJson?.es || '').trim()) missing.push('disclosure');
  } else if (mode === 'ASSIGN_AT_PICKUP') {
    if (!partner?.defaultVehicleTypeId) missing.push('vehicles');
  }

  return {
    missing: [...new Set(missing)],
    ready: missing.length === 0,
    steps: {
      profile: !missing.includes('name') && !missing.includes('slug') && !missing.includes('code'),
      terms: !missing.includes('terms'),
      pricing: !missing.includes('pricing'),
      vehicles: !missing.includes('vehicles') && !missing.includes('vehicleMode') && !missing.includes('disclosure'),
      services: true, // optional
      hosted: String(partner?.status || '') === 'ACTIVE'
    },
    serviceCount
  };
}

/**
 * Discount mode: the customer sees an EFFECTIVE daily rate (same shape as revenue
 * pricing: quote.dailyRate moves, baseDailyRate is kept for the strike-through).
 * Never a negative charge line. Rounded to cents, never below 0.
 */
export function applyDiscount(baseDaily, discountPct) {
  const base = Number(baseDaily || 0);
  const pct = Number(discountPct || 0);
  if (!Number.isFinite(base) || base <= 0) return 0;
  if (!Number.isFinite(pct) || pct <= 0) return Number(base.toFixed(2));
  const capped = Math.min(pct, 100);
  return Number(Math.max(0, base * (1 - capped / 100)).toFixed(2));
}

/**
 * Public URL of the program. Tenant override (its own storefront subdomain) wins;
 * otherwise RFM serves /p/<tenantSlug>/<partnerSlug>.
 */
export function hostedUrl({ hostedBaseUrl, appBaseUrl, tenantSlug, slug }) {
  const clean = normalizeSlug(slug);
  const base = stripTrailingSlashes(hostedBaseUrl);
  if (base) return `${base}/${clean}`;
  const app = stripTrailingSlashes(appBaseUrl);
  return `${app}/p/${encodeURIComponent(String(tenantSlug || ''))}/${clean}`;
}

/** The URL printed on the QR — adds attribution so scans are measurable. */
export function qrUrl(publicUrl) {
  const url = String(publicUrl || '');
  if (!url) return '';
  return `${url}${url.includes('?') ? '&' : '?'}utm_source=qr&utm_medium=print`;
}

/** Minimal HTML escape for interpolating a plain-text name into the default disclosure. */
function esc(text) {
  return String(text ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Default disclosure text (Hector 2026-09-05), editable per partner. */
export function defaultCoverageDisclosure(partnerName = '') {
  const name = esc(String(partnerName || '').trim());
  const who = name ? ` con ${name}` : '';
  const whoEn = name ? ` with ${name}` : '';
  return {
    es: `<p><strong>Tu preferencia no está garantizada.</strong> El vehículo que recibas depende de la cobertura de tu póliza${who} y de la disponibilidad el día de la recogida. Te asignaremos el vehículo al momento de recogerlo.</p>`,
    en: `<p><strong>Your preference is not guaranteed.</strong> The vehicle you receive depends on the coverage of your policy${whoEn} and on availability on pickup day. We will assign your vehicle when you pick it up.</p>`
  };
}
