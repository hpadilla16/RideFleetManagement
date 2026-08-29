/**
 * No-show fan-out — DB-free with an in-memory prisma (Phase 3, 2026-08-25;
 * approved mockup Screen 17).
 *
 * What carries the operation:
 *   - the SMS copy is MODE-AWARE, the approved distinction verbatim:
 *     cyclical promises the next bus, on-demand promises the counter — never
 *     the other way around;
 *   - consent: the SMS goes only to smsOptIn rows with a phone;
 *   - ONE alert row per no-show (providerRef unique = the debounce), and the
 *     whole thing is idempotent — a re-marked request re-notifies nobody;
 *   - the ephemeral location key dies with the request.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { shuttleRequestsService } from './shuttle-requests.service.js';
import { buildNoShowSms, buildNoShowStaffEmail } from './shuttle-zone-alerts.js';

// ─── the pure copy builders ─────────────────────────────────────────────────

test('CYCLICAL copy (es): espera el próximo shuttle + headway + tel — a next pass is a real promise', () => {
  const sms = buildNoShowSms({
    mode: 'NON_STOP', spotName: 'Lot B', headwayMinutes: 10,
    counterPhone: '(310) 555-0100', brandName: 'RideFleet', locale: 'es-PR',
  });
  assert.match(sms, /no pudimos encontrarte en Lot B/);
  assert.match(sms, /Espera el próximo shuttle \(~10 min\)/);
  assert.match(sms, /llama al counter: \(310\) 555-0100/);
  assert.equal(sms.includes('contactará'), false, 'cyclical never promises a counter call-back');
});

test('ON_DEMAND copy (es): el counter te contactará — NO next bus is implied', () => {
  const sms = buildNoShowSms({
    mode: 'ON_DEMAND', spotName: 'Lot B', headwayMinutes: 10,
    counterPhone: '(310) 555-0100', brandName: 'RideFleet', locale: 'es',
  });
  assert.match(sms, /El counter te contactará para coordinar tu recogida/);
  assert.equal(sms.includes('próximo shuttle'), false);
  assert.equal(sms.includes('~10 min'), false, 'headway is a cyclical promise only');
});

test('bilingual: an en locale gets English; unknown headway and missing phone degrade cleanly', () => {
  const en = buildNoShowSms({ mode: 'NON_STOP', spotName: 'Lot B', headwayMinutes: null, counterPhone: '', locale: 'en-US' });
  assert.match(en, /we couldn't find you at Lot B/);
  assert.match(en, /wait for the next shuttle\./);
  assert.equal(en.includes('call the counter'), false, 'no phone = no dead call line');
  const es = buildNoShowSms({ mode: 'ON_DEMAND', spotName: null, locale: 'es' });
  assert.match(es, /tu punto de recogida/);
});

test('staff email: names and counts only — never a phone number or coordinates', () => {
  const msg = buildNoShowStaffEmail({
    customerName: 'Juan P.', partySize: 2, bags: 3, spotName: 'Lot B',
    vehicleLabel: 'Van 2', locationName: 'LAX Airport', occurredAt: new Date('2026-08-25T19:42:00Z'),
  });
  assert.match(msg.subject, /Shuttle no-show: Juan P\. at Lot B — LAX Airport/);
  assert.match(msg.text, /\(2 pax, 3 bags\)/);
  assert.match(msg.text, /19:42 UTC/);
});

// ─── the service fan-out, in-memory prisma ──────────────────────────────────

const matches = (row, where = {}) => Object.entries(where).every(([k, v]) => {
  if (v && typeof v === 'object' && 'in' in v) return v.in.includes(row[k]);
  return row[k] === v;
});

function table(rows) {
  return {
    rows,
    async findFirst({ where } = {}) { return rows.find((r) => matches(r, where)) || null; },
    async findMany({ where } = {}) { return rows.filter((r) => matches(r, where)); },
    async update({ where, data }) {
      const row = rows.find((r) => r.id === where.id);
      for (const [k, v] of Object.entries(data)) {
        row[k] = v && typeof v === 'object' && 'increment' in v ? (row[k] || 0) + v.increment : v;
      }
      return { ...row };
    },
    async create({ data }) {
      // Honor the (tenantId, providerRef) unique the way postgres would.
      if (data.providerRef && rows.some((r) => r.tenantId === data.tenantId && r.providerRef === data.providerRef)) {
        const e = new Error('unique violation'); e.code = 'P2002'; throw e;
      }
      const row = { id: `alert_${rows.length + 1}`, ...data };
      rows.push(row);
      return { ...row };
    },
  };
}

function makeWorld({ mode = 'ON_DEMAND', smsOptIn = true, recipients = null } = {}) {
  const requests = table([{
    id: 'req_1', tenantId: 't1', locationId: 'lax', reservationId: 'res_1',
    customerName: 'Juan P.', customerPhone: '+13105550182', partySize: 2, bags: 3,
    pickupSpotZoneId: 'zone_b', assignedVehicleId: 'v1',
    status: 'READY', smsOptIn, callCount: 1,
  }]);
  const alerts = table([]);
  const sms = [];
  const emails = [];
  const cleared = [];
  const deps = {
    prisma: {
      shuttleRequest: requests,
      shuttleAlert: alerts,
      shuttleTrackerConfig: table([{ id: 'c1', tenantId: 't1', locationId: 'lax', mode, headwayMinutes: 10, vehicleIdsJson: ['v1'], alertRecipientsJson: recipients }]),
      location: table([{ id: 'lax', tenantId: 't1', name: 'LAX Airport', locationConfig: JSON.stringify({ locationPhone: '(310) 555-0100' }) }]),
      shuttleZone: table([{ id: 'zone_b', tenantId: 't1', locationId: 'lax', name: 'Lot B', isPickupSpot: true, active: true }]),
      reservation: table([{ id: 'res_1', tenantId: 't1', customer: { locale: 'es-PR' } }]),
      vehicle: table([{ id: 'v1', tenantId: 't1', make: 'Ford', model: 'Transit 350', plate: 'IKT-482' }]),
    },
    logger: { info() {}, warn() {}, error() {} },
    smsSend: async (args) => { sms.push(args); },
    sendEmail: async (args) => { emails.push(args); },
    resolveBrand: async () => ({ companyName: 'RideFleet' }),
    clearCustomerLocation: async (id) => { cleared.push(id); },
    now: () => new Date('2026-08-25T19:42:00Z'),
  };
  return { deps, requests, alerts, sms, emails, cleared };
}

test('markNoShow: NO_SHOW + mode-aware SMS + one REQUEST_NO_SHOW alert + location key cleared', async () => {
  const w = makeWorld({ mode: 'NON_STOP' });
  const out = await shuttleRequestsService.markNoShow('req_1', { scope: { tenantId: 't1' }, userId: 'u9', reason: 'driver could not find', actorContext: 'driver' }, w.deps);

  assert.equal(out.request.status, 'NO_SHOW');
  assert.equal(out.request.closedByUserId, 'u9');
  assert.equal(out.notified, true);

  // SMS — Spanish (reservation locale), cyclical copy, spot name, tel.
  assert.equal(w.sms.length, 1);
  assert.equal(w.sms[0].to, '+13105550182');
  assert.equal(w.sms[0].tenantId, 't1');
  assert.match(w.sms[0].body, /RideFleet: no pudimos encontrarte en Lot B/);
  assert.match(w.sms[0].body, /Espera el próximo shuttle \(~10 min\)/);
  assert.match(w.sms[0].body, /\(310\) 555-0100/);

  // Alert row — typed, deduped ref, ids only in rawJson (no phone, no coords).
  assert.equal(w.alerts.rows.length, 1);
  const alert = w.alerts.rows[0];
  assert.equal(alert.type, 'REQUEST_NO_SHOW');
  assert.equal(alert.providerRef, 'noshow:req_1');
  assert.equal(alert.zoneId, 'zone_b');
  assert.equal(alert.vehicleId, 'v1');
  assert.equal(alert.rawJson.includes('+1310'), false, 'no phone in the alert row');

  // Ephemeral location: delete-on-state-change.
  await new Promise((r) => setImmediate(r)); // the clear is fire-and-forget
  assert.deepEqual(w.cleared, ['req_1']);
});

test('markNoShow in ON_DEMAND: the counter promise, never the next-bus promise', async () => {
  const w = makeWorld({ mode: 'ON_DEMAND' });
  await shuttleRequestsService.markNoShow('req_1', { scope: { tenantId: 't1' } }, w.deps);
  assert.equal(w.sms.length, 1);
  assert.match(w.sms[0].body, /El counter te contactará/);
  assert.equal(w.sms[0].body.includes('próximo shuttle'), false);
});

test('IDEMPOTENT: marking an already-closed request re-notifies NOBODY', async () => {
  const w = makeWorld({ mode: 'NON_STOP' });
  await shuttleRequestsService.markNoShow('req_1', { scope: { tenantId: 't1' } }, w.deps);
  const again = await shuttleRequestsService.markNoShow('req_1', { scope: { tenantId: 't1' } }, w.deps);
  assert.equal(again.request.status, 'NO_SHOW');
  assert.equal(again.notified, false);
  assert.equal(w.sms.length, 1, 'one SMS ever');
  assert.equal(w.alerts.rows.length, 1, 'one alert row ever');
});

test('consent: no smsOptIn = no SMS — but the alert row and the state change still land', async () => {
  const w = makeWorld({ smsOptIn: false });
  const out = await shuttleRequestsService.markNoShow('req_1', { scope: { tenantId: 't1' } }, w.deps);
  assert.equal(out.request.status, 'NO_SHOW');
  assert.equal(out.notified, false);
  assert.equal(w.sms.length, 0);
  assert.equal(w.alerts.rows.length, 1);
});

test('optional staff email goes to EMAIL-channel recipients of the Phase-2 list', async () => {
  const w = makeWorld({
    recipients: [
      { name: 'Counter', email: 'counter@lax.example', channels: ['EMAIL'] },
      { name: 'SMS-only', phone: '+17875550001', channels: ['SMS'] },
    ],
  });
  await shuttleRequestsService.markNoShow('req_1', { scope: { tenantId: 't1' } }, w.deps);
  assert.equal(w.emails.length, 1, 'EMAIL channel only — the SMS-only recipient is not emailed');
  assert.equal(w.emails[0].to, 'counter@lax.example');
  assert.match(w.emails[0].subject, /Shuttle no-show: Juan P\./);
});

test('scoping fails closed: a foreign-tenant scope cannot no-show the row', async () => {
  const w = makeWorld();
  await assert.rejects(
    () => shuttleRequestsService.markNoShow('req_1', { scope: { tenantId: 't2' } }, w.deps),
    (e) => e.status === 404,
  );
  assert.equal(w.sms.length, 0);
});

test('a dead SMS provider never resurrects the close', async () => {
  const w = makeWorld();
  w.deps.smsSend = async () => { throw new Error('provider down'); };
  const out = await shuttleRequestsService.markNoShow('req_1', { scope: { tenantId: 't1' } }, w.deps);
  assert.equal(out.request.status, 'NO_SHOW');
  assert.equal(out.notified, false);
  assert.equal(w.alerts.rows.length, 1, 'the alert row still lands');
});

test('markPickedUp: COMPLETED through the same close (location key cleared with it)', async () => {
  const w = makeWorld();
  const row = await shuttleRequestsService.markPickedUp('req_1', { tenantId: 't1' }, 'u3', null, w.deps);
  assert.equal(row.status, 'COMPLETED');
  assert.equal(row.closedByUserId, 'u3');
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(w.cleared, ['req_1']);
  assert.equal(w.sms.length, 0, 'picked-up sends nothing');
});

// ─── route wiring pins ──────────────────────────────────────────────────────

test('the staff endpoints exist and the no-show route goes through the fan-out service', () => {
  const src = readFileSync(new URL('./shuttle-requests.routes.js', import.meta.url), 'utf8');
  assert.match(src, /post\('\/:id\/no-show'/);
  assert.match(src, /markNoShow\(/, 'the route must call the fan-out, not the bare close');
  assert.match(src, /post\('\/:id\/picked-up'/);
  assert.match(src, /markPickedUp\(/);
});
