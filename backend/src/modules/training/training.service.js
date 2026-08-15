/**
 * Ride University — arming a module, proving it, and reporting standing.
 *
 * This file owns the database. Every decision it makes is delegated to
 * training-verify.js, which is pure and directly tested; what happens here is
 * fetching candidate records and writing the result.
 *
 * The curriculum itself is NOT here — it lives in the frontend, and the client
 * sends the module's key, verify type and point value when arming. That looks
 * like trusting the client, so the guard is deliberate: points are clamped,
 * the verify type must be one this file knows how to prove, and completion is
 * ALWAYS decided from records this service reads itself. A caller can ask to
 * arm anything; it cannot assert that it finished.
 */
import { prisma } from '../../lib/prisma.js';
import logger from '../../lib/logger.js';
import { findProof, standing, VERIFY_TYPES, PROOF_SHAPE } from './training-verify.js';

/** Nobody earns more than this from one module, whatever the client claims. */
const MAX_POINTS = 50;

function clampPoints(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(MAX_POINTS, Math.round(n));
}

/**
 * Candidate records for a verify type: this person's work in this tenant since
 * they armed the module. Scoped and bounded — never a table scan.
 */
async function candidatesFor(verifyType, { tenantId, userId, armedAt }) {
  const common = { take: 25, orderBy: { createdAt: 'desc' } };
  switch (verifyType) {
    case 'RESERVATION_CREATED':
      return prisma.reservation.findMany({
        where: { tenantId, createdByUserId: userId, createdAt: { gte: armedAt } },
        select: { id: true, createdByUserId: true, createdAt: true },
        ...common,
      });
    case 'RESERVATION_CHECKED_OUT':
      return prisma.checkoutSession.findMany({
        where: { tenantId, startedByUserId: userId, finishedAt: { gte: armedAt } },
        select: { id: true, startedByUserId: true, finishedAt: true },
        ...common,
      });
    case 'RESERVATION_CHECKED_IN':
      return prisma.rentalAgreement.findMany({
        where: { tenantId, closedByUserId: userId, closedAt: { gte: armedAt } },
        select: { id: true, closedByUserId: true, closedAt: true },
        ...common,
      });
    case 'PAYMENT_RECORDED':
      // ReservationPayment carries no tenantId of its own; scope through the
      // reservation it belongs to rather than reading across tenants.
      return prisma.reservationPayment.findMany({
        where: {
          recordedByUserId: userId,
          paidAt: { gte: armedAt },
          reservation: { tenantId },
        },
        select: { id: true, recordedByUserId: true, paidAt: true },
        ...common,
      });
    default:
      return [];
  }
}

export const trainingService = {
  /** Everything this person has started or finished. */
  async progressFor({ tenantId, userId }) {
    if (!tenantId || !userId) return [];
    return prisma.trainingProgress.findMany({
      where: { tenantId, userId },
      orderBy: { updatedAt: 'desc' },
    });
  },

  /**
   * Start a module. Idempotent: arming something already armed keeps the
   * ORIGINAL armedAt, so a person cannot reset the clock to sweep up work they
   * did in between.
   */
  async arm({ tenantId, userId, moduleKey, verifyType = null, points = 0 }) {
    if (!tenantId || !userId || !moduleKey) throw new Error('tenantId, userId and moduleKey are required');
    if (verifyType && !VERIFY_TYPES.includes(verifyType)) throw new Error(`Unknown verification type: ${verifyType}`);

    const existing = await prisma.trainingProgress.findUnique({
      where: { userId_moduleKey: { userId, moduleKey } },
    });
    if (existing) return existing;

    return prisma.trainingProgress.create({
      data: {
        tenantId,
        userId,
        moduleKey,
        status: 'ARMED',
        pointsAwarded: 0,
        // Stash what proves it and what it is worth, so completion never has
        // to trust whatever the client says at claim time.
        provenBy: verifyType ? `pending:${verifyType}:${clampPoints(points)}` : null,
      },
    });
  },

  /**
   * Check every armed module for this person and complete the ones the records
   * now prove. Returns the modules that just completed.
   *
   * Called when Ride University is opened rather than on a schedule: the
   * person is right there, and a sweep over every user would read far more
   * than it ever completes.
   */
  async settle({ tenantId, userId }) {
    if (!tenantId || !userId) return [];
    const armed = await prisma.trainingProgress.findMany({
      where: { tenantId, userId, status: 'ARMED' },
    });

    const completed = [];
    for (const row of armed) {
      const [, verifyType, pointsRaw] = String(row.provenBy || '').split(':');
      if (!verifyType || !PROOF_SHAPE[verifyType]) continue; // read-only module

      let records = [];
      try {
        records = await candidatesFor(verifyType, { tenantId, userId, armedAt: row.armedAt });
      } catch (err) {
        // A broken check must never block someone's training page.
        logger.warn('[training] candidate lookup failed', { moduleKey: row.moduleKey, message: err.message });
        continue;
      }

      const proof = findProof({ verifyType, records, userId, armedAt: row.armedAt });
      if (!proof.proved) continue;

      const updated = await prisma.trainingProgress.update({
        where: { id: row.id },
        data: {
          status: 'COMPLETED',
          completedAt: new Date(),
          pointsAwarded: clampPoints(pointsRaw),
          provenBy: proof.provenBy,
        },
      });
      completed.push(updated);
    }
    return completed;
  },

  /**
   * Team standing for a manager.
   *
   * pointsAvailable comes from the CALLER, because it depends on each person's
   * role and their tenant's enabled modules — knowledge that lives in the
   * curriculum, not here. Percentages, never raw points: an agent's whole
   * curriculum is worth less than an admin's, so ranking by the raw number
   * would rank people by their job title.
   */
  async teamStanding({ tenantId, pointsAvailableByUser = {} }) {
    if (!tenantId) return [];
    const rows = await prisma.trainingProgress.findMany({
      where: { tenantId },
      select: { userId: true, status: true, pointsAwarded: true },
    });
    const byUser = new Map();
    for (const r of rows) {
      if (!byUser.has(r.userId)) byUser.set(r.userId, []);
      byUser.get(r.userId).push(r);
    }
    return [...byUser.entries()].map(([userId, progress]) => ({
      userId,
      ...standing(progress, pointsAvailableByUser[userId] || 0),
    }));
  },
};
