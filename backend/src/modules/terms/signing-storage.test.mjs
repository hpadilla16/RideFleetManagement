/**
 * Tests for signing-storage.js (2026-05-21).
 * Run: node --test backend/src/modules/terms/signing-storage.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  uploadSignatureBlob,
  uploadSignedAgreementPdf,
  signSignatureUrl,
  signSignatureUrls,
  deleteSignatureBlob,
  SIGNING_BUCKET,
} from './signing-storage.js';

// Tiny 1x1 PNG (base64)
const TINY_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAfbLI3wAAAABJRU5ErkJggg==';

test('uploadSignatureBlob rejects missing required args', async () => {
  await assert.rejects(
    () => uploadSignatureBlob({ reservationId: 'r', fieldKey: 'k', body: TINY_PNG_B64 }),
    /tenantId required/
  );
  await assert.rejects(
    () => uploadSignatureBlob({ tenantId: 't', fieldKey: 'k', body: TINY_PNG_B64 }),
    /reservationId required/
  );
  await assert.rejects(
    () => uploadSignatureBlob({ tenantId: 't', reservationId: 'r', body: TINY_PNG_B64 }),
    /fieldKey required/
  );
});

test('uploadSignatureBlob rejects empty body', async () => {
  await assert.rejects(
    () =>
      uploadSignatureBlob({
        tenantId: 't',
        reservationId: 'r',
        fieldKey: 'k',
        body: '',
        uploader: async () => {},
      }),
    /empty or invalid/
  );
});

test('uploadSignatureBlob accepts base64 string + uploads with correct path scheme', async () => {
  let captured = null;
  const result = await uploadSignatureBlob({
    tenantId: 't_abc',
    reservationId: 'r_001',
    fieldKey: 'INITIALS_S4',
    body: TINY_PNG_B64,
    contentType: 'image/png',
    kind: 'initial',
    uploader: async (args) => {
      captured = args;
    },
  });
  assert.match(result.storagePath, /^tenants\/t_abc\/reservations\/r_001\/signing\/initial-INITIALS_S4-[a-f0-9]{8}\.png$/);
  assert.equal(result.contentType, 'image/png');
  assert.ok(result.sizeBytes > 0);
  assert.equal(captured.contentType, 'image/png');
  assert.equal(captured.bucket, SIGNING_BUCKET);
});

test('uploadSignatureBlob accepts data: URL prefix', async () => {
  let captured = null;
  await uploadSignatureBlob({
    tenantId: 't',
    reservationId: 'r',
    fieldKey: 'X',
    body: `data:image/png;base64,${TINY_PNG_B64}`,
    uploader: async (args) => {
      captured = args;
    },
  });
  assert.ok(Buffer.isBuffer(captured.body));
});

test('uploadSignatureBlob accepts raw Buffer', async () => {
  let captured = null;
  await uploadSignatureBlob({
    tenantId: 't',
    reservationId: 'r',
    fieldKey: 'X',
    body: Buffer.from(TINY_PNG_B64, 'base64'),
    uploader: async (args) => {
      captured = args;
    },
  });
  assert.ok(Buffer.isBuffer(captured.body));
});

test('uploadSignatureBlob sanitizes fieldKey in filename', async () => {
  let captured = null;
  await uploadSignatureBlob({
    tenantId: 't',
    reservationId: 'r',
    fieldKey: 'BAD/KEY..\\WITH SPACES',
    body: TINY_PNG_B64,
    uploader: async (args) => {
      captured = args;
    },
  });
  // Filename only — directory portion legitimately has slashes from safePath.
  const filename = captured.path.split('/').pop();
  assert.doesNotMatch(filename, /[ /\\]/, 'filename has no spaces/slashes/backslashes');
});

test('uploadSignatureBlob rejects oversized body', async () => {
  const huge = Buffer.alloc(6 * 1024 * 1024);
  await assert.rejects(
    () =>
      uploadSignatureBlob({
        tenantId: 't',
        reservationId: 'r',
        fieldKey: 'X',
        body: huge,
        uploader: async () => {},
      }),
    /exceeds max size/
  );
});

test('uploadSignedAgreementPdf writes a PDF with timestamped filename', async () => {
  let captured = null;
  const result = await uploadSignedAgreementPdf({
    tenantId: 't',
    reservationId: 'r',
    pdfBuffer: Buffer.from('%PDF-1.4 fake', 'utf8'),
    uploader: async (args) => {
      captured = args;
    },
  });
  assert.match(result.storagePath, /^tenants\/t\/reservations\/r\/signing\/agreement-\d+\.pdf$/);
  assert.equal(captured.contentType, 'application/pdf');
  assert.equal(result.contentType, 'application/pdf');
});

test('uploadSignedAgreementPdf rejects non-Buffer', async () => {
  await assert.rejects(
    () =>
      uploadSignedAgreementPdf({
        tenantId: 't',
        reservationId: 'r',
        pdfBuffer: 'not a buffer',
        uploader: async () => {},
      }),
    /pdfBuffer must be a non-empty Buffer/
  );
});

test('signSignatureUrl delegates to signer', async () => {
  const url = await signSignatureUrl('tenants/t/reservations/r/signing/x.png', {
    signer: async ({ bucket, path, expiresIn }) =>
      `https://example/${bucket}/${path}?t=${expiresIn}`,
  });
  assert.match(url, /^https:\/\/example\/customer-signatures\/tenants\/t\//);
});

test('signSignatureUrls degrades to null on signer error', async () => {
  let calls = 0;
  const signed = await signSignatureUrls(
    [{ storagePath: 'a' }, { storagePath: 'b' }],
    {
      signer: async () => {
        calls += 1;
        if (calls === 1) return 'https://ok';
        throw new Error('boom');
      },
    }
  );
  assert.equal(signed[0].signedUrl, 'https://ok');
  assert.equal(signed[1].signedUrl, null);
});

test('signSignatureUrls reads from `signatureSvgOrPath` when `storagePath` absent', async () => {
  const signed = await signSignatureUrls(
    [{ signatureSvgOrPath: 'a' }],
    { signer: async () => 'https://example' }
  );
  assert.equal(signed[0].signedUrl, 'https://example');
});

test('deleteSignatureBlob is idempotent (404 swallowed)', async () => {
  let called = false;
  await deleteSignatureBlob('p', {
    deleter: async () => {
      called = true;
      const e = new Error('not found');
      e.status = 404;
      throw e;
    },
  });
  assert.ok(called);
});

test('deleteSignatureBlob propagates non-404 errors', async () => {
  await assert.rejects(
    () =>
      deleteSignatureBlob('p', {
        deleter: async () => {
          const e = new Error('boom');
          e.status = 500;
          throw e;
        },
      }),
    /boom/
  );
});
