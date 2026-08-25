/**
 * Shuttle tracker — the IO half. Decisions live in shuttle-tracker-position.js.
 *
 * ARCHITECTURE (Innovation, 2026-08-15): nothing above the worker imports the
 * VoltSwitch client. This service reads positions from Redis (written by the
 * worker's fast loop, or by the simulator) with a Postgres fallback on the
 * existing [vehicleId, eventAt desc] index. Because the API layer only reads
 * house storage, simulator data is indistinguishable from provider data —
 * which is what makes the whole feature buildable before the VoltSwitch
 * credentials arrive.
 *
 * The public GET is itself the demand signal: every call re-arms
 * shuttle:watch:<tenantId> with a 90s TTL, and the worker polls fast only
 * while that key exists. No session tracking, no "page opened" endpoint —
 * the signal maintains itself because the page polls.
 */
import { prisma } from '../../lib/prisma.js';
import logger from '../../lib/logger.js';
import {
  publicPositionPayload, linkState, configVehicleIds,
  watchKey, posKey, WATCH_TTL_S,
} from './shuttle-tracker-position.js';

const REDIS_URL = process.env.REDIS_URL || '';
let redisClient = null;
let redisLoading = null;
let redisDisabled = false;

/** Lazy ioredis, same shape as verify-probe-throttle. null = Redis off. */
async function getRedis() {
  if (redisClient) return redisClient;
  if (redisDisabled || !REDIS_URL) return null;
  if (redisLoading) return redisLoading;
  redisLoading = (async () => {
    try {
      const IORedis = await import('ioredis').then((m) => m.default || m);
      const client = new IORedis(REDIS_URL, { maxRetriesPerRequest: 1, enableReadyCheck: false, lazyConnect: false });
      client.on('error', (err) => logger.warn('[shuttle-tracker] redis error', { message: err.message }));
      redisClient = client;
      return client;
    } catch (err) {
      logger.warn('[shuttle-tracker] ioredis unavailable — falling back to Postgres reads', { message: err.message });
      redisDisabled = true;
      return null;
    } finally {
      redisLoading = null;
    }
  })();
  return redisLoading;
}

/**
 * Latest fix for any of the config's vehicles: Redis first, then Postgres.
 * Each fix carries its `vehicleId` (2026-08-24, tracker polish NEW #3): the
 * public payload names WHICH van to look for, so the read path must keep the
 * association instead of discarding it in the sort.
 */
async function latestPosition(vehicleIds) {
  if (!vehicleIds.length) return null;
  const redis = await getRedis();
  if (redis) {
    try {
      const raws = await Promise.all(vehicleIds.map((id) => redis.get(posKey(id))));
      const parsed = raws
        .map((raw, i) => {
          if (!raw) return null;
          try { return { ...JSON.parse(raw), vehicleId: vehicleIds[i] }; } catch { return null; }
        })
        .filter(Boolean);
      if (parsed.length) {
        return parsed.sort((a, b) => new Date(b.eventAt) - new Date(a.eventAt))[0];
      }
    } catch (err) {
      logger.warn('[shuttle-tracker] redis read failed, using db', { message: err.message });
    }
  }
  return prisma.vehicleTelematicsEvent.findFirst({
    where: { vehicleId: { in: vehicleIds } },
    orderBy: { eventAt: 'desc' },
    select: { vehicleId: true, latitude: true, longitude: true, heading: true, speedMph: true, eventAt: true },
  });
}

/**
 * Latest fix PER vehicle — the Staff Shuttle Monitor's read (2026-08-24).
 * Same house path as latestPosition (Redis fix written by the fast poll or
 * the simulator, Postgres fallback on the [vehicleId, eventAt desc] index);
 * deliberately NOT a provider call — the monitor reads what the worker wrote.
 *
 * @returns {Promise<Record<string, object>>} vehicleId → fix (missing key = no fix ever)
 */
export async function latestPositionsByVehicle(vehicleIds) {
  const ids = (vehicleIds || []).filter(Boolean);
  const out = {};
  if (!ids.length) return out;
  const redis = await getRedis();
  const missing = [];
  if (redis) {
    try {
      const raws = await Promise.all(ids.map((id) => redis.get(posKey(id))));
      raws.forEach((raw, i) => {
        if (!raw) { missing.push(ids[i]); return; }
        try { out[ids[i]] = { ...JSON.parse(raw), vehicleId: ids[i] }; } catch { missing.push(ids[i]); }
      });
    } catch (err) {
      logger.warn('[shuttle-tracker] redis read failed, using db', { message: err.message });
      missing.push(...ids.filter((id) => !(id in out)));
    }
  } else {
    missing.push(...ids);
  }
  if (missing.length) {
    // distinct-per-vehicle on the existing [vehicleId, eventAt desc] index.
    const rows = await prisma.vehicleTelematicsEvent.findMany({
      where: { vehicleId: { in: missing } },
      orderBy: [{ vehicleId: 'asc' }, { eventAt: 'desc' }],
      distinct: ['vehicleId'],
      select: { vehicleId: true, latitude: true, longitude: true, heading: true, speedMph: true, eventAt: true },
    });
    for (const row of rows) out[row.vehicleId] = row;
  }
  return out;
}

/** Re-arm the worker's fast-poll signal. Best-effort — never blocks the read. */
async function signalWatch(tenantId) {
  const redis = await getRedis();
  if (!redis) return;
  try { await redis.set(watchKey(tenantId), '1', 'EX', WATCH_TTL_S); } catch { /* signal only */ }
}

export const shuttleTrackerService = {
  /**
   * Everything the public page needs, from one token. Returns null when the
   * token is unusable — the route turns that into a 404 with no detail,
   * because an unauthenticated caller learns nothing from WHY.
   */
  async publicState(token) {
    const clean = String(token || '').trim();
    if (!clean || clean.length < 16) return null;

    const link = await prisma.shuttleTrackerLink.findUnique({ where: { token: clean } });
    if (linkState(link) !== 'ACTIVE') return null;

    const reservation = await prisma.reservation.findUnique({
      where: { id: link.reservationId },
      select: { pickupLocationId: true, tenantId: true },
    });
    if (!reservation || reservation.tenantId !== link.tenantId) return null;

    const config = await prisma.shuttleTrackerConfig.findUnique({
      where: { locationId: reservation.pickupLocationId || '' },
    });
    if (!config || config.tenantId !== link.tenantId || config.mode === 'OFF') return null;

    const location = await prisma.location.findUnique({
      where: { id: config.locationId },
      select: { name: true, locationConfig: true, latitude: true, longitude: true },
    });

    let pickupInstructions = '';
    let walkingDirections = '';
    let locationCompanyPhone = '';
    try {
      const parsed = location?.locationConfig ? JSON.parse(location.locationConfig) : null;
      pickupInstructions = parsed?.shuttlePickupInstructions || parsed?.pickupInstructions || '';
      // NEW #4 (2026-08-24, approved): sede-written "how to get there" text.
      // Static prose beside the pickup instructions — no routing engine.
      walkingDirections = parsed?.shuttleWalkingDirections || '';
      // The branch's own phone first (Settings → "Location Phone"), then the
      // agreement-config companyPhone some branches use instead.
      locationCompanyPhone = parsed?.locationPhone || parsed?.companyPhone || '';
    } catch { pickupInstructions = ''; }

    // Ownership is re-verified on EVERY read, not just when the config was
    // saved (QA, 2026-08-15): a super can transfer a vehicle across tenants,
    // and a config holding the stale id would otherwise stream the NEW
    // tenant's GPS to the old tenant's public links.
    const configuredIds = configVehicleIds(config);
    const owned = configuredIds.length
      ? await prisma.vehicle.findMany({
        where: { id: { in: configuredIds }, tenantId: link.tenantId },
        // make/model/color/plate feed the DELIBERATE public whitelist (NEW #3)
        // — publicPositionPayload picks from them; the row never crosses.
        select: { id: true, make: true, model: true, color: true, plate: true },
      })
      : [];
    const vehicleIds = owned.map((v) => v.id);
    const position = await latestPosition(vehicleIds);

    // Which van is the customer looking for? The one whose fix we are about
    // to show; a single-vehicle config is unambiguous even with no fix yet.
    const shownVehicleId = position?.vehicleId || (vehicleIds.length === 1 ? vehicleIds[0] : null);
    const vehicle = shownVehicleId ? owned.find((v) => v.id === shownVehicleId) || null : null;

    // NEW #2: the request-state status line comes from the EXISTING shuttle
    // request state machine — the latest request for THIS link's reservation.
    const lastRequest = await prisma.shuttleRequest.findFirst({
      where: { tenantId: link.tenantId, reservationId: link.reservationId },
      orderBy: { createdAt: 'desc' },
      select: { status: true },
    }).catch(() => null);

    // NEW #1 + #5: tenant brand + counter phone. Brand goes through the
    // customer-facing cascade (never the platform's name); the phone follows
    // the same locCfg → global rule the check-in emails use, with the
    // settings placeholder default filtered out — "(787) 000-0000" is the
    // absence of an answer, not a number to call from a curb.
    let brandName = null;
    let counterPhone = null;
    try {
      const { settingsService } = await import('../settings/settings.service.js');
      const globalCfg = await settingsService.getRentalAgreementConfig({ tenantId: link.tenantId });
      const { resolveCustomerFacingBrand } = await import('../../lib/tenant-brand.js');
      const brand = await resolveCustomerFacingBrand({
        tenantId: link.tenantId,
        location,
        globalConfig: globalCfg,
      });
      brandName = brand?.companyName || null;
      const phone = String(locationCompanyPhone || globalCfg?.companyPhone || '').trim();
      counterPhone = phone && phone !== '(787) 000-0000' ? phone : null;
    } catch (err) {
      // Branding/phone must never break the tracker itself.
      logger.warn('[shuttle-tracker] brand/phone resolution failed', { message: err.message });
    }

    // The read IS the demand signal for the fast poll.
    await signalWatch(link.tenantId);

    return publicPositionPayload({
      position, config, location, pickupInstructions,
      walkingDirections, brandName, counterPhone, vehicle,
      requestStatus: lastRequest?.status || null,
    });
  },

  /**
   * Resolution for the public "request the shuttle" POST. Same chain as
   * publicState with one extra gate: the mode must be ON_DEMAND — a NON_STOP
   * loop has no request button, and a token for one must not grow that power
   * just because someone crafts the POST by hand.
   *
   * IDENTITY COMES FROM THE TOKEN, never from the request body: the name and
   * phone on the resulting ShuttleRequest are the reservation's own. A caller
   * holding a leaked token can summon a bus to the location it already serves
   * — annoying — but cannot impersonate a different customer or inject text
   * into the agents' queue.
   */
  async publicRequestContext(token) {
    const clean = String(token || '').trim();
    if (!clean || clean.length < 16) return null;

    const link = await prisma.shuttleTrackerLink.findUnique({ where: { token: clean } });
    if (linkState(link) !== 'ACTIVE') return null;

    const reservation = await prisma.reservation.findUnique({
      where: { id: link.reservationId },
      select: {
        id: true, tenantId: true, pickupLocationId: true, reservationNumber: true,
        customer: { select: { firstName: true, lastName: true, phone: true } },
      },
    });
    if (!reservation || reservation.tenantId !== link.tenantId) return null;

    const config = await prisma.shuttleTrackerConfig.findUnique({
      where: { locationId: reservation.pickupLocationId || '' },
    });
    if (!config || config.tenantId !== link.tenantId || config.mode !== 'ON_DEMAND') return null;

    return { link, reservation, config };
  },
};

/** Worker/simulator write path: publish a fix to Redis beside the DB row. */
export async function publishPosition(vehicleId, fix) {
  const redis = await getRedis();
  if (!redis) return;
  try {
    await redis.set(posKey(vehicleId), JSON.stringify(fix), 'EX', 300);
  } catch { /* the DB row is the durable copy */ }
}

/** Worker read path: which tenants have someone watching right now? */
export async function isWatched(tenantId) {
  const redis = await getRedis();
  if (!redis) return true; // no Redis = no signal — poll rather than go dark
  try { return (await redis.exists(watchKey(tenantId))) === 1; } catch { return true; }
}
