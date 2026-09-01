/**
 * Shuttle fast poll — the ONLY file above the provider clients allowed to
 * import them. Everything else (public API, page, simulator) reads house
 * storage, which is what makes the feature buildable and demo-able before
 * the VoltSwitch credentials arrive.
 *
 * DEMAND-DRIVEN (Innovation, 2026-08-15): polls a tenant's shuttle vehicles
 * fast ONLY while someone is watching — the public GET re-arms
 * shuttle:watch:<tenantId> (TTL 90s) on every call — or while an OPEN
 * shuttle request exists. Nobody watching and nothing pending: zero provider
 * calls from this loop; the ordinary tenant sync remains the slow baseline.
 * At the fast cadence that is ~4 calls/min per shuttle, only while a page is
 * actually open.
 *
 * PROVIDER-AWARE (2026-08-24): the tenant's shuttle vehicles may carry
 * VehicleTelematicsDevice rows from either provider. VOLTSWITCH rows go
 * through the original per-device path unchanged. ONESTEPGPS rows are served
 * by ONE bulk device-info call per tenant tick (the API returns every device
 * in a single response — cheaper than per-device, and kind to its
 * undocumented rate limits), filtered to the mapped externalDeviceIds. Both
 * publish through the SAME house write path: a VehicleTelematicsEvent row +
 * publishPosition to Redis. Readiness gates keep unconfigured tenants
 * zero-cost: VoltSwitch behind tcfg.voltswitchConnectorReady, OneStepGPS
 * behind a stored API key (hasApiKey). Each provider branch fails in
 * isolation — one connector down must not blind the other.
 *
 * House scheduler rules apply (2026-08-08 incident): overlap guard, every
 * provider call timeout-bounded, per-tenant failure isolation.
 */
import { prisma } from '../../lib/prisma.js';
import logger from '../../lib/logger.js';
import { withTimeout } from '../../lib/with-timeout.js';
import { settingsService } from '../settings/settings.service.js';
import {
  authenticate as voltswitchAuth,
  getDeviceLocation,
} from '../vehicles/telematics-voltswitch.js';
import {
  hasApiKey as onestepgpsHasApiKey,
  getDevicesWithPositions as onestepgpsGetDevicesWithPositions,
} from '../vehicles/telematics-onestepgps.js';
import { configVehicleIds } from './shuttle-tracker-position.js';
import { publishPosition, isWatched } from './shuttle-tracker.service.js';

const TICK_MS = Math.max(10 * 1000, parseInt(process.env.SHUTTLE_FAST_POLL_MS || String(15 * 1000), 10) || 15 * 1000);
const CALL_TIMEOUT_MS = 10 * 1000;

let timerHandle = null;
let running = false;

/** The house write path: DB row (best-effort) + Redis fix, identical for every provider. */
// Last WRITTEN device-time per vehicle (innovation P2, 2026-08-25): a stalled
// device keeps returning the same latest point every tick — without this memo
// that's ~4 duplicate rows/min until STALE, and thousands/day on a watched
// shuttle. In-memory is enough: this scheduler runs only in the single worker
// process, and a restart merely rewrites one row. `null` eventAt fixes always
// write (no device time to compare).
const lastWrittenEventAt = new Map();

/** Test seam: the memo is process-lifetime by design; suites that replay the
 * same fixture fixes across cases reset it between tests. */
export function __resetWriteMemoForTests() { lastWrittenEventAt.clear(); }

async function writeFix(deps, tenantId, vehicleId, fix) {
  const eventAt = fix.eventAt ? new Date(fix.eventAt) : new Date();
  if (fix.eventAt) {
    const iso = eventAt.toISOString();
    if (lastWrittenEventAt.get(vehicleId) === iso) return false; // unchanged fix
    lastWrittenEventAt.set(vehicleId, iso);
  }
  await deps.prisma.vehicleTelematicsEvent.create({
    data: {
      tenantId,
      vehicleId,
      eventType: 'PING',
      eventAt,
      latitude: fix.latitude,
      longitude: fix.longitude,
      speedMph: fix.speedMph,
      heading: fix.heading,
      payloadJson: JSON.stringify({ source: 'SHUTTLE_FAST_POLL' }),
    },
  }).catch(() => {}); // Redis still gets the fix; the row is best-effort
  await deps.publishPosition(vehicleId, {
    latitude: fix.latitude, longitude: fix.longitude,
    heading: fix.heading, speedMph: fix.speedMph,
    eventAt: eventAt.toISOString(),
  });
  return true;
}

function defaultDeps() {
  return {
    prisma,
    logger,
    settingsService,
    isWatched,
    publishPosition,
    voltswitch: { authenticate: voltswitchAuth, getDeviceLocation },
    onestepgps: {
      hasApiKey: onestepgpsHasApiKey,
      getDevicesWithPositions: onestepgpsGetDevicesWithPositions,
    },
  };
}

/** One tenant's poll. Deps injectable for tests; production passes none. */
export async function pollTenant(config, depsOverride = {}) {
  const deps = { ...defaultDeps(), ...depsOverride };
  const { tenantId } = config;

  // Demand check first — the whole point is not calling the provider when
  // nobody is looking.
  const watched = await deps.isWatched(tenantId);
  if (!watched) {
    const openRequests = await deps.prisma.shuttleRequest.count({
      where: { tenantId, locationId: config.locationId, status: { in: ['READY', 'VIEWED'] } },
    });
    if (openRequests === 0) return { polled: 0, skipped: true };
  }

  const vehicleIds = configVehicleIds(config);
  if (!vehicleIds.length) return { polled: 0, skipped: true };

  const devices = await deps.prisma.vehicleTelematicsDevice.findMany({
    where: { provider: { in: ['VOLTSWITCH', 'ONESTEPGPS'] }, isActive: true, vehicleId: { in: vehicleIds } },
    select: { vehicleId: true, externalDeviceId: true, provider: true },
  });
  if (!devices.length) return { polled: 0, skipped: true };

  const voltDevices = devices.filter((d) => d.provider === 'VOLTSWITCH');
  const onestepDevices = devices.filter((d) => d.provider === 'ONESTEPGPS');
  let polled = 0;

  // ── VoltSwitch: per-device reads, exactly the original path ──────────────
  if (voltDevices.length) {
    try {
      const tcfg = await deps.settingsService.getTelematicsConfig({ tenantId }, { includeSecret: true });
      if (tcfg.voltswitchConnectorReady) {
        const session = await deps.voltswitch.authenticate({
          username: tcfg.voltswitchApiEmail,
          password: tcfg.voltswitchApiPassword,
          tenantId: `shuttle:${tenantId}`,
        });
        for (const device of voltDevices) {
          try {
            const fix = await withTimeout(
              deps.voltswitch.getDeviceLocation(session, { imei: device.externalDeviceId }),
              CALL_TIMEOUT_MS,
              `shuttle poll ${device.externalDeviceId}`
            );
            if (!fix || fix.latitude == null || fix.longitude == null) continue;
            await writeFix(deps, tenantId, device.vehicleId, fix);
            polled++;
          } catch (err) {
            deps.logger.warn('[shuttle-poll] device read failed', { tenantId, message: err.message });
          }
        }
      }
    } catch (err) {
      deps.logger.warn('[shuttle-poll] voltswitch branch failed', { tenantId, message: err.message });
    }
  }

  // ── OneStepGPS: ONE bulk call per tenant tick, filtered to mapped ids ────
  if (onestepDevices.length) {
    try {
      const ready = await deps.onestepgps.hasApiKey(tenantId);
      if (ready) {
        // Per-tick memo (innovation P1, 2026-08-25): the bulk call already
        // returns EVERY device on the account, so a tenant with N tracked
        // locations must not make N identical calls per tick against an API
        // with undocumented rate limits. tick() passes one shared Map per
        // sweep; the PROMISE is cached, so concurrent locations coalesce and
        // a failed call is not retried within the same tick.
        let fixesPromise = deps.bulkCache?.get(tenantId);
        if (!fixesPromise) {
          fixesPromise = withTimeout(
            deps.onestepgps.getDevicesWithPositions(tenantId),
            CALL_TIMEOUT_MS,
            `shuttle onestepgps bulk ${tenantId}`
          );
          deps.bulkCache?.set(tenantId, fixesPromise);
        }
        const fixes = await fixesPromise;
        const byExternalId = new Map((fixes || []).map((f) => [f.externalDeviceId, f]));
        for (const device of onestepDevices) {
          const fix = byExternalId.get(device.externalDeviceId);
          if (!fix || fix.latitude == null || fix.longitude == null) continue;
          await writeFix(deps, tenantId, device.vehicleId, fix);
          polled++;
        }
      }
    } catch (err) {
      deps.logger.warn('[shuttle-poll] onestepgps branch failed', { tenantId, message: err.message });
    }
  }

  return { polled, skipped: false };
}

async function tick() {
  if (running) return;
  running = true;
  try {
    const configs = await prisma.shuttleTrackerConfig.findMany({ where: { mode: { not: 'OFF' } } });
    // One OneStepGPS bulk result per tenant per sweep (see pollTenant).
    const bulkCache = new Map();
    for (const config of configs) {
      try {
        const out = await withTimeout(pollTenant(config, { bulkCache }), 60 * 1000, `shuttle tenant ${config.tenantId}`);
        if (out.polled) logger.info('[shuttle-poll] fixes published', { tenantId: config.tenantId, polled: out.polled });
      } catch (err) {
        logger.warn('[shuttle-poll] tenant failed', { tenantId: config.tenantId, message: err.message });
      }
    }
  } catch (err) {
    logger.warn('[shuttle-poll] tick failed', { message: err.message });
  } finally {
    running = false;
  }
}

export function startShuttleFastPollScheduler() {
  if (timerHandle) return;
  timerHandle = setInterval(() => { tick().catch(() => {}); }, TICK_MS);
  if (timerHandle.unref) timerHandle.unref();
  logger.info('[shuttle-poll] scheduler started', { tickMs: TICK_MS });
}

export function stopShuttleFastPollScheduler() {
  if (timerHandle) { clearInterval(timerHandle); timerHandle = null; }
}
