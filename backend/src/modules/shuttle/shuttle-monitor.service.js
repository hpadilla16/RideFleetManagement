/**
 * Staff Shuttle Monitor — the IO half (2026-08-24, approved mockup Screen 1).
 * Decisions live in shuttle-monitor.js.
 *
 * READS HOUSE STORAGE ONLY: positions come from latestPositionsByVehicle
 * (Redis written by the fast poll / simulator, VehicleTelematicsEvent
 * fallback). No provider client is imported here — the fast-poll scheduler
 * stays the only file above the providers allowed to call them.
 *
 * TENANT-SCOPED, FAIL-CLOSED. A scope with no tenantId returns the empty
 * shape — never "all tenants". Super admins narrow with ?tenantId= exactly
 * like scopeFor elsewhere. Location scoping follows the shuttle-requests
 * convention: allowedLocationIds INTERSECTS, never widens — a LAX-scoped
 * agent sees LAX shuttles and LAX queues only.
 *
 * Deps are injectable for the DB-free test suite; production passes none.
 */
import { prisma } from '../../lib/prisma.js';
import { latestPositionsByVehicle, signalWatch } from './shuttle-tracker.service.js';
import { configVehicleIds } from './shuttle-tracker-position.js';
import { OPEN_STATUSES, scopeWhere } from './shuttle-query.js';
import { monitorShuttlePayload, summarizeOpenRequests } from './shuttle-monitor.js';

const EMPTY = () => ({ enabled: false, shuttles: [], requestsByLocation: {}, locations: [], generatedAt: new Date().toISOString() });

function allowedIds(scope) {
  const ids = Array.isArray(scope?.allowedLocationIds) ? scope.allowedLocationIds.filter(Boolean).map(String) : [];
  return ids.length ? ids : null;
}

function defaultDeps() {
  return { prisma, latestPositionsByVehicle };
}

export const shuttleMonitorService = {
  /**
   * Cheap nav-visibility check: does the caller's scope contain at least one
   * location with the tracker ON? Same fail-closed rule as positions().
   */
  async enabled(scope = {}, depsOverride = {}) {
    const deps = { ...defaultDeps(), ...depsOverride };
    if (!scope?.tenantId) return { enabled: false };
    const allowed = allowedIds(scope);
    const count = await deps.prisma.shuttleTrackerConfig.count({
      where: {
        tenantId: scope.tenantId,
        mode: { not: 'OFF' },
        ...(allowed ? { locationId: { in: allowed } } : {}),
      },
    });
    return { enabled: count > 0 };
  },

  /**
   * Everything the monitor page draws: every shuttle-configured vehicle in
   * scope with its latest house-stored position and freshness, plus the open
   * request summary of each configured location.
   */
  async positions(scope = {}, depsOverride = {}, now = Date.now()) {
    const deps = { ...defaultDeps(), ...depsOverride };
    // Fail closed: no tenant, no map. (scopeFor already hands non-supers a
    // deny-all sentinel; this also refuses a super who picked no tenant.)
    if (!scope?.tenantId) return EMPTY();
    const allowed = allowedIds(scope);

    // Staff demand signal (innovation P1, 2026-08-25): the monitor is a
    // watcher too. Arming the same shuttle:watch key the customer page uses
    // wakes the fast poll for OneStepGPS-only tenants — otherwise the staff
    // map goes dark whenever no customer link is open. Best-effort.
    signalWatch(scope.tenantId).catch(() => {});

    const configs = await deps.prisma.shuttleTrackerConfig.findMany({
      where: {
        tenantId: scope.tenantId,
        mode: { not: 'OFF' },
        ...(allowed ? { locationId: { in: allowed } } : {}),
      },
    });
    if (!configs.length) return EMPTY();

    const locationIds = [...new Set(configs.map((c) => c.locationId).filter(Boolean))];
    // Location re-verified against the tenant — a re-tenanted location must
    // not keep feeding the old tenant's monitor (same rule as the tracker).
    const locations = await deps.prisma.location.findMany({
      where: { id: { in: locationIds }, tenantId: scope.tenantId },
      select: { id: true, name: true, latitude: true, longitude: true },
    });
    const locationById = Object.fromEntries(locations.map((l) => [l.id, l]));

    // Vehicle ownership re-verified on EVERY read (QA 2026-08-15) — a config
    // holding a transferred vehicle's id must not stream the new tenant's GPS.
    const allVehicleIds = [...new Set(configs.flatMap((c) => configVehicleIds(c)))];
    const ownedVehicles = allVehicleIds.length
      ? await deps.prisma.vehicle.findMany({
        where: { id: { in: allVehicleIds }, tenantId: scope.tenantId },
        select: { id: true, year: true, make: true, model: true, color: true, plate: true, internalNumber: true },
      })
      : [];
    const vehicleById = Object.fromEntries(ownedVehicles.map((v) => [v.id, v]));
    const ownedIds = ownedVehicles.map((v) => v.id);

    // "No device" is a mapping fact, not a stale-fix fact.
    const devices = ownedIds.length
      ? await deps.prisma.vehicleTelematicsDevice.findMany({
        where: { vehicleId: { in: ownedIds }, isActive: true },
        select: { vehicleId: true },
      })
      : [];
    const hasDevice = new Set(devices.map((d) => d.vehicleId));

    const fixes = await deps.latestPositionsByVehicle(ownedIds);

    const shuttles = [];
    for (const config of configs) {
      const location = locationById[config.locationId] || null;
      if (!location) continue; // config for a location no longer in this tenant
      for (const vehicleId of configVehicleIds(config)) {
        const vehicle = vehicleById[vehicleId];
        if (!vehicle) continue; // no longer owned — drop, exactly like the config save does
        shuttles.push(monitorShuttlePayload({
          vehicle,
          hasDevice: hasDevice.has(vehicleId),
          position: fixes[vehicleId] || null,
          config,
          location,
          now,
        }));
      }
    }

    // Open queue per configured location — the same pure query fragments the
    // shuttle-requests list uses (scopeWhere + OPEN_STATUSES), oldest first.
    const openRows = await deps.prisma.shuttleRequest.findMany({
      where: {
        ...scopeWhere(scope),
        status: { in: OPEN_STATUSES },
        locationId: { in: locationIds },
      },
      orderBy: { createdAt: 'asc' },
      select: { locationId: true, customerName: true, partySize: true, pickupNote: true, createdAt: true },
    });

    return {
      enabled: true,
      shuttles,
      requestsByLocation: summarizeOpenRequests(openRows, now),
      locations,
      generatedAt: new Date(now).toISOString(),
    };
  },

  /**
   * The Phase-2 alert feed (approved mockup Screen 5): normalized geofence
   * alerts, newest first, enriched with zone + vehicle labels via keyed
   * lookups (ShuttleZone/ShuttleAlert carry plain refs, no relations).
   *
   * SCOPING: tenant fail-closed like everything here. Location-scoped staff
   * see only alerts attributable to a zone at one of their sedes; zone-less
   * provider alerts (a rule made by hand in the provider's own UI) have no
   * location to check, so they are visible to unscoped staff only.
   */
  async alerts(scope = {}, { limit = 50 } = {}, depsOverride = {}) {
    const deps = { ...defaultDeps(), ...depsOverride };
    if (!scope?.tenantId) return { alerts: [] };
    const allowed = allowedIds(scope);
    const take = Math.min(200, Math.max(1, Number(limit) || 50));

    const zones = await deps.prisma.shuttleZone.findMany({
      where: {
        tenantId: scope.tenantId,
        ...(allowed ? { locationId: { in: allowed } } : {}),
      },
      select: { id: true, name: true, kind: true, locationId: true, isPickupSpot: true },
    });
    const zoneById = new Map(zones.map((z) => [z.id, z]));

    const rows = await deps.prisma.shuttleAlert.findMany({
      where: {
        tenantId: scope.tenantId,
        ...(allowed ? { zoneId: { in: zones.map((z) => z.id) } } : {}),
      },
      orderBy: { occurredAt: 'desc' },
      take,
    });

    // Vehicle labels — cosmetic keyed lookup, a failure never fails the feed.
    const vehicleIds = [...new Set(rows.map((r) => r.vehicleId).filter(Boolean))];
    let vehicleById = {};
    if (vehicleIds.length) {
      try {
        const vehicles = await deps.prisma.vehicle.findMany({
          where: { id: { in: vehicleIds }, tenantId: scope.tenantId },
          select: { id: true, make: true, model: true, plate: true },
        });
        vehicleById = Object.fromEntries(vehicles.map((v) => [v.id, v]));
      } catch { vehicleById = {}; }
    }

    return {
      alerts: rows.map((r) => {
        const zone = r.zoneId ? zoneById.get(r.zoneId) || null : null;
        const vehicle = r.vehicleId ? vehicleById[r.vehicleId] || null : null;
        return {
          id: r.id,
          type: r.type,
          occurredAt: r.occurredAt,
          zone: zone ? { id: zone.id, name: zone.name, kind: zone.kind, locationId: zone.locationId, isPickupSpot: zone.isPickupSpot } : null,
          vehicle: vehicle ? {
            id: vehicle.id,
            name: [vehicle.make, vehicle.model].map((p) => String(p || '').trim()).filter(Boolean).join(' ') || null,
            plate: vehicle.plate || null,
          } : null,
          staffNotifiedAt: r.staffNotifiedAt,
        };
      }),
    };
  },
};
