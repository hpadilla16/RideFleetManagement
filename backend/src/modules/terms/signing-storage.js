/**
 * Signing storage helper (2026-05-21).
 *
 * Saves customer signatures (and Dejavoo terminal-captured signature PNGs)
 * to Supabase Storage under a per-tenant + per-reservation path scheme.
 *
 * Path scheme:
 *   tenants/<tenantId>/reservations/<reservationId>/signing/<fieldKey>.<ext>
 *   tenants/<tenantId>/reservations/<reservationId>/signing/receipt-<ts>.<ext>
 *   tenants/<tenantId>/reservations/<reservationId>/signing/agreement-<ts>.pdf
 *
 * Bucket: `customer-signatures` (new, separate from the 16h
 * `inspection-photos` bucket — different lifecycle policy and access pattern).
 *
 * No feature flag — this helper is invoked only by callers that have
 * already passed their own gates (terms-signing.service, payment-gateway
 * orchestrator). The helper itself just performs I/O.
 *
 * Design doc: doc/interactive-tc-and-dejavoo-unified-2026-05-21.md §8
 */

import crypto from 'node:crypto';
import {
  uploadObject,
  getSignedUrl,
  deleteObject,
  safePath,
  StorageError,
} from '../../lib/storage/supabase-storage.js';

export const SIGNING_BUCKET = process.env.SUPABASE_STORAGE_SIGNATURES_BUCKET
  || 'customer-signatures';

// 5 MB cap — agreement-level signatures from a tablet canvas are tiny SVG,
// PNG terminal captures are usually <500 KB. The cap exists to fail loud
// if something goes wrong (e.g. attempting to upload a video).
const MAX_BYTES = 5 * 1024 * 1024;

const EXT_BY_MIME = Object.freeze({
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/svg+xml': 'svg',
  'application/pdf': 'pdf',
});

function resolveExtension(contentType) {
  const ct = (contentType || 'image/png').toLowerCase();
  return EXT_BY_MIME[ct] || 'bin';
}

function decodeBase64MaybeDataUrl(input) {
  if (input == null) return null;
  if (Buffer.isBuffer(input)) return input;
  if (typeof input !== 'string') return null;
  // Strip data: URL prefix if present (data:image/png;base64,...)
  const m = input.match(/^data:[^;,]+(;base64)?,(.*)$/);
  const payload = m ? m[2] : input;
  try {
    const buf = Buffer.from(payload, 'base64');
    return buf.byteLength > 0 ? buf : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Upload a signature blob captured from the Dejavoo terminal (PNG) or the
 * tablet canvas (PNG or SVG).
 *
 * @param {object} args
 * @param {string} args.tenantId
 * @param {string} args.reservationId
 * @param {string} args.fieldKey           — TermsTemplateField.markerKey
 * @param {Buffer|string} args.body         — Buffer OR base64 string OR data:URL
 * @param {string} [args.contentType]       — defaults to 'image/png'
 * @param {string} [args.kind]              — 'agreement' | 'receipt' | 'initial' (for the filename)
 * @param {string} [args.bucket]            — override
 * @param {Function} [args.uploader]        — test seam; defaults to real uploadObject
 * @returns {Promise<{ storagePath, contentType, sizeBytes, bucket }>}
 */
export async function uploadSignatureBlob({
  tenantId,
  reservationId,
  fieldKey,
  body,
  contentType,
  kind,
  bucket,
  uploader,
} = {}) {
  if (!tenantId) throw new StorageError('uploadSignatureBlob: tenantId required', 400);
  if (!reservationId) throw new StorageError('uploadSignatureBlob: reservationId required', 400);
  if (!fieldKey) throw new StorageError('uploadSignatureBlob: fieldKey required', 400);

  const buf = decodeBase64MaybeDataUrl(body);
  if (!buf || buf.byteLength === 0) {
    throw new StorageError('uploadSignatureBlob: body is empty or invalid', 400);
  }
  if (buf.byteLength > MAX_BYTES) {
    throw new StorageError(
      `uploadSignatureBlob: body exceeds max size of ${MAX_BYTES} bytes (got ${buf.byteLength})`,
      413
    );
  }

  const normalizedCT = (contentType || 'image/png').toLowerCase();
  const ext = resolveExtension(normalizedCT);
  // Filename: <kind>-<fieldKey>-<uuid> so re-takes within a session don't
  // overwrite previous attempts (audit trail preserved).
  const safeKey = String(fieldKey).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 60);
  const prefix = kind || 'sig';
  const fileName = `${prefix}-${safeKey}-${crypto.randomUUID().slice(0, 8)}.${ext}`;
  const path = safePath('tenants', tenantId, 'reservations', reservationId, 'signing', fileName);

  const upload = typeof uploader === 'function' ? uploader : uploadObject;
  await upload({
    bucket: bucket || SIGNING_BUCKET,
    path,
    body: buf,
    contentType: normalizedCT,
    upsert: false,
  });

  return {
    storagePath: path,
    contentType: normalizedCT,
    sizeBytes: buf.byteLength,
    bucket: bucket || SIGNING_BUCKET,
  };
}

/**
 * Upload the final stitched-and-rendered PDF for a completed ReservationSigning.
 * Same bucket, different filename pattern.
 *
 * @param {object} args
 * @param {string} args.tenantId
 * @param {string} args.reservationId
 * @param {Buffer} args.pdfBuffer
 * @returns {Promise<{ storagePath, contentType, sizeBytes, bucket }>}
 */
export async function uploadSignedAgreementPdf({
  tenantId,
  reservationId,
  pdfBuffer,
  bucket,
  uploader,
} = {}) {
  if (!tenantId) throw new StorageError('uploadSignedAgreementPdf: tenantId required', 400);
  if (!reservationId) throw new StorageError('uploadSignedAgreementPdf: reservationId required', 400);
  if (!Buffer.isBuffer(pdfBuffer) || pdfBuffer.byteLength === 0) {
    throw new StorageError('uploadSignedAgreementPdf: pdfBuffer must be a non-empty Buffer', 400);
  }
  if (pdfBuffer.byteLength > MAX_BYTES * 4) {
    // PDFs can be larger; raise the ceiling 4x for them.
    throw new StorageError(
      `uploadSignedAgreementPdf: pdfBuffer exceeds ${MAX_BYTES * 4} bytes`,
      413
    );
  }

  const ts = Date.now();
  const fileName = `agreement-${ts}.pdf`;
  const path = safePath('tenants', tenantId, 'reservations', reservationId, 'signing', fileName);

  const upload = typeof uploader === 'function' ? uploader : uploadObject;
  await upload({
    bucket: bucket || SIGNING_BUCKET,
    path,
    body: pdfBuffer,
    contentType: 'application/pdf',
    upsert: false,
  });

  return {
    storagePath: path,
    contentType: 'application/pdf',
    sizeBytes: pdfBuffer.byteLength,
    bucket: bucket || SIGNING_BUCKET,
  };
}

/**
 * Sign a stored signature/PDF for short-lived display.
 */
export async function signSignatureUrl(storagePath, opts = {}) {
  if (!storagePath) throw new StorageError('signSignatureUrl: storagePath required', 400);
  const expiresIn = Number.isFinite(opts.expiresIn) ? opts.expiresIn : 3600;
  const sign = typeof opts.signer === 'function' ? opts.signer : getSignedUrl;
  return sign({
    bucket: opts.bucket || SIGNING_BUCKET,
    path: storagePath,
    expiresIn,
  });
}

/**
 * Batch-sign rows that have a `storagePath` field. Returns rows with
 * `signedUrl` added. Errors per row degrade to `signedUrl: null`.
 */
export async function signSignatureUrls(rows, opts = {}) {
  if (!Array.isArray(rows) || rows.length === 0) return [];
  const out = new Array(rows.length);
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const path = row?.storagePath || row?.signatureSvgOrPath;
    if (!path) {
      out[i] = { ...(row || {}), signedUrl: null };
      continue;
    }
    try {
      out[i] = { ...row, signedUrl: await signSignatureUrl(path, opts) };
    } catch {
      out[i] = { ...row, signedUrl: null };
    }
  }
  return out;
}

/**
 * Delete a stored signature. Idempotent (404 swallowed).
 */
export async function deleteSignatureBlob(storagePath, opts = {}) {
  if (!storagePath) throw new StorageError('deleteSignatureBlob: storagePath required', 400);
  const del = typeof opts.deleter === 'function' ? opts.deleter : deleteObject;
  try {
    await del({
      bucket: opts.bucket || SIGNING_BUCKET,
      path: storagePath,
    });
  } catch (err) {
    if (err && err.status === 404) return;
    throw err;
  }
}
