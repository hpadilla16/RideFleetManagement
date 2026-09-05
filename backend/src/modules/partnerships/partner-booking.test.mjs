/**
 * Partnerships F2 — pure checkout/quote rules (DB-free). Run: npm run test:partnerships
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  partnerEligibleTypeIds,
  applyPartnerDiscount,
  partnerPricingBlock,
  partnerCheckoutRequirements,
  mandatoryPartnerServices,
  PartnerUnavailableError
} from './partner-booking.js';

const base = (over = {}) => ({
  partner: { id: 'p1', slug: 'seguros-isla', code: 'ISLA26', name: 'Seguros Isla', kind: 'INSURANCE', vehicleMode: 'SHOW_INVENTORY', preferredTypePricing: 'CONFIRM_AT_PICKUP', askPolicyNumber: false, termsVersion: 3, coverageDisclosureVersion: 2 },
  pricingMode: 'RATE', rateId: 'r1', discountPct: null, allowedVehicleTypeIds: null, defaultVehicleTypeId: null, noOnlinePayment: false, services: [],
  ...over
});

test('eligible types per vehicle mode', () => {
  const all = ['a', 'b', 'c'];
  assert.deepEqual(partnerEligibleTypeIds(null, all), all, 'no partner → everything');
  assert.deepEqual(partnerEligibleTypeIds(base(), all), all, 'SHOW_INVENTORY without narrowing → everything (the book fails closed per class later)');
  assert.deepEqual(partnerEligibleTypeIds(base({ allowedVehicleTypeIds: ['b', 'zzz'] }), all), ['b']);
  assert.deepEqual(partnerEligibleTypeIds(base({ partner: { ...base().partner, vehicleMode: 'PREFERRED_TYPE' }, allowedVehicleTypeIds: ['c', 'a'] }), all), ['c', 'a']);
  assert.deepEqual(partnerEligibleTypeIds(base({ partner: { ...base().partner, vehicleMode: 'PREFERRED_TYPE' } }), all), [], 'preferred type with nothing selectable → nothing');
  assert.deepEqual(partnerEligibleTypeIds(base({ partner: { ...base().partner, vehicleMode: 'ASSIGN_AT_PICKUP' }, defaultVehicleTypeId: 'b' }), all), ['b']);
  assert.deepEqual(partnerEligibleTypeIds(base({ partner: { ...base().partner, vehicleMode: 'ASSIGN_AT_PICKUP' }, defaultVehicleTypeId: 'nope' }), all), []);
});

test('discount mode is an effective daily rate on the ONLINE quote, per-day breakdown included', () => {
  const online = { dailyRate: 52, baseDailyRate: 52, baseTotal: 156, days: 3, dailyBreakdown: [{ date: '2026-10-12', dailyRate: 52 }, { date: '2026-10-13', dailyRate: 52 }, { date: '2026-10-14', dailyRate: 52 }], source: 'LOCATION' };
  const q = applyPartnerDiscount(online, 12);
  assert.equal(q.dailyRate, 45.76);
  assert.equal(q.baseTotal, 137.28);
  assert.equal(q.days, 3);
  assert.equal(q.source, 'PARTNER_DISCOUNT');
  assert.deepEqual(q.dailyBreakdown.map((r) => r.dailyRate), [45.76, 45.76, 45.76]);
  assert.equal(applyPartnerDiscount(null, 12), null, 'no online quote → nothing (fail-closed)');
});

test('partnerPricing block carries the strike-through numbers', () => {
  const block = partnerPricingBlock(base({ pricingMode: 'DISCOUNT', discountPct: 12, rateId: null }), { onlineQuote: { dailyRate: 52 }, programQuote: { dailyRate: 45.76 } });
  assert.equal(block.mode, 'DISCOUNT');
  assert.equal(block.onlineDailyRate, 52);
  assert.equal(block.programDailyRate, 45.76);
  assert.equal(block.savingsPct, 12);
  assert.equal(block.priceConfirmedAtPickup, false);
  assert.equal(partnerPricingBlock(null, {}), null);
});

test('checkout requirements: SHOW_INVENTORY must pick an offered class', () => {
  const ctx = base();
  assert.throws(() => partnerCheckoutRequirements(ctx, { vehicleTypeId: 'zzz' }, { offeredTypeIds: ['a', 'b'] }), /not offered/);
  const out = partnerCheckoutRequirements(ctx, { vehicleTypeId: 'a' }, { offeredTypeIds: ['a', 'b'] });
  assert.equal(out.vehicleTypeId, 'a');
  assert.equal(out.noOnlinePayment, false);
  assert.equal(out.stamps.partnerId, 'p1');
  assert.equal(out.stamps.partnerTermsVersion, 3);
  assert.equal(out.stamps.partnerPreferredVehicleTypeId, null);
  assert.equal(partnerCheckoutRequirements(null, {}), null);
});

test('checkout requirements: PREFERRED_TYPE needs an offered type + accepted disclosure; no online payment by default', () => {
  const ctx = base({ partner: { ...base().partner, vehicleMode: 'PREFERRED_TYPE', askPolicyNumber: true }, allowedVehicleTypeIds: ['a', 'b'], noOnlinePayment: true });
  assert.throws(() => partnerCheckoutRequirements(ctx, { partnerPreferredVehicleTypeId: 'a' }, { offeredTypeIds: ['a', 'b'] }), /coverage disclosure/);
  assert.throws(() => partnerCheckoutRequirements(ctx, { partnerPreferredVehicleTypeId: 'zzz', partnerDisclosureAccepted: true }, { offeredTypeIds: ['a', 'b'] }), /vehicle types offered/);
  const out = partnerCheckoutRequirements(ctx, { partnerPreferredVehicleTypeId: 'b', partnerDisclosureAccepted: true, partnerPolicyNumber: ' POL-123 ' }, { offeredTypeIds: ['a', 'b'] });
  assert.equal(out.vehicleTypeId, 'b', 'the preference becomes the booked class (program price at hand for the counter)');
  assert.equal(out.noOnlinePayment, true);
  assert.equal(out.stamps.partnerPreferredVehicleTypeId, 'b');
  assert.ok(out.stamps.partnerDisclosureAcceptedAt instanceof Date);
  assert.equal(out.stamps.partnerDisclosureVersion, 2);
  assert.equal(out.stamps.partnerPolicyNumber, 'POL-123');
  // Policy number is ignored unless the program asks for it.
  const quiet = partnerCheckoutRequirements(base({ partner: { ...ctx.partner, askPolicyNumber: false }, allowedVehicleTypeIds: ['a'] }), { partnerPreferredVehicleTypeId: 'a', partnerDisclosureAccepted: true, partnerPolicyNumber: 'X' }, { offeredTypeIds: ['a'] });
  assert.equal(quiet.stamps.partnerPolicyNumber, null);
});

test('checkout requirements: ASSIGN_AT_PICKUP books the default class regardless of the client', () => {
  const ctx = base({ partner: { ...base().partner, kind: 'COOPERATIVE', vehicleMode: 'ASSIGN_AT_PICKUP' }, defaultVehicleTypeId: 'b' });
  const out = partnerCheckoutRequirements(ctx, { vehicleTypeId: 'a' }, { offeredTypeIds: ['b'] });
  assert.equal(out.vehicleTypeId, 'b');
  assert.throws(() => partnerCheckoutRequirements(base({ partner: { ...ctx.partner }, defaultVehicleTypeId: null }), {}, {}), /no default vehicle class/);
});

test('mandatory program services are the ones flagged mandatory', () => {
  assert.deepEqual(mandatoryPartnerServices([{ serviceId: 's1', mandatory: true }, { serviceId: 's2', mandatory: false }, null]).map((s) => s.serviceId), ['s1']);
  assert.deepEqual(mandatoryPartnerServices(undefined), []);
});

test('PartnerUnavailableError is a 422 with a machine code and reason', () => {
  const err = new PartnerUnavailableError('PAUSED');
  assert.equal(err.status, 422);
  assert.equal(err.code, 'PARTNER_NOT_AVAILABLE');
  assert.equal(err.reason, 'PAUSED');
});
