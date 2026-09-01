// Notification Center — the EMIT side (2026-09-01).
//
// Deliberately dependency-light (prisma + logger only) so the five emitter
// call sites (overdue-locate, tolls staff alert, shuttle no-show, kiosk
// escalation, billing dunning) and the daily sweep can import it without
// widening their import graphs or risking a cycle with notifications.service
// (which dynamically imports source modules for ack delegation).
//
// Contract (design/mockups/notifications-NOTES.md §6):
// - An emitter is a PURE ADD-ON at an existing choke point. It must NEVER
//   break the host flow — hence every exported helper is a *Safe variant that
//   catches and logs instead of throwing.
// - Idempotency: upsert on the (tenantId, dedupeKey) unique with `update: {}`
//   — re-detection of the same condition is a no-op, never a duplicate row
//   and never a "bump to unread". Same pattern as ShuttleAlert providerRef.
// - Severity is data, not CSS: CRITICAL | NEEDS_ACTION | INFO only.

import { prisma } from '../../lib/prisma.js';
import logger from '../../lib/logger.js';

export const NOTIFICATION_SEVERITIES = Object.freeze(['CRITICAL', 'NEEDS_ACTION', 'INFO']);

// Sources wired in the MVP. DOCUMENTS covers registration/marbete expiry.
// CHECKIN_AUDIT (2026-09-03): post-check-in T1 rules audit — entry-error
// findings emit NEEDS_ACTION, deduped per reservation+check.
// FLEET (2026-09-01, backlog #5): idle-vehicle daily sweep — one envelope per
// vehicle per idle episode, severity from the tenant's idleVehicleConfig.
export const NOTIFICATION_SOURCE_TYPES = Object.freeze([
  'GEOFENCE', 'TOLL', 'SHUTTLE', 'KIOSK', 'BILLING', 'MAINTENANCE', 'DOCUMENTS',
  'CHECKIN_AUDIT', 'FLEET',
]);

/**
 * Create the envelope row if (tenantId, dedupeKey) has never been seen.
 * Throws on invalid input; callers in host flows use emitNotificationSafe.
 */
export async function emitNotification({
  tenantId,
  locationId = null,
  severity,
  sourceType,
  sourceRefId = null,
  title,
  body = null,
  deepLink = null,
  dedupeKey,
  templateKey = null,
  paramsJson = null,
  audienceRole = null,
} = {}) {
  if (!tenantId) throw new Error('emitNotification: tenantId is required');
  if (!dedupeKey) throw new Error('emitNotification: dedupeKey is required');
  if (!title) throw new Error('emitNotification: title is required');
  if (!NOTIFICATION_SEVERITIES.includes(severity)) {
    throw new Error(`emitNotification: invalid severity ${severity}`);
  }
  if (!NOTIFICATION_SOURCE_TYPES.includes(sourceType)) {
    throw new Error(`emitNotification: invalid sourceType ${sourceType}`);
  }
  return prisma.notificationEvent.upsert({
    where: { tenantId_dedupeKey: { tenantId, dedupeKey } },
    // Re-detection is a no-op by design — the first emission wins so a row a
    // user already read never jumps back to unread.
    update: {},
    create: {
      tenantId,
      locationId: locationId || null,
      severity,
      sourceType,
      sourceRefId: sourceRefId || null,
      title,
      body,
      deepLink,
      dedupeKey,
      templateKey,
      paramsJson: paramsJson ? JSON.stringify(paramsJson) : null,
      audienceRole,
    },
  });
}

/** Never throws — an emitter must never break the flow that hosts it. */
export async function emitNotificationSafe(input) {
  try {
    return await emitNotification(input);
  } catch (err) {
    logger.warn('[notifications] emit failed (non-fatal)', {
      dedupeKey: input?.dedupeKey,
      sourceType: input?.sourceType,
      message: err?.message || String(err),
    });
    return null;
  }
}

/**
 * Mark the envelope resolved when the underlying condition cleared on its own
 * (e.g. the geofence sweep sees the car back inside). Renders as
 * "Self-resolved" in the center. Never throws.
 */
export async function resolveNotificationSafe({ tenantId, sourceType, sourceRefId } = {}) {
  try {
    if (!tenantId || !sourceType || !sourceRefId) return null;
    return await prisma.notificationEvent.updateMany({
      where: { tenantId, sourceType, sourceRefId, resolvedAt: null },
      data: { resolvedAt: new Date() },
    });
  } catch (err) {
    logger.warn('[notifications] resolve failed (non-fatal)', {
      sourceType, sourceRefId, message: err?.message || String(err),
    });
    return null;
  }
}

/**
 * Mirror an acknowledge that happened ON THE SOURCE surface (toll tray ack,
 * dashboard geofence dismiss) onto the envelope, so the center and the source
 * never disagree about who handled the item. The source stays the owner of
 * the state — this is a display stamp, not a fork. Never throws.
 */
export async function ackNotificationBySourceRefSafe({ tenantId, sourceType, sourceRefId, userId = null, userName = null } = {}) {
  try {
    if (!tenantId || !sourceType || !sourceRefId) return null;
    return await prisma.notificationEvent.updateMany({
      where: { tenantId, sourceType, sourceRefId, ackAt: null },
      data: { ackAt: new Date(), ackByUserId: userId || null, ackByName: userName || null },
    });
  } catch (err) {
    logger.warn('[notifications] source-ack mirror failed (non-fatal)', {
      sourceType, sourceRefId, message: err?.message || String(err),
    });
    return null;
  }
}
