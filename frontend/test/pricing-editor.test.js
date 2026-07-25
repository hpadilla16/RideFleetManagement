/**
 * Round-trip tests for the Edit-pricing derivation (2026-07-25).
 *
 * THE MONEY LOOP UNDER TEST: portal writes charges → pricingEditorState derives
 * the editor's selections → Save Override rebuilds rows from the catalog. Two
 * live money bugs lived in this loop:
 *  - precheckin services (source ADDITIONAL_SERVICE_PRECHECKIN) were not
 *    derived at all → Save Override DELETED a purchased upsell;
 *  - insurance derived from the snapshot, which the portal never updates (and
 *    which only persists ONE code) → a plan added at pre-check-in was dropped.
 *
 * And the QA blocker on the first fix attempt: identity was keyed by NAME with
 * only the "(Pre-checkin rate)" suffix stripped, but the editor prepends
 * "Service: " — so on the SECOND override the name stopped matching, the row
 * lost its PRECHECKIN source, and the portal's delete-by-source missed it and
 * double-charged the customer. The two-override test here is what pins that.
 */
import { describe, it, expect } from 'vitest';
import { pricingEditorState } from '../src/lib/pricing-editor';
import {
  precheckinServiceKeys,
  isPrecheckinService,
  hasPrecheckinDiscount,
} from '../src/lib/precheckin-discount';

// What the PORTAL writes after the customer buys at pre-check-in.
const PORTAL_CHARGES = [
  { name: 'Daily', source: 'DAILY', sourceRefId: null, notes: null },
  {
    name: 'Toll Pass (Pre-checkin rate)',
    source: 'ADDITIONAL_SERVICE_PRECHECKIN',
    sourceRefId: 'svc-toll-1',
    notes: 'Counter price: $12.99/day × 3 day(s) × 1 unit(s), pre-checkin discount applied',
  },
  {
    name: 'CDW Zero Deductible (Pre-checkin rate)',
    source: 'INSURANCE',
    sourceRefId: '101',
    notes: 'Counter price: $35.99/day × 3 day(s), pre-checkin discount applied',
  },
];

// The snapshot as the portal leaves it: STALE — no insurance code, because the
// portal never writes selectedInsuranceCode(s).
const STALE_SNAPSHOT = { dailyRate: 50, taxRate: 9.5, selectedInsuranceCode: '' };

describe('pricingEditorState — deriving from what the portal wrote', () => {
  const state = pricingEditorState({ snapshot: STALE_SNAPSHOT, charges: PORTAL_CHARGES }, {});

  it('a precheckin service APPEARS in the editor (it used to be deleted on save)', () => {
    expect(state.serviceNames).toBe('Toll Pass');
  });

  it('insurance derives from the LIVE charge, not the stale snapshot', () => {
    expect(state.insuranceCodes).toBe('101');
  });

  it('a deliberately removed plan stays removed (empty charges + cleared snapshot)', () => {
    const after = pricingEditorState({ snapshot: STALE_SNAPSHOT, charges: [PORTAL_CHARGES[0]] }, {});
    expect(after.insuranceCodes).toBe('');
  });

  it('pre-charge drafts still fall back to the snapshot', () => {
    const draft = pricingEditorState(
      { snapshot: { ...STALE_SNAPSHOT, selectedInsuranceCode: '14' }, charges: [] },
      {},
    );
    expect(draft.insuranceCodes).toBe('14');
  });
});

describe('two consecutive overrides — the QA blocker', () => {
  // What the EDITOR writes on override #1: name decorated with BOTH the
  // "Service: " prefix and the "(Pre-checkin rate)" suffix.
  const OVERRIDE1_CHARGES = [
    { name: 'Daily', source: 'DAILY', sourceRefId: null, notes: null },
    {
      name: 'Service: Toll Pass (Pre-checkin rate)',
      source: 'ADDITIONAL_SERVICE_PRECHECKIN',
      sourceRefId: 'svc-toll-1',
      notes: 'Counter price: $12.99 per unit × 3, pre-checkin discount applied',
    },
    {
      name: 'Insurance: CDW Zero Deductible (Pre-checkin rate)',
      source: 'INSURANCE',
      sourceRefId: '101',
      notes: 'Counter price: $35.99/day × 3 day(s), pre-checkin discount applied',
    },
  ];

  it('override #2 still derives the same clean selections', () => {
    const state = pricingEditorState({ snapshot: STALE_SNAPSHOT, charges: OVERRIDE1_CHARGES }, {});
    expect(state.serviceNames).toBe('Toll Pass');
    expect(state.insuranceCodes).toBe('101');
  });

  it('the service is STILL recognized as precheckin — source cannot degrade', () => {
    const keys = precheckinServiceKeys(OVERRIDE1_CHARGES);
    // Primary key: the catalog id, immune to any name decoration.
    expect(isPrecheckinService(keys, { id: 'svc-toll-1', name: 'Toll Pass' })).toBe(true);
    // Fallback: the decorated name itself must ALSO match (this exact case is
    // the blocker — suffix-only stripping missed the "Service: " prefix).
    expect(isPrecheckinService(keys, { id: null, name: 'Service: Toll Pass (Pre-checkin rate)' })).toBe(true);
    expect(isPrecheckinService(keys, { id: null, name: 'Toll Pass' })).toBe(true);
    // A different service is NOT swept in.
    expect(isPrecheckinService(keys, { id: 'svc-gps-9', name: 'GPS' })).toBe(false);
  });

  it('the discount marker survives the round trip, so override #3 still discounts', () => {
    expect(hasPrecheckinDiscount(OVERRIDE1_CHARGES)).toBe(true);
  });
});

describe('reservations that never went through pre-check-in', () => {
  const BOOKING_CHARGES = [
    { name: 'Daily', source: 'DAILY', sourceRefId: null, notes: null },
    { name: 'CDW $500', source: 'INSURANCE', sourceRefId: '14', notes: null },
    { name: 'Service: GPS', source: 'SERVICE', sourceRefId: 'svc-gps-9', notes: null },
  ];

  it('derivation is unchanged for ordinary reservations', () => {
    const state = pricingEditorState({ snapshot: STALE_SNAPSHOT, charges: BOOKING_CHARGES }, {});
    expect(state.serviceNames).toBe('GPS');
    expect(state.insuranceCodes).toBe('14');
  });

  it('no marker → no discount context', () => {
    expect(hasPrecheckinDiscount(BOOKING_CHARGES)).toBe(false);
    const keys = precheckinServiceKeys(BOOKING_CHARGES);
    expect(isPrecheckinService(keys, { id: 'svc-gps-9', name: 'GPS' })).toBe(false);
  });
});
