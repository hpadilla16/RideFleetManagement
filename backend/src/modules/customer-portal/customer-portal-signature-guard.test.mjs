/**
 * /api/public/signature/:token takes no auth — the token in the URL IS the
 * auth — and it accepts an image. Two things have to hold, or an anonymous
 * caller can spend the server's CPU without holding a valid token at all:
 *
 *   1. The token is resolved BEFORE the PNG is decoded. Decoding is by far
 *      the most expensive thing the handler does.
 *   2. The data URL is capped. The parent app parses JSON at 50mb (sized for
 *      inspection photo batches), which is three orders of magnitude more
 *      than a pen stroke needs.
 *
 * Run: node --test backend/src/modules/customer-portal/customer-portal-signature-guard.test.mjs
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { prisma } from '../../lib/prisma.js';
import { MAX_MARK_BYTES } from '../../lib/signature-ink.js';
import { customerPortalRouter } from './customer-portal.routes.js';

// --- the POST /signature/:token handler, minus its rate-limit middleware ----
function signatureHandler() {
  for (const layer of customerPortalRouter.stack) {
    if (layer.route?.path === '/signature/:token' && layer.route.methods?.post) {
      const handlers = layer.route.stack.map((s) => s.handle);
      return handlers[handlers.length - 1];
    }
  }
  throw new Error('POST /signature/:token not found on the router');
}

function fakeRes() {
  const res = { statusCode: 200, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
}

/** Invoke the handler and report status/body, surfacing any thrown error. */
async function call(body) {
  const res = fakeRes();
  let nextErr = null;
  await signatureHandler()({ params: { token: 'NOPE' }, body, ip: '127.0.0.1' }, res, (e) => { nextErr = e; });
  if (nextErr) throw nextErr;
  return res;
}

// A valid all-white PNG: the analyzer reports "blank" on it, so if a blank
// rejection comes back for an invalid token, the decode ran too early.
function blankPng() {
  const crcTable = [];
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crcTable[n] = c >>> 0;
  }
  const crc32 = (buf) => {
    let crc = 0xffffffff;
    for (const b of buf) crc = crcTable[(crc ^ b) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    out.write(type, 4, 'ascii');
    data.copy(out, 8);
    out.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'ascii'), data])), 8 + data.length);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(120, 0); ihdr.writeUInt32BE(60, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  const raw = Buffer.alloc((120 * 4 + 1) * 60, 0xff);
  for (let y = 0; y < 60; y += 1) raw[y * (120 * 4 + 1)] = 0;
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
  return `data:image/png;base64,${png.toString('base64')}`;
}

let lookups;
beforeEach(() => {
  lookups = 0;
  // No reservation matches the token — the anonymous-stranger case.
  prisma.reservation.findFirst = async () => { lookups += 1; return null; };
});

test('an invalid token is rejected before the image is decoded', async () => {
  const res = await call({ signerName: 'Ana', signatureDataUrl: blankPng() });
  assert.equal(lookups, 1, 'the token must be looked up');
  assert.equal(res.statusCode, 404);
  assert.match(res.body.error, /Invalid or expired/,
    `expected the token error; got "${res.body.error}" — the decode ran first`);
});

test('an invalid token is rejected before the size ceiling is applied', async () => {
  const huge = 'data:image/png;base64,' + 'A'.repeat(MAX_MARK_BYTES + 1024);
  const res = await call({ signerName: 'Ana', signatureDataUrl: huge });
  assert.equal(res.statusCode, 404, 'an invalid token must cost nothing');
  assert.match(res.body.error, /Invalid or expired/);
});

test('the handler still validates its inputs before any lookup', async () => {
  const missing = await call({ signerName: 'Ana', signatureDataUrl: '' });
  assert.equal(missing.statusCode, 400);
  assert.equal(lookups, 0, 'a request with no signature need not hit the database');
});

test('the ceiling leaves room for a real signature pad', async () => {
  // The customer-portal pad is a fixed 860x220 (sign-agreement/page.js) and
  // emits a mostly-white PNG. Nothing a real pad produces may approach this.
  assert.ok(blankPng().length < MAX_MARK_BYTES / 4);
  assert.equal(MAX_MARK_BYTES, 512 * 1024);
});
