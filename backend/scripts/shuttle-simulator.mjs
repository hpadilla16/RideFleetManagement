/**
 * Shuttle simulator — drives a fake shuttle around a loop, writing the same
 * VehicleTelematicsEvent rows and Redis keys the worker's fast poll writes.
 *
 * Because nothing above the worker imports the VoltSwitch client, everything
 * downstream (public API, map page, staff views) cannot tell simulator data
 * from provider data. That is the point: the whole tracker is buildable and
 * demo-able before the VoltSwitch credentials arrive, and this same script
 * is the demo driver for conventions.
 *
 * Usage (inside the backend container or with backend/.env loaded):
 *   node scripts/shuttle-simulator.mjs --vehicle <vehicleId> --tenant <tenantId> [--interval 15]
 *
 * The loop is a rounded rectangle around SJU airport-ish coordinates; the
 * shuttle advances a step per tick with a plausible speed and heading.
 * Ctrl+C to stop. Writes stop with it — the tracker page will honestly go
 * AGING and then OFFLINE, which is itself worth demoing.
 */
import { PrismaClient } from '@prisma/client';

const args = Object.fromEntries(
  process.argv.slice(2).map((a, i, all) => (a.startsWith('--') ? [a.slice(2), all[i + 1]] : null)).filter(Boolean)
);
const vehicleId = args.vehicle;
const tenantId = args.tenant;
const intervalS = Math.max(5, Number(args.interval) || 15);
if (!vehicleId || !tenantId) {
  console.error('usage: node scripts/shuttle-simulator.mjs --vehicle <vehicleId> --tenant <tenantId> [--interval 15]');
  process.exit(1);
}

const prisma = new PrismaClient();

// Redis, same lazy posture as the service: absent Redis just means the
// public read falls back to Postgres.
let redis = null;
try {
  const IORedis = (await import('ioredis')).default;
  if (process.env.REDIS_URL) {
    redis = new IORedis(process.env.REDIS_URL, { maxRetriesPerRequest: 1, enableReadyCheck: false });
    redis.on('error', () => {});
  }
} catch { redis = null; }

// A loop around the SJU area: airport curb → rental lot → hotel strip → back.
// ~40 waypoints so a 15s tick laps in ~10 minutes, like a real shuttle.
const CENTER = { lat: 18.4394, lng: -66.0018 };
const WAYPOINTS = [];
for (let i = 0; i < 40; i++) {
  const t = (i / 40) * 2 * Math.PI;
  WAYPOINTS.push({
    lat: CENTER.lat + 0.012 * Math.sin(t),
    lng: CENTER.lng + 0.018 * Math.cos(t),
  });
}

const headingBetween = (a, b) => (Math.atan2(b.lng - a.lng, b.lat - a.lat) * 180 / Math.PI + 360) % 360;

let step = 0;
console.log(`simulating shuttle ${vehicleId} (tenant ${tenantId}) every ${intervalS}s — Ctrl+C to stop`);

async function tick() {
  const here = WAYPOINTS[step % WAYPOINTS.length];
  const next = WAYPOINTS[(step + 1) % WAYPOINTS.length];
  step++;
  const fix = {
    latitude: Number(here.lat.toFixed(6)),
    longitude: Number(here.lng.toFixed(6)),
    heading: Math.round(headingBetween(here, next)),
    speedMph: 18 + Math.round(Math.random() * 10),
    eventAt: new Date().toISOString(),
  };

  await prisma.vehicleTelematicsEvent.create({
    data: {
      tenantId,
      vehicleId,
      eventType: 'PING',
      eventAt: new Date(fix.eventAt),
      latitude: fix.latitude,
      longitude: fix.longitude,
      speedMph: fix.speedMph,
      heading: fix.heading,
      payload: JSON.stringify({ source: 'SHUTTLE_SIMULATOR' }),
    },
  });
  if (redis) {
    await redis.set(`shuttle:pos:${vehicleId}`, JSON.stringify(fix), 'EX', 300).catch(() => {});
  }
  console.log(`  ${fix.eventAt}  ${fix.latitude},${fix.longitude}  ${fix.speedMph}mph hdg ${fix.heading}`);
}

await tick();
const timer = setInterval(() => tick().catch((e) => console.error('tick failed:', e.message)), intervalS * 1000);

process.on('SIGINT', async () => {
  clearInterval(timer);
  await prisma.$disconnect();
  if (redis) redis.disconnect();
  console.log('\nsimulator stopped — the tracker page will now age out honestly');
  process.exit(0);
});
