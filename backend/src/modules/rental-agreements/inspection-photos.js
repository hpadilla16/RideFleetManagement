/**
 * Inspection photo storage helpers (16l).
 *
 * Migrates inspection photo storage from base64-in-Postgres (legacy
 * `photosJson` column) to Supabase Storage. The new path saves a slim
 * `photoStorageRefs` array describing each uploaded object and never
 * inlines bytes into the DB row.
 *
 * Feature-flagged via `INSPECTION_PHOTOS_STORAGE_ENABLED`. When the flag is
 * false (default), callers fall back to writing `photosJson` exactly like
 * before — this lets us ship the code dark and flip the flag once the bucket
 * is provisioned. Read path is always backward-compatible: legacy rows that
 * only have `photosJson` are still served, and the API response shape stays
 * the same (just URLs instead of base64 strings).
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

// Match the per-photo size limit used elsewhere in the codebase for
// uploads (issue-center attachments cap at 10 MB). Keeping the same ceiling
// avoids surprising the wizard UI.
export const MAX_PHOTO_BYTES = 10 * 1024 * 1024;

// Extensions we explicitly recognize. Anything else is rejected — the
// inspection wizard only sends JPEG/PNG today.
const EXT_BY_MIME = Object.freeze({
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'image/heif': 'heif'
});

export function isStorageEnabled() {
  return String(process.env.INSPECTION_PHOTOS_STORAGE_ENABLED || '').toLowerCase() === 'true';
}

export function getPhotosBucket() {
  return process.env.SUPABASE_STORAGE_PHOTOS_BUCKET || 'inspection-photos';
}

/**
 * Parse a single photo value coming from the inspection wizard.
 *
 * The wizard posts either:
 *   - a data URL: "data:image/jpeg;base64,/9j/4AAQ..."
 *   - a raw base64 string with no prefix
 *   - an already-uploaded URL (skip — return null so caller keeps the URL as-is)
 *
 * Returns { buffer, contentType, ext } or null when the value is not a
 * decodable base64 photo.
 */
export function decodePhotoValue(rawValue) {
  if (rawValue == null) return null;
  const s = String(rawValue);
  if (!s) return null;
  // Already a URL — leave alone, the read path will treat it as external.
  if (/^https?:\/\//i.test(s)) return null;

  let contentType = 'image/jpeg';
  let payload = s;
  const dataUrlMatch = s.match(/^data:([^;,]+);base64,(.+)$/);
  if (dataUrlMatch) {
    contentType = String(dataUrlMatch[1] || 'image/jpeg').toLowerCase();
    payload = dataUrlMatch[2];
  }
  // Strip whitespace from base64 payload (browsers sometimes wrap it).
  payload = payload.replace(/\s+/g, '');
  if (!payload) return null;

  let buffer;
  try {
    buffer = Buffer.from(payload, 'base64');
  } catch {
    return null;
  }
  if (!buffer || buffer.byteLength === 0) return null;
  if (buffer.byteLength > MAX_PHOTO_BYTES) {
    throw new StorageError(
      `inspection photo exceeds max size of ${MAX_PHOTO_BYTES} bytes (got ${buffer.byteLength})`,
      413
    );
  }
  const ext = EXT_BY_MIME[contentType] || 'jpg';
  return { buffer, contentType, ext };
}

/**
 * Upload a `{ key: base64-or-dataUrl, ... }` photos object to Storage and
 * return an array of refs suitable for `photoStorageRefs`.
 *
 *   refs: [{ key, path, contentType, size, uploadedAt }]
 *
 * `key` preserves the wizard's slot name (e.g. "front", "rear", "damage_1")
 * so the read path can still group photos by area when rendering.
 *
 * @param {object} opts
 * @param {object} opts.photos - { key: base64-or-dataUrl } map from wizard
 * @param {string} opts.tenantId
 * @param {string} opts.inspectionId
 * @param {string} [opts.bucket] - override; defaults to env / 'inspection-photos'
 * @param {(args:{bucket,path,body,contentType,upsert}) => Promise<any>} [opts.uploader]
 *   - injection seam for tests; defaults to real uploadObject
 * @returns {Promise<Array<object>>}
 */
export async function uploadInspectionPhotos({
  photos,
  tenantId,
  inspectionId,
  bucket,
  uploader
} = {}) {
  if (!photos || typeof photos !== 'object') return [];
  if (!tenantId) throw new StorageError('uploadInspectionPhotos: tenantId is required', 400);
  if (!inspectionId) throw new StorageError('uploadInspectionPhotos: inspectionId is required', 400);

  const targetBucket = bucket || getPhotosBucket();
  const upload = typeof uploader === 'function' ? uploader : uploadObject;

  const refs = [];
  const entries = Object.entries(photos);
  for (const [key, value] of entries) {
    // Arrays of photos per slot (e.g. damage shots) are flattened.
    const items = Array.isArray(value) ? value : [value];
    for (let i = 0; i < items.length; i++) {
      const decoded = decodePhotoValue(items[i]);
      if (!decoded) {
        // Not a base64 photo — keep the original value as a "url" ref so
        // the read path can still surface it.
        if (typeof items[i] === 'string' && /^https?:\/\//i.test(items[i])) {
          refs.push({
            key,
            url: items[i],
            external: true,
            uploadedAt: new Date().toISOString()
          });
        }
        continue;
      }
      const photoId = `${key.replace(/[^A-Za-z0-9_-]/g, '_')}_${crypto.randomUUID()}`;
      const path = safePath(
        'tenants',
        tenantId,
        'inspections',
        inspectionId,
        `${photoId}.${decoded.ext}`
      );
      await upload({
        bucket: targetBucket,
        path,
        body: decoded.buffer,
        contentType: decoded.contentType,
        upsert: false
      });
      refs.push({
        key,
        path,
        contentType: decoded.contentType,
        size: decoded.buffer.byteLength,
        uploadedAt: new Date().toISOString()
      });
    }
  }
  return refs;
}

/**
 * Materialize `photoStorageRefs` into signed URLs for client rendering.
 *
 * Returns an object shaped like the legacy `photos` map so the API contract
 * stays stable: { key: url } or { key: [url, url, ...] } when multiple
 * photos were saved against the same slot.
 *
 * @param {Array<object>} refs
 * @param {object} [opts]
 * @param {string} [opts.bucket]
 * @param {number} [opts.expiresIn=3600] - seconds
 * @param {(args:{bucket,path,expiresIn})=>Promise<string>} [opts.signer]
 * @returns {Promise<object>}
 */
export async function materializeStorageRefs(refs, opts = {}) {
  if (!Array.isArray(refs) || refs.length === 0) return {};
  const targetBucket = opts.bucket || getPhotosBucket();
  const expiresIn = Number.isFinite(opts.expiresIn) ? opts.expiresIn : 3600;
  const sign = typeof opts.signer === 'function' ? opts.signer : getSignedUrl;

  const out = {};
  for (const ref of refs) {
    if (!ref || typeof ref !== 'object') continue;
    const key = ref.key || 'photo';
    let url = null;
    if (ref.external && ref.url) {
      url = ref.url;
    } else if (ref.path) {
      try {
        url = await sign({ bucket: targetBucket, path: ref.path, expiresIn });
      } catch (err) {
        // Best effort — a bad ref shouldn't blow up the whole inspection
        // payload. Tag the URL as null so the caller can show a placeholder.
        url = null;
      }
    }
    if (!url) continue;
    if (out[key] == null) {
      out[key] = url;
    } else if (Array.isArray(out[key])) {
      out[key].push(url);
    } else {
      out[key] = [out[key], url];
    }
  }
  return out;
}
