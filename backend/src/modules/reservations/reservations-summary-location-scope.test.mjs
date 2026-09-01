/**
 * DB-backed tests for LOCATION scoping of the dashboard summary (2026-07-23).
 * Requires DATABASE_URL.
 *
 * WHY THIS EXISTS: `reservationsService.summary()` was the ONE reservation read
 * path with no location clause — listPage/list/getById all had one. A user
 * restricted to a single branch therefore opened the dashboard and saw the whole
 * tenant's numbers (reported live: a LAX-scoped user saw 4,148 reservations,
 * 153 pickups and 48 returns that belonged to every branch).
 *
 * The second half of the bug is subtler and is the reason CARE 3 exists: even
 * with the counts filtered, summary() serves from `ReservationDailyCounter`,
 * a per-(tenant, day) rollup that holds WHOLE-TENANT numbers by construction
 * (refreshCounters recomputes from tenantId alone and never sees the caller's
 * `where`). A scoped caller that hits that table gets the tenant totals back
 * no matter how correct the live query is.
 *
 * CARES PROVEN HERE (each bites):
 *  1. a location-scoped caller counts ONLY reservations touching its location,
 *     and a reservation is "touching" if EITHER end does (pickup OR return) —
 *     a car picked up at B and dropped at A belongs to both branches' work.
 *  2. an unrestricted caller (tenant admin) still sees the tenant totals — the
 *     no-regression half.
 *  3. a location-scoped caller does NOT read the whole-tenant counter table.
 *     Planted with an absurd value, the scoped caller must ignore it and the
 *     unrestricted caller must serve it — that asymmetry IS the fix.
 *  4. a location-scoped caller does not trigger a counter-table refresh, while
 *     an unrestricted caller still does (so care 3 can't be satisfied by
 *     breaking the counter table for everyone).
 *  5. `unpaidBalances` (2026-08-28, the Ops Hub tile that replaced Fee
 *     Advisories) is scoped the same way — it counts RentalAgreement rows, so
 *     it could not inherit the reservation `where` and needed its own clause.
 *     Cancelled agreements are excluded, matching the report the tile links to.
 *  6. `unpaidBalances` is computed live even on a rollup HIT — it is not a
 *     column on the counter table, and must not degrade to 0 when the rest of
 *     the counters are served from it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';
import { reservationsService } from './reservations.service.js';

const prisma = new PrismaClient();
const TAG = `RESLOC-${Date.now()}`;
const ids = { tenant: null, locA: null, locB: null, customer: null };

let scopedToA = null;    // caller restricted to location A
let unrestricted = null; // tenant admin — no location restriction
let dayStart = null;     // the counter-table key summary() computes for "today"

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Mirror summary()'s own "today in the tenant timezone" math so the fixtures
// land mid-window regardless of the machine's clock, and so the planted
// counter row uses the exact key summary() will look up.
function tenantToday(timeZone = 'America/Puerto_Rico') {
  const nowInTz = new Date(new Date().toLocaleString('en-US', { timeZone }));
  const y = nowInTz.getFullYear();
  const m = String(nowInTz.getMonth() + 1).padStart(2, '0');
  const d = String(nowInTz.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

async function waitForCounterRow(present, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const row = await prisma.reservationDailyCounter.findUnique({
      where: { tenantId_day: { tenantId: ids.tenant, day: dayStart } }
    });
    if (Boolean(row) === present) return row;
    if (Date.now() > deadline) return row;
    await sleep(150);
  }
}

test.after(async () => {
  if (ids.tenant) {
    await prisma.reservationDailyCounter.deleteMany({ where: { tenantId: ids.tenant } }).catch(() => {});
    // Agreements first — they FK to both reservation and location.
    await prisma.rentalAgreement.deleteMany({ where: { tenantId: ids.tenant } }).catch(() => {});
    await prisma.reservation.deleteMany({ where: { tenantId: ids.tenant } }).catch(() => {});
    await prisma.customer.deleteMany({ where: { tenantId: ids.tenant } }).catch(() => {});
  }
  for (const l of [ids.locA, ids.locB]) if (l) await prisma.location.delete({ where: { id: l } }).catch(() => {});
  if (ids.tenant) await prisma.tenant.delete({ where: { id: ids.tenant } }).catch(() => {});
  await prisma.$disconnect();
});

test('setup: two branches, three reservations — one at A, one at B, one crossing B→A', async () => {
  const tenant = await prisma.tenant.create({ data: { name: `T ${TAG}`, slug: `t-${TAG}`.toLowerCase() } });
  ids.tenant = tenant.id;

  const [a, b] = await Promise.all([
    prisma.location.create({ data: { tenantId: tenant.id, code: `A-${TAG}`.slice(0, 12), name: 'Branch A' } }),
    prisma.location.create({ data: { tenantId: tenant.id, code: `B-${TAG}`.slice(0, 12), name: 'Branch B' } })
  ]);
  ids.locA = a.id; ids.locB = b.id;

  const cust = await prisma.customer.create({
    data: { tenantId: tenant.id, firstName: 'Loc', lastName: `Scope ${TAG}`, phone: '7875550100' }
  });
  ids.customer = cust.id;

  const todayStr = tenantToday();
  dayStart = new Date(`${todayStr}T00:00:00`);
  // Noon so both pickupAt and returnAt sit inside today's [00:00, 23:59:59.999]
  // window on every machine timezone — these count as BOTH a pickup and a
  // return today, which is what makes the two counters comparable.
  const noon = new Date(`${todayStr}T12:00:00`);

  const base = { tenantId: tenant.id, customerId: cust.id, pickupAt: noon, returnAt: noon, status: 'CONFIRMED' };
  await Promise.all([
    prisma.reservation.create({ data: { ...base, reservationNumber: `RA-${TAG}`, pickupLocationId: a.id, returnLocationId: a.id } }),
    prisma.reservation.create({ data: { ...base, reservationNumber: `RB-${TAG}`, pickupLocationId: b.id, returnLocationId: b.id } }),
    // Crosses branches: picked up at B, dropped at A. Belongs to BOTH.
    prisma.reservation.create({ data: { ...base, reservationNumber: `RX-${TAG}`, pickupLocationId: b.id, returnLocationId: a.id } })
  ]);

  scopedToA = { tenantId: tenant.id, allowedLocationIds: [a.id] };
  unrestricted = { tenantId: tenant.id, allowedLocationIds: null };
  assert.ok(ids.locA && ids.locB && ids.customer);
});

test('CARE 1: a location-scoped caller counts only its own branch (pickup OR return)', async () => {
  const s = await reservationsService.summary(scopedToA);
  // RA (both ends at A) and RX (returns at A) touch A. RB does not.
  assert.equal(s.pickupsToday, 2, 'pickups today are location-filtered');
  assert.equal(s.returnsToday, 2, 'returns today are location-filtered');
  assert.equal(s.totalReservations, 2, 'the Reservations card is filtered too — this is the 4,148 the user saw');
});

test('CARE 2: an unrestricted caller still sees the whole tenant', async () => {
  const s = await reservationsService.summary(unrestricted);
  assert.equal(s.pickupsToday, 3);
  assert.equal(s.returnsToday, 3);
  assert.equal(s.totalReservations, 3);
});

// Runs BEFORE the planted-row test on purpose: it ends with the rollup written
// and quiesced, so the next test can plant a value without an in-flight
// fire-and-forget refresh overwriting it mid-assertion.
test('CARE 4: a scoped caller does not refresh the rollup; an unrestricted one still does', async () => {
  // Drain first: the unrestricted call in CARE 2 fired a fire-and-forget
  // refresh that is very likely still in flight. Deleting without waiting lets
  // that straggler land AFTER the delete and masquerade as a write by the
  // scoped call below.
  await sleep(800);
  await prisma.reservationDailyCounter.deleteMany({ where: { tenantId: ids.tenant } });

  await reservationsService.summary(scopedToA);
  await sleep(800); // the refresh is fire-and-forget — give a regression time to land
  const afterScoped = await prisma.reservationDailyCounter.findUnique({
    where: { tenantId_day: { tenantId: ids.tenant, day: dayStart } }
  });
  assert.equal(afterScoped, null, 'a location-scoped request must not write the shared rollup row');

  await reservationsService.summary(unrestricted);
  const afterAdmin = await waitForCounterRow(true);
  assert.ok(afterAdmin, 'unrestricted requests still populate the rollup — the skip is scope-specific');
  assert.equal(afterAdmin.pickupsToday, 3, 'and it holds WHOLE-TENANT numbers, never a filtered count');
});

test('CARE 3: a location-scoped caller never serves from the whole-tenant counter table', async () => {
  // CARE 4 left exactly one refresh behind and waited for it to land, so no
  // write is in flight and the planted value below cannot be clobbered.
  await waitForCounterRow(true);
  // Plant a fresh rollup row holding numbers that cannot come from the live
  // query. Whoever reads the table will hand these back verbatim.
  await prisma.reservationDailyCounter.update({
    where: { tenantId_day: { tenantId: ids.tenant, day: dayStart } },
    data: { pickupsToday: 999, returnsToday: 888, refreshedAt: new Date() }
  });

  const scoped = await reservationsService.summary(scopedToA);
  assert.equal(scoped.pickupsToday, 2, 'scoped caller must ignore the whole-tenant rollup and aggregate live');
  assert.equal(scoped.returnsToday, 2);

  // The admin read is a rollup HIT, so it serves the planted numbers and does
  // not fire another refresh — nothing overwrites the row underneath us.
  const admin = await reservationsService.summary(unrestricted);
  assert.equal(admin.pickupsToday, 999, 'the rollup is still live for unrestricted callers (fix is not a blanket disable)');
  assert.equal(admin.returnsToday, 888);
});

// ---------------------------------------------------------------------------
// Unpaid balances (2026-08-28) — the counter behind the Ops Hub tile that
// replaced Fee Advisories. It counts RentalAgreement rows, not Reservation
// rows, so it needed its own scoping rather than inheriting the reservation
// `where` — which is exactly the class of bug CARE 1 was written for.
//
// Runs LAST on purpose: it adds a fourth reservation, which would move the
// totalReservations numbers CARE 1/2 assert on.
// ---------------------------------------------------------------------------

test('setup: agreements owing money — one at A, one at B, one crossing B→A, plus a CANCELLED one at A', async () => {
  const res = await prisma.reservation.findMany({
    where: { tenantId: ids.tenant },
    select: { id: true, reservationNumber: true, pickupLocationId: true, returnLocationId: true }
  });
  const byNum = new Map(res.map((r) => [r.reservationNumber, r]));
  const noon = new Date(`${tenantToday()}T12:00:00`);

  const agreement = (r, suffix, balance, status = 'CLOSED') => ({
    tenantId: ids.tenant,
    agreementNumber: `AG-${suffix}-${TAG}`,
    reservationId: r.id,
    status,
    pickupAt: noon,
    returnAt: noon,
    pickupLocationId: r.pickupLocationId,
    returnLocationId: r.returnLocationId,
    customerFirstName: 'Loc',
    customerLastName: `Scope ${TAG}`,
    total: 300,
    paidAmount: 300 - balance,
    balance
  });

  // A fourth reservation at A carries the CANCELLED agreement — a cancelled
  // rental owes nothing by definition, so a balance on one must never count.
  const rc = await prisma.reservation.create({
    data: {
      tenantId: ids.tenant, customerId: ids.customer,
      reservationNumber: `RC-${TAG}`, pickupAt: noon, returnAt: noon,
      status: 'CANCELLED', pickupLocationId: ids.locA, returnLocationId: ids.locA
    }
  });

  await Promise.all([
    prisma.rentalAgreement.create({ data: agreement(byNum.get(`RA-${TAG}`), 'A', 100) }),
    prisma.rentalAgreement.create({ data: agreement(byNum.get(`RB-${TAG}`), 'B', 50) }),
    prisma.rentalAgreement.create({ data: agreement(byNum.get(`RX-${TAG}`), 'X', 25) }),
    prisma.rentalAgreement.create({ data: agreement(rc, 'C', 500, 'CANCELLED') })
  ]);

  // A zero-balance agreement would need a 5th reservation; the `balance > 0`
  // half of the filter is covered by the unit suite (unpaid-balance.report).
  const owing = await prisma.rentalAgreement.count({
    where: { tenantId: ids.tenant, balance: { gt: 0 } }
  });
  assert.equal(owing, 4, 'four agreements owe money; one of them is cancelled');
});

test('CARE 5: unpaidBalances is location-scoped (pickup OR return), and excludes CANCELLED', async () => {
  const scoped = await reservationsService.summary(scopedToA);
  // AG-A (both ends at A) and AG-X (returns at A) touch A. AG-B does not, and
  // AG-C is cancelled — so the $500 cancelled balance must not appear here.
  assert.equal(scoped.unpaidBalances, 2, 'a branch sees only the money owed on its own agreements');

  const admin = await reservationsService.summary(unrestricted);
  assert.equal(admin.unpaidBalances, 3, 'the tenant admin sees all three live agreements, still not the cancelled one');
});

test('CARE 6: unpaidBalances is always live — the whole-tenant rollup never serves it', async () => {
  // CARE 3 planted pickupsToday=999 in the rollup and it is still fresh, so the
  // unrestricted read below is a rollup HIT for the reservation counters. The
  // agreement counter must be computed live anyway: it is not a column on that
  // table, and silently defaulting it to 0 would be the failure this catches.
  const admin = await reservationsService.summary(unrestricted);
  assert.equal(admin.pickupsToday, 999, 'precondition: this read really is serving from the rollup');
  assert.equal(admin.unpaidBalances, 3, 'and the agreement count is still the live number, not a rollup 0');
});
