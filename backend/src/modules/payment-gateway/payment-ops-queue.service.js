/**
 * Payment ops queue — the CONCRETE staff queue (B5 Phase 1, QA M4/M18).
 * Design: doc/kiosk-b5-payment-design-2026-07-16.md §9C.
 *
 * ⚠️ NO GATEWAY CALLS HERE. This module only records that a money action is
 * outstanding and lets staff see/resolve it. The actual void/refund is gateway
 * work and is blocked on rep answers (refund request shape, settlement
 * observability) — see the TODO(B5-gateway) markers.
 *
 * Every money path that cannot finish on its own raises a flag here instead of
 * failing silently. The three states are deliberately distinct because they are
 * different operational problems:
 *   NOT_ATTEMPTED  — nothing has been tried yet (e.g. the nightly sweep found a
 *                    stranded hold but has no gateway arm to release it)
 *   GATEWAY_FAILED — a gateway call WAS made and failed (lastError populated)
 *   RESOLVED       — actioned, manually or by a future automated sweep
 */

import { prisma } from '../../lib/prisma.js';
import logger from '../../lib/logger.js';

export const PAYMENT_OPS_KINDS = [
  'STRANDED_DEPOSIT_HOLD',
  'ORPHAN_PAYMENT',
  'ROLLBACK_FAILED',
  'CARD_ON_FILE_FAILED',
  'NAME_MISMATCH_REVIEW',
];
export const PAYMENT_OPS_STATUSES = ['NOT_ATTEMPTED', 'GATEWAY_FAILED', 'RESOLVED'];

/**
 * NOTE on RESOLVED rows (review): the dedupe lookup below excludes RESOLVED, so
 * if staff mark a stranded hold resolved while the hold is in fact still live,
 * the next sweep raises a NEW row rather than reopening the old one. That is
 * intentional — a resolved row is an audit record of a decision made at a point
 * in time, and a still-live hold genuinely is new outstanding work. It also
 * means a premature "resolve" cannot permanently hide money from the sweep.
 *
 * Raise (or refresh) a flag. Idempotent on the natural key
 * (tenantId, kind, + whichever of reference/gatewayRef/agreement identifies the
 * item): re-running a sweep must not pile up duplicate rows for the same
 * stranded hold. An existing UNRESOLVED flag is updated in place.
 */
async function raise({
  tenantId, kind, status = 'NOT_ATTEMPTED',
  reservationId = null, rentalAgreementId = null, kioskSessionId = null,
  reference = null, gatewayRef = null, amount = null,
  note = null, lastError = null,
} = {}) {
  if (!tenantId) throw new Error('tenantId is required to raise a payment ops flag');
  if (!PAYMENT_OPS_KINDS.includes(kind)) throw new Error(`unknown payment ops kind: ${kind}`);

  const existing = await prisma.paymentOpsFlag.findFirst({
    where: {
      tenantId,
      kind,
      status: { not: 'RESOLVED' },
      ...(gatewayRef ? { gatewayRef } : {}),
      ...(reference ? { reference } : {}),
      ...(!gatewayRef && !reference && rentalAgreementId ? { rentalAgreementId } : {}),
      ...(!gatewayRef && !reference && !rentalAgreementId && kioskSessionId ? { kioskSessionId } : {}),
    },
    select: { id: true, attempts: true, status: true },
  });

  if (existing) {
    // NEVER DOWNGRADE (QA minor 1): a later NOT_ATTEMPTED raise must not
    // overwrite a GATEWAY_FAILED row — that would erase the fact that we DID
    // call the gateway and it refused, turning a known-hard failure back into
    // "nobody has tried yet" and hiding it from whoever triages by severity.
    // The more severe state always wins; context/attempts still update.
    const nextStatus = (existing.status === 'GATEWAY_FAILED' && status === 'NOT_ATTEMPTED')
      ? 'GATEWAY_FAILED'
      : status;
    return prisma.paymentOpsFlag.update({
      where: { id: existing.id },
      data: {
        status: nextStatus,
        attempts: existing.attempts + (status === 'GATEWAY_FAILED' ? 1 : 0),
        ...(lastError ? { lastError: String(lastError).slice(0, 500) } : {}),
        ...(note ? { note: String(note).slice(0, 500) } : {}),
      },
    });
  }

  const created = await prisma.paymentOpsFlag.create({
    data: {
      tenantId,
      kind,
      status,
      reservationId,
      rentalAgreementId,
      kioskSessionId,
      reference,
      gatewayRef,
      amount,
      note: note ? String(note).slice(0, 500) : null,
      lastError: lastError ? String(lastError).slice(0, 500) : null,
      attempts: status === 'GATEWAY_FAILED' ? 1 : 0,
    },
  });
  logger.warn('[payment-ops] flag raised', {
    id: created.id, tenantId, kind, status, reservationId, rentalAgreementId, gatewayRef,
  });
  return created;
}

/** Read surface for the dashboard. Tenant-scoped; open items first. */
async function list(scope = {}, { status, kind, take } = {}) {
  if (!scope?.tenantId) throw new Error('A tenant scope is required');
  const where = {
    tenantId: scope.tenantId,
    ...(status ? { status: String(status).toUpperCase() } : {}),
    ...(kind ? { kind: String(kind).toUpperCase() } : {}),
  };
  const [flags, grouped] = await Promise.all([
    prisma.paymentOpsFlag.findMany({
      where,
      orderBy: [{ status: 'asc' }, { raisedAt: 'desc' }],
      take: Math.min(Number(take) || 100, 500),
    }),
    prisma.paymentOpsFlag.groupBy({
      by: ['status'],
      where: { tenantId: scope.tenantId },
      _count: { _all: true },
    }),
  ]);
  const counts = Object.fromEntries(grouped.map((g) => [g.status, g._count._all]));
  return {
    flags,
    counts,
    openCount: (counts.NOT_ATTEMPTED || 0) + (counts.GATEWAY_FAILED || 0),
  };
}

/** Mark a flag actioned (manual staff unwind, or a future sweep). */
async function resolve(id, { actorUserId = null, note = null } = {}, scope = {}) {
  if (!scope?.tenantId) throw new Error('A tenant scope is required');
  const flag = await prisma.paymentOpsFlag.findFirst({
    where: { id: String(id), tenantId: scope.tenantId },
    select: { id: true },
  });
  if (!flag) {
    const err = new Error('Payment ops flag not found');
    err.status = 404;
    throw err;
  }
  return prisma.paymentOpsFlag.update({
    where: { id: flag.id },
    data: {
      status: 'RESOLVED',
      resolvedAt: new Date(),
      resolvedByUserId: actorUserId,
      resolvedNote: note ? String(note).slice(0, 500) : null,
    },
  });
}

export const paymentOpsQueue = { raise, list, resolve };
