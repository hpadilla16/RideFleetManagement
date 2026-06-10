import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeInspectionPhotos, canonicalPhotoKey } from './inspection-photos-normalize.js';

test('canonicalPhotoKey maps mobile snake_case to desktop camelCase', () => {
  assert.equal(canonicalPhotoKey('front_seat'), 'frontSeat');
  assert.equal(canonicalPhotoKey('rear_seat'), 'rearSeat');
  assert.equal(canonicalPhotoKey('dash'), 'dashboard');
  // Unaliased keys pass through untouched.
  assert.equal(canonicalPhotoKey('front'), 'front');
  assert.equal(canonicalPhotoKey('trunk'), 'trunk');
  assert.equal(canonicalPhotoKey(''), '');
  assert.equal(canonicalPhotoKey(null), '');
});

test('mobile ARRAY shape -> object map keyed by canonical slot', () => {
  const arr = [
    { key: 'front', dataUrl: 'data:img/front' },
    { key: 'rear', dataUrl: 'data:img/rear' },
    { key: 'front_seat', dataUrl: 'data:img/fseat' },
    { key: 'rear_seat', dataUrl: 'data:img/rseat' },
    { key: 'dash', dataUrl: 'data:img/dash' },
    { key: 'trunk', dataUrl: 'data:img/trunk' }
  ];
  const out = normalizeInspectionPhotos(arr);
  assert.deepEqual(out, {
    front: 'data:img/front',
    rear: 'data:img/rear',
    frontSeat: 'data:img/fseat',   // aliased
    rearSeat: 'data:img/rseat',    // aliased
    dashboard: 'data:img/dash',    // aliased
    trunk: 'data:img/trunk'
  });
});

test('array items accept url/src besides dataUrl; drop entries with no src or no key', () => {
  const arr = [
    { key: 'front', url: 'https://x/front.jpg' },
    { key: 'rear', src: 'data:img/rear' },
    { key: 'left' },                 // no src -> dropped
    { dataUrl: 'data:img/orphan' },  // no key -> dropped
    null,                            // junk -> skipped
    'nope'                           // junk -> skipped
  ];
  assert.deepEqual(normalizeInspectionPhotos(arr), {
    front: 'https://x/front.jpg',
    rear: 'data:img/rear'
  });
});

test('legacy desktop MAP shape passes through, with snake_case keys re-aliased', () => {
  const map = {
    front: 'data:img/front',
    rear: 'data:img/rear',
    dash: 'data:img/dash',   // legacy row that used the mobile key in a map
    extra: null              // null values dropped
  };
  assert.deepEqual(normalizeInspectionPhotos(map), {
    front: 'data:img/front',
    rear: 'data:img/rear',
    dashboard: 'data:img/dash'
  });
});

test('garbage / empty inputs return empty object', () => {
  assert.deepEqual(normalizeInspectionPhotos(null), {});
  assert.deepEqual(normalizeInspectionPhotos(undefined), {});
  assert.deepEqual(normalizeInspectionPhotos('string'), {});
  assert.deepEqual(normalizeInspectionPhotos(42), {});
  assert.deepEqual(normalizeInspectionPhotos([]), {});
  assert.deepEqual(normalizeInspectionPhotos({}), {});
});
