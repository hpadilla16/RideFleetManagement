/**
 * Sanitizer for operator-authored CONTRACT html (2026-09-09).
 *
 * ── WHY THIS EXISTS AND partner-sanitize.js DOES NOT COVER IT ───────────────
 * A branch's terms are rendered RAW into the customer's browser — the signing
 * page does `dangerouslySetInnerHTML` with whatever the cascade returns. Until
 * now nothing could write those fields from the app, so nothing sanitized them.
 * Giving admins a way to save them without a filter would put an admin-typed
 * <script> in front of every renter who signs.
 *
 * The partnerships allowlist cannot be reused. It admits paragraphs, lists and
 * headings h2-h4 only, and these documents are built from `div`, `section`,
 * `header`, `h1`, real `table`s, and — load-bearing — `class` and `lang`
 * attributes that carry the bilingual English/Spanish structure. Measured on
 * the three contracts in production: the canonical uses 18 distinct tags, LAX's
 * override 11. Running them through the partner filter would strip the document
 * to a wall of paragraphs and silently lose the Spanish markup.
 *
 * So the allowlist here is WIDER but drawn from what real contracts actually
 * contain, and the test asserts a round trip through it leaves the canonical
 * document's tag census unchanged. What stays out is the part that executes or
 * fetches: script, style, iframe, object, embed, form, inputs, every event
 * handler, and any scheme that is not http/https/mailto/tel.
 *
 * Applied ON WRITE. The readers — the signing page, the PDF, the preview —
 * keep trusting the database, exactly as they do today.
 */
import sanitizeHtml from 'sanitize-html';

/**
 * Tags a rental contract legitimately uses. Derived from the documents that
 * exist, not from imagination: anything added here should be because a real
 * contract needed it.
 */
export const ALLOWED_TAGS = Object.freeze([
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'p', 'br', 'hr', 'span', 'div', 'section', 'header', 'footer', 'article',
  'strong', 'b', 'em', 'i', 'u', 's', 'sup', 'sub', 'small',
  'ul', 'ol', 'li', 'dl', 'dt', 'dd', 'blockquote',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'caption', 'colgroup', 'col',
  'a',
]);

const OPTIONS = Object.freeze({
  allowedTags: [...ALLOWED_TAGS],
  allowedAttributes: {
    // `class` carries the layout and `lang` the bilingual structure; both are
    // inert. Deliberately NO `style`, `id`, `on*`, `srcset` or `data-*`.
    '*': ['class', 'lang', 'dir', 'colspan', 'rowspan', 'scope'],
    a: ['href', 'rel', 'target'],
    col: ['span'],
    colgroup: ['span'],
  },
  allowedSchemes: ['http', 'https', 'mailto', 'tel'],
  allowedSchemesAppliedToAttributes: ['href'],
  allowProtocolRelative: false,
  // Drop the tag but KEEP its text: a contract clause wrapped in an
  // unrecognised tag must not lose its wording, because losing a sentence from
  // a signed document is worse than losing its formatting.
  disallowedTagsMode: 'discard',
  // ...except for these, where the CONTENT is the danger, not the tag.
  nonTextTags: ['script', 'style', 'textarea', 'option', 'noscript', 'iframe', 'object', 'embed'],
  transformTags: {
    a: (tagName, attribs) => ({
      tagName: 'a',
      attribs: { ...attribs, rel: 'noopener noreferrer', target: '_blank' },
    }),
  },
});

/**
 * Sanitize contract HTML. Null/empty in → '' out. Never throws.
 *
 * Empty-in-empty-out matters: '' is how a branch says "I have no terms of my
 * own", which sends the cascade to the tenant. A sanitizer that turned a
 * cleared field into whitespace would make that branch look like it had an
 * override — and print a blank contract.
 */
export function sanitizeContractHtml(value) {
  const raw = value === null || value === undefined ? '' : String(value);
  if (!raw.trim()) return '';
  return sanitizeHtml(raw, OPTIONS).trim();
}

/**
 * What a sanitize pass would REMOVE, for showing an author before they save.
 * Pure, best-effort, and never throws: it exists to explain a change, not to
 * decide one.
 */
export function describeSanitizerImpact(value) {
  const before = value === null || value === undefined ? '' : String(value);
  const after = sanitizeContractHtml(before);
  const census = (html) => {
    const out = new Map();
    for (const m of html.matchAll(/<\s*\/?\s*([a-zA-Z][a-zA-Z0-9]*)/g)) {
      const t = m[1].toLowerCase();
      out.set(t, (out.get(t) || 0) + 1);
    }
    return out;
  };
  const a = census(before);
  const b = census(after);
  const removed = [];
  for (const [tag, n] of a) {
    const kept = b.get(tag) || 0;
    if (kept < n) removed.push({ tag, removed: n - kept });
  }
  return {
    changed: before.trim() !== after,
    removedTags: removed.sort((x, y) => y.removed - x.removed),
    lengthBefore: before.length,
    lengthAfter: after.length,
  };
}
