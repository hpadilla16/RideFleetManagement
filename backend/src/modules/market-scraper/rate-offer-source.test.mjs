import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  offerToObservationRow,
  loadCompetitorRows,
  kayakAllInConfirmed,
  sourceAllInConfirmed
} from './rate-offer-source.js';

// The adapter takes the prisma client as a parameter, so these tests pass a
// fake client instead of monkey-patching the shared prisma instance (same
// mock-prisma spirit as the other market suites, minus the global mutation).
function fakeClient({ offers = [], observations = [] } = {}) {
  const calls = { offerWhere: null, obsWhere: null };
  return {
    calls,
    rateOffer: {
      findMany: async (args = {}) => { calls.offerWhere = args.where || null; return offers; }
    },
    marketObservation: {
      findMany: async (args = {}) => { calls.obsWhere = args.where || null; return observations; }
    }
  };
}

function makeOffer(over = {}) {
  return {
    id: 'offer-1',
    runId: 'run-1',
    profileId: 'profile-1',
    observedAt: new Date('2026-07-02T08:00:00Z'),
    source: 'KAYAK',
    provider: 'Priceline',
    supplier: 'Hertz',
    pickupDate: new Date('2026-07-10'),
    returnDate: new Date('2026-07-13'),
    lorDays: 3,
    sipp: 'ECAR',
    rawCategory: 'Economy',
    carExample: 'Kia Rio or similar',
    dailyPrice: 24.5,
    totalPrice: 73.5,
    effectiveDailyPrice: 24.5,
    currency: 'USD',
    status: 'FOUND',
    ...over
  };
}

function makeObs(over = {}) {
  return {
    id: 'obs-1',
    runId: 'run-1',
    profileId: 'profile-1',
    observedAt: new Date('2026-06-28T08:00:00Z'),
    pickupDate: new Date('2026-07-10'),
    returnDate: new Date('2026-07-13'),
    lorDays: 3,
    sipp: 'ECAR',
    rawCategory: 'Economy',
    vendor: 'Hertz',
    source: 'EXPEDIA',
    dailyPrice: 22,
    totalPrice: 90,
    effectiveDailyPrice: 30,
    status: 'FOUND',
    ...over
  };
}

// Env hygiene: the gate reads KAYAK_EFFECTIVE_IS_ALL_IN at call time.
const ENV_KEY = 'KAYAK_EFFECTIVE_IS_ALL_IN';
afterEach(() => { delete process.env[ENV_KEY]; });

// ----- offerToObservationRow ----------------------------------------------

describe('offerToObservationRow', () => {
  it('maps a RateOffer to the observation shape (vendor = supplier, provider/source carried)', () => {
    const offer = makeOffer();
    const row = offerToObservationRow(offer);
    assert.deepEqual(row, {
      id: 'offer-1',
      vendor: 'Hertz',
      sipp: 'ECAR',
      rawCategory: 'Economy',
      dailyPrice: 24.5,
      effectiveDailyPrice: 24.5,
      totalPrice: 73.5,
      lorDays: 3,
      pickupDate: offer.pickupDate,
      returnDate: offer.returnDate,
      observedAt: offer.observedAt,
      status: 'FOUND',
      provider: 'Priceline',
      source: 'KAYAK',
      runId: 'run-1',
      profileId: 'profile-1'
    });
  });
});

// ----- kayakAllInConfirmed --------------------------------------------------

describe('kayakAllInConfirmed', () => {
  it('defaults to false (unset / anything but the literal "true")', () => {
    delete process.env[ENV_KEY];
    assert.equal(kayakAllInConfirmed(), false);
    process.env[ENV_KEY] = '1';
    assert.equal(kayakAllInConfirmed(), false);
    process.env[ENV_KEY] = 'TRUE';
    assert.equal(kayakAllInConfirmed(), false);
  });

  it('returns true only for the literal "true"', () => {
    process.env[ENV_KEY] = 'true';
    assert.equal(kayakAllInConfirmed(), true);
  });
});

// ----- sourceAllInConfirmed (all-in ALLOWLIST, 2026-09-02) ------------------

describe('sourceAllInConfirmed', () => {
  it('EXPEDIA_DIRECT and CARRENTALS are confirmed all-in regardless of env', () => {
    delete process.env[ENV_KEY];
    assert.equal(sourceAllInConfirmed('EXPEDIA_DIRECT'), true);
    assert.equal(sourceAllInConfirmed('CARRENTALS'), true);
  });

  it('KAYAK follows KAYAK_EFFECTIVE_IS_ALL_IN (unchanged semantics)', () => {
    delete process.env[ENV_KEY];
    assert.equal(sourceAllInConfirmed('KAYAK'), false);
    process.env[ENV_KEY] = 'true';
    assert.equal(sourceAllInConfirmed('KAYAK'), true);
  });

  it('a source NOT in the allowlist defaults to NOT confirmed — even with the Kayak env flipped', () => {
    process.env[ENV_KEY] = 'true';
    for (const s of ['SOMETHING_NEW', 'SKYSCANNER', '', null, undefined]) {
      assert.equal(sourceAllInConfirmed(s), false, `source ${String(s)} must not be pricing-eligible`);
    }
  });
});

// ----- loadCompetitorRows ---------------------------------------------------

describe('loadCompetitorRows — merge + legacy defaults', () => {
  it('merges offers with legacy observations; legacy rows get provider Expedia / source EXPEDIA_DIRECT', async () => {
    const client = fakeClient({
      offers: [makeOffer({ provider: 'Priceline', supplier: 'Sixt', dailyPrice: 30 })],
      observations: [makeObs({ vendor: 'Avis' })]
    });
    const { rows } = await loadCompetitorRows(client, { runId: 'run-1' }, { purpose: 'display' });
    assert.equal(rows.length, 2);
    const legacy = rows.find((r) => r.vendor === 'Avis');
    assert.equal(legacy.provider, 'Expedia');
    assert.equal(legacy.source, 'EXPEDIA_DIRECT');
    const offer = rows.find((r) => r.vendor === 'Sixt');
    assert.equal(offer.provider, 'Priceline');
    assert.equal(offer.source, 'KAYAK');
  });

  it('applies equivalent DB filters to both tables (status FOUND + non-null price)', async () => {
    const client = fakeClient();
    await loadCompetitorRows(client, { runId: 'run-9' }, { purpose: 'display' });
    assert.equal(client.calls.obsWhere.runId, 'run-9');
    assert.equal(client.calls.obsWhere.status, 'FOUND');
    assert.deepEqual(client.calls.obsWhere.dailyPrice, { not: null });
    assert.equal(client.calls.offerWhere.runId, 'run-9');
    assert.equal(client.calls.offerWhere.status, 'FOUND');
    // Offers may carry only effectiveDailyPrice (Kayak), hence the OR.
    assert.deepEqual(client.calls.offerWhere.OR, [
      { dailyPrice: { not: null } },
      { effectiveDailyPrice: { not: null } }
    ]);
  });

  it('sorts merged rows by pickupDate, then sipp', async () => {
    const client = fakeClient({
      offers: [makeOffer({ pickupDate: new Date('2026-07-09'), sipp: 'SFAR' })],
      observations: [
        makeObs({ pickupDate: new Date('2026-07-10'), sipp: 'ECAR' }),
        makeObs({ id: 'obs-2', pickupDate: new Date('2026-07-09'), sipp: 'CCAR', vendor: 'Budget' })
      ]
    });
    const { rows } = await loadCompetitorRows(client, {}, { purpose: 'display' });
    assert.deepEqual(rows.map((r) => `${r.pickupDate.toISOString().slice(0, 10)}|${r.sipp}`), [
      '2026-07-09|CCAR', '2026-07-09|SFAR', '2026-07-10|ECAR'
    ]);
  });
});

describe('loadCompetitorRows — anonymous supplier exclusion', () => {
  it('excludes offers with supplier === "" and counts them in totals.anonymousOffers', async () => {
    const client = fakeClient({
      offers: [
        makeOffer({ id: 'o1', supplier: '' }),
        makeOffer({ id: 'o2', supplier: '', provider: 'EconomyBookings' }),
        makeOffer({ id: 'o3', supplier: 'Dollar' })
      ]
    });
    const { rows, totals } = await loadCompetitorRows(client, {}, { purpose: 'display' });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].vendor, 'Dollar');
    assert.equal(totals.anonymousOffers, 2);
  });
});

describe('loadCompetitorRows — Expedia-channel precedence dedup', () => {
  it('drops the Kayak-relayed Expedia quote when a direct-Expedia OFFER exists for the same (pickupDate, sipp, supplier)', async () => {
    const client = fakeClient({
      offers: [
        makeOffer({ id: 'direct', source: 'EXPEDIA_DIRECT', provider: 'Expedia', supplier: 'Hertz', dailyPrice: 25 }),
        makeOffer({ id: 'relay', source: 'KAYAK', provider: 'Expedia', supplier: 'Hertz', dailyPrice: 24 })
      ]
    });
    const { rows } = await loadCompetitorRows(client, {}, { purpose: 'display' });
    assert.deepEqual(rows.map((r) => r.id), ['direct']);
  });

  it('legacy observations count as direct-Expedia for the dedup (supplier matched via vendorKey)', async () => {
    const client = fakeClient({
      offers: [makeOffer({ id: 'relay', source: 'KAYAK', provider: 'Expedia', supplier: 'ACE Rent A Car' })],
      observations: [makeObs({ id: 'legacy', vendor: 'ACE' })]
    });
    const { rows } = await loadCompetitorRows(client, {}, { purpose: 'display' });
    assert.deepEqual(rows.map((r) => r.id), ['legacy']);
  });

  it('keeps the Kayak-Expedia quote when the direct row is a different supplier, date or sipp', async () => {
    const client = fakeClient({
      offers: [
        makeOffer({ id: 'relay-other-supplier', source: 'KAYAK', provider: 'Expedia', supplier: 'Sixt' }),
        makeOffer({ id: 'relay-other-date', source: 'KAYAK', provider: 'Expedia', supplier: 'Hertz', pickupDate: new Date('2026-07-11') })
      ],
      observations: [makeObs({ vendor: 'Hertz', pickupDate: new Date('2026-07-10') })]
    });
    const { rows } = await loadCompetitorRows(client, {}, { purpose: 'display' });
    assert.equal(rows.length, 3);
  });

  it('does not touch non-Expedia Kayak providers (Priceline via Kayak survives)', async () => {
    const client = fakeClient({
      offers: [makeOffer({ id: 'priceline', source: 'KAYAK', provider: 'Priceline', supplier: 'Hertz' })],
      observations: [makeObs({ vendor: 'Hertz' })]
    });
    const { rows } = await loadCompetitorRows(client, {}, { purpose: 'display' });
    assert.equal(rows.length, 2);
  });
});

describe('loadCompetitorRows — pricing gate (KAYAK_EFFECTIVE_IS_ALL_IN)', () => {
  const mixed = () => fakeClient({
    offers: [
      makeOffer({ id: 'kayak-priceline', source: 'KAYAK', provider: 'Priceline', supplier: 'Sixt' }),
      makeOffer({ id: 'kayak-expedia', source: 'KAYAK', provider: 'Expedia', supplier: 'Dollar' }),
      makeOffer({ id: 'direct', source: 'EXPEDIA_DIRECT', provider: 'Expedia', supplier: 'Thrifty' }),
      makeOffer({ id: 'carrentals', source: 'CARRENTALS', provider: 'CarRentals', supplier: 'Fox' })
    ],
    observations: [makeObs({ id: 'legacy', vendor: 'Avis' })]
  });

  it('purpose=pricing with env unset EXCLUDES every KAYAK-source row (teaser protection for the live AUTO rules)', async () => {
    delete process.env[ENV_KEY];
    const { rows } = await loadCompetitorRows(mixed(), {}, { purpose: 'pricing' });
    assert.deepEqual(rows.map((r) => r.id).sort(), ['carrentals', 'direct', 'legacy']);
  });

  it('purpose=pricing with KAYAK_EFFECTIVE_IS_ALL_IN=true includes KAYAK rows', async () => {
    process.env[ENV_KEY] = 'true';
    const { rows } = await loadCompetitorRows(mixed(), {}, { purpose: 'pricing' });
    assert.deepEqual(rows.map((r) => r.id).sort(),
      ['carrentals', 'direct', 'kayak-expedia', 'kayak-priceline', 'legacy']);
  });

  it('EXPEDIA_DIRECT and CARRENTALS are never gated for pricing', async () => {
    delete process.env[ENV_KEY];
    const client = fakeClient({
      offers: [
        makeOffer({ id: 'direct', source: 'EXPEDIA_DIRECT', provider: 'Expedia', supplier: 'Thrifty' }),
        makeOffer({ id: 'carrentals', source: 'CARRENTALS', provider: 'CarRentals', supplier: 'Fox' })
      ]
    });
    const { rows } = await loadCompetitorRows(client, {}, { purpose: 'pricing' });
    assert.equal(rows.length, 2);
  });

  it('purpose=display always includes KAYAK rows (env unset)', async () => {
    delete process.env[ENV_KEY];
    const { rows } = await loadCompetitorRows(mixed(), {}, { purpose: 'display' });
    assert.deepEqual(rows.map((r) => r.id).sort(),
      ['carrentals', 'direct', 'kayak-expedia', 'kayak-priceline', 'legacy']);
  });

  it('UNKNOWN source rows reach display but NEVER pricing (poison-source protection)', async () => {
    const client = () => fakeClient({
      offers: [
        makeOffer({ id: 'mystery', source: 'SOMETHING_NEW', provider: 'NewOTA', supplier: 'Hertz' }),
        makeOffer({ id: 'direct', source: 'EXPEDIA_DIRECT', provider: 'Expedia', supplier: 'Thrifty' })
      ]
    });
    // Display: labelable, so the unknown source is shown.
    delete process.env[ENV_KEY];
    const { rows: display } = await loadCompetitorRows(client(), {}, { purpose: 'display' });
    assert.deepEqual(display.map((r) => r.id).sort(), ['direct', 'mystery']);
    // Pricing: excluded with the Kayak env unset...
    const { rows: pricing } = await loadCompetitorRows(client(), {}, { purpose: 'pricing' });
    assert.deepEqual(pricing.map((r) => r.id), ['direct']);
    // ...and STILL excluded when Kayak is confirmed all-in — the allowlist is
    // per-source; confirming one source never opens the door for another.
    process.env[ENV_KEY] = 'true';
    const { rows: pricingEnvOn } = await loadCompetitorRows(client(), {}, { purpose: 'pricing' });
    assert.deepEqual(pricingEnvOn.map((r) => r.id), ['direct']);
  });

  it('FAIL-CLOSED: missing/unknown purpose defaults to pricing (Kayak excluded)', async () => {
    delete process.env[ENV_KEY];
    // No opts at all — a forgetful future caller must land on the SAFE side.
    const { rows: noOpts } = await loadCompetitorRows(mixed(), {});
    assert.ok(!noOpts.some((r) => r.source === 'KAYAK'), 'no-opts caller must not receive Kayak teaser rows');
    // Typoed purpose — same protection.
    const { rows: typo } = await loadCompetitorRows(mixed(), {}, { purpose: 'dsiplay' });
    assert.ok(!typo.some((r) => r.source === 'KAYAK'), 'unknown purpose must not receive Kayak teaser rows');
  });
});

// ── Provider filter (2026-07-29) ───────────────────────────────────────────
// Narrows the DISPLAY pool to specific OTAs. Must never fire unless the caller
// passes providers, so the pricing path keeps seeing every OTA and the
// per-agency ladder is unchanged.
describe('providers filter', () => {
  const offers = [
    { id: '1', supplier: 'Hertz', provider: 'Priceline', source: 'KAYAK', status: 'FOUND', dailyPrice: 40, effectiveDailyPrice: 40, pickupDate: new Date('2026-08-01'), sipp: 'CCAR' },
    { id: '2', supplier: 'Hertz', provider: 'Booking.com', source: 'KAYAK', status: 'FOUND', dailyPrice: 38, effectiveDailyPrice: 38, pickupDate: new Date('2026-08-01'), sipp: 'CCAR' },
    { id: '3', supplier: 'Sixt', provider: 'EconomyBookings', source: 'KAYAK', status: 'FOUND', dailyPrice: 55, effectiveDailyPrice: 55, pickupDate: new Date('2026-08-01'), sipp: 'CCAR' }
  ];

  it('keeps only the named OTAs, case-insensitively', async () => {
    const client = fakeClient({ offers });
    const { rows } = await loadCompetitorRows(client, { providers: ['booking.COM', 'EconomyBookings'] }, { purpose: 'display' });
    assert.deepEqual(rows.map((r) => r.provider).sort(), ['Booking.com', 'EconomyBookings']);
  });

  it('no providers key = every OTA (pricing path is never narrowed)', async () => {
    const client = fakeClient({ offers });
    const { rows } = await loadCompetitorRows(client, {}, { purpose: 'display' });
    assert.equal(rows.length, 3);
  });

  it('an empty list means "no filter", not "nothing"', async () => {
    const client = fakeClient({ offers });
    const { rows } = await loadCompetitorRows(client, { providers: [] }, { purpose: 'display' });
    assert.equal(rows.length, 3);
  });
});
