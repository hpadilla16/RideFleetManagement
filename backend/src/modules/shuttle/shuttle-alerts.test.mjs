import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

// Env BEFORE the imports: the scheduler statically imports prisma, the
// provider client and the zones service.
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://u:p@localhost:5432/testdb';
process.env.INTEGRATION_ENC_KEY = process.env.INTEGRATION_ENC_KEY || crypto.randomBytes(32).toString('base64');

const {
  normalizeProviderAlert,
  mapAlertType,
  alertDedupeRef,
  arrivalState,
  buildStaffAlertMessages,
  buildArrivalSms,
  ARRIVAL_FRESH_MS,
} = await import('./shuttle-zone-alerts.js');
const { pollTenantAlerts, __resetWatermarksForTests } = await import('./shuttle-alerts.scheduler.js');

test.beforeEach(() => { __resetWatermarksForTests(); });

const NOW = new Date('2026-08-24T15:00:00Z').getTime();
const minutesAgo = (m) => new Date(NOW - m * 60_000).toISOString();

// ── normalization (the ASSUMED provider shape, defensively parsed) ──────────

const CTX = () => ({
  zoneByProviderId: new Map([['prov-1', { id: 'z1' }]]),
  vehicleByExternalId: new Map([['dev-1', 'v1']]),
  now: NOW,
});

test('mapAlertType: keyword mapping across plausible spellings; unknown is null', () => {
  assert.equal(mapAlertType('zone_enter'), 'ENTER');
  assert.equal(mapAlertType('Geofence Entry'), 'ENTER');
  assert.equal(mapAlertType('arrival'), 'ENTER');
  assert.equal(mapAlertType('zone_exit'), 'EXIT');
  assert.equal(mapAlertType('LEFT ZONE'), 'EXIT');
  assert.equal(mapAlertType('departed'), 'EXIT');
  assert.equal(mapAlertType('off_route'), 'OFF_ROUTE');
  assert.equal(mapAlertType('route deviation'), 'OFF_ROUTE');
  assert.equal(mapAlertType('speeding'), null);
  assert.equal(mapAlertType(''), null);
});

test('normalizeProviderAlert: the canonical assumed shape lands fully resolved', () => {
  const v = normalizeProviderAlert({
    alert_id: 'a-100', alert_type: 'zone_enter', zone_id: 'prov-1',
    device_id: 'dev-1', dt_alert: minutesAgo(2),
  }, CTX());
  assert.equal(v.ok, true);
  assert.equal(v.alert.type, 'ENTER');
  assert.equal(v.alert.zoneId, 'z1');
  assert.equal(v.alert.vehicleId, 'v1');
  assert.equal(v.alert.providerRef, 'a-100');
  assert.equal(v.alert.occurredAt.toISOString(), minutesAgo(2));
});

test('normalizeProviderAlert: alternate spellings + nested refs still resolve', () => {
  const v = normalizeProviderAlert({
    id: 7, type: 'geofence_exit', zone: { zone_id: 'prov-1' },
    device: { device_id: 'dev-1' }, occurred_at: minutesAgo(1),
  }, CTX());
  assert.equal(v.ok, true);
  assert.equal(v.alert.type, 'EXIT');
  assert.equal(v.alert.zoneId, 'z1');
  assert.equal(v.alert.vehicleId, 'v1');
  assert.equal(v.alert.providerRef, '7');
});

test('normalizeProviderAlert: surprises are SKIPPED with a reason, never guessed', () => {
  assert.equal(normalizeProviderAlert(null, CTX()).ok, false);
  assert.equal(normalizeProviderAlert({ alert_type: 'idling', dt_alert: minutesAgo(1) }, CTX()).ok, false); // unknown type
  assert.equal(normalizeProviderAlert({ alert_type: 'zone_enter' }, CTX()).ok, false);                       // no timestamp
  assert.equal(normalizeProviderAlert({ alert_type: 'zone_enter', dt_alert: 'garbage' }, CTX()).ok, false);
  const future = normalizeProviderAlert({ alert_type: 'zone_enter', dt_alert: new Date(NOW + 3600_000).toISOString() }, CTX());
  assert.equal(future.ok, false, 'future timestamps are provider garbage');
});

test('normalizeProviderAlert: unknown zone/device stay null (feed-only), no invented links', () => {
  const v = normalizeProviderAlert({
    alert_id: 'a-1', alert_type: 'zone_enter', zone_id: 'prov-UNKNOWN',
    device_id: 'dev-UNKNOWN', dt_alert: minutesAgo(1),
  }, CTX());
  assert.equal(v.ok, true);
  assert.equal(v.alert.zoneId, null);
  assert.equal(v.alert.vehicleId, null);
});

test('an id-less entry gets a STABLE derived ref — same entry, same ref, different entry, different ref', () => {
  const entry = { alert_type: 'zone_enter', zone_id: 'prov-1', device_id: 'dev-1', dt_alert: minutesAgo(3) };
  const a = normalizeProviderAlert({ ...entry }, CTX());
  const b = normalizeProviderAlert({ ...entry }, CTX());
  assert.equal(a.alert.providerRef, b.alert.providerRef, 'idempotency needs determinism');
  assert.match(a.alert.providerRef, /^derived:/);
  const c = normalizeProviderAlert({ ...entry, dt_alert: minutesAgo(4) }, CTX());
  assert.notEqual(a.alert.providerRef, c.alert.providerRef);
  assert.equal(alertDedupeRef({ deviceId: 'd', zoneRef: 'z', type: 'ENTER', atIso: 'x' }),
    alertDedupeRef({ deviceId: 'd', zoneRef: 'z', type: 'ENTER', atIso: 'x' }));
});

// ── arrivalState (the Screen-16 banner decision) ────────────────────────────

const ZONES = new Map([['z1', { name: 'Pickup Lot B', walkingDirections: 'Sign B-4' }]]);

test('arrivalState: a fresh un-exited ENTER = arrived, with the spot name + walking text', () => {
  const out = arrivalState([
    { type: 'ENTER', zoneId: 'z1', vehicleId: 'v1', occurredAt: new Date(NOW - 60_000) },
  ], ZONES, NOW);
  assert.equal(out.arrivedAtSpot, true);
  assert.equal(out.spotName, 'Pickup Lot B');
  assert.equal(out.spotWalkingDirections, 'Sign B-4');
});

test('arrivalState: a newer EXIT clears it; a stale ENTER never lies', () => {
  const exited = arrivalState([
    { type: 'EXIT', zoneId: 'z1', vehicleId: 'v1', occurredAt: new Date(NOW - 30_000) },
    { type: 'ENTER', zoneId: 'z1', vehicleId: 'v1', occurredAt: new Date(NOW - 120_000) },
  ], ZONES, NOW);
  assert.equal(exited.arrivedAtSpot, false);

  const stale = arrivalState([
    { type: 'ENTER', zoneId: 'z1', vehicleId: 'v1', occurredAt: new Date(NOW - ARRIVAL_FRESH_MS - 60_000) },
  ], ZONES, NOW);
  assert.equal(stale.arrivedAtSpot, false);

  assert.equal(arrivalState([], ZONES, NOW).arrivedAtSpot, false);
});

// ── message builders ────────────────────────────────────────────────────────

test('staff messages carry vehicle, zone, sede and the PROVIDER event time', () => {
  const msg = buildStaffAlertMessages({
    type: 'ENTER', zoneName: 'Pickup Lot B', vehicleLabel: 'Ford Transit · IKT-482',
    locationName: 'LAX Airport', occurredAt: new Date('2026-08-24T14:28:00Z'),
  });
  assert.match(msg.subject, /Ford Transit · IKT-482 entered Pickup Lot B/);
  assert.match(msg.text, /14:28 UTC/);
  assert.match(msg.smsBody, /^Shuttle alert:/);
});

test('arrival SMS: Spanish by locale, vehicle identity + walking text included, nothing else', () => {
  const es = buildArrivalSms({
    spotName: 'Lot B', walkingDirections: 'Ve al letrero B-4', vehicleName: 'Ford Transit',
    vehiclePlate: 'ABC-123', brandName: 'RideFleet', locale: 'es-PR',
  });
  assert.match(es, /^RideFleet: tu shuttle llegó a Lot B\./);
  assert.match(es, /Ford Transit \(ABC-123\)/);
  assert.match(es, /letrero B-4/);
  const en = buildArrivalSms({ spotName: 'Lot B', locale: 'en-US' });
  assert.match(en, /your shuttle has arrived at Lot B\./);
});

// ── the scheduler: idempotent re-poll + fan-out exactly once ────────────────

function world({ zones = [], rawAlerts = [], recipients = null, requests = [] } = {}) {
  const alertRows = [];
  const emails = [];
  const smses = [];
  const warns = [];
  let idSeq = 0;
  const deps = {
    now: () => NOW,
    logger: { info: () => {}, warn: (msg, meta) => warns.push({ msg, meta }) },
    provider: { hasApiKey: async () => true, listRawAlerts: async () => rawAlerts },
    syncZoneToProvider: async (z) => z, // sync retries covered in shuttle-zones.test.mjs
    mailer: { sendEmail: async (args) => { emails.push(args); } },
    smsSend: async (args) => { smses.push(args); },
    resolveBrand: async () => ({ companyName: 'RideFleet' }),
    prisma: {
      shuttleZone: { findMany: async ({ where }) => zones.filter((z) => z.tenantId === where.tenantId && z.active) },
      vehicleTelematicsDevice: {
        findMany: async () => [{ externalDeviceId: 'dev-1', vehicleId: 'v1' }],
      },
      shuttleAlert: {
        create: async ({ data }) => {
          if (alertRows.some((r) => r.tenantId === data.tenantId && r.providerRef === data.providerRef)) {
            const err = new Error('Unique constraint failed'); err.code = 'P2002'; throw err;
          }
          const row = { id: `al_${++idSeq}`, staffNotifiedAt: null, arrivalNotifiedAt: null, ...data };
          alertRows.push(row);
          return row;
        },
        update: async ({ where, data }) => {
          const row = alertRows.find((r) => r.id === where.id);
          Object.assign(row || {}, data);
          return row;
        },
      },
      shuttleTrackerConfig: {
        findFirst: async () => (recipients ? { alertRecipientsJson: recipients } : null),
      },
      location: { findFirst: async () => ({ name: 'LAX Airport' }) },
      vehicle: { findFirst: async () => ({ make: 'Ford', model: 'Transit', plate: 'IKT-482' }) },
      shuttleRequest: { findMany: async () => requests },
    },
  };
  return { deps, alertRows, emails, smses, warns };
}

const PICKUP_ZONE = {
  id: 'z1', tenantId: 't1', locationId: 'locA', name: 'Pickup Lot B', kind: 'ZONE',
  isPickupSpot: true, walkingDirections: 'Sign B-4', providerZoneId: 'prov-1',
  providerSyncStatus: 'SYNCED', notifyOnEnter: true, notifyOnExit: false,
  notifyOnOffRoute: false, active: true, geometryJson: { points: [] },
};

const RAW_ENTER = { alert_id: 'a-1', alert_type: 'zone_enter', zone_id: 'prov-1', device_id: 'dev-1', dt_alert: minutesAgo(2) };

test('a tenant with no active zones is skipped — zero provider calls', async () => {
  let providerCalls = 0;
  const w = world({ zones: [] });
  w.deps.provider.listRawAlerts = async () => { providerCalls++; return []; };
  const out = await pollTenantAlerts('t1', w.deps);
  assert.deepEqual(out, { skipped: true });
  assert.equal(providerCalls, 0);
});

test('IDEMPOTENT RE-POLL: the same provider entries twice = one row, one fan-out, no dupes', async () => {
  const w = world({
    zones: [PICKUP_ZONE],
    rawAlerts: [RAW_ENTER],
    recipients: [{ name: 'HP', email: 'hp@ride.co', channels: ['EMAIL'] }],
    requests: [{ id: 'req1', smsOptIn: true, customerPhone: '+17875550100', reservation: { customer: { locale: 'es' } } }],
  });

  const first = await pollTenantAlerts('t1', w.deps);
  assert.equal(first.created, 1);
  assert.equal(w.alertRows.length, 1);
  assert.equal(w.emails.length, 1, 'staff email once');
  assert.equal(w.smses.length, 1, 'arrival sms once');

  // Second tick re-reads the same window (the lookback) — everything collapses.
  const second = await pollTenantAlerts('t1', w.deps);
  assert.equal(second.created, 0);
  assert.equal(w.alertRows.length, 1, 'no duplicate row on re-poll');
  assert.equal(w.emails.length, 1, 'no duplicate staff email');
  assert.equal(w.smses.length, 1, 'no duplicate arrival sms — the providerRef unique IS the debounce');
});

test('ARRIVAL FAN-OUT: ENTER on a pickup spot notifies opted-in open requests ONLY, and stamps the row', async () => {
  const w = world({
    zones: [PICKUP_ZONE],
    rawAlerts: [RAW_ENTER],
    requests: [
      { id: 'r-opted', smsOptIn: true, customerPhone: '+17875550100', reservation: { customer: { locale: 'es' } } },
      { id: 'r-noopt', smsOptIn: false, customerPhone: '+17875550200', reservation: null },
      { id: 'r-nophone', smsOptIn: true, customerPhone: '', reservation: null },
    ],
  });
  const out = await pollTenantAlerts('t1', w.deps);
  assert.equal(out.arrivalSms, 1);
  assert.equal(w.smses.length, 1);
  assert.equal(w.smses[0].to, '+17875550100');
  assert.match(w.smses[0].body, /tu shuttle llegó a Pickup Lot B/);
  assert.match(w.smses[0].body, /Ford Transit \(IKT-482\)/);
  assert.match(w.smses[0].body, /Sign B-4/);
  assert.ok(w.alertRows[0].arrivalNotifiedAt instanceof Date, 'processed-marker stamped');
});

test('an ENTER on a NON-pickup zone notifies staff (per toggle) but never customers', async () => {
  const w = world({
    zones: [{ ...PICKUP_ZONE, isPickupSpot: false }],
    rawAlerts: [RAW_ENTER],
    recipients: [
      { name: 'HP', email: 'hp@ride.co', channels: ['EMAIL', 'SMS'], phone: '+17875550999' },
    ],
    requests: [{ id: 'r-opted', smsOptIn: true, customerPhone: '+17875550100', reservation: null }],
  });
  const out = await pollTenantAlerts('t1', w.deps);
  assert.equal(out.staffAttempts, 2, 'email + sms to the recipient');
  assert.equal(w.emails.length, 1);
  assert.equal(w.smses.length, 1);
  assert.equal(w.smses[0].to, '+17875550999', 'the STAFF phone, not the customer');
  assert.equal(out.arrivalSms, 0);
  assert.ok(w.alertRows[0].staffNotifiedAt instanceof Date);
});

test('an EXIT with the enter-only toggle stays feed-only (no staff notification)', async () => {
  const w = world({
    zones: [PICKUP_ZONE], // notifyOnExit: false
    rawAlerts: [{ alert_id: 'a-2', alert_type: 'zone_exit', zone_id: 'prov-1', device_id: 'dev-1', dt_alert: minutesAgo(1) }],
    recipients: [{ name: 'HP', email: 'hp@ride.co', channels: ['EMAIL'] }],
  });
  const out = await pollTenantAlerts('t1', w.deps);
  assert.equal(out.created, 1, 'the row still lands for the feed');
  assert.equal(out.staffAttempts, 0);
  assert.equal(w.emails.length, 0);
});

test('unrecognized entries are warned + skipped; a zone-less alert is recorded feed-only', async () => {
  const w = world({
    zones: [PICKUP_ZONE],
    rawAlerts: [
      { alert_id: 'a-x', alert_type: 'harsh_braking', dt_alert: minutesAgo(1) },              // unknown type → skip
      { alert_id: 'a-y', alert_type: 'zone_enter', zone_id: 'prov-???', device_id: 'dev-1', dt_alert: minutesAgo(1) }, // unknown zone → feed-only
    ],
    recipients: [{ name: 'HP', email: 'hp@ride.co', channels: ['EMAIL'] }],
    requests: [{ id: 'r-opted', smsOptIn: true, customerPhone: '+17875550100', reservation: null }],
  });
  const out = await pollTenantAlerts('t1', w.deps);
  assert.equal(out.skippedEntries, 1);
  assert.ok(w.warns.some((x) => x.msg.includes('skipping unrecognized alert entry')));
  assert.equal(out.created, 1);
  assert.equal(w.alertRows[0].zoneId, null);
  assert.equal(out.staffAttempts, 0, 'no zone, no toggles, no fan-out');
  assert.equal(out.arrivalSms, 0);
});

test('one broken notification channel never blocks the rest of the fan-out', async () => {
  const w = world({
    zones: [PICKUP_ZONE],
    rawAlerts: [RAW_ENTER],
    recipients: [{ name: 'HP', email: 'hp@ride.co', channels: ['EMAIL'] }],
    requests: [{ id: 'r-opted', smsOptIn: true, customerPhone: '+17875550100', reservation: null }],
  });
  w.deps.mailer.sendEmail = async () => { throw new Error('smtp down'); };
  const out = await pollTenantAlerts('t1', w.deps);
  assert.equal(out.created, 1);
  assert.equal(out.arrivalSms, 1, 'arrival sms still went out despite the dead mailer');
  assert.ok(w.warns.some((x) => x.msg.includes('staff email failed')));
});
