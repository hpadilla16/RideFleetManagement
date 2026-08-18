/**
 * Blank signatures are rejected; real strokes pass; unreadable formats
 * fail open (RA-20260701152550: an untouched signature pad — a perfectly
 * valid PNG — printed a white box over the customer's real T&C stroke).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { analyzeSignatureInk, pickInkedSignature, MAX_MARK_BYTES, MAX_INGEST_RAW_BYTES } from './signature-ink.js';

// ---------------------------------------------------------------------------
// Minimal PNG encoder for fixtures: 8-bit RGBA, filter 0 rows.
// ---------------------------------------------------------------------------
function crc32(buf) {
  let c; const table = [];
  for (let n = 0; n < 256; n += 1) {
    c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (const b of buf) crc = table[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'ascii'), data])), 8 + data.length);
  return out;
}
/** pixels: (x,y) → [r,g,b,a] */
function makePng(width, height, pixelFn) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  const raw = Buffer.alloc((width * 4 + 1) * height);
  let p = 0;
  for (let y = 0; y < height; y += 1) {
    raw[p] = 0; p += 1; // filter 0
    for (let x = 0; x < width; x += 1) {
      const [r, g, b, a] = pixelFn(x, y);
      raw[p] = r; raw[p + 1] = g; raw[p + 2] = b; raw[p + 3] = a; p += 4;
    }
  }
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  return `data:image/png;base64,${png.toString('base64')}`;
}

const BLANK_WHITE = makePng(120, 60, () => [255, 255, 255, 255]);
const BLANK_TRANSPARENT = makePng(120, 60, () => [0, 0, 0, 0]);
// A 60px horizontal dark stroke, like the shortest real pen line.
const STROKE = makePng(120, 60, (x, y) => (y === 30 && x >= 20 && x < 90 ? [20, 24, 40, 255] : [255, 255, 255, 255]));
// A couple of stray anti-aliased specks must NOT count as a signature.
const SPECKS = makePng(120, 60, (x, y) => ((x === 5 && y === 5) || (x === 100 && y === 40) ? [0, 0, 0, 255] : [255, 255, 255, 255]));

describe('analyzeSignatureInk', () => {
  it('an untouched pad — white or transparent — has no ink', () => {
    assert.deepEqual(analyzeSignatureInk(BLANK_WHITE), { analyzable: true, hasInk: false, inkPixels: 0 });
    // Transparent pixels are invisible on paper regardless of their RGB.
    assert.equal(analyzeSignatureInk(BLANK_TRANSPARENT).hasInk, false);
  });

  it('a real stroke has ink', () => {
    const out = analyzeSignatureInk(STROKE);
    assert.equal(out.analyzable, true);
    assert.equal(out.hasInk, true);
    assert.equal(out.inkPixels, 70);
  });

  it('stray specks are not a signature', () => {
    const out = analyzeSignatureInk(SPECKS);
    assert.equal(out.analyzable, true);
    assert.equal(out.hasInk, false, `${out.inkPixels} pixels of noise must not pass as ink`);
  });

  it('fails OPEN on anything it cannot read — never block a real signature over a parser limit', () => {
    for (const v of ['', null, 'data:image/jpeg;base64,/9j/4AAQ', 'data:image/png;base64,not-base64!!', 'data:image/png;base64,aGVsbG8=']) {
      assert.equal(analyzeSignatureInk(v).analyzable, false, String(v).slice(0, 40));
    }
  });
});

describe('pickInkedSignature', () => {
  it('the RA-20260701152550 case: a blank interactive signature no longer masks the real T&C stroke', () => {
    assert.equal(pickInkedSignature(BLANK_WHITE, STROKE), STROKE);
  });

  it('keeps the normal preference when the first candidate has ink', () => {
    assert.equal(pickInkedSignature(STROKE, BLANK_WHITE), STROKE);
  });

  it('falls open to an unanalyzable candidate rather than printing a known blank', () => {
    const jpeg = 'data:image/jpeg;base64,/9j/4AAQSkZJRg==';
    assert.equal(pickInkedSignature(BLANK_WHITE, jpeg), jpeg);
  });

  it('with only blanks, prints the first one — "No signature on file" would be a lie', () => {
    assert.equal(pickInkedSignature(BLANK_WHITE, BLANK_TRANSPARENT), BLANK_WHITE);
    assert.equal(pickInkedSignature(null, undefined, ''), '');
  });
});

// ---------------------------------------------------------------------------
// Decompression bombs (2026-08-17).
//
// /api/public/signature/:token and /api/sign take no auth — the token in the
// URL is the auth — and the parent app parses JSON at 50mb because inspection
// photos need it. A PNG whose IHDR claims 1x1 but whose IDAT carries hundreds
// of megabytes of zeros used to be inflated in full before anyone checked the
// token, blocking the event loop for every other request on the process.
// The inflate is now bounded by the size IHDR itself declares.
// ---------------------------------------------------------------------------

/** A PNG with an honest header and a deliberately oversized IDAT. */
function makeBomb(width, height, payloadBytes) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(Buffer.alloc(payloadBytes))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  return `data:image/png;base64,${png.toString('base64')}`;
}

describe('decompression bombs', () => {
  it('refuses a 1x1 header carrying 8MB of IDAT instead of inflating it', () => {
    // 8MB of zeros deflates to a few KB — the amplification the attack needs.
    const bomb = makeBomb(1, 1, 8 * 1024 * 1024);
    assert.ok(bomb.length < 64 * 1024, 'fixture must be small on the wire');
    const started = process.hrtime.bigint();
    const out = analyzeSignatureInk(bomb);
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    // Fail-open on shape, but it must not have done the work.
    assert.equal(out.analyzable, false);
    assert.ok(ms < 50, `should bail immediately, took ${ms.toFixed(1)}ms`);
  });

  it('refuses a header declaring more pixels than any real pad', () => {
    // 30000x30000 RGBA would be 3.6GB of raw pixels. Never allocate it.
    const out = analyzeSignatureInk(makeBomb(30000, 30000, 1024));
    assert.equal(out.analyzable, false);
  });

  it('still reads a high-DPI pad, so the cap cannot reject a real signature', () => {
    // The /sign pad is devicePixelRatio-scaled: a 1200px-wide fullWidth canvas
    // at dpr 3 is 3600x420. It must analyze normally.
    const big = makePng(3600, 420, (x, y) => (y === 200 && x >= 100 && x < 3000
      ? [20, 24, 40, 255] : [255, 255, 255, 255]));
    const out = analyzeSignatureInk(big);
    assert.equal(out.analyzable, true);
    assert.equal(out.hasInk, true);
  });

  it('a real pad stays below the wire ceiling the endpoints enforce', () => {
    // Both public endpoints reject a data URL longer than MAX_MARK_BYTES, and
    // a false rejection blocks a customer from signing a rental agreement —
    // worse than the flood the cap exists to stop. So measure a DENSE
    // signature, not a thin line: a single 1px stroke compresses to nothing
    // and would prove nothing about the real margin. This is a multi-loop
    // anti-aliased scribble at filter 0, which is harder to compress than
    // anything a browser's adaptive filtering emits.
    const scribble = (w, h) => makePng(w, h, (x, y) => {
      // Three overlapping sine loops spanning the pad, with soft edges.
      let d = Infinity;
      for (let k = 1; k <= 3; k += 1) {
        const yy = h / 2 + Math.sin((x / w) * Math.PI * 2 * k) * (h / 3);
        d = Math.min(d, Math.abs(y - yy));
      }
      if (d > 3) return [255, 255, 255, 255];
      const v = Math.round(20 + (d / 3) * 200); // anti-aliased ramp
      return [v, v, v + 10, 255];
    });
    // The customer-portal pad is a fixed 860x220 (no dpr scaling).
    const portalPad = scribble(860, 220);
    // The /sign pad is dpr-scaled inside a 480px-wide container at height 140,
    // so 1912x560 at devicePixelRatio 4 is its ceiling.
    const signPad = scribble(1912, 560);
    assert.ok(portalPad.length < MAX_MARK_BYTES,
      `portal pad ${portalPad.length} must fit under ${MAX_MARK_BYTES}`);
    assert.ok(signPad.length < MAX_MARK_BYTES,
      `/sign pad at dpr4 ${signPad.length} must fit under ${MAX_MARK_BYTES}`);
    // Both must also survive the decode bound, or blank-detection silently
    // switches off for a legitimate signature.
    assert.equal(analyzeSignatureInk(portalPad).hasInk, true);
    assert.equal(analyzeSignatureInk(signPad).hasInk, true);
  });
});

describe('per-caller decode bound', () => {
  it('the ingest bound refuses a geometry the print bound would still decode', () => {
    // A small payload whose header declares ~12MB of raw pixels: under the
    // 16MB print default, over the 8MB ingest bound. This is the shape that
    // makes a decode expensive without making the request look big.
    const wide = makeBomb(750000, 4, 1024); // (750000*4+1)*4 = 12.0MB
    assert.equal(analyzeSignatureInk(wide).analyzable, false, 'no pixel data');
    assert.equal(
      analyzeSignatureInk(wide, { maxRawBytes: MAX_INGEST_RAW_BYTES }).analyzable,
      false,
      'the ingest bound must refuse it before allocating',
    );
    // And the bound really is the thing rejecting it at ingest: a geometry
    // under 8MB is still accepted by both.
    const ok = makePng(860, 220, (x, y) => (y === 110 && x >= 100 && x < 700
      ? [20, 24, 40, 255] : [255, 255, 255, 255]));
    assert.equal(analyzeSignatureInk(ok, { maxRawBytes: MAX_INGEST_RAW_BYTES }).hasInk, true);
  });

  it('every real pad still fits under the tighter ingest bound', () => {
    // /sign at devicePixelRatio 4 is the largest pad reaching a public
    // endpoint: 1912x560 RGBA = 4.09MB, comfortably under 8MB.
    const signPad = makePng(1912, 560, (x, y) => (y === 300 && x >= 100 && x < 1800
      ? [20, 24, 40, 255] : [255, 255, 255, 255]));
    const out = analyzeSignatureInk(signPad, { maxRawBytes: MAX_INGEST_RAW_BYTES });
    assert.equal(out.analyzable, true);
    assert.equal(out.hasInk, true);
  });
});
