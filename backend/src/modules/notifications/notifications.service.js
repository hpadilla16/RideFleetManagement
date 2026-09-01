// Notification Center — the READ side (2026-09-01).
//
// Source of truth: design/mockups/notification-center-mockup.html +
// notifications-NOTES.md. The center AGGREGATES the existing alert surfaces
// (it replaces nothing in v1); this service owns the feed, the per-user read
// state, and the per-tenant acknowledge with delegation to the source module
// where one already exists.
//
// The two-plane model (NOTES §6, mock callouts):
// - READ is per-user (NotificationRead rows). It clears the bell and tints
//   the row for that user only. "Mark all read" never acknowledges work
//   items on behalf of the team.
// - ACKNOWLEDGE is per-tenant and shows WHO + WHEN. For sources that already
//   own a resolution state it DELEGATES: GEOFENCE → the dashboard dismiss
//   (OverdueVehicleAlert status DISMISSED), TOLL → tollsService
//   .acknowledgeTollAlert (staffAckAt). The envelope stamp is display
//   metadata — never a parallel resolution state.
//
// Scoping: same effectiveLocationIds machinery as every module. Rows with a
// null locationId are tenant-wide and visible to every caller of the tenant.
// Role gate: audienceRole='ADMIN' rows (billing dunning) are filtered at the
// API for non-admin roles — never in the client.

import { prisma } from '../../lib/prisma.js';
import { effectiveLocationIds } from '../../lib/tenant-scope.js';
import {
  NOTIFICATION_SEVERITIES,
  NOTIFICATION_SOURCE_TYPES,
} from './notifications-emit.js';

export { NOTIFICATION_SEVERITIES, NOTIFICATION_SOURCE_TYPES };

// The bell badge counts unread CRITICAL + NEEDS_ACTION only — INFO never
// badges (fixed severity contract, NOTES §6 / MVP item 2).
export const BADGE_SEVERITIES = Object.freeze(['CRITICAL', 'NEEDS_ACTION']);

// Roles allowed to see audienceRole='ADMIN' rows (billing).
const ADMIN_ROLES = Object.freeze(['ADMIN', 'SUPER_ADMIN']);

const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 100;
// Bounded id scans for the unread math and mark-all-read. The badge caps at
// 99+ anyway; nobody needs an exact count past this.
const UNREAD_SCAN_CAP = 500;

function isAdminRole(role) {
  return ADMIN_ROLES.includes(String(role || '').toUpperCase());
}

/**
 * The visibility filter every read goes through. Fail-closed: no tenant on
 * the scope (e.g. SUPER_ADMIN without ?tenantId) matches nothing rather than
 * everything.
 */
export function visibilityWhere(query = {}, scope = {}, caller = {}) {
  const AND = [
    { tenantId: scope?.tenantId || '__no_tenant__' },
    { archivedAt: null },
  ];
  const effLocIds = effectiveLocationIds(query, scope);
  if (effLocIds) {
    // Location-scoped caller: own sedes + tenant-wide (null-location) rows.
    AND.push({ OR: [{ locationId: { in: effLocIds } }, { locationId: null }] });
  }
  if (!isAdminRole(caller?.role)) {
    // MVP: the only audienceRole in use is 'ADMIN' (billing). Non-admins see
    // only unrestricted rows.
    AND.push({ audienceRole: null });
  }
  return { AND };
}

function serialize(row, readSet) {
  return {
    id: row.id,
    locationId: row.locationId,
    severity: row.severity,
    sourceType: row.sourceType,
    sourceRefId: row.sourceRefId,
    title: row.title,
    body: row.body,
    deepLink: row.deepLink,
    templateKey: row.templateKey,
    params: row.paramsJson ? safeParse(row.paramsJson) : null,
    audienceRole: row.audienceRole,
    ackAt: row.ackAt,
    ackByName: row.ackByName,
    resolvedAt: row.resolvedAt,
    createdAt: row.createdAt,
    read: readSet ? readSet.has(row.id) : false,
  };
}

function safeParse(s) {
  try { return JSON.parse(s); } catch { return null; }
}

export const notificationsService = {
  /**
   * The feed. Filters: severity, sourceType, tab ('inbox' | 'acknowledged'),
   * before (ISO cursor). Returns { items, total, counts, unread } — `total`
   * feeds the honest "Showing a of b" footer; `counts` feeds the lane rail
   * (severity + sourceType, DB-counted like tolls queueCounts).
   */
  async list(query = {}, scope = {}, caller = {}) {
    const where = visibilityWhere(query, scope, caller);
    const AND = [...where.AND];
    if (query.severity && NOTIFICATION_SEVERITIES.includes(query.severity)) {
      AND.push({ severity: query.severity });
    }
    if (query.sourceType && NOTIFICATION_SOURCE_TYPES.includes(query.sourceType)) {
      AND.push({ sourceType: query.sourceType });
    }
    if (String(query.tab || '') === 'acknowledged') {
      AND.push({ ackAt: { not: null } });
    }
    const before = query.before ? new Date(query.before) : null;
    if (before && !Number.isNaN(before.getTime())) {
      AND.push({ createdAt: { lt: before } });
    }
    const limit = Math.min(Math.max(Number(query.limit) || DEFAULT_LIMIT, 1), MAX_LIMIT);

    const [rows, total, bySeverity, bySourceType] = await Promise.all([
      prisma.notificationEvent.findMany({
        where: { AND },
        orderBy: { createdAt: 'desc' },
        take: limit,
      }),
      prisma.notificationEvent.count({ where }),
      prisma.notificationEvent.groupBy({ by: ['severity'], where, _count: { _all: true } }),
      prisma.notificationEvent.groupBy({ by: ['sourceType'], where, _count: { _all: true } }),
    ]);

    const readSet = await this._readSetFor(caller?.id, rows.map((r) => r.id));
    const unread = await this.unreadCount(query, scope, caller);
    return {
      items: rows.map((r) => serialize(r, readSet)),
      total,
      counts: {
        severity: Object.fromEntries(bySeverity.map((g) => [g.severity, g._count._all])),
        sourceType: Object.fromEntries(bySourceType.map((g) => [g.sourceType, g._count._all])),
      },
      unread,
    };
  },

  async _readSetFor(userId, ids) {
    if (!userId || !ids.length) return new Set();
    const reads = await prisma.notificationRead.findMany({
      where: { userId, notificationId: { in: ids } },
      select: { notificationId: true },
    });
    return new Set(reads.map((r) => r.notificationId));
  },

  /**
   * The bell badge: this user's unread CRITICAL + NEEDS_ACTION, unresolved
   * and unacknowledged, within their location scope. INFO never counts.
   */
  async unreadCount(query = {}, scope = {}, caller = {}) {
    const where = visibilityWhere(query, scope, caller);
    const rows = await prisma.notificationEvent.findMany({
      where: {
        AND: [
          ...where.AND,
          { severity: { in: [...BADGE_SEVERITIES] } },
          { resolvedAt: null },
          { ackAt: null },
        ],
      },
      select: { id: true },
      orderBy: { createdAt: 'desc' },
      take: UNREAD_SCAN_CAP,
    });
    if (!rows.length) return 0;
    const readSet = await this._readSetFor(caller?.id, rows.map((r) => r.id));
    return rows.length - readSet.size;
  },

  /** Per-user read mark. Idempotent; 404s outside the caller's visibility. */
  async markRead(id, query = {}, scope = {}, caller = {}) {
    const row = await prisma.notificationEvent.findFirst({
      where: { AND: [...visibilityWhere(query, scope, caller).AND, { id: String(id) }] },
      select: { id: true },
    });
    if (!row) { const e = new Error('Notification not found'); e.status = 404; throw e; }
    if (!caller?.id) { const e = new Error('No user'); e.status = 401; throw e; }
    await prisma.notificationRead.upsert({
      where: { userId_notificationId: { userId: caller.id, notificationId: row.id } },
      update: {},
      create: { userId: caller.id, notificationId: row.id },
    });
    return { ok: true };
  },

  /** "Mark all read" — clears the PERSONAL badge only, never acknowledges. */
  async markAllRead(query = {}, scope = {}, caller = {}) {
    if (!caller?.id) { const e = new Error('No user'); e.status = 401; throw e; }
    const rows = await prisma.notificationEvent.findMany({
      where: visibilityWhere(query, scope, caller),
      select: { id: true },
      orderBy: { createdAt: 'desc' },
      take: UNREAD_SCAN_CAP,
    });
    if (!rows.length) return { ok: true, marked: 0 };
    const result = await prisma.notificationRead.createMany({
      data: rows.map((r) => ({ userId: caller.id, notificationId: r.id })),
      skipDuplicates: true,
    });
    return { ok: true, marked: result?.count ?? rows.length };
  },

  /**
   * Team-visible acknowledge. Delegates to the source's own endpoint where
   * one exists so the center never forks state:
   *   GEOFENCE → OverdueVehicleAlert dismiss (same write as the dashboard
   *              button, vehicles.routes.js POST /overdue-alerts/:id/dismiss)
   *   TOLL     → tollsService.acknowledgeTollAlert (staffAckAt)
   * Everything else (SHUTTLE, KIOSK, BILLING, MAINTENANCE, DOCUMENTS) has no
   * source-side resolution state today → center-local stamp only (NOTES B4).
   */
  async acknowledge(id, query = {}, scope = {}, caller = {}) {
    const row = await prisma.notificationEvent.findFirst({
      where: { AND: [...visibilityWhere(query, scope, caller).AND, { id: String(id) }] },
    });
    if (!row) { const e = new Error('Notification not found'); e.status = 404; throw e; }
    if (row.ackAt) {
      return { ok: true, alreadyAcknowledged: true, ackAt: row.ackAt, ackByName: row.ackByName };
    }

    // Delegation first — if the source refuses, the envelope stays unacked.
    if (row.sourceType === 'GEOFENCE' && row.sourceRefId) {
      // Same statement as the dashboard dismiss route. updateMany count 0 just
      // means the alert already left OPEN (resolved/dismissed) — fine to ack.
      await prisma.overdueVehicleAlert.updateMany({
        where: { id: row.sourceRefId, tenantId: row.tenantId, status: 'OPEN' },
        data: { status: 'DISMISSED', resolvedAt: new Date() },
      });
    } else if (row.sourceType === 'TOLL' && row.sourceRefId) {
      // Dynamic import: tolls.service imports notifications-emit, so a static
      // import here would be a cycle. acknowledgeTollAlert re-checks location
      // scope internally (getTransactionOrThrow).
      const { tollsService } = await import('../tolls/tolls.service.js');
      await tollsService.acknowledgeTollAlert(row.sourceRefId, scope, caller?.id || null);
    }

    const ackAt = new Date();
    await prisma.notificationEvent.update({
      where: { id: row.id },
      data: {
        ackAt,
        ackByUserId: caller?.id || null,
        ackByName: caller?.name || null,
      },
    });
    // Acknowledging implies the acker has seen it.
    if (caller?.id) {
      await prisma.notificationRead.upsert({
        where: { userId_notificationId: { userId: caller.id, notificationId: row.id } },
        update: {},
        create: { userId: caller.id, notificationId: row.id },
      }).catch(() => null);
    }
    return { ok: true, alreadyAcknowledged: false, ackAt, ackByName: caller?.name || null };
  },

  /**
   * 30-day auto-archive (the honest footer line). Bounded batch — never an
   * unbounded mass update. Reads for archived rows are pruned so the join
   * table does not grow forever. Called by the daily notifications sweep.
   */
  async archiveOldNotifications({ now = new Date(), days = 30, batch = 1000 } = {}) {
    const cutoff = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
    const rows = await prisma.notificationEvent.findMany({
      where: { archivedAt: null, createdAt: { lt: cutoff } },
      select: { id: true },
      take: batch,
    });
    if (!rows.length) return { archived: 0 };
    const ids = rows.map((r) => r.id);
    await prisma.notificationEvent.updateMany({
      where: { id: { in: ids } },
      data: { archivedAt: now },
    });
    await prisma.notificationRead.deleteMany({
      where: { notificationId: { in: ids } },
    }).catch(() => null);
    return { archived: ids.length };
  },
};
