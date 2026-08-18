/**
 * Does a signature data-URL actually contain INK? (2026-08-06)
 *
 * Found on contract RA-20260701152550-2797: the customer signed the checkout
 * T&C with a real stroke, then two days later opened the interactive-agreement
 * link and submitted the signature pad UNTOUCHED. The endpoint only checked
 * "non-empty string", a blank canvas is a perfectly valid PNG, and because the
 * agreement print prefers the interactive signature, a WHITE BOX printed in
 * the Customer Signature block while the real stroke sat on the appendix page.
 *
 * This module decodes the PNG (Node's zlib — no dependencies) and counts
 * pixels that are meaningfully dark and opaque. Deliberately FAIL-OPEN: a
 * format we cannot analyze (JPEG, exotic bit depths, corrupt data) reports
 * analyzable:false and callers must NOT reject on it — blocking a legitimate
 * signature over a parser limitation is worse than admitting a blank one.
 * Signature pads emit 8-bit RGB/RGBA/grayscale PNGs, which is what we decode.
 */
import zlib from 'node:zlib';

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Paeth predictor, verbatim from the PNG spec. */
function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

function parsePng(buf) {
  if (!buf.subarray(0, 8).equals(PNG_MAGIC)) return null;
  let width = 0; let height = 0; let bitDepth = 0; let colorType = 0; let interlace = 0;
  const idat = [];
  let off = 8;
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    off += 12 + len; // len + type + crc
  }
  if (!width || !height || !idat.length) return null;
  return { width, height, bitDepth, colorType, interlace, idat: Buffer.concat(idat) };
}

// Channels per pixel by PNG color type: 0 gray, 2 RGB, 4 gray+alpha, 6 RGBA.
const CHANNELS = { 0: 1, 2: 3, 4: 2, 6: 4 };

/**
 * Largest raw pixel buffer an IHDR may ask us to allocate, by caller.
 *
 * PRINT (default, 16MB): renderAgreementHtml re-reads signatures captured by
 * every pad in the app, including the check-in wizard's full-width pad, which
 * on a 5K panel at 300% scaling reaches ~10MB of raw pixels. Going lower would
 * make a legitimate STORED signature unanalyzable at print time and silently
 * switch off the blank-detection that RA-20260701152550 exists for.
 *
 * INGEST (8MB): the two public token-authenticated endpoints only ever receive
 * their own pads, which top out at 4.09MB (/sign at devicePixelRatio 4) and
 * 0.72MB (customer portal). Halving the bound there halves the worst-case
 * decode an attacker with a valid token can force, and cannot reject anything
 * those pads produce.
 */
const MAX_RAW_BYTES = 16 * 1024 * 1024;
export const MAX_INGEST_RAW_BYTES = 8 * 1024 * 1024;

/**
 * Ceiling on an incoming signature/initial data URL, for the public
 * token-authenticated endpoints. This is the second of two limits: main.js
 * caps the signing paths at a 1mb body, and this bounds what we accept as a
 * mark once parsed. Real pads are nowhere near it: the customer-portal pad is a
 * fixed 860x220 and the /sign pad is devicePixelRatio-scaled, and both
 * emit mostly-white PNGs that compress to tens of KB. Callers should
 * check this AFTER the token lookup, so an invalid token costs nothing.
 */
export const MAX_MARK_BYTES = 512 * 1024;

/**
 * Analyze a data URL. Returns { analyzable, hasInk, inkPixels }.
 * "Ink" = a pixel that is OPAQUE enough to see (alpha > 32) and DARK enough to
 * read (luma < 200 of 255). A couple of stray anti-aliased pixels do not count
 * as a signature: the threshold is 25 inked pixels, roughly the shortest
 * possible pen tick, far below any real initial.
 */
export function analyzeSignatureInk(dataUrl, { maxRawBytes = MAX_RAW_BYTES } = {}) {
  const none = { analyzable: false, hasInk: false, inkPixels: 0 };
  const m = /^data:image\/png;base64,([A-Za-z0-9+/=\s]+)$/.exec(String(dataUrl || '').trim());
  if (!m) return none;
  let png;
  try {
    png = parsePng(Buffer.from(m[1], 'base64'));
  } catch {
    return none;
  }
  if (!png || png.interlace !== 0 || png.bitDepth !== 8 || !(png.colorType in CHANNELS)) return none;

  const bpp = CHANNELS[png.colorType];
  const stride = png.width * bpp;
  // A PNG of W x H at this colour type inflates to EXACTLY (stride + 1) * H
  // bytes, and IHDR told us W and H before we spent anything. Bounding the
  // inflate by that figure removes the amplification entirely: a 1x1 header
  // shipping megabytes of IDAT (a zip bomb — 400KB in, ~300MB out, ~286ms of
  // blocked event loop) is refused after a few bytes instead of being
  // decompressed in full. A fixed ceiling would either be too low for a
  // high-DPI pad or too high to stop the bomb; this is neither.
  const expected = (stride + 1) * png.height;
  // The header itself is attacker-controlled, so cap what it may ASK for.
  // Callers that only ever see their own signature pad should pass the tighter
  // MAX_INGEST_RAW_BYTES; the default keeps the print path's headroom.
  if (!expected || expected > maxRawBytes) return none;

  let raw;
  try {
    // Trailing bytes past the pixel data are not part of any signature we
    // print, but tolerate a little slack so an odd-but-valid encoder is not
    // failed shut. Overshooting the limit THROWS, and the catch fails open.
    raw = zlib.inflateSync(png.idat, { maxOutputLength: expected + 1024 });
  } catch {
    return none;
  }

  if (raw.length < expected) return none;

  let inkPixels = 0;
  const prev = Buffer.alloc(stride);
  const cur = Buffer.alloc(stride);
  let pos = 0;
  for (let y = 0; y < png.height; y += 1) {
    const filter = raw[pos]; pos += 1;
    raw.copy(cur, 0, pos, pos + stride); pos += stride;
    // Reconstruct per the PNG filter spec so pixel values are real.
    for (let i = 0; i < stride; i += 1) {
      const a = i >= bpp ? cur[i - bpp] : 0;
      const b = prev[i];
      const c = i >= bpp ? prev[i - bpp] : 0;
      if (filter === 1) cur[i] = (cur[i] + a) & 0xff;
      else if (filter === 2) cur[i] = (cur[i] + b) & 0xff;
      else if (filter === 3) cur[i] = (cur[i] + ((a + b) >> 1)) & 0xff;
      else if (filter === 4) cur[i] = (cur[i] + paeth(a, b, c)) & 0xff;
    }
    for (let x = 0; x < png.width; x += 1) {
      const i = x * bpp;
      let alpha = 255;
      let luma;
      if (png.colorType === 6) { alpha = cur[i + 3]; luma = (cur[i] * 299 + cur[i + 1] * 587 + cur[i + 2] * 114) / 1000; }
      else if (png.colorType === 2) { luma = (cur[i] * 299 + cur[i + 1] * 587 + cur[i + 2] * 114) / 1000; }
      else if (png.colorType === 4) { alpha = cur[i + 1]; luma = cur[i]; }
      else { luma = cur[i]; }
      if (alpha > 32 && luma < 200) inkPixels += 1;
    }
    cur.copy(prev);
  }

  return { analyzable: true, hasInk: inkPixels >= 25, inkPixels };
}

/**
 * The signature to PRINT, from candidates in preference order: the first one
 * with visible ink wins; if none is analyzable-with-ink, the first non-empty
 * candidate (fail-open — an unanalyzable format may still be a real stroke).
 * This is what keeps a blank interactive signature from masking a real T&C
 * stroke on the agreement print.
 */
export function pickInkedSignature(...candidates) {
  const nonEmpty = candidates.map((c) => String(c || '').trim()).filter(Boolean);
  for (const c of nonEmpty) {
    const a = analyzeSignatureInk(c);
    if (a.analyzable && a.hasInk) return c;
  }
  for (const c of nonEmpty) {
    if (!analyzeSignatureInk(c).analyzable) return c;
  }
  return nonEmpty[0] || '';
}
