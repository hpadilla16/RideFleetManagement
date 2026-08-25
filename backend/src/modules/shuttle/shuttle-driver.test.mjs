/**
 * Driver mode — the pure decisions (Phase 3 driver surface, 2026-08-25;
 * approved mockup Screens 12–15 + 17a). DB-free; the service half has its
 * own suite (shuttle-driver-service.test.mjs).
 *
 * What carries the operation here:
 *   - the token is the WHOLE credential: 192-bit, house base64url shape;
 *   - a shift can never outlive 24h, and the default dies at midnight;
 *   - roster entries leak coordinates ONLY while a customer shares, and the
 *     zone payload carries drawing fields, never provider/sync state.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mintDriverToken, shiftExpiry, shiftState, SHIFT_MAX_HOURS,
  DRIVER_ISSUE_CATEGORIES, ISSUE_NOTE_MAX, validateIssueInput,
  validateDriverMessage, validateDriverName, MESSAGE_MAX,
  driverZonePayload, driverRosterEntry,
} from './shuttle-driver.js';

// ─── token ──────────────────────────────────────────────────────────────────

test('mintDriverToken: 192-bit base64url (32 chars, house alphabet), unique per mint', () => {
  const seen = new Set();
  for (let i = 0; i < 50; i++) {
    const t = mintDriverToken();
    assert.equal(t.length, 32, '24 bytes base64url = 32 chars');
    assert.match(t, /^[A-Za-z0-9_-]+$/, 'base64url alphabet only — URL-safe, no padding');
    seen.add(t);
  }
  assert.equal(seen.size, 50, 'no collisions across 50 mints');
});

// ─── expiry ─────────────────────────────────────────────────────────────────

test('shiftExpiry default: end of the current day — an unspecified shift dies at midnight', () => {
  const now = new Date('2026-08-25T14:30:00');
  const exp = shiftExpiry({ now });
  assert.equal(exp.getFullYear(), 2026);
  assert.equal(exp.getMonth(), 7);
  assert.equal(exp.getDate(), 25, 'same calendar day');
  assert.equal(exp.getHours(), 23);
  assert.equal(exp.getMinutes(), 59);
  assert.ok(exp.getTime() - now.getTime() < SHIFT_MAX_HOURS * 3600 * 1000, 'end-of-day is always under the 24h ceiling');
});

test('shiftExpiry hours: honored within [1, 24], clamped outside — no immortal links', () => {
  const now = new Date('2026-08-25T14:30:00Z');
  assert.equal(shiftExpiry({ hours: 5, now }).getTime(), now.getTime() + 5 * 3600 * 1000);
  assert.equal(shiftExpiry({ hours: 500, now }).getTime(), now.getTime() + 24 * 3600 * 1000, 'ceiling is 24h');
  assert.equal(shiftExpiry({ hours: 0.2, now }).getTime(), now.getTime() + 1 * 3600 * 1000, 'floor is 1h');
});

// ─── state ──────────────────────────────────────────────────────────────────

test('shiftState: ACTIVE only when un-revoked and un-expired; everything else is a distinct dead state', () => {
  const now = new Date('2026-08-25T12:00:00Z').getTime();
  const base = { expiresAt: new Date('2026-08-25T23:59:59Z'), revokedAt: null };
  assert.equal(shiftState(null, now), 'NOT_FOUND');
  assert.equal(shiftState(base, now), 'ACTIVE');
  assert.equal(shiftState({ ...base, revokedAt: new Date() }, now), 'REVOKED');
  assert.equal(shiftState({ ...base, expiresAt: new Date('2026-08-25T11:59:59Z') }, now), 'EXPIRED');
  assert.equal(shiftState({ ...base, expiresAt: 'garbage' }, now), 'EXPIRED', 'unparseable expiry fails closed');
});

// ─── inputs ─────────────────────────────────────────────────────────────────

test('validateIssueInput: the five approved categories, case-normalized; anything else refuses', () => {
  for (const c of DRIVER_ISSUE_CATEGORIES) {
    assert.equal(validateIssueInput({ category: c }).ok, true);
  }
  assert.equal(validateIssueInput({ category: 'mecanico' }).issue.category, 'MECANICO', 'lowercase normalizes');
  assert.equal(validateIssueInput({ category: 'ENGINE' }).ok, false);
  assert.equal(validateIssueInput({}).ok, false);
});

test('validateIssueInput: the note is optional, trimmed, and hard-capped — no unbounded driver prose', () => {
  assert.equal(validateIssueInput({ category: 'OTRO' }).issue.note, null);
  assert.equal(validateIssueInput({ category: 'OTRO', note: '  flat tire  ' }).issue.note, 'flat tire');
  const long = validateIssueInput({ category: 'OTRO', note: 'x'.repeat(2000) });
  assert.equal(long.issue.note.length, ISSUE_NOTE_MAX);
});

test('validateDriverMessage / validateDriverName: required, trimmed, capped', () => {
  assert.equal(validateDriverMessage('  Recoge en Terminal B  ').message, 'Recoge en Terminal B');
  assert.equal(validateDriverMessage('').ok, false);
  assert.equal(validateDriverMessage('x'.repeat(MESSAGE_MAX + 1)).ok, false);
  assert.equal(validateDriverName(' Luis M. ').driverName, 'Luis M.');
  assert.equal(validateDriverName('').ok, false);
  assert.equal(validateDriverName('x'.repeat(81)).ok, false);
});

// ─── payloads ───────────────────────────────────────────────────────────────

test('driverZonePayload: drawing fields cross, provider/sync/notify state does NOT', () => {
  const out = driverZonePayload({
    id: 'z1', name: 'Lot B', kind: 'ROUTE', isPickupSpot: true,
    geometryJson: { type: 'polyline', points: [{ lat: 1, lng: 2 }] }, toleranceM: 300,
    walkingDirections: ' sign B-4 ', walkingDirectionsEs: ' letrero B-4 ',
    providerZoneId: 'osg_99', providerSyncStatus: 'SYNCED', notifyOnEnter: true, active: true,
  });
  assert.deepEqual(out, {
    id: 'z1', name: 'Lot B', kind: 'ROUTE', isPickupSpot: true,
    geometry: { type: 'polyline', points: [{ lat: 1, lng: 2 }] }, toleranceM: 300,
    walkingDirections: 'sign B-4', walkingDirectionsEs: 'letrero B-4',
  });
  assert.equal('providerZoneId' in out, false, 'PICKED, never spread — provider ids stay staff-side');
});

test('driverRosterEntry not sharing: same card, sharing:false, NO lat/lng keys at all', () => {
  const out = driverRosterEntry({
    request: {
      id: 'req_1', customerName: ' Juan P. ', partySize: 2, bags: 3, status: 'READY',
      pickupNote: 'blue jacket', pickupSpotZoneId: 'z1', assignedVehicleId: null,
      createdAt: new Date(Date.now() - 5 * 60000),
    },
    fix: null, spotName: 'Lot B', shiftVehicleId: 'v1',
  });
  assert.equal(out.name, 'Juan P.');
  assert.equal(out.pickupSpot, 'Lot B');
  assert.equal(out.waitingMinutes, 5);
  assert.equal(out.sharing, false);
  assert.equal('lat' in out, false, 'not sharing = no coordinate keys, not null coordinates');
  assert.equal('lng' in out, false);
  assert.equal(out.assignedToYou, false);
});

test('driverRosterEntry sharing: coordinates + ageSeconds cross — the driver is who they exist for', () => {
  const now = Date.now();
  const out = driverRosterEntry({
    request: { id: 'req_1', customerName: 'Juan', partySize: 1, status: 'READY', createdAt: new Date(now) },
    fix: { lat: 33.9425, lng: -118.4081, at: now - 20 * 1000 },
    now,
  });
  assert.equal(out.sharing, true);
  assert.equal(out.lat, 33.9425);
  assert.equal(out.lng, -118.4081);
  assert.equal(out.ageSeconds, 20);
});

test('driverRosterEntry assignment: assignedToYou highlights THIS vehicle only; a foreign van still labels', () => {
  const request = {
    id: 'req_1', customerName: 'Juan', partySize: 1, status: 'VIEWED',
    assignedVehicleId: 'v2', createdAt: new Date(),
  };
  const mine = driverRosterEntry({ request: { ...request, assignedVehicleId: 'v1' }, shiftVehicleId: 'v1', assignedVehicle: { make: 'Ford', model: 'Transit', plate: 'IKT-482' } });
  assert.equal(mine.assignedToYou, true);
  const theirs = driverRosterEntry({ request, shiftVehicleId: 'v1', assignedVehicle: { make: 'Ram', model: 'ProMaster', plate: 'XYZ-001' } });
  assert.equal(theirs.assignedToYou, false, 'assigned to another van is NOT yours');
  assert.equal(theirs.assignedVehicle.name, 'Ram ProMaster');
  assert.equal(theirs.assignedVehicle.plate, 'XYZ-001');
  const none = driverRosterEntry({ request: { ...request, assignedVehicleId: null }, shiftVehicleId: 'v1' });
  assert.equal(none.assignedVehicle, null);
});
