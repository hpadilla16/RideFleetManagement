/**
 * Unit tests for the mandatory-swap-photo gate (2026-07-16). Pure — no prisma,
 * no network, no DATABASE_URL.
 *
 * Rule under test (Hector, non-negotiable): 8 standard photos per car, both cars
 * (16 total), HARD BLOCK with no override — and the refs-only persistence rule
 * that keeps base64 out of the swap JSON (beta.310 regression guard).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SWAP_PHOTOS_PER_VEHICLE,
  SWAP_PHOTOS_TOTAL,
  SWAP_PHOTO_SLOTS,
  __test,
  assertNoInlinePhotos,
  describeMissingSwapPhotos,
  uploadSwapPhotos,
  validateSwapPhotos
} from './swap-photos.js';

// Smallest thing that passes the JPEG magic-header check in decodePhotoValue.
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 7)]);
const jpegDataUrl = () => `data:image/jpeg;base64,${JPEG.toString('base64')}`;

const fullSet = (overrides = {}) => {
  const out = {};
  for (const slot of SWAP_PHOTO_SLOTS) out[slot] = jpegDataUrl();
  return { ...out, ...overrides };
};

test('the standard 8 slots are exactly the app-wide inspection set', () => {
  assert.deepEqual(SWAP_PHOTO_SLOTS, ['front', 'rear', 'left', 'right', 'frontSeat', 'rearSeat', 'dashboard', 'trunk']);
  assert.equal(SWAP_PHOTOS_PER_VEHICLE, 8);
  assert.equal(SWAP_PHOTOS_TOTAL, 16);
});

test('a full 8-photo set passes', () => {
  const result = validateSwapPhotos(fullSet());
  assert.equal(result.ok, true);
  assert.equal(result.missing.length, 0);
  assert.equal(result.present.length, 8);
});

test('an empty payload reports all 8 slots missing', () => {
  const result = validateSwapPhotos({});
  assert.equal(result.ok, false);
  assert.deepEqual(result.missing.map((m) => m.slot), SWAP_PHOTO_SLOTS.slice());
});

test('each individual slot is required — one missing blocks the swap', () => {
  for (const slot of SWAP_PHOTO_SLOTS) {
    const photos = fullSet();
    delete photos[slot];
    const result = validateSwapPhotos(photos);
    assert.equal(result.ok, false, `${slot} must be required`);
    assert.deepEqual(result.missing.map((m) => m.slot), [slot]);
  }
});

test('a key with junk behind it does NOT satisfy the slot', () => {
  // The whole point: the gate validates BYTES, not the presence of a key.
  const cases = [
    ['ok', 'not-an-image'],
    [`data:image/jpeg;base64,${Buffer.from('[object Object]').toString('base64')}`, 'not-an-image'],
    ['', 'missing']
  ];
  for (const [value, reason] of cases) {
    const result = validateSwapPhotos(fullSet({ trunk: value }));
    assert.equal(result.ok, false, `junk "${String(value).slice(0, 20)}" must be rejected`);
    assert.deepEqual(result.missing, [{ slot: 'trunk', reason }]);
  }
});

test('an oversize photo is rejected as too-large, not silently accepted', () => {
  const huge = `data:image/jpeg;base64,${Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
    Buffer.alloc(11 * 1024 * 1024, 1)
  ]).toString('base64')}`;
  const result = validateSwapPhotos(fullSet({ front: huge }));
  assert.equal(result.ok, false);
  assert.deepEqual(result.missing, [{ slot: 'front', reason: 'too-large' }]);
});

test('mobile shapes are accepted: array of {key,dataUrl} + snake_case aliases', () => {
  const photos = SWAP_PHOTO_SLOTS.map((slot) => ({
    key: slot === 'frontSeat' ? 'front_seat' : slot === 'rearSeat' ? 'rear_seat' : slot === 'dashboard' ? 'dash' : slot,
    dataUrl: jpegDataUrl()
  }));
  assert.equal(validateSwapPhotos(photos).ok, true);
});

// ── MUST-1 (security): a URL is NOT evidence ────────────────────────────────
// The inspection wizard accepts an http(s) passthrough for its resume flow.
// Doing that HERE would let a crafted call satisfy the hard block with zero
// bytes stored: `uploadInspectionPhotosDetailed` turns a URL into an
// {external:true} ref, that ref counts toward gotSlots, uploadSwapPhotos'
// shortfall check passes, and the read path later serves the attacker's URL
// back as "the photo". No legitimate swap caller ever sends a URL.

test('an https URL does NOT satisfy a slot — a URL is not evidence', () => {
  const result = validateSwapPhotos(fullSet({ left: 'https://storage.example/inspection-photos/x.jpg' }));
  assert.equal(result.ok, false);
  assert.deepEqual(result.missing, [{ slot: 'left', reason: 'invalid' }]);
});

test('the URL bypass cannot complete a swap: a full set of URLs is fully rejected', () => {
  // The attack shape: every slot "present", zero bytes anywhere.
  const allUrls = {};
  for (const slot of SWAP_PHOTO_SLOTS) allUrls[slot] = `https://evil.example/${slot}.jpg`;
  const result = validateSwapPhotos(allUrls);
  assert.equal(result.ok, false);
  assert.equal(result.present.length, 0, 'no URL may ever count as a satisfied slot');
  assert.deepEqual(result.missing.map((m) => m.slot), SWAP_PHOTO_SLOTS.slice());
  for (const m of result.missing) assert.equal(m.reason, 'invalid');
});

test('every URL flavor is rejected (http, https, protocol-relative case, mixed case)', () => {
  const flavors = [
    'http://evil.example/x.jpg',
    'https://evil.example/x.jpg',
    'HTTPS://EVIL.EXAMPLE/X.JPG',
    'HtTpS://evil.example/x.jpg',
    // A URL wearing a data-URL costume still isn't image bytes.
    'https://evil.example/x.jpg?data:image/jpeg;base64,AAAA'
  ];
  for (const value of flavors) {
    const result = validateSwapPhotos(fullSet({ trunk: value }));
    assert.equal(result.ok, false, `${value} must be rejected`);
    assert.deepEqual(result.missing, [{ slot: 'trunk', reason: 'invalid' }]);
  }
});

test('uploadSwapPhotos refuses external refs even if one slips past the validator', async (t) => {
  // Defense in depth: pin the SECOND lock independently of the first, by
  // calling uploadSwapPhotos directly (bypassing validateSwapPhotos exactly as
  // a future refactor might). `uploadInspectionPhotosDetailed` emits a real
  // {external:true} ref for an http(s) value — uploadSwapPhotos must refuse it
  // rather than count it toward the 8.
  const objects = new Map();
  const previousFlag = process.env.INSPECTION_PHOTOS_STORAGE_ENABLED;
  process.env.INSPECTION_PHOTOS_STORAGE_ENABLED = 'true';
  __test.setStorageAdapter({
    uploader: async ({ bucket, path, body }) => {
      objects.set(`${bucket}:${path}`, body);
      return { path };
    },
    downloader: async ({ bucket, path }) => ({ body: objects.get(`${bucket}:${path}`) || null })
  });
  t.after(() => {
    __test.reset();
    if (previousFlag === undefined) delete process.env.INSPECTION_PHOTOS_STORAGE_ENABLED;
    else process.env.INSPECTION_PHOTOS_STORAGE_ENABLED = previousFlag;
  });

  // Sanity: the honest all-bytes path succeeds with this adapter.
  const refs = await uploadSwapPhotos({
    photos: fullSet(),
    tenantId: 't1',
    scopeId: 'swap_test_previous',
    logger: { warn() {} }
  });
  assert.equal(refs.length, 8);
  assert.ok(refs.every((r) => !r.external), 'no external refs on the honest path');
  assert.ok(refs.every((r) => r.path), 'every honest ref points at a stored object');

  // One URL among real photos -> refused, and named.
  await assert.rejects(
    () => uploadSwapPhotos({
      photos: fullSet({ left: 'https://evil.example/left.jpg' }),
      tenantId: 't1',
      scopeId: 'swap_test_previous',
      logger: { warn() {} }
    }),
    /external URLs.*left/s,
    'a URL must never be recorded as a stored swap photo'
  );

  // The full attack shape: 8 URLs, zero bytes -> refused, nothing stored.
  const allUrls = {};
  for (const slot of SWAP_PHOTO_SLOTS) allUrls[slot] = `https://evil.example/${slot}.jpg`;
  objects.clear();
  await assert.rejects(
    () => uploadSwapPhotos({ photos: allUrls, tenantId: 't1', scopeId: 'swap_test_next', logger: { warn() {} } }),
    /external URLs/,
    'a full set of URLs must never complete a swap'
  );
  assert.equal(objects.size, 0, 'a URL-only swap stores no bytes at all');
});

test('the error names which car and which slots', () => {
  const message = describeMissingSwapPhotos([
    { label: 'Vehicle coming back', vehicleLabel: 'KII873', missing: [{ slot: 'left', reason: 'missing' }, { slot: 'trunk', reason: 'missing' }] },
    { label: 'Replacement vehicle', vehicleLabel: 'KHV165', missing: [{ slot: 'dashboard', reason: 'not-an-image' }] }
  ]);
  assert.match(message, /Vehicle coming back \(KII873\): left, trunk/);
  assert.match(message, /Replacement vehicle \(KHV165\): dashboard \(not a valid image\)/);
  // The route maps /required/ -> 400 rather than a generic 500.
  assert.match(message, /required/);
});

test('describeMissingSwapPhotos omits a car that is complete', () => {
  const message = describeMissingSwapPhotos([
    { label: 'Vehicle coming back', vehicleLabel: 'KII873', missing: [] },
    { label: 'Replacement vehicle', vehicleLabel: 'KHV165', missing: [{ slot: 'rear', reason: 'missing' }] }
  ]);
  assert.doesNotMatch(message, /KII873/);
  assert.match(message, /KHV165/);
});

test('assertNoInlinePhotos passes for a refs-only inspection', () => {
  assert.equal(
    assertNoInlinePhotos({ photos: {}, photoStorageRefs: [{ key: 'front', path: 'tenants/t/inspections/s/front_x.jpg', size: 100 }] }),
    true
  );
});

test('assertNoInlinePhotos BLOCKS base64 in the swap JSON (beta.310 guard)', () => {
  // A non-empty photos map = base64 blobs about to be stringified into
  // previousInspectionJson/nextInspectionJson. This is the outage shape.
  assert.throws(
    () => assertNoInlinePhotos({ photos: { front: jpegDataUrl() }, photoStorageRefs: [] }),
    /inline photos map must be empty/
  );
  // Bytes smuggled inside a ref.
  assert.throws(
    () => assertNoInlinePhotos({ photos: {}, photoStorageRefs: [{ key: 'front', dataUrl: jpegDataUrl() }] }),
    /carries inline bytes/
  );
  assert.throws(() => assertNoInlinePhotos({ photos: {} }), /photoStorageRefs must be an array/);
});
