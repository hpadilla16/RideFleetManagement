/**
 * Tests for backend/src/lib/storage/supabase-storage.js
 *
 * Strategy: stub `globalThis.fetch` per-test. The module reads
 * SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY at import time but only validates
 * them inside _request(), so we set both before importing.
 */
import { describe, it, before, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://test-project.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key';

const SB_URL = process.env.SUPABASE_URL;

let storage;
before(async () => {
  storage = await import('./supabase-storage.js');
});

// ---------------------------------------------------------------------------
// Tiny fetch-stub helper. Records every call; returns a queued Response.
// ---------------------------------------------------------------------------
function makeResponse({ status = 200, headers = {}, json, text, buffer } = {}) {
  const h = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => h.get(String(k).toLowerCase()) ?? null },
    async json() { return json; },
    async text() { return text ?? ''; },
    async arrayBuffer() {
      if (buffer instanceof Uint8Array) return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
      if (buffer instanceof ArrayBuffer) return buffer;
      return new ArrayBuffer(0);
    },
  };
}

let calls;
let originalFetch;
beforeEach(() => {
  calls = [];
  originalFetch = globalThis.fetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
});

function stubFetch(responder) {
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method || 'GET', headers: init.headers || {}, body: init.body });
    return responder(url, init);
  };
}

// ---------------------------------------------------------------------------
// uploadObject
// ---------------------------------------------------------------------------
describe('uploadObject', () => {
  it('sends correct headers + URL and returns metadata', async () => {
    stubFetch(() => makeResponse({
      status: 200,
      headers: { 'etag': '"abc123"', 'content-type': 'application/json' },
      json: { Key: 'inspection-photos/tenant-1/before.jpg' },
    }));

    const body = Buffer.from('hello world');
    const result = await storage.uploadObject({
      bucket: 'inspection-photos',
      path: 'tenant-1/before.jpg',
      body,
      contentType: 'image/jpeg',
      upsert: true,
    });

    assert.equal(calls.length, 1);
    const c = calls[0];
    assert.equal(c.method, 'POST');
    assert.equal(c.url, `${SB_URL}/storage/v1/object/inspection-photos/tenant-1/before.jpg`);
    assert.equal(c.headers['Content-Type'], 'image/jpeg');
    assert.equal(c.headers['x-upsert'], 'true');
    assert.equal(c.headers.apikey, 'test-service-role-key');
    assert.equal(c.headers.Authorization, 'Bearer test-service-role-key');
    assert.equal(c.body, body);

    assert.equal(result.path, 'inspection-photos/tenant-1/before.jpg');
    assert.equal(result.size, 11);
    assert.equal(result.etag, '"abc123"');
    assert.equal(result.contentType, 'image/jpeg');
  });

  it('defaults x-upsert to false', async () => {
    stubFetch(() => makeResponse({ status: 200, json: {} }));
    await storage.uploadObject({
      bucket: 'b', path: 'p.txt', body: Buffer.from('x'), contentType: 'text/plain',
    });
    assert.equal(calls[0].headers['x-upsert'], 'false');
  });
});

// ---------------------------------------------------------------------------
// downloadObject
// ---------------------------------------------------------------------------
describe('downloadObject', () => {
  it('decodes binary body and exposes content-type', async () => {
    const payload = new Uint8Array([1, 2, 3, 4, 5, 254, 255]);
    stubFetch(() => makeResponse({
      status: 200,
      headers: { 'content-type': 'image/png' },
      buffer: payload,
    }));

    const result = await storage.downloadObject({ bucket: 'b', path: 'a/b.png' });
    assert.equal(calls[0].method, 'GET');
    assert.equal(calls[0].url, `${SB_URL}/storage/v1/object/b/a/b.png`);
    assert.ok(Buffer.isBuffer(result.body));
    assert.equal(result.body.length, payload.byteLength);
    assert.deepEqual([...result.body], [...payload]);
    assert.equal(result.contentType, 'image/png');
    assert.equal(result.size, payload.byteLength);
  });

  it('throws NotFoundError on 404', async () => {
    stubFetch(() => makeResponse({
      status: 404,
      headers: { 'content-type': 'application/json' },
      json: { message: 'Object not found' },
    }));
    await assert.rejects(
      () => storage.downloadObject({ bucket: 'b', path: 'missing.txt' }),
      (err) => err instanceof storage.NotFoundError && err.status === 404,
    );
  });
});

// ---------------------------------------------------------------------------
// getSignedUrl
// ---------------------------------------------------------------------------
describe('getSignedUrl', () => {
  it('returns the URL from the API response', async () => {
    stubFetch(() => makeResponse({
      status: 200,
      headers: { 'content-type': 'application/json' },
      json: { signedURL: '/object/sign/photos/a.jpg?token=xyz' },
    }));
    const url = await storage.getSignedUrl({ bucket: 'photos', path: 'a.jpg', expiresIn: 600 });
    assert.equal(calls[0].method, 'POST');
    assert.equal(calls[0].url, `${SB_URL}/storage/v1/object/sign/photos/a.jpg`);
    assert.equal(JSON.parse(calls[0].body).expiresIn, 600);
    assert.equal(url, `${SB_URL}/storage/v1/object/sign/photos/a.jpg?token=xyz`);
  });

  it('handles absolute signedURL', async () => {
    const abs = 'https://cdn.example.com/object/sign/x?token=t';
    stubFetch(() => makeResponse({ status: 200, json: { signedURL: abs } }));
    const url = await storage.getSignedUrl({ bucket: 'b', path: 'x' });
    assert.equal(url, abs);
  });
});

// ---------------------------------------------------------------------------
// getPublicUrl
// ---------------------------------------------------------------------------
describe('getPublicUrl', () => {
  it('builds the public URL without hitting fetch', () => {
    stubFetch(() => { throw new Error('should not be called'); });
    const url = storage.getPublicUrl({ bucket: 'photos', path: 'tenant/img.jpg' });
    assert.equal(url, `${SB_URL}/storage/v1/object/public/photos/tenant/img.jpg`);
    assert.equal(calls.length, 0);
  });
});

// ---------------------------------------------------------------------------
// deleteObject
// ---------------------------------------------------------------------------
describe('deleteObject', () => {
  it('swallows 404 (idempotent)', async () => {
    stubFetch(() => makeResponse({
      status: 404,
      headers: { 'content-type': 'application/json' },
      json: { message: 'not found' },
    }));
    const result = await storage.deleteObject({ bucket: 'b', path: 'gone.txt' });
    assert.deepEqual(result, { deleted: false, reason: 'not-found' });
  });

  it('returns { deleted: true } on 200', async () => {
    stubFetch(() => makeResponse({ status: 200, json: {} }));
    const result = await storage.deleteObject({ bucket: 'b', path: 'a.txt' });
    assert.deepEqual(result, { deleted: true });
    assert.equal(calls[0].method, 'DELETE');
  });
});

// ---------------------------------------------------------------------------
// Error mapping
// ---------------------------------------------------------------------------
describe('error mapping', () => {
  it('maps 401 → UnauthorizedError', async () => {
    stubFetch(() => makeResponse({
      status: 401,
      headers: { 'content-type': 'application/json' },
      json: { message: 'Invalid JWT' },
    }));
    await assert.rejects(
      () => storage.uploadObject({
        bucket: 'b', path: 'p', body: Buffer.from('x'), contentType: 'text/plain',
      }),
      (err) => err instanceof storage.UnauthorizedError && err.status === 401,
    );
  });

  it('maps 403 → UnauthorizedError', async () => {
    stubFetch(() => makeResponse({
      status: 403,
      headers: { 'content-type': 'application/json' },
      json: { message: 'Forbidden' },
    }));
    await assert.rejects(
      () => storage.downloadObject({ bucket: 'b', path: 'p' }),
      (err) => err instanceof storage.UnauthorizedError && err.status === 403,
    );
  });

  it('maps 500 → StorageError', async () => {
    stubFetch(() => makeResponse({
      status: 500,
      headers: { 'content-type': 'application/json' },
      json: { message: 'kaboom' },
    }));
    await assert.rejects(
      () => storage.downloadObject({ bucket: 'b', path: 'p' }),
      (err) =>
        err instanceof storage.StorageError &&
        !(err instanceof storage.NotFoundError) &&
        !(err instanceof storage.UnauthorizedError) &&
        err.status === 500 &&
        /kaboom/.test(err.message),
    );
  });
});

// ---------------------------------------------------------------------------
// safePath
// ---------------------------------------------------------------------------
describe('safePath', () => {
  it('strips leading slashes', () => {
    assert.equal(storage.safePath('/a', 'b'), 'a/b');
    assert.equal(storage.safePath('///foo', '/bar/'), 'foo/bar');
  });

  it('rejects ".." segments', () => {
    assert.throws(
      () => storage.safePath('a', '..', 'b'),
      (err) => err instanceof storage.StorageError && err.status === 400,
    );
    assert.throws(
      () => storage.safePath('a/../b'),
      (err) => err instanceof storage.StorageError,
    );
  });

  it('collapses empty segments', () => {
    assert.equal(storage.safePath('a', '', 'b', null, undefined, 'c'), 'a/b/c');
    assert.equal(storage.safePath('a//b///c'), 'a/b/c');
  });

  it('joins multi-segment inputs', () => {
    assert.equal(
      storage.safePath('inspections', 'tenant-uuid', 'before.jpg'),
      'inspections/tenant-uuid/before.jpg',
    );
  });

  it('throws when result is empty', () => {
    assert.throws(() => storage.safePath('', '/', null), (err) => err instanceof storage.StorageError);
  });

  it('rejects control characters', () => {
    assert.throws(() => storage.safePath('a\x00b'), (err) => err instanceof storage.StorageError);
  });
});
