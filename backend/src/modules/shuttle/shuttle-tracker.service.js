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

/** Latest fix for any of the config's vehicles: Redis first, then Postgres. */
async function latestPosition(vehicleIds) {
  if (!vehicleIds.length) return null;
  const redis = await getRedis();
  if (redis) {
    try {
      const raws = await Promise.all(vehicleIds.map((id) => redis.get(posKey(id))));
      const parsed = raws.filter(Boolean).map((raw) => { try { return JSON.parse(raw); } catch { return null; } }).filter(Boolean);
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
    select: { latitude: true, longitude: true, heading: true, speedMph: true, eventAt: true },
  });
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
    try {
      const parsed = location?.locationConfig ? JSON.parse(location.locationConfig) : null;
      pickupInstructions = parsed?.shuttlePickupInstructions || parsed?.pickupInstructions || '';
    } catch { pickupInstructions = ''; }

    // Ownership is re-verified on EVERY read, not just when the config was
    // saved (QA, 2026-08-15): a super can transfer a vehicle across tenants,
    // and a config holding the stale id would otherwise stream the NEW
    // tenant's GPS to the old tenant's public links.
    const configuredIds = configVehicleIds(config);
    const owned = configuredIds.length
      ? await prisma.vehicle.findMany({
        where: { id: { in: configuredIds }, tenantId: link.tenantId },
        select: { id: true },
      })
      : [];
    const vehicleIds = owned.map((v) => v.id);
    const position = await latestPosition(vehicleIds);

    // The read IS the demand signal for the fast poll.
    await signalWatch(link.tenantId);

    return publicPositionPayload({ position, config, location, pickupInstructions });
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
