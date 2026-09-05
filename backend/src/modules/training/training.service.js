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
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { prisma } from '../../lib/prisma.js';
import { issueTrainingPracticeToken } from '../auth/auth.service.js';
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
    case 'KIOSK_ASSISTED':
      // idVerifiedAt, not assistGrantedAt: the grant is cleared when the verify
      // consumes it (see training-verify.js). The method filter is repeated in
      // findProof so the decision is testable without a database.
      return prisma.kioskSession.findMany({
        where: {
          tenantId,
          assistUserId: userId,
          idVerifiedAt: { gte: armedAt },
          idVerifyMethod: { in: ['STAFF_OVERRIDE', 'STAFF_NAME_OVERRIDE'] },
        },
        select: { id: true, assistUserId: true, idVerifiedAt: true, idVerifyMethod: true },
        take: 25, orderBy: { idVerifiedAt: 'desc' },
      });
    case 'KIOSK_ACCESS_GRANTED':
      // The JSON containment ({module:'kiosk', to:true}) is decided in
      // findProof; 25 most recent per-user saves since arming is plenty.
      return prisma.moduleAccessAuditLog.findMany({
        where: { tenantId, scope: 'USER', actorUserId: userId, changedAt: { gte: armedAt } },
        select: { id: true, actorUserId: true, changedAt: true, changed: true, scope: true },
        take: 25, orderBy: { changedAt: 'desc' },
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
  /**
   * `proofTenantId` / `proofUserId` (optional): where to look for the WORK,
   * when it did not happen under the same identity that owns the progress.
   * Practice mode is exactly that case — the trainee's record lives on their
   * real account, but the reservation they created lives in the demo tenant
   * under their practice user.
   */
  async settle({ tenantId, userId, proofTenantId = null, proofUserId = null }) {
    if (!tenantId || !userId) return [];
    const lookInTenant = proofTenantId || tenantId;
    const lookForUser = proofUserId || userId;
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
        records = await candidatesFor(verifyType, { tenantId: lookInTenant, userId: lookForUser, armedAt: row.armedAt });
      } catch (err) {
        // A broken check must never block someone's training page.
        logger.warn('[training] candidate lookup failed', { moduleKey: row.moduleKey, message: err.message });
        continue;
      }

      const proof = findProof({ verifyType, records, userId: lookForUser, armedAt: row.armedAt });
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

  /**
   * Start a module over (Hector, 2026-08-17: "dale la habilidad de reiniciar
   * lo de nuevo si necesitan").
   *
   * Deletes the row rather than rewinding it, so re-taking a module is
   * genuinely a fresh start: a new armedAt, and no completion left behind to
   * confuse the standing. The points go with it and come back when they
   * finish again — a module you are redoing is one you have not finished.
   */
  async reset({ tenantId, userId, moduleKey }) {
    if (!tenantId || !userId || !moduleKey) throw new Error('tenantId, userId and moduleKey are required');
    const row = await prisma.trainingProgress.findUnique({
      where: { userId_moduleKey: { userId, moduleKey } },
    });
    // Nothing to reset is a success, not an error — the module is already at
    // the start, which is exactly what the caller asked for.
    if (!row) return { ok: true, reset: false };
    if (row.tenantId !== tenantId) { const e = new Error('Module not found'); e.status = 404; throw e; }
    await prisma.trainingProgress.delete({ where: { id: row.id } });
    logger.info('[training] module reset', { userId, moduleKey });
    return { ok: true, reset: true };
  },

  /**
   * Practice mode (2026-08-16): a 4h session as the shared practice AGENT on
   * the DEMO tenant, so a trainee can rehearse the OPPORTUNISTIC modules —
   * create, check out, check in, take a payment — without touching real
   * inventory or real money. Training never manufactures real work; the demo
   * tenant is the rehearsal space, and this is the bridge into it.
   *
   * The account is created on first use, one per trainee. Its password is
   * random and thrown away — nobody ever logs into it directly; the only door
   * is this endpoint, behind the caller's own real session. What the trainee
   * completes in here DOES count: the token names them (pracFor), so progress
   * lands on their real record while the proof is looked up under the practice
   * user in the demo tenant.
   */
  /** Deps injectable for tests: { prisma, issueToken }. */
  async practiceSession(actor = {}, deps = {}) {
    const db = deps.prisma || prisma;
    const issueToken = deps.issueToken || issueTrainingPracticeToken;
    // Deterministic even if a second demo tenant ever appears (QA #6d).
    const demo = await db.tenant.findFirst({
      where: { isDemo: true },
      orderBy: { createdAt: 'asc' },
      select: { id: true, name: true },
    });
    if (!demo) { const e = new Error('No demo tenant is configured'); e.status = 404; throw e; }

    // ONE PRACTICE USER PER TRAINEE (2026-08-17). It began as a single shared
    // account, which was fine while practice earned nothing. Now that practice
    // COUNTS, attribution has to be exact: two trainees rehearsing at the same
    // time would otherwise prove each other's modules. A per-person account
    // also ends the shared-screen-lock and shared-audit-trail problems.
    if (!actor.userId) { const e = new Error('Practice needs a signed-in user'); e.status = 400; throw e; }
    const email = `practica+${String(actor.userId).toLowerCase()}@ride.university`;
    // Case-insensitive: login lowercases, so a `Practica@...` row would slip
    // past a sensitive lookup AND past the guard below (QA #6c).
    const findPractice = () => db.user.findFirst({ where: { email: { equals: email, mode: 'insensitive' } } });
    let user = await findPractice();
    if (user && (
      user.tenantId !== demo.id || !user.isActive || user.role !== 'AGENT'
      || user.mustChangePassword || user.isServiceAccount
    )) {
      // The practice account may only ever be an active, password-stable,
      // human AGENT on the demo tenant. Anything else means someone squatted
      // the address or repurposed the account (a password reset sets
      // mustChangePassword and would trap every trainee in the forced-change
      // screen for a SHARED account) — refuse loudly, and leave a trace.
      logger.warn('[training] practice account misconfigured — session refused', {
        practiceUserId: user.id, practiceTenantId: user.tenantId,
        byUserId: actor.userId || null, byTenantId: actor.tenantId || null,
      });
      const e = new Error('The practice account is misconfigured — contact an admin');
      e.status = 409;
      throw e;
    }
    if (!user) {
      try {
        user = await db.user.create({
          data: {
            tenantId: demo.id,
            email,
            fullName: `Practica - ${actor.email || actor.userId}`,
            role: 'AGENT',
            passwordHash: await bcrypt.hash(crypto.randomBytes(24).toString('hex'), 10),
            isActive: true,
            mustChangePassword: false,
            passwordChangedAt: new Date(),
            // The idle screen lock would have trainee #1 SET a PIN on the
            // shared account and trainee #2 locked out by it (QA #5).
            screenLockExempt: true,
          },
        });
        logger.info('[training] practice user created', { userId: user.id, tenantId: demo.id });
      } catch (err) {
        // Two first-ever trainees racing: unique(email) fires for one of
        // them — the row now exists, use it (QA #6a).
        if (err?.code === 'P2002') user = await findPractice();
        if (!user) throw err;
      }
    } else if (!user.screenLockExempt) {
      // Heal rows created before the exemption existed.
      user = await db.user.update({ where: { id: user.id }, data: { screenLockExempt: true } });
    }

    // EVERY mint is attributed (QA #2): inside the demo tenant all actions
    // show the shared practice user, so this log line is the only record of
    // which human, on which tenant, was behind a given practice session.
    logger.info('[training] practice session minted', {
      byUserId: actor.userId || null, byEmail: actor.email || null, byTenantId: actor.tenantId || null,
      practiceUserId: user.id, demoTenantId: demo.id,
    });

    return {
      token: issueToken(user, { forUserId: actor.userId, forTenantId: actor.tenantId || null }),
      tenantName: demo.name,
    };
  },
};
