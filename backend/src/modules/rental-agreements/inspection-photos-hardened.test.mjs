/**
 * HARDENED inspection-photos tests (prod incident 2026-06: lost 13 inspections).
 *
 * These exercise the THREE REAL production photosJson formats and the exact
 * bug that destroyed data: an ARRAY of OBJECTS where each element's base64
 * lives in `dataUrl`. The old code String()'d the object -> "[object Object]"
 * -> Buffer.from(...,'base64') -> ~9 bytes of garbage uploaded as a "real"
 * photo, after which the clear step nulled the original.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  decodePhotoValue,
  normalizePhotosForUpload,
  uploadInspectionPhotos,
  uploadInspectionPhotosDetailed,
  looksLikeImage
} from './inspection-photos.js';

// A tiny but VALID 1x1 PNG (real magic header 89 50 4E 47).
const TINY_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
const TINY_PNG_BUF = Buffer.from(TINY_PNG_B64, 'base64');
const TINY_PNG_LEN = TINY_PNG_BUF.byteLength; // ~70 bytes

// A tiny VALID JPEG: SOI FFD8FF ... EOI FFD9. Build a minimal valid-ish header.
const TINY_JPEG_BUF = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0xff, 0xd9]);
const TINY_JPEG_B64 = TINY_JPEG_BUF.toString('base64');

describe('decodePhotoValue — HARDENED', () => {
  it('THE BUG: returns null for an OBJECT (never String()s it to garbage)', () => {
    assert.equal(decodePhotoValue({ key: 'front', dataUrl: `data:image/jpeg;base64,${TINY_JPEG_B64}` }), null);
  });
  it('returns null for an array', () => {
    assert.equal(decodePhotoValue([1, 2, 3]), null);
  });
  it('returns null for a number / boolean', () => {
    assert.equal(decodePhotoValue(42), null);
    assert.equal(decodePhotoValue(true), null);
  });
  it('returns null for null / empty', () => {
    assert.equal(decodePhotoValue(null), null);
    assert.equal(decodePhotoValue(''), null);
  });
  it('returns null for an http URL (external passthrough)', () => {
    assert.equal(decodePhotoValue('https://cdn.example/x.jpg'), null);
  });
  it('rejects a non-image magic header (e.g. base64 of "[object Object]")', () => {
    const junk = Buffer.from('[object Object]').toString('base64');
    assert.equal(decodePhotoValue(junk), null);
  });
  it('decodes a valid PNG data-url', () => {
    const d = decodePhotoValue(`data:image/png;base64,${TINY_PNG_B64}`);
    assert.ok(d);
    assert.equal(d.ext, 'png');
    assert.equal(d.buffer.byteLength, TINY_PNG_LEN);
  });
  it('decodes a valid JPEG', () => {
    const d = decodePhotoValue(`data:image/jpeg;base64,${TINY_JPEG_B64}`);
    assert.ok(d);
    assert.equal(d.buffer.byteLength, TINY_JPEG_BUF.byteLength);
  });
});

describe('looksLikeImage', () => {
  it('accepts PNG and JPEG', () => {
    assert.equal(looksLikeImage(TINY_PNG_BUF), true);
    assert.equal(looksLikeImage(TINY_JPEG_BUF), true);
  });
  it('rejects the 9-byte garbage', () => {
    assert.equal(looksLikeImage(Buffer.from('[object Object]', 'binary').subarray(0, 9)), false);
    assert.equal(looksLikeImage(Buffer.from('hello')), false);
  });
});

describe('normalizePhotosForUpload — three real formats', () => {
  it('format #1 object-of-strings -> {slot,value} for each', () => {
    const { items, skipped } = normalizePhotosForUpload({ front: TINY_PNG_B64, rear: TINY_JPEG_B64 });
    assert.equal(items.length, 2);
    assert.equal(skipped.length, 0);
    assert.deepEqual(items.map((i) => i.slot).sort(), ['front', 'rear']);
  });
  it('format #2 object-of-nulls -> 0 items (skipped, NOT junk)', () => {
    const { items, skipped } = normalizePhotosForUpload({ front: null, rear: null, left: null });
    assert.equal(items.length, 0);
    assert.equal(skipped.length, 0);
  });
  it('format #3 array-of-objects [{key,dataUrl}] -> real values keyed by element.key', () => {
    const { items, skipped } = normalizePhotosForUpload([
      { key: 'front', dataUrl: `data:image/jpeg;base64,${TINY_JPEG_B64}`, notes: '', capturedAt: 'x' },
      { key: 'rear', dataUrl: `data:image/png;base64,${TINY_PNG_B64}` }
    ]);
    assert.equal(items.length, 2);
    assert.equal(skipped.length, 0);
    assert.equal(items[0].slot, 'front');
    assert.ok(items[0].value.startsWith('data:image/jpeg'));
  });
  it('garbage object element (no base64 field) -> skipped, not stringified', () => {
    const { items, skipped } = normalizePhotosForUpload([
      { key: 'front', dataUrl: `data:image/png;base64,${TINY_PNG_B64}` },
      { key: 'bad', notes: 'no image here' }
    ]);
    assert.equal(items.length, 1);
    assert.equal(skipped.length, 1);
    assert.equal(skipped[0].slot, 'bad');
  });
  it('array-of-strings -> slot=index', () => {
    const { items } = normalizePhotosForUpload([TINY_PNG_B64, TINY_JPEG_B64]);
    assert.equal(items.length, 2);
    assert.deepEqual(items.map((i) => i.slot), ['0', '1']);
  });
});

describe('uploadInspectionPhotos — array-of-objects produces REAL refs (not 9 bytes)', () => {
  const mkUploader = (store) => async (args) => { store.set(args.path, args.body); return { path: args.path }; };

  it('format #3 -> refs with correct slot keys + byte size == decoded image (NOT 9)', async () => {
    const store = new Map();
    const refs = await uploadInspectionPhotos({
      photos: [
        { key: 'front', dataUrl: `data:image/jpeg;base64,${TINY_JPEG_B64}` },
        { key: 'rear', dataUrl: `data:image/png;base64,${TINY_PNG_B64}` }
      ],
      tenantId: 't1',
      inspectionId: 'i1',
      uploader: mkUploader(store)
    });
    assert.equal(refs.length, 2);
    const front = refs.find((r) => r.key === 'front');
    const rear = refs.find((r) => r.key === 'rear');
    assert.ok(front && rear);
    assert.equal(front.size, TINY_JPEG_BUF.byteLength);
    assert.equal(rear.size, TINY_PNG_LEN);
    assert.notEqual(front.size, 9); // explicit: NOT the garbage size
    // the stored bytes match the decoded image exactly
    assert.equal(store.get(front.path).byteLength, TINY_JPEG_BUF.byteLength);
  });

  it('format #2 object-of-nulls -> 0 refs (empty)', async () => {
    const refs = await uploadInspectionPhotos({
      photos: { front: null, rear: null },
      tenantId: 't', inspectionId: 'i',
      uploader: async () => { throw new Error('should not upload nulls'); }
    });
    assert.deepEqual(refs, []);
  });

  it('garbage object element is SKIPPED, not uploaded', async () => {
    const calls = [];
    const refs = await uploadInspectionPhotos({
      photos: [
        { key: 'front', dataUrl: `data:image/png;base64,${TINY_PNG_B64}` },
        { key: 'junk', somethingElse: { nested: true } }
      ],
      tenantId: 't', inspectionId: 'i',
      uploader: async (a) => { calls.push(a); return { path: a.path }; }
    });
    assert.equal(calls.length, 1); // only the real one uploaded
    assert.equal(refs.length, 1);
    assert.equal(refs[0].key, 'front');
  });

  it('detailed: inputCount/uploadedCount/skippedCount reported', async () => {
    const r = await uploadInspectionPhotosDetailed({
      photos: [
        { key: 'front', dataUrl: `data:image/png;base64,${TINY_PNG_B64}` },
        { key: 'junk', notes: 'x' }
      ],
      tenantId: 't', inspectionId: 'i',
      uploader: async (a) => ({ path: a.path })
    });
    assert.equal(r.uploadedCount, 1);
    assert.equal(r.inputCount, 1); // junk excluded from inputCount
    assert.equal(r.skippedCount, 1);
    assert.equal(r.verifyFailed, 0);
  });

  it('read-back verify: byte mismatch -> ref skipped + verifyFailed counted', async () => {
    const r = await uploadInspectionPhotosDetailed({
      photos: { front: `data:image/png;base64,${TINY_PNG_B64}` },
      tenantId: 't', inspectionId: 'i',
      uploader: async (a) => ({ path: a.path }),
      downloader: async () => ({ body: Buffer.alloc(3) }) // wrong length
    });
    assert.equal(r.refs.length, 0);
    assert.equal(r.verifyFailed, 1);
    assert.equal(r.uploadedCount, 0);
    assert.equal(r.inputCount, 1);
  });

  it('read-back verify: matching bytes -> ref kept', async () => {
    const r = await uploadInspectionPhotosDetailed({
      photos: { front: `data:image/png;base64,${TINY_PNG_B64}` },
      tenantId: 't', inspectionId: 'i',
      uploader: async (a) => ({ path: a.path }),
      downloader: async () => ({ body: Buffer.alloc(TINY_PNG_LEN) })
    });
    assert.equal(r.refs.length, 1);
    assert.equal(r.verifyFailed, 0);
  });
  it('canonicalizes the input slot on the stored ref key (front_seat -> frontSeat)', async () => {
    const uploaded = [];
    const r = await uploadInspectionPhotosDetailed({
      // Mobile snake_case slot names that the read path canonicalizes.
      photos: {
        front_seat: `data:image/png;base64,${TINY_PNG_B64}`,
        rear_seat: `data:image/png;base64,${TINY_PNG_B64}`,
        dash: `data:image/png;base64,${TINY_PNG_B64}`
      },
      tenantId: 't', inspectionId: 'i',
      uploader: async (a) => { uploaded.push(a.path); return { path: a.path }; }
    });
    const keys = r.refs.map((x) => x.key).sort();
    assert.deepEqual(keys, ['dashboard', 'frontSeat', 'rearSeat'],
      'stored ref keys are canonical, matching what the read/materialize path groups by');
    // The object path also carries the canonical slot (no raw front_seat).
    assert.ok(uploaded.every((pth) => /\/(frontSeat|rearSeat|dashboard)_/.test(pth)),
      'storage path uses the canonical slot, not the raw snake_case one');
    assert.ok(!uploaded.some((pth) => /front_seat_|rear_seat_|dash_/.test(pth)),
      'no raw snake_case slot leaked into the storage path');
  });

  it('canonicalizes the slot on an EXTERNAL-url ref too', async () => {
    const r = await uploadInspectionPhotosDetailed({
      photos: { front_seat: 'https://cdn.example/seat.jpg' },
      tenantId: 't', inspectionId: 'i',
      uploader: async (a) => ({ path: a.path })
    });
    assert.equal(r.refs.length, 1);
    assert.equal(r.refs[0].key, 'frontSeat', 'external ref key is canonical');
    assert.equal(r.refs[0].external, true);
  });
});
