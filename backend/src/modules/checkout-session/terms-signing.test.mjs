/**
 * Tests for the public T&C signing service.
 * Run: node --test backend/src/modules/checkout-session/terms-signing.test.mjs
 */

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '../../lib/prisma.js';
import { termsSigningService } from './terms-signing.service.js';
import { TC_SECTIONS } from './terms-content.js';

const FUTURE = new Date(Date.now() + 15 * 60_000);
const PAST = new Date(Date.now() - 60_000);
const FAKE_DATA_URL = 'data:image/png;base64,' + 'A'.repeat(500);

let upserts;
let txOps;
function reset() {
  upserts = [];
  txOps = [];
  prisma.handoffToken.findUnique = async () => ({
    id: 't1', token: 'TOK', kind: 'TERMS_SIGNING',
    expiresAt: FUTURE, consumedAt: null,
    reservationId: 'r1',
    reservation: {
      id: 'r1', reservationNumber: 'RES-1', customerId: 'c1',
      rentalAgreement: { id: 'a1', declinedInsurance: false, agreementNumber: 'RA-1' },
    },
  });
  prisma.agreementSectionInitial.findMany = async () => [];
  prisma.agreementSectionInitial.upsert = async (op) => { upserts.push(op); return {}; };
  prisma.checkoutSession.findUnique = async () => ({ id: 's1', events: '[]', reservationId: 'r1' });
  prisma.$transaction = async (ops) => { txOps = ops; return ops; };
  prisma.rentalAgreement.update = async () => ({});
  prisma.checkoutSession.update = async () => ({});
  prisma.handoffToken.update = async () => ({});
}

beforeEach(() => reset());

// ---------------------------------------------------------------------------
// loadSession
// ---------------------------------------------------------------------------

test('loadSession returns canonical sections when not declined', async () => {
  const out = await termsSigningService.loadSession('TOK');
  assert.equal(out.sections.length, TC_SECTIONS.length);
  for (const s of out.sections) {
    assert.equal(s.signed, false, 'all unsigned initially');
  }
});

test('loadSession injects declined-insurance section when flag is true', async () => {
  prisma.handoffToken.findUnique = async () => ({
    id: 't1', token: 'TOK', kind: 'TERMS_SIGNING',
    expiresAt: FUTURE, consumedAt: null, reservationId: 'r1',
    reservation: {
      id: 'r1', reservationNumber: 'RES-1', customerId: 'c1',
      rentalAgreement: { id: 'a1', declinedInsurance: true, agreementNumber: 'RA-1' },
    },
  });
  const out = await termsSigningService.loadSession('TOK');
  assert.equal(out.sections.length, TC_SECTIONS.length + 1);
  assert.ok(out.sections.some((s) => s.key === 'declined_insurance'));
});

test('loadSession reflects signed state from prior initials', async () => {
  prisma.agreementSectionInitial.findMany = async () => [
    { sectionKey: 'rental_period', signedAt: new Date() },
  ];
  const out = await termsSigningService.loadSession('TOK');
  const rp = out.sections.find((s) => s.key === 'rental_period');
  assert.equal(rp.signed, true);
});

// ---------------------------------------------------------------------------
// Token validation
// ---------------------------------------------------------------------------

test('expired token throws 410', async () => {
  prisma.handoffToken.findUnique = async () => ({
    id: 't1', token: 'X', kind: 'TERMS_SIGNING',
    expiresAt: PAST, consumedAt: null, reservationId: 'r1',
    reservation: { id: 'r1', rentalAgreement: { id: 'a1' } },
  });
  await assert.rejects(
    () => termsSigningService.loadSession('X'),
    (err) => err.status === 410 && err.code === 'TOKEN_EXPIRED',
  );
});

test('consumed token throws 410', async () => {
  prisma.handoffToken.findUnique = async () => ({
    id: 't1', token: 'X', kind: 'TERMS_SIGNING',
    expiresAt: FUTURE, consumedAt: new Date(), reservationId: 'r1',
    reservation: { id: 'r1', rentalAgreement: { id: 'a1' } },
  });
  await assert.rejects(
    () => termsSigningService.loadSession('X'),
    (err) => err.status === 410 && err.code === 'TOKEN_CONSUMED',
  );
});

test('wrong-kind token throws 410', async () => {
  prisma.handoffToken.findUnique = async () => ({
    id: 't1', token: 'X', kind: 'MOBILE_INSPECTION',
    expiresAt: FUTURE, consumedAt: null, reservationId: 'r1',
    reservation: { id: 'r1', rentalAgreement: { id: 'a1' } },
  });
  await assert.rejects(
    () => termsSigningService.loadSession('X'),
    (err) => err.status === 410 && err.code === 'TOKEN_WRONG_KIND',
  );
});

// ---------------------------------------------------------------------------
// saveInitial
// ---------------------------------------------------------------------------

test('saveInitial upserts the right section', async () => {
  await termsSigningService.saveInitial({
    token: 'TOK',
    sectionKey: 'rental_period',
    initialDataUrl: FAKE_DATA_URL,
    customerIp: '1.2.3.4',
  });
  assert.equal(upserts.length, 1);
  assert.equal(upserts[0].create.sectionKey, 'rental_period');
  assert.equal(upserts[0].create.customerIp, '1.2.3.4');
});

test('saveInitial rejects unknown sectionKey', async () => {
  await assert.rejects(
    () => termsSigningService.saveInitial({ token: 'TOK', sectionKey: 'made_up', initialDataUrl: FAKE_DATA_URL }),
    (err) => err.status === 400,
  );
});

test('saveInitial rejects tiny dataURL', async () => {
  await assert.rejects(
    () => termsSigningService.saveInitial({ token: 'TOK', sectionKey: 'rental_period', initialDataUrl: 'data:,' }),
    (err) => err.status === 400,
  );
});

// ---------------------------------------------------------------------------
// complete
// ---------------------------------------------------------------------------

test('complete fails when any section missing', async () => {
  prisma.agreementSectionInitial.findMany = async () => [
    { sectionKey: 'rental_period' },
  ];
  await assert.rejects(
    () => termsSigningService.complete({ token: 'TOK', signatureDataUrl: FAKE_DATA_URL, signerName: 'Erick Bou' }),
    (err) => err.code === 'INITIALS_INCOMPLETE',
  );
});

test('complete fires a transaction with three updates when all sections initialed', async () => {
  prisma.agreementSectionInitial.findMany = async () => TC_SECTIONS.map((s) => ({ sectionKey: s.key }));
  const r = await termsSigningService.complete({ token: 'TOK', signatureDataUrl: FAKE_DATA_URL, signerName: 'Erick Bou' });
  assert.equal(r.ok, true);
  assert.equal(txOps.length, 3, 'agreement update + session update + token consume');
});

// ---------------------------------------------------------------------------
// Token first, image second (2026-08-17).
//
// /api/sign takes no auth — the token IS the auth. Decoding the PNG is the
// expensive part of these calls, so it must happen only after the token has
// checked out; otherwise anyone who knows the URL can spend our CPU with no
// valid token. These tests fail if the decode moves back above loadToken.
// ---------------------------------------------------------------------------

import zlib from 'node:zlib';

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
/** An all-white 120x60 RGBA PNG — a valid image with no ink in it. */
function blankPng() {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(120, 0); ihdr.writeUInt32BE(60, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  const raw = Buffer.alloc((120 * 4 + 1) * 60, 0xff);
  for (let y = 0; y < 60; y += 1) raw[y * (120 * 4 + 1)] = 0; // filter byte
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
  return `data:image/png;base64,${png.toString('base64')}`;
}

test('complete checks the token before it decodes the image', async () => {
  prisma.handoffToken.findUnique = async () => null;
  // A blank canvas the analyzer WOULD reject with "signature is blank" — so if
  // this comes back as the blank error, the decode ran before the token check.
  await assert.rejects(
    () => termsSigningService.complete({ token: 'NOPE', signatureDataUrl: blankPng(), signerName: 'X' }),
    (err) => {
      assert.equal(err.code, 'TOKEN_INVALID', `expected the token to be rejected first, got: ${err.message}`);
      return true;
    },
  );
});

test('complete rejects an oversized signature only after the token is valid', async () => {
  const huge = 'data:image/png;base64,' + 'A'.repeat(600 * 1024);
  prisma.handoffToken.findUnique = async () => null;
  await assert.rejects(
    () => termsSigningService.complete({ token: 'NOPE', signatureDataUrl: huge, signerName: 'X' }),
    (err) => {
      assert.equal(err.code, 'TOKEN_INVALID', 'an invalid token must cost nothing');
      return true;
    },
  );
  // With a good token the size ceiling does apply.
  reset();
  await assert.rejects(
    () => termsSigningService.complete({ token: 'TOK', signatureDataUrl: huge, signerName: 'X' }),
    (err) => {
      assert.equal(err.status, 413, `expected 413, got ${err.status}: ${err.message}`);
      return true;
    },
  );
});

test('saveInitial checks the token before it stores the image', async () => {
  const huge = 'data:image/png;base64,' + 'A'.repeat(600 * 1024);
  prisma.handoffToken.findUnique = async () => null;
  await assert.rejects(
    () => termsSigningService.saveInitial({ token: 'NOPE', sectionKey: TC_SECTIONS[0].key, initialDataUrl: huge }),
    (err) => {
      assert.equal(err.code, 'TOKEN_INVALID', 'an invalid token must cost nothing');
      return true;
    },
  );
  reset();
  await assert.rejects(
    () => termsSigningService.saveInitial({ token: 'TOK', sectionKey: TC_SECTIONS[0].key, initialDataUrl: huge }),
    (err) => {
      assert.equal(err.status, 413, `expected 413, got ${err.status}: ${err.message}`);
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// The throttle must not cut a customer off mid-signature.
//
// /api/sign is rate-limited per IP, and the /sign page treats any error as
// fatal: it unmounts the flow and the drawn signature is lost. The pad posts
// on every pen-up, so one customer sends an initial per STROKE across every
// section and then completes. The ceiling has to clear that with room for the
// several customers a carrier CGNAT or branch WiFi puts behind one address.
// ---------------------------------------------------------------------------

test('the write ceilings match the cost profile of each endpoint', async () => {
  const {
    SIGN_INITIALS_MAX_PER_MIN, SIGN_COMPLETE_MAX_PER_MIN,
  } = await import('./terms-signing.routes.js');

  // Every section that can require an initial, including the conditional ones.
  const maxSections = TC_SECTIONS.length + 2; // + declined_insurance, damage_ack
  const strokesPerInitial = 4;                // a deliberate, unhurried signer
  const worstCaseSession = maxSections * strokesPerInitial; // initials only

  // /initials posts once per PEN-UP and decodes nothing, so it needs room for
  // the several customers a carrier CGNAT or branch WiFi puts on one IP.
  const CONCURRENT_SIGNERS = 4;
  assert.ok(
    SIGN_INITIALS_MAX_PER_MIN >= worstCaseSession * CONCURRENT_SIGNERS,
    `one session sends up to ${worstCaseSession} initials; a ceiling of `
    + `${SIGN_INITIALS_MAX_PER_MIN}/min does not clear ${CONCURRENT_SIGNERS} `
    + `signers on one IP, and a 429 discards the customer's signature`,
  );

  // /complete is posted ONCE per session and is the only endpoint that decodes
  // a PNG. It must NOT inherit the initials headroom: complete rejects a blank
  // signature before consuming the token, so one valid link replays forever.
  assert.ok(
    SIGN_COMPLETE_MAX_PER_MIN <= 30,
    `complete decodes a PNG and is called once per session; `
    + `${SIGN_COMPLETE_MAX_PER_MIN}/min is too much event loop to hand one IP`,
  );
  // ...but still generous next to the one call a real customer makes.
  assert.ok(SIGN_COMPLETE_MAX_PER_MIN >= 10, 'leave room for reload retries');
});
