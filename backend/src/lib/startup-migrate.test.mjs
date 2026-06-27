import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { runStartupMigrations } from './startup-migrate.js';

const URL = process.env.DATABASE_URL;
const MIG = fs.mkdtempSync(path.join(os.tmpdir(), 'migs-'));
function addMig(name, sql) { const d = path.join(MIG, name); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, 'migration.sql'), sql); }
const silent = { info() {}, warn() {}, error() {} };
async function run() { return runStartupMigrations({ databaseUrl: URL, migrationsDir: MIG, logger: silent }); }
async function q(sql, params) { const c = new pg.Client({ connectionString: URL }); await c.connect(); try { return (await c.query(sql, params)).rows; } finally { await c.end(); } }
async function tableExists(t) { return (await q('SELECT to_regclass($1) AS r', [t]))[0].r !== null; }

test.before(async () => {
  // Clean slate so the baseline-first-run assertion is deterministic.
  await q('DROP TABLE IF EXISTS "_app_migrations"').catch(() => {});
  await q('DROP TABLE IF EXISTS should_not_exist_on_baseline').catch(() => {});
  await q('DROP TABLE IF EXISTS app_mig_foo').catch(() => {});
});
test.after(() => { fs.rmSync(MIG, { recursive: true, force: true }); });

test('first run baselines existing migrations WITHOUT executing their SQL', async () => {
  addMig('20260101_legacy', 'CREATE TABLE should_not_exist_on_baseline (id int);');
  const r = await run();
  assert.equal(r.baselined, 1);
  assert.equal(r.applied.length, 0);
  assert.equal(await tableExists('should_not_exist_on_baseline'), false, 'baseline must not execute SQL');
});

test('new migration after baseline is executed (multi-statement + DO block)', async () => {
  addMig('20260202_addcol', 'CREATE TABLE app_mig_foo (id int);\nDO $$ BEGIN ALTER TABLE app_mig_foo ADD COLUMN IF NOT EXISTS bar text; END $$;');
  const r = await run();
  assert.deepEqual(r.applied, ['20260202_addcol']);
  assert.equal(await tableExists('app_mig_foo'), true);
});

test('already-applied migration is skipped (idempotent re-run)', async () => {
  const r = await run();
  assert.equal(r.applied.length, 0);
  assert.ok(r.alreadyApplied >= 2);
});

test('a failing migration is fail-open: logged, not recorded, never throws', async () => {
  addMig('20260303_bad', 'THIS IS NOT VALID SQL;');
  const r = await run();
  assert.equal(r.failed.length, 1);
  assert.equal(r.failed[0].name, '20260303_bad');
  const r2 = await run();
  assert.equal(r2.failed.length, 1);
});
