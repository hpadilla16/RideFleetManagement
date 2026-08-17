/**
 * Route-layer tests for terms-signing.routes.js — the public /api/sign router.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * /api/sign was the only public token router in main.js mounted with no
 * `attachPublicRequestMeta` and no `createPublicRateLimitGuard`, while portal,
 * addendum, loaner, kiosk, store-board, issues, shuttle-tracker and booking all
 * carry them. Its two POSTs accept base64 images at any frequency, and its GET
 * answers "does this token exist?" at any frequency.
 *
 * A rate limit is only correct if it stops the abuse WITHOUT stopping the
 * customer, so the first test here is the legitimate worst case — a renter who
 * re-does every one of their initials three times before submitting. If a
 * future tightening of the cap breaks that customer, this fails first.
 *
 * Harness follows fee-rates.routes.test.mjs: bare Express app, node's own http
 * client, no supertest dep. `trust proxy` is set to 1 exactly as main.js does,
 * so each test can present its own client IP via X-Forwarded-For and get its
 * own bucket — the guard's buckets are module-level and outlive a test.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import { termsSigningPublicRouter } from './terms-signing.routes.js';
import { termsSigningService } from './terms-signing.service.js';
import { sectionsForAgreement } from './terms-content.js';

// The docker-compose CI job exports RATE_LIMIT_DISABLED=1 to keep the
// integration suite from throttling itself, and some dev .env files carry it.
// This file is ABOUT the guard, so it must never run against a passthrough.
delete process.env.RATE_LIMIT_DISABLED;

/**
 * Max sections a signing session can ever show: TC_SECTIONS' 6, plus
 * declined_insurance when the customer waived counter coverage.
 *
 * Derived from terms-content.js rather than typed as a literal — the first
 * version of this file said 8, counting damage_acknowledgement, which
 * terms-content.js states plainly is NOT a signing section and never lands in
 * AgreementSectionInitial. The write cap is justified by this number, so the
 * number has to come from the source of truth.
 */
const MAX_SECTIONS = sectionsForAgreement({ declinedInsurance: true }).length;

/** Must match terms-signing.routes.js. Asserted against the live header below. */
const WRITE_CAP = 45;
const REDO_BUDGET = 5;

let server;
let lastReq = null;

before(async () => {
  // The router is the unit under test; the service behind it is not.
  termsSigningService.loadSession = async () => ({ sections: [], brand: { companyName: 'Autos del Valle' } });
  termsSigningService.saveInitial = async () => ({ sectionKey: 'rental_period', signed: true });
  termsSigningService.complete = async () => ({ ok: true });

  const app = express();
  app.set('trust proxy', 1); // same as main.js — req.ip becomes the XFF client
  app.use(express.json());
  app.use((req, _res, next) => { lastReq = req; next(); });
  app.use('/api/sign', termsSigningPublicRouter);

  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

function request(method, path, { ip, body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request({
      method,
      hostname: '127.0.0.1',
      port: server.address().port,
      path,
      headers: {
        'x-forwarded-for': ip,
        ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}),
      },
    }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: raw }));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const initial = (ip) => request('POST', '/api/sign/TOK/initials', {
  ip, body: { sectionKey: 'rental_period', initialDataUrl: 'data:image/png;base64,AAAA' },
});

// ---------------------------------------------------------------------------
// The customer must get through
// ---------------------------------------------------------------------------

test('the write cap is still justified by the sections that exist', async () => {
  // The cap is not a round number, it is an argument: "the most a real
  // customer can post in a minute, plus room". If someone adds an eighth
  // signing section, the argument stops holding and this says so, instead of
  // a renter discovering it mid-signature.
  assert.equal(MAX_SECTIONS, 7, '6 canonical + declined_insurance');
  assert.ok(
    MAX_SECTIONS * REDO_BUDGET <= WRITE_CAP,
    `${MAX_SECTIONS} sections × ${REDO_BUDGET} attempts exceeds the ${WRITE_CAP}/min cap`,
  );
});

test('a renter who re-initials every section three times is never throttled', async () => {
  const ip = '203.0.113.10';
  for (let attempt = 0; attempt < 3; attempt += 1) {
    for (let section = 0; section < MAX_SECTIONS; section += 1) {
      const res = await initial(ip);
      assert.equal(res.status, 200, `initial ${attempt}/${section} was rejected: ${res.body}`);
    }
  }
  const done = await request('POST', '/api/sign/TOK/complete', {
    ip, body: { signatureDataUrl: 'data:image/png;base64,AAAA', signerName: 'Erick Bou' },
  });
  assert.equal(done.status, 200, `completing after ${MAX_SECTIONS * 3} initials was rejected: ${done.body}`);
});

// ---------------------------------------------------------------------------
// The abuser must not
// ---------------------------------------------------------------------------

test('writes are capped per IP', async () => {
  const ip = '203.0.113.20';
  let limit = null;
  for (let i = 0; i < WRITE_CAP; i += 1) {
    const res = await initial(ip);
    limit = Number(res.headers['x-public-rate-limit-limit']);
    assert.equal(res.status, 200, `write ${i + 1} should still be allowed`);
  }
  assert.equal(limit, WRITE_CAP, 'the documented write ceiling');
  const over = await initial(ip);
  assert.equal(over.status, 429);
});

test('a customer throttled on initials can still submit the signature', async () => {
  // The two used to share one bucket, which meant an over-eager initialer
  // could be locked out of SUBMITTING the signature they had just drawn — a
  // new way to block a signature on a route that previously had no cap at all.
  // The realistic path there is a slow connection, not abuse: CanvasPad fires
  // a POST on every finger-lift and the box only disables once the POST
  // returns, so on bad signal the customer keeps drawing and keeps posting.
  const ip = '203.0.113.21';
  for (let i = 0; i < 46; i += 1) await initial(ip);
  assert.equal((await initial(ip)).status, 429, 'initials are exhausted');

  const done = await request('POST', '/api/sign/TOK/complete', {
    ip, body: { signatureDataUrl: 'data:image/png;base64,AAAA', signerName: 'Erick Bou' },
  });
  assert.equal(done.status, 200, 'complete has its own budget');
});

test('complete is capped too, and far lower — one submission is the norm', async () => {
  const ip = '203.0.113.22';
  const submit = () => request('POST', '/api/sign/TOK/complete', {
    ip, body: { signatureDataUrl: 'data:image/png;base64,AAAA', signerName: 'Erick Bou' },
  });
  let limit = null;
  for (let i = 0; i < 10; i += 1) {
    const res = await submit();
    limit = Number(res.headers['x-public-rate-limit-limit']);
    assert.equal(res.status, 200, `submission ${i + 1} should still be allowed`);
  }
  assert.equal(limit, 10, 'retries after a transient failure, nothing more');
  assert.equal((await submit()).status, 429);
});

test('reads are capped per IP', async () => {
  const ip = '203.0.113.30';
  for (let i = 0; i < 60; i += 1) {
    assert.equal((await request('GET', '/api/sign/TOK', { ip })).status, 200);
  }
  const over = await request('GET', '/api/sign/TOK', { ip });
  assert.equal(over.status, 429, 'token-existence probing is capped');
});

test('one IP being throttled never touches another customer', async () => {
  const noisy = '203.0.113.40';
  for (let i = 0; i < 61; i += 1) await request('GET', '/api/sign/TOK', { ip: noisy });
  assert.equal((await request('GET', '/api/sign/TOK', { ip: noisy })).status, 429);
  assert.equal((await request('GET', '/api/sign/TOK', { ip: '203.0.113.41' })).status, 200);
});

// ---------------------------------------------------------------------------
// Both halves of the guard pair, on every route
// ---------------------------------------------------------------------------

test('every /api/sign route carries the public meta and the limiter', async () => {
  const cases = [
    ['GET', '/api/sign/TOK', 'terms-signing-read', undefined],
    ['POST', '/api/sign/TOK/initials', 'terms-signing-write', { sectionKey: 'rental_period', initialDataUrl: 'x' }],
    ['POST', '/api/sign/TOK/complete', 'terms-signing-complete', { signatureDataUrl: 'x', signerName: 'E' }],
  ];
  for (const [method, path, expectedName, body] of cases) {
    const res = await request(method, path, { ip: '203.0.113.50', body });
    assert.equal(res.status, 200, `${method} ${path}`);
    assert.ok(res.headers['x-public-rate-limit-limit'], `${method} ${path} has no limiter`);
    assert.equal(lastReq?.publicRequestMeta?.name, expectedName, `${method} ${path} meta`);
    assert.equal(lastReq?.publicRequestMeta?.ip, '203.0.113.50', 'meta records the real client IP');
  }
});
