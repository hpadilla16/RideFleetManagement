/**
 * Blank signatures are rejected; real strokes pass; unreadable formats
 * fail open (RA-20260701152550: an untouched signature pad — a perfectly
 * valid PNG — printed a white box over the customer's real T&C stroke).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { analyzeSignatureInk, pickInkedSignature } from './signature-ink.js';

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

/**
 * Which signature the printed agreement calls "the customer's".
 *
 * A rental carries two marks: the T&C signature the customer made themselves
 * before driving away, and the close signature captured at the counter on
 * staff hardware when the rental ends. Until 2026-08-27 the print block tried
 * the close signature FIRST, so it won on the 835 of 1,573 agreements that had
 * both — printing under the heading "Customer Signature" with whatever name
 * the closing agent typed. A customer queried an agreement that read
 * "Signed by: <an employee>". The stored records were correct throughout;
 * only the rendering attributed the wrong mark.
 */
describe('printed agreement — customer signature precedence', () => {
  it("the customer's own T&C stroke wins over the counter's closing stroke", () => {
    const tc = STROKE;
    const close = SPECKS;
    assert.equal(pickInkedSignature(tc, close), tc);
  });

  it('an untouched T&C pad does not blank the block — the close stroke still prints', () => {
    assert.equal(pickInkedSignature(BLANK_WHITE, STROKE), STROKE);
  });

  it('no T&C signature at all still falls through rather than printing an empty box', () => {
    assert.equal(pickInkedSignature('', STROKE), STROKE);
    assert.equal(pickInkedSignature(null, STROKE), STROKE);
  });

  it('the print builder passes the T&C signature first', async () => {
    const { readFile } = await import('node:fs/promises');
    const src = await readFile(
      new URL('../modules/rental-agreements/rental-agreements.service.js', import.meta.url),
      'utf8',
    );
    const call = src.match(/pickInkedSignature\(\s*([A-Za-z0-9_.?\[\]]+)\s*,\s*([A-Za-z0-9_.?\[\]]+)\s*\)/);
    assert.ok(call, 'expected a two-argument pickInkedSignature call in the print builder');
    assert.equal(call[1], 'tcSigRaw', "the customer's T&C signature must be the first candidate");
    assert.equal(call[2], 'closeSigRaw', 'the closing signature must be the fallback, not the winner');
  });

  it('the rendered name is not read straight off the reservation any more', async () => {
    const { readFile } = await import('node:fs/promises');
    const src = await readFile(
      new URL('../modules/rental-agreements/rental-agreements.service.js', import.meta.url),
      'utf8',
    );
    assert.ok(
      !/signatureSignedBy:\s*esc\(agreement\.reservation\?\.signatureSignedBy/.test(src),
      'the name must follow whichever signature is shown, not always the closing one',
    );
  });
});
