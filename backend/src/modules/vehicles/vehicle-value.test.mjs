import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeVehicleValue, rotationStatus, registrationStatus, monthsBetween } from './vehicle-value.js';

const NOW = new Date('2026-06-10T12:00:00Z');
const monthsAgo = (m) => new Date(NOW.getTime() - m * 30.4375 * 24 * 60 * 60 * 1000);

test('computeVehicleValue: declining balance, canonical example', () => {
  // $28,000 @ 20%/yr, 22 months in fleet → 28000 × 0.8^(22/12) ≈ $18,648
  const v = computeVehicleValue({
    acquisitionCost: 28000, depreciationAnnualPct: 20,
    acquisitionDate: monthsAgo(22), now: NOW
  });
  assert.ok(Math.abs(v.currentValue - 28000 * Math.pow(0.8, 22 / 12)) < 1);
  assert.ok(v.depreciatedPct > 30 && v.depreciatedPct < 40);
  assert.ok(Math.abs(v.monthsInFleet - 22) < 0.2);
});

test('computeVehicleValue: brand new car ≈ full cost', () => {
  const v = computeVehicleValue({
    acquisitionCost: 30000, depreciationAnnualPct: 25,
    acquisitionDate: NOW, now: NOW
  });
  assert.equal(v.currentValue, 30000);
  assert.equal(v.depreciatedPct, 0);
});

test('computeVehicleValue: incomplete data returns null', () => {
  assert.equal(computeVehicleValue({ acquisitionCost: null, depreciationAnnualPct: 20, acquisitionDate: NOW }), null);
  assert.equal(computeVehicleValue({ acquisitionCost: 30000, depreciationAnnualPct: null, acquisitionDate: NOW }), null);
  assert.equal(computeVehicleValue({ acquisitionCost: 30000, depreciationAnnualPct: 20, acquisitionDate: null }), null);
  assert.equal(computeVehicleValue({ acquisitionCost: -5, depreciationAnnualPct: 20, acquisitionDate: NOW }), null);
  assert.equal(computeVehicleValue({ acquisitionCost: 30000, depreciationAnnualPct: 100, acquisitionDate: NOW }), null);
});

test('computeVehicleValue: Prisma Decimal-like strings work', () => {
  const v = computeVehicleValue({
    acquisitionCost: '24999.99', depreciationAnnualPct: '15.5',
    acquisitionDate: monthsAgo(12), now: NOW
  });
  assert.ok(v.currentValue > 20000 && v.currentValue < 24999.99);
});

test('rotationStatus TIME: ready / approaching / ok / null', () => {
  assert.equal(rotationStatus({ rule: 'TIME', acquisitionDate: monthsAgo(36), targetFleetMonths: 36, now: NOW }), 'ready');
  assert.equal(rotationStatus({ rule: 'TIME', acquisitionDate: monthsAgo(35), targetFleetMonths: 36, now: NOW }), 'approaching');
  assert.equal(rotationStatus({ rule: 'TIME', acquisitionDate: monthsAgo(12), targetFleetMonths: 36, now: NOW }), 'ok');
  assert.equal(rotationStatus({ rule: 'TIME', acquisitionDate: null, targetFleetMonths: 36, now: NOW }), null);
  assert.equal(rotationStatus({ rule: 'TIME', acquisitionDate: monthsAgo(12), targetFleetMonths: null, now: NOW }), null);
});

test('rotationStatus MILEAGE: ready / approaching / ok / null', () => {
  assert.equal(rotationStatus({ rule: 'MILEAGE', mileage: 60000, targetFleetMiles: 60000 }), 'ready');
  assert.equal(rotationStatus({ rule: 'MILEAGE', mileage: 58500, targetFleetMiles: 60000 }), 'approaching');
  assert.equal(rotationStatus({ rule: 'MILEAGE', mileage: 20000, targetFleetMiles: 60000 }), 'ok');
  assert.equal(rotationStatus({ rule: 'MILEAGE', mileage: 20000, targetFleetMiles: null }), null);
});

test('rotationStatus: unknown rule falls back to TIME; lowercase tolerated', () => {
  assert.equal(rotationStatus({ rule: 'mileage', mileage: 61000, targetFleetMiles: 60000 }), 'ready');
  assert.equal(rotationStatus({ rule: 'whatever', acquisitionDate: monthsAgo(40), targetFleetMonths: 36, now: NOW }), 'ready');
});

test('registrationStatus: ok / expiring / expired / null', () => {
  const days = (d) => new Date(NOW.getTime() + d * 24 * 60 * 60 * 1000);
  assert.equal(registrationStatus(days(90), NOW).status, 'ok');
  assert.equal(registrationStatus(days(15), NOW).status, 'expiring');
  assert.equal(registrationStatus(days(-3), NOW).status, 'expired');
  assert.equal(registrationStatus(null, NOW), null);
  assert.equal(registrationStatus('garbage', NOW), null);
});

test('monthsBetween: clamps negatives to 0, rejects junk', () => {
  assert.equal(monthsBetween(NOW, monthsAgo(5)), 0);
  assert.equal(monthsBetween('junk', NOW), null);
});
