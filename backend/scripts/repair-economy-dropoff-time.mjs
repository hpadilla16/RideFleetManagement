/**
 * REPAIR — Economy (RezLight) dropoff times lost to the resDropoffFullDate
 * key-casing bug (fixed in economy.worker.js, branch fix/economy-dropoff-time).
 *
 * WHAT WENT WRONG. The importer read `resDropOffFullDate` (capital "O"); the
 * portal sends `resDropoffFullDate` (lowercase "o"). The key never matched, so
 * every dropoff fell through to the date-only field and landed at LOCAL
 * MIDNIGHT — e.g. EEXPA149407E was stored Aug 31 00:00 Pacific when the portal
 * said 18:00, i.e. 18 hours early. Production audit 2026-08-26: 4,661 of 4,661
 * Economy rows with detail JSON are affected.
 *
 * WHY NO PORTAL CALL IS NEEDED. The correct value was captured all along — it
 * is sitting in ExternalReservation.rawJson->'detail'->>'resDropoffFullDate'.
 * This script re-derives from that stored truth. It never touches the network.
 *
 * WHAT IT WRITES (only with --apply):
 *   ExternalReservation.dropoffAt   ← resDropoffFullDate, in the area timezone
 *   Reservation.returnAt            ← same value, on the promoted reservation
 *                                     (economy.worker.js:704 sets returnAt from
 *                                     dropoffAt, so both drifted together)
 *
 * USAGE
 *   node scripts/repair-economy-dropoff-time.mjs                  # DRY-RUN (default)
 *   node scripts/repair-economy-dropoff-time.mjs --future-only    # DRY-RUN, future only
 *   node scripts/repair-economy-dropoff-time.mjs --future-only --apply
 *   node scripts/repair-economy-dropoff-time.mjs --apply          # everything
 *
 *   --future-only   only rows whose CORRECTED dropoff is still in the future.
 *                   Run this first: those are the reservations actively
 *                   producing wrong return times on today's board.
 *   --tenant=<id>   restrict to one tenant
 *   --area=<LAX>    restrict to one external area (LAX / MIA / FLL / MCO)
 *   --limit=<n>     cap rows examined (rehearsal)
 *   --verbose       print every row, not just the first SAMPLE_LIMIT per area
 *   --apply         ACTUALLY WRITE. Without it nothing is modified, ever.
 *
 * SAFETY
 *   - Dry-run is the default and is strictly read-only.
 *   - Rows already holding the correct instant are skipped (idempotent, so a
 *     partial run can simply be re-run).
 *   - Rows whose promoted Reservation is closed/finalised are NEVER written,
 *     even with --apply. Changing the agreed return time on a settled contract
 *     can move late-return money; that is the owner's call, not this script's.
 *     They are counted and listed under "HELD BACK" for review.
 *   - Each ExternalReservation + its Reservation are updated in ONE transaction,
 *     so the two can never disagree.
 */
import { prisma } from '../src/lib/prisma.js';
import { parseDateTimeInTz } from '../src/lib/date-utils.js';
import { SOURCE_SYSTEM, areaFromLocPickup, timeZoneForArea } from '../src/modules/integrations/economy/economy.constants.js';

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const valOf = (name) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};

const APPLY = has('--apply');
const FUTURE_ONLY = has('--future-only');
const VERBOSE = has('--verbose');
const ONLY_TENANT = valOf('tenant');
const ONLY_AREA = valOf('area') ? valOf('area').toUpperCase() : null;
const LIMIT = valOf('limit') ? Number(valOf('limit')) : null;

const BATCH = 500;
const SAMPLE_LIMIT = 5;

// Reservation statuses that mean "the rental is over / settled". Sourced from
// enum ReservationStatus in prisma/schema.prisma. CHECKED_OUT is deliberately
// NOT here: the car is still out, the return time is still live and fixing it
// is exactly what we want.
const CLOSED_RES_STATUSES = new Set([
  'CHECKED_IN',          // returned, balance settled, agreement CLOSED + locked
  'CHECKED_IN_UNPAID',   // returned, balance outstanding, agreement still open
  'CANCELLED',
  'NO_SHOW',
]);

/** "MM/DD/YYYY HH:mm" (RezLight's native shape) → UTC Date, read in `tz`. */
function portalDateToUtc(raw, tz) {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (s === '') return null;
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if (!m) return null;
  const [, mo, day, yr, hh, mi, se] = m;
  const pad = (n) => String(n).padStart(2, '0');
  const naive = `${yr}-${pad(mo)}-${pad(day)}T${pad(hh ?? '0')}:${mi ?? '00'}${se ? `:${se}` : ''}`;
  const d = parseDateTimeInTz(naive, tz);
  return d && Number.isFinite(d.valueOf()) ? d : null;
}

/**
 * Timezone for a row. The worker derives the area from the LIST row's
 * rgLocPickup (economy.worker.js → areaFromLocPickup); pickupLocation is the
 * detail's resPickupLocation and is used only as a fallback. Verified against
 * production: the two agree on all 4,661 rows.
 */
function areaForRow(row) {
  const listLoc = row.rawJson?.list?.rgLocPickup ?? null;
  return areaFromLocPickup(listLoc) ?? areaFromLocPickup(row.pickupLocation) ?? null;
}

const iso = (d) => (d ? new Date(d).toISOString() : 'null');
const inTz = (d, tz) => (d
  ? new Date(d).toLocaleString('en-US', { timeZone: tz, hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
  : 'null');

function blankStats() {
  return {
    scanned: 0, needsFix: 0, alreadyCorrect: 0, noPortalValue: 0,
    unparseable: 0, heldClosed: 0, skippedPast: 0, updatedExt: 0, updatedRes: 0,
    samples: [], held: [],
  };
}

async function main() {
  const now = new Date();
  console.log('');
  console.log('='.repeat(78));
  console.log(`  Economy dropoff-time repair — mode=${APPLY ? '*** APPLY (WRITES) ***' : 'DRY-RUN (read-only)'}`);
  console.log(`  scope=${FUTURE_ONLY ? 'FUTURE ONLY (corrected dropoff > now)' : 'ALL ROWS'}`
    + `${ONLY_AREA ? ` area=${ONLY_AREA}` : ''}${ONLY_TENANT ? ` tenant=${ONLY_TENANT}` : ''}`
    + `${LIMIT ? ` limit=${LIMIT}` : ''}`);
  console.log(`  now=${now.toISOString()}`);
  console.log('='.repeat(78));

  const byArea = new Map();
  const statsFor = (area) => {
    if (!byArea.has(area)) byArea.set(area, blankStats());
    return byArea.get(area);
  };

  let cursor = null;
  let examined = 0;

  for (;;) {
    if (LIMIT && examined >= LIMIT) break;
    const take = LIMIT ? Math.min(BATCH, LIMIT - examined) : BATCH;

    const rows = await prisma.externalReservation.findMany({
      where: { sourceSystem: SOURCE_SYSTEM, ...(ONLY_TENANT ? { tenantId: ONLY_TENANT } : {}) },
      take,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      orderBy: { id: 'asc' },
      select: {
        id: true, tenantId: true, externalRef: true, pickupLocation: true,
        dropoffAt: true, rawJson: true, promotedToReservationId: true,
      },
    });
    if (rows.length === 0) break;
    cursor = rows[rows.length - 1].id;
    examined += rows.length;

    for (const row of rows) {
      const area = areaForRow(row) ?? 'UNKNOWN';
      if (ONLY_AREA && area !== ONLY_AREA) continue;

      const st = statsFor(area);
      st.scanned++;

      const tz = timeZoneForArea(area);
      const portalRaw = row.rawJson?.detail?.resDropoffFullDate
        ?? row.rawJson?.detail?.resDropOffFullDate
        ?? null;

      if (portalRaw == null || String(portalRaw).trim() === '') { st.noPortalValue++; continue; }

      const want = portalDateToUtc(portalRaw, tz);
      if (!want) {
        st.unparseable++;
        if (st.samples.length < SAMPLE_LIMIT || VERBOSE) {
          console.log(`  [unparseable] ${row.externalRef} raw="${portalRaw}"`);
        }
        continue;
      }

      const have = row.dropoffAt ? new Date(row.dropoffAt) : null;
      if (have && have.getTime() === want.getTime()) { st.alreadyCorrect++; continue; }

      if (FUTURE_ONLY && want.getTime() <= now.getTime()) { st.skippedPast++; continue; }

      // Is the promoted reservation settled? Never rewrite those silently.
      let res = null;
      if (row.promotedToReservationId) {
        res = await prisma.reservation.findUnique({
          where: { id: row.promotedToReservationId },
          select: {
            id: true, status: true, returnAt: true, reservationNumber: true,
            // One-to-one (RentalAgreement.reservationId is @unique).
            rentalAgreement: {
              select: { id: true, status: true, locked: true, closedAt: true, finalizedAt: true },
            },
          },
        });
      }

      const ra = res?.rentalAgreement ?? null;
      const agreementSettled = !!ra
        && (ra.locked || !!ra.closedAt || !!ra.finalizedAt || ra.status === 'CLOSED');
      const settled = !!res && (CLOSED_RES_STATUSES.has(res.status) || agreementSettled);

      st.needsFix++;

      const detail = {
        ref: row.externalRef,
        portal: String(portalRaw),
        beforeUtc: iso(have), afterUtc: iso(want),
        beforeLocal: inTz(have, tz), afterLocal: inTz(want, tz),
        driftHours: have ? Math.round(((want - have) / 3_600_000) * 100) / 100 : null,
        resNumber: res?.reservationNumber ?? null,
        resStatus: res?.status ?? null,
      };

      if (settled) {
        st.heldClosed++;
        st.held.push(detail);
        continue; // never written, even with --apply
      }

      if (st.samples.length < SAMPLE_LIMIT || VERBOSE) st.samples.push(detail);

      if (APPLY) {
        await prisma.$transaction(async (tx) => {
          await tx.externalReservation.update({
            where: { id: row.id },
            data: { dropoffAt: want },
          });
          st.updatedExt++;
          if (res) {
            await tx.reservation.update({
              where: { id: res.id },
              data: { returnAt: want },
            });
            st.updatedRes++;
          }
        });
      }
    }
  }

  // ---------------------------------------------------------------- report --
  const areas = [...byArea.keys()].sort();
  const tot = blankStats();

  for (const area of areas) {
    const s = byArea.get(area);
    const tz = timeZoneForArea(area);
    console.log('');
    console.log(`--- ${area}  (${tz}) ${'-'.repeat(Math.max(0, 50 - area.length - tz.length))}`);
    console.log(`  scanned .............. ${s.scanned}`);
    console.log(`  already correct ...... ${s.alreadyCorrect}`);
    console.log(`  no portal value ...... ${s.noPortalValue}   (list-only rows; nothing to re-derive)`);
    console.log(`  unparseable .......... ${s.unparseable}`);
    if (FUTURE_ONLY) console.log(`  skipped (past) ....... ${s.skippedPast}`);
    console.log(`  NEEDS FIX ............ ${s.needsFix}`);
    console.log(`    - held back (closed) ${s.heldClosed}   <-- owner review, never auto-written`);
    console.log(`    - writable ......... ${s.needsFix - s.heldClosed}`);
    if (APPLY) console.log(`  UPDATED  ext=${s.updatedExt}  reservations=${s.updatedRes}`);

    if (s.samples.length) {
      console.log(`  before/after (first ${s.samples.length}):`);
      for (const d of s.samples) {
        console.log(`    ${d.ref}  portal="${d.portal}"`);
        console.log(`        before ${d.beforeLocal} local  (${d.beforeUtc})`);
        console.log(`        after  ${d.afterLocal} local  (${d.afterUtc})   drift ${d.driftHours}h`);
      }
    }

    for (const k of Object.keys(tot)) {
      if (Array.isArray(tot[k])) continue;
      tot[k] += s[k];
    }
  }

  if (areas.some((a) => byArea.get(a).held.length)) {
    console.log('');
    console.log('='.repeat(78));
    console.log('  HELD BACK — promoted reservation is closed/finalised.');
    console.log('  These were NOT written. Changing a settled contract\'s return time can');
    console.log('  move late-return money; decide these individually.');
    console.log('='.repeat(78));
    for (const area of areas) {
      for (const d of byArea.get(area).held) {
        console.log(`  [${area}] ${d.ref}  res=${d.resNumber ?? '-'} (${d.resStatus})`);
        console.log(`        ${d.beforeLocal} -> ${d.afterLocal} local   drift ${d.driftHours}h`);
      }
    }
  }

  console.log('');
  console.log('='.repeat(78));
  console.log(`  TOTAL  scanned=${tot.scanned}  alreadyCorrect=${tot.alreadyCorrect}  `
    + `noPortalValue=${tot.noPortalValue}  unparseable=${tot.unparseable}`
    + (FUTURE_ONLY ? `  skippedPast=${tot.skippedPast}` : ''));
  console.log(`  TOTAL  needsFix=${tot.needsFix}  heldClosed=${tot.heldClosed}  `
    + `writable=${tot.needsFix - tot.heldClosed}`);
  if (APPLY) {
    console.log(`  TOTAL  updated: ExternalReservation=${tot.updatedExt}  Reservation=${tot.updatedRes}`);
  } else {
    console.log('  DRY-RUN — nothing was written. Re-run with --apply to commit.');
  }
  console.log('='.repeat(78));
  console.log('');
}

main()
  .catch((err) => { console.error('[repair-economy-dropoff] FAILED', err); process.exitCode = 1; })
  .finally(async () => { await prisma.$disconnect(); });
