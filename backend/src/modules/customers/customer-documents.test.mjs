/**
 * Unit tests for customer-documents.js (pure functions only — no real Storage,
 * no Prisma, no network). Injected signer/uploader where needed.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  CUSTOMER_DOCS_BUCKET,
  MAX_DOCUMENT_BYTES,
  decodeDocumentValue,
  isStoragePath,
  uploadCustomerDocument,
  materializeDocumentRef,
  customerDocsStorageEnabled,
  maybeUploadCustomerDocument
} from './customer-documents.js';

// 1x1 transparent PNG.
const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
// Minimal JPEG-ish bytes (FFD8FF... ) base64.
const JPEG_B64 = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a]).toString('base64');
// Minimal PDF: starts with %PDF magic header.
const PDF_BYTES = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\n', 'utf8');
const PDF_B64 = PDF_BYTES.toString('base64');

// A read-back downloader that returns the EXACT bytes recorded by a paired
// uploader, so the hardened read-back verify passes. Use mkVerifyPair() to get
// a matched { uploader, downloader }.
function mkVerifyPair() {
  const store = new Map();
  const uploader = async (a) => { store.set(a.path, a.body); return { path: a.path }; };
  const downloader = async ({ path }) => ({ body: store.get(path) || Buffer.alloc(0) });
  return { uploader, downloader, store };
}

describe('decodeDocumentValue', () => {
  it('decodes a data:image/png base64 value → png', () => {
    const out = decodeDocumentValue(`data:image/png;base64,${PNG_B64}`);
    assert.equal(out.ext, 'png');
    assert.equal(out.contentType, 'image/png');
    assert.ok(Buffer.isBuffer(out.buffer));
    assert.ok(out.buffer.byteLength > 0);
  });

  it('decodes a data:image/jpeg base64 value → jpg', () => {
    const out = decodeDocumentValue(`data:image/jpeg;base64,${JPEG_B64}`);
    assert.equal(out.ext, 'jpg');
    assert.equal(out.contentType, 'image/jpeg');
  });

  it('decodes a data:application/pdf base64 value → pdf', () => {
    const out = decodeDocumentValue(`data:application/pdf;base64,${PDF_B64}`);
    assert.equal(out.ext, 'pdf');
    assert.equal(out.contentType, 'application/pdf');
  });

  it('detects a PDF by magic header even with no/foreign mime → pdf', () => {
    // raw base64 (no data: prefix) of %PDF bytes must still resolve to pdf.
    const out = decodeDocumentValue(PDF_B64);
    assert.equal(out.ext, 'pdf');
    assert.equal(out.contentType, 'application/pdf');
  });

  it('unknown image mime falls back to jpg', () => {
    const out = decodeDocumentValue(`data:image/tiff;base64,${JPEG_B64}`);
    assert.equal(out.ext, 'jpg');
  });

  it('passes through http(s) URLs', () => {
    const out = decodeDocumentValue('https://cdn.example.com/x.png');
    assert.deepEqual(out, { passthrough: true, value: 'https://cdn.example.com/x.png' });
  });

  it('throws for empty / nullish', () => {
    assert.throws(() => decodeDocumentValue(''), /empty/i);
    assert.throws(() => decodeDocumentValue(null), /empty/i);
    assert.throws(() => decodeDocumentValue('   '), /empty/i);
  });

  it('throws when oversize (> 15MB)', () => {
    // Build a buffer just over the cap, then base64-encode it.
    const big = Buffer.alloc(MAX_DOCUMENT_BYTES + 16, 0x41); // 'A'
    const b64 = big.toString('base64');
    assert.throws(() => decodeDocumentValue(`data:image/png;base64,${b64}`), /exceeds max size/i);
  });
});

describe('isStoragePath', () => {
  it('true for tenants/... paths', () => {
    assert.equal(isStoragePath('tenants/t1/customers/c1/id-photo_abc.png'), true);
  });
  it('false for http(s) URLs', () => {
    assert.equal(isStoragePath('https://x.co/a.png'), false);
    assert.equal(isStoragePath('http://x.co/a.png'), false);
  });
  it('false for data: URLs', () => {
    assert.equal(isStoragePath(`data:image/png;base64,${PNG_B64}`), false);
  });
  it('false for raw base64 blobs (long, no slash, base64 alphabet)', () => {
    const blob = PNG_B64.repeat(3); // >100 chars, base64 alphabet
    assert.equal(isStoragePath(blob), false);
  });
  it('false for empty / non-string', () => {
    assert.equal(isStoragePath(''), false);
    assert.equal(isStoragePath(null), false);
    assert.equal(isStoragePath(undefined), false);
    assert.equal(isStoragePath(123), false);
  });
});

describe('uploadCustomerDocument', () => {
  it('uploads and returns the storage path', async () => {
    const calls = [];
    const store = new Map();
    const uploader = async (a) => { calls.push(a); store.set(a.path, a.body); return { path: a.path }; };
    const downloader = async ({ path }) => ({ body: store.get(path) });
    const path = await uploadCustomerDocument({
      raw: `data:image/png;base64,${PNG_B64}`,
      tenantId: 't1',
      customerId: 'c1',
      kind: 'id-photo',
      uploader,
      downloader
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].bucket, CUSTOMER_DOCS_BUCKET);
    assert.equal(calls[0].upsert, true);
    assert.equal(calls[0].contentType, 'image/png');
    assert.match(path, /^tenants\/t1\/customers\/c1\/id-photo_[0-9a-f-]+\.png$/);
  });

  it('passes through an http URL unchanged (no upload)', async () => {
    let n = 0;
    const uploader = async () => { n++; return {}; };
    const out = await uploadCustomerDocument({
      raw: 'https://cdn.example.com/x.pdf',
      tenantId: 't1',
      customerId: 'c1',
      kind: 'insurance',
      uploader
    });
    assert.equal(n, 0);
    assert.equal(out, 'https://cdn.example.com/x.pdf');
  });

  it('uses pdf extension for PDF docs', async () => {
    const uploader = async (a) => ({ path: a.path });
    const path = await uploadCustomerDocument({
      raw: `data:application/pdf;base64,${PDF_B64}`,
      tenantId: 't1', customerId: 'c1', kind: 'insurance', uploader, downloader: false
    });
    assert.match(path, /insurance_[0-9a-f-]+\.pdf$/);
  });

  it('throws if tenantId/customerId missing', async () => {
    await assert.rejects(
      () => uploadCustomerDocument({ raw: `data:image/png;base64,${PNG_B64}`, customerId: 'c1', kind: 'id-photo' }),
      /tenantId is required/i
    );
    await assert.rejects(
      () => uploadCustomerDocument({ raw: `data:image/png;base64,${PNG_B64}`, tenantId: 't1', kind: 'id-photo' }),
      /customerId is required/i
    );
  });
});

describe('materializeDocumentRef', () => {
  it('passes http(s) URLs through', async () => {
    const out = await materializeDocumentRef('https://cdn.example.com/a.png', {
      signer: async () => 'SHOULD_NOT_BE_CALLED'
    });
    assert.equal(out, 'https://cdn.example.com/a.png');
  });

  it('signs a storage path via the injected signer', async () => {
    const calls = [];
    const signer = async (a) => { calls.push(a); return `https://signed/${a.path}?token=xyz`; };
    const out = await materializeDocumentRef('tenants/t1/customers/c1/id-photo_abc.png', { signer });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].bucket, CUSTOMER_DOCS_BUCKET);
    assert.equal(calls[0].expiresIn, 3600);
    assert.equal(out, 'https://signed/tenants/t1/customers/c1/id-photo_abc.png?token=xyz');
  });

  it('returns legacy inline base64 unchanged', async () => {
    const v = `data:image/png;base64,${PNG_B64}`;
    const out = await materializeDocumentRef(v, { signer: async () => 'NOPE' });
    assert.equal(out, v);
  });

  it("returns '' when the signer throws (best-effort)", async () => {
    const signer = async () => { throw new Error('boom'); };
    const out = await materializeDocumentRef('tenants/t1/customers/c1/x.png', { signer });
    assert.equal(out, '');
  });

  it('returns empty value unchanged', async () => {
    assert.equal(await materializeDocumentRef('', {}), '');
    assert.equal(await materializeDocumentRef(null, {}), null);
  });
});

describe('customerDocsStorageEnabled / maybeUploadCustomerDocument flag gating', () => {
  it('flag OFF → value returned unchanged, uploader never called', async () => {
    const prev = process.env.CUSTOMER_DOCS_STORAGE_ENABLED;
    delete process.env.CUSTOMER_DOCS_STORAGE_ENABLED;
    try {
      assert.equal(customerDocsStorageEnabled(), false);
      let n = 0;
      const uploader = async () => { n++; return {}; };
      const v = `data:image/png;base64,${PNG_B64}`;
      const out = await maybeUploadCustomerDocument(v, {
        tenantId: 't1', customerId: 'c1', kind: 'id-photo', uploader
      });
      assert.equal(out, v);
      assert.equal(n, 0);
    } finally {
      if (prev === undefined) delete process.env.CUSTOMER_DOCS_STORAGE_ENABLED;
      else process.env.CUSTOMER_DOCS_STORAGE_ENABLED = prev;
    }
  });

  it('flag ON + inline base64 → uploads and returns path', async () => {
    const prev = process.env.CUSTOMER_DOCS_STORAGE_ENABLED;
    process.env.CUSTOMER_DOCS_STORAGE_ENABLED = 'true';
    try {
      assert.equal(customerDocsStorageEnabled(), true);
      const store = new Map();
      const uploader = async (a) => { store.set(a.path, a.body); return { path: a.path }; };
      const downloader = async ({ path }) => ({ body: store.get(path) });
      const out = await maybeUploadCustomerDocument(`data:image/png;base64,${PNG_B64}`, {
        tenantId: 't1', customerId: 'c1', kind: 'id-photo', uploader, downloader
      });
      assert.match(out, /^tenants\/t1\/customers\/c1\/id-photo_/);
    } finally {
      if (prev === undefined) delete process.env.CUSTOMER_DOCS_STORAGE_ENABLED;
      else process.env.CUSTOMER_DOCS_STORAGE_ENABLED = prev;
    }
  });

  it('flag ON + upload throws → FALLS BACK to original base64 (no throw)', async () => {
    const prev = process.env.CUSTOMER_DOCS_STORAGE_ENABLED;
    process.env.CUSTOMER_DOCS_STORAGE_ENABLED = 'true';
    try {
      const uploader = async () => { throw new Error('storage 500'); };
      const v = `data:image/png;base64,${PNG_B64}`;
      let warned = 0;
      const out = await maybeUploadCustomerDocument(v, {
        tenantId: 't1', customerId: 'c1', kind: 'id-photo', uploader,
        logger: { warn: () => { warned++; } }
      });
      assert.equal(out, v); // fell back to inline base64
      assert.equal(warned, 1);
    } finally {
      if (prev === undefined) delete process.env.CUSTOMER_DOCS_STORAGE_ENABLED;
      else process.env.CUSTOMER_DOCS_STORAGE_ENABLED = prev;
    }
  });

  it('flag ON + already a storage path → unchanged, no upload', async () => {
    const prev = process.env.CUSTOMER_DOCS_STORAGE_ENABLED;
    process.env.CUSTOMER_DOCS_STORAGE_ENABLED = 'true';
    try {
      let n = 0;
      const uploader = async () => { n++; return {}; };
      const p = 'tenants/t1/customers/c1/id-photo_abc.png';
      const out = await maybeUploadCustomerDocument(p, {
        tenantId: 't1', customerId: 'c1', kind: 'id-photo', uploader
      });
      assert.equal(out, p);
      assert.equal(n, 0);
    } finally {
      if (prev === undefined) delete process.env.CUSTOMER_DOCS_STORAGE_ENABLED;
      else process.env.CUSTOMER_DOCS_STORAGE_ENABLED = prev;
    }
  });

  it('flag ON + http URL → unchanged, no upload', async () => {
    const prev = process.env.CUSTOMER_DOCS_STORAGE_ENABLED;
    process.env.CUSTOMER_DOCS_STORAGE_ENABLED = 'true';
    try {
      let n = 0;
      const uploader = async () => { n++; return {}; };
      const out = await maybeUploadCustomerDocument('https://cdn.example.com/a.pdf', {
        tenantId: 't1', customerId: 'c1', kind: 'insurance', uploader
      });
      assert.equal(out, 'https://cdn.example.com/a.pdf');
      assert.equal(n, 0);
    } finally {
      if (prev === undefined) delete process.env.CUSTOMER_DOCS_STORAGE_ENABLED;
      else process.env.CUSTOMER_DOCS_STORAGE_ENABLED = prev;
    }
  });
});

describe('maybeUploadCustomerDocument — read-back verify fallback (HARDENED)', () => {
  it('flag ON + verify byte-mismatch → FALLS BACK to original base64 (no path stored)', async () => {
    const prev = process.env.CUSTOMER_DOCS_STORAGE_ENABLED;
    process.env.CUSTOMER_DOCS_STORAGE_ENABLED = 'true';
    try {
      const v = `data:image/png;base64,${PNG_B64}`;
      const uploader = async (a) => ({ path: a.path }); // "succeeds"
      // Downloader returns the WRONG length -> verify fails inside upload.
      const downloader = async () => ({ body: Buffer.alloc(3) });
      let warned = 0;
      const out = await maybeUploadCustomerDocument(v, {
        tenantId: 't1', customerId: 'c1', kind: 'id-photo', uploader, downloader,
        logger: { warn: () => { warned++; } }
      });
      assert.equal(out, v, 'fell back to inline base64, no storage path stored');
      assert.equal(warned, 1, 'fallback was logged');
    } finally {
      if (prev === undefined) delete process.env.CUSTOMER_DOCS_STORAGE_ENABLED;
      else process.env.CUSTOMER_DOCS_STORAGE_ENABLED = prev;
    }
  });

  it('flag ON + read-back throws → FALLS BACK to original base64', async () => {
    const prev = process.env.CUSTOMER_DOCS_STORAGE_ENABLED;
    process.env.CUSTOMER_DOCS_STORAGE_ENABLED = 'true';
    try {
      const v = `data:image/png;base64,${PNG_B64}`;
      const uploader = async (a) => ({ path: a.path });
      const downloader = async () => { throw new Error('storage read 500'); };
      const out = await maybeUploadCustomerDocument(v, {
        tenantId: 't1', customerId: 'c1', kind: 'id-photo', uploader, downloader,
        logger: { warn: () => {} }
      });
      assert.equal(out, v);
    } finally {
      if (prev === undefined) delete process.env.CUSTOMER_DOCS_STORAGE_ENABLED;
      else process.env.CUSTOMER_DOCS_STORAGE_ENABLED = prev;
    }
  });

  it('flag ON + verify OK → stores the storage path', async () => {
    const prev = process.env.CUSTOMER_DOCS_STORAGE_ENABLED;
    process.env.CUSTOMER_DOCS_STORAGE_ENABLED = 'true';
    try {
      const { uploader, downloader } = mkVerifyPair();
      const out = await maybeUploadCustomerDocument(`data:image/png;base64,${PNG_B64}`, {
        tenantId: 't1', customerId: 'c1', kind: 'id-photo', uploader, downloader
      });
      assert.match(out, /^tenants\/t1\/customers\/c1\/id-photo_/);
    } finally {
      if (prev === undefined) delete process.env.CUSTOMER_DOCS_STORAGE_ENABLED;
      else process.env.CUSTOMER_DOCS_STORAGE_ENABLED = prev;
    }
  });
});
