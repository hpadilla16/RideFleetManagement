/**
 * Shuttle alert poll — worker-only (Phase 2, 2026-08-24; approved mockup
 * Screens 5 + 16). Polls the provider's Alerts endpoint, normalizes into
 * ShuttleAlert rows, and fans out: staff email/SMS per the location's
 * recipients list, and the customer "your shuttle has arrived" notification
 * when an ENTER fires on a pickup-spot zone.
 *
 * CADENCE: gentle and demand-INDEPENDENT — 60s per tick (the provider's rate
 * limits are undocumented; alerts are not positions, a minute of latency is
 * fine), and ONLY tenants that have BOTH an API key and at least one active
 * zone are ever polled. No zones or no key = zero provider calls, which keeps
 * the whole feature naturally inert until a tenant configures it.
 *
 * IDEMPOTENCY: every tick re-reads a lookback window (the device-point doc's
 * own "pass your previous call time to catch delayed records" idiom). The
 * unique (tenantId, providerRef) makes re-seen alerts collapse into P2002
 * no-ops — fan-out runs ONLY for rows that actually inserted, so a re-polled
 * alert can never notify twice. That unique IS the arrival debounce.
 *
 * House scheduler rules (2026-08-08 incident): overlap guard, every provider
 * call timeout-bounded, per-tenant failure isolation. The provider API key
 * never appears in logs — client errors are already redacted.
 *
 * IN-HOUSE DETECTION (2026-08-25, owner-approved — now the PRIMARY path):
 * the provider has no corridor alerts, and its zone triggers produced
 * nothing for a real crossing, so OFF_ROUTE *and* ENTER/EXIT are detected
 * here every tick from house fixes — see detectInHouseEvents below and
 * route-corridor.js for the pure math and state machines. The provider poll
 * above remains as enrichment.
 */
import { prisma } from '../../lib/prisma.js';
import logger from '../../lib/logger.js';
import { withTimeout } from '../../lib/with-timeout.js';
import {
  hasApiKey as onestepgpsHasApiKey,
  listRawAlerts as onestepgpsListRawAlerts,
  pushProviderZone as onestepgpsPushProviderZone,
  deleteProviderZone as onestepgpsDeleteProviderZone,
  getDevicesWithPositions as onestepgpsGetDevicesWithPositions,
} from '../vehicles/telematics-onestepgps.js';
import { syncZoneToProvider } from './shuttle-zones.service.js';
import {
  normalizeProviderAlert,
  parseAlertRecipients,
  buildStaffAlertMessages,
  buildArrivalSms,
} from './shuttle-zone-alerts.js';
import { isOffRoute, createOffRouteTracker, isInsideZone, createZonePresenceTracker } from './route-corridor.js';
import { configVehicleIds } from './shuttle-tracker-position.js';
import { latestPositionsByVehicle } from './shuttle-tracker.service.js';

const TICK_MS = Math.max(30 * 1000, parseInt(process.env.SHUTTLE_ALERT_POLL_MS || String(60 * 1000), 10) || 60 * 1000);
const CALL_TIMEOUT_MS = 10 * 1000;
const TENANT_TIMEOUT_MS = 45 * 1000;
/** Re-read this far behind the watermark every tick — late provider writes
 *  land as P2002 no-ops, never as gaps. */
const LOOKBACK_MS = 10 * 60 * 1000;
/** First poll after a (re)start looks back this far, no further: catching up
 *  on an hour is useful, replaying a week of stale arrivals is not. */
const FIRST_POLL_LOOKBACK_MS = 60 * 60 * 1000;
/** Unsynced-zone retries per tenant per tick — provider-gentle. */
const SYNC_RETRIES_PER_TICK = 3;
/** In-house detection (2026-08-25): a house fix older than this is refreshed
 *  with ONE bulk provider call per tenant per tick… */
const FRESH_FIX_MS = 90 * 1000;
/** …and a fix still older than this after the refresh SKIPS the vehicle for
 *  the tick — no false alarms on stale data. */
const MAX_FIX_AGE_MS = 5 * 60 * 1000;

let timerHandle = null;
let running = false;

// Per-tenant newest occurredAt seen (ms). In-memory is enough: this runs only
// in the single worker process, and a restart merely re-reads one lookback
// window into P2002 no-ops.
const watermarks = new Map();
export function __resetWatermarksForTests() { watermarks.clear(); }

// In-house detection state — in-memory per worker like the fast poll's write
// memo; a restart forgets in-flight excursions/presence (bounded by the
// providerRef minute bucket + the ENTER baseline seeding). Pure machines live
// in route-corridor.js.
const offRouteTracker = createOffRouteTracker();
const zonePresenceTracker = createZonePresenceTracker();
export function __resetInHouseDetectionForTests() {
  offRouteTracker.reset();
  zonePresenceTracker.reset();
}

let _mailer = null;
async function resolveDefaultMailer() {
  if (_mailer) return _mailer;
  const mod = await import('../../lib/mailer.js');
  _mailer = { sendEmail: mod.sendEmail };
  return _mailer;
}
let _smsSend = null;
async function resolveDefaultSms() {
  if (_smsSend) return _smsSend;
  const mod = await import('../sms/sms.service.js');
  _smsSend = (args) => mod.smsService.sendCustom(args);
  return _smsSend;
}
let _resolveBrand = null;
async function resolveDefaultBrand() {
  if (_resolveBrand) return _resolveBrand;
  const mod = await import('../../lib/email-template.js');
  _resolveBrand = mod.resolveEmailBrand;
  return _resolveBrand;
}

function defaultDeps() {
  return {
    prisma,
    logger,
    now: () => Date.now(),
    // FULL provider surface (fix 2026-08-25): the zone-sync retry below hands
    // THIS deps object to syncZoneToProvider, whose spread lets it SHADOW the
    // service's own provider — with push/delete missing, every worker retry
    // died with "pushProviderZone is not a function" and overwrote the real
    // sync status. Caught live on the first tenant zone (Base MCO).
    provider: {
      hasApiKey: onestepgpsHasApiKey,
      listRawAlerts: onestepgpsListRawAlerts,
      pushProviderZone: onestepgpsPushProviderZone,
      deleteProviderZone: onestepgpsDeleteProviderZone,
      getDevicesWithPositions: onestepgpsGetDevicesWithPositions,
    },
    syncZoneToProvider,
    latestPositionsByVehicle,
    offRouteTracker,
    zonePresenceTracker,
    // mailer/smsSend/resolveBrand resolved lazily inside the fan-out so the
    // poll path stays importable in DB-free tests without the SMS module.
    mailer: null,
    smsSend: null,
    resolveBrand: null,
  };
}

async function vehicleLabel(deps, tenantId, vehicleId) {
  if (!vehicleId) return null;
  try {
    const v = await deps.prisma.vehicle.findFirst({
      where: { id: vehicleId, tenantId },
      select: { make: true, model: true, plate: true },
    });
    if (!v) return null;
    const name = [v.make, v.model].map((p) => String(p || '').trim()).filter(Boolean).join(' ');
    return [name, v.plate ? `· ${v.plate}` : ''].filter(Boolean).join(' ') || null;
  } catch { return null; }
}

/** Staff email/SMS per the location's recipients list. Best-effort per
 *  channel per recipient — one dead mailbox never blocks the rest. */
async function notifyStaff(row, zone, deps) {
  const wants = (row.type === 'ENTER' && zone.notifyOnEnter)
    || (row.type === 'EXIT' && zone.notifyOnExit)
    || (row.type === 'OFF_ROUTE' && zone.notifyOnOffRoute);
  if (!wants) return { attempted: 0 };

  const [config, location] = await Promise.all([
    deps.prisma.shuttleTrackerConfig.findFirst({
      where: { locationId: zone.locationId, tenantId: row.tenantId },
      select: { alertRecipientsJson: true },
    }),
    deps.prisma.location.findFirst({
      where: { id: zone.locationId, tenantId: row.tenantId },
      select: { name: true },
    }).catch(() => null),
  ]);
  const recipients = parseAlertRecipients(config?.alertRecipientsJson);
  if (!recipients.length) return { attempted: 0 };

  const msg = buildStaffAlertMessages({
    type: row.type,
    zoneName: zone.name,
    vehicleLabel: await vehicleLabel(deps, row.tenantId, row.vehicleId),
    locationName: location?.name || null,
    occurredAt: row.occurredAt,
  });

  const mailer = deps.mailer || (await resolveDefaultMailer());
  const smsSend = deps.smsSend || (await resolveDefaultSms());
  let attempted = 0;
  for (const r of recipients) {
    if (r.channels.includes('EMAIL') && r.email) {
      attempted++;
      try {
        await mailer.sendEmail({ tenantId: row.tenantId, to: r.email, subject: msg.subject, text: msg.text });
      } catch (err) {
        deps.logger.warn('[shuttle-alerts] staff email failed', { tenantId: row.tenantId, alertId: row.id, message: err.message });
      }
    }
    if (r.channels.includes('SMS') && r.phone) {
      attempted++;
      try {
        await smsSend({ to: r.phone, body: msg.smsBody, tenantId: row.tenantId });
      } catch (err) {
        // "SMS is not configured for this tenant" lands here — expected.
        deps.logger.info('[shuttle-alerts] staff sms not sent', { tenantId: row.tenantId, alertId: row.id, message: err.message });
      }
    }
  }
  return { attempted };
}

/**
 * The Screen-16 payoff: ENTER on a pickup-spot zone → every OPEN shuttle
 * request at that location learns the bus is there. The tracker page reads it
 * from ShuttleAlert on its next poll (see publicState); the SMS goes only to
 * requests that opted in AND have a phone. Runs once per alert ROW — the
 * providerRef unique upstream is the debounce, arrivalNotifiedAt records it.
 */
async function notifyArrival(row, zone, deps) {
  if (row.type !== 'ENTER' || !zone.isPickupSpot) return { smsSent: 0 };

  const requests = await deps.prisma.shuttleRequest.findMany({
    where: { tenantId: row.tenantId, locationId: zone.locationId, status: { in: ['READY', 'VIEWED'] } },
    include: { reservation: { select: { customer: { select: { locale: true } } } } },
  });

  let smsSent = 0;
  const optedIn = requests.filter((r) => r.smsOptIn === true && String(r.customerPhone || '').trim());
  if (optedIn.length) {
    const smsSend = deps.smsSend || (await resolveDefaultSms());
    const resolveBrand = deps.resolveBrand || (await resolveDefaultBrand());
    let brand = null;
    try { brand = await resolveBrand({ tenantId: row.tenantId }); } catch { brand = null; }
    let vehicle = null;
    if (row.vehicleId) {
      vehicle = await deps.prisma.vehicle.findFirst({
        where: { id: row.vehicleId, tenantId: row.tenantId },
        select: { make: true, model: true, plate: true },
      }).catch(() => null);
    }
    const vehicleName = vehicle ? [vehicle.make, vehicle.model].map((p) => String(p || '').trim()).filter(Boolean).join(' ') || null : null;

    for (const request of optedIn) {
      try {
        await smsSend({
          to: request.customerPhone,
          body: buildArrivalSms({
            spotName: zone.name,
            walkingDirections: zone.walkingDirections,
            vehicleName,
            vehiclePlate: vehicle?.plate || null,
            brandName: brand?.companyName,
            locale: request.reservation?.customer?.locale,
          }),
          tenantId: row.tenantId,
        });
        smsSent++;
      } catch (err) {
        deps.logger.info('[shuttle-alerts] arrival sms not sent', { tenantId: row.tenantId, requestId: request.id, message: err.message });
      }
    }
  }

  // Processed-marker, even with zero SMS: the row was considered exactly once.
  await deps.prisma.shuttleAlert.update({
    where: { id: row.id },
    data: { arrivalNotifiedAt: new Date() },
  }).catch(() => {});
  return { smsSent };
}

/** One tenant's poll. Deps injectable for tests; production passes none. */
export async function pollTenantAlerts(tenantId, depsOverride = {}) {
  const deps = { ...defaultDeps(), ...depsOverride };
  const now = deps.now();

  const zones = await deps.prisma.shuttleZone.findMany({ where: { tenantId, active: true } });
  if (!zones.length) return { skipped: true };

  // Retry unsynced ZONE geometry (bounded): a zone saved before the API key
  // landed goes live here without anyone re-saving it.
  const unsynced = zones.filter((z) => z.kind === 'ZONE' && !['SYNCED', 'UNSUPPORTED'].includes(z.providerSyncStatus)).slice(0, SYNC_RETRIES_PER_TICK);
  for (const zone of unsynced) {
    const updated = await deps.syncZoneToProvider(zone, deps);
    if (updated?.providerZoneId) Object.assign(zone, updated);
  }

  const zoneByProviderId = new Map(
    zones.filter((z) => z.providerZoneId).map((z) => [String(z.providerZoneId), z]),
  );
  const devices = await deps.prisma.vehicleTelematicsDevice.findMany({
    where: { tenantId, provider: 'ONESTEPGPS', isActive: true },
    select: { externalDeviceId: true, vehicleId: true },
  });
  const vehicleByExternalId = new Map(devices.map((d) => [d.externalDeviceId, d.vehicleId]));

  const wm = watermarks.get(tenantId);
  const sinceMs = wm ? wm - LOOKBACK_MS : now - FIRST_POLL_LOOKBACK_MS;
  const raws = await withTimeout(
    deps.provider.listRawAlerts(tenantId, { sinceIso: new Date(sinceMs).toISOString() }),
    CALL_TIMEOUT_MS,
    `shuttle alerts ${tenantId}`,
  );

  let newest = wm || 0;
  let skippedEntries = 0;
  const created = [];
  for (const raw of raws || []) {
    const v = normalizeProviderAlert(raw, { zoneByProviderId, vehicleByExternalId, now });
    if (!v.ok) {
      skippedEntries++;
      deps.logger.warn('[shuttle-alerts] skipping unrecognized alert entry', { tenantId, reason: v.reason });
      continue;
    }
    const at = v.alert.occurredAt.getTime();
    // The since param is ASSUMED — if the provider ignored it, old history
    // must not resurrect week-old "arrivals".
    if (at < sinceMs) continue;
    if (at > newest) newest = at;
    try {
      created.push(await deps.prisma.shuttleAlert.create({ data: { tenantId, ...v.alert } }));
    } catch (err) {
      if (err?.code === 'P2002') continue; // re-seen on re-poll — the whole point
      deps.logger.warn('[shuttle-alerts] alert row insert failed', { tenantId, message: err.message });
    }
  }
  watermarks.set(tenantId, newest || now);

  // Fan-out for genuinely NEW rows only. A zone-less alert (provider-side
  // rule we don't know) stays feed-only by construction.
  const { staffAttempts, arrivalSms } = await fanOutCreatedAlerts(tenantId, created, zones, deps);

  return { skipped: false, fetched: (raws || []).length, created: created.length, skippedEntries, staffAttempts, arrivalSms };
}

/**
 * THE fan-out choke point (extracted 2026-08-25): every genuinely-new alert
 * row — provider-ingested OR minted by the in-house detector — goes through
 * this one function, so a synthetic pickup-spot ENTER triggers the customer
 * arrival SMS exactly like a provider ENTER would. Notify prefs gate the
 * email/SMS only; the row itself always exists for the feed.
 */
async function fanOutCreatedAlerts(tenantId, created, zones, deps) {
  let staffAttempts = 0;
  let arrivalSms = 0;
  for (const row of created) {
    const zone = row.zoneId ? zones.find((z) => z.id === row.zoneId) : null;
    if (!zone) continue;
    try {
      const s = await notifyStaff(row, zone, deps);
      staffAttempts += s.attempted;
      if (s.attempted) {
        await deps.prisma.shuttleAlert.update({ where: { id: row.id }, data: { staffNotifiedAt: new Date() } }).catch(() => {});
      }
      const a = await notifyArrival(row, zone, deps);
      arrivalSms += a.smsSent;
    } catch (err) {
      deps.logger.warn('[shuttle-alerts] fan-out failed', { tenantId, alertId: row.id, message: err.message });
    }
  }
  return { staffAttempts, arrivalSms };
}

// ─── In-house geofence detection (2026-08-25, owner-approved) ───────────────
//
// PRIMARY detection path. Discovered live: the provider's trigger system
// produced NOTHING for a real zone crossing, and it never had corridor
// alerts — so BOTH detections run HERE, every tick (~60s resolution), from
// HOUSE fixes (Redis fast path + Postgres fallback via
// latestPositionsByVehicle). Provider alert ingestion above stays as
// enrichment only; if the provider ever starts delivering, its ENTER/EXIT
// rows carry different providerRefs than ours, so the feed could show both —
// an accepted, visible redundancy, not silent loss.
//
//   * ROUTE corridors → OFF_ROUTE / BACK_ON_ROUTE (route-corridor.js:
//     2-tick debounce, 2-tick recovery, 10-min cooldown backstop).
//   * ZONE polygons → ENTER / EXIT (zone presence tracker: first observation
//     seeds the baseline WITHOUT emitting — a van already inside at worker
//     boot is not an arrival — then any confirmed flip emits).
//
// Because the fast poll is DEMAND-driven, an unwatched tenant may have no
// fresh fix at all: a fix older than FRESH_FIX_MS is refreshed with ONE bulk
// device-info call per tenant per tick (detection-only — deliberately NOT
// the fast poll's DB write path, so this never duplicates
// VehicleTelematicsEvent rows). A fix still older than MAX_FIX_AGE_MS skips
// that vehicle: silence, not a false alarm.
//
// All emitted rows go through fanOutCreatedAlerts — the SAME choke point as
// provider alerts — so notify prefs gate email/SMS (rows always land in the
// feed) and a pickup-spot ENTER fires the customer arrival SMS exactly like
// a provider ENTER would. BACK_ON_ROUTE alone is feed-only by design.

const fixAtMs = (fix) => {
  if (!fix) return NaN;
  const at = fix.eventAt instanceof Date ? fix.eventAt.getTime() : new Date(fix.eventAt || 0).getTime();
  return Number.isFinite(at) && at > 0 ? at : NaN;
};

/** One tenant's in-house sweep. Deps injectable for tests; production passes none. */
export async function detectInHouseEvents(tenantId, depsOverride = {}) {
  const deps = { ...defaultDeps(), ...depsOverride };
  const routeTracker = deps.offRouteTracker || offRouteTracker;
  const presenceTracker = deps.zonePresenceTracker || zonePresenceTracker;
  const now = deps.now();

  const all = await deps.prisma.shuttleZone.findMany({ where: { tenantId, active: true } });
  if (!all.length) return { skipped: true };
  const routes = all.filter((z) => z.kind === 'ROUTE');
  const plainZones = all.filter((z) => z.kind === 'ZONE');

  // One-time self-heal: ROUTE rows saved while routes were store-only carry
  // UNSUPPORTED — flip them to ACTIVE so pre-existing routes light up without
  // a re-save. New saves already land ACTIVE (shuttle-zones.service.js).
  const legacy = routes.filter((r) => r.providerSyncStatus === 'UNSUPPORTED');
  if (legacy.length) {
    try {
      await deps.prisma.shuttleZone.updateMany({
        where: { id: { in: legacy.map((r) => r.id) } },
        data: { providerSyncStatus: 'ACTIVE', providerSyncError: null },
      });
      legacy.forEach((r) => { r.providerSyncStatus = 'ACTIVE'; });
      deps.logger.info('[shuttle-offroute] legacy ROUTE rows now ACTIVE (in-house detection)', {
        tenantId, zoneIds: legacy.map((r) => r.id),
      });
    } catch (err) {
      deps.logger.warn('[shuttle-offroute] legacy ROUTE self-heal failed', { tenantId, message: err.message });
    }
  }

  // Routes detect only when armed (notifyOnOffRoute); ZONE rows ALWAYS
  // detect — the feed shows every crossing, the prefs gate only the
  // notifications (same contract the provider path always had).
  const armedRoutes = routes.filter((r) => r.notifyOnOffRoute);
  const watched = [...armedRoutes, ...plainZones];
  if (!watched.length) return { skipped: true };

  // The vehicles a zone/route watches = its LOCATION's shuttle config list —
  // the same source of truth the tracker page resolves (an SJU van far from
  // an MCO corridor is not "off" that route; it was never on it).
  const configs = await deps.prisma.shuttleTrackerConfig.findMany({
    where: { tenantId, locationId: { in: [...new Set(watched.map((z) => z.locationId))] } },
  });
  const vehiclesByLocation = new Map(configs.map((c) => [c.locationId, configVehicleIds(c)]));
  const allVehicleIds = [...new Set([...vehiclesByLocation.values()].flat())];
  if (!allVehicleIds.length) return { skipped: true };

  const fixes = await deps.latestPositionsByVehicle(allVehicleIds);

  // Demand-independent freshness: ONE bulk call per tenant per tick, only
  // when needed and only when a key exists. Detection-only — no DB write.
  const staleIds = allVehicleIds.filter((id) => {
    const at = fixAtMs(fixes[id]);
    return !Number.isFinite(at) || now - at > FRESH_FIX_MS;
  });
  let refreshed = 0;
  if (staleIds.length) {
    try {
      if (await deps.provider.hasApiKey(tenantId)) {
        const devices = await deps.prisma.vehicleTelematicsDevice.findMany({
          where: { tenantId, provider: 'ONESTEPGPS', isActive: true, vehicleId: { in: staleIds } },
          select: { externalDeviceId: true, vehicleId: true },
        });
        if (devices.length) {
          const bulk = await withTimeout(
            deps.provider.getDevicesWithPositions(tenantId),
            CALL_TIMEOUT_MS,
            `shuttle offroute bulk ${tenantId}`,
          );
          const byExternalId = new Map((bulk || []).map((f) => [f.externalDeviceId, f]));
          for (const device of devices) {
            const f = byExternalId.get(device.externalDeviceId);
            if (!f || f.latitude == null || f.longitude == null) continue;
            const freshAt = fixAtMs(f);
            const haveAt = fixAtMs(fixes[device.vehicleId]);
            if (Number.isFinite(freshAt) && (!Number.isFinite(haveAt) || freshAt > haveAt)) {
              fixes[device.vehicleId] = {
                vehicleId: device.vehicleId,
                latitude: f.latitude,
                longitude: f.longitude,
                eventAt: f.eventAt,
              };
              refreshed++;
            }
          }
        }
      }
    } catch (err) {
      // Detection degrades to the house fixes it has — stale ones skip below.
      deps.logger.warn('[shuttle-offroute] bulk position refresh failed', { tenantId, message: err.message });
    }
  }

  /** Minute-bucketed refs = idempotent under retries/restarts within the
   *  bucket; the (tenantId, providerRef) unique is the ledger. Returns the
   *  inserted row, or null on duplicate/failure. */
  const createAlert = async (data) => {
    try {
      return await deps.prisma.shuttleAlert.create({ data: { tenantId, ...data } });
    } catch (err) {
      if (err?.code !== 'P2002') {
        deps.logger.warn('[shuttle-offroute] alert row insert failed', { tenantId, message: err.message });
      }
      return null;
    }
  };

  let skippedStale = 0;
  let backOnRoute = 0;
  const created = []; // rows that fan out (OFF_ROUTE / ENTER / EXIT)
  const usableFix = (vehicleId) => {
    const fix = fixes[vehicleId];
    const at = fixAtMs(fix);
    if (!Number.isFinite(at) || now - at > MAX_FIX_AGE_MS) { skippedStale++; return null; }
    return { fix, at };
  };

  // ── ROUTE corridors ──
  for (const route of armedRoutes) {
    for (const vehicleId of vehiclesByLocation.get(route.locationId) || []) {
      const u = usableFix(vehicleId);
      if (!u) continue;
      const verdict = isOffRoute({ lat: Number(u.fix.latitude), lng: Number(u.fix.longitude) }, route);
      const out = routeTracker.observe({ zoneId: route.id, vehicleId, off: verdict.off, now });
      if (!out.fire) continue;
      const isRecovery = out.fire === 'BACK_ON_ROUTE';
      const row = await createAlert({
        type: out.fire,
        occurredAt: new Date(u.at), // the FIX's own time, same rule as provider alerts
        providerRef: isRecovery
          ? `backonroute:${route.id}:${vehicleId}:${Math.floor(now / 60000)}`
          : `offroute:${route.id}:${vehicleId}:${Math.floor(out.firstOffAt / 60000)}`,
        zoneId: route.id,
        vehicleId,
        // Distances only — NO coordinates persist in rawJson.
        rawJson: JSON.stringify({
          source: 'IN_HOUSE_CORRIDOR',
          distanceM: verdict.distanceM == null ? null : Math.round(verdict.distanceM),
          toleranceM: verdict.toleranceM,
        }),
      });
      if (!row) continue;
      if (isRecovery) backOnRoute++; // feed-only by design — no email/SMS
      else created.push(row);
    }
  }

  // ── ZONE polygons (ENTER/EXIT) ──
  for (const zone of plainZones) {
    for (const vehicleId of vehiclesByLocation.get(zone.locationId) || []) {
      const u = usableFix(vehicleId);
      if (!u) continue;
      const inside = isInsideZone({ lat: Number(u.fix.latitude), lng: Number(u.fix.longitude) }, zone);
      const out = presenceTracker.observe({ zoneId: zone.id, vehicleId, inside, now });
      if (!out.fire) continue;
      const row = await createAlert({
        type: out.fire,
        occurredAt: new Date(u.at),
        providerRef: `zonedet:${zone.id}:${vehicleId}:${out.fire}:${Math.floor(now / 60000)}`,
        zoneId: zone.id,
        vehicleId,
        rawJson: JSON.stringify({ source: 'IN_HOUSE_GEOFENCE' }),
      });
      if (row) created.push(row);
    }
  }

  // Same choke point as provider ingestion: prefs gate the notifications,
  // pickup-spot ENTERs reach the customer arrival SMS, rows stay regardless.
  const { staffAttempts, arrivalSms } = await fanOutCreatedAlerts(tenantId, created, all, deps);

  routeTracker.prune(now);
  presenceTracker.prune(now);
  return {
    skipped: false,
    routes: armedRoutes.length,
    zones: plainZones.length,
    vehicles: allVehicleIds.length,
    refreshed,
    skippedStale,
    created: created.length + backOnRoute,
    backOnRoute,
    staffAttempts,
    arrivalSms,
  };
}

async function tick() {
  if (running) return;
  running = true;
  try {
    // Tenants with at least one active zone; provider polling additionally
    // needs a stored key, but the in-house geofence sweep (the PRIMARY
    // detector) reads HOUSE fixes and must not go dark for a keyless
    // (e.g. VoltSwitch-only) tenant.
    const grouped = await prisma.shuttleZone.groupBy({ by: ['tenantId'], where: { active: true } });
    for (const g of grouped) {
      const tenantId = g.tenantId;
      try {
        if (await onestepgpsHasApiKey(tenantId)) {
          const out = await withTimeout(pollTenantAlerts(tenantId), TENANT_TIMEOUT_MS, `shuttle alerts tenant ${tenantId}`);
          if (out.created) logger.info('[shuttle-alerts] alerts ingested', { tenantId, ...out });
        }
        const det = await withTimeout(detectInHouseEvents(tenantId), TENANT_TIMEOUT_MS, `shuttle in-house detection tenant ${tenantId}`);
        if (det.created) logger.info('[shuttle-offroute] in-house geofence alerts created', { tenantId, ...det });
      } catch (err) {
        logger.warn('[shuttle-alerts] tenant failed', { tenantId, message: err.message });
      }
    }
  } catch (err) {
    logger.warn('[shuttle-alerts] tick failed', { message: err.message });
  } finally {
    running = false;
  }
}

export function startShuttleAlertScheduler() {
  if (timerHandle) return;
  timerHandle = setInterval(() => { tick().catch(() => {}); }, TICK_MS);
  if (timerHandle.unref) timerHandle.unref();
  logger.info('[shuttle-alerts] scheduler started', { tickMs: TICK_MS });
}

export function stopShuttleAlertScheduler() {
  if (timerHandle) { clearInterval(timerHandle); timerHandle = null; }
}
