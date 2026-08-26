/**
 * Shuttle driver mode — the IO half (Phase 3 driver surface, 2026-08-25;
 * approved mockup Screens 12–15 + 17a). Decisions live in shuttle-driver.js.
 *
 * AUTH MODEL (approved): a driver holds a TOKENIZED PER-SHIFT LINK — no user
 * account, no login. Staff mint the link from the monitor (audited), it
 * expires end-of-day (24h max) and dies instantly on revoke. Everything
 * unusable (unknown, expired, revoked, tracker off, vehicle rotated out) is
 * the same bare 404 on the public surface — an enumerator gets no oracle.
 *
 * FAIL-CLOSED CHAIN on every token resolution, mirroring publicState:
 * shift ACTIVE → config exists for the shift's location AND belongs to the
 * shift's tenant AND mode != OFF → the shift's vehicle is still owned by the
 * tenant AND still in the config's vehicle list. Any doubt = null = 404.
 *
 * Deps are injectable for the DB-free suites; production passes none.
 */
import { prisma } from '../../lib/prisma.js';
import logger from '../../lib/logger.js';
import { sendEmail } from '../../lib/mailer.js';
import { configVehicleIds } from './shuttle-tracker-position.js';
import { signalWatch, readCustomerLocation, publishPosition, latestPositionsByVehicle } from './shuttle-tracker.service.js';
import { validateCustomerFix } from './shuttle-customer-location.js';
import { OPEN_STATUSES, scopeWhere } from './shuttle-query.js';
import { parseAlertRecipients } from './shuttle-zone-alerts.js';
import { shuttleRequestsService } from './shuttle-requests.service.js';
import { vehicleLabel } from './shuttle-monitor.js';
import {
  mintDriverToken, shiftExpiry, shiftState,
  validateIssueInput, validateDriverMessage, validateDriverName,
  driverZonePayload, driverRosterEntry, driverOwnPosition, driverClosedEntry,
  RECENTLY_CLOSED_MS, RECENTLY_CLOSED_MAX,
} from './shuttle-driver.js';
import crypto from 'node:crypto';

/**
 * Customer-facing brand for the driver page header (2026-08-26). The SAME
 * cascade the customer tracker runs — locationConfig → franchise → location
 * name → tenant — which by construction never yields the platform's own name.
 * Injectable so the DB-free suites need neither settings nor franchise tables.
 */
async function resolveBrandFn(deps) {
  if (deps.resolveBrandName) return deps.resolveBrandName;
  return async ({ tenantId, location }) => {
    const { settingsService } = await import('../settings/settings.service.js');
    const globalConfig = await settingsService.getRentalAgreementConfig({ tenantId });
    const { resolveCustomerFacingBrand } = await import('../../lib/tenant-brand.js');
    const brand = await resolveCustomerFacingBrand({ tenantId, location, globalConfig });
    return brand?.companyName || null;
  };
}

function defaultDeps() {
  return {
    prisma,
    logger,
    sendEmail,
    signalWatch,
    readCustomerLocation,
    publishPosition,
    latestPositionsByVehicle,
    // null = use the real settings/franchise cascade (see resolveBrandFn).
    resolveBrandName: null,
    requests: shuttleRequestsService,
    // Passed through to shuttleRequestsService.markNoShow/markPickedUp so the
    // DB-free suites can hand ONE in-memory prisma to both layers.
    requestsDeps: {},
    now: () => new Date(),
  };
}

function httpError(status, message, code = null) {
  const e = new Error(message);
  e.status = status;
  if (code) e.code = code;
  return e;
}

const clean = (v) => String(v || '').trim();

export const shuttleDriverService = {
  /**
   * Staff mint (monitor, Screen 12): { vehicleId, driverName, hours?,
   * locationId? } → a shift row + the one-time-displayed token. The vehicle
   * must be a CONFIGURED shuttle at a location inside the caller's scope —
   * the config list is the "this is a shuttle" marker everywhere else, and a
   * driver link must not be mintable for an arbitrary unit. locationId
   * disambiguates a vehicle serving several configured sedes.
   */
  async mintShift({ vehicleId, driverName, hours = null, locationId = null } = {}, scope = {}, userId = null, depsOverride = {}) {
    const deps = { ...defaultDeps(), ...depsOverride };
    if (!scope?.tenantId) throw httpError(400, 'tenantId scope is required');

    const nameCheck = validateDriverName(driverName);
    if (!nameCheck.ok) throw httpError(400, nameCheck.error);
    const cleanVehicleId = clean(vehicleId);
    if (!cleanVehicleId) throw httpError(400, 'vehicleId is required');
    const h = hours == null || hours === '' ? null : Number(hours);
    if (h !== null && (!Number.isFinite(h) || h < 1 || h > 24)) {
      throw httpError(400, 'hours must be between 1 and 24');
    }

    // Ownership first — a foreign vehicle id reads as not-a-shuttle, not as
    // an existence oracle.
    const vehicle = await deps.prisma.vehicle.findFirst({
      where: { id: cleanVehicleId, tenantId: scope.tenantId },
      select: { id: true },
    });
    if (!vehicle) throw httpError(400, 'Vehicle is not a configured shuttle');

    const allowed = Array.isArray(scope?.allowedLocationIds) && scope.allowedLocationIds.length
      ? scope.allowedLocationIds.map(String)
      : null;
    const configs = await deps.prisma.shuttleTrackerConfig.findMany({
      where: {
        tenantId: scope.tenantId,
        mode: { not: 'OFF' },
        ...(allowed ? { locationId: { in: allowed } } : {}),
      },
    });
    const serving = configs.filter((c) => configVehicleIds(c).includes(cleanVehicleId));
    const wanted = clean(locationId);
    const matches = wanted ? serving.filter((c) => c.locationId === wanted) : serving;
    if (!matches.length) throw httpError(400, 'Vehicle is not a configured shuttle at a location in your scope');
    if (matches.length > 1) {
      throw httpError(400, 'Vehicle serves multiple locations — pass locationId to pick one');
    }

    const now = deps.now();
    const shift = await deps.prisma.shuttleDriverShift.create({
      data: {
        tenantId: scope.tenantId,
        locationId: matches[0].locationId,
        vehicleId: cleanVehicleId,
        driverName: nameCheck.driverName,
        token: mintDriverToken(),
        expiresAt: shiftExpiry({ hours: h, now }),
        createdByUserId: userId || null,
      },
    });
    return shift; // token included — shown ONCE in the mint response, never re-listed
  },

  /**
   * Active shifts for the monitor UI. The TOKEN is deliberately absent — it
   * is displayed once at mint (same one-time rule as service tokens); a lost
   * link means revoke + re-mint, not a re-read.
   */
  async listShifts(scope = {}, depsOverride = {}) {
    const deps = { ...defaultDeps(), ...depsOverride };
    if (!scope?.tenantId) return { shifts: [] };
    const now = deps.now();
    const rows = await deps.prisma.shuttleDriverShift.findMany({
      where: {
        ...scopeWhere(scope),
        revokedAt: null,
        expiresAt: { gt: now },
      },
      orderBy: { createdAt: 'desc' },
    });

    // Cosmetic keyed lookups (tenant-guarded, a failure never fails the list).
    const vehicleIds = [...new Set(rows.map((r) => r.vehicleId).filter(Boolean))];
    const locationIds = [...new Set(rows.map((r) => r.locationId).filter(Boolean))];
    let vehicleById = {};
    let locationById = {};
    try {
      const [vehicles, locations] = await Promise.all([
        vehicleIds.length
          ? deps.prisma.vehicle.findMany({
            where: { id: { in: vehicleIds }, tenantId: scope.tenantId },
            select: { id: true, year: true, make: true, model: true, plate: true, internalNumber: true },
          })
          : [],
        locationIds.length
          ? deps.prisma.location.findMany({
            where: { id: { in: locationIds }, tenantId: scope.tenantId },
            select: { id: true, name: true },
          })
          : [],
      ]);
      vehicleById = Object.fromEntries(vehicles.map((v) => [v.id, v]));
      locationById = Object.fromEntries(locations.map((l) => [l.id, l]));
    } catch { vehicleById = {}; locationById = {}; }

    return {
      shifts: rows.map((r) => ({
        id: r.id,
        driverName: r.driverName,
        vehicleId: r.vehicleId,
        vehicleLabel: vehicleById[r.vehicleId] ? vehicleLabel(vehicleById[r.vehicleId]) : null,
        plate: vehicleById[r.vehicleId]?.plate || null,
        locationId: r.locationId,
        locationName: locationById[r.locationId]?.name || null,
        expiresAt: r.expiresAt,
        createdAt: r.createdAt,
      })),
    };
  },

  /** Revoke — the link dies now. Scoped fail-closed; idempotent. */
  async revokeShift(id, scope = {}, depsOverride = {}) {
    const deps = { ...defaultDeps(), ...depsOverride };
    const row = await deps.prisma.shuttleDriverShift.findFirst({
      where: { id: clean(id), ...scopeWhere(scope) },
    });
    if (!row) throw httpError(404, 'Shift not found');
    if (row.revokedAt) return row;
    return deps.prisma.shuttleDriverShift.update({
      where: { id: row.id },
      data: { revokedAt: deps.now() },
    });
  },

  /**
   * Staff→driver message (Screen 12 "Notificar al conductor"). Only an
   * ACTIVE shift accepts one — messaging a dead link is a 409 the UI can
   * explain, not a silent write nobody will ever read.
   */
  async notifyShift(id, message, scope = {}, userId = null, depsOverride = {}) {
    const deps = { ...defaultDeps(), ...depsOverride };
    const check = validateDriverMessage(message);
    if (!check.ok) throw httpError(400, check.error);
    const row = await deps.prisma.shuttleDriverShift.findFirst({
      where: { id: clean(id), ...scopeWhere(scope) },
    });
    if (!row) throw httpError(404, 'Shift not found');
    if (shiftState(row, deps.now().getTime()) !== 'ACTIVE') {
      throw httpError(409, 'Shift is no longer active');
    }
    const msg = await deps.prisma.shuttleDriverMessage.create({
      data: {
        tenantId: row.tenantId,
        shiftId: row.id,
        message: check.message,
        createdByUserId: userId || null,
      },
    });
    return { ok: true, id: msg.id };
  },

  /**
   * Token → full working context, or null (the route's bare 404). The chain
   * re-verifies EVERYTHING on every call — config mode, config tenant,
   * vehicle ownership, vehicle-still-configured — because any of them can
   * change mid-shift and the link must die with them.
   */
  async resolveShift(token, depsOverride = {}) {
    const deps = { ...defaultDeps(), ...depsOverride };
    const t = clean(token);
    if (!t || t.length < 16) return null;

    const shift = await deps.prisma.shuttleDriverShift.findUnique({ where: { token: t } });
    if (shiftState(shift, deps.now().getTime()) !== 'ACTIVE') return null;

    const config = await deps.prisma.shuttleTrackerConfig.findUnique({
      where: { locationId: shift.locationId },
    });
    if (!config || config.tenantId !== shift.tenantId || config.mode === 'OFF') return null;

    // Ownership re-verified on EVERY read (QA 2026-08-15 rule): the owned
    // config vehicles feed roster assignment labels too, so fetch them all.
    const configuredIds = configVehicleIds(config);
    if (!configuredIds.includes(shift.vehicleId)) return null;
    const owned = configuredIds.length
      ? await deps.prisma.vehicle.findMany({
        where: { id: { in: configuredIds }, tenantId: shift.tenantId },
        select: { id: true, make: true, model: true, color: true, plate: true },
      })
      : [];
    const vehicle = owned.find((v) => v.id === shift.vehicleId) || null;
    if (!vehicle) return null;

    return { shift, config, vehicle, ownedVehicles: owned };
  },

  /**
   * The driver page payload (Screens 13/14): shift + vehicle + location +
   * zones/pickup spots (geometry for drawing) + the ROSTER of open requests
   * at the location. Customer coordinates cross ONLY for sharing customers —
   * Redis-only read, never logged, never persisted (same treatment as the
   * staff monitor, because the driver is the one picking them up).
   *
   * DELIBERATE PAYLOAD ADDITIONS (2026-08-26), each picked field-by-field:
   *   • brandName      the customer-facing brand cascade (never the platform's
   *                    own name) — the header the driver shows a customer;
   *   • deviceMapped   does this van have an active telematics device? The
   *                    page previously learned this only from a POST /position
   *                    echo, i.e. after already asking for the phone's GPS;
   *   • ownPosition    {status, ageSeconds, latitude?, longitude?} — the van's
   *                    own fix from HOUSE storage on the shared 90s/4min
   *                    thresholds, for the "GPS LIVE · 14s" chip;
   *   • recentlyClosed COMPLETED/NO_SHOW at this sede in the last 60 minutes
   *                    (id, name, status, closedAt) so a tapped card becomes
   *                    history instead of vanishing.
   * No phone numbers and no new coordinates beyond the van's own.
   */
  async shiftContext(token, depsOverride = {}) {
    const deps = { ...defaultDeps(), ...depsOverride };
    const ctx = await this.resolveShift(token, depsOverride);
    if (!ctx) return null;
    const { shift, config, vehicle, ownedVehicles } = ctx;
    const now = deps.now().getTime();

    const [location, zones, openRows, closedRows, deviceCount] = await Promise.all([
      deps.prisma.location.findFirst({
        where: { id: shift.locationId, tenantId: shift.tenantId },
        // locationConfig feeds the brand cascade ONLY — it never crosses.
        select: { id: true, name: true, latitude: true, longitude: true, locationConfig: true },
      }),
      deps.prisma.shuttleZone.findMany({
        where: { tenantId: shift.tenantId, locationId: shift.locationId, active: true },
        select: {
          id: true, name: true, kind: true, isPickupSpot: true,
          geometryJson: true, toleranceM: true, walkingDirections: true,
          walkingDirectionsEs: true,
        },
      }),
      deps.prisma.shuttleRequest.findMany({
        // Tenant AND location pinned to the SHIFT's own — a token never reads
        // another sede's queue, let alone another tenant's.
        where: { tenantId: shift.tenantId, locationId: shift.locationId, status: { in: OPEN_STATUSES } },
        orderBy: { createdAt: 'asc' },
        select: {
          id: true, customerName: true, partySize: true, bags: true, status: true,
          pickupNote: true, pickupSpotZoneId: true, assignedVehicleId: true, createdAt: true,
        },
      }),
      // "Recién cerrados" (2026-08-26): what this sede closed in the last
      // hour, so the roster can show history instead of a card vanishing the
      // instant the driver taps it. Same tenant+location pin as the open
      // queue — never another sede's, never another tenant's.
      deps.prisma.shuttleRequest.findMany({
        where: {
          tenantId: shift.tenantId,
          locationId: shift.locationId,
          status: { in: ['COMPLETED', 'NO_SHOW'] },
          closedAt: { gte: new Date(now - RECENTLY_CLOSED_MS) },
        },
        orderBy: { closedAt: 'desc' },
        take: RECENTLY_CLOSED_MAX,
        select: { id: true, customerName: true, status: true, closedAt: true },
      }).catch(() => []),
      // Is this van device-mapped? The page used to learn this only from a
      // POST /position echo — i.e. after already asking for the phone's GPS.
      deps.prisma.vehicleTelematicsDevice.count({
        where: { vehicleId: shift.vehicleId, isActive: true },
      }).catch(() => 0),
    ]);
    // A re-tenanted location kills the link, same as the tracker.
    if (!location) return null;

    const zoneNameById = new Map(zones.map((z) => [z.id, z.name]));
    const vehicleById = Object.fromEntries(ownedVehicles.map((v) => [v.id, v]));

    const roster = await Promise.all(openRows.map(async (r) => {
      let fix = null;
      try { fix = await deps.readCustomerLocation(r.id); } catch { fix = null; }
      return driverRosterEntry({
        request: r,
        fix,
        spotName: r.pickupSpotZoneId ? zoneNameById.get(r.pickupSpotZoneId) || null : null,
        shiftVehicleId: shift.vehicleId,
        assignedVehicle: r.assignedVehicleId ? vehicleById[r.assignedVehicleId] || null : null,
        now,
      });
    }));

    // The driver page is a watcher too — arm the fast poll (best-effort).
    try { await deps.signalWatch(shift.tenantId); } catch { /* signal only */ }

    // The van's OWN fix, from the same HOUSE storage the monitor reads (Redis
    // fix written by the fast poll / simulator / this driver's own pushes,
    // Postgres fallback) — never a provider call from here. Best-effort: no
    // GPS chip is better than a dead driver page.
    let ownPosition = null;
    try {
      const fixes = await deps.latestPositionsByVehicle([shift.vehicleId]);
      ownPosition = driverOwnPosition(fixes?.[shift.vehicleId] || null, now);
    } catch { ownPosition = driverOwnPosition(null, now); }

    // Customer-facing brand for the header — the cascade, never the platform
    // name. Branding must never be able to break the page that renders it.
    let brandName = null;
    try {
      brandName = clean(await (await resolveBrandFn(deps))({ tenantId: shift.tenantId, location })) || null;
    } catch (err) {
      deps.logger.warn('[shuttle-driver] brand resolution failed', { shiftId: shift.id, message: err.message });
    }

    // PICKED, never spread — the public-payload law.
    const vehicleName = [vehicle.make, vehicle.model].map((p) => clean(p)).filter(Boolean).join(' ') || null;
    return {
      driverName: shift.driverName,
      expiresAt: shift.expiresAt,
      // ── deliberate driver-payload additions (2026-08-26) ──────────────────
      brandName,
      // A device-mapped van's GPS is the truth; the page uses this to stop
      // asking for the phone's location at all (it used to find out only from
      // a POST /position echo, i.e. after already asking).
      deviceMapped: Number(deviceCount) > 0,
      ownPosition,
      recentlyClosed: closedRows.map((r) => driverClosedEntry(r)),
      // ─────────────────────────────────────────────────────────────────────
      mode: config.mode === 'NON_STOP' ? 'NON_STOP' : 'ON_DEMAND',
      headwayMinutes: Number.isFinite(Number(config.headwayMinutes)) ? Number(config.headwayMinutes) : null,
      vehicle: {
        name: vehicleName,
        color: clean(vehicle.color) || null,
        plate: clean(vehicle.plate) || null,
      },
      location: {
        name: location.name || null,
        ...(Number.isFinite(Number(location.latitude)) && Number.isFinite(Number(location.longitude))
          ? { latitude: Number(location.latitude), longitude: Number(location.longitude) }
          : {}),
      },
      zones: zones.map((z) => driverZonePayload(z)),
      roster,
      generatedAt: new Date(now).toISOString(),
    };
  },

  /**
   * Driver-phone position fallback (Screen 13). Publishes through the SAME
   * house write path as the pollers — a VehicleTelematicsEvent row (source
   * DRIVER_PHONE) + the Redis fix — but ONLY when the vehicle has NO active
   * telematics device: a device-mapped shuttle's GPS is the truth and a
   * phone in the driver's pocket must never fight it. Coordinates are never
   * logged (Screen 9 privacy law applies to the driver too).
   *
   * @returns {null|{ok:true, accepted:boolean}} null = unusable token (404)
   */
  async pushPosition(token, body = {}, depsOverride = {}) {
    const deps = { ...defaultDeps(), ...depsOverride };
    const ctx = await this.resolveShift(token, depsOverride);
    if (!ctx) return null;
    const { shift } = ctx;

    const check = validateCustomerFix(body);
    if (!check.ok) throw httpError(400, check.error);

    const mapped = await deps.prisma.vehicleTelematicsDevice.count({
      where: { vehicleId: shift.vehicleId, isActive: true },
    });
    if (mapped > 0) {
      // Device wins. Accept the POST (the page keeps its cadence without
      // erroring) but store nothing.
      return { ok: true, accepted: false, reason: 'DEVICE_MAPPED' };
    }

    const eventAt = deps.now();
    await deps.prisma.vehicleTelematicsEvent.create({
      data: {
        tenantId: shift.tenantId,
        vehicleId: shift.vehicleId,
        eventType: 'PING',
        eventAt,
        latitude: check.fix.lat,
        longitude: check.fix.lng,
        payloadJson: JSON.stringify({ source: 'DRIVER_PHONE', shiftId: shift.id }),
      },
    }).catch(() => {}); // Redis still gets the fix; the row is best-effort (writeFix rule)
    await deps.publishPosition(shift.vehicleId, {
      latitude: check.fix.lat,
      longitude: check.fix.lng,
      heading: null,
      speedMph: null,
      eventAt: eventAt.toISOString(),
    });
    return { ok: true, accepted: true };
  },

  /**
   * "✓ Recogido" from the driver (Screen 17a) — the EXISTING markPickedUp
   * service, scoped to the shift's own tenant+location so a request from
   * anywhere else fails closed as a plain 404.
   */
  async markPickedUp(token, requestId, depsOverride = {}) {
    const deps = { ...defaultDeps(), ...depsOverride };
    const ctx = await this.resolveShift(token, depsOverride);
    if (!ctx) return null;
    const scope = { tenantId: ctx.shift.tenantId, allowedLocationIds: [ctx.shift.locationId] };
    const row = await deps.requests.markPickedUp(clean(requestId), scope, null, `driver: ${ctx.shift.driverName}`.slice(0, 120), deps.requestsDeps);
    return { ok: true, id: row.id, status: row.status };
  },

  /**
   * Driver no-show (Screen 17a) — the EXISTING markNoShow with its full
   * fan-out (customer SMS, REQUEST_NO_SHOW alert, staff email). The mockup's
   * confirm dialog is a CONTRACT: without body.confirmed === true this is a
   * 400 before any state is touched.
   */
  async markNoShow(token, requestId, body = {}, depsOverride = {}) {
    const deps = { ...defaultDeps(), ...depsOverride };
    if (body?.confirmed !== true) {
      throw httpError(400, 'confirmed: true is required to mark a no-show', 'CONFIRM_REQUIRED');
    }
    const ctx = await this.resolveShift(token, depsOverride);
    if (!ctx) return null;
    const scope = { tenantId: ctx.shift.tenantId, allowedLocationIds: [ctx.shift.locationId] };
    const out = await deps.requests.markNoShow(clean(requestId), {
      scope,
      userId: null,
      reason: `driver: ${ctx.shift.driverName}`.slice(0, 120),
      actorContext: 'driver',
    }, deps.requestsDeps);
    return { ok: true, id: out.request.id, status: out.request.status };
  },

  /** Store→driver messages, newest first, last 20 (Screen 14 banner). */
  async listNotifications(token, depsOverride = {}) {
    const deps = { ...defaultDeps(), ...depsOverride };
    const ctx = await this.resolveShift(token, depsOverride);
    if (!ctx) return null;
    const rows = await deps.prisma.shuttleDriverMessage.findMany({
      where: { tenantId: ctx.shift.tenantId, shiftId: ctx.shift.id },
      orderBy: { createdAt: 'desc' },
      take: 20,
    });
    return {
      messages: rows.map((m) => ({ id: m.id, message: m.message, at: m.createdAt })),
    };
  },

  /**
   * Driver issue report (Screen 15) → a ShuttleAlert row typed DRIVER_ISSUE
   * (the staff monitor's alert feed) + best-effort email to the location's
   * EMAIL-channel alert recipients.
   *
   * WHY NOT the Issue Center: its TripIncident model requires a Trip or
   * Reservation anchor — tenant visibility (incidentTenantWhere) resolves
   * ONLY through those relations, so an anchorless incident would be
   * invisible to the very staff it is for — and its `type` is a closed
   * Prisma enum (DAMAGE|TOLL|CLEANING|LATE_RETURN|OTHER) that a shift-level
   * MECANICO/TRAFICO report does not fit. A driver issue is about the
   * SHUTTLE and the SHIFT, not a rental contract; the sanctioned degrade
   * path (ShuttleAlert + recipients email) is the honest fit.
   */
  async reportIssue(token, body = {}, depsOverride = {}) {
    const deps = { ...defaultDeps(), ...depsOverride };
    const check = validateIssueInput(body);
    if (!check.ok) throw httpError(400, check.error);
    const ctx = await this.resolveShift(token, depsOverride);
    if (!ctx) return null;
    const { shift, config, vehicle } = ctx;
    const occurredAt = deps.now();

    // Unique per report — a driver CAN file two MECANICO issues in one shift.
    const providerRef = `drvissue:${shift.id}:${crypto.randomBytes(6).toString('hex')}`;
    const alertRow = await deps.prisma.shuttleAlert.create({
      data: {
        tenantId: shift.tenantId,
        zoneId: null,
        vehicleId: shift.vehicleId,
        type: 'DRIVER_ISSUE',
        occurredAt,
        providerRef,
        // ids + the driver's own words only — no coordinates, no customer PII.
        rawJson: JSON.stringify({
          shiftId: shift.id,
          category: check.issue.category,
          note: check.issue.note,
          driverName: shift.driverName,
        }),
      },
    });

    // Best-effort staff email (the Phase-2 recipients list, EMAIL channel).
    try {
      const recipients = parseAlertRecipients(config?.alertRecipientsJson)
        .filter((r) => r.channels.includes('EMAIL') && r.email);
      if (recipients.length) {
        let locationName = null;
        try {
          const loc = await deps.prisma.location.findFirst({
            where: { id: shift.locationId, tenantId: shift.tenantId },
            select: { name: true },
          });
          locationName = loc?.name || null;
        } catch { locationName = null; }
        const label = [vehicle.make, vehicle.model].map((p) => clean(p)).filter(Boolean).join(' ') || 'Shuttle';
        const plate = clean(vehicle.plate);
        const subject = `Driver issue (${check.issue.category}): ${label}${plate ? ` · ${plate}` : ''}${locationName ? ` — ${locationName}` : ''}`;
        const text = [
          `Driver: ${shift.driverName}`,
          `Category: ${check.issue.category}`,
          check.issue.note ? `Note: ${check.issue.note}` : null,
          `Vehicle: ${label}${plate ? ` (${plate})` : ''}`,
          locationName ? `Location: ${locationName}` : null,
          `At: ${occurredAt.toISOString()}`,
        ].filter(Boolean).join('\n');
        for (const r of recipients) {
          try {
            await deps.sendEmail({ tenantId: shift.tenantId, to: r.email, subject, text });
          } catch (err) {
            deps.logger.warn('[shuttle-driver] issue email failed', { tenantId: shift.tenantId, shiftId: shift.id, message: err.message });
          }
        }
      }
    } catch (err) {
      deps.logger.warn('[shuttle-driver] issue fan-out failed', { shiftId: shift.id, message: err.message });
    }

    // "Reporte #…" (2026-08-26): the created ShuttleAlert id, so the driver
    // has something to quote on the radio. An id only — the row's contents
    // stay on the staff feed.
    return { ok: true, reportId: String(alertRow?.id || '') || null };
  },
};
