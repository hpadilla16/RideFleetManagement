import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '../../lib/prisma.js';
import { customerInspectionService } from './customer-inspection.service.js';
import { settingsService } from '../settings/settings.service.js';
import { _sweepCheckinRemindersOnce } from './checkin-reminders.scheduler.js';

const HOUR_MS = 60 * 60 * 1000;

// The sweep queries `reservation.findMany({ where:{ status, returnAt:{gt,lte} }})`.
// This stub HONORS that where clause against a fixture set, so the rolling-window
// boundaries are what's actually under test (not just the call plumbing).
function installReservationStub(fixtures) {
  prisma.reservation.findMany = async ({ where } = {}) => fixtures.filter((r) => {
    if (where?.status && r.status !== where.status) return false;
    const rt = r.returnAt.getTime();
    if (where?.returnAt?.gt && !(rt > where.returnAt.gt.getTime())) return false;
    if (where?.returnAt?.lte && !(rt <= where.returnAt.lte.getTime())) return false;
    return true;
  }).map((r) => ({ id: r.id, tenantId: r.tenantId }));
}

test('checkin-reminders sweep: rolling 48h window sends in-window rentals, skips far/past, respects dedupe', async (t) => {
  const prevLead = process.env.CUSTOMER_INSPECTION_CHECKIN_LEAD_HOURS;
  const prevSend = customerInspectionService.sendCheckinInspection;
  const prevCfg = settingsService.getCustomerInspectionConfig;
  delete process.env.CUSTOMER_INSPECTION_CHECKIN_LEAD_HOURS; // exercise the 48h default
  t.after(() => {
    if (prevLead === undefined) delete process.env.CUSTOMER_INSPECTION_CHECKIN_LEAD_HOURS; else process.env.CUSTOMER_INSPECTION_CHECKIN_LEAD_HOURS = prevLead;
    customerInspectionService.sendCheckinInspection = prevSend;
    settingsService.getCustomerInspectionConfig = prevCfg;
  });

  const now = Date.now();
  installReservationStub([
    { id: 'r_within', tenantId: 't1', status: 'CHECKED_OUT', returnAt: new Date(now + 24 * HOUR_MS) }, // (a) in window → send
    { id: 'r_short',  tenantId: 't1', status: 'CHECKED_OUT', returnAt: new Date(now + 12 * HOUR_MS) }, // (b) short rental just checked out → send (regression)
    { id: 'r_already', tenantId: 't1', status: 'CHECKED_OUT', returnAt: new Date(now + 30 * HOUR_MS) }, // (c) already sent → skipped, not re-sent
    { id: 'r_far',    tenantId: 't1', status: 'CHECKED_OUT', returnAt: new Date(now + 72 * HOUR_MS) }, // (d) >48h out → not yet
    { id: 'r_past',   tenantId: 't1', status: 'CHECKED_OUT', returnAt: new Date(now - 2 * HOUR_MS) },  // already returned → excluded
  ]);

  settingsService.getCustomerInspectionConfig = async () => ({ enabled: true, checkinModel: 'CUSTOMER' });

  const calls = [];
  customerInspectionService.sendCheckinInspection = async ({ reservationId }) => {
    calls.push(reservationId);
    // Model the DB-level dedupe guard: r_already already has a CHECKIN inspection.
    if (reservationId === 'r_already') return { ok: true, alreadySent: true };
    return { ok: true };
  };

  const res = await _sweepCheckinRemindersOnce();

  // Window selection: only future rentals within 48h were even considered.
  assert.deepEqual(calls.sort(), ['r_already', 'r_short', 'r_within']);
  assert.ok(calls.includes('r_short'), 'short 1-day rental within 48h must be caught (regression)');
  assert.ok(!calls.includes('r_far'), 'a return >48h out must not be sent yet');
  assert.ok(!calls.includes('r_past'), 'an already-returned rental must be excluded');

  // Dedupe: r_already is reported by the service as alreadySent → counted skipped,
  // NOT sent, and invoked exactly once (no double-send).
  assert.equal(calls.filter((id) => id === 'r_already').length, 1);
  assert.equal(res.scanned, 3);
  assert.equal(res.sent, 2, 'only r_within + r_short count as freshly sent');
  assert.equal(res.skipped, 1, 'r_already counts as skipped');
});

test('checkin-reminders sweep: honors CUSTOMER_INSPECTION_CHECKIN_LEAD_HOURS override', async (t) => {
  const prevLead = process.env.CUSTOMER_INSPECTION_CHECKIN_LEAD_HOURS;
  const prevSend = customerInspectionService.sendCheckinInspection;
  const prevCfg = settingsService.getCustomerInspectionConfig;
  process.env.CUSTOMER_INSPECTION_CHECKIN_LEAD_HOURS = '6'; // tighten the window to 6h
  t.after(() => {
    if (prevLead === undefined) delete process.env.CUSTOMER_INSPECTION_CHECKIN_LEAD_HOURS; else process.env.CUSTOMER_INSPECTION_CHECKIN_LEAD_HOURS = prevLead;
    customerInspectionService.sendCheckinInspection = prevSend;
    settingsService.getCustomerInspectionConfig = prevCfg;
  });

  const now = Date.now();
  installReservationStub([
    { id: 'r_3h',  tenantId: 't1', status: 'CHECKED_OUT', returnAt: new Date(now + 3 * HOUR_MS) },  // within 6h → send
    { id: 'r_24h', tenantId: 't1', status: 'CHECKED_OUT', returnAt: new Date(now + 24 * HOUR_MS) }, // outside 6h → not yet
  ]);
  settingsService.getCustomerInspectionConfig = async () => ({ enabled: true, checkinModel: 'CUSTOMER' });
  const calls = [];
  customerInspectionService.sendCheckinInspection = async ({ reservationId }) => { calls.push(reservationId); return { ok: true }; };

  const res = await _sweepCheckinRemindersOnce();
  assert.deepEqual(calls, ['r_3h']);
  assert.equal(res.sent, 1);
});
