/**
 * Fee Rate Audit service — V2 (pillar2 followup).
 *
 * Persistent audit trail for changes to FeeRate rows. The PUT/POST/DELETE
 * routes call `recordChange` from inside the Prisma transaction that performs
 * the underlying mutation so the audit record commits atomically with the
 * change.
 *
 * Audit is BEST-EFFORT: if the audit insert throws, callers should swallow
 * the error and emit a warning rather than rolling back the user-facing
 * change. See the wrapping try/catch in fee-rates.service.bulkUpsert.
 *
 * Multi-tenancy: every query filters by `tenantId`. There is no FK to FeeRate
 * (DELETEs must not cascade away the audit row); `feeRateId` is a plain string.
 */

import { prisma as defaultPrisma } from '../../lib/prisma.js';
import logger from '../../lib/logger.js';

const VALID_CHANGE_TYPES = new Set(['CREATE', 'UPDATE', 'DELETE', 'TOGGLE']);

/**
 * Extract a compact, JSON-friendly snapshot from a FeeRate Prisma row.
 * Returns null for null/undefined inputs (used when before/after doesn't apply,
 * e.g. before=null on a CREATE, after=null on a DELETE).
 */
export function snapshotFeeRate(row) {
  if (!row) return null;
  return {
    id: row.id ?? null,
    tenantId: row.tenantId ?? null,
    locationId: row.locationId ?? null,
    feeType: row.feeType ?? null,
    unit: row.unit ?? null,
    // Prisma Decimal -> Number for the JSON snapshot. Numeric precision past
    // 2 decimal places isn't meaningful for fee rates (the validation range
    // is in dollars with a 0.01 step), so the round-trip is safe.
    amount: row.amount == null ? null : Number(row.amount),
    isActive: row.isActive == null ? null : !!row.isActive,
    notes: row.notes ?? null,
    updatedAt: row.updatedAt ? new Date(row.updatedAt).toISOString() : null
  };
}

/**
 * Classify the change between two snapshots. Used to label UPDATE vs TOGGLE
 * (TOGGLE = ONLY isActive flipped — useful so the UI can show "disabled"
 * differently from a rate change).
 */
export function classifyChange(before, after) {
  if (!before && after) return 'CREATE';
  if (before && !after) return 'DELETE';
  if (!before && !after) return 'UPDATE'; // degenerate, shouldn't happen
  // both present: detect TOGGLE = only isActive differs
  const keys = ['amount', 'unit', 'notes', 'locationId', 'feeType'];
  const otherChanged = keys.some((k) => before[k] !== after[k]);
  const isActiveChanged = before.isActive !== after.isActive;
  if (!otherChanged && isActiveChanged) return 'TOGGLE';
  return 'UPDATE';
}

/**
 * Insert a single FeeRateAuditLog row. Pass a `tx` (Prisma transaction
 * client) when calling from inside a $transaction so the audit row commits
 * atomically with the underlying mutation. Otherwise pass `prisma` directly.
 *
 * Returns the inserted row on success; never throws — wraps the underlying
 * insert in try/catch so an audit failure doesn't break the user flow. The
 * caller's transaction is unaffected because we use the passed client.
 */
export async function recordChange({
  prisma = defaultPrisma,
  tx = null,
  tenantId,
  feeRateId = null,
  feeType,
  locationId = null,
  actor = null,
  changeType,
  before = null,
  after = null
}) {
  if (!tenantId) {
    logger.warn('[fee-rate-audit] recordChange skipped: missing tenantId');
    return null;
  }
  if (!feeType) {
    logger.warn('[fee-rate-audit] recordChange skipped: missing feeType (tenant=%s)', tenantId);
    return null;
  }
  if (!VALID_CHANGE_TYPES.has(changeType)) {
    logger.warn('[fee-rate-audit] recordChange skipped: invalid changeType=%s', changeType);
    return null;
  }

  const client = tx || prisma;
  const data = {
    tenantId,
    feeRateId: feeRateId || null,
    feeType,
    locationId: locationId || null,
    actorUserId: actor?.id || actor?.userId || null,
    actorEmail: actor?.email || null,
    actorRole: actor?.role ? String(actor.role).toUpperCase() : null,
    changeType,
    before: before ?? null,
    after: after ?? null
  };

  try {
    return await client.feeRateAuditLog.create({ data });
  } catch (err) {
    logger.warn('[fee-rate-audit] insert failed (tenant=%s feeType=%s changeType=%s): %s',
      tenantId, feeType, changeType, err?.message || err);
    return null;
  }
}

/**
 * List audit log rows for a tenant. Newest first. Defaults to 50 rows, capped
 * at 500 to keep the response payload bounded.
 *
 * Multi-tenancy: every query filters by `tenantId`. Pass `feeRateId` to
 * narrow to a single rate's history.
 */
export async function listAuditLog({
  prisma = defaultPrisma,
  tenantId,
  limit = 50,
  offset = 0,
  feeRateId = null
} = {}) {
  if (!tenantId) return [];
  const take = Math.max(1, Math.min(500, Number(limit) || 50));
  const skip = Math.max(0, Number(offset) || 0);
  const where = { tenantId };
  if (feeRateId) where.feeRateId = String(feeRateId);

  const rows = await prisma.feeRateAuditLog.findMany({
    where,
    orderBy: { changedAt: 'desc' },
    take,
    skip
  });

  // Normalize timestamps + numeric fields for the JSON response so the
  // frontend doesn't have to deal with raw Decimals or Date objects.
  return rows.map((r) => ({
    id: r.id,
    tenantId: r.tenantId,
    feeRateId: r.feeRateId,
    feeType: r.feeType,
    locationId: r.locationId,
    actorUserId: r.actorUserId,
    actorEmail: r.actorEmail,
    actorRole: r.actorRole,
    changeType: r.changeType,
    before: r.before ?? null,
    after: r.after ?? null,
    changedAt: r.changedAt ? new Date(r.changedAt).toISOString() : null
  }));
}

export const feeRateAuditService = {
  recordChange,
  listAuditLog,
  snapshotFeeRate,
  classifyChange
};
