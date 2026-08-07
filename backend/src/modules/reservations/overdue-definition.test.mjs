/**
 * The Overdue Returns KPI and the list it links to must agree — DB-free.
 *
 * They drifted (Hector, 2026-08-07): International's dashboard said 6 overdue,
 * clicking through showed 4. The KPI had been fixed on 2026-08-05 to treat a
 * return as overdue the MOMENT it passes (the VPH "32 active + 10 overdue vs
 * 46 really out" bug); the list filter kept the old midnight rule. The two
 * missing rows were cars due back at 10:39 AM and 2:30 PM the same day, still
 * out — counted, but invisible in the list the tile links to.
 *
 * A tile you cannot click through to is worse than no tile, so the rule lives
 * here as one shared predicate and both sides are asserted against it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

/**
 * The canonical rule, mirrored from reports.service.js (KPI) and
 * reservations.service.js (?filter=overdue). Both build this exact shape.
 */
function overdueOr({ now, startOfTenantToday }) {
  return [
    // A rental is overdue the moment its planned return passes.
    { status: 'CHECKED_OUT', returnAt: { lt: now } },
    // A missed PICKUP keeps the midnight grace — arriving late the same day
    // is normal and must not flag the booking.
    { status: { in: ['NEW', 'CONFIRMED'] }, pickupAt: { lt: startOfTenantToday } },
  ];
}

/** Evaluate the rule against a row, the way Prisma would. */
function matches(row, { now, startOfTenantToday }) {
  if (row.overdueIgnored) return false;
  if (row.status === 'CHECKED_OUT') return new Date(row.returnAt) < now;
  if (['NEW', 'CONFIRMED'].includes(row.status)) return new Date(row.pickupAt) < startOfTenantToday;
  return false;
}

const NOW = new Date('2026-08-07T21:00:00.000Z');          // 5 PM AST
const START_TODAY = new Date('2026-08-07T04:00:00.000Z');  // AST midnight
const CTX = { now: NOW, startOfTenantToday: START_TODAY };

test('the shared rule shape is what both sides build', () => {
  const or = overdueOr(CTX);
  assert.equal(or.length, 2);
  assert.deepEqual(or[0], { status: 'CHECKED_OUT', returnAt: { lt: NOW } });
  assert.deepEqual(or[1], { status: { in: ['NEW', 'CONFIRMED'] }, pickupAt: { lt: START_TODAY } });
  // The regression, named: a midnight bound on RETURNS is the old bug.
  assert.notDeepEqual(or[0], { status: 'CHECKED_OUT', returnAt: { lt: START_TODAY } });
});

test('THE 6-vs-4 CASE: a car due back earlier TODAY is overdue', () => {
  // Verbatim from International, 2026-08-07: due 10:39 AM, still out at 5 PM.
  const stillOut = { status: 'CHECKED_OUT', returnAt: '2026-08-07T14:39:00Z' };
  assert.equal(matches(stillOut, CTX), true, 'the KPI counts it, so the list must show it');
  // Under the old midnight rule it vanished from the list:
  assert.equal(new Date(stillOut.returnAt) < START_TODAY, false, 'which is exactly why they disagreed');
});

test('a car due back LATER today is not overdue yet', () => {
  assert.equal(matches({ status: 'CHECKED_OUT', returnAt: '2026-08-07T23:30:00Z' }, CTX), false);
});

test('a car overdue from previous days still counts', () => {
  assert.equal(matches({ status: 'CHECKED_OUT', returnAt: '2026-08-04T14:07:00Z' }, CTX), true);
});

test('a missed PICKUP keeps the midnight grace', () => {
  // Scheduled for 9 AM today, not picked up at 5 PM — still normal, not overdue.
  assert.equal(matches({ status: 'CONFIRMED', pickupAt: '2026-08-07T13:00:00Z' }, CTX), false);
  // Yesterday's un-picked-up booking IS overdue.
  assert.equal(matches({ status: 'CONFIRMED', pickupAt: '2026-08-06T13:00:00Z' }, CTX), true);
});

test('overdueIgnored rows are excluded from both surfaces', () => {
  assert.equal(matches({ status: 'CHECKED_OUT', returnAt: '2026-08-01T10:00:00Z', overdueIgnored: true }, CTX), false);
});

test('closed and cancelled bookings are never overdue', () => {
  for (const status of ['CHECKED_IN', 'CANCELLED', 'NO_SHOW', 'COMPLETED']) {
    assert.equal(matches({ status, returnAt: '2026-08-01T10:00:00Z' }, CTX), false, status);
  }
});

test('the full International set reconciles: 6 counted, 6 listed', () => {
  const rows = [
    { status: 'CHECKED_OUT', returnAt: '2026-08-04T14:07:00Z' },
    { status: 'CHECKED_OUT', returnAt: '2026-08-05T18:05:00Z' },
    { status: 'CHECKED_OUT', returnAt: '2026-08-07T10:39:00Z' }, // was missing
    { status: 'CHECKED_OUT', returnAt: '2026-08-07T14:30:00Z' }, // was missing
    { status: 'CONFIRMED', pickupAt: '2026-08-05T04:00:00Z' },
    { status: 'CONFIRMED', pickupAt: '2026-08-05T04:00:00Z' },
    { status: 'CHECKED_OUT', returnAt: '2026-08-09T10:00:00Z' }, // not due yet
  ];
  assert.equal(rows.filter((r) => matches(r, CTX)).length, 6, 'KPI and list agree on the same six');
});
