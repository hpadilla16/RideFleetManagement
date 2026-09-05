/**
 * Ride University — proving someone did the work.
 *
 * The rule this file exists to enforce: a module is complete because the
 * system can SEE the person did the task, not because they clicked through a
 * guide. Everything here is pure — it takes the candidate records a caller
 * already fetched and answers yes or no, so the decision is testable without a
 * database and cannot drift between the check and the manager's report.
 *
 * WHY DOMAIN RECORDS AND NOT THE AUDIT TRAIL (2026-08-14): audit rows are
 * wrong in both directions here. Settling a balance with a payment writes a
 * STATUS_CHANGE to CHECKED_IN with the PAYER as actor, so taking a payment
 * would have completed the check-in module; and a genuine check-in that leaves
 * a balance writes CHECKED_IN_UNPAID, so it would have been missed entirely.
 * Audit rows also require a reservationId, a quarter of them omit tenantId,
 * and actorUserId is unindexed.
 *
 * The domain records carry the actor already and mean exactly one thing each:
 *
 *   RESERVATION_CREATED      Reservation.createdByUserId
 *   RESERVATION_CHECKED_OUT  CheckoutSession.startedByUserId + finishedAt
 *   RESERVATION_CHECKED_IN   RentalAgreement.closedByUserId
 *   PAYMENT_RECORDED         ReservationPayment.recordedByUserId
 *   KIOSK_ASSISTED           KioskSession.assistUserId + idVerifiedAt, where the
 *                            method is one of the IN-PERSON pair. assistGrantedAt
 *                            is the wrong timestamp: it is CLEARED the moment the
 *                            verify consumes the grant, so a proof read from it
 *                            would vanish at exactly the moment it became true.
 *   KIOSK_ACCESS_GRANTED     ModuleAccessAuditLog.actorUserId + changedAt, where
 *                            `changed` contains {module:'kiosk', to:true}. This is
 *                            the DEDICATED access-change record, not the generic
 *                            AuditLog rejected above — one row per save, actor
 *                            and tenant on it, indexed by changedAt.
 *
 * NOT PROVABLE, on purpose: a REMOTE override. Valet reaches this server as one
 * service account, so KioskSession.assistUserId names the account, never the
 * human agent. A module about remote help is therefore reading, with a check —
 * anything else would award points to nobody or to the wrong someone.
 */

export const VERIFY_TYPES = Object.freeze([
  'RESERVATION_CREATED',
  'RESERVATION_CHECKED_OUT',
  'RESERVATION_CHECKED_IN',
  'PAYMENT_RECORDED',
  'KIOSK_ASSISTED',
  'KIOSK_ACCESS_GRANTED',
]);

/** Which field on which record proves each type — the one mapping, in one place. */
export const PROOF_SHAPE = Object.freeze({
  RESERVATION_CREATED: { model: 'reservation', actorField: 'createdByUserId', atField: 'createdAt' },
  RESERVATION_CHECKED_OUT: { model: 'checkoutSession', actorField: 'startedByUserId', atField: 'finishedAt' },
  RESERVATION_CHECKED_IN: { model: 'rentalAgreement', actorField: 'closedByUserId', atField: 'closedAt' },
  PAYMENT_RECORDED: { model: 'reservationPayment', actorField: 'recordedByUserId', atField: 'paidAt' },
  // `where` narrows by a column value; `match` is a pure predicate over the row
  // for what a column filter cannot say (a JSON containment). Both optional.
  KIOSK_ASSISTED: {
    model: 'kioskSession', actorField: 'assistUserId', atField: 'idVerifiedAt',
    where: { field: 'idVerifyMethod', in: ['STAFF_OVERRIDE', 'STAFF_NAME_OVERRIDE'] },
  },
  KIOSK_ACCESS_GRANTED: {
    model: 'moduleAccessAuditLog', actorField: 'actorUserId', atField: 'changedAt',
    // Per-PERSON grants only. The tenant-wide switch in Settings writes the
    // same {module, to} shape with scope 'TENANT', and that is a different
    // module (kiosk-grant-valet teaches People, not Settings). Repeated here,
    // not only in the DB query, so the decision stays testable without one.
    where: { field: 'scope', in: ['USER'] },
    match: (row) => Array.isArray(row?.changed)
      && row.changed.some((c) => c && c.module === 'kiosk' && c.to === true),
  },
});

const time = (v) => {
  if (!v) return null;
  const t = v instanceof Date ? v.getTime() : new Date(v).getTime();
  return Number.isFinite(t) ? t : null;
};

/**
 * Does any candidate record prove this person did this task, after they armed
 * the module?
 *
 * ARMED-AFTER IS THE POINT. Without it, a new hire would "complete" modules
 * on their first login for work done by whoever held that account before, or
 * for their own work from last month. Training records what someone did while
 * training.
 *
 * @param {object} args
 * @param {string} args.verifyType
 * @param {Array<object>} args.records  already scoped to the tenant by the caller
 * @param {string} args.userId
 * @param {Date|string} args.armedAt
 * @returns {{proved: boolean, provenBy: string|null, at: string|null}}
 */
export function findProof({ verifyType, records = [], userId, armedAt }) {
  const shape = PROOF_SHAPE[verifyType];
  const armed = time(armedAt);
  const miss = { proved: false, provenBy: null, at: null };
  if (!shape || !userId || armed === null) return miss;

  for (const row of Array.isArray(records) ? records : []) {
    if (!row) continue;
    if (String(row[shape.actorField] || '') !== String(userId)) continue;
    const at = time(row[shape.atField]);
    // A record with no timestamp cannot be placed relative to arming, so it
    // cannot prove anything — a checkout session that was started and never
    // finished is the live example.
    if (at === null || at < armed) continue;
    // The right person at the right time is not enough when the same record
    // also stands for something else: an in-person kiosk verify and a remote
    // one share a row shape and differ only in the method column.
    if (shape.where && !shape.where.in.includes(row[shape.where.field])) continue;
    if (typeof shape.match === 'function' && !shape.match(row)) continue;
    return { proved: true, provenBy: row.id || null, at: new Date(at).toISOString() };
  }
  return miss;
}

/**
 * Read the stamp written when a module was armed: `pending:<verifyType>:<points>`.
 *
 * The middle field being EMPTY is the whole security boundary. It says the
 * module had nothing to prove when it was armed, which is the only condition
 * under which reaching the end of a guide may complete it. Because the stamp
 * is written server-side at arming, a client cannot later claim a module is
 * verify-less in order to walk its way to the points.
 */
export function parseArmStamp(provenBy) {
  const parts = String(provenBy || '').split(':');
  if (parts[0] !== 'pending') return { armed: false, verifyType: null, points: 0 };
  return {
    armed: true,
    verifyType: parts[1] || null,
    points: Number(parts[2]) || 0,
  };
}

/**
 * May finishing the walkthrough complete this module?
 *
 * YES, for any armed module (Hector, 2026-08-17: "cuentalo como completado
 * cuando terminen la instruccion").
 *
 * It used to be no whenever a module had a verify rule, on the reasoning that
 * "walking is not doing the job". True of the JOB — and wrong about the
 * TRAINING: someone who walks all three check-out steps has learned the
 * check-out, and holding their progress hostage to a real customer showing up
 * taught them nothing except that the tracker was broken. Three of the four
 * hands-on modules could sit armed for weeks.
 *
 * The verify path is not gone; it is now the OTHER way in. Whichever happens
 * first completes the module: doing the real work still proves it for someone
 * who never opened the guide (settle() handles that), and finishing the guide
 * completes it for someone learning. What a `verify` rule still guarantees is
 * that nothing is completed by a stray click — the row must have been armed,
 * and the walkthrough must have reached its end.
 */
export function canCompleteByWalkthrough(row) {
  if (!row || row.status !== 'ARMED') return false;
  return parseArmStamp(row.provenBy).armed;
}

/**
 * Points for a completion. Snapshotted by the caller at the moment it is
 * proved, so re-weighting the curriculum later never rewrites history.
 */
export function pointsFor(module) {
  const n = Number(module?.points);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

/**
 * A person's standing, as a percentage of what is available TO THEM.
 *
 * Raw points are not comparable across roles — an agent's whole curriculum is
 * worth less than an admin's — so a manager's grid must never rank people by
 * the raw number. This returns the fraction that makes the comparison fair.
 *
 * @param {Array<{status: string, pointsAwarded: number}>} progress
 * @param {number} pointsAvailable  from the curriculum, for THAT person's role
 */
export function standing(progress = [], pointsAvailable = 0) {
  const rows = Array.isArray(progress) ? progress : [];
  const completed = rows.filter((r) => r?.status === 'COMPLETED');
  const earned = completed.reduce((sum, r) => sum + (Number(r.pointsAwarded) || 0), 0);
  const available = Number(pointsAvailable) || 0;
  return {
    completedCount: completed.length,
    armedCount: rows.filter((r) => r?.status === 'ARMED').length,
    pointsEarned: earned,
    pointsAvailable: available,
    // Capped: a module re-weighted downward after someone completed it must
    // not put them above 100%.
    percent: available > 0 ? Math.min(100, Math.round((earned / available) * 100)) : 0,
  };
}
