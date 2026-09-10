/**
 * All-in comparison, base recommendation (2026-09-10).
 *
 * Hector: "recuerda que veamos la competencia pero todavia recomienda el precio
 * que ellos tienen que poner en sus integraciones para reflejar ese precio que
 * ve el cliente." Two domains, and the engine has to keep them straight:
 *
 *   compare in ALL-IN   — what a customer pays, on both sides
 *   recommend in BASE   — what the tenant types into Titanium/Amadeus
 *
 * It used to do neither: the ladder was built from Kayak QUOTES (a teaser,
 * measured that day at 0.582x Expedia's all-in) and the winner was written
 * straight into Rate.daily as a base. So the card ranked our grossed-up price
 * against their teaser — SJU read "#4 of 4" while sitting roughly at market —
 * and the recommendation was a customer-facing number masquerading as a base.
 *
 * The load-bearing case is the first one, priced out with SJU's real config.
 *
 * Pure-ish: prisma is mocked, no DB.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

const { prisma } = await import('../../lib/prisma.js');
const { evaluateRule } = await import('./pricing-suggestion-engine.service.js');
const { competitorAllIn, customerAllInFromBase, baseFromCustomerAllIn } =
  await import('../market-scraper/pricing-grossup.js');

// SJU as configured in production: PR tax 11.5% + airport fee 10.5%, brokerage
// 20.1%, TITANIUM. Gross-up factor 1.4652.
const SJU = {
  connectionType: 'TITANIUM',
  taxes: [{ name: 'PR tax', pct: 11.5 }, { name: 'Airport fee', pct: 10.5 }],
  brokeragePct: 20.1,
};

// Monkey-patch prisma the same way min-sample-guard.test.mjs does: node:test's
// mock.method cannot touch the client's proxied namespaces.
function installMock({ offers = [], config = SJU } = {}) {
  for (const k of ['pricingSuggestion', 'marketScrapeProfile', 'marketPricingConfig', 'marketObservation', 'rateOffer', 'appSetting']) {
    if (!prisma[k]) prisma[k] = {};
  }
  const state = { suggestionCreates: [], offers, config };
  const orig = {};
  const set = (path, fn) => {
    const [a, b] = path.split('.');
    orig[path] = prisma[a][b];
    prisma[a][b] = fn;
  };
  set('marketPricingConfig.findFirst', async () => state.config);
  set('marketPricingConfig.findUnique', async () => state.config);
  set('pricingSuggestion.create', async ({ data }) => { state.suggestionCreates.push(data); return { id: 'sg', ...data }; });
  set('pricingSuggestion.updateMany', async () => ({ count: 0 }));
  set('rateOffer.findMany', async () => state.offers);
  set('marketObservation.findMany', async () => []);
  set('marketScrapeProfile.findMany', async () => []);
  set('appSetting.findUnique', async () => null);
  return {
    state,
    restore: () => { for (const [path, fn] of Object.entries(orig)) { const [a, b] = path.split('.'); prisma[a][b] = fn; } },
  };
}

const offer = (supplier, price) => ({
  id: `o-${supplier}-${price}`,
  profileId: 'p1',
  supplier,
  // EXPEDIA_DIRECT, not KAYAK: the adapter's all-in allowlist keeps KAYAK out
  // of purpose:'pricing' unless KAYAK_EFFECTIVE_IS_ALL_IN is set, and this test
  // is about the two price DOMAINS, not about that gate.
  provider: 'Expedia',
  source: 'EXPEDIA_DIRECT',
  status: 'FOUND',
  runId: 'run-1',
  sipp: 'SFAR',
  rawCategory: 'Standard SUV',
  carExample: 'Mitsubishi Outlander',
  dailyPrice: price,
  totalPrice: price * 3,
  effectiveDailyPrice: price,
  lorDays: 3,
  pickupDate: new Date('2026-09-13'),
  returnDate: new Date('2026-09-16'),
  observedAt: new Date(),
});

const rule = (over = {}) => ({
  id: 'r1',
  tenantId: 't1',
  rateId: 'rate1',
  sipp: 'SFAR',
  mode: 'SUGGEST',
  strategy: 'NTH_CHEAPEST',
  targetN: 2,
  paddingPct: -2,
  floorPrice: 1,
  ceilingPrice: 9999,
  autoMaxDeltaPct: null,
  active: true,
  rate: { id: 'rate1', rateCode: 'SJU_SFAR_DAILY', daily: 37.9, location: { code: 'SJU' } },
  ...over,
});

test('THE SFAR CASE: the ladder is all-in and the recommendation is a base', async () => {
  // Three agencies quoted 35 / 38.67 / 44 on Kayak. 2nd cheapest = 38.67, which
  // is a TEASER. Their customer pays 38.67 x 1.22 = $47.18. Padding -2% aims at
  // $46.24 all-in, and the base that grosses up to it is $31.56.
  const m = installMock({ offers: [offer('Routes', 35), offer('Zezgo', 38.67), offer('U-Save', 44)] });
  try {
    const out = await evaluateRule(rule());
    assert.equal(out.skipped, false, JSON.stringify(out));

    const created = m.state.suggestionCreates[0];
    assert.ok(created, 'a suggestion was written');
    const r = created.reason;

    assert.equal(r.priceBasis, 'TAXES_ONLY');
    assert.equal(r.competitorFactor, 1.22);
    assert.equal(r.marketMinQuoted, 35, 'the raw quote is kept for the audit');
    assert.equal(r.marketMin, competitorAllIn(35, SJU), 'the ladder is in all-in');
    assert.equal(r.targetAllIn, 46.24, '2nd cheapest 38.67 -> 47.18 all-in, less 2%');

    const base = Number(created.suggestedPrice);
    assert.equal(base, 31.56, 'the recommendation is the BASE to upload');
    assert.ok(base < r.targetAllIn, 'a base is always below the all-in it produces');
    assert.equal(r.suggestedAllIn, 46.24, 'and it grosses back up to the target');
  } finally { m.restore(); }
});

test('the recommended base round-trips through the tenant gross-up', async () => {
  // The property that matters: whatever base we recommend, the customer must
  // land on the all-in we aimed for. Anything else is a silent over- or
  // under-price.
  const m = installMock({ offers: [offer('A', 20), offer('B', 30), offer('C', 40)] });
  try {
    await evaluateRule(rule({ paddingPct: 0 }));
    const created = m.state.suggestionCreates[0];
    const base = Number(created.suggestedPrice);
    const allIn = customerAllInFromBase(base, SJU);
    assert.ok(Math.abs(allIn - created.reason.targetAllIn) < 0.02, `${allIn} vs ${created.reason.targetAllIn}`);
  } finally { m.restore(); }
});

test('NO tax config: identical to the old behavior, and the basis says so', async () => {
  // A location with no config must not change at all. The lift becomes the
  // identity in both directions, so the 2nd-cheapest quote is the suggestion.
  const m = installMock({ offers: [offer('A', 20), offer('B', 30), offer('C', 40)], config: null });
  try {
    await evaluateRule(rule({ paddingPct: 0 }));
    const created = m.state.suggestionCreates[0];
    assert.equal(created.reason.priceBasis, 'QUOTED');
    assert.equal(created.reason.competitorFactor, 1);
    assert.equal(Number(created.suggestedPrice), 30, 'unchanged: the raw 2nd-cheapest quote');
    assert.equal(created.reason.targetAllIn, 30);
  } finally { m.restore(); }
});

test('the flat per-day fee rides on both sides (the LAX vehicle licence fee)', async () => {
  const LAX = { connectionType: 'TITANIUM', taxes: [{ name: 'LA tax', pct: 9.75 }, { name: 'VLF', amountPerDay: 2 }], brokeragePct: 46.43 };
  const m = installMock({ offers: [offer('A', 40), offer('B', 50), offer('C', 60)], config: LAX });
  try {
    await evaluateRule(rule({ paddingPct: 0, rate: { id: 'rate1', rateCode: 'LAX_SFAR_DAILY', daily: 40, location: { code: 'LAX' } } }));
    const r = m.state.suggestionCreates[0].reason;
    assert.equal(r.competitorFlatPerDay, 2);
    assert.equal(r.targetAllIn, competitorAllIn(50, LAX), '50 x 1.0975 + 2');
    const base = Number(m.state.suggestionCreates[0].suggestedPrice);
    assert.equal(base, baseFromCustomerAllIn(r.targetAllIn, LAX));
  } finally { m.restore(); }
});

test('the floor and ceiling are BASE bounds and clamp the BASE, not the all-in', async () => {
  // The bug this pins: clamping an all-in number against a base bound compares
  // two different currencies. A $60 floor against a target that back-solves to
  // $31.56 must win, and the written number must be the floor itself.
  const m = installMock({ offers: [offer('A', 35), offer('B', 38.67), offer('C', 44)] });
  try {
    await evaluateRule(rule({ floorPrice: 60, ceilingPrice: 9999 }));
    const created = m.state.suggestionCreates[0];
    assert.equal(Number(created.suggestedPrice), 60);
    assert.ok(created.reason.guardrailsHit.includes('floor'));
  } finally { m.restore(); }
});

test('a rank against the all-in ladder is not the rank against quotes', async () => {
  // Why the whole change exists. Our base 37.90 grosses up to 55.53. Against
  // raw quotes (35 / 38.67 / 44) we look last by a mile; against what their
  // customers actually pay (42.70 / 47.18 / 53.68) we are one step above the
  // most expensive rival, not four.
  const quotes = [35, 38.67, 44];
  const ours = customerAllInFromBase(37.9, SJU);
  const worseThanAllQuotes = quotes.every((q) => ours > q);
  const allIn = quotes.map((q) => competitorAllIn(q, SJU));
  assert.equal(worseThanAllQuotes, true, 'against quotes we are dead last');
  assert.equal(ours > allIn[allIn.length - 1], true);
  assert.ok(ours - allIn[allIn.length - 1] < ours - quotes[quotes.length - 1],
    'but the true gap is far smaller than the quoted comparison implied');
});
