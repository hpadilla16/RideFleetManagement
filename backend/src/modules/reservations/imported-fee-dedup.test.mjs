/**
 * Don't charge a fee the franchise already charged — DB-free.
 *
 * Hector, 2026-08-09: "MEX si ya tiene el fee no se lo duplicas."
 *
 * MEX bookings arrive with the portal's fee lines imported as IMPORTED_FEE
 * rows. Reservation pricing separately auto-applies the pickup location's
 * mandatory fees. Nothing connected the two, so an overlapping fee was billed
 * twice on the franchise's own paperwork.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { dropFeesAlreadyImported, normalizeFeeName, importedFeeNames } from './imported-fee-dedup.js';

const imported = (name) => ({ name, source: 'MEX_IMPORT', selected: true });
const ourFee = (id, name) => ({ id, name });

test('THE BUG: a fee the portal already charged is not charged again', () => {
  const { keep, skipped } = dropFeesAlreadyImported(
    [ourFee('f1', 'Vehicle License Fee'), ourFee('f2', 'Airport Concession')],
    [imported('VEHICLE LICENSE FEE')],
  );
  assert.deepEqual(keep.map((f) => f.id), ['f2']);
  assert.deepEqual(skipped.map((f) => f.id), ['f1']);
});

test('PER FEE, not all-or-nothing — what MEX does NOT charge is still ours', () => {
  // The safer failure direction: charged once, never charged zero times.
  const { keep } = dropFeesAlreadyImported(
    [ourFee('f1', 'Vehicle License Fee'), ourFee('f2', 'Environmental Fee')],
    [imported('Vehicle License Fee')],
  );
  assert.deepEqual(keep.map((f) => f.name), ['Environmental Fee']);
});

test('names match across the cosmetic differences the two systems produce', () => {
  const pairs = [
    ['Vehicle License Fee', 'VEHICLE LICENSE'],
    ['Airport Concession Fee', 'airport concession'],
    ['Cargo por Licencia', 'CARGO POR LICENCIA'],
    ['Road-Safety Fee', 'ROAD SAFETY FEE'],
  ];
  for (const [a, b] of pairs) {
    assert.equal(normalizeFeeName(a), normalizeFeeName(b), `${a} vs ${b}`);
  }
});

test('genuinely different fees do NOT collapse together', () => {
  assert.notEqual(normalizeFeeName('Vehicle License Fee'), normalizeFeeName('Airport Concession Fee'));
  const { keep } = dropFeesAlreadyImported(
    [ourFee('f1', 'Airport Concession Fee')],
    [imported('Vehicle License Fee')],
  );
  assert.equal(keep.length, 1, 'a different fee must survive');
});

test('a booking with no imported fees is untouched', () => {
  const fees = [ourFee('f1', 'Vehicle License Fee')];
  assert.deepEqual(dropFeesAlreadyImported(fees, []).keep, fees);
  // Our OWN mandatory rows must never count as "already imported", or the fee
  // would delete itself on the second pricing read.
  const ours = [{ name: 'Vehicle License Fee', source: 'MANDATORY_FEE', selected: true }];
  assert.deepEqual(dropFeesAlreadyImported(fees, ours).keep, fees);
});

test('a voided imported row does not suppress anything', () => {
  const { keep } = dropFeesAlreadyImported(
    [ourFee('f1', 'Vehicle License Fee')],
    [{ name: 'Vehicle License Fee', source: 'MEX_IMPORT', selected: false }],
  );
  assert.equal(keep.length, 1, 'a voided charge is not a charge');
});

test('importedFeeNames reads only franchise rows', () => {
  const names = importedFeeNames([
    imported('Vehicle License Fee'),
    { name: 'Daily Rate', source: 'BASE_RATE', selected: true },
    { name: 'Tax', source: 'TAX', selected: true },
  ]);
  assert.deepEqual([...names], [normalizeFeeName('Vehicle License Fee')]);
});

test('empty or nameless rows cannot match everything', () => {
  assert.equal(normalizeFeeName(''), '');
  assert.equal(normalizeFeeName(null), '');
  const { keep } = dropFeesAlreadyImported(
    [{ id: 'f1', name: '' }, ourFee('f2', 'Vehicle License Fee')],
    [imported('')],
  );
  assert.equal(keep.length, 2, 'a blank name must never suppress a real fee');
});
