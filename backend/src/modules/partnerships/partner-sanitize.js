/**
 * Partnerships — HTML sanitizer for partner-authored content (2026-09-05).
 *
 * Partner terms, landing copy and the coverage disclosure are typed by a tenant
 * admin in RFM and rendered on a PUBLIC page (partners.rentandgopr.com). Nothing
 * else in the repo sanitizes HTML: Location.termsRiderHtml is rendered raw, but
 * only on authenticated contract pages. A phished admin account must not be able
 * to plant a script in front of customers, so everything the public payload
 * carries goes through this allowlist ON WRITE (and the reader trusts the DB).
 *
 * Allowlist is deliberately small: paragraphs, lists, emphasis, headings h2-h4,
 * line breaks and http(s)/mailto/tel links. No images, no styles, no classes,
 * no ids, no event handlers, no data: / javascript: URLs.
 */
import sanitizeHtml from 'sanitize-html';

const OPTIONS = Object.freeze({
  allowedTags: ['p', 'br', 'ul', 'ol', 'li', 'strong', 'b', 'em', 'i', 'u', 'a', 'h2', 'h3', 'h4', 'blockquote'],
  allowedAttributes: { a: ['href', 'rel', 'target'] },
  allowedSchemes: ['http', 'https', 'mailto', 'tel'],
  allowedSchemesAppliedToAttributes: ['href'],
  allowProtocolRelative: false,
  disallowedTagsMode: 'discard',
  transformTags: {
    a: (tagName, attribs) => ({
      tagName: 'a',
      attribs: { ...attribs, rel: 'noopener noreferrer', target: '_blank' }
    })
  }
});

/** Sanitize one HTML string. Null/empty in → '' out. Never throws. */
export function sanitizePartnerHtml(value) {
  const raw = value === null || value === undefined ? '' : String(value);
  if (!raw.trim()) return '';
  return sanitizeHtml(raw, OPTIONS).trim();
}

const NAMED_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/** Decode the entities sanitize-html leaves in text nodes ("Tom &amp; Jerry" → "Tom & Jerry"). */
function decodeEntities(text) {
  return String(text).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, body) => {
    const key = body.toLowerCase();
    if (key.startsWith('#x')) { const cp = parseInt(key.slice(2), 16); return Number.isFinite(cp) ? String.fromCodePoint(cp) : match; }
    if (key.startsWith('#')) { const cp = parseInt(key.slice(1), 10); return Number.isFinite(cp) ? String.fromCodePoint(cp) : match; }
    return Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, key) ? NAMED_ENTITIES[key] : match;
  });
}

/** Escape plain text for interpolation INTO an HTML string (the reverse of the above). */
export function escapeHtmlText(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Plain text (no tags at all) — for names, titles, eyebrows, benefit lines, CTA
 * labels. Tags are stripped and the result is DECODED back to plain text:
 * sanitize-html re-escapes text nodes, so without the decode a partner named
 * "Seguros & Asociados" would be stored as "Seguros &amp; Asociados" and React
 * (which escapes on render) would show the literal "&amp;". Stored value is
 * plain text; every renderer escapes it itself.
 */
export function sanitizePartnerText(value, { maxLength = 500 } = {}) {
  const raw = value === null || value === undefined ? '' : String(value);
  if (!raw.trim()) return '';
  const stripped = sanitizeHtml(raw, { allowedTags: [], allowedAttributes: {} });
  return decodeEntities(stripped).replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

const LOCALES = ['es', 'en'];

/** {es: html, en: html} → same shape, every value sanitized; unknown keys dropped. */
export function sanitizeLocalizedHtml(value) {
  const out = {};
  const src = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  for (const locale of LOCALES) out[locale] = sanitizePartnerHtml(src[locale]);
  return out;
}

const BENEFIT_ICONS = new Set(['percent', 'user-plus', 'truck', 'plane', 'shield', 'clock', 'map-pin', 'car', 'check', 'star']);

/**
 * landingJson: {es:{eyebrow,heroTitle,heroSubtitle,partnerNote,benefits[],ctaLabel}, en:{...}}
 * Text fields → plain text. benefits → max 6 of {icon (from a fixed set), title, body}.
 */
export function sanitizeLandingJson(value) {
  const out = {};
  const src = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  for (const locale of LOCALES) {
    const block = src[locale] && typeof src[locale] === 'object' ? src[locale] : {};
    const benefits = Array.isArray(block.benefits) ? block.benefits.slice(0, 6) : [];
    out[locale] = {
      eyebrow: sanitizePartnerText(block.eyebrow, { maxLength: 120 }),
      heroTitle: sanitizePartnerText(block.heroTitle, { maxLength: 160 }),
      heroSubtitle: sanitizePartnerText(block.heroSubtitle, { maxLength: 400 }),
      partnerNote: sanitizePartnerText(block.partnerNote, { maxLength: 300 }),
      ctaLabel: sanitizePartnerText(block.ctaLabel, { maxLength: 60 }),
      benefits: benefits
        .map((b) => ({
          icon: BENEFIT_ICONS.has(String(b?.icon || '')) ? String(b.icon) : 'check',
          title: sanitizePartnerText(b?.title, { maxLength: 80 }),
          body: sanitizePartnerText(b?.body, { maxLength: 240 })
        }))
        .filter((b) => b.title)
    };
  }
  return out;
}

export const PARTNER_SANITIZE_ALLOWED_TAGS = OPTIONS.allowedTags;
