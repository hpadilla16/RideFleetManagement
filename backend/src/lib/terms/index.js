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
 * Per-tenant effective T&C HTML.
 *
 * If the tenant has a non-empty `termsHtml` override stored on the
 * `Tenant` row, that body is used and the five `{{INITIALS_*}}`
 * markers are substituted using the same rules as the canonical
 * renderer. Otherwise we fall through to `getCanonicalTermsHtml()`,
 * which keeps default behaviour unchanged for every tenant that has
 * not set a custom T&C.
 *
 * @param {string} tenantId - id of the tenant whose rental agreement
 *     is being rendered. Required; if falsy we just return canonical.
 * @param {object} deps
 * @param {import('@prisma/client').PrismaClient} deps.prisma - injected
 *     prisma client. Injected (not imported) so this module stays
 *     pure / mockable from tests.
 * @param {object} [opts]
 * @param {Record<string,string>} [opts.initials] - same shape as
 *     getCanonicalTermsHtml; merged into both the override path and
 *     the canonical-fallback path.
 * @returns {Promise<string>} HTML string with markers replaced.
 */
export async function getEffectiveTermsHtmlForTenant(tenantId, { prisma } = {}, opts = {}) {
  const initials = opts.initials || {};
  if (tenantId && prisma && typeof prisma.tenant?.findUnique === 'function') {
    let row = null;
    try {
      row = await prisma.tenant.findUnique({
        where: { id: tenantId },
        select: { termsHtml: true }
      });
    } catch {
      // DB error: fall through to canonical so rendering never fails
      // just because of a tenant-lookup hiccup.
      row = null;
    }
    const override = typeof row?.termsHtml === 'string' ? row.termsHtml.trim() : '';
    if (override) {
      let html = override;
      for (const key of INITIALS_KEYS) {
        const raw = initials[key];
        const replacement = raw ? escapeHtml(String(raw).trim()) : DEFAULT_BLANK;
        html = html.split(`{{${key}}}`).join(replacement);
      }
      return html;
    }
  }
  return getCanonicalTermsHtml({ initials });
}
