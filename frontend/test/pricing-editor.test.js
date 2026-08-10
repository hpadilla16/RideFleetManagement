/**
 * The money round-trip: charges -> editor derives -> Save Override rebuilds.
 *
 * Hector, 2026-08-10: an agent edits an additional service's unit and price on
 * a reservation, clicks Save Override, and it reverts to whatever is
 * configured in settings.
 *
 * The cause was in this file. pricingEditorState reduced every service to a
 * comma-separated list of NAMES, discarding rate and quantity, so the page had
 * nothing left to rebuild from but the AdditionalService catalog. The editor
 * literally could not represent a price belonging to one reservation.
 *
 * The flag is what separates "a human set this" from "this came from
 * settings" — only the former is frozen, so changing a service's price in
 * settings still reaches reservations nobody has edited.
 */
import { describe, it, expect } from 'vitest';
import { pricingEditorState, editableRowId } from '../src/lib/pricing-editor';

const svc = (over = {}) => ({
  source: 'SERVICE',
  sourceRefId: 'svc-gps',
  name: 'Service: GPS Unit',
  rate: 25,
  quantity: 3,
  ...over,
});

describe('pricingEditorState — services carry their price, not just a name', () => {
  it('THE BUG: rate and quantity survive the derivation', () => {
    const out = pricingEditorState({ charges: [svc()] }, { dailyRate: 50 });
    expect(out.servicePricing).toHaveLength(1);
    expect(out.servicePricing[0]).toMatchObject({
      sourceRefId: 'svc-gps',
      name: 'GPS Unit',
      rate: 25,
      quantity: 3,
    });
    // The old behaviour kept ONLY this, which is what forced the rebuild back
    // to the settings catalog.
    expect(out.serviceNames).toBe('GPS Unit');
  });

  it('carries the override flag so a typed price can be told from a configured one', () => {
    const configured = pricingEditorState({ charges: [svc()] }, {});
    expect(configured.servicePricing[0].priceOverridden).toBe(false);

    const typed = pricingEditorState({ charges: [svc({ priceOverridden: true })] }, {});
    expect(typed.servicePricing[0].priceOverridden).toBe(true);
  });

  it('an untouched service stays unfrozen, so settings changes still reach it', () => {
    // The reason the flag is STORED and not inferred by comparing to the
    // catalog: raise a price in settings and every untouched row would suddenly
    // "differ" and freeze at its old rate — the opposite of what settings are for.
    const out = pricingEditorState({ charges: [svc({ rate: 10, priceOverridden: false })] }, {});
    expect(out.servicePricing[0].priceOverridden).toBe(false);
  });

  it('handles every service source the portal writes', () => {
    const out = pricingEditorState({
      charges: [
        svc({ source: 'ADDITIONAL_SERVICE', sourceRefId: 'a', name: 'Service: Child Seat' }),
        svc({ source: 'ADDITIONAL_SERVICE_PRECHECKIN', sourceRefId: 'b', name: 'Service: Wifi (Pre-checkin rate)' }),
      ],
    }, {});
    expect(out.servicePricing.map((s) => s.name)).toEqual(['Child Seat', 'Wifi']);
  });

  it('ignores rows that are not services', () => {
    const out = pricingEditorState({
      charges: [
        svc(),
        { source: 'TAX', name: 'Sales Tax', rate: 11.5, quantity: 1 },
        { source: 'MANDATORY_FEE', name: 'Fee: Vehicle License', rate: 4, quantity: 1 },
        { source: 'TOLL_MODULE', name: 'Toll', rate: 1.4, quantity: 1 },
      ],
    }, {});
    expect(out.servicePricing).toHaveLength(1);
    expect(out.servicePricing[0].name).toBe('GPS Unit');
  });

  it('a reservation with no charges yet derives an empty list, never undefined', () => {
    const out = pricingEditorState(null, { dailyRate: 40 });
    expect(out.servicePricing).toEqual([]);
    expect(out.serviceNames).toBe('');
  });

  it('missing numbers degrade to usable values rather than NaN', () => {
    const out = pricingEditorState({ charges: [svc({ rate: undefined, quantity: undefined })] }, {});
    expect(out.servicePricing[0].rate).toBe(0);
    expect(out.servicePricing[0].quantity).toBe(1);
  });
});

describe('fees and insurance carry their price too', () => {
  // Verified at Hector's request on 2026-08-10: page.js rebuilt a fee from
  // feeOptions (opt.amount) and insurance from the plan (plan.amount), exactly
  // like services, so both discarded a typed price on the next editor open.
  it('a fee keeps its rate, quantity and override flag', () => {
    const out = pricingEditorState({
      charges: [{ source: 'FEE', sourceRefId: 'fee-1', name: 'Fee: Airport Concession', rate: 9.5, quantity: 4, priceOverridden: true }],
    }, {});
    expect(out.feePricing).toHaveLength(1);
    expect(out.feePricing[0]).toMatchObject({ name: 'Airport Concession', rate: 9.5, quantity: 4, priceOverridden: true });
  });

  it('every fee source the engine writes is picked up', () => {
    const out = pricingEditorState({
      charges: [
        { source: 'MANDATORY_FEE', sourceRefId: 'a', name: 'Fee: Vehicle License', rate: 4, quantity: 1 },
        { source: 'UNDERAGE_FEE', sourceRefId: 'b', name: 'Fee: Underage Driver', rate: 15, quantity: 1 },
        { source: 'SERVICE_LINKED_FEE', sourceRefId: 'c', name: 'Fee: Delivery', rate: 30, quantity: 1 },
      ],
    }, {});
    expect(out.feePricing.map((f) => f.name)).toEqual(['Vehicle License', 'Underage Driver', 'Delivery']);
  });

  it('insurance keeps its amount and flag', () => {
    const out = pricingEditorState({
      charges: [{ source: 'INSURANCE', sourceRefId: 'CDW', name: 'Insurance: Collision Damage Waiver', rate: 18.75, quantity: 5, priceOverridden: true }],
    }, {});
    expect(out.insurancePricing[0]).toMatchObject({ sourceRefId: 'CDW', rate: 18.75, quantity: 5, priceOverridden: true });
    // The codes string the editor already used stays intact beside it.
    expect(out.insuranceCodes).toBe('CDW');
  });

  it('an untouched fee or plan stays unfrozen', () => {
    const out = pricingEditorState({
      charges: [
        { source: 'FEE', sourceRefId: 'f', name: 'Fee: X', rate: 5, quantity: 1 },
        { source: 'INSURANCE', sourceRefId: 'Y', name: 'Insurance: Y', rate: 5, quantity: 1 },
      ],
    }, {});
    expect(out.feePricing[0].priceOverridden).toBe(false);
    expect(out.insurancePricing[0].priceOverridden).toBe(false);
  });

  it('a reservation with nothing yet gives empty lists, never undefined', () => {
    const out = pricingEditorState(null, {});
    expect(out.feePricing).toEqual([]);
    expect(out.insurancePricing).toEqual([]);
  });
});

describe('editableRowId — the id both sides of the editor must agree on', () => {
  // THE BUG (Hector, 2026-08-10, RES-041577): the row DISPLAYED used
  // `service-${sourceRefId}` and the row SAVED used `svc-${index}`. Typed edits
  // are keyed by the displayed id, so applyOv looked them up under an id that
  // did not exist and every service and fee price was dropped on save.
  //
  // Insurance was the accident that exposed it: both sides keyed off the plan
  // code, so insurance alone survived — exactly what he reported.
  it('the same row gets the same id from either side', () => {
    const refId = 'cmnbvc6bg0007s60ielxjcmly';
    // display side passes the charge's sourceRefId; core side passes opt.id.
    expect(editableRowId('service', refId, 3)).toBe(editableRowId('service', refId, 99));
    expect(editableRowId('service', refId, 0)).toBe('service-' + refId);
  });

  it('never produces the old index-keyed shapes', () => {
    expect(editableRowId('service', 'abc', 2)).not.toBe('svc-2');
    expect(editableRowId('fee', 'abc', 2)).not.toBe('fee-2');
  });

  it('falls back to the index only when there is no reference', () => {
    expect(editableRowId('fee', null, 4)).toBe('fee-4');
    expect(editableRowId('fee', undefined, 0)).toBe('fee-0');
    expect(editableRowId('service', '', 7)).toBe('service-7');
  });

  it('keeps insurance on the shape that already worked', () => {
    expect(editableRowId('insurance', 'CDW', 0)).toBe('insurance-CDW');
  });

  it('a zero reference is a reference, not a missing one', () => {
    expect(editableRowId('fee', 0, 9)).toBe('fee-0');
  });
});
