/**
 * The signature IS the authentication on both Authorize.Net webhook endpoints.
 * There is no token, no session and no allowlist behind it — so every property
 * asserted here is load-bearing, and a regression in this file is an unlocked
 * door on a route that writes to the money tables.
 *
 * The extraction this suite guards (customer-portal.routes.js -> lib/) had no
 * tests at all in its original home. That is the gap being closed.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import {
  verifyAuthnetWebhookSignature,
  signAuthnetWebhookBody,
  authnetSignatureKeyHex,
  safeHexEqual,
  rawWebhookBody,
  authnetSignatureHeader,
} from './authnet-webhook-signature.js';

// A 64-char hex string, exactly the shape the merchant portal shows.
const KEY = 'A1B2C3D4E5F60718293A4B5C6D7E8F90A1B2C3D4E5F60718293A4B5C6D7E8F90';
const BODY = JSON.stringify({
  notificationId: '3f1a9c0e-77aa-4f61-9d2e-5b8e1c0a2d44',
  eventType: 'net.authorize.customer.subscription.suspended',
  eventDate: '2026-08-26T13:27:04.1234567Z',
  webhookId: 'w-1',
  payload: { id: '9471226', entityName: 'subscription' },
});

test('a body signed with the key as HEX BYTES verifies', () => {
  const header = signAuthnetWebhookBody(BODY, KEY, { encoding: 'hex-bytes' });
  const result = verifyAuthnetWebhookSignature(Buffer.from(BODY, 'utf8'), header, KEY);
  assert.equal(result.ok, true);
  assert.equal(result.method, 'hex-bytes');
});

test('a body signed with the key as LATIN1 TEXT also verifies', () => {
  // The second reading of the Signature Key. Authorize.Net's documentation is
  // ambiguous about which is right and real accounts have been seen doing this
  // one, so dropping it presents as "works in sandbox, silently fails in prod".
  const header = signAuthnetWebhookBody(BODY, KEY, { encoding: 'latin1-text' });
  const result = verifyAuthnetWebhookSignature(Buffer.from(BODY, 'utf8'), header, KEY);
  assert.equal(result.ok, true);
  assert.equal(result.method, 'latin1-text');
});

test('the sha512= prefix is optional and case-insensitive, and hex case does not matter', () => {
  const full = signAuthnetWebhookBody(BODY, KEY);
  const bare = full.slice('sha512='.length);
  for (const header of [full, bare, `SHA512=${bare}`, `sha512=${bare.toLowerCase()}`, ` ${full} `]) {
    assert.equal(
      verifyAuthnetWebhookSignature(BODY, header, KEY).ok,
      true,
      `header form rejected: ${header.slice(0, 16)}…`,
    );
  }
});

test('a signature over DIFFERENT bytes is rejected', () => {
  const header = signAuthnetWebhookBody(BODY, KEY);
  const tampered = BODY.replace('9471226', '9471227');
  assert.equal(verifyAuthnetWebhookSignature(tampered, header, KEY).ok, false);
});

test('a signature made with a DIFFERENT key is rejected', () => {
  const otherKey = 'FFEEDDCCBBAA99887766554433221100FFEEDDCCBBAA99887766554433221100';
  const header = signAuthnetWebhookBody(BODY, otherKey);
  assert.equal(verifyAuthnetWebhookSignature(BODY, header, KEY).ok, false);
});

test('a missing, empty or malformed header is rejected — never throws', () => {
  for (const header of [undefined, null, '', '   ', 'sha512=', 'not-hex-at-all', 'sha512=abc']) {
    const result = verifyAuthnetWebhookSignature(BODY, header, KEY);
    assert.equal(result.ok, false, `accepted header ${JSON.stringify(header)}`);
  }
  // Odd-length hex would be silently truncated by Buffer.from and could
  // otherwise collide with a truncated expectation.
  assert.equal(verifyAuthnetWebhookSignature(BODY, `sha512=${'a'.repeat(127)}`, KEY).ok, false);
});

test('an empty body is rejected even with a well-formed signature over it', () => {
  // Signing the empty string is trivial for anyone holding the key, but a
  // zero-byte webhook is never a real event; accepting one would let an empty
  // POST reach the handler.
  const header = signAuthnetWebhookBody('', KEY);
  assert.equal(verifyAuthnetWebhookSignature('', header, KEY).ok, false);
  assert.equal(verifyAuthnetWebhookSignature(Buffer.alloc(0), header, KEY).ok, false);
});

test('a missing or blank signature key is rejected — a misconfigured endpoint fails CLOSED', () => {
  const header = signAuthnetWebhookBody(BODY, KEY);
  for (const key of [undefined, null, '', '   ', 'zzzz']) {
    assert.equal(
      verifyAuthnetWebhookSignature(BODY, header, key).ok,
      false,
      `accepted key ${JSON.stringify(key)}`,
    );
  }
});

test('RAW BYTES, not a re-serialised body — this is the whole ballgame', () => {
  // JSON.stringify(JSON.parse(x)) is not x. Key order moves, whitespace
  // vanishes. Verifying against a re-serialised body rejects every genuine
  // event, with no visible cause, on an endpoint whose failure mode is silence.
  const spaced = '{\n  "b": 2,\n  "a": 1\n}';
  const header = signAuthnetWebhookBody(spaced, KEY);
  assert.equal(verifyAuthnetWebhookSignature(spaced, header, KEY).ok, true);

  const reserialised = JSON.stringify(JSON.parse(spaced));
  assert.notEqual(reserialised, spaced, 'precondition: the two encodings must differ');
  assert.equal(
    verifyAuthnetWebhookSignature(reserialised, header, KEY).ok,
    false,
    'a re-serialised body must NOT verify — proving the HMAC is over raw bytes',
  );
});

test('a body with non-ASCII bytes verifies on the Buffer, not on a lossy string', () => {
  const utf8 = JSON.stringify({ name: 'Rentas Añasco — cañón', id: '1' });
  const buf = Buffer.from(utf8, 'utf8');
  const header = signAuthnetWebhookBody(buf, KEY);
  assert.equal(verifyAuthnetWebhookSignature(buf, header, KEY).ok, true);
  // And the string path must agree with the Buffer path for the same content.
  assert.equal(verifyAuthnetWebhookSignature(utf8, header, KEY).ok, true);
});

test('rawWebhookBody mirrors the express.json verify hook, and never guesses from req.body', () => {
  const buf = Buffer.from(BODY, 'utf8');
  assert.equal(rawWebhookBody({ rawBodyBuffer: buf }).equals(buf), true);
  // Fallback to the utf8 string the same hook stashes.
  assert.equal(rawWebhookBody({ rawBody: BODY }).equals(buf), true);
  // An empty buffer must fall through to the string, not be taken as the body.
  assert.equal(rawWebhookBody({ rawBodyBuffer: Buffer.alloc(0), rawBody: BODY }).equals(buf), true);
  // req.body is NOT a source. A parsed object must yield nothing.
  assert.equal(rawWebhookBody({ body: JSON.parse(BODY) }).length, 0);
  assert.equal(rawWebhookBody({}).length, 0);
  assert.equal(rawWebhookBody(null).length, 0);
});

test('authnetSignatureHeader reads the header whatever the proxy cased it as', () => {
  assert.equal(
    authnetSignatureHeader({ get: (k) => (k === 'X-ANET-Signature' ? 'sha512=AB' : null) }),
    'sha512=AB',
  );
  assert.equal(
    authnetSignatureHeader({ get: (k) => (k === 'x-anet-signature' ? 'sha512=CD' : null) }),
    'sha512=CD',
  );
  // No express `get` at all (a bare object in a unit test) still works.
  assert.equal(authnetSignatureHeader({ headers: { 'x-anet-signature': 'sha512=EF' } }), 'sha512=EF');
  assert.equal(authnetSignatureHeader({}), '');
});

test('authnetSignatureKeyHex strips formatting without changing the key material', () => {
  assert.equal(authnetSignatureKeyHex(' a1b2-c3d4 '), 'a1b2c3d4');
  assert.equal(authnetSignatureKeyHex('zzz'), '');
  assert.equal(authnetSignatureKeyHex(null), '');
});

test('safeHexEqual is length-guarded and returns false rather than throwing', () => {
  assert.equal(safeHexEqual('abcd', 'abcd'), true);
  assert.equal(safeHexEqual('abcd', 'abce'), false);
  // timingSafeEqual THROWS on unequal lengths; a throw inside a verifier is an
  // outage rather than a rejection, so this must be a quiet false.
  assert.equal(safeHexEqual('abcd', 'ab'), false);
  assert.equal(safeHexEqual('', ''), false);
});

test('the verifier agrees with an independent HMAC computed by hand', () => {
  // Pins the algorithm itself (HMAC-SHA512, key as hex bytes) rather than only
  // agreeing with our own signer.
  const expected = crypto
    .createHmac('sha512', Buffer.from(KEY, 'hex'))
    .update(Buffer.from(BODY, 'utf8'))
    .digest('hex');
  assert.equal(verifyAuthnetWebhookSignature(BODY, `sha512=${expected}`, KEY).ok, true);
});
