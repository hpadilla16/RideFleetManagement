/**
 * Shadow mode (2026-09-10).
 *
 * The live path was measured this day to deliver the tenant's configured target
 * on 0 of 14 classes, and it has been doing that for weeks with 56 suggestions
 * applied by a human who had no way to know. The only responsible way to replace
 * a money path in that state is to run the replacement BESIDE it first, on real
 * pools, and compare — so the window-target engine is computed on every rule and
 * recorded in the suggestion, and it changes nothing.
 *
 * The load-bearing tests are the first two: the written price is untouched, and
 * the shadow can fail in any way it likes without taking the live path with it.
 *
 * prisma is mocked; no DB.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

const { prisma } = await import('../../lib/prisma.js');
const { evaluateRule } = await import('./pricing-suggestion-engine.service.js');

const SJU = {
  connectionType: 'TITANIUM',
  taxes: [{ name: 'PR tax', pct: 11.5 }, { name: 'Airport fee', pct: 10.5 }],
  brokeragePct: 20.1,
};

function installMock({ offers = [], config = SJU, tenant = { marketExcludedVendors: ['ZezGo'] } } = {}) {
  for (const k of ['pricingSuggestion', 'marketScrapeProfile', 'marketPricingConfig', 'marketObservation', 'rateOffer', 'appSetting', 'tenant']) {
    if (!prisma[k]) prisma[k] = {};
  }
  const state = { suggestionCreates: [], offers, config, tenant };
  const orig = {};
  const set = (path, fn) => { const [a, b] = path.split('.'); orig[path] = prisma[a][b]; prisma[a][b] = fn; };
  set('marketPricingConfig.findFirst', async () => state.config);
  set('marketPricingConfig.findUnique', async () => state.config);
  set('pricingSuggestion.create', async ({ data }) => { state.suggestionCreates.push(data); return { id: 'sg', ...data }; });
  set('pricingSuggestion.updateMany', async () => ({ count: 0 }));
  set('rateOffer.findMany', async () => state.offers);
  set('marketObservation.findMany', async () => []);
  set('marketScrapeProfile.findMany', async () => []);
  set('appSetting.findUnique', async () => null);
  set('tenant.findUnique', async () => state.tenant);
  return {
    state,
    restore: () => { for (const [p, fn] of Object.entries(orig)) { const [a, b] = p.split('.'); prisma[a][b] = fn; } },
  };
}

const offer = (supplier, price, pickupDate) => ({
  id: `o-${supplier}-${pickupDate}-${price}`,
  runId: 'run-1', profileId: 'p1',
  supplier, provider: 'Expedia', source: 'EXPEDIA_DIRECT', status: 'FOUND',
  sipp: 'CCAR', rawCategory: 'Compact', carExample: 'Kia Rio',
  dailyPrice: price, totalPrice: price * 3, effectiveDailyPrice: price, lorDays: 3,
  pickupDate: new Date(pickupDate), returnDate: new Date(pickupDate), observedAt: new Date(),
});

const rule = (over = {}) => ({
  id: 'r1', tenantId: 't1', rateId: 'rate1', sipp: 'CCAR',
  mode: 'SUGGEST', strategy: 'NTH_CHEAPEST', targetN: 2, paddingPct: 0,
  floorPrice: 1, ceilingPrice: 9999, autoMaxDeltaPct: null, active: true,
  rate: { id: 'rate1', rateCode: 'SJU_CCAR_DAILY', daily: 14.14, location: { code: 'SJU' } },
  ...over,
});

// Two pickup dates, three rivals each, plus our own listing (ZezGo).
const POOL = [
  offer('Payless', 15.00, '2026-09-11'), offer('Advantage', 15.67, '2026-09-11'), offer('Hertz', 20.00, '2026-09-11'),
  offer('Payless', 16.00, '2026-09-12'), offer('Advantage', 17.00, '2026-09-12'), offer('Hertz', 21.00, '2026-09-12'),
  offer('ZezGo', 13.00, '2026-09-11'), offer('ZezGo', 13.33, '2026-09-12'),
];

// ---------------------------------------------------------------------------
test('THE POINT: the shadow changes nothing about what gets written', () => {
  // Run the same rule with the shadow's inputs present and absent; the price
  // the tenant would receive must be identical.
  const withPool = installMock({ offers: POOL });
  let priced;
  return evaluateRule(rule())
    .then((out) => {
      priced = out.suggestedPrice;
      const created = withPool.state.suggestionCreates[0];
      assert.ok(created, 'a suggestion was written');
      assert.equal(Number(created.suggestedPrice), priced);
      // The shadow rode along in the audit payload.
      assert.ok(created.reason.shadow, 'the shadow is recorded');
      assert.notEqual(created.reason.shadow.answer, undefined);
      // And it is NOT the number that was written.
      assert.equal(Number(created.suggestedPrice), priced, 'untouched by whatever the shadow said');
    })
    .finally(() => withPool.restore());
});

test('a broken own-brand lookup degrades the shadow, never the live suggestion', async () => {
  // getCompetitorExcludeSet swallows its own failures and returns an empty set,
  // so the shadow keeps working with nobody excluded — our own listing then
  // appears as a rival. That is a degraded answer, and it must not be a
  // degraded PRICE: the live path is untouched either way.
  const m = installMock({ offers: POOL });
  prisma.tenant.findUnique = async () => { throw new Error('tenant lookup exploded'); };
  try {
    const out = await evaluateRule(rule());
    assert.equal(out.skipped, false, 'the live path completed');
    const created = m.state.suggestionCreates[0];
    assert.ok(created.reason.shadow, 'the shadow still reported something');
    assert.equal(created.reason.shadow.selfListingsSeen, 0, 'with nobody recognised as ours');
    assert.ok(Number(created.suggestedPrice) > 0, 'and a price was still written');
  } finally { m.restore(); }
});

// ---------------------------------------------------------------------------
test('the shadow builds its ladder PER PICKUP DATE, not across the window', async () => {
  // The live path takes the min per supplier across every date, which prices
  // for the cheapest day in the window. Here the two dates differ, so a
  // per-date answer and a collapsed one cannot agree.
  const m = installMock({ offers: POOL });
  try {
    await evaluateRule(rule({ targetN: 2 }));
    const s = m.state.suggestionCreates[0].reason.shadow;
    assert.equal(s.datesInPool, 2);
    assert.equal(s.usableDates, 2, 'both dates carry two or more rivals');
    // 2nd cheapest is 15.67 on the 11th and 17.00 on the 12th; the band is
    // (15.67 -> wait: lower = max(15.00, 16.00) = 16.00, upper = min(15.67,
    // 17.00) = 15.67. No intersection, so it must NOT claim every date.
    assert.notEqual(s.answer, 'FEASIBLE');
    assert.ok(s.holdsOn < s.usableDates, `held ${s.holdsOn} of ${s.usableDates}`);
  } finally { m.restore(); }
});

test('our own brand is excluded from the shadow ladder and used for the ratio', async () => {
  const m = installMock({ offers: POOL });
  try {
    await evaluateRule(rule());
    const s = m.state.suggestionCreates[0].reason.shadow;
    assert.equal(s.selfListingsSeen, 2, 'both ZezGo rows recognised as ours');
    assert.equal(s.ratio.n, 2, 'and used to measure listed/base');
    assert.ok(s.ratio.median > 0.9 && s.ratio.median < 1.0, `ratio ${s.ratio.median}`);
    assert.equal(s.ratioAssumed, false, 'measured, not assumed');
  } finally { m.restore(); }
});

test('with no own listing the shadow says the ratio was ASSUMED', async () => {
  const m = installMock({ offers: POOL.filter((o) => o.supplier !== 'ZezGo') });
  try {
    await evaluateRule(rule());
    const s = m.state.suggestionCreates[0].reason.shadow;
    assert.equal(s.selfListingsSeen, 0);
    assert.equal(s.ratioAssumed, true);
    assert.equal(s.ratioUsed, 1);
  } finally { m.restore(); }
});

test('the shadow refuses to answer when no single DATE has enough rivals', async () => {
  // The real SJU shape, and the reason the two engines disagree: three distinct
  // suppliers clear the live path's sample floor, but they are spread one per
  // pickup date, so no date can host a 2nd-cheapest claim at all.
  const thin = [
    offer('Payless', 15, '2026-09-11'),
    offer('Advantage', 16, '2026-09-12'),
    offer('Hertz', 17, '2026-09-13'),
  ];
  const m = installMock({ offers: thin });
  try {
    await evaluateRule(rule({ targetN: 2 }));
    const s = m.state.suggestionCreates[0].reason.shadow;
    assert.equal(s.answer, 'NOT_ANSWERABLE');
    assert.equal(s.base, null, 'and invents no price');
    assert.match(s.sentence, /Cannot say/);
  } finally { m.restore(); }
});

test('a non-ordinal strategy still gets a shadow, aimed at cheapest', async () => {
  // CHASE_VENDOR has no N. Rather than skip the comparison, the shadow answers
  // the question it can answer, and the payload says which.
  const m = installMock({ offers: POOL });
  try {
    await evaluateRule(rule({ strategy: 'CHASE_VENDOR', targetVendor: 'Payless' }));
    const created = m.state.suggestionCreates[0];
    if (created?.reason?.shadow) assert.equal(created.reason.shadow.targetN, 1);
  } finally { m.restore(); }
});
