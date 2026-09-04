/**
 * Ride Kiosk — Fase B5 Phase 1: payment intent + late-payment binding.
 * Design: doc/kiosk-b5-payment-design-2026-07-16.md §3, §6A.
 *
 * ⚠️ NO GATEWAY CALLS HERE. This owns the REFERENCE and its lifecycle only;
 * creating the actual HPP session is gateway work (blocked on rep answers).
 *
 * TWO money-safety jobs:
 *
 * 1. ONE payment intent per kiosk session. A retried payment-link create must
 *    REUSE the persisted transactionReferenceId. Minting a second live intent
 *    would put two QRs in the world → two genuine charges that the
 *    reference-based dedupe is structurally blind to (different references =
 *    not duplicates). Reuse is the only safe answer; superseding is explicit.
 *
 * 2. Late-payment binding (§6A). The HPP `expiry` MINIMUM is 1 DAY, so a guest
 *    can photograph the QR and pay hours later — long after the kiosk session
 *    was wiped. The reference→session/reservation binding lives on the
 *    KioskSession row and therefore SURVIVES the wipe, so an arriving payment
 *    can always be resolved back to its reservation. When it can't, that is an
 *    orphan payment and it goes to the staff queue.
 */

import crypto from 'node:crypto';
import { prisma } from '../../lib/prisma.js';
import logger from '../../lib/logger.js';
import { KioskError } from './kiosk-device.service.js';
import { getSessionForDevice } from './kiosk-session.service.js';
import { paymentOpsQueue } from '../payment-gateway/payment-ops-queue.service.js';
import { buildGatewayReference } from '../../lib/payment-references.js';

export const INTENT_STATES = ['PENDING', 'SUPERSEDED', 'PAID', 'TERMINAL'];
// The gateway prefix this module mints under. The prefix VOCABULARY (and the
// idempotency-floor predicate that must list it) lives in lib/payment-references.js
// — never hardcode a new prefix here without extending that module + migration.
export const PAYMENT_REFERENCE_PREFIX = 'IPOS';

/**
 * transactionReferenceId generator. STRICTLY [A-Za-z0-9], <= 20 chars.
 *
 * The 904 lesson (ipos-transact-client.js:162): hyphens are NOT alphanumeric
 * and the gateway echoes this field to the processor host, which answered
 * "904 FORMAT ERROR". Everything non-alphanumeric is stripped, never joined.
 * Collision safety: a FULL 6 alphanumeric random chars on top of the
 * time-based tail, plus a DB-enforced unique index on the persisted column
 * (review M1) — a collision must fail loudly, never bind a payment to the
 * wrong reservation.
 *
 * Review R7: base64url emits '-' and '_', which the alphanumeric filter
 * strips. Filtering a SHORT buffer and then slicing sometimes yielded fewer
 * than 6 random chars (silently weaker refs). Draw from a longer buffer,
 * filter, and only then slice — the 6 chars are now guaranteed.
 */
export function generateIntentRef(prefix = 'K', now = Date.now()) {
  const head = String(prefix || 'K').replace(/[^A-Za-z0-9]/g, '').slice(0, 4) || 'K';
  const stamp = now.toString(36).replace(/[^A-Za-z0-9]/g, '');
  const rand = crypto.randomBytes(24).toString('base64url').replace(/[^A-Za-z0-9]/g, '').slice(0, 6);
  return `${head}${stamp}${rand}`.slice(0, 20);
}

async function mintUniqueIntentRef() {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const ref = generateIntentRef();
    // eslint-disable-next-line no-await-in-loop
    const clash = await prisma.kioskSession.findFirst({
      where: { paymentIntentRef: ref },
      select: { id: true },
    });
    if (!clash) return ref;
  }
  throw new KioskError('Could not mint a unique payment reference — try again', 500, 'INTENT_REF_MINT_FAILED');
}

async function mintInto(session, device, { superseding = null } = {}) {
  const ref = await mintUniqueIntentRef();
  // CONDITIONAL on the ref we believe is there. Two concurrent requests on a
  // session with no intent both passed the read, both minted, and last-write-wins
  // dropped the loser — not even into paymentIntentPriorRefs, so a guest who paid
  // the losing link produced a payment nothing could resolve. `updateMany` with
  // the expected ref in the WHERE makes the winner decidable in the database
  // instead of by arrival order; the loser re-reads and reuses. (QA M1.)
  const claimed = await prisma.kioskSession.updateMany({
    where: { id: session.id, paymentIntentRef: superseding ?? null },
    data: {
      paymentIntentRef: ref,
      paymentIntentState: 'PENDING',
      paymentIntentCreatedAt: new Date(),
      lastActivityAt: new Date(),
      // A fresh reference gets a fresh link. Carrying the old URL forward would
      // hand a guest a page minted for a different reference and amount.
      paymentIntentUrl: null,
      paymentIntentAmount: null,
    },
  });
  if (claimed.count === 0) {
    // Someone else claimed it between our read and our write. Their reference is
    // the live one; hand it back rather than putting a second QR into the world.
    const fresh = await prisma.kioskSession.findUnique({ where: { id: session.id } });
    if (!fresh?.paymentIntentRef) {
      throw new KioskError('Could not establish a payment reference', 409, 'INTENT_RACE_UNRESOLVED');
    }
    logger.warn('[kiosk-payment-intent] concurrent mint lost the race — reusing the winner', {
      sessionId: session.id, discarded: ref, winner: fresh.paymentIntentRef,
    });
    return {
      paymentIntentRef: fresh.paymentIntentRef,
      reference: buildGatewayReference(PAYMENT_REFERENCE_PREFIX, fresh.paymentIntentRef),
      state: fresh.paymentIntentState || 'PENDING',
      reused: true,
    };
  }
  const updated = await prisma.kioskSession.update({
    where: { id: session.id },
    data: {
      // RETAIN the replaced ref — a superseded iPOS link may still be payable.
      ...(superseding
        ? { paymentIntentPriorRefs: { push: superseding } }
        : {}),
    },
  });
  logger.info('[kiosk-payment-intent] minted', {
    sessionId: session.id, deviceId: device.id, tenantId: device.tenantId,
    paymentIntentRef: ref, superseded: superseding || null,
  });
  return {
    paymentIntentRef: updated.paymentIntentRef,
    reference: buildGatewayReference(PAYMENT_REFERENCE_PREFIX, updated.paymentIntentRef),
    state: 'PENDING',
    reused: false,
    ...(superseding ? { supersededRef: superseding } : {}),
  };
}

/**
 * Get-or-create THE payment intent for this session.
 *
 * PENDING → the SAME ref comes back (`reused: true`): never a second live QR
 * for an intent the guest can still pay.
 *
 * TERMINAL (declined / cancelled / rejected) → the dead ref is SUPERSEDED and
 * a fresh one is minted. Review M4: returning the existing ref regardless of
 * state was a trapdoor — after a decline the guest could never obtain a
 * payable link again. A terminal intent is exactly the case where a new link
 * is correct.
 */
async function ensureIntent(sessionId, device) {
  const session = await getSessionForDevice(sessionId, device);
  if (!session.reservationId) {
    throw new KioskError('Attach a reservation first', 422, 'NO_RESERVATION_ATTACHED');
  }

  if (session.paymentIntentRef) {
    const state = session.paymentIntentState || 'PENDING';
    if (state === 'PAID') {
      throw new KioskError('This session is already paid', 409, 'INTENT_ALREADY_PAID');
    }
    if (state === 'PENDING') {
      return {
        paymentIntentRef: session.paymentIntentRef,
        reference: buildGatewayReference(PAYMENT_REFERENCE_PREFIX, session.paymentIntentRef),
        state,
        reused: true,
      };
    }
    // TERMINAL / SUPERSEDED — the current ref is not payable-by-design; give
    // the guest a live one and keep the old ref resolvable.
    return mintInto(session, device, { superseding: session.paymentIntentRef });
  }

  return mintInto(session, device);
}

/**
 * Explicitly replace the live intent (e.g. the amount changed after an upsell).
 * The old ref moves to paymentIntentPriorRefs and STAYS resolvable — iPOS
 * publishes no way to cancel an unpaid link, so a guest holding the old QR can
 * still pay it. That payment must resolve to this reservation and land in the
 * staff queue, never become an untraceable orphan.
 */
async function supersedeIntent(sessionId, device) {
  const session = await getSessionForDevice(sessionId, device);
  if (!session.paymentIntentRef) {
    throw new KioskError('This session has no payment intent', 409, 'NO_PAYMENT_INTENT');
  }
  if (session.paymentIntentState === 'PAID') {
    throw new KioskError('This session is already paid', 409, 'INTENT_ALREADY_PAID');
  }
  return mintInto(session, device, { superseding: session.paymentIntentRef });
}

/** Advance the intent state (PENDING → PAID / TERMINAL / SUPERSEDED). */
async function setIntentState(sessionId, device, state) {
  if (!INTENT_STATES.includes(state)) {
    throw new KioskError(`state must be one of ${INTENT_STATES.join(', ')}`, 400);
  }
  const session = await getSessionForDevice(sessionId, device);
  if (!session.paymentIntentRef) {
    throw new KioskError('This session has no payment intent', 409, 'NO_PAYMENT_INTENT');
  }
  return prisma.kioskSession.update({
    where: { id: session.id },
    data: { paymentIntentState: state, lastActivityAt: new Date() },
  });
}

/**
 * Resolve an inbound gateway reference back to its kiosk session + reservation
 * — the late-payment binding. Works long after the session was wiped/completed
 * because the binding is a persisted column, not session memory.
 *
 * `reference` accepts either the bare transactionReferenceId or the prefixed
 * "IPOS:<ref>" form.
 */
async function resolveByReference(rawReference) {
  const raw = String(rawReference || '').trim();
  if (!raw) return null;
  const unprefixed = raw.includes(':') ? raw.slice(raw.indexOf(':') + 1) : raw;
  // iPOS does not hand the reference back clean. The return URL carries it
  // DECORATED — a second `?TransactionId=…` glued on, seen live twice
  // (2026-08-30) — and this resolver only stripped the prefix, so EVERY real
  // return fell through to "orphan", the payment went unrecorded, and the staff
  // queue got nothing. The reference is strictly alphanumeric by contract, so
  // the leading run IS the reference; anything after it is the gateway's
  // decoration. Inlined rather than imported: this file lives in the kiosk
  // module, which may not import a gateway client (payment-references R2).
  const bare = (/^[A-Za-z0-9]{1,20}/.exec(unprefixed) || [''])[0];
  if (!bare) return null;

  const select = {
    id: true, tenantId: true, deviceId: true, reservationId: true,
    outcome: true, paymentIntentRef: true, paymentIntentState: true, endedAt: true,
  };

  // Current ref first (DB-unique, review M1 — exactly one session can own it).
  let session = await prisma.kioskSession.findFirst({ where: { paymentIntentRef: bare }, select });
  let superseded = false;

  // Then the RETAINED superseded refs: an old QR is still payable at iPOS
  // (no documented cancel), so its late payment must still resolve here
  // rather than becoming an untraceable orphan (review M4).
  if (!session) {
    session = await prisma.kioskSession.findFirst({
      where: { paymentIntentPriorRefs: { has: bare } },
      select,
    });
    superseded = !!session;
  }
  if (!session) return null;

  return {
    kioskSessionId: session.id,
    tenantId: session.tenantId,
    reservationId: session.reservationId,
    paymentIntentRef: session.paymentIntentRef,
    paymentIntentState: session.paymentIntentState,
    // The reference that actually matched, and whether it was a retired one.
    matchedRef: bare,
    superseded,
    // A payment arriving for a session that already ended is the §6A case.
    // A payment on a SUPERSEDED ref is always staff-queue material even if the
    // session is technically still live — the guest paid a retired link.
    sessionLive: !superseded && session.outcome === 'IN_PROGRESS' && !session.endedAt,
  };
}

/**
 * A payment arrived that no live session is waiting on (guest photographed the
 * QR and paid hours later, or abandoned mid-flow). Record it for staff.
 *
 * TODO(B5-gateway): once the gateway layer lands, this is where the automatic
 * void (pre-batch-close, 5:30 PM EST) / refund (post-settlement) decision runs.
 * Both arms are blocked on rep answers — refund request shape and settlement
 * observability — so Phase 1 records and escalates, never silently swallows.
 */
async function flagOrphanPayment({ reference, amount = null, tenantId = null, note = null } = {}) {
  const bound = await resolveByReference(reference);
  const resolvedTenantId = bound?.tenantId || tenantId;
  if (!resolvedTenantId) {
    logger.error('[kiosk-payment-intent] orphan payment with no resolvable tenant', { reference });
    return null;
  }
  return paymentOpsQueue.raise({
    tenantId: resolvedTenantId,
    kind: 'ORPHAN_PAYMENT',
    status: 'NOT_ATTEMPTED',
    reservationId: bound?.reservationId || null,
    kioskSessionId: bound?.kioskSessionId || null,
    reference: String(reference || '').trim() || null,
    amount,
    note: note || (bound
      ? (bound.superseded
        ? 'Payment landed on a SUPERSEDED payment link (the guest paid an old QR; iPOS publishes no way to cancel a link). Needs void (pre-batch) or refund.'
        : 'Payment arrived after the kiosk session ended — needs void (pre-batch) or refund.')
      : 'Payment reference matches no kiosk session — manual investigation required.'),
  });
}

export const kioskPaymentIntentService = {
  ensureIntent,
  supersedeIntent,
  setIntentState,
  resolveByReference,
  flagOrphanPayment,
};
