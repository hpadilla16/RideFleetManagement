/**
 * Shuttle zones — the IO half (Phase 2, 2026-08-24). Decisions live in
 * shuttle-zone-alerts.js.
 *
 * OWNERSHIP MODEL (approved decision #9): we hold the record (name, kind,
 * notify prefs, pickup-spot flag) and the provider holds the live geometry
 * copy — enter/exit detection runs on THEIR side, so a zone only detects once
 * providerSyncStatus is SYNCED. Sync is BEST-EFFORT on every save and retried
 * by the alert scheduler: a provider outage (or a not-yet-stored API key)
 * leaves the zone PENDING, visibly, instead of failing the staff save.
 *
 * ROUTE = IN-HOUSE detection (2026-08-25, owner-approved): the provider has
 * no route/corridor alert API, so ROUTE rows are never pushed anywhere —
 * OFF_ROUTE is detected by OUR worker (shuttle-alerts.scheduler.js →
 * detectInHouseEvents + route-corridor.js) against house GPS fixes at ~60s
 * resolution. providerSyncStatus for a ROUTE is therefore ACTIVE: "our
 * detector is wired for this route". ACTIVE is stamped on every save
 * regardless of notifyOnOffRoute — the toggle ARMS alerting (exactly like a
 * ZONE's notify toggles beside its SYNCED chip); the chip describes the
 * machinery. Legacy UNSUPPORTED rows are self-healed by the scheduler.
 *
 * TENANT-SCOPED FAIL-CLOSED: every read/write filters by tenantId, and a
 * zone's location must belong to the tenant before create. Out-of-scope rows
 * look identical to nonexistent (404), same as shuttle-tracker admin routes.
 */
import { prisma } from '../../lib/prisma.js';
import logger from '../../lib/logger.js';
import {
  pushProviderZone,
  deleteProviderZone,
  hasApiKey,
  OneStepGpsAuthError,
} from '../vehicles/telematics-onestepgps.js';
import { validateZoneInput, parseAlertRecipients } from './shuttle-zone-alerts.js';

function defaultDeps() {
  return {
    prisma,
    logger,
    provider: { pushProviderZone, deleteProviderZone, hasApiKey },
  };
}

const httpError = (status, message) => { const e = new Error(message); e.status = status; return e; };

/** Public list shape — providerSyncError is included so staff SEE a broken
 *  sync, but it is a redacted provider message (the client never puts the
 *  API key in error text — see apiCall). */
const zoneOut = (z) => ({
  id: z.id,
  locationId: z.locationId,
  name: z.name,
  kind: z.kind,
  isPickupSpot: z.isPickupSpot,
  walkingDirections: z.walkingDirections,
  walkingDirectionsEs: z.walkingDirectionsEs,
  geometry: z.geometryJson,
  toleranceM: z.toleranceM,
  notifyOnEnter: z.notifyOnEnter,
  notifyOnExit: z.notifyOnExit,
  notifyOnOffRoute: z.notifyOnOffRoute,
  active: z.active,
  providerSyncStatus: z.providerSyncStatus,
  providerSyncError: z.providerSyncError,
  updatedAt: z.updatedAt,
});

/**
 * Push one zone's geometry to the provider and stamp the outcome on the row.
 * NEVER throws — the save (or the scheduler tick) already succeeded; this
 * records whether detection is live. Exported for the scheduler's retry.
 */
export async function syncZoneToProvider(zone, depsOverride = {}) {
  const deps = { ...defaultDeps(), ...depsOverride };
  if (zone.kind === 'ROUTE') {
    // ROUTEs never touch the provider: OFF_ROUTE is detected IN-HOUSE by the
    // worker (~60s resolution) — see the header. ACTIVE = our detector has
    // this route; the notifyOnOffRoute toggle arms the alerting.
    return deps.prisma.shuttleZone.update({
      where: { id: zone.id },
      data: { providerSyncStatus: 'ACTIVE', providerSyncError: null },
    });
  }
  try {
    const { providerZoneId } = await deps.provider.pushProviderZone(zone.tenantId, {
      providerZoneId: zone.providerZoneId || null,
      name: zone.name,
      points: zone.geometryJson?.points || [],
    });
    return await deps.prisma.shuttleZone.update({
      where: { id: zone.id },
      data: { providerZoneId, providerSyncStatus: 'SYNCED', providerSyncError: null },
    });
  } catch (err) {
    // No API key yet is the NORMAL pre-connector state: stay PENDING (the
    // scheduler retries once a key lands). Anything else is an ERROR the
    // panel shows. err.message is already key-redacted by the client.
    const noKey = err instanceof OneStepGpsAuthError;
    deps.logger.warn('[shuttle-zones] provider sync failed', {
      tenantId: zone.tenantId, zoneId: zone.id, pending: noKey, message: err.message,
    });
    return deps.prisma.shuttleZone.update({
      where: { id: zone.id },
      data: {
        providerSyncStatus: noKey ? 'PENDING' : 'ERROR',
        providerSyncError: String(err.message || 'sync failed').slice(0, 300),
      },
    }).catch(() => zone);
  }
}

export const shuttleZonesService = {
  async list({ tenantId, locationId = null }, depsOverride = {}) {
    const deps = { ...defaultDeps(), ...depsOverride };
    if (!tenantId) return []; // fail closed — never "all tenants"
    const rows = await deps.prisma.shuttleZone.findMany({
      where: { tenantId, ...(locationId ? { locationId } : {}) },
      orderBy: [{ active: 'desc' }, { createdAt: 'asc' }],
    });
    return rows.map(zoneOut);
  },

  async create({ tenantId, locationId, body }, depsOverride = {}) {
    const deps = { ...defaultDeps(), ...depsOverride };
    if (!tenantId) throw httpError(400, 'tenantId is required');
    const locId = String(locationId || '').trim();
    if (!locId) throw httpError(400, 'locationId is required');

    // The location must be the tenant's own — cross-tenant looks nonexistent.
    const location = await deps.prisma.location.findFirst({
      where: { id: locId, tenantId }, select: { id: true },
    });
    if (!location) throw httpError(404, 'Location not found');

    const v = validateZoneInput(body);
    if (!v.ok) throw httpError(400, v.error);

    const row = await deps.prisma.shuttleZone.create({
      data: { tenantId, locationId: locId, ...v.zone, providerSyncStatus: 'PENDING' },
    });
    const synced = await syncZoneToProvider(row, deps);
    return zoneOut(synced || row);
  },

  async update({ tenantId, zoneId, body }, depsOverride = {}) {
    const deps = { ...defaultDeps(), ...depsOverride };
    if (!tenantId) throw httpError(400, 'tenantId is required');
    const existing = await deps.prisma.shuttleZone.findFirst({ where: { id: zoneId, tenantId } });
    if (!existing) throw httpError(404, 'Zone not found');

    // Validate the MERGED record: a PATCH that only flips a toggle must not
    // have to re-send geometry, but whatever lands must still be whole.
    const merged = {
      name: body.name ?? existing.name,
      kind: existing.kind, // kind is immutable — a ZONE cannot become a ROUTE
      isPickupSpot: body.isPickupSpot ?? existing.isPickupSpot,
      walkingDirections: body.walkingDirections ?? existing.walkingDirections,
      walkingDirectionsEs: body.walkingDirectionsEs ?? existing.walkingDirectionsEs,
      geometry: body.geometry ?? existing.geometryJson,
      toleranceM: body.toleranceM ?? existing.toleranceM,
      notifyOnEnter: body.notifyOnEnter ?? existing.notifyOnEnter,
      notifyOnExit: body.notifyOnExit ?? existing.notifyOnExit,
      notifyOnOffRoute: body.notifyOnOffRoute ?? existing.notifyOnOffRoute,
      active: body.active ?? existing.active,
    };
    const v = validateZoneInput(merged);
    if (!v.ok) throw httpError(400, v.error);

    const geometryChanged = JSON.stringify(v.zone.geometryJson) !== JSON.stringify(existing.geometryJson)
      || v.zone.name !== existing.name;
    const row = await deps.prisma.shuttleZone.update({
      where: { id: existing.id },
      data: {
        ...v.zone,
        ...(geometryChanged && existing.kind === 'ZONE'
          ? { providerSyncStatus: 'PENDING' } : {}),
      },
    });
    const synced = geometryChanged ? await syncZoneToProvider(row, deps) : row;
    return zoneOut(synced || row);
  },

  async remove({ tenantId, zoneId }, depsOverride = {}) {
    const deps = { ...defaultDeps(), ...depsOverride };
    if (!tenantId) throw httpError(400, 'tenantId is required');
    const existing = await deps.prisma.shuttleZone.findFirst({ where: { id: zoneId, tenantId } });
    if (!existing) throw httpError(404, 'Zone not found');

    // Provider copy first, best-effort: a dead provider must not make a zone
    // undeletable. An orphaned provider zone stops mattering the moment our
    // row is gone — its alerts resolve to zoneId null and never fan out.
    if (existing.providerZoneId) {
      try {
        await deps.provider.deleteProviderZone(existing.tenantId, existing.providerZoneId);
      } catch (err) {
        deps.logger.warn('[shuttle-zones] provider zone delete failed — deleting ours anyway', {
          tenantId, zoneId, message: err.message,
        });
      }
    }
    await deps.prisma.shuttleZone.delete({ where: { id: existing.id } });
    return { ok: true };
  },

  // ── Staff alert recipients (per location, Screen 4 "Who gets alerted") ────

  async getRecipients({ tenantId, locationId }, depsOverride = {}) {
    const deps = { ...defaultDeps(), ...depsOverride };
    if (!tenantId) return { locationId, recipients: [] };
    const cfg = await deps.prisma.shuttleTrackerConfig.findFirst({
      where: { locationId, tenantId },
      select: { alertRecipientsJson: true },
    });
    return { locationId, recipients: parseAlertRecipients(cfg?.alertRecipientsJson) };
  },

  async setRecipients({ tenantId, locationId, recipients }, depsOverride = {}) {
    const deps = { ...defaultDeps(), ...depsOverride };
    if (!tenantId) throw httpError(400, 'tenantId is required');
    const locId = String(locationId || '').trim();
    if (!locId) throw httpError(400, 'locationId is required');
    const location = await deps.prisma.location.findFirst({
      where: { id: locId, tenantId }, select: { id: true },
    });
    if (!location) throw httpError(404, 'Location not found');

    const clean = parseAlertRecipients(recipients);
    // Upsert keeps a location without a tracker config still able to hold a
    // recipients list (zones can exist before the tracker page is turned on).
    await deps.prisma.shuttleTrackerConfig.upsert({
      where: { locationId: locId },
      update: { tenantId, alertRecipientsJson: clean },
      create: { tenantId, locationId: locId, mode: 'OFF', alertRecipientsJson: clean },
    });
    return { locationId: locId, recipients: clean };
  },
};
