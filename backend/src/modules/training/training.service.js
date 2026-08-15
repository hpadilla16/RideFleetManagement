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
import { findProof, standing, parseArmStamp, canCompleteByWalkthrough, VERIFY_TYPES, PROOF_SHAPE } from './training-verify.js';

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

    // ALWAYS stamped, even with no verification — the empty middle field is
    // what later tells the server "this module has nothing to prove, so
    // finishing the walkthrough is a legitimate completion". Writing null here
    // is what left every read-only module armed forever (2026-08-15).
    const stamp = `pending:${verifyType || ''}:${clampPoints(points)}`;

    const existing = await prisma.trainingProgress.findUnique({
      where: { userId_moduleKey: { userId, moduleKey } },
    });
    if (existing) {
      // Heal a row armed before the stamp existed, without touching armedAt —
      // re-arming must never reset the clock.
      if (!existing.provenBy && existing.status === 'ARMED') {
        return prisma.trainingProgress.update({ where: { id: existing.id }, data: { provenBy: stamp } });
      }
      return existing;
    }

    return prisma.trainingProgress.create({
      data: { tenantId, userId, moduleKey, status: 'ARMED', pointsAwarded: 0, provenBy: stamp },
    });
  },

  /**
   * Finish a module that has nothing to prove.
   *
   * Reading a screen leaves no record, so a walkthrough module completes when
   * the person reaches the end of its steps. THE SERVER decides whether that
   * is allowed: only a module armed WITHOUT a verify type qualifies, and the
   * points come from what was stamped at arming — so a client cannot claim it
   * finished 'create-reservation' by walking the guide, nor invent a score.
   */
  async completeWalkthrough({ tenantId, userId, moduleKey }) {
    if (!tenantId || !userId || !moduleKey) throw new Error('tenantId, userId and moduleKey are required');
    const row = await prisma.trainingProgress.findUnique({
      where: { userId_moduleKey: { userId, moduleKey } },
    });
    if (!row || row.tenantId !== tenantId) throw new Error('Module not started');
    // One definition of the rule, in the tested pure module — a module with
    // real work behind it is never completable by walking the guide.
    if (!canCompleteByWalkthrough(row)) return row;

    return prisma.trainingProgress.update({
      where: { id: row.id },
      data: {
        status: 'COMPLETED',
        completedAt: new Date(),
        pointsAwarded: clampPoints(parseArmStamp(row.provenBy).points),
        provenBy: 'walkthrough',
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
      const { verifyType, points } = parseArmStamp(row.provenBy);
      // No verify type means nothing to prove — those complete when the person
      // finishes walking the guide, not here.
      if (!verifyType || !PROOF_SHAPE[verifyType]) continue;

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
          pointsAwarded: clampPoints(points),
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
