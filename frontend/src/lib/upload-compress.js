/**
 * Client-side document upload compaction (extracted 2026-07-28 from the
 * customer-portal pre-check-in page, LAX #5/#6 — now shared by the portal
 * form, the staff "Fill In For Customer" panel, and the New Reservation V2
 * customer step, so all three produce payloads the backend's body-size limit
 * accepts).
 *
 * Images are downscaled to 1400px / JPEG q0.72; PDFs pass through inline but
 * are capped at 350 KB (the backend stores/base64-routes them).
 */

export const MAX_INLINE_PDF_BYTES = 350 * 1024;

function loadImage(dataUrl) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('Unable to process image'));
    image.src = dataUrl;
  });
}

export async function fileToDataUrl(file) {
  if (!file) return '';
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('Unable to read file'));
    reader.readAsDataURL(file);
  });
}

export async function compressImageDataUrl(dataUrl, { maxWidth = 1400, maxHeight = 1400, quality = 0.72 } = {}) {
  const image = await loadImage(dataUrl);
  let width = image.width || maxWidth;
  let height = image.height || maxHeight;
  const scale = Math.min(1, maxWidth / width, maxHeight / height);
  width = Math.max(1, Math.round(width * scale));
  height = Math.max(1, Math.round(height * scale));

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(image, 0, 0, width, height);
  return canvas.toDataURL('image/jpeg', quality);
}

export async function toCompactUploadPayload(file) {
  if (!file) return '';
  if (String(file.type || '').startsWith('image/')) {
    const raw = await fileToDataUrl(file);
    return compressImageDataUrl(raw);
  }
  if (String(file.type || '').includes('pdf')) {
    if (Number(file.size || 0) > MAX_INLINE_PDF_BYTES) {
      throw new Error(`PDF "${file.name}" is too large. Please keep PDFs under ${Math.round(MAX_INLINE_PDF_BYTES / 1024)} KB.`);
    }
    return fileToDataUrl(file);
  }
  return fileToDataUrl(file);
}
