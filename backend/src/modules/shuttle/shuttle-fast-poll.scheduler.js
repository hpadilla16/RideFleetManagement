/**
 * Shuttle fast poll — the ONLY file above the provider client allowed to
 * import it. Everything else (public API, page, simulator) reads house
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
import { configVehicleIds } from './shuttle-tracker-position.js';
import { publishPosition, isWatched } from './shuttle-tracker.service.js';

const TICK_MS = Math.max(10 * 1000, parseInt(process.env.SHUTTLE_FAST_POLL_MS || String(15 * 1000), 10) || 15 * 1000);
const CALL_TIMEOUT_MS = 10 * 1000;

let timerHandle = null;
let running = false;

async function pollTenant(config) {
  const { tenantId } = config;

  // Demand check first — the whole point is not calling the provider when
  // nobody is looking.
  const watched = await isWatched(tenantId);
  if (!watched) {
    const openRequests = await prisma.shuttleRequest.count({
      where: { tenantId, locationId: config.locationId, status: { in: ['READY', 'VIEWED'] } },
    });
    if (openRequests === 0) return { polled: 0, skipped: true };
  }

  const vehicleIds = configVehicleIds(config);
  if (!vehicleIds.length) return { polled: 0, skipped: true };

  const devices = await prisma.vehicleTelematicsDevice.findMany({
    where: { provider: 'VOLTSWITCH', isActive: true, vehicleId: { in: vehicleIds } },
    select: { vehicleId: true, externalDeviceId: true },
  });
  if (!devices.length) return { polled: 0, skipped: true };

  const tcfg = await settingsService.getTelematicsConfig({ tenantId }, { includeSecret: true });
  if (!tcfg.voltswitchConnectorReady) return { polled: 0, skipped: true };

  const session = await voltswitchAuth({
    username: tcfg.voltswitchApiEmail,
    password: tcfg.voltswitchApiPassword,
    tenantId: `shuttle:${tenantId}`,
  });

  let polled = 0;
  for (const device of devices) {
    try {
      const fix = await withTimeout(
        getDeviceLocation(session, { imei: device.externalDeviceId }),
        CALL_TIMEOUT_MS,
        `shuttle poll ${device.externalDeviceId}`
      );
      if (!fix || fix.latitude == null || fix.longitude == null) continue;

      const eventAt = fix.eventAt ? new Date(fix.eventAt) : new Date();
      await prisma.vehicleTelematicsEvent.create({
        data: {
          tenantId,
          vehicleId: device.vehicleId,
          eventType: 'PING',
          eventAt,
          latitude: fix.latitude,
          longitude: fix.longitude,
          speedMph: fix.speedMph,
          heading: fix.heading,
          payload: JSON.stringify({ source: 'SHUTTLE_FAST_POLL' }),
        },
      }).catch(() => {}); // Redis still gets the fix; the row is best-effort
      await publishPosition(device.vehicleId, {
        latitude: fix.latitude, longitude: fix.longitude,
        heading: fix.heading, speedMph: fix.speedMph,
        eventAt: eventAt.toISOString(),
      });
      polled++;
    } catch (err) {
      logger.warn('[shuttle-poll] device read failed', { tenantId, message: err.message });
    }
  }
  return { polled, skipped: false };
}

async function tick() {
  if (running) return;
  running = true;
  try {
    const configs = await prisma.shuttleTrackerConfig.findMany({ where: { mode: { not: 'OFF' } } });
    for (const config of configs) {
      try {
        const out = await withTimeout(pollTenant(config), 60 * 1000, `shuttle tenant ${config.tenantId}`);
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
