/**
 * 16l unit tests for inspection-photos.js helpers.
 *
 * Covers:
 *   - feature flag default (off)
 *   - base64 / data-URL decode
 *   - oversize rejection
 *   - uploadInspectionPhotos with an injected uploader stub
 *   - materializeStorageRefs with an injected signer stub
 *   - skip-external (http://) values
 *   - per-slot array flattening (multiple damage photos)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  isStorageEnabled,
  decodePhotoValue,
  uploadInspectionPhotos,
  materializeStorageRefs,
  MAX_PHOTO_BYTES
} from './inspection-photos.js';

const TINY_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

describe('isStorageEnabled', () => {
  it('returns false by default', () => {
    const prev = process.env.INSPECTION_PHOTOS_STORAGE_ENABLED;
    delete process.env.INSPECTION_PHOTOS_STORAGE_ENABLED;
    try {
      assert.equal(isStorageEnabled(), false);
    } finally {
      if (prev !== undefined) process.env.INSPECTION_PHOTOS_STORAGE_ENABLED = prev;
    }
  });
  it('returns true when env=true', () => {
    const prev = process.env.INSPECTION_PHOTOS_STORAGE_ENABLED;
    process.env.INSPECTION_PHOTOS_STORAGE_ENABLED = 'true';
    try {
      assert.equal(isStorageEnabled(), true);
    } finally {
      if (prev === undefined) delete process.env.INSPECTION_PHOTOS_STORAGE_ENABLED;
      else process.env.INSPECTION_PHOTOS_STORAGE_ENABLED = prev;
    }
  });
});

describe('decodePhotoValue', () => {
  it('decodes a raw base64 string into a buffer', () => {
    const decoded = decodePhotoValue(TINY_PNG_B64);
    assert.ok(decoded);
    assert.ok(Buffer.isBuffer(decoded.buffer));
    assert.equal(decoded.contentType, 'image/jpeg'); // default when no data-URL header
    assert.equal(decoded.ext, 'jpg');
  });
  it('decodes a data URL and respects content type', () => {
    const decoded = decodePhotoValue(`data:image/png;base64,${TINY_PNG_B64}`);
    assert.ok(decoded);
    assert.equal(decoded.contentType, 'image/png');
    assert.equal(decoded.ext, 'png');
  });
  it('returns null for an http URL (already external)', () => {
    assert.equal(decodePhotoValue('https://example.com/x.jpg'), null);
  });
  it('returns null for empty / nullish input', () => {
    assert.equal(decodePhotoValue(null), null);
    assert.equal(decodePhotoValue(''), null);
    assert.equal(decodePhotoValue(undefined), null);
  });
  it('throws when payload exceeds MAX_PHOTO_BYTES', () => {
    // Build a base64 string that decodes to > MAX_PHOTO_BYTES.
    const oversize = Buffer.alloc(MAX_PHOTO_BYTES + 1, 0xff).toString('base64');
    assert.throws(() => decodePhotoValue(oversize), /exceeds max size/);
  });
});

describe('uploadInspectionPhotos', () => {
  it('uploads each photo through the injected uploader and returns refs', async () => {
    const calls = [];
    const uploader = async (args) => {
      calls.push(args);
      return { path: args.path, size: args.body.byteLength };
    };
    const refs = await uploadInspectionPhotos({
      photos: {
        front: TINY_PNG_B64,
        rear: `data:image/png;base64,${TINY_PNG_B64}`
      },
      tenantId: 'tenant_test',
      inspectionId: 'insp_test',
      uploader
    });
    assert.equal(calls.length, 2);
    assert.equal(refs.length, 2);
    for (const ref of refs) {
      assert.ok(ref.path.startsWith('tenants/tenant_test/inspections/insp_test/'));
      assert.ok(['image/jpeg', 'image/png'].includes(ref.contentType));
      assert.ok(typeof ref.size === 'number' && ref.size > 0);
      assert.ok(typeof ref.uploadedAt === 'string');
    }
  });

  it('preserves external https URLs as external refs (no upload)', async () => {
    const uploader = async () => {
      throw new Error('uploader should not be called for external urls');
    };
    const refs = await uploadInspectionPhotos({
      photos: { front: 'https://cdn.example/x.jpg' },
      tenantId: 'tenant_test',
      inspectionId: 'insp_test',
      uploader
    });
    assert.equal(refs.length, 1);
    assert.equal(refs[0].external, true);
    assert.equal(refs[0].url, 'https://cdn.example/x.jpg');
  });

  it('flattens arrays of photos per slot', async () => {
    const uploader = async (args) => ({ path: args.path });
    const refs = await uploadInspectionPhotos({
      photos: { damage: [TINY_PNG_B64, TINY_PNG_B64] },
      tenantId: 't',
      inspectionId: 'i',
      uploader
    });
    assert.equal(refs.length, 2);
    assert.equal(refs[0].key, 'damage');
    assert.equal(refs[1].key, 'damage');
  });

  it('returns [] when photos is empty/missing', async () => {
    const refs = await uploadInspectionPhotos({
      photos: {},
      tenantId: 't',
      inspectionId: 'i',
      uploader: async () => ({})
    });
    assert.deepEqual(refs, []);
  });

  it('requires tenantId and inspectionId', async () => {
    await assert.rejects(
      uploadInspectionPhotos({ photos: { front: TINY_PNG_B64 }, inspectionId: 'i' }),
      /tenantId is required/
    );
    await assert.rejects(
      uploadInspectionPhotos({ photos: { front: TINY_PNG_B64 }, tenantId: 't' }),
      /inspectionId is required/
    );
  });
});

describe('materializeStorageRefs', () => {
  it('returns {} for empty refs', async () => {
    assert.deepEqual(await materializeStorageRefs([]), {});
    assert.deepEqual(await materializeStorageRefs(null), {});
  });
  it('signs refs through the injected signer', async () => {
    const signer = async ({ path }) => `https://signed.example/${path}?token=abc`;
    const out = await materializeStorageRefs(
      [
        { key: 'front', path: 'a/b/c.jpg', contentType: 'image/jpeg', size: 10, uploadedAt: 'now' }
      ],
      { signer }
    );
    assert.equal(out.front, 'https://signed.example/a/b/c.jpg?token=abc');
  });
  it('passes external URL refs through without signing', async () => {
    const signer = async () => 'SHOULD_NOT_BE_USED';
    const out = await materializeStorageRefs(
      [{ key: 'side', external: true, url: 'https://cdn.example/x.jpg' }],
      { signer }
    );
    assert.equal(out.side, 'https://cdn.example/x.jpg');
  });
  it('groups multiple refs per key as an array', async () => {
    const signer = async ({ path }) => `https://s/${path}`;
    const out = await materializeStorageRefs(
      [
        { key: 'damage', path: 'p/1.jpg' },
        { key: 'damage', path: 'p/2.jpg' },
        { key: 'damage', path: 'p/3.jpg' }
      ],
      { signer }
    );
    assert.ok(Array.isArray(out.damage));
    assert.equal(out.damage.length, 3);
  });
  it('skips refs when signing fails', async () => {
    const signer = async () => {
      throw new Error('boom');
    };
    const out = await materializeStorageRefs(
      [{ key: 'front', path: 'a/b.jpg' }],
      { signer }
    );
    assert.deepEqual(out, {});
  });
});
