/**
 * Counter-UX Item 1 (2026-08-31) — the vehicle-assignment picker filter.
 *
 * One pure rule shared by EVERY assign surface (reservation-detail picker,
 * loaner ops picker, /swap page, checkout-wizard-v2 swap modal, loaner
 * intake): default to AVAILABLE units of the reservation's vehicle type,
 * full list when the reservation has no type, ALWAYS keep the currently
 * assigned/selected vehicle, and honor the "Show all vehicles" escape hatch.
 */
import { describe, it, expect } from 'vitest';
import { filterAssignableVehicles, vehicleTypeIdOf, assignFilterApplies } from '../src/lib/vehicle-assignment.js';

const fleet = [
  { id: 'v1', status: 'AVAILABLE', vehicleTypeId: 'suv' },
  { id: 'v2', status: 'AVAILABLE', vehicleTypeId: 'sedan' },
  { id: 'v3', status: 'ON_RENT', vehicleTypeId: 'suv' },
  { id: 'v4', status: 'IN_MAINTENANCE', vehicleTypeId: 'suv' },
  { id: 'v5', status: 'AVAILABLE', vehicleType: { id: 'suv', name: 'SUV' } }, // relation-shaped type
  { id: 'v6', status: 'available', vehicleTypeId: 'suv' },                    // lower-case status
];

describe('filterAssignableVehicles — type match', () => {
  it('keeps only AVAILABLE vehicles of the reservation type', () => {
    const out = filterAssignableVehicles(fleet, { vehicleTypeId: 'suv' });
    expect(out.map((v) => v.id)).toEqual(['v1', 'v5', 'v6']);
  });

  it('reads the type from vehicleTypeId OR vehicleType.id', () => {
    expect(vehicleTypeIdOf({ vehicleTypeId: 'suv' })).toBe('suv');
    expect(vehicleTypeIdOf({ vehicleType: { id: 'suv' } })).toBe('suv');
    expect(vehicleTypeIdOf({})).toBe(null);
  });

  it('status matching is case-insensitive but strict on AVAILABLE', () => {
    const out = filterAssignableVehicles(fleet, { vehicleTypeId: 'suv' });
    expect(out.some((v) => v.id === 'v3')).toBe(false); // ON_RENT out
    expect(out.some((v) => v.id === 'v4')).toBe(false); // IN_MAINTENANCE out
    expect(out.some((v) => v.id === 'v6')).toBe(true);  // 'available' in
  });
});

describe('filterAssignableVehicles — no-type fallback', () => {
  it('returns the full list untouched when the reservation has no vehicle type', () => {
    expect(filterAssignableVehicles(fleet, { vehicleTypeId: null })).toEqual(fleet);
    expect(filterAssignableVehicles(fleet, {})).toEqual(fleet);
    expect(filterAssignableVehicles(fleet, { vehicleTypeId: '' })).toEqual(fleet);
  });

  it('assignFilterApplies mirrors the same rule (drives whether the hatch renders)', () => {
    expect(assignFilterApplies({ vehicleTypeId: 'suv' })).toBe(true);
    expect(assignFilterApplies({ vehicleTypeId: null })).toBe(false);
    expect(assignFilterApplies({})).toBe(false);
  });
});

describe('filterAssignableVehicles — current vehicle always included', () => {
  it('keeps the assigned vehicle even when it no longer matches type or status', () => {
    const out = filterAssignableVehicles(fleet, { vehicleTypeId: 'suv', keepIds: ['v2'] });
    expect(out.some((v) => v.id === 'v2')).toBe(true); // sedan, kept anyway
    const out2 = filterAssignableVehicles(fleet, { vehicleTypeId: 'sedan', keepIds: ['v4'] });
    expect(out2.map((v) => v.id)).toEqual(['v2', 'v4']); // IN_MAINTENANCE suv, kept anyway
  });

  it('accepts a single id, an array, and ignores null/empty keep ids', () => {
    expect(filterAssignableVehicles(fleet, { vehicleTypeId: 'sedan', keepIds: 'v3' }).map((v) => v.id)).toEqual(['v2', 'v3']);
    expect(filterAssignableVehicles(fleet, { vehicleTypeId: 'sedan', keepIds: [null, '', undefined] }).map((v) => v.id)).toEqual(['v2']);
  });

  it('so an open reservation never renders an empty/invalid selection', () => {
    // Every candidate filtered out, but the assigned car survives.
    const out = filterAssignableVehicles(
      [{ id: 'v9', status: 'SOLD', vehicleTypeId: 'van' }],
      { vehicleTypeId: 'suv', keepIds: ['v9'] }
    );
    expect(out.map((v) => v.id)).toEqual(['v9']);
  });
});

describe('filterAssignableVehicles — escape hatch', () => {
  it('showAll bypasses the filter entirely (deliberate upgrades stay possible)', () => {
    expect(filterAssignableVehicles(fleet, { vehicleTypeId: 'suv', showAll: true })).toEqual(fleet);
  });

  it('toggling the hatch back re-applies the filter', () => {
    const on = filterAssignableVehicles(fleet, { vehicleTypeId: 'suv', showAll: false });
    expect(on.map((v) => v.id)).toEqual(['v1', 'v5', 'v6']);
  });
});

describe('filterAssignableVehicles — robustness', () => {
  it('tolerates non-array input and malformed rows', () => {
    expect(filterAssignableVehicles(null, { vehicleTypeId: 'suv' })).toEqual([]);
    expect(filterAssignableVehicles(undefined, {})).toEqual([]);
    expect(filterAssignableVehicles([null, {}, { id: 'x' }], { vehicleTypeId: 'suv' })).toEqual([]);
  });
});
