// Loader + renderer for the canonical Terms & Conditions.
//
// Reads tc-<TC_VERSION>.html from disk on first call and caches it in
// memory. Two output modes:
//
//   getCanonicalTermsHtml({ initials })    — full bilingual HTML with the
//                                            five {{INITIALS_*}} markers
//                                            replaced by either captured
//                                            initials text (signed flow)
//                                            or empty underscores (blank
//                                            agreement for signing).
//
//   getCanonicalTermsPlainText()           — best-effort plain-text strip
//                                            for the legacy {{termsText}}
//                                            placeholder in old templates.
//                                            New templates should embed
//                                            the HTML directly.
//
// Both are pure functions over the cached source; safe to call from hot
// paths.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { TC_VERSION, TC_HTML_FILENAME } from './version.js';
import logger from '../logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TC_PATH = join(__dirname, TC_HTML_FILENAME);

let cachedHtml = null;

function loadHtml() {
  if (cachedHtml == null) {
    cachedHtml = readFileSync(TC_PATH, 'utf8');
  }
  return cachedHtml;
}

// The five {{INITIALS_*}} markers used inside tc-<version>.html.
// Kept centralized so the print template + the sign endpoint agree on
// the shape of the `initials` object passed to getCanonicalTermsHtml().
export const INITIALS_KEYS = Object.freeze([
  'INITIALS_S4_DECLINE',        // Section 4 — decline of optional coverage
  'INITIALS_S11_CARD_ON_FILE',  // Section 11 — card-on-file authorization
  'INITIALS_S11_CNP',           // Section 11 — card-not-present
  'INITIALS_S11_NO_CHARGEBACK', // Section 11 — no chargeback
  'INITIALS_S13_POST_RENTAL'    // Section 13 — post-rental charges
]);

// Default rendering of an unsigned initial slot. Three underscores
// matches the PDF visual: "( ___ Initials )".
const DEFAULT_BLANK = '___';

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Get the bilingual T&C HTML with initials substituted.
 *
 * @param {object} [opts]
 * @param {Record<string,string>} [opts.initials] - keyed by INITIALS_KEYS;
 *     missing keys render as DEFAULT_BLANK ("___").
 * @returns {string} full HTML
 */
export function getCanonicalTermsHtml(opts = {}) {
  const initials = opts.initials || {};
  let html = loadHtml();
  for (const key of INITIALS_KEYS) {
    const raw = initials[key];
    const replacement = raw ? escapeHtml(String(raw).trim()) : DEFAULT_BLANK;
    html = html.split(`{{${key}}}`).join(replacement);
  }
  return html;
}

/**
 * Plain-text fallback for legacy renderers that only accept {{termsText}}
 * as a `white-space: pre-wrap` block. Strips tags but keeps section
 * headings + paragraph breaks reasonably readable.
 *
 * @returns {string}
 */
export function getCanonicalTermsPlainText() {
  return loadHtml()
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<\/(p|li|h1|h2|h3|tr)>/gi, '\n')
    .replace(/<br\s*\/?\s*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&[a-z]+;/gi, (m) => {
      // Common Latin-1 supplements that show up in the bilingual text.
      const map = {
        '&aacute;': 'á', '&eacute;': 'é', '&iacute;': 'í', '&oacute;': 'ó', '&uacute;': 'ú',
        '&Aacute;': 'Á', '&Eacute;': 'É', '&Iacute;': 'Í', '&Oacute;': 'Ó', '&Uacute;': 'Ú',
        '&ntilde;': 'ñ', '&Ntilde;': 'Ñ',
        '&iexcl;': '¡', '&iquest;': '¿',
        '&ldquo;': '“', '&rdquo;': '”', '&lsquo;': '‘', '&rsquo;': '’',
        '&mdash;': '—', '&ndash;': '–'
      };
      return map[m] || m;
    })
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export { TC_VERSION };

/**
 * Append a branch rider to the resolved base agreement.
 *
 * The rider is wrapped in its own <section> so the print CSS and anyone reading
 * the contract can see where the branch's local policies begin. Its markers get
 * substituted too — a rider may legitimately carry its own initials line.
 *
 * Order matters and is deliberate: the rider comes LAST so it reads as a rider,
 * and so that where it restates a general term (mileage allowance, deposit
 * tier) the branch-specific figure is the one the customer reads second.
 */
function withRider(baseHtml, riderHtml, initials = {}) {
  const rider = typeof riderHtml === 'string' ? riderHtml.trim() : '';
  if (!rider) return baseHtml;
  return `${baseHtml}\n<section class="tc-location-rider">\n${applyInitials(rider, initials)}\n</section>`;
}

/** Substitute the five {{INITIALS_*}} markers into an override body. */
function applyInitials(html, initials = {}) {
  let out = html;
  for (const key of INITIALS_KEYS) {
    const raw = initials[key];
    const replacement = raw ? escapeHtml(String(raw).trim()) : DEFAULT_BLANK;
    out = out.split(`{{${key}}}`).join(replacement);
  }
  return out;
}

/**
 * Effective T&C HTML for a rental, resolved LOCATION → TENANT → CANONICAL.
 *
 * The first non-empty override in that chain wins, and its five
 * `{{INITIALS_*}}` markers are substituted with the same rules as the
 * canonical renderer. A tenant or branch that has set nothing renders exactly
 * what it renders today.
 *
 * WHY THE LOCATION LAYER (2026-07-24): a multi-branch tenant can operate under
 * different terms per branch. Corpusa's LAX runs on Rightcars' California
 * agreement — 9.5% local tax, a 150-mile/day cap and a $2,000 deposit for
 * California-licensed renters — while its Orlando, Miami and Fort Lauderdale
 * branches do not. With only the tenant slot, loading LAX's terms would have
 * silently rebound the other three to a California agreement.
 *
 * VERSIONING IS DELIBERATELY NOT PER-BRANCH. `TC_VERSION` stays global and is
 * what gets stamped on the reservation — exactly as it already is for the
 * tenant-level override, which has never bumped it either. Making the version
 * branch-dependent would make `autochargeBlocked` mean something different
 * depending on where a car was picked up, and that flag gates money.
 *
 * Fail-soft on DB errors at every level: a lookup hiccup falls through to the
 * next layer rather than failing the render. An agreement that renders slightly
 * generic terms beats an agreement that will not render.
 *
 * @param {object} target
 * @param {string} [target.tenantId] - tenant whose agreement is rendering.
 * @param {string} [target.locationId] - the rental's PICKUP location. Omit for
 *     tenant-level resolution (the pre-2026-07-24 behaviour).
 * @param {object} deps
 * @param {import('@prisma/client').PrismaClient} deps.prisma - injected (not
 *     imported) so this module stays pure / mockable from tests.
 * @param {object} [opts]
 * @param {Record<string,string>} [opts.initials] - same shape as
 *     getCanonicalTermsHtml; merged into every path.
 * @returns {Promise<string>} HTML with markers replaced.
 */
export async function getEffectiveTermsHtml({ tenantId, locationId } = {}, { prisma } = {}, opts = {}) {
  const initials = opts.initials || {};
  // Branch RIDER, resolved alongside the branch override in the same read and
  // appended to whichever base wins below. Not an override: the branch keeps the
  // canonical agreement — including the §11 card-on-file pre-authorization the
  // tolls/citations modules rely on to bill after a rental closes — and only ADDS
  // its local policies. See the schema comment on Location.termsRiderHtml.
  let riderHtml = '';

  // 1. Branch override wins.
  if (locationId && prisma && typeof prisma.location?.findUnique === 'function') {
    let row = null;
    try {
      row = await prisma.location.findUnique({
        where: { id: locationId },
        select: { termsHtml: true, termsRiderHtml: true }
      });
    } catch (err) {
      // MUST be logged, not just swallowed. Without this line a stale Prisma
      // client (one generated before Location.termsHtml existed — the dev
      // Dockerfile does not run `prisma generate`), a migration that failed
      // (startup-migrate.js is fail-open and does not record a failure, so a
      // missing column throws forever), and a branch that genuinely has no
      // override all produce BYTE-IDENTICAL output: the tenant's terms. That is
      // a wrong legal document with no signal anywhere.
      row = null;
      logger.error('[terms] location override lookup failed — falling back to tenant/canonical terms', {
        locationId,
        tenantId: tenantId || null,
        message: String(err?.message || err),
      });
    }
    riderHtml = typeof row?.termsRiderHtml === 'string' ? row.termsRiderHtml.trim() : '';
    const override = typeof row?.termsHtml === 'string' ? row.termsHtml.trim() : '';
    if (override) return withRider(applyInitials(override, initials), riderHtml, initials);
  }

  // 2. Tenant override.
  if (tenantId && prisma && typeof prisma.tenant?.findUnique === 'function') {
    let row = null;
    try {
      row = await prisma.tenant.findUnique({
        where: { id: tenantId },
        select: { termsHtml: true }
      });
    } catch (err) {
      // DB error: fall through to canonical so rendering never fails just
      // because of a tenant-lookup hiccup. Logged for the same reason as the
      // location lookup above — silence here is a wrong legal document.
      row = null;
      logger.error('[terms] tenant override lookup failed — falling back to canonical terms', {
        tenantId,
        message: String(err?.message || err),
      });
    }
    const override = typeof row?.termsHtml === 'string' ? row.termsHtml.trim() : '';
    if (override) return withRider(applyInitials(override, initials), riderHtml, initials);
  }

  // 3. Canonical.
  return withRider(getCanonicalTermsHtml({ initials }), riderHtml, initials);
}

/**
 * Tenant-only resolution. Kept as the pre-2026-07-24 entry point so existing
 * callers and tests are unaffected; new code should call getEffectiveTermsHtml
 * and pass the pickup location so a branch override can win.
 */
export async function getEffectiveTermsHtmlForTenant(tenantId, { prisma } = {}, opts = {}) {
  return getEffectiveTermsHtml({ tenantId }, { prisma }, opts);
}
