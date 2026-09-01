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
  publicPositionPayload, publicShuttleEntry, linkState, configVehicleIds,
  zoneCentroid, resolveWalkingDirections,
  watchKey, posKey, WATCH_TTL_S, POSITION_STALE_MS,
} from './shuttle-tracker-position.js';
import { parseIntakeConfig } from './shuttle-intake.js';
import { arrivalState, ARRIVAL_FRESH_MS } from './shuttle-zone-alerts.js';
import {
  custLocKey, CUSTOMER_LOC_TTL_S, parseStoredFix, publicLocationSharing,
} from './shuttle-customer-location.js';
import { OPEN_STATUSES } from './shuttle-query.js';

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

/** Re-arm the worker's fast-poll signal. Best-effort — never blocks the read.
 * Exported (2026-08-25, innovation P1): the STAFF monitor read must also arm
 * it — without this, an OneStepGPS-only tenant with no customer page open and
 * no open requests never polls, and the monitor stares at stale fixes. */
export async function signalWatch(tenantId) {
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
    let walkingDirectionsEs = '';
    let locationCompanyPhone = '';
    try {
      const parsed = location?.locationConfig ? JSON.parse(location.locationConfig) : null;
      pickupInstructions = parsed?.shuttlePickupInstructions || parsed?.pickupInstructions || '';
      // NEW #4 (2026-08-24, approved): sede-written "how to get there" text.
      // Static prose beside the pickup instructions — no routing engine.
      walkingDirections = parsed?.shuttleWalkingDirections || '';
      // Spanish variant (2026-08-25) — same JSON blob, new key.
      walkingDirectionsEs = parsed?.shuttleWalkingDirectionsEs || '';
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

    // NEW #2: the request-state status line comes from the EXISTING shuttle
    // request state machine — the latest request for THIS link's reservation.
    // Phase 3 reads two more columns off the same row: the manual assignment
    // and the id (the ephemeral-location Redis key).
    const lastRequest = await prisma.shuttleRequest.findFirst({
      where: { tenantId: link.tenantId, reservationId: link.reservationId },
      orderBy: { createdAt: 'desc' },
      select: { id: true, status: true, assignedVehicleId: true },
    }).catch(() => null);
    const requestOpen = !!lastRequest && OPEN_STATUSES.includes(lastRequest.status);
    // The assignment only steers the page while the request is OPEN and the
    // vehicle is still in the (ownership-re-verified) config list —
    // fail-closed to the old freshest-fix behavior on any doubt.
    const assignedVehicleId = requestOpen && lastRequest.assignedVehicleId && vehicleIds.includes(lastRequest.assignedVehicleId)
      ? lastRequest.assignedVehicleId
      : null;

    // Mode-aware read (Phase 3, Screens 8a/8b):
    //   NON_STOP    → every configured shuttle (the loop), single-position
    //                 keys keep showing the freshest for old pages;
    //   ON_DEMAND   → the assigned vehicle ONLY when one is pinned — a
    //                 customer with "Van 2 assigned to you" must never watch
    //                 Van 1's dot; otherwise the freshest, as before.
    let position = null;
    let loopShuttles = null;
    let fixesByVehicle = null;
    if (config.mode === 'NON_STOP') {
      fixesByVehicle = await latestPositionsByVehicle(vehicleIds);
      const all = Object.values(fixesByVehicle);
      position = all.length ? all.sort((a, b) => new Date(b.eventAt) - new Date(a.eventAt))[0] : null;
      loopShuttles = owned.map((v) => publicShuttleEntry({ vehicle: v, position: fixesByVehicle[v.id] || null }));
    } else if (assignedVehicleId) {
      position = await latestPosition([assignedVehicleId]);
    } else {
      position = await latestPosition(vehicleIds);
    }

    // Which van is the customer looking for? The assigned one wins; else the
    // one whose fix we are about to show; a single-vehicle config is
    // unambiguous even with no fix yet.
    const shownVehicleId = assignedVehicleId || position?.vehicleId || (vehicleIds.length === 1 ? vehicleIds[0] : null);
    const vehicle = shownVehicleId ? owned.find((v) => v.id === shownVehicleId) || null : null;

    // Phase 3 (Screen 9): the viewer's own sharing state. Distance is
    // computed HERE and only the distance crosses — the customer's
    // coordinates are never echoed back through the public payload.
    let locationSharing = { active: false, distanceMeters: null };
    if (requestOpen) {
      try {
        const custFix = await readCustomerLocation(lastRequest.id);
        if (custFix) {
          const fresh = (p) => {
            const at = p?.eventAt instanceof Date ? p.eventAt.getTime() : new Date(p?.eventAt || 0).getTime();
            return Number.isFinite(at) && Date.now() - at <= POSITION_STALE_MS;
          };
          const candidates = (fixesByVehicle ? Object.values(fixesByVehicle) : [position]).filter((p) => p && fresh(p));
          locationSharing = publicLocationSharing(custFix, candidates);
        }
      } catch { locationSharing = { active: false, distanceMeters: null }; }
    }

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

    // Phase 2 arrival (approved #21, mockup Screen 16): a fresh provider
    // ENTER on a pickup-spot zone at this location, not yet exited, lets the
    // page say "your shuttle has arrived". Read from OUR ShuttleAlert rows —
    // never the provider — and guarded whole: a rolling deploy whose old
    // Prisma client predates the table must not break the tracker.
    let arrival = { arrivedAtSpot: false, spotName: null };
    let spotZones = [];
    try {
      spotZones = await prisma.shuttleZone.findMany({
        where: { tenantId: link.tenantId, locationId: config.locationId, isPickupSpot: true, active: true },
        // geometryJson stays SERVER-SIDE: it feeds the centroid fallback below
        // and never crosses into the public payload (zoneCentroid → a single
        // lat/lng pair, same public-knowledge status as the counter address).
        select: { id: true, name: true, walkingDirections: true, walkingDirectionsEs: true, geometryJson: true },
      });
      if (spotZones.length) {
        const zoneById = new Map(spotZones.map((z) => [z.id, z]));
        const recent = await prisma.shuttleAlert.findMany({
          where: {
            tenantId: link.tenantId,
            zoneId: { in: spotZones.map((z) => z.id) },
            type: { in: ['ENTER', 'EXIT'] },
            occurredAt: { gte: new Date(Date.now() - ARRIVAL_FRESH_MS) },
            // Only the vehicles this page may show — an unrelated van of the
            // same tenant entering the lot is not "your shuttle".
            ...(vehicleIds.length ? { OR: [{ vehicleId: { in: vehicleIds } }, { vehicleId: null }] } : {}),
          },
          orderBy: { occurredAt: 'desc' },
          take: 10,
        });
        arrival = arrivalState(recent, zoneById);
      }
    } catch (err) {
      logger.warn('[shuttle-tracker] arrival lookup failed', { message: err.message });
    }

    // The read IS the demand signal for the fast poll.
    await signalWatch(link.tenantId);

    // The DESIGNATED spot: exactly one active pickup-spot zone — ambiguity
    // (zero or many) means no spot-level text and no centroid fallback.
    const designatedSpot = spotZones.length === 1 ? spotZones[0] : null;
    // Which text fills the walking keys (2026-08-25 fix): the designated
    // spot's own directions are PRIMARY at all times — the sede wrote them
    // FOR that spot — with the location-level config as the fallback; while
    // arrived, the arrived zone's text still wins (unchanged). Per language,
    // resolved in resolveWalkingDirections.
    const directions = resolveWalkingDirections({
      arrival, pickupSpot: designatedSpot,
      locationEn: walkingDirections, locationEs: walkingDirectionsEs,
    });

    return publicPositionPayload({
      position, config, location, pickupInstructions,
      walkingDirections: directions.en,
      walkingDirectionsEs: directions.es,
      brandName, counterPhone, vehicle,
      requestStatus: lastRequest?.status || null,
      arrivedAtSpot: arrival.arrivedAtSpot,
      arrivedSpotName: arrival.spotName,
      // Phase 3 additions — each individually whitelisted in the payload.
      assigned: !!assignedVehicleId,
      shuttles: loopShuttles,
      locationSharing,
      intake: parseIntakeConfig(config),
      pickupSpot: designatedSpot,
      // Null-Island fix (2026-08-25): a location with NULL/0 coordinates falls
      // back to the single spot's centroid instead of pinning (0,0).
      pickupFallback: designatedSpot ? zoneCentroid(designatedSpot.geometryJson) : null,
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

  /**
   * Resolution for the public location-sharing POST (Phase 3, Screen 9).
   * Same token chain as publicState — link ACTIVE, reservation and config in
   * the link's tenant, tracker not OFF — plus one more gate: an OPEN shuttle
   * request must exist for the reservation. Sharing is "only while you wait";
   * with nothing open there is nothing to attach a fix to, and the same bare
   * 404 keeps the token oracle silent. Works in BOTH modes: a cyclical-loop
   * customer waiting at a spot is exactly who the driver needs to find.
   */
  async publicLocationContext(token) {
    const clean = String(token || '').trim();
    if (!clean || clean.length < 16) return null;

    const link = await prisma.shuttleTrackerLink.findUnique({ where: { token: clean } });
    if (linkState(link) !== 'ACTIVE') return null;

    const reservation = await prisma.reservation.findUnique({
      where: { id: link.reservationId },
      select: { id: true, tenantId: true, pickupLocationId: true },
    });
    if (!reservation || reservation.tenantId !== link.tenantId) return null;

    const config = await prisma.shuttleTrackerConfig.findUnique({
      where: { locationId: reservation.pickupLocationId || '' },
    });
    if (!config || config.tenantId !== link.tenantId || config.mode === 'OFF') return null;

    const request = await prisma.shuttleRequest.findFirst({
      where: { tenantId: link.tenantId, reservationId: reservation.id, status: { in: OPEN_STATUSES } },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    });
    if (!request) return null;

    return { link, request };
  },
};

// ─── Ephemeral customer location (Phase 3, Screens 9/10) ────────────────────
// Redis ONLY — never a DB row, never a logged coordinate. Key = request id
// (a cuid, no PII), TTL refreshed on every push, deleted on any close. The
// optional redisOverride keeps these testable without a live Redis.

/** @returns {Promise<boolean>} stored (false = Redis off/unreachable) */
export async function storeCustomerLocation(requestId, { lat, lng }, redisOverride) {
  const redis = redisOverride !== undefined ? redisOverride : await getRedis();
  if (!redis || !requestId) return false;
  try {
    await redis.set(custLocKey(requestId), JSON.stringify({ lat, lng, at: Date.now() }), 'EX', CUSTOMER_LOC_TTL_S);
    return true;
  } catch {
    return false; // ephemeral by design — losing one push loses nothing durable
  }
}

/** @returns {Promise<{lat,lng,at}|null>} the fresh fix, or null */
export async function readCustomerLocation(requestId, redisOverride) {
  const redis = redisOverride !== undefined ? redisOverride : await getRedis();
  if (!redis || !requestId) return null;
  try {
    return parseStoredFix(await redis.get(custLocKey(requestId)));
  } catch {
    return null;
  }
}

/** Delete-on-state-change (close/cancel/no-show). TTL is the backstop. */
export async function clearCustomerLocation(requestId, redisOverride) {
  const redis = redisOverride !== undefined ? redisOverride : await getRedis();
  if (!redis || !requestId) return;
  try { await redis.del(custLocKey(requestId)); } catch { /* TTL reaps it */ }
}

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
