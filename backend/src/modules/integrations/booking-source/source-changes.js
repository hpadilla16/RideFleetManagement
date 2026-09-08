/**
 * When a booking is CANCELLED or MODIFIED at the source, say so in RFM
 * (2026-09-08).
 *
 * Hector: "para todas integraciones, si se actualiza que se cancelo o se
 * modifico un reserva, eso deberia reflejar en RFM tambien con notas del
 * cambio".
 *
 * WHAT WAS THERE BEFORE. Almost nothing. Of the six booking sources, only MEX
 * and Advantage looked at cancellations at all, and only halfway: a booking
 * cancelled BEFORE promotion was rejected, but one cancelled AFTER promotion
 * left the live Reservation untouched and merely incremented a counter. Two
 * LAX reservations were sitting CONFIRMED on 2026-09-08 for bookings MEX had
 * already cancelled — cars held for people who were not coming. Economy, NU,
 * Flexways and TL had no cancellation handling whatsoever, and NO source
 * detected a modification: the staged row was overwritten with the new dates
 * every sweep and nobody was told.
 *
 * ── THE LINE THIS DOES NOT CROSS ────────────────────────────────────────────
 * A vehicle that is already OUT is a person on the road, and no scraper gets to
 * change that from a web page it just read. So:
 *
 *   status NEW / CONFIRMED   the rental has not started — the source is the
 *                            authority on its own booking, so cancel it and
 *                            write down why.
 *   anything else            CHECKED_OUT, CHECKED_IN, CHECKED_IN_UNPAID,
 *                            NO_SHOW, already CANCELLED — RFM's own record
 *                            wins. Note it, flag it, and leave it for a human.
 *
 * Modifications follow the same rule for the same reason: moving the return
 * date of a car that is already out changes what somebody owes.
 *
 * ── WHY A NOTE AND NOT JUST A STATUS ────────────────────────────────────────
 * "Cancelled" with no provenance is indistinguishable from a counter agent
 * cancelling it by mistake. Every write here appends a dated line naming the
 * source, the external reference and the actual before/after values, so the
 * agent who opens the reservation on Monday can see that MEX cancelled it on
 * Sunday and what it used to say.
 */

/** Prefix every line this module writes, so they are greppable and never re-parsed as free text. */
export const CHANGE_NOTE_PREFIX = '[source]';

/** Reservation statuses where the rental has NOT started and the source may still speak. */
const NOT_STARTED = new Set(['NEW', 'CONFIRMED']);

/** Fields worth telling a human about. Money and dates; not internal plumbing. */
const WATCHED = Object.freeze([
  { key: 'pickupAt', label: 'pickup' },
  { key: 'dropoffAt', label: 'return' },
  { key: 'vehicleAcriss', label: 'class' },
  { key: 'totalAmount', label: 'total' },
]);

function sameValue(a, b) {
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  if (a instanceof Date || b instanceof Date) {
    const at = new Date(a).getTime();
    const bt = new Date(b).getTime();
    return Number.isFinite(at) && Number.isFinite(bt) && at === bt;
  }
  // Decimal columns arrive as Prisma Decimal or string; compare numerically
  // when both look numeric so 44 and "44.00" are not reported as a change.
  const an = Number(a);
  const bn = Number(b);
  if (Number.isFinite(an) && Number.isFinite(bn)) return an === bn;
  return String(a) === String(b);
}

function show(v) {
  if (v == null || v === '') return '(empty)';
  if (v instanceof Date) return v.toISOString().slice(0, 16).replace('T', ' ');
  const n = Number(v);
  if (Number.isFinite(n) && typeof v !== 'string') return String(v);
  const asDate = new Date(v);
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v) && !Number.isNaN(asDate.getTime())) {
    return asDate.toISOString().slice(0, 16).replace('T', ' ');
  }
  return String(v);
}

/**
 * What changed between the row we already had and the row the source just sent.
 * Pure. Returns [] when nothing watched moved.
 */
export function diffStagedRow(before, after) {
  if (!before || !after) return [];
  const out = [];
  for (const { key, label } of WATCHED) {
    if (!(key in after)) continue;
    if (sameValue(before[key], after[key])) continue;
    out.push({ field: key, label, from: before[key], to: after[key] });
  }
  return out;
}

/** One dated, greppable line. Pure. */
export function buildChangeNote({ sourceName, externalRef, kind, changes = [], at = new Date() }) {
  const stamp = new Date(at).toISOString().slice(0, 16).replace('T', ' ');
  const head = `${CHANGE_NOTE_PREFIX} ${stamp} ${sourceName} ${externalRef}`;
  if (kind === 'CANCELLED') return `${head}: cancelled at the source.`;
  if (kind === 'CANCELLED_BLOCKED') {
    return `${head}: cancelled at the source, but this rental has already started — RFM status left unchanged for a human to decide.`;
  }
  const body = changes.map((c) => `${c.label} ${show(c.from)} -> ${show(c.to)}`).join('; ');
  if (kind === 'MODIFIED_BLOCKED') {
    return `${head}: changed at the source (${body}), but this rental has already started — RFM values left unchanged for a human to decide.`;
  }
  return `${head}: changed at the source — ${body}.`;
}

/** Append a line to whatever notes the reservation already carries. Pure. */
export function appendNote(existing, line) {
  const prev = String(existing || '').trim();
  return prev ? `${prev}\n${line}` : line;
}

/**
 * Reflect a source-side cancellation or modification on the live Reservation.
 *
 * Best-effort and NEVER throws into the caller: an import must not fail because
 * we could not annotate it. Returns a summary of what was done so the worker
 * can count it.
 *
 * @param {object} db        Prisma handle (worker's client or tx).
 * @param {object} args
 * @param {string} args.reservationId
 * @param {boolean} args.cancelledAtSource
 * @param {Array}  args.changes            from diffStagedRow
 * @param {string} args.sourceName         'Economy' | 'MEX' | ...
 * @param {string} args.externalRef
 * @param {object} [args.logger]
 */
export async function applySourceChange(db, {
  reservationId, cancelledAtSource = false, changes = [],
  sourceName = 'source', externalRef = '?', logger = null,
} = {}) {
  const nothing = { applied: false, blocked: false, cancelled: false, noted: false };
  if (!db?.reservation?.findUnique || !reservationId) return nothing;
  if (!cancelledAtSource && !changes.length) return nothing;

  try {
    const res = await db.reservation.findUnique({
      where: { id: reservationId },
      select: { id: true, status: true, notes: true },
    });
    if (!res) return nothing;

    // Already cancelled in RFM: nothing to say, and re-noting it every sweep
    // would grow the note without bound.
    if (cancelledAtSource && res.status === 'CANCELLED') return nothing;

    const started = !NOT_STARTED.has(String(res.status || '').toUpperCase());
    const kind = cancelledAtSource
      ? (started ? 'CANCELLED_BLOCKED' : 'CANCELLED')
      : (started ? 'MODIFIED_BLOCKED' : 'MODIFIED');
    const line = buildChangeNote({ sourceName, externalRef, kind, changes });

    // The note is written in every case. The STATUS only moves when the rental
    // has not started — see the block comment at the top.
    const data = { notes: appendNote(res.notes, line), notesUpdatedAt: new Date() };
    if (cancelledAtSource && !started) data.status = 'CANCELLED';

    await db.reservation.update({ where: { id: reservationId }, data });

    if (started && logger?.warn) {
      logger.warn('[source-changes] source changed a rental that has already started — noted, not applied', {
        reservationId, externalRef, sourceName, status: res.status, cancelledAtSource, changes: changes.length,
      });
    }
    return {
      applied: true,
      blocked: started,
      cancelled: Boolean(data.status),
      noted: true,
    };
  } catch (err) {
    if (logger?.warn) {
      logger.warn('[source-changes] could not annotate the reservation — import continues', {
        reservationId, externalRef, sourceName, message: String(err?.message || err),
      });
    }
    return nothing;
  }
}
