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
  downloadObject,
  getSignedUrl,
  safePath,
  StorageError
} from '../../lib/storage/supabase-storage.js';
import { canonicalPhotoKey } from './inspection-photos-normalize.js';

// Match the per-photo size limit used elsewhere in the codebase for
// uploads (issue-center attachments cap at 10 MB). Keeping the same ceiling
// avoids surprising the wizard UI.
export const MAX_PHOTO_BYTES = 10 * 1024 * 1024;

// Decoded buffers smaller than this are almost certainly not a real image
// (the prod incident produced 9-byte "[object Object]" buffers). We rely on
// magic-header validation as the real guard, but this floor is a cheap
// first-line sanity check used in logging/diagnostics.
export const MIN_PLAUSIBLE_IMAGE_BYTES = 100;

/**
 * Does this buffer start with a plausible image magic header?
 *   - JPEG : FF D8 FF
 *   - PNG  : 89 50 4E 47 0D 0A 1A 0A
 *   - GIF  : 'GIF87a' / 'GIF89a'
 *   - WEBP : 'RIFF' .... 'WEBP'
 *   - HEIC/HEIF : .... 'ftyp' (offset 4) — covers heic/heif/mif1/avif boxes
 *   - BMP  : 'BM'
 * Anything else (e.g. the 9-byte garbage from stringifying an object) is
 * rejected so we never upload a non-image at the source.
 */
export function looksLikeImage(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4) return false;
  // JPEG
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return true;
  // PNG
  if (
    buffer.length >= 8 &&
    buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47 &&
    buffer[4] === 0x0d && buffer[5] === 0x0a && buffer[6] === 0x1a && buffer[7] === 0x0a
  ) return true;
  // GIF
  if (buffer.length >= 6) {
    const sig = buffer.toString('ascii', 0, 6);
    if (sig === 'GIF87a' || sig === 'GIF89a') return true;
  }
  // BMP
  if (buffer[0] === 0x42 && buffer[1] === 0x4d) return true;
  // WEBP: 'RIFF' .... 'WEBP'
  if (
    buffer.length >= 12 &&
    buffer.toString('ascii', 0, 4) === 'RIFF' &&
    buffer.toString('ascii', 8, 12) === 'WEBP'
  ) return true;
  // HEIC/HEIF/AVIF: ISO-BMFF box with 'ftyp' brand at offset 4.
  if (buffer.length >= 12 && buffer.toString('ascii', 4, 8) === 'ftyp') return true;
  return false;
}

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
  // HARDENED (prod incident 2026-06): NEVER String() a non-string. The mobile
  // array format stores each photo as an OBJECT ({key,dataUrl,...}); the old
  // code did String(object) -> "[object Object]" -> Buffer.from(...,'base64')
  // -> ~9 bytes of GARBAGE that got uploaded and then nulled the real
  // photosJson. A non-string value is NEVER a decodable photo here — return
  // null and let the caller's normalizer extract the real base64 field.
  if (typeof rawValue !== 'string') return null;
  const s = rawValue;
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
  // HARDENED: validate the decoded bytes actually look like an image. This
  // stops garbage at the source (e.g. base64 of "[object Object]" decodes to
  // 9 bytes that are NOT an image). Without this, junk could be uploaded and
  // recorded as a "real" ref.
  if (!looksLikeImage(buffer)) return null;
  const ext = EXT_BY_MIME[contentType] || 'jpg';
  return { buffer, contentType, ext };
}

/**
 * Normalize the THREE real production photosJson shapes into a uniform list of
 * { slot, value } where value is a base64/data-url STRING (or an http(s) URL
 * string that the caller will pass through as external).
 *
 * Shapes (confirmed in prod):
 *   1. OBJECT of strings  : { front: "data:...", rear: "<b64>" }
 *   2. OBJECT of nulls    : { front: null, rear: null }            -> skipped
 *   3. ARRAY of objects   : [{ key, dataUrl, notes, ... }, ...]    -> dataUrl
 *   + ARRAY of strings    : ["<b64>", ...]                          -> slot=index
 *   + per-slot arrays     : { damage: ["<b64>", "<b64>"] }         -> flattened
 *
 * Anything that is an OBJECT without a usable base64 field, or a non-string
 * non-extractable value, is NOT stringified — it is pushed to `skipped` so the
 * caller can count/log it. We never silently turn junk into an upload.
 *
 * @returns {{ items: Array<{slot:string, value:string}>, skipped: Array<{slot:string, reason:string}> }}
 */
export function normalizePhotosForUpload(photos) {
  const items = [];
  const skipped = [];
  if (!photos || typeof photos !== 'object') return { items, skipped };

  const pushValue = (slot, value, idx) => {
    const finalSlot =
      slot != null && String(slot).length > 0 ? String(slot) : String(idx);
    if (typeof value === 'string') {
      items.push({ slot: finalSlot, value });
      return;
    }
    if (value == null) {
      // Format #2 empty slot — legitimately skip, not junk.
      return;
    }
    if (typeof value === 'object' && !Array.isArray(value)) {
      // Format #3 element — pull the real base64 out of a known field.
      const src = value.dataUrl || value.url || value.value || value.src || null;
      if (typeof src === 'string' && src.length > 0) {
        items.push({ slot: finalSlot, value: src });
      } else {
        skipped.push({ slot: finalSlot, reason: 'object-without-base64-field' });
      }
      return;
    }
    // number / boolean / nested array / anything else — never stringify.
    skipped.push({ slot: finalSlot, reason: `non-string-value:${typeof value}` });
  };

  if (Array.isArray(photos)) {
    // ARRAY shape (#3 or array-of-strings). Slot derives from element.key
    // (objects) or the array index.
    for (let i = 0; i < photos.length; i++) {
      const el = photos[i];
      if (el && typeof el === 'object' && !Array.isArray(el)) {
        pushValue(el.key, el, i);
      } else {
        pushValue(i, el, i);
      }
    }
    return { items, skipped };
  }

  // OBJECT shape (#1 or #2, possibly with per-slot arrays).
  for (const [key, value] of Object.entries(photos)) {
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) pushValue(key, value[i], i);
    } else {
      pushValue(key, value, key);
    }
  }
  return { items, skipped };
}

/**
 * Upload inspection photos to Storage and return an array of refs suitable for
 * `photoStorageRefs`.
 *
 *   refs: [{ key, path, contentType, size, uploadedAt }]
 *
 * HARDENED (prod incident 2026-06):
 *   - normalizes ALL three real photosJson shapes (see normalizePhotosForUpload),
 *   - rejects non-image / garbage at the source (decodePhotoValue magic header),
 *   - optionally READ-BACK byte-verifies each uploaded object (pass `downloader`)
 *     so a write that didn't actually land is never recorded as a real ref,
 *   - returns `{ refs, inputCount, uploadedCount, skippedCount, verifyFailed }`
 *     via the out-param when callers need to decide whether to keep photosJson.
 *
 * The default return is the refs array (back-compat with existing callers).
 * Callers that need the counts can pass `stats` and read it after the call, OR
 * call `uploadInspectionPhotosDetailed` which returns the full object.
 *
 * `key` preserves the wizard's slot name (e.g. "front", "rear", "damage_1")
 * so the read path can still group photos by area when rendering.
 *
 * @param {object} opts
 * @param {object|Array} opts.photos
 * @param {string} opts.tenantId
 * @param {string} opts.inspectionId
 * @param {string} [opts.bucket]
 * @param {(args:{bucket,path,body,contentType,upsert}) => Promise<any>} [opts.uploader]
 * @param {(args:{bucket,path}) => Promise<{body?:Buffer,size?:number}>} [opts.downloader]
 *   - when provided, each uploaded object is downloaded back and its byte length
 *     is verified against the source buffer. A mismatch SKIPS that ref.
 * @param {{warn?:Function,error?:Function,log?:Function}} [opts.logger]
 * @param {object} [opts.stats] - optional out-param; counts are written here.
 * @returns {Promise<Array<object>>}
 */
export async function uploadInspectionPhotos(opts = {}) {
  const detailed = await uploadInspectionPhotosDetailed(opts);
  if (opts.stats && typeof opts.stats === 'object') {
    opts.stats.inputCount = detailed.inputCount;
    opts.stats.uploadedCount = detailed.uploadedCount;
    opts.stats.skippedCount = detailed.skippedCount;
    opts.stats.verifyFailed = detailed.verifyFailed;
  }
  return detailed.refs;
}

/**
 * Same as uploadInspectionPhotos but returns the full result object:
 *   { refs, inputCount, uploadedCount, skippedCount, verifyFailed }
 * `inputCount` is the number of NON-EMPTY photo slots seen (format #2 nulls are
 * not counted as input). A caller that wants the fail-safe rule "keep photosJson
 * unless EVERY input photo uploaded+verified" compares refs.length to inputCount.
 */
export async function uploadInspectionPhotosDetailed({
  photos,
  tenantId,
  inspectionId,
  bucket,
  uploader,
  downloader,
  logger = console
} = {}) {
  const empty = { refs: [], inputCount: 0, uploadedCount: 0, skippedCount: 0, verifyFailed: 0 };
  if (!photos || typeof photos !== 'object') return empty;
  if (!tenantId) throw new StorageError('uploadInspectionPhotos: tenantId is required', 400);
  if (!inspectionId) throw new StorageError('uploadInspectionPhotos: inspectionId is required', 400);

  const targetBucket = bucket || getPhotosBucket();
  const upload = typeof uploader === 'function' ? uploader : uploadObject;
  const download = typeof downloader === 'function' ? downloader : null;

  const { items, skipped } = normalizePhotosForUpload(photos);
  // inputCount counts every value we intended to upload (strings/extracted
  // base64). Format #2 nulls are already filtered out of `items`. Junk objects
  // are in `skipped` and counted separately.
  let inputCount = items.length;
  let skippedCount = skipped.length;
  let verifyFailed = 0;
  const refs = [];

  if (skippedCount > 0) {
    try {
      (logger?.warn || console.warn).call(
        logger || console,
        `[16l-upload] inspection=${inspectionId} skipped ${skippedCount} non-photo element(s): ` +
          skipped.map((x) => `${x.slot}:${x.reason}`).join(', ')
      );
    } catch { /* logging never throws */ }
  }

  for (const { slot, value } of items) {
    const decoded = decodePhotoValue(value);
    if (!decoded) {
      // Not a base64 photo. If it's an external http(s) URL, surface it as an
      // external ref (counts as uploaded for the fail-safe accounting since the
      // bytes already live elsewhere). Otherwise it's junk -> skip + count.
      if (typeof value === 'string' && /^https?:\/\//i.test(value)) {
        refs.push({
          key: canonicalPhotoKey(slot),
          url: value,
          external: true,
          uploadedAt: new Date().toISOString()
        });
        continue;
      }
      skippedCount++;
      inputCount = Math.max(0, inputCount - 1); // it was never a real photo
      try {
        (logger?.warn || console.warn).call(
          logger || console,
          `[16l-upload] inspection=${inspectionId} slot=${slot} value did not decode to a valid image; skipped`
        );
      } catch { /* ignore */ }
      continue;
    }

    // Canonicalize the slot (e.g. front_seat -> frontSeat) so the stored ref
    // `key` matches what the read/materialize path groups by. Without this a
    // migrated photo could be stored under the raw snake_case slot while the UI
    // groups by the camelCase key -> photo shows under the wrong/no slot.
    const canonicalSlot = canonicalPhotoKey(slot);
    const photoId = `${canonicalSlot.replace(/[^A-Za-z0-9_-]/g, '_')}_${crypto.randomUUID()}`;
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

    // HARDENED: read-back byte-verify when a downloader is provided. A write
    // that didn't actually persist (or stored the wrong bytes) must NEVER be
    // recorded as a real ref — that was exactly how 13 inspections were lost.
    if (download) {
      let back = null;
      try {
        back = await download({ bucket: targetBucket, path });
      } catch (err) {
        verifyFailed++;
        try {
          (logger?.warn || console.warn).call(
            logger || console,
            `[16l-upload] inspection=${inspectionId} slot=${slot} read-back FAILED: ${err?.message || err}`
          );
        } catch { /* ignore */ }
        continue;
      }
      const backLen = back?.body?.byteLength ?? back?.size ?? null;
      if (backLen == null || backLen !== decoded.buffer.byteLength) {
        verifyFailed++;
        try {
          (logger?.warn || console.warn).call(
            logger || console,
            `[16l-upload] inspection=${inspectionId} slot=${slot} byte mismatch src=${decoded.buffer.byteLength} back=${backLen}; skipped`
          );
        } catch { /* ignore */ }
        continue;
      }
    }

    refs.push({
      key: canonicalSlot,
      path,
      contentType: decoded.contentType,
      size: decoded.buffer.byteLength,
      uploadedAt: new Date().toISOString()
    });
  }

  const uploadedCount = refs.length;
  return { refs, inputCount, uploadedCount, skippedCount, verifyFailed };
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
