/**
 * Throwaway-cluster verification for the two 20260828 billingPreviousStatus
 * migrations, through the REAL runStartupMigrations().
 *
 * Not a test file and not wired into any script: this needs a Postgres binary
 * downloaded on demand, which is exactly why the repo keeps DB-backed work out
 * of the guard suites. Run by hand:
 *   npm install --no-save embedded-postgres@18.4.0-beta.17
 *   node scripts/verify-prevstatus-migrations.mjs
 *
 * It reproduces PRODUCTION'S SHAPE, not a convenient one: the tracking table is
 * pre-seeded so the runner does NOT take its baseline path (an empty table
 * records every migration as applied without executing it, which would make this
 * whole exercise pass while proving nothing).
 */
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import net from 'node:net';
import pg from 'pg';
import { fileURLToPath } from 'node:url';

const BACKEND = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const MIGRATIONS = path.join(BACKEND, 'prisma', 'migrations');

const ALTER = '20260828_tenant_billing_previous_status';
const BACKFILL = '20260828_tenant_billing_previous_status_backfill';

function freePort() {
  return new Promise((res, rej) => {
    const s = net.createServer();
    s.unref(); s.on('error', rej);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); });
  });
}

const fail = [];
function check(label, cond, detail = '') {
  console.log(`${cond ? 'ok  ' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`);
  if (!cond) fail.push(label);
}

const { default: EmbeddedPostgres } = await import('embedded-postgres');
const port = await freePort();
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rfm-mig-'));
const pgsrv = new EmbeddedPostgres({
  databaseDir: dataDir, user: 'postgres', password: 'postgres', port,
  persistent: false, initdbFlags: ['--encoding=UTF8', '--locale=C'],
});

await pgsrv.initialise();
await pgsrv.start();
await pgsrv.createDatabase('rfm');
const url = `postgresql://postgres:postgres@127.0.0.1:${port}/rfm`;

const c = new pg.Client({ connectionString: url });
await c.connect();

// PRE-MIGRATION SHAPE: Tenant deliberately WITHOUT billingPreviousStatus.
await c.query(`
  CREATE TABLE "Tenant" (
    id text PRIMARY KEY,
    status text NOT NULL,
    "billingSuspendedAt" timestamptz
  );
  CREATE TABLE "AdminAuditLog" (
    id text PRIMARY KEY,
    action text NOT NULL,
    "tenantId" text,
    "targetType" text,
    "targetId" text,
    metadata jsonb,
    at timestamptz NOT NULL DEFAULT now()
  );
`);

// Rows that mirror production plus the cases production does NOT have, so the
// backfill's scoping is exercised rather than merely executed against nothing.
await c.query(`
  INSERT INTO "Tenant" (id, status, "billingSuspendedAt") VALUES
    ('demo-prod',   'DEMO',      NULL),                  -- prod's demo tenant: audit row, but NOT billing-suspended
    ('susp-noflag', 'SUSPENDED', NULL),                   -- prod's 3 suspended: no billing suspension
    ('susp-billed', 'SUSPENDED', now()),                  -- the case the backfill exists for
    ('susp-blank',  'SUSPENDED', now()),                  -- recorded '' -> must be dropped by NULLIF/TRIM
    ('susp-self',   'SUSPENDED', now()),                  -- recorded 'SUSPENDED' -> must never be seeded
    ('active-one',  'ACTIVE',    NULL);
  INSERT INTO "AdminAuditLog" (id, action, "tenantId", "targetType", "targetId", metadata, at) VALUES
    ('a1','TENANT_SUSPEND','demo-prod','Tenant','demo-prod','{"previousTenantStatus":"DEMO"}', now()),
    ('a2','TENANT_SUSPEND','susp-billed','Tenant','susp-billed','{"previousTenantStatus":"DEMO"}', now()),
    ('a3','TENANT_SUSPEND','susp-billed','Tenant','susp-billed','{"previousTenantStatus":"ACTIVE"}', now() - interval '1 day'),
    ('a4','TENANT_SUSPEND','susp-blank','Tenant','susp-blank','{"previousTenantStatus":"   "}', now()),
    ('a5','TENANT_SUSPEND','susp-self','Tenant','susp-self','{"previousTenantStatus":"SUSPENDED"}', now());
`);

// Pre-seed the tracker so the runner does NOT baseline. Everything that already
// exists on disk is marked applied EXCEPT our two.
const all = fs.readdirSync(MIGRATIONS, { withFileTypes: true })
  .filter((d) => d.isDirectory()).map((d) => d.name).sort();
await c.query('CREATE TABLE IF NOT EXISTS "_app_migrations" (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now(), baseline boolean NOT NULL DEFAULT false)');
for (const n of all) {
  if (n === ALTER || n === BACKFILL) continue;
  await c.query('INSERT INTO "_app_migrations"(name, baseline) VALUES ($1, true) ON CONFLICT DO NOTHING', [n]);
}

check('the two migrations sort adjacently, ALTER first',
  all.indexOf(BACKFILL) === all.indexOf(ALTER) + 1,
  `${all.indexOf(ALTER)} -> ${all.indexOf(BACKFILL)}`);

const { runStartupMigrations } = await import('../src/lib/startup-migrate.js');
const quiet = { info: () => {}, warn: () => {}, error: (...a) => console.log('  [migrate error]', ...a) };

// ── PASS 1 ────────────────────────────────────────────────────────────────
const r1 = await runStartupMigrations({ databaseUrl: url, migrationsDir: MIGRATIONS, logger: quiet });
check('pass 1 applied both migrations', r1.applied.includes(ALTER) && r1.applied.includes(BACKFILL), JSON.stringify(r1.applied));
check('pass 1 had no failures', r1.failed.length === 0, JSON.stringify(r1.failed));
check('pass 1 did not take the baseline path', r1.baselined === 0);

const col = await c.query(`SELECT column_name, is_nullable, column_default FROM information_schema.columns
                            WHERE table_name='Tenant' AND column_name='billingPreviousStatus'`);
check('the column exists', col.rows.length === 1);
check('the column is NULLABLE', col.rows[0]?.is_nullable === 'YES');
check('the column has NO default', col.rows[0]?.column_default === null);

const seeded = await c.query('SELECT id, "billingPreviousStatus" AS p FROM "Tenant" ORDER BY id');
const by = Object.fromEntries(seeded.rows.map((r) => [r.id, r.p]));
console.log('  backfill result:', JSON.stringify(by));
check('the billing-suspended tenant got the NEWEST recorded status', by['susp-billed'] === 'DEMO');
check('prod\'s demo tenant is NOT touched (not billing-suspended)', by['demo-prod'] === null);
check('a suspended tenant with no billing flag is NOT touched', by['susp-noflag'] === null);
check('a blank recorded status is NOT seeded', by['susp-blank'] === null);
check('a recorded SUSPENDED is NOT seeded', by['susp-self'] === null);
check('an active tenant is NOT touched', by['active-one'] === null);

// ── PASS 2: idempotency ───────────────────────────────────────────────────
const r2 = await runStartupMigrations({ databaseUrl: url, migrationsDir: MIGRATIONS, logger: quiet });
check('pass 2 re-applies nothing', r2.applied.length === 0, JSON.stringify(r2.applied));
check('pass 2 has no failures', r2.failed.length === 0, JSON.stringify(r2.failed));

// ── PASS 3: forced re-run of the raw SQL (the real idempotency question) ──
// Simulates the tracker row being lost, which is the only way a shipped
// migration executes twice. Both files must survive it.
await c.query('DELETE FROM "_app_migrations" WHERE name IN ($1,$2)', [ALTER, BACKFILL]);
await c.query(`UPDATE "Tenant" SET "billingPreviousStatus"='ACTIVE' WHERE id='susp-billed'`);
const r3 = await runStartupMigrations({ databaseUrl: url, migrationsDir: MIGRATIONS, logger: quiet });
check('pass 3 re-executes both without error', r3.failed.length === 0, JSON.stringify(r3.failed));
const after = await c.query(`SELECT "billingPreviousStatus" AS p FROM "Tenant" WHERE id='susp-billed'`);
check('a re-run does NOT overwrite a value already written', after.rows[0].p === 'ACTIVE',
  `got ${after.rows[0].p}`);

await c.end();
await pgsrv.stop();
try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}

console.log(fail.length ? `\nFAILURES: ${fail.join('; ')}` : '\nALL CHECKS PASSED');
process.exit(fail.length ? 1 : 0);
