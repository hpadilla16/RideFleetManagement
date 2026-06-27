import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import { runStartupMigrations } from './startup-migrate.js';

const DATA = path.join(os.tmpdir(), 'pg-startup-mig');
fs.rmSync(DATA, { recursive: true, force: true });
const pg = new EmbeddedPostgres({ databaseDir: DATA, user: 'postgres', password: 'postgres', port: 55480, persistent: false });
await pg.initialise(); await pg.start(); await pg.createDatabase('rfm');
const URL = 'postgresql://postgres:postgres@localhost:55480/rfm?schema=public';

const MIG = fs.mkdtempSync(path.join(os.tmpdir(), 'migs-'));
function addMig(name, sql) { const d = path.join(MIG, name); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, 'migration.sql'), sql); }
const silent = { info() {}, warn() {}, error() {} };
async function run() { return runStartupMigrations({ databaseUrl: URL, migrationsDir: MIG, logger: silent }); }

// pg helper to assert table existence
const { default: pglib } = await import('pg');
async function tableExists(t) {
  const c = new pglib.Client({ connectionString: URL }); await c.connect();
  const { rows } = await c.query("SELECT to_regclass($1) AS r", [t]); await c.end();
  return rows[0].r !== null;
}

test.after(async () => { await pg.stop(); fs.rmSync(MIG, { recursive: true, force: true }); });

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
  // retried next run (still not recorded) — proves not persisted
  const r2 = await run();
  assert.equal(r2.failed.length, 1);
});
