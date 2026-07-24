/**
 * DB-backed tests for GET /api/market/airports (2026-07-24). Requires DATABASE_URL.
 *
 * WHY THIS EXISTS: every airport picker in the Market Intelligence UI used to be
 * built from the tenant's `Location` rows, and the market endpoints key on
 * `MarketScrapeProfile.locationCode` — which is also the IATA code the scraper
 * puts in the Kayak URL. Those are not the same string. Corpusa's LAX branch is
 * coded `LAXA01` (a Rightcars station code), so the UI asked for
 * `?airport=LAXA01`, matched no profile, and rendered an empty dashboard while
 * 1,249 rows of LAX market data sat in the table. It only ever worked for the
 * first tenant because they happened to name their location `SJU`.
 *
 * CARES PROVEN HERE (each bites):
 *  1. the list comes from PROFILES, so a location whose code is not the airport
 *     code (LAXA01) still yields the code the data is actually under (LAX) —
 *     the exact bug.
 *  2. a location with NO scrape profile is not offered — you cannot select your
 *     way into a guaranteed-empty screen.
 *  3. INACTIVE profiles are excluded.
 *  4. tenant isolation: one tenant never sees another's airports.
 *  5. the cosmetic Location join is a nicety, not a requirement — a profile
 *     whose code matches no Location still comes back, labelled with the code.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';
import { marketObservationsService } from './market-observations.service.js';

const prisma = new PrismaClient();
const TAG = `MKTAIR-${Date.now()}`;
const ids = { tenantA: null, tenantB: null };

test.after(async () => {
  for (const t of [ids.tenantA, ids.tenantB]) {
    if (!t) continue;
    await prisma.marketScrapeProfile.deleteMany({ where: { tenantId: t } }).catch(() => {});
    await prisma.location.deleteMany({ where: { tenantId: t } }).catch(() => {});
    await prisma.tenant.delete({ where: { id: t } }).catch(() => {});
  }
  await prisma.$disconnect();
});

const profile = (tenantId, name, locationCode, active = true) => ({
  tenantId, name, locationCode, active,
  windowStartDay: 1, windowEndDay: 14, lorDays: 3,
  sources: ['KAYAK'],
});

test('setup: a tenant whose Location codes do NOT match its airport codes', async () => {
  const [a, b] = await Promise.all([
    prisma.tenant.create({ data: { name: `A ${TAG}`, slug: `a-${TAG}`.toLowerCase() } }),
    prisma.tenant.create({ data: { name: `B ${TAG}`, slug: `b-${TAG}`.toLowerCase() } }),
  ]);
  ids.tenantA = a.id; ids.tenantB = b.id;

  await Promise.all([
    // Station-code style, like Rightcars exports: the Location is LAXA01 but
    // the scraper (and therefore the data) lives under LAX.
    prisma.location.create({ data: { tenantId: a.id, code: 'LAXA01', name: 'Los Angeles', city: 'Los Angeles' } }),
    // A location with no scrape profile at all.
    prisma.location.create({ data: { tenantId: a.id, code: 'MIA', name: 'Miami', city: 'Miami' } }),
    // Codes line up here, so the cosmetic label join hits.
    prisma.location.create({ data: { tenantId: a.id, code: 'FLL', name: 'Fort Lauderdale', city: 'Fort Lauderdale' } }),
  ]);

  await prisma.marketScrapeProfile.createMany({
    data: [
      profile(a.id, `LAX 1-14 ${TAG}`, 'LAX'),
      profile(a.id, `LAX 15-29 ${TAG}`, 'LAX'),      // same airport, 2nd window
      profile(a.id, `FLL 1-14 ${TAG}`, 'FLL'),
      profile(a.id, `MCO retired ${TAG}`, 'MCO', false), // inactive
      profile(b.id, `SJU 1-14 ${TAG}`, 'SJU'),        // other tenant
    ],
  });
  assert.ok(ids.tenantA && ids.tenantB);
});

test('CARE 1 + 3 + 5: airports come from ACTIVE profiles, deduped, never from Location.code', async () => {
  const { airports } = await marketObservationsService.listMarketAirports({
    scope: { tenantId: ids.tenantA },
  });
  const codes = airports.map((a) => a.code);

  assert.deepEqual(codes, ['FLL', 'LAX'], 'sorted, deduped, inactive MCO excluded');
  assert.ok(!codes.includes('LAXA01'), 'the Location code is NOT what the UI must ask for — this is the bug');
  assert.ok(!codes.includes('MCO'), 'an inactive profile is not an offerable airport');
});

test('CARE 2: a Location with no scrape profile is never offered', async () => {
  const { airports } = await marketObservationsService.listMarketAirports({
    scope: { tenantId: ids.tenantA },
  });
  assert.ok(
    !airports.some((a) => a.code === 'MIA'),
    'MIA exists as a Location but has no profile — offering it would guarantee an empty dashboard'
  );
});

test('CARE 5: labels borrow the Location name when codes match, else fall back to the bare code', async () => {
  const { airports } = await marketObservationsService.listMarketAirports({
    scope: { tenantId: ids.tenantA },
  });
  const byCode = Object.fromEntries(airports.map((a) => [a.code, a.label]));
  assert.equal(byCode.FLL, 'FLL — Fort Lauderdale', 'codes line up → friendly label');
  assert.equal(byCode.LAX, 'LAX', 'no Location carries the code LAX → bare code, still usable');
});

test('CARE 4: tenant isolation — one tenant never sees another tenant airports', async () => {
  const a = await marketObservationsService.listMarketAirports({ scope: { tenantId: ids.tenantA } });
  const b = await marketObservationsService.listMarketAirports({ scope: { tenantId: ids.tenantB } });
  assert.ok(!a.airports.some((x) => x.code === 'SJU'), 'A must not see B airport');
  assert.deepEqual(b.airports.map((x) => x.code), ['SJU']);

  const denied = await marketObservationsService.listMarketAirports({
    scope: { tenantId: '__no_tenant__' },
  });
  assert.deepEqual(denied.airports, [], 'the deny-all sentinel yields nothing');
});
