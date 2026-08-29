/**
 * citation-attachments — pure helpers for supporting documents on a citation.
 *
 * No prisma, no storage, no network: everything here is a pure function so the
 * rules (document types, the MIME allowlist, the size cap, the payment-card
 * warning) can be tested without a database. The service layer next door does
 * the I/O.
 *
 * READ citation-attachments.service.js's header before touching this — these
 * documents must never reach the OCR pipeline.
 */

/**
 * The controlled document-type list. Free text here would be unfixable once
 * operators had typed a hundred variants of "receipt", so the list is closed
 * and anything unrecognised falls to OTHER rather than being rejected (an
 * upload failing because of a dropdown value is a worse outcome than a
 * mislabelled document).
 */
export const ATTACHMENT_DOC_TYPES = Object.freeze([
  'AGENCY_NOTICE',
  'PROOF_OF_PAYMENT',
  'DISPUTE_LETTER',
  'AGENCY_RESPONSE',
  'CUSTOMER_CORRESPONDENCE',
  'RENTAL_DOCUMENT',
  'OTHER',
]);

export const ATTACHMENT_STATUS = Object.freeze({ ACTIVE: 'ACTIVE', ARCHIVED: 'ARCHIVED' });

/** 15MB, matching the citation-notice cap (CITATION_DOC_MAX_BYTES). */
export const ATTACHMENT_MAX_BYTES = 15 * 1024 * 1024;

/**
 * MIME allowlist. PDFs and images are the two kinds the export can physically
 * append; the office formats are accepted because operators genuinely receive
 * dispute correspondence as .docx, but the export lists them instead of
 * embedding them (and says so on the cover, so nobody assumes the bundle is
 * complete when it is not).
 *
 * Anything not on this list is refused at upload. An allowlist, never a
 * denylist: the failure mode of a denylist is that the one thing you forgot is
 * the one thing that hurts.
 */
export const ATTACHMENT_MIME_ALLOWLIST = Object.freeze({
  'application/pdf': 'pdf',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'image/tiff': 'tiff',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'text/plain': 'txt',
  'message/rfc822': 'eml',
});

/** Types the export can append as real pages. Everything else is listed only. */
export const EMBEDDABLE_MIMES = Object.freeze([
  'application/pdf', 'image/jpeg', 'image/png', 'image/webp',
]);

export function normalizeDocType(value) {
  const v = String(value || '').trim().toUpperCase();
  return ATTACHMENT_DOC_TYPES.includes(v) ? v : 'OTHER';
}

export function isAllowedMime(mime) {
  return Object.prototype.hasOwnProperty.call(ATTACHMENT_MIME_ALLOWLIST, String(mime || '').toLowerCase());
}

export function extForMime(mime) {
  return ATTACHMENT_MIME_ALLOWLIST[String(mime || '').toLowerCase()] || 'bin';
}

/** Can the export embed this attachment as pages, or only name it? */
export function isEmbeddable(mime) {
  return EMBEDDABLE_MIMES.includes(String(mime || '').toLowerCase());
}

export function isPdfMime(mime) {
  return String(mime || '').toLowerCase() === 'application/pdf';
}

export function isImageMime(mime) {
  const m = String(mime || '').toLowerCase();
  return m.startsWith('image/') && EMBEDDABLE_MIMES.includes(m);
}

/**
 * ── THE PCI PROMPT ────────────────────────────────────────────────────────
 * Does this upload look like it might carry payment card data?
 *
 * The platform is PCI SAQ C certified and stores no card number anywhere. A
 * photographed receipt showing a full PAN would be a NEW exposure and would
 * move the assessment toward SAQ D — for a file nobody needed to keep.
 *
 * This is deliberately a WARNING and never a block. We cannot read a PAN out
 * of a photo reliably, and a false negative that silently blocked a genuine
 * dispute document would cost an operator their case. So this is a heuristic
 * over the METADATA the operator gives us — the document type they chose and
 * the words in the filename and label — and the answer is a confirmation
 * prompt, not a refusal. Cheap insurance, per the plan.
 *
 * We do NOT scan file bytes: OCR-ing every upload looking for card numbers
 * would send exactly the documents this feature exists to protect through an
 * analysis path, which is the thing we are avoiding.
 */
const CARD_HINT_PATTERN = /\b(receipt|recibo|card|tarjeta|visa|mastercard|amex|american\s*express|discover|invoice|factura|payment|pago|statement|estado\s*de\s*cuenta)\b/i;

export function mayContainCardData({ docType, fileName, label } = {}) {
  // A "proof of payment" is by definition a payment artefact — always prompt.
  if (normalizeDocType(docType) === 'PROOF_OF_PAYMENT') return true;
  const haystack = `${fileName || ''} ${label || ''}`;
  return CARD_HINT_PATTERN.test(haystack);
}

/** The operator-facing wording, kept next to the rule that triggers it. */
export const CARD_WARNING_CODE = 'CARD_DATA_CONFIRMATION_REQUIRED';
export const CARD_WARNING_MESSAGE =
  'This looks like it may be a payment document. Do not upload anything showing a full '
  + 'card number — mask all but the last 4 digits first. Confirm to continue.';
