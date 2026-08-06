/**
 * Staff-editable quotes: add-ons (services + insurance) — 2026-08-06, Hector:
 * "abrir quotes que los puedan editar, que puedan poner additional services y
 * insurances. Todo esto sin alterar como el voice ai hace sus proceso".
 *
 * The invariants these tests defend:
 *   - prices resolve SERVER-SIDE from the catalog; the client sends codes;
 *   - totals recompute from the BASELINE (the spoken price), so re-edits never
 *     compound and clearing restores the original number exactly;
 *   - the VozIA shape is untouched: an unedited quote carries addOnsJson null
 *     and converts with zero charge rows, byte-identical to before;
 *   - a converted quote with add-ons itemizes them with the booking engine's
 *     own identities (source SERVICE / INSURANCE).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createQuotesService, parseAddOns } from './quotes.service.js';

const NOW = new Date('2026-08-06T15:00:00.000Z');

const CATALOG = {
  services: [
    { code: 'GPS', name: 'GPS Navigation', quantity: 4, rate: 5, total: 20, taxable: true },
    { code: 'SEAT', name: 'Child Seat', quantity: 1, rate: 25, total: 25, taxable: false },
  ],
  insurancePlans: [
    { code: 'CDW', label: 'Collision Damage Waiver', quantity: 4, amount: 15, rate: 15, total: 60, taxable: false },
  ],
};

function quoteRow(over = {}) {
  return {
    id: 'q1', tenantId: 't1', quoteNumber: 'Q-1000', status: 'ACTIVE',
    pickupLocationId: 'loc1', returnLocationId: 'loc1', vehicleTypeId: 'vt-suv',
    pickupAt: new Date('2026-08-10T14:00:00Z'), returnAt: new Date('2026-08-14T14:00:00Z'),
    days: 4, dailyRate: 50, subtotal: 200, fees: 10, taxes: 23, total: 233,
    expiresAt: new Date('2026-08-09T00:00:00Z'), addOnsJson: null,
    contactName: 'Caller', contactPhone: '787', contactEmail: null, customerId: null,
    source: 'VOZIA', author: null,
    ...over,
  };
}

function makeDb(quotes) {
  const charges = [];
  return {
    charges,
    quote: {
      async findFirst({ where }) {
        return quotes.find((q) => (!where.id || q.id === where.id) && (!where.quoteNumber || q.quoteNumber === where.quoteNumber)) || null;
      },
      async update({ where, data }) { const q = quotes.find((x) => x.id === where.id); Object.assign(q, data); return q; },
      async updateMany() { return { count: 0 }; },
      async count() { return quotes.length; },
    },
    vehicleType: { async findMany() { return [{ id: 'vt-suv', code: 'SUV', name: 'SUV' }]; } },
    location: { async findFirst() { return { taxRate: 10 }; } },
    reservation: { async findFirst() { return null; } },
    reservationCharge: { async createMany({ data }) { charges.push(...data); return { count: data.length }; } },
    customer: {
      async findFirst() { return { id: 'cus1', tenantId: 't1' }; },
      async create({ data }) { return { id: 'cus1', ...data }; },
    },
  };
}

function makeSvc({ quotes = [quoteRow()], engineRows = [] } = {}) {
  const db = makeDb(quotes);
  const reservations = {
    created: [],
    async create(data, scope) { const r = { id: 'res1', ...data, tenantId: scope.tenantId }; reservations.created.push(r); return r; },
  };
  const engine = {
    catalogCalls: [],
    async searchRental() {
      return { results: engineRows.length ? engineRows : [{ vehicleType: { id: 'vt-suv' }, availability: { available: true, availableUnits: 2 }, quote: { days: 4, dailyRate: 50, subtotal: 200, fees: 10, taxes: 23, total: 233 } }] };
    },
    async getAddOnCatalog(args) { engine.catalogCalls.push(args); return CATALOG; },
  };
  const svc = createQuotesService({ prisma: db, bookingEngine: engine, reservations, now: () => NOW, randHex: () => 'ab12', resolveTz: async () => 'UTC' });
  return { svc, db, engine, reservations };
}

const scope = { tenantId: 't1' };

test('setAddOns prices from the catalog and recomputes from the baseline', async () => {
  const { svc, engine } = makeSvc();
  const out = await svc.setAddOns('q1', { addOns: [{ kind: 'SERVICE', code: 'GPS' }, { kind: 'INSURANCE', code: 'CDW' }] }, scope, { userId: 'u1' });

  // Catalog priced for the quote's own location/class/window.
  assert.deepEqual(engine.catalogCalls[0], { tenantId: 't1', locationId: 'loc1', vehicleTypeId: 'vt-suv', baseAmount: 200, days: 4 });

  const state = parseAddOns(out);
  assert.equal(state.items.length, 2);
  assert.deepEqual(state.baseline, { subtotal: 200, fees: 10, taxes: 23, total: 233 });
  // GPS 20 (taxable, 10% → 2) + CDW 60 (not taxable):
  assert.equal(out.taxes, 25, 'baseline 23 + 2 tax on the taxable add-on');
  assert.equal(out.total, 315, '233 + 80 add-ons + 2 tax');
});

test('a re-edit recomputes from the ORIGINAL baseline — never compounds', async () => {
  const { svc } = makeSvc();
  await svc.setAddOns('q1', { addOns: [{ kind: 'SERVICE', code: 'GPS' }, { kind: 'INSURANCE', code: 'CDW' }] }, scope, {});
  const second = await svc.setAddOns('q1', { addOns: [{ kind: 'SERVICE', code: 'SEAT' }] }, scope, {});
  assert.equal(second.total, 258, '233 + 25 (SEAT, untaxed) — the GPS/CDW edit left no residue');

  const cleared = await svc.setAddOns('q1', { addOns: [] }, scope, {});
  assert.equal(cleared.total, 233, 'clearing restores the exact spoken price');
  assert.equal(cleared.taxes, 23);
});

test('codes the catalog does not offer are refused, never priced by guess', async () => {
  const { svc } = makeSvc();
  await assert.rejects(() => svc.setAddOns('q1', { addOns: [{ kind: 'SERVICE', code: 'JETPACK' }] }, scope, {}), /not available/);
  await assert.rejects(() => svc.setAddOns('q1', { addOns: [{ code: 'GPS' }] }, scope, {}), /kind/);
});

test('only ACTIVE quotes are editable', async () => {
  const { svc } = makeSvc({ quotes: [quoteRow({ status: 'CONVERTED' })] });
  await assert.rejects(() => svc.setAddOns('q1', { addOns: [] }, scope, {}), /CONVERTED/);
  await assert.rejects(() => svc.addOnOptions('q1', scope), /CONVERTED/);
});

test('updateContact edits contact only', async () => {
  const { svc } = makeSvc();
  const out = await svc.updateContact('q1', { contactName: 'Ana Soto', contactEmail: 'ana@x.com' }, scope);
  assert.equal(out.contactName, 'Ana Soto');
  assert.equal(out.total, 233, 'money untouched');
  await assert.rejects(() => svc.updateContact('q1', {}, scope), /Nothing to update/);
});

test('VOZIA SHAPE UNTOUCHED: an unedited quote converts with zero charge rows', async () => {
  const { svc, db } = makeSvc();
  const out = await svc.convert('q1', { customerId: 'cus1' }, scope, {});
  assert.equal(out.alreadyConverted, false);
  assert.equal(db.charges.length, 0, 'no add-ons → no itemization → byte-identical to the pre-feature flow');
});

test('a quote WITH add-ons converts with itemized SERVICE/INSURANCE rows', async () => {
  const { svc, db, reservations } = makeSvc();
  await svc.setAddOns('q1', { addOns: [{ kind: 'SERVICE', code: 'GPS' }, { kind: 'INSURANCE', code: 'CDW' }] }, scope, {});
  await svc.convert('q1', { customerId: 'cus1' }, scope, {});

  assert.equal(reservations.created[0].estimatedTotal, 315, 'the reservation promises the edited total');
  assert.equal(db.charges.length, 2);
  const gps = db.charges.find((c) => c.code === 'GPS');
  assert.equal(gps.source, 'SERVICE');
  assert.equal(gps.total, 20);
  assert.equal(gps.taxable, true);
  assert.equal(gps.sourceRefId, 'QUOTE:q1:SERVICE:GPS');
  const cdw = db.charges.find((c) => c.code === 'CDW');
  assert.equal(cdw.source, 'INSURANCE');
  assert.match(cdw.name, /^Insurance: /);
});

test('parseAddOns degrades to null on garbage — never breaks a read', () => {
  assert.equal(parseAddOns({ addOnsJson: null }), null);
  assert.equal(parseAddOns({ addOnsJson: 'not json' }), null);
  assert.equal(parseAddOns({ addOnsJson: '{"items":"nope"}' }), null);
});
