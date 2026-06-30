/**
 * Customer KYC document storage helpers (blob → Supabase Storage migration).
 *
 * Customer identity/insurance documents (ID photo, license back, insurance
 * document) historically live INLINE as base64 / data: URLs in three Postgres
 * columns:
 *   - Customer.idPhotoUrl
 *   - Customer.insuranceDocumentUrl
 *   - RentalAgreement.insuranceDocumentUrl  (snapshot copied from the customer)
 * (the columns are misnamed "Url" but in practice hold a `data:` URL).
 *
 * This module is the customer-side mirror of
 * `rental-agreements/inspection-photos.js`. It moves new uploads to Supabase
 * Storage (behind a feature flag) and signs storage paths on read. It also
 * supports application/pdf, since insurance documents are frequently PDFs and
 * can be larger than inspection photos — hence the 15MB byte cap.
 *
 * Design rules (locked spec):
 *   - Write path is feature-flagged (CUSTOMER_DOCS_STORAGE_ENABLED) and ships
 *     OFF. When OFF, behavior is byte-identical to today.
 *   - Write path is fail-SAFE: if the upload throws, the caller falls back to
 *     storing the base64 exactly as before. We NEVER lose a KYC doc or 500 a
 *     request because Storage hiccupped.
 *   - Read path is best-effort: signing errors return '' (never throw), matching
 *     the signedUrlSafe pattern in incident-report.service.js. Legacy inline
 *     base64 and external http(s) URLs pass through unchanged.
 *
 * ESM. No new npm deps.
 */

import crypto from 'node:crypto';
import {
  uploadObject,
  getSignedUrl,
  safePath,
  StorageError
} from '../../lib/storage/supabase-storage.js';

/**
 * Bucket holding customer KYC documents. Override via env so staging/prod can
 * point at different buckets.
 */
export const CUSTOMER_DOCS_BUCKET =
  process.env.SUPABASE_STORAGE_CUSTOMER_DOCS_BUCKET || 'customer-documents';

/**
 * Byte cap. Insurance PDFs can be meaningfully bigger than inspection photos
 * (which cap at 10MB), so we allow 15MB here.
 */
export const MAX_DOCUMENT_BYTES = 15 * 1024 * 1024;

/**
 * Document kinds we recognize. Used purely to namespace the storage key so an
 * operator browsing the bucket can tell an ID photo from an insurance doc.
 */
export const DOCUMENT_KINDS = Object.freeze(['id-photo', 'license-back', 'insurance']);

// MIME → file extension. Images AND PDF. Unknown image-ish types default to jpg
// (the historical inspection-photo behavior); a PDF is special-cased below so a
// PDF can never be mislabeled as jpg.
const EXT_BY_MIME = Object.freeze({
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'image/heif': 'heif',
  'application/pdf': 'pdf'
});

function isHttpUrl(s) {
  return /^https?:\/\//i.test(s);
}

function isDataUrl(s) {
  return /^data:/i.test(s);
}

/**
 * Heuristic: does this buffer look like a PDF? PDFs start with the magic
 * header `%PDF` (0x25 0x50 0x44 0x46).
 */
function looksLikePdf(buffer) {
  return (
    buffer &&
    buffer.length >= 4 &&
    buffer[0] === 0x25 && // %
    buffer[1] === 0x50 && // P
    buffer[2] === 0x44 && // D
    buffer[3] === 0x46    // F
  );
}

/**
 * Decode a single customer-document value.
 *
 * Input is one of:
 *   - a data URL: "data:application/pdf;base64,JVBERi0xLj..."
 *   - a data URL image: "data:image/jpeg;base64,/9j/4AAQ..."
 *   - a raw base64 string with no prefix
 *   - an already-hosted URL (http/https) — PASSED THROUGH
 *
 * Returns:
 *   - { passthrough: true, value }                        for http(s) URLs
 *   - { buffer, contentType, ext }                        for decodable base64
 *
 * Throws a typed StorageError for empty input or when the decoded payload
 * exceeds MAX_DOCUMENT_BYTES.
 */
export function decodeDocumentValue(raw) {
  if (raw == null) {
    throw new StorageError('decodeDocumentValue: value is empty', 400);
  }
  const s = String(raw);
  if (!s.trim()) {
    throw new StorageError('decodeDocumentValue: value is empty', 400);
  }

  // Already hosted — leave alone. The read path treats it as external.
  if (isHttpUrl(s)) {
    return { passthrough: true, value: s };
  }

  let contentType = 'image/jpeg';
  let declaredPdf = false;
  let payload = s;
  const dataUrlMatch = s.match(/^data:([^;,]+);base64,(.+)$/i);
  if (dataUrlMatch) {
    contentType = String(dataUrlMatch[1] || 'image/jpeg').toLowerCase();
    declaredPdf = contentType === 'application/pdf';
    payload = dataUrlMatch[2];
  }

  // Strip whitespace from the base64 payload (browsers sometimes wrap it).
  payload = payload.replace(/\s+/g, '');
  if (!payload) {
    throw new StorageError('decodeDocumentValue: value is empty', 400);
  }

  let buffer;
  try {
    buffer = Buffer.from(payload, 'base64');
  } catch {
    throw new StorageError('decodeDocumentValue: value is not valid base64', 400);
  }
  if (!buffer || buffer.byteLength === 0) {
    throw new StorageError('decodeDocumentValue: value decoded to empty buffer', 400);
  }
  if (buffer.byteLength > MAX_DOCUMENT_BYTES) {
    throw new StorageError(
      `customer document exceeds max size of ${MAX_DOCUMENT_BYTES} bytes (got ${buffer.byteLength})`,
      413
    );
  }

  // A PDF must always map to pdf, never jpg — even if the data: URL lied about
  // the mime or there was no data: prefix at all. Detect via the declared mime
  // OR the %PDF magic header.
  if (declaredPdf || looksLikePdf(buffer)) {
    return { buffer, contentType: 'application/pdf', ext: 'pdf' };
  }

  const ext = EXT_BY_MIME[contentType] || 'jpg';
  // Keep contentType consistent with the chosen ext for known types; unknown
  // image-ish types fall back to image/jpeg to match the jpg ext.
  const normalizedContentType = EXT_BY_MIME[contentType] ? contentType : 'image/jpeg';
  return { buffer, contentType: normalizedContentType, ext };
}

/**
 * Is `value` a Supabase Storage object path (as opposed to an http URL, a
 * data: URL, or raw inline base64)?
 *
 * Conservative on purpose: we only ever sign things we're confident are paths.
 *   - empty / non-string            → false
 *   - http(s) URL                   → false
 *   - data: URL                     → false
 *   - starts with "tenants/"        → true  (our canonical prefix)
 *   - contains "/" and does not look like padded base64 → true
 *   - otherwise (looks like raw base64 blob) → false
 */
export function isStoragePath(value) {
  if (typeof value !== 'string') return false;
  const s = value.trim();
  if (!s) return false;
  if (isHttpUrl(s)) return false;
  if (isDataUrl(s)) return false;

  // Canonical layout — always a path.
  if (s.startsWith('tenants/')) return true;

  // No slash → can't be one of our nested object paths.
  if (!s.includes('/')) return false;

  // Raw base64 blobs are long, contain no spaces, are drawn from the base64
  // alphabet, and frequently end in '=' padding. A real storage path has short
  // slash-delimited segments with file-system-friendly characters. If the value
  // looks like a single contiguous base64 token (very long, base64 alphabet,
  // optional trailing padding) treat it as inline data, NOT a path.
  const looksLikeBase64Blob =
    s.length > 100 && /^[A-Za-z0-9+/]+={0,2}$/.test(s);
  if (looksLikeBase64Blob) return false;

  return true;
}

/**
 * Upload one customer document to Storage and return the storage PATH string.
 *
 * If `raw` is already an http(s) URL it is returned unchanged (passthrough).
 *
 * @param {object} args
 * @param {string} args.raw        - data URL / raw base64 / http URL
 * @param {string} args.tenantId
 * @param {string} args.customerId
 * @param {('id-photo'|'license-back'|'insurance')} args.kind
 * @param {(a:{bucket,path,body,contentType,upsert})=>Promise<any>} [args.uploader]
 *   - injection seam for tests; defaults to real uploadObject
 * @returns {Promise<string>} storage path (or the original http URL when passthrough)
 */
export async function uploadCustomerDocument({ raw, tenantId, customerId, kind, uploader } = {}) {
  if (!tenantId) throw new StorageError('uploadCustomerDocument: tenantId is required', 400);
  if (!customerId) throw new StorageError('uploadCustomerDocument: customerId is required', 400);

  const decoded = decodeDocumentValue(raw);
  if (decoded.passthrough) {
    // Already hosted — keep the URL as-is.
    return decoded.value;
  }

  const safeKind = DOCUMENT_KINDS.includes(kind) ? kind : 'document';
  const upload = typeof uploader === 'function' ? uploader : uploadObject;
  const fileName = `${safeKind}_${crypto.randomUUID()}.${decoded.ext}`;
  const path = safePath('tenants', tenantId, 'customers', customerId, fileName);

  await upload({
    bucket: CUSTOMER_DOCS_BUCKET,
    path,
    body: decoded.buffer,
    contentType: decoded.contentType,
    upsert: true
  });

  return path;
}

/**
 * Materialize a stored document reference into something the client can render.
 *
 *   - empty value         → returned unchanged
 *   - http(s) URL         → passthrough
 *   - storage path        → signed URL (best-effort; '' on signing error)
 *   - legacy inline base64 → returned unchanged
 *
 * Best-effort by contract: ANY signing error returns '' rather than throwing,
 * so a single bad ref never breaks the whole payload.
 *
 * @param {string} value
 * @param {object} [opts]
 * @param {(a:{bucket,path,expiresIn})=>Promise<string>} [opts.signer]
 * @param {number} [opts.expiresIn=3600] - seconds
 * @returns {Promise<string>}
 */
export async function materializeDocumentRef(value, { signer, expiresIn = 3600 } = {}) {
  if (value == null || value === '') return value;
  const s = String(value);
  if (isHttpUrl(s)) return s;

  if (isStoragePath(s)) {
    const sign = typeof signer === 'function' ? signer : getSignedUrl;
    try {
      return await sign({ bucket: CUSTOMER_DOCS_BUCKET, path: s, expiresIn });
    } catch {
      return '';
    }
  }

  // Legacy inline base64 / data URL — leave unchanged.
  return value;
}

/**
 * Is the customer-document Storage write path enabled? Reads the feature flag.
 * Ships dark (OFF) by default — only 'true' (string) turns it on.
 */
export function customerDocsStorageEnabled() {
  return String(process.env.CUSTOMER_DOCS_STORAGE_ENABLED || '').toLowerCase() === 'true';
}

/**
 * DRY internal helper for the write sites. Given an incoming field value, decide
 * what to persist:
 *   - flag OFF                         → return the original value (no-op)
 *   - empty / not inline base64        → return the original value (no-op)
 *   - flag ON + inline base64/data-url → upload, return the storage PATH
 *   - upload throws                    → FALL BACK to the original value (+warn)
 *
 * This NEVER throws: a Storage failure degrades gracefully to the legacy inline
 * behavior so a KYC doc is never lost and the request never 500s.
 *
 * @param {string} value
 * @param {object} ctx
 * @param {string} ctx.tenantId
 * @param {string} ctx.customerId
 * @param {('id-photo'|'license-back'|'insurance')} ctx.kind
 * @param {(a:{bucket,path,body,contentType,upsert})=>Promise<any>} [ctx.uploader]
 * @param {{warn:Function}} [ctx.logger]
 * @returns {Promise<string>} the storage path (uploaded) OR the original value
 */
export async function maybeUploadCustomerDocument(value, { tenantId, customerId, kind, uploader, logger = console } = {}) {
  if (!customerDocsStorageEnabled()) return value;
  if (value == null || value === '') return value;
  const s = String(value);
  // Only migrate inline blobs. Anything already hosted or already a storage
  // path is left exactly as-is.
  if (isHttpUrl(s) || isStoragePath(s)) return value;
  // Must be decodable base64 / data URL to be worth uploading.
  if (!isDataUrl(s) && !/^[A-Za-z0-9+/\s]+={0,2}$/.test(s)) return value;
  if (!tenantId || !customerId) return value;

  try {
    return await uploadCustomerDocument({ raw: s, tenantId, customerId, kind, uploader });
  } catch (err) {
    // FAIL-SAFE: keep the base64 exactly as today. Never lose a doc, never 500.
    try {
      (logger?.warn || console.warn).call(
        logger || console,
        `[customer-docs] upload failed for kind=${kind} customer=${customerId} tenant=${tenantId}; falling back to inline storage: ${err?.message || err}`
      );
    } catch { /* logging must never throw */ }
    return value;
  }
}

export default {
  CUSTOMER_DOCS_BUCKET,
  MAX_DOCUMENT_BYTES,
  DOCUMENT_KINDS,
  decodeDocumentValue,
  isStoragePath,
  uploadCustomerDocument,
  materializeDocumentRef,
  customerDocsStorageEnabled,
  maybeUploadCustomerDocument
};
