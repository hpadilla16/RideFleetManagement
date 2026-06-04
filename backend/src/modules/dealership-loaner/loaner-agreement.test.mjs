import test from 'node:test';
import assert from 'node:assert/strict';

const { __test } = await import('./loaner-agreement.service.js');
const { serialize, parseDate, clampFuel, toInt, makeAgreementNumber } = __test;

test('makeAgreementNumber returns an LA-prefixed 8-digit number', () => {
  const n = makeAgreementNumber();
  assert.match(n, /^LA-\d{8}$/);
});

test('clampFuel clamps to 0..1 and tolerates blanks', () => {
  assert.equal(clampFuel(0.5), 0.5);
  assert.equal(clampFuel(1.4), 1);
  assert.equal(clampFuel(-0.2), 0);
  assert.equal(clampFuel(''), null);
  assert.equal(clampFuel(null), null);
  assert.equal(clampFuel('abc'), null);
});

test('toInt rounds and tolerates blanks', () => {
  assert.equal(toInt('18902'), 18902);
  assert.equal(toInt(19144.6), 19145);
  assert.equal(toInt(''), null);
  assert.equal(toInt(null), null);
});

test('parseDate returns Date for valid input, null otherwise', () => {
  assert.ok(parseDate('2026-06-02T17:00:00Z') instanceof Date);
  assert.equal(parseDate('not-a-date'), null);
  assert.equal(parseDate(null), null);
});

test('serialize computes the out/in diff (miles + fuel)', () => {
  const dto = serialize({
    id: 'la1', tenantId: 't1', agreementNumber: 'LA-00000001', status: 'RETURNED',
    reservationId: 'r1', vehicleId: 'v1', pickupAt: new Date(), returnAt: new Date(),
    customerFirstName: 'Maria', customerLastName: 'Colon',
    fuelOut: 1.0, fuelIn: 0.75, odometerOut: 18902, odometerIn: 19144,
    photos: [], damagePoints: []
  });
  assert.equal(dto.diff.milesDriven, 242);
  assert.equal(dto.diff.fuelDelta, 0.25);
});

test('serialize is null-safe when out/in not recorded', () => {
  const dto = serialize({
    id: 'la2', agreementNumber: 'LA-00000002', status: 'DRAFT',
    customerFirstName: 'A', customerLastName: 'B',
    fuelOut: null, fuelIn: null, odometerOut: null, odometerIn: null,
    photos: [], damagePoints: []
  });
  assert.equal(dto.diff.milesDriven, null);
  assert.equal(dto.diff.fuelDelta, null);
});

test('serialize maps signature + remote-signing flags and nested collections', () => {
  const dto = serialize({
    id: 'la3', agreementNumber: 'LA-00000003', status: 'ACTIVE',
    customerFirstName: 'A', customerLastName: 'B',
    signedAt: new Date(), signerName: 'Maria Colon', termsVersion: 'v3.2',
    signatureToken: 'tok', signatureTokenExpiresAt: new Date(),
    photos: [{ id: 'p1', kind: 'WALKAROUND_OUT', angleLabel: 'Front', storagePath: 'x', contentType: 'image/jpeg', sizeBytes: 10, annotation: null, takenAt: new Date() }],
    damagePoints: [{ id: 'd1', x: 0.2, y: 0.6, side: 'LEFT', severity: 'MINOR', note: 'scuff', preExisting: true, photoId: 'p1' }]
  });
  assert.equal(dto.signature.signed, true);
  assert.equal(dto.signature.signerName, 'Maria Colon');
  assert.equal(dto.remoteSigning.pending, true);
  assert.equal(dto.photos.length, 1);
  assert.equal(dto.photos[0].angleLabel, 'Front');
  assert.equal(dto.damagePoints.length, 1);
  assert.equal(dto.damagePoints[0].severity, 'MINOR');
});
