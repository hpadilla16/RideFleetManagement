/**
 * Browser-side image compressor.
 *
 * Reduces typical inspection photos from 1-2MB down to 200-400KB by:
 *   1. Resizing to maxWidth (default 1280px) preserving aspect ratio
 *   2. Re-encoding as JPEG at quality 0.7
 *
 * Why: today RentalAgreementInspection.photosJson stores base64 data-URLs
 * inline in a TEXT column. Without compression, 8 photos at 1-2MB each
 * push the JSON payload past 10MB — Express body limit is 50MB but
 * Supabase/Postgres TEXT writes start to time out around 4-5MB. This
 * util keeps captures small enough that the existing path is safe.
 *
 * Long-term, photos should move to Supabase Storage with signed URL
 * uploads (see master plan section 7.2 and task 16l). This util is the
 * quick-fix bridge until that lands.
 *
 * Usage:
 *   const compressed = await compressImage(file, { maxWidth: 1280, quality: 0.7 });
 *   // compressed is a File (same .name + lastModified, smaller .size)
 *
 *   const dataUrl = await fileToDataUrl(compressed);
 *   // dataUrl is "data:image/jpeg;base64,…" — ready to post to backend
 *
 *   // Or use the all-in-one shortcut:
 *   const dataUrl = await compressToDataUrl(file);
 */

const DEFAULT_MAX_WIDTH = 1280;
const DEFAULT_QUALITY = 0.7;
const DEFAULT_MAX_HEIGHT = 1280;
const DEFAULT_TYPE = 'image/jpeg';

/**
 * Compress an image file and return a new File object.
 *
 * @param {File|Blob} file - Source image
 * @param {object} opts
 * @param {number} opts.maxWidth - Max output width in pixels (default 1280)
 * @param {number} opts.maxHeight - Max output height in pixels (default 1280)
 * @param {number} opts.quality - JPEG quality 0-1 (default 0.7)
 * @param {string} opts.type - Output MIME type (default 'image/jpeg')
 * @returns {Promise<File>}
 */
export async function compressImage(file, opts = {}) {
  const {
    maxWidth = DEFAULT_MAX_WIDTH,
    maxHeight = DEFAULT_MAX_HEIGHT,
    quality = DEFAULT_QUALITY,
    type = DEFAULT_TYPE
  } = opts;

  if (!file) throw new Error('compressImage: file is required');

  // Bypass non-image files
  if (file.type && !file.type.startsWith('image/')) {
    return file;
  }

  const img = await loadImage(file);
  const { width, height } = computeDimensions(img.width, img.height, maxWidth, maxHeight);

  // If source is already small enough AND already a JPEG, skip recompression.
  // Avoids quality loss when staff uploads a server-generated thumbnail.
  if (img.width <= maxWidth && img.height <= maxHeight && file.type === type) {
    return file;
  }

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('compressImage: 2D canvas context unavailable');
  ctx.drawImage(img, 0, 0, width, height);

  const blob = await canvasToBlob(canvas, type, quality);
  if (!blob) throw new Error('compressImage: canvas.toBlob returned null');

  // Wrap in a File so consumers see the same shape as the source
  const fileName = (file.name || 'photo.jpg').replace(/\.(png|webp|heic|heif)$/i, '.jpg');
  return new File([blob], fileName, {
    type,
    lastModified: file.lastModified || Date.now()
  });
}

/**
 * Compress + convert to a base64 data URL in one step. Convenient for the
 * current photosJson upload path.
 *
 * @param {File|Blob} file
 * @param {object} opts - Same as compressImage
 * @returns {Promise<string>} - "data:image/jpeg;base64,…"
 */
export async function compressToDataUrl(file, opts = {}) {
  const compressed = await compressImage(file, opts);
  return fileToDataUrl(compressed);
}

/**
 * Compress an array of files in parallel. Order is preserved.
 *
 * @param {File[]} files
 * @param {object} opts
 * @returns {Promise<File[]>}
 */
export async function compressMany(files, opts = {}) {
  if (!Array.isArray(files) || files.length === 0) return [];
  // Limit concurrency to avoid OOM on mid-range phones with many photos.
  const CONCURRENCY = 3;
  const results = new Array(files.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, files.length) }, async () => {
    while (true) {
      const i = cursor++;
      if (i >= files.length) return;
      results[i] = await compressImage(files[i], opts);
    }
  }));
  return results;
}

// =============================================================================
// Helpers
// =============================================================================

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('compressImage: failed to decode image'));
    };
    img.src = url;
  });
}

function computeDimensions(srcW, srcH, maxW, maxH) {
  if (srcW <= maxW && srcH <= maxH) return { width: srcW, height: srcH };
  const scale = Math.min(maxW / srcW, maxH / srcH);
  return {
    width: Math.round(srcW * scale),
    height: Math.round(srcH * scale)
  };
}

function canvasToBlob(canvas, type, quality) {
  return new Promise((resolve) => {
    canvas.toBlob(resolve, type, quality);
  });
}

export function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('fileToDataUrl: read failed'));
    reader.readAsDataURL(file);
  });
}

/**
 * Estimate the byte size of a base64 data URL — useful for client-side
 * preflight checks before posting to the backend.
 *
 * Base64 encoded size ≈ data length × 3/4 (minus padding).
 */
export function dataUrlByteSize(dataUrl) {
  if (typeof dataUrl !== 'string') return 0;
  const commaIdx = dataUrl.indexOf(',');
  if (commaIdx === -1) return 0;
  const b64 = dataUrl.slice(commaIdx + 1);
  const padding = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  return Math.floor(b64.length * 3 / 4) - padding;
}
