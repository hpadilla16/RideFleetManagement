/**
 * Authorize.Net webhook signature verification — the shared primitive.
 *
 * EXTRACTED, NOT REWRITTEN (2026-08-27, billing Phase 2). This code lived inside
 * `modules/customer-portal/customer-portal.routes.js:503-553`, where it had been
 * hardened against a real production failure. Two endpoints now need it — the
 * per-tenant RENTAL receiver that was already there, and the new BILLING
 * receiver that guards Ride's own subscription revenue — and a second copy of a
 * money-path signature check is a second copy that can drift.
 *
 * The behaviour below is preserved deliberately, quirks included:
 *
 *  1. THE SIGNATURE KEY HAS TWO INTERPRETATIONS AND AUTHORIZE.NET DOES NOT SAY
 *     WHICH. The merchant portal shows the Signature Key as a hex string. It can
 *     mean "these are 32 bytes, written in hex" (the documented reading) or "this
 *     is a 64-character text secret" (what some accounts actually behave like).
 *     Both are tried, and either matching is a pass. Removing one of them breaks
 *     verification on some accounts and not others — which presents as "webhooks
 *     work in sandbox, silently fail in production", the single most expensive
 *     shape this bug can take. That ambiguity has already cost somebody an
 *     afternoon here; do not rediscover it.
 *
 *  2. THE HEADER MAY OR MAY NOT CARRY A `sha512=` PREFIX. Stripped
 *     case-insensitively.
 *
 *  3. THE HMAC IS OVER RAW REQUEST BYTES. Never over a re-serialised `req.body`:
 *     `JSON.stringify(JSON.parse(x))` is not `x` — key order and whitespace both
 *     move — so a re-serialise turns a valid signature into a rejection with no
 *     visible cause.
 *
 * The comparison is `timingSafeEqual` over equal-length buffers, so a caller
 * cannot learn the expected digest one byte at a time from response timing.
 *
 * NOTE ON THE RETURN VALUE. `expectedHex` / `expectedHexAlt` are returned because
 * the rental endpoint logs their prefixes on failure. THE BILLING ENDPOINT MUST
 * NOT: those prefixes are derived from the key, and a route guarding our own
 * revenue should hand a log reader nothing. Read `.ok` and stop.
 */
import crypto from 'crypto';

/** The Signature Key with every non-hex character stripped. */
export function authnetSignatureKeyHex(value = '') {
  return String(value || '').replace(/[^a-fA-F0-9]/g, '').trim();
}

/**
 * Constant-time hex compare. Returns false — never throws — on any length
 * mismatch or malformed input, because `timingSafeEqual` throws on unequal
 * lengths and a throw inside a verifier is an outage, not a rejection.
 */
export function safeHexEqual(expectedHex = '', actualHex = '') {
  if (!expectedHex || !actualHex || expectedHex.length !== actualHex.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(expectedHex, 'hex'), Buffer.from(actualHex, 'hex'));
  } catch {
    return false;
  }
}

/**
 * Verify one Authorize.Net webhook body against one Signature Key.
 *
 * @param {Buffer|string} rawBody  RAW request bytes. See quirk 3.
 * @param {string} header          The X-ANET-Signature header, with or without `sha512=`.
 * @param {string} signatureKey    The Signature Key from the merchant portal.
 * @returns {{ok:boolean, method:string, expectedHex:string, expectedHexAlt?:string, actualHex:string}}
 */
export function verifyAuthnetWebhookSignature(rawBody = '', header = '', signatureKey = '') {
  const payloadBuffer = Buffer.isBuffer(rawBody)
    ? rawBody
    : Buffer.from(String(rawBody || ''), 'utf8');
  const signatureHex = authnetSignatureKeyHex(signatureKey);
  const signatureText = String(signatureKey || '').trim();
  const rawHeader = String(header || '').trim();

  // An empty body, an unset key or a missing header are all "no" — and all
  // indistinguishable to the caller, which is the point on a public route.
  if (!payloadBuffer.length || !signatureHex || !rawHeader) {
    return { ok: false, method: '', expectedHex: '', actualHex: '' };
  }

  const actualHex = String(
    rawHeader.toLowerCase().startsWith('sha512=') ? rawHeader.slice(7) : rawHeader,
  ).trim().toLowerCase();
  // Odd length cannot be hex; Buffer.from would silently truncate it.
  if (!actualHex || actualHex.length % 2 !== 0) {
    return { ok: false, method: '', expectedHex: '', actualHex };
  }

  try {
    // Reading 1: the portal's hex string IS the key material.
    const expectedHexBinary = crypto
      .createHmac('sha512', Buffer.from(signatureHex, 'hex'))
      .update(payloadBuffer)
      .digest('hex')
      .toLowerCase();
    // Reading 2: the portal's hex string is the key AS TEXT.
    const expectedHexLatin1 = signatureText
      ? crypto.createHmac('sha512', Buffer.from(signatureText, 'latin1'))
        .update(payloadBuffer).digest('hex').toLowerCase()
      : '';

    const matchesBinary = safeHexEqual(expectedHexBinary, actualHex);
    const matchesLatin1 = safeHexEqual(expectedHexLatin1, actualHex);

    return {
      ok: matchesBinary || matchesLatin1,
      method: matchesBinary ? 'hex-bytes' : matchesLatin1 ? 'latin1-text' : '',
      expectedHex: expectedHexBinary,
      expectedHexAlt: expectedHexLatin1,
      actualHex,
    };
  } catch {
    return { ok: false, method: '', expectedHex: '', actualHex };
  }
}

/**
 * The RAW request bytes for a webhook, in the exact order the rental receiver
 * looks for them (`customer-portal.routes.js:607-609`).
 *
 * `main.js:190-195` installs an `express.json({ verify })` hook that stashes the
 * unparsed body on EVERY request as both `req.rawBodyBuffer` (Buffer) and
 * `req.rawBody` (utf8 string). The Buffer is preferred and the string is the
 * fallback; `req.body` is never an input here — see quirk 3 above.
 *
 * Returns an empty Buffer when neither is present, so a caller's `.length`
 * check is enough and no verification path can be reached with a body we did
 * not actually receive.
 */
export function rawWebhookBody(req) {
  if (Buffer.isBuffer(req?.rawBodyBuffer) && req.rawBodyBuffer.length) return req.rawBodyBuffer;
  if (req?.rawBody) return Buffer.from(String(req.rawBody), 'utf8');
  return Buffer.alloc(0);
}

/** The X-ANET-Signature header, however the proxy cased it. */
export function authnetSignatureHeader(req) {
  const viaGetter = typeof req?.get === 'function'
    ? (req.get('X-ANET-Signature') || req.get('x-anet-signature'))
    : null;
  return String(viaGetter || req?.headers?.['x-anet-signature'] || '').trim();
}

/**
 * Produce the header Authorize.Net would send. FOR TESTS AND LOCAL REPLAY ONLY
 * — nothing in the request path signs anything.
 *
 * It lives next to the verifier on purpose: a test that signs with its own
 * private copy of the algorithm proves the test agrees with the test, and would
 * keep passing after the verifier's key handling drifted. Signing here means the
 * suite exercises both readings of the key against the real implementation.
 */
export function signAuthnetWebhookBody(rawBody, signatureKey, { encoding = 'hex-bytes' } = {}) {
  const payloadBuffer = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody), 'utf8');
  const key = encoding === 'latin1-text'
    ? Buffer.from(String(signatureKey).trim(), 'latin1')
    : Buffer.from(authnetSignatureKeyHex(signatureKey), 'hex');
  return `sha512=${crypto.createHmac('sha512', key).update(payloadBuffer).digest('hex').toUpperCase()}`;
}
