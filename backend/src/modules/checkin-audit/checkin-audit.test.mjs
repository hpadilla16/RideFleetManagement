/**
 * Post-check-in audit — Tier 1 rules (2026-09-03) + the damage-baseline
 * smallest slice. Run via: npm run test:checkin-audit
 *
 * Covers, in order:
 *  A. Model discipline — the 20260903_checkin_audit migration against
 *     schema.prisma (column parity), additive/idempotent statement rules, the
 *     pinned-predecessor sort (against 20260902_maintenance_checkin), and the
 *     four VehicleDamageReport baseline columns.
 *  B. The six T1 checks with the mockups' own numbers (impossible odometer
 *     41,210→41,190; 861 mi/day vs the 600 band; 577 mi / 5 days = 115/day
 *     clean; fuel 100%→45% with and without the refill fee; 8/8 photos +
 *     signature vs 2 missing angles).
 *  C. The close-time runner — findings persisted with dedupe per
 *     reservation+check (upsert, first detection wins), the PASS row on a
 *     clean run (and NOT after prior findings), entry errors emitting
 *     NEEDS_ACTION (sourceType CHECKIN_AUDIT, deduped), rulesEnabled=false
 *     short-circuit, and the never-throws contract.
 *  D. The dismiss fork (damage-baseline Mock 2) — NOT_ISSUE logs
 *     DISMISSED_NOT_ISSUE with the reviewer stamp; PREEXISTING (DAMAGE
 *     findings only — none exist in T1, so exercised through the generic API
 *     exactly as T2 will call it) creates the HARD_APPROVED ledger entry via
 *     the existing manual-damage path with source AUDIT_PREEXISTING +
 *     sourceAuditFindingId, and resolves the finding; the guards (400 on
 *     non-damage PREEXISTING, 400 on PASS, 409 on already-dismissed).
 *  E. The baseline slice — addManualDamage's internal-only provenance opts
 *     (HTTP body can never spoof them) and clearDamageReport (reason
 *     REQUIRED, HARD_APPROVED-only, FIXED-equivalent cleared state, audit
 *     log written when reservation-anchored).
 *  F. Wiring — checkin-close calls the Safe runner AFTER the maintenance
 *     hook; main.js mounts /api/checkin-audit; the notification center's
 *     source whitelist knows CHECKIN_AUDIT; the clear route exists.
 *
 * DB-FREE: service calls inject a fake db (maintenance-checkin.test.mjs
 * technique); the singleton is monkeypatched only for the two
 * customer-inspection functions that read it directly.
 */

// MUST be first — sets DATABASE_URL etc. before lib/prisma.js constructs.
import '../../lib/_two-factor-test-env.mjs';

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import { prisma } from '../../lib/prisma.js';
import {
  CHECK_KEYS,
  FINDING_STATUSES,
  DEFAULT_CHECKIN_AUDIT_CONFIG,
  REQUIRED_ANGLES,
  normalizeCheckinAuditConfig,
  checkOdometerImpossible,
  checkMilesOutlier,
  checkFuelUpNoRecord,
  checkFuelDropNoFee,
  checkEntriesIncomplete,
  checkBackdatedReturn,
  runT1Checks,
  runCheckinAuditForCloseSafe,
  dismissFinding,
  DISMISS_CLASSIFICATIONS,
} from './checkin-audit.service.js';
import { customerInspectionService } from '../customer-inspection/customer-inspection.service.js';
import { NOTIFICATION_SOURCE_TYPES } from '../notifications/notifications-emit.js';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

// ───────────────────────── A. model / migration discipline ─────────────────

const MIGRATION_DIR = '20260903_checkin_audit';
// The migration that was newest when this one shipped. Pinned predecessor,
// not "newest in repo" — see billing-model.test.mjs for why.
const MIGRATION_PREDECESSOR = '20260902_maintenance_checkin';
const SQL = readFileSync(join(ROOT, 'prisma', 'migrations', MIGRATION_DIR, 'migration.sql'), 'utf8');
const SCHEMA = readFileSync(join(ROOT, 'prisma', 'schema.prisma'), 'utf8');
const STATEMENTS = SQL.replace(/^\s*--.*$/gm, '');

test('CheckinAuditFinding: migration and schema.prisma declare the same columns', () => {
  const re = /CREATE TABLE IF NOT EXISTS "CheckinAuditFinding" \(([\s\S]*?)\n\);/;
  const m = STATEMENTS.match(re);
  assert.ok(m, 'migration creates CheckinAuditFinding');
  const sqlCols = [...m[1].matchAll(/^\s*"(\w+)"/gm)].map((x) => x[1]);

  const modelMatch = SCHEMA.match(/model CheckinAuditFinding \{([\s\S]*?)\n\}/);
  assert.ok(modelMatch, 'schema.prisma has model CheckinAuditFinding');
  const schemaCols = [...modelMatch[1].matchAll(/^\s{2}(\w+)\s/gm)]
    .map((x) => x[1])
    .filter((name) => !name.startsWith('@'));

  assert.deepEqual(sqlCols.sort(), schemaCols.sort());
});

test('migration is additive + idempotent: only IF NOT EXISTS creates and ADD COLUMN IF NOT EXISTS alters', () => {
  const creates = [...STATEMENTS.matchAll(/CREATE (TABLE|UNIQUE INDEX|INDEX)/g)];
  assert.ok(creates.length >= 4, 'creates the table + 3 indexes');
  for (const m of [...STATEMENTS.matchAll(/CREATE (?:TABLE|UNIQUE INDEX|INDEX)(?: IF NOT EXISTS)?/g)]) {
    assert.match(m[0], / IF NOT EXISTS$/, `not idempotent: ${m[0]}`);
  }
  const alters = [...STATEMENTS.matchAll(/ALTER TABLE "(\w+)"[^\n]*/g)];
  assert.equal(alters.length, 4, 'exactly the four baseline columns');
  for (const m of alters) {
    assert.equal(m[1], 'VehicleDamageReport', 'only the baseline columns alter an existing table');
    assert.match(m[0], /ADD COLUMN IF NOT EXISTS/, `not additive/idempotent: ${m[0]}`);
  }
  assert.ok(!/DROP|DELETE FROM|UPDATE /.test(STATEMENTS), 'nothing destructive');
});

test('migration sorts after its pinned predecessor (startup-migrate applies in name order)', () => {
  assert.ok(MIGRATION_DIR > MIGRATION_PREDECESSOR);
  const dirs = readdirSync(join(ROOT, 'prisma', 'migrations')).filter((d) => /^\d{8}/.test(d));
  assert.ok(dirs.includes(MIGRATION_PREDECESSOR), 'predecessor exists');
  assert.ok(dirs.includes(MIGRATION_DIR), 'this migration exists');
});

test('the four baseline columns land on VehicleDamageReport in BOTH migration and schema', () => {
  for (const col of ['sourceAuditFindingId', 'lastVerifiedAt', 'lastVerifiedPhotoRef', 'clearedReason']) {
    assert.match(STATEMENTS, new RegExp(`ALTER TABLE "VehicleDamageReport" ADD COLUMN IF NOT EXISTS "${col}"`), `migration adds ${col}`);
  }
  const model = SCHEMA.match(/model VehicleDamageReport \{([\s\S]*?)\n\}/)[1];
  for (const col of ['sourceAuditFindingId', 'lastVerifiedAt', 'lastVerifiedPhotoRef', 'clearedReason']) {
    assert.match(model, new RegExp(`\\n  ${col}\\s`), `schema has ${col}`);
    // additive = nullable: every one of the four is optional
    assert.match(model, new RegExp(`${col}\\s+\\w+\\?`), `${col} is nullable`);
  }
});

test('dedupe contract: unique (reservationId, checkKey) in migration and schema', () => {
  assert.match(STATEMENTS, /CREATE UNIQUE INDEX IF NOT EXISTS "CheckinAuditFinding_reservationId_checkKey_key"\s+ON "CheckinAuditFinding"\("reservationId", "checkKey"\)/);
  assert.match(SCHEMA, /@@unique\(\[reservationId, checkKey\]\)/);
});

test('contract constants are frozen and complete', () => {
  assert.deepEqual([...FINDING_STATUSES], ['OPEN', 'DISMISSED_NOT_ISSUE', 'RESOLVED']);
  assert.ok(Object.isFrozen(CHECK_KEYS) && Object.isFrozen(FINDING_STATUSES));
  assert.deepEqual([...REQUIRED_ANGLES], ['front', 'rear', 'left', 'right', 'frontSeat', 'rearSeat', 'dashboard', 'trunk']);
  assert.equal(DEFAULT_CHECKIN_AUDIT_CONFIG.milesPerDayBand, 600);
  assert.equal(DEFAULT_CHECKIN_AUDIT_CONFIG.fuelUpDelta, 0.25);
  assert.deepEqual([...DISMISS_CLASSIFICATIONS], ['NOT_ISSUE', 'PREEXISTING']);
});

// ───────────────────────── B. the six T1 checks — mockup numbers ────────────

test('ODO_IMPOSSIBLE: 41,210 → 41,190 (Mock 3) flags as ERROR citing both fields', () => {
  const f = checkOdometerImpossible({ odometerOut: 41210, odometerIn: 41190 });
  assert.ok(f);
  assert.equal(f.checkKey, 'ODO_IMPOSSIBLE');
  assert.equal(f.severity, 'ERROR');
  assert.equal(f.category, 'ENTRY');
  assert.equal(f.details.odometerOut, 41210);
  assert.equal(f.details.odometerIn, 41190);
  assert.deepEqual(f.details.fields, ['RentalAgreement.odometerOut', 'RentalAgreement.odometerIn']);
});

test('ODO_IMPOSSIBLE: 12,404 → 12,981 (Mock 2) passes; equal readings pass; nulls skip', () => {
  assert.equal(checkOdometerImpossible({ odometerOut: 12404, odometerIn: 12981 }), null);
  assert.equal(checkOdometerImpossible({ odometerOut: 500, odometerIn: 500 }), null);
  assert.equal(checkOdometerImpossible({ odometerOut: null, odometerIn: 100 }), null);
  assert.equal(checkOdometerImpossible({ odometerOut: 100, odometerIn: null }), null);
});

test('MILES_OUTLIER: 861 mi/day (Mock 1, RSV-2391) is outside the default 600 band', () => {
  // 2,583 miles over 3 days = 861/day
  const f = checkMilesOutlier({ odometerOut: 10000, odometerIn: 12583, rentalDays: 3 });
  assert.ok(f);
  assert.equal(f.checkKey, 'MILES_OUTLIER');
  assert.equal(f.severity, 'WARN');
  assert.equal(f.category, 'MILEAGE_FUEL');
  assert.equal(f.details.milesPerDay, 861);
  assert.equal(f.details.band, 600);
});

test('MILES_OUTLIER: 577 mi over 5 days = 115/day (Mock 2) passes; tenant band is honored', () => {
  assert.equal(checkMilesOutlier({ odometerOut: 12404, odometerIn: 12981, rentalDays: 5 }), null);
  // tighter tenant band flags the same trip
  const f = checkMilesOutlier({ odometerOut: 12404, odometerIn: 12981, rentalDays: 5 }, { milesPerDayBand: 100 });
  assert.ok(f);
  assert.equal(f.details.band, 100);
  // impossible readings are ODO_IMPOSSIBLE's finding, not this one's
  assert.equal(checkMilesOutlier({ odometerOut: 41210, odometerIn: 41190, rentalDays: 1 }), null);
});

test('FUEL_UP_NO_RECORD: +0.375 tank with nothing on record flags; +0.125 passes; a recorded refuel passes', () => {
  const f = checkFuelUpNoRecord({ fuelOut: 0.5, fuelIn: 0.875, refuelRecorded: false });
  assert.ok(f);
  assert.equal(f.checkKey, 'FUEL_UP_NO_RECORD');
  assert.equal(f.severity, 'WARN');
  assert.equal(f.details.delta, 0.375);
  assert.equal(f.details.threshold, 0.25);
  assert.equal(checkFuelUpNoRecord({ fuelOut: 0.5, fuelIn: 0.625, refuelRecorded: false }), null);
  assert.equal(checkFuelUpNoRecord({ fuelOut: 0.5, fuelIn: 0.875, refuelRecorded: true }), null);
});

test('FUEL_DROP_NO_FEE: 100% → 45% (Mock 2) with the refill fee billed passes; without it, flags the fee gap', () => {
  assert.equal(checkFuelDropNoFee({ fuelOut: 1, fuelIn: 0.45, fuelRefillCharged: true }), null);
  const f = checkFuelDropNoFee({ fuelOut: 1, fuelIn: 0.45, fuelRefillCharged: false });
  assert.ok(f);
  assert.equal(f.checkKey, 'FUEL_DROP_NO_FEE');
  assert.equal(f.severity, 'WARN');
  assert.equal(f.details.delta, 0.55);
  assert.ok(f.details.fields.some((x) => x.includes('FUEL_REFILL')), 'cites the charge it looked for');
  // a drop inside the threshold is normal usage, not a gap
  assert.equal(checkFuelDropNoFee({ fuelOut: 0.5, fuelIn: 0.375, fuelRefillCharged: false }), null);
});

test('ENTRIES_INCOMPLETE: 8/8 photos + signature (Mock 2) passes clean', () => {
  assert.equal(checkEntriesIncomplete({ photoKeys: [...REQUIRED_ANGLES], hasSignature: true }), null);
});

test('ENTRIES_INCOMPLETE: 2 angles missing (Mock 1, RSV-2388) flags and names them', () => {
  const keys = REQUIRED_ANGLES.filter((k) => k !== 'rearSeat' && k !== 'trunk');
  const f = checkEntriesIncomplete({ photoKeys: keys, hasSignature: true });
  assert.ok(f);
  assert.equal(f.category, 'ENTRY');
  assert.deepEqual(f.details.missingAngles, ['rearSeat', 'trunk']);
  assert.equal(f.details.photoCount, 6);
  assert.equal(f.details.requiredCount, 8);
});

test('ENTRIES_INCOMPLETE: missing signature flags even with all photos; mobile snake_case keys canonicalize', () => {
  const f = checkEntriesIncomplete({ photoKeys: [...REQUIRED_ANGLES], hasSignature: false });
  assert.ok(f);
  assert.equal(f.details.hasSignature, false);
  assert.deepEqual(f.details.missingAngles, []);
  // front_seat/rear_seat/dash are the mobile flow's aliases (inspection-photos-normalize)
  const aliased = ['front', 'rear', 'left', 'right', 'front_seat', 'rear_seat', 'dash', 'trunk'];
  assert.equal(checkEntriesIncomplete({ photoKeys: aliased, hasSignature: true }), null);
});

test('BACKDATED_RETURN: photos 4 min from returnedAt (Mock 2 "audited 4 min after close") pass; a 26h gap flags INFO', () => {
  const ret = '2026-08-29T09:42:00Z';
  assert.equal(checkBackdatedReturn({ returnedAt: ret, photoTimestamps: ['2026-08-29T09:46:00Z'] }), null);
  const f = checkBackdatedReturn({ returnedAt: '2026-08-28T08:00:00Z', photoTimestamps: ['2026-08-29T10:00:00Z'] });
  assert.ok(f);
  assert.equal(f.checkKey, 'BACKDATED_RETURN');
  assert.equal(f.severity, 'INFO');
  assert.equal(f.details.gapHours, 26);
  assert.equal(f.details.maxGapHours, 6);
});

test('BACKDATED_RETURN: no photo timestamps → skip (never guess)', () => {
  assert.equal(checkBackdatedReturn({ returnedAt: '2026-08-29T09:42:00Z', photoTimestamps: [] }), null);
});

test('runT1Checks: the Mock 2 clean close produces ZERO findings', () => {
  const findings = runT1Checks({
    odometerOut: 12404, odometerIn: 12981, rentalDays: 5,
    fuelOut: 1, fuelIn: 0.45, fuelRefillCharged: true, refuelRecorded: false,
    photoKeys: [...REQUIRED_ANGLES], hasSignature: true,
    returnedAt: '2026-08-29T09:42:00Z', photoTimestamps: ['2026-08-29T09:40:00Z'],
  });
  assert.deepEqual(findings, []);
});

test('runT1Checks: a bad close stacks findings — each is a distinct checkKey', () => {
  const findings = runT1Checks({
    odometerOut: 41210, odometerIn: 41190, rentalDays: 1,
    fuelOut: 1, fuelIn: 0.45, fuelRefillCharged: false, refuelRecorded: false,
    photoKeys: [], hasSignature: false,
    returnedAt: '2026-08-28T08:00:00Z', photoTimestamps: ['2026-08-29T10:00:00Z'],
  });
  const keys = findings.map((f) => f.checkKey);
  assert.deepEqual(keys, ['ODO_IMPOSSIBLE', 'FUEL_DROP_NO_FEE', 'ENTRIES_INCOMPLETE', 'BACKDATED_RETURN']);
  assert.equal(new Set(keys).size, keys.length);
  for (const f of findings) assert.ok(CHECK_KEYS.includes(f.checkKey));
});

test('normalizeCheckinAuditConfig: defaults ON with the NOTES numbers; junk falls back', () => {
  const d = normalizeCheckinAuditConfig(null);
  assert.deepEqual(d, { rulesEnabled: true, milesPerDayBand: 600, fuelUpDelta: 0.25, fuelDropDelta: 0.25, backdateGapHours: 6 });
  const c = normalizeCheckinAuditConfig({ rulesEnabled: false, milesPerDayBand: 'NaN', fuelUpDelta: -3 });
  assert.equal(c.rulesEnabled, false);
  assert.equal(c.milesPerDayBand, 600);
  assert.equal(c.fuelUpDelta, 0.25);
});

// ───────────────────────── C. the close-time runner ─────────────────────────

function makeDb({ inspection = null, signature = null, refillCharge = null, priorFindings = [], vehicle = null } = {}) {
  const state = {
    upserts: [],
    deletes: [],
    rows: new Map(priorFindings.map((r) => [`${r.reservationId}:${r.checkKey}`, r])),
  };
  const db = {
    rentalAgreementInspection: { findFirst: async () => inspection },
    reservation: { findUnique: async () => (signature == null ? null : { signatureDataUrl: signature }) },
    rentalAgreementCharge: { findFirst: async () => refillCharge },
    vehicle: { findUnique: async () => vehicle },
    user: { findUnique: async () => ({ fullName: 'M. Rivera', email: 'mrivera@x.test' }) },
    checkinAuditFinding: {
      findFirst: async ({ where }) => {
        for (const row of state.rows.values()) {
          if (row.reservationId !== where.reservationId) continue;
          if (where.checkKey?.not && row.checkKey === where.checkKey.not) continue;
          if (typeof where.checkKey === 'string' && row.checkKey !== where.checkKey) continue;
          return row;
        }
        return null;
      },
      upsert: async ({ where, create }) => {
        const key = `${where.reservationId_checkKey.reservationId}:${where.reservationId_checkKey.checkKey}`;
        state.upserts.push({ key, create });
        if (state.rows.has(key)) return state.rows.get(key); // update: {} — first detection wins
        const row = { id: `f-${state.rows.size + 1}`, ...create };
        state.rows.set(key, row);
        return row;
      },
      deleteMany: async ({ where }) => {
        state.deletes.push(where);
        for (const [k, row] of [...state.rows]) {
          if (row.reservationId === where.reservationId && row.checkKey === where.checkKey) state.rows.delete(k);
        }
        return { count: 1 };
      },
    },
  };
  return { db, state };
}

const CLEAN_CLOSE = {
  agreementId: 'agr-1',
  tenantId: 't1',
  reservationId: 'res-2417',
  vehicleId: 'veh-1',
  locationId: 'loc-sju',
  reservationNumber: 'RSV-2417',
  odometerOut: 12404, odometerIn: 12981,
  fuelOut: 1, fuelIn: 0.45,
  rentalDays: 5,
  returnedAt: '2026-08-29T09:42:00Z',
  feeItems: [{ feeType: 'FUEL_REFILL', total: 57.75 }],
  hasSignature: true,
  closedByUserId: 'u-rivera',
};

const CLEAN_INSPECTION = {
  photoStorageRefs: REQUIRED_ANGLES.map((k) => ({ key: k, path: `x/${k}.jpg`, uploadedAt: '2026-08-29T09:40:00Z' })),
  photosJson: null,
  capturedAt: '2026-08-29T09:40:00Z',
};

test('runner: a clean close writes exactly one PASS row (status RESOLVED) and no notification', async () => {
  const { db, state } = makeDb({
    inspection: CLEAN_INSPECTION,
    vehicle: { make: 'Toyota', model: 'Corolla', plate: 'ABC-124', internalNumber: 'C-118' },
  });
  const emitted = [];
  const out = await runCheckinAuditForCloseSafe(CLEAN_CLOSE, {
    db, emit: async (e) => emitted.push(e), getConfig: async () => normalizeCheckinAuditConfig(null),
  });
  assert.deepEqual(out, { findings: 0, passed: true });
  assert.equal(state.upserts.length, 1);
  const pass = state.upserts[0].create;
  assert.equal(pass.checkKey, 'PASS');
  assert.equal(pass.status, 'RESOLVED');
  assert.equal(pass.severity, 'NONE');
  assert.equal(pass.vehicleLabel, 'Toyota Corolla · ABC-124');
  assert.equal(pass.closedByName, 'M. Rivera');
  assert.equal(emitted.length, 0);
});

test('runner: the impossible odometer persists an ERROR finding and emits ONE NEEDS_ACTION (CHECKIN_AUDIT, deduped key)', async () => {
  const { db, state } = makeDb({ inspection: CLEAN_INSPECTION });
  const emitted = [];
  const out = await runCheckinAuditForCloseSafe({
    ...CLEAN_CLOSE,
    reservationId: 'res-2398', reservationNumber: 'RSV-2398',
    odometerOut: 41210, odometerIn: 41190,
  }, { db, emit: async (e) => emitted.push(e), getConfig: async () => normalizeCheckinAuditConfig(null) });
  assert.equal(out.passed, false);
  assert.equal(out.findings, 1);
  const row = [...state.rows.values()][0];
  assert.equal(row.checkKey, 'ODO_IMPOSSIBLE');
  assert.equal(row.severity, 'ERROR');
  assert.ok(!('status' in row), 'status left to the DB default OPEN');
  assert.equal(emitted.length, 1);
  const n = emitted[0];
  assert.equal(n.sourceType, 'CHECKIN_AUDIT');
  assert.equal(n.severity, 'NEEDS_ACTION');
  assert.equal(n.dedupeKey, 'checkin-audit:res-2398:ODO_IMPOSSIBLE');
  assert.match(n.title, /Entry error — RSV-2398/);
  assert.match(n.title, /41,210 → 41,190/);
  assert.equal(n.deepLink, '/checkin-audit?reservationId=res-2398');
});

test('runner: WARN findings persist but do NOT notify (only entry errors reach the center)', async () => {
  const { db, state } = makeDb({ inspection: CLEAN_INSPECTION });
  const emitted = [];
  await runCheckinAuditForCloseSafe({
    ...CLEAN_CLOSE,
    reservationId: 'res-2391',
    odometerOut: 10000, odometerIn: 12583, rentalDays: 3, // 861 mi/day
  }, { db, emit: async (e) => emitted.push(e), getConfig: async () => normalizeCheckinAuditConfig(null) });
  const keys = [...state.rows.values()].map((r) => r.checkKey);
  assert.deepEqual(keys, ['MILES_OUTLIER']);
  assert.equal(emitted.length, 0);
});

test('runner: dedupe per reservation+check — a re-run upserts into the same row, never a duplicate', async () => {
  const { db, state } = makeDb({ inspection: CLEAN_INSPECTION });
  const args = {
    ...CLEAN_CLOSE, reservationId: 'res-2398', odometerOut: 41210, odometerIn: 41190,
  };
  const deps = { db, emit: async () => {}, getConfig: async () => normalizeCheckinAuditConfig(null) };
  await runCheckinAuditForCloseSafe(args, deps);
  await runCheckinAuditForCloseSafe(args, deps);
  assert.equal(state.upserts.length, 2, 'two upsert calls');
  assert.equal(state.rows.size, 1, 'one row — update:{} means first detection wins');
});

test('runner: findings retire an earlier PASS row; a clean re-run does NOT bury open findings under a PASS', async () => {
  // First: PASS exists, then a finding arrives → PASS deleted.
  const prior = [{ id: 'p1', reservationId: 'res-9', checkKey: 'PASS', status: 'RESOLVED' }];
  const { db, state } = makeDb({ inspection: CLEAN_INSPECTION, priorFindings: prior });
  const deps = { db, emit: async () => {}, getConfig: async () => normalizeCheckinAuditConfig(null) };
  await runCheckinAuditForCloseSafe({
    ...CLEAN_CLOSE, reservationId: 'res-9', odometerOut: 41210, odometerIn: 41190,
  }, deps);
  assert.ok(state.deletes.some((w) => w.checkKey === 'PASS'), 'PASS retired');
  assert.ok([...state.rows.values()].some((r) => r.checkKey === 'ODO_IMPOSSIBLE'));

  // Then: a clean re-run with the finding still on file → no new PASS row.
  const before = state.upserts.length;
  await runCheckinAuditForCloseSafe({ ...CLEAN_CLOSE, reservationId: 'res-9' }, deps);
  assert.equal(state.upserts.length, before, 'no PASS minted while findings exist');
});

test('runner: rulesEnabled=false short-circuits — no reads, no writes', async () => {
  const { db, state } = makeDb({});
  const out = await runCheckinAuditForCloseSafe(CLEAN_CLOSE, {
    db, emit: async () => { throw new Error('must not emit'); },
    getConfig: async () => ({ ...normalizeCheckinAuditConfig(null), rulesEnabled: false }),
  });
  assert.equal(out, null);
  assert.equal(state.upserts.length, 0);
});

test('runner: NEVER throws — a broken db is a log line, the close is unaffected', async () => {
  const db = {
    rentalAgreementInspection: { findFirst: async () => { throw new Error('db down'); } },
    reservation: { findUnique: async () => { throw new Error('db down'); } },
    rentalAgreementCharge: { findFirst: async () => { throw new Error('db down'); } },
    vehicle: { findUnique: async () => { throw new Error('db down'); } },
    user: { findUnique: async () => { throw new Error('db down'); } },
    checkinAuditFinding: {
      findFirst: async () => { throw new Error('db down'); },
      upsert: async () => { throw new Error('db down'); },
      deleteMany: async () => { throw new Error('db down'); },
    },
  };
  const out = await runCheckinAuditForCloseSafe(CLEAN_CLOSE, {
    db, emit: async () => {}, getConfig: async () => normalizeCheckinAuditConfig(null),
  });
  assert.equal(out, null, 'returns null instead of throwing');
});

test('runner: missing tenant/reservation is a quiet no-op', async () => {
  assert.equal(await runCheckinAuditForCloseSafe({ tenantId: null, reservationId: 'x' }, {}), null);
  assert.equal(await runCheckinAuditForCloseSafe({ tenantId: 't', reservationId: null }, {}), null);
});

// ───────────────────────── D. the dismiss fork ──────────────────────────────

function makeDismissDb(finding) {
  const state = { updates: [] };
  const db = {
    checkinAuditFinding: {
      findFirst: async () => finding,
      update: async ({ where, data }) => { state.updates.push({ where, data }); return { ...finding, ...data }; },
    },
    user: { findUnique: async () => ({ fullName: 'M. Rivera', email: 'mrivera@x.test' }) },
  };
  return { db, state };
}

const OPEN_WARN_FINDING = {
  id: 'f-1', tenantId: 't1', reservationId: 'res-2391', reservationNumber: 'RSV-2391',
  vehicleId: 'veh-1', checkKey: 'MILES_OUTLIER', category: 'MILEAGE_FUEL',
  severity: 'WARN', status: 'OPEN',
};

test('dismiss NOT_ISSUE: logs DISMISSED_NOT_ISSUE with the reviewer stamp', async () => {
  const { db, state } = makeDismissDb({ ...OPEN_WARN_FINDING });
  const out = await dismissFinding('f-1', { classification: 'NOT_ISSUE' }, { tenantId: 't1', userId: 'u-rivera' }, { db, now: '2026-08-27T17:52:00Z' });
  assert.deepEqual(out, { ok: true, status: 'DISMISSED_NOT_ISSUE' });
  assert.equal(state.updates.length, 1);
  const d = state.updates[0].data;
  assert.equal(d.status, 'DISMISSED_NOT_ISSUE');
  assert.equal(d.dismissedByUserId, 'u-rivera');
  assert.equal(d.dismissedByName, 'M. Rivera');
  assert.equal(new Date(d.dismissedAt).toISOString(), '2026-08-27T17:52:00.000Z');
});

test('dismiss PREEXISTING on a DAMAGE finding: appends the ledger entry via the manual-damage path and resolves the finding', async () => {
  // T1 produces no DAMAGE findings — this is the generic API exactly as the
  // future T2 flag will exercise it (damage-baseline Mock 2's KD-4 story).
  const damageFinding = {
    ...OPEN_WARN_FINDING, id: 'f-2', reservationId: 'res-88214', reservationNumber: 'R-88214',
    checkKey: 'PHOTO_PAIR_REAR', category: 'DAMAGE', severity: 'WARN',
  };
  const { db, state } = makeDismissDb(damageFinding);
  const calls = [];
  const fakeInspectionSvc = {
    addManualDamage: async (vehicleId, body, scope, opts) => {
      calls.push({ vehicleId, body, scope, opts });
      return { id: 'dmg-kd4', view: body.view };
    },
  };
  const out = await dismissFinding('f-2', {
    classification: 'PREEXISTING',
    view: 'REAR', xPct: 24, yPct: 66,
    description: '15 cm scuff — lower-left rear bumper',
    photoDataUrl: 'data:image/jpeg;base64,Zm9v',
  }, { tenantId: 't1', userId: 'u-rivera' }, { db, customerInspection: fakeInspectionSvc, now: '2026-08-27T17:52:00Z' });

  assert.equal(out.status, 'RESOLVED');
  assert.equal(out.resolution, 'PREEXISTING_BASELINED');
  assert.equal(out.damageReportId, 'dmg-kd4');

  assert.equal(calls.length, 1);
  const c = calls[0];
  assert.equal(c.vehicleId, 'veh-1');
  assert.equal(c.body.view, 'REAR');
  assert.equal(c.body.xPct, 24);
  assert.equal(c.body.yPct, 66);
  assert.equal(c.body.reservationId, 'res-88214');
  assert.equal(c.scope.userId, 'u-rivera', 'reviewer stamped through scope');
  assert.deepEqual(c.opts, { source: 'AUDIT_PREEXISTING', sourceAuditFindingId: 'f-2' });

  const d = state.updates[0].data;
  assert.equal(d.status, 'RESOLVED');
  assert.equal(d.resolution, 'PREEXISTING_BASELINED');
  assert.equal(d.linkedDamageReportId, 'dmg-kd4');
  assert.equal(d.dismissedByName, 'M. Rivera');
});

test('dismiss guards: PREEXISTING refuses non-damage findings (T1 has none); PASS and non-OPEN refuse', async () => {
  const { db } = makeDismissDb({ ...OPEN_WARN_FINDING });
  await assert.rejects(
    dismissFinding('f-1', { classification: 'PREEXISTING', view: 'REAR', xPct: 1, yPct: 1, photoDataUrl: 'data:image/jpeg;base64,Zm9v' }, { tenantId: 't1' }, { db }),
    (e) => e.status === 400 && /Only damage findings/.test(e.message),
  );
  const pass = makeDismissDb({ ...OPEN_WARN_FINDING, checkKey: 'PASS', category: 'PASS', status: 'RESOLVED' });
  await assert.rejects(
    dismissFinding('f-1', { classification: 'NOT_ISSUE' }, { tenantId: 't1' }, { db: pass.db }),
    (e) => e.status === 400,
  );
  const done = makeDismissDb({ ...OPEN_WARN_FINDING, status: 'DISMISSED_NOT_ISSUE' });
  await assert.rejects(
    dismissFinding('f-1', { classification: 'NOT_ISSUE' }, { tenantId: 't1' }, { db: done.db }),
    (e) => e.status === 409,
  );
  await assert.rejects(
    dismissFinding('f-1', { classification: 'WHATEVER' }, { tenantId: 't1' }, { db }),
    (e) => e.status === 400,
  );
});

// ───────────────────────── E. the baseline slice ────────────────────────────

test('addManualDamage: internal opts stamp AUDIT_PREEXISTING + sourceAuditFindingId; HTTP body cannot spoof them', async () => {
  const created = [];
  const origVehicle = prisma.vehicle.findFirst;
  const origCreate = prisma.vehicleDamageReport.create;
  const origUpdate = prisma.vehicleDamageReport.update;
  prisma.vehicle.findFirst = async () => ({ id: 'veh-1' });
  prisma.vehicleDamageReport.create = async ({ data }) => { created.push(data); return { id: `dmg-${created.length}`, ...data }; };
  prisma.vehicleDamageReport.update = async ({ where, data }) => ({ id: where.id, ...data });
  try {
    // The audit's internal call — provenance rides in opts.
    await customerInspectionService.addManualDamage('veh-1', {
      view: 'REAR', xPct: 24, yPct: 66, description: 'scuff',
      photoDataUrl: 'data:image/jpeg;base64,Zm9v',
    }, { tenantId: 't1', userId: 'u-rivera' }, { source: 'AUDIT_PREEXISTING', sourceAuditFindingId: 'f-2' });
    assert.equal(created[0].source, 'AUDIT_PREEXISTING');
    assert.equal(created[0].sourceAuditFindingId, 'f-2');
    assert.equal(created[0].status, 'HARD_APPROVED');
    assert.equal(created[0].reviewedByUserId, 'u-rivera');

    // The HTTP path (routes forward body only) — body fields cannot set provenance.
    await customerInspectionService.addManualDamage('veh-1', {
      view: 'REAR', xPct: 1, yPct: 1, photoDataUrl: 'data:image/jpeg;base64,Zm9v',
      source: 'AUDIT_PREEXISTING', sourceAuditFindingId: 'spoofed',
    }, { tenantId: 't1', userId: 'u-agent' });
    assert.equal(created[1].source, 'MANUAL');
    assert.equal(created[1].sourceAuditFindingId, null);
  } finally {
    prisma.vehicle.findFirst = origVehicle;
    prisma.vehicleDamageReport.create = origCreate;
    prisma.vehicleDamageReport.update = origUpdate;
  }
});

test('clearDamageReport: reason REQUIRED; HARD_APPROVED-only; sets the FIXED-equivalent cleared state; audit-logged', async () => {
  const updates = [];
  const audits = [];
  const origFind = prisma.vehicleDamageReport.findFirst;
  const origUpdate = prisma.vehicleDamageReport.update;
  const origAudit = prisma.auditLog.create;
  prisma.vehicleDamageReport.findFirst = async () => ({
    id: 'dmg-1', status: 'HARD_APPROVED', tenantId: 't1', vehicleId: 'veh-1',
    reservationId: 'res-1', description: 'double entry', source: 'MANUAL',
  });
  prisma.vehicleDamageReport.update = async ({ where, data }) => { updates.push({ where, data }); return { id: where.id, ...data }; };
  prisma.auditLog.create = async ({ data }) => { audits.push(data); return { id: 'a1', ...data }; };
  try {
    await assert.rejects(
      customerInspectionService.clearDamageReport({ reportId: 'dmg-1', reason: '   ', actorUserId: 'u-1', scope: { tenantId: 't1' } }),
      (e) => e.status === 400 && e.code === 'REASON_REQUIRED',
    );

    const out = await customerInspectionService.clearDamageReport({
      reportId: 'dmg-1', reason: 'Was dirt — wiped off at the wash', actorUserId: 'u-1', scope: { tenantId: 't1' },
    });
    assert.equal(out.ok, true);
    assert.equal(out.status, 'FIXED');
    const d = updates[0].data;
    assert.equal(d.status, 'FIXED');
    assert.equal(d.clearedReason, 'Was dirt — wiped off at the wash');
    assert.equal(d.fixedByUserId, 'u-1');
    assert.ok(d.fixedAt instanceof Date);
    assert.ok(!('fixedPhotoJson' in d), 'no repair photo is faked');
    assert.equal(audits.length, 1);
    assert.equal(audits[0].action, 'ADMIN_OVERRIDE');
    assert.match(audits[0].reason, /cleared without repair/);
    assert.equal(JSON.parse(audits[0].metadata).kind, 'damage_report_clear_no_repair');

    // FIXED rows refuse a second clear
    prisma.vehicleDamageReport.findFirst = async () => ({ id: 'dmg-1', status: 'FIXED', tenantId: 't1' });
    await assert.rejects(
      customerInspectionService.clearDamageReport({ reportId: 'dmg-1', reason: 'x', actorUserId: 'u-1', scope: { tenantId: 't1' } }),
      (e) => e.status === 409,
    );
  } finally {
    prisma.vehicleDamageReport.findFirst = origFind;
    prisma.vehicleDamageReport.update = origUpdate;
    prisma.auditLog.create = origAudit;
  }
});

// ───────────────────────── F. wiring ────────────────────────────────────────

test('checkin-close calls the Safe runner AFTER the maintenance hook, INSIDE closeAgreementWithCheckinFees', () => {
  const src = readFileSync(join(ROOT, 'src', 'modules', 'rental-agreements', 'checkin-close.service.js'), 'utf8');
  assert.match(src, /import \{ runCheckinAuditForCloseSafe \} from '\.\.\/checkin-audit\/checkin-audit\.service\.js'/);
  const maintIdx = src.indexOf('executeCheckinMaintenanceDecisionSafe({');
  const auditIdx = src.indexOf('runCheckinAuditForCloseSafe({');
  const auditLogIdx = src.indexOf("action: 'STATUS_CHANGE'");
  assert.ok(maintIdx > 0 && auditIdx > 0, 'both hooks called');
  assert.ok(auditIdx > maintIdx, 'audit fires after the maintenance hook (Step 6b → 6c)');
  assert.ok(auditIdx < auditLogIdx, 'audit fires before the Step 7 audit log');
});

test('main.js mounts /api/checkin-audit with requireAuth + tenantRateLimit and no module gate', () => {
  const src = readFileSync(join(ROOT, 'src', 'main.js'), 'utf8');
  assert.match(src, /app\.use\('\/api\/checkin-audit', requireAuth, tenantRateLimit, checkinAuditRouter\)/);
});

test('notification center: CHECKIN_AUDIT is a known source type', () => {
  assert.ok(NOTIFICATION_SOURCE_TYPES.includes('CHECKIN_AUDIT'));
});

test('the clear-with-reason route exists beside /fix', () => {
  const src = readFileSync(join(ROOT, 'src', 'modules', 'customer-inspection', 'customer-inspection.routes.js'), 'utf8');
  assert.match(src, /'\/reports\/:reportId\/clear'/);
  assert.match(src, /clearDamageReport/);
});
