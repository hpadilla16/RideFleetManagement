/**
 * A promoted reservation must carry the vehicle type the source booked.
 *
 * Hector, 2026-08-05: "estan importing pero no le esta pasando el vehicle type
 * como si CFAR o FVAR". The ACRISS was correct everywhere — on the staged row,
 * in the portal detail, and in the tenant's AcrissCategoryMap — yet all six
 * promoted reservations had vehicleTypeId = null. The category was being lost
 * because evaluatePromotion resolves the ACRISS at gate 2 and then returns
 * MANUAL_REVIEW at gate 4 (customer not found), discarding a mapping it had
 * already made; the promote routes only read the category on an AUTO decision.
 *
 * So resolution belongs on the promote path, which every caller shares.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// Pure test — no DB. The prisma singleton is imported transitively by promote.js
// and only needs a syntactically valid URL to construct.
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://u:p@127.0.0.1:5432/none';
const { resolveVehicleTypeId } = await import('./promote.js');

const FRESH = { tenantId: 't1', externalRef: 'WMX000F86C', vehicleAcriss: 'CFAR' };

// Mirrors International Rental Corp: the map REDIRECTS classes the tenant does
// not stock (ECAR→CCAR, ICAR→SCAR) and passes through the ones it does.
const MAP = { CFAR: 'CFAR', FVAR: 'FVAR', ECAR: 'CCAR', ICAR: 'SCAR' };
const TYPES = ['CCAR', 'CFAR', 'FFAR', 'FVAR', 'SCAR', 'SFAR', 'SPAR'];

function tx({ map = MAP, types = TYPES, calls = {} } = {}) {
  return {
    acrissCategoryMap: {
      findFirst: async ({ where }) => {
        calls.map = (calls.map || 0) + 1;
        const cat = map[where.acrissCode];
        return cat ? { vehicleCategory: cat } : null;
      },
    },
    vehicleType: {
      findFirst: async ({ where }) => {
        calls.type = (calls.type || 0) + 1;
        const code = String(where.code.equals).toUpperCase();
        return types.includes(code) ? { id: `vt-${code}` } : null;
      },
    },
  };
}

describe('resolveVehicleTypeId', () => {
  it('falls back to the row own ACRISS when no caller supplied a category', async () => {
    // The exact production bug: a hand-approved review row promotes with
    // vehicleCategory=null, and must still land on CFAR.
    assert.equal(await resolveVehicleTypeId(tx(), FRESH, {}), 'vt-CFAR');
    assert.equal(
      await resolveVehicleTypeId(tx(), { ...FRESH, vehicleAcriss: 'FVAR' }, { vehicleCategory: null }),
      'vt-FVAR',
    );
  });

  it('honours the map redirect instead of the raw ACRISS', async () => {
    // ECAR is not stocked; the tenant maps it to CCAR. Matching the ACRISS
    // straight against VehicleType would find nothing and lose the type.
    assert.equal(await resolveVehicleTypeId(tx(), { ...FRESH, vehicleAcriss: 'ECAR' }, {}), 'vt-CCAR');
    assert.equal(await resolveVehicleTypeId(tx(), { ...FRESH, vehicleAcriss: 'ICAR' }, {}), 'vt-SCAR');
  });

  it('uses the ACRISS as a type code when the map has no row for it', async () => {
    assert.equal(await resolveVehicleTypeId(tx({ map: {} }), { ...FRESH, vehicleAcriss: 'SPAR' }, {}), 'vt-SPAR');
  });

  it('an explicit choice by a human is never overridden', async () => {
    const calls = {};
    assert.equal(
      await resolveVehicleTypeId(tx({ calls }), FRESH, { vehicleTypeId: 'vt-PICKED-BY-HAND' }),
      'vt-PICKED-BY-HAND',
    );
    assert.deepEqual(calls, {}, 'an explicit id must not trigger a single lookup');

    // A panel override of the category outranks the row's own ACRISS.
    assert.equal(await resolveVehicleTypeId(tx(), FRESH, { vehicleCategory: 'FFAR' }), 'vt-FFAR');
  });

  it('a category the tenant does not stock still falls through to the ACRISS', async () => {
    // Otherwise a stale override would silently blank the type.
    assert.equal(await resolveVehicleTypeId(tx(), FRESH, { vehicleCategory: 'NOPE' }), 'vt-CFAR');
  });

  it('returns null rather than throwing when nothing resolves', async () => {
    assert.equal(await resolveVehicleTypeId(tx(), { ...FRESH, vehicleAcriss: null }, {}), null);
    assert.equal(await resolveVehicleTypeId(tx(), { ...FRESH, vehicleAcriss: '   ' }, {}), null);
    assert.equal(await resolveVehicleTypeId(tx({ map: {}, types: [] }), FRESH, {}), null);
  });

  it('degrades to null when the tx has no acrissCategoryMap at all', async () => {
    // Rolling deploy / test double: a missing model must not break promotion,
    // which is the one thing worse than a missing vehicle type.
    const bare = { vehicleType: tx().vehicleType };
    assert.equal(await resolveVehicleTypeId(bare, FRESH, {}), 'vt-CFAR', 'direct code match still works');
    assert.equal(await resolveVehicleTypeId({}, FRESH, {}), null);
  });

  it('matches type codes case-insensitively', async () => {
    assert.equal(await resolveVehicleTypeId(tx(), { ...FRESH, vehicleAcriss: 'cfar' }, {}), 'vt-CFAR');
  });
});
