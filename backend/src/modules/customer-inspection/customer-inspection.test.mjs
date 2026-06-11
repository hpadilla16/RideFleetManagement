import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diagramTypeFor, VEHICLE_VIEWS } from './customer-inspection.service.js';

test('diagramTypeFor: maps vehicle type names to diagram families', () => {
  assert.equal(diagramTypeFor('Full Size SUV'), 'suv');
  assert.equal(diagramTypeFor('Compact SUV / Crossover'), 'suv');
  assert.equal(diagramTypeFor('Minivan'), 'van');
  assert.equal(diagramTypeFor('Passenger Van'), 'van');
  assert.equal(diagramTypeFor('Pickup Truck'), 'pickup');
  assert.equal(diagramTypeFor('Pick-up'), 'pickup');
  assert.equal(diagramTypeFor('Economy'), 'sedan');
  assert.equal(diagramTypeFor('Midsize Sedan'), 'sedan');
  assert.equal(diagramTypeFor('Full Size'), 'sedan');
});

test('diagramTypeFor: junk falls back to sedan', () => {
  assert.equal(diagramTypeFor(null), 'sedan');
  assert.equal(diagramTypeFor(''), 'sedan');
  assert.equal(diagramTypeFor('Spaceship'), 'sedan');
});

test('VEHICLE_VIEWS: the five canonical views, frozen', () => {
  assert.deepEqual([...VEHICLE_VIEWS], ['FRONT', 'REAR', 'LEFT', 'RIGHT', 'INTERIOR']);
  assert.ok(Object.isFrozen(VEHICLE_VIEWS));
});
