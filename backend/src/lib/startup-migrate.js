/**
 * Startup DB migration runner (2026-06-27).
 *
 * Applies pending prisma/migrations/<dir>/migration.sql files on boot BEFORE the
 * server accepts traffic, so a release that adds a column can never go live
 * against a DB that's missing it (the root cause of the 2026-06-27 outage).
 *
 * Design / safety:
 *  - Uses node-postgres (simple-query protocol) so multi-statement + DO $$ blocks
 *    run correctly even over the Supabase pgbouncer pooler.
 *  - BASELINE ON FIRST RUN: if the tracking table is empty, every existing
 *    migration is recorded as applied WITHOUT executing it (prod is assumed to
 *    already be at the current schema — migrations were applied manually before
 *    this feature). So the first deploy of this feature executes NO migration SQL.
 *  - Only genuinely NEW migrations execute thereafter. Keep new migrations
 *    idempotent (ADD COLUMN IF NOT EXISTS / CREATE ... EXCEPTION WHEN duplicate).
 *  - FAIL-OPEN: a failing migration is logged loudly and skipped (not recorded,
 *    so it retries next boot) and never throws — the server still starts, so the
 *    migrator can never crash-loop the site.
 *  - Disable with AUTO_MIGRATE_ON_BOOT=false.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_DIR = path.resolve(__dirname, '../../prisma/migrations');

export async function runStartupMigrations(opts = {}) {
  const databaseUrl = opts.databaseUrl || process.env.DATABASE_URL;
  const dir = opts.migrationsDir || DEFAULT_DIR;
  const log = opts.logger || console;
  const result = { skipped: false, baselined: 0, applied: [], alreadyApplied: 0, failed: [] };

  if (!databaseUrl) { (log.warn || log.info || console.log)('[startup-migrate] no DATABASE_URL; skipping'); result.skipped = true; return result; }
  if (!fs.existsSync(dir)) { (log.warn || console.log)('[startup-migrate] migrations dir missing; skipping', dir); result.skipped = true; return result; }

  const names = fs.readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .filter((n) => fs.existsSync(path.join(dir, n, 'migration.sql')))
    .sort();

  const client = new pg.Client({ connectionString: databaseUrl, connectionTimeoutMillis: 10000 });
  try {
    await client.connect();
    // Never wait forever for a lock (2026-08-08 incident review, P2).
    // A migration that runs on BOOT and blocks on a lock held by live traffic
    // would hang the container's startup indefinitely — and because the boot
    // never completes, the deploy neither succeeds nor fails visibly. Failing
    // fast turns a silent hang into a loud, retryable error.
    // statement_timeout is the companion guard: a lock we DID get, on a table
    // big enough to rewrite for minutes, is the same outage by another route.
    await client.query("SET lock_timeout = '10s'");
    await client.query("SET statement_timeout = '120s'");
    await client.query('CREATE TABLE IF NOT EXISTS "_app_migrations" (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now(), baseline boolean NOT NULL DEFAULT false)');
    const { rows } = await client.query('SELECT name FROM "_app_migrations"');
    const applied = new Set(rows.map((r) => r.name));

    if (applied.size === 0 && names.length) {
      for (const n of names) {
        await client.query('INSERT INTO "_app_migrations"(name, baseline) VALUES ($1, true) ON CONFLICT (name) DO NOTHING', [n]);
      }
      result.baselined = names.length;
      (log.info || console.log)('[startup-migrate] baselined existing migrations (no SQL executed)', { count: names.length });
      return result;
    }

    for (const n of names) {
      if (applied.has(n)) { result.alreadyApplied += 1; continue; }
      const sql = fs.readFileSync(path.join(dir, n, 'migration.sql'), 'utf8');
      try {
        // rowCount of the LAST statement in the file. For a pure DDL migration
        // it is meaningless and null; for one that backfills, it is the only
        // signal anyone gets that the backfill matched anything at all. A
        // backfill that silently updates zero rows — wrong key, rows that
        // predate the field — looks identical in the log to one that worked,
        // and the bug it was written to fix is still there.
        const res = await client.query(sql);
        const rowCount = Array.isArray(res) ? res[res.length - 1]?.rowCount ?? null : res?.rowCount ?? null;
        await client.query('INSERT INTO "_app_migrations"(name) VALUES ($1) ON CONFLICT (name) DO NOTHING', [n]);
        result.applied.push(n);
        (log.info || console.log)('[startup-migrate] applied migration', { name: n, rowCount });
      } catch (e) {
        result.failed.push({ name: n, error: e.message });
        (log.error || console.error)('[startup-migrate] migration FAILED (continuing boot)', { name: n, error: e.message });
      }
    }
    return result;
  } catch (e) {
    (log.error || console.error)('[startup-migrate] runner error (continuing boot)', e && e.message);
    result.error = e && e.message;
    return result;
  } finally {
    await client.end().catch(() => {});
  }
}

export default runStartupMigrations;
