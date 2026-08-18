/**
 * M2 P1 — soft presence/claim on checkout sessions (2026-08-17, Hector-approved
 * PR-tren, ops-app-plan/M2-PLAN.md §1.2).
 *
 * Four surfaces now legitimately operate the SAME CheckoutSession row (counter
 * web wizard, kiosk tablet, customer phone, RideOps yard app — see
 * ops-app-plan/00-REGROUND.md §2). This module lets each surface heartbeat
 * "I'm looking at this session" so the OTHERS can render a presence chip
 * ("Ana is on the kiosk step") BEFORE they collide and have to reconcile a 409.
 *
 * HARD RULES (the reason this file is so small):
 *   • INFORMATIVE ONLY. Nothing may ever gate, lock or 409 based on presence.
 *     A dead tablet that stops heartbeating must never wedge a checkout —
 *     that's why this is a "soft claim" and not a lease/lock.
 *   • TTL IS LOGICAL. 45 s, filtered at READ time (lastSeenAt >= now - TTL).
 *     No cron, no cleanup job, no deletes needed for correctness — stale rows
 *     are just rows nobody selects. (Same "filter, don't sweep" shape as the
 *     kiosk pickup-window gate.)
 *   • READS NEVER BREAK. withPresence() swallows every error into
 *     presence: [] — a presence hiccup must not take down the wizard's poll,
 *     which is the heartbeat of the whole multi-surface UX.
 *
 * Upsert is MANUAL (findFirst → update/create) instead of prisma.upsert:
 * actorUserId is nullable and Prisma cannot address a compound unique through
 * a null member. The migration's partial unique index closes the null-actor
 * race at the DB level; on the rare P2002 loss we just retry the update once.
 */
import { prisma } from '../../lib/prisma.js';
import logger from '../../lib/logger.js';
import { CheckoutSessionError } from './checkout-session.service.js';

// Logical TTL: a surface polling every 5–15 s (M2-H1 poll contract) refreshes
// comfortably inside 45 s; three straight missed polls = you're gone.
export const PRESENCE_TTL_MS = 45_000;

export const CHECKOUT_SURFACES = ['RIDEOPS', 'COUNTER', 'KIOSK', 'CUSTOMER'];

// Fallback chip labels when the writer sent no label and has no user row
// (kiosk device with a blank name, customer phone).
const SURFACE_FALLBACK_LABEL = {
  RIDEOPS: 'RideOps',
  COUNTER: 'Counter',
  KIOSK: 'Kiosk',
  CUSTOMER: 'Customer',
};

function normalizeSurface(surface) {
  const value = String(surface || '').trim().toUpperCase();
  return CHECKOUT_SURFACES.includes(value) ? value : null;
}

/**
 * POST /api/checkout-sessions/:id/presence — the heartbeat. Validates the
 * session exists (tenant soft-scoped, same forgiving null-tenant rule as
 * getByReservationId) and upserts the (sessionId, surface, actorUserId)
 * row's lastSeenAt/label.
 */
async function heartbeat({ sessionId, surface, actorUserId, label, tenantId }) {
  if (!sessionId) throw new CheckoutSessionError('session id required', 400);
  const normalized = normalizeSurface(surface);
  if (!normalized) {
    throw new CheckoutSessionError(
      `Unknown surface: ${surface}. Expected one of ${CHECKOUT_SURFACES.join(', ')}`,
      400,
      'UNKNOWN_SURFACE',
    );
  }
  const where = tenantId
    ? { id: sessionId, OR: [{ tenantId }, { tenantId: null }] }
    : { id: sessionId };
  const session = await prisma.checkoutSession.findFirst({ where, select: { id: true } });
  if (!session) throw new CheckoutSessionError('Session not found', 404);

  const row = await upsertPresence({
    sessionId,
    surface: normalized,
    actorUserId: actorUserId || null,
    displayLabel: label ? String(label).slice(0, 120) : null,
  });
  return { ok: true, surface: row.surface, lastSeenAt: row.lastSeenAt };
}

async function upsertPresence({ sessionId, surface, actorUserId, displayLabel }) {
  const now = new Date();
  // Only overwrite the label when the caller SENT one — a label-less
  // heartbeat (cheap poll refresh) must not blank a chip that had a name.
  const patch = { lastSeenAt: now, ...(displayLabel ? { displayLabel } : {}) };
  const findWhere = { sessionId, surface, actorUserId };

  const existing = await prisma.checkoutPresence.findFirst({ where: findWhere, select: { id: true } });
  if (existing) {
    return prisma.checkoutPresence.update({ where: { id: existing.id }, data: patch });
  }
  try {
    return await prisma.checkoutPresence.create({
      data: { sessionId, surface, actorUserId, displayLabel: displayLabel || null, lastSeenAt: now },
    });
  } catch (err) {
    // Unique race (two first-heartbeats landing together): the partial/compound
    // unique index rejects the loser — fall back to updating the winner's row.
    if (err?.code === 'P2002') {
      const winner = await prisma.checkoutPresence.findFirst({ where: findWhere, select: { id: true } });
      if (winner) return prisma.checkoutPresence.update({ where: { id: winner.id }, data: patch });
    }
    throw err;
  }
}

/**
 * Fresh presence for one session: [{ surface, displayName, lastSeenAt }],
 * newest first. displayName resolution: explicit label → actor's fullName →
 * generic surface label. THROWS on infrastructure errors — use withPresence()
 * on read paths that must never fail.
 */
async function activePresence(sessionId, { now = new Date() } = {}) {
  if (!sessionId) return [];
  const cutoff = new Date(now.getTime() - PRESENCE_TTL_MS);
  const rows = await prisma.checkoutPresence.findMany({
    where: { sessionId, lastSeenAt: { gte: cutoff } },
    orderBy: { lastSeenAt: 'desc' },
  });
  if (!rows.length) return [];

  // Batch-resolve staff names for rows that heartbeated without a label.
  const needName = [...new Set(rows.filter((r) => !r.displayLabel && r.actorUserId).map((r) => r.actorUserId))];
  const nameById = new Map();
  if (needName.length) {
    const users = await prisma.user.findMany({
      where: { id: { in: needName } },
      select: { id: true, fullName: true },
    });
    users.forEach((u) => nameById.set(u.id, u.fullName));
  }

  return rows.map((row) => ({
    surface: row.surface,
    displayName: row.displayLabel
      || (row.actorUserId ? nameById.get(row.actorUserId) : null)
      || SURFACE_FALLBACK_LABEL[row.surface]
      || row.surface,
    lastSeenAt: row.lastSeenAt,
  }));
}

/**
 * Serializer for GET /:id and GET /by-reservation/:rid — attaches
 * `presence: [...]` to the response WITHOUT touching the session row.
 * Additive field: web/kiosk/precheckin clients that don't know about it
 * simply ignore it. Best-effort by contract: any presence failure degrades
 * to presence: [] rather than failing the read the wizards poll on.
 */
async function withPresence(session) {
  if (!session) return session;
  try {
    const presence = await activePresence(session.id);
    return { ...session, presence };
  } catch (err) {
    logger.warn('[checkout-presence] presence read failed (non-fatal)', {
      sessionId: session.id, error: err?.message || String(err),
    });
    return { ...session, presence: [] };
  }
}

/**
 * Fire-and-forget writer for surfaces that already hold a verified session
 * reference (the kiosk hook in kiosk-checkout.service.js). Skips the session
 * re-lookup heartbeat() does and NEVER rejects — presence must not add a
 * failure mode to the calling business path.
 */
function recordPresenceSafe({ sessionId, surface, actorUserId = null, displayLabel = null }) {
  const normalized = normalizeSurface(surface);
  if (!sessionId || !normalized) return Promise.resolve(null);
  return upsertPresence({ sessionId, surface: normalized, actorUserId, displayLabel })
    .catch((err) => {
      logger.warn('[checkout-presence] fire-and-forget presence write failed', {
        sessionId, surface: normalized, error: err?.message || String(err),
      });
      return null;
    });
}

export const checkoutPresenceService = {
  heartbeat,
  activePresence,
  withPresence,
  recordPresenceSafe,
};
