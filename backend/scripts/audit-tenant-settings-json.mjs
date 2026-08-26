#!/usr/bin/env node
/**
 * audit-tenant-settings-json.mjs — READ-ONLY audit of Tenant."settingsJson".
 *
 * WHY (2026-08-26): the column existed in the DB but was never declared in
 * schema.prisma, so every reader threw and the per-tenant config it holds has
 * silently never applied — tenant SMS provider/credentials (sms.service.js) and
 * the Dejavoo/SPIn terminal config (payment-gateway.service.js). This script
 * answers "who has data in there that was being ignored?" so the fix can be
 * checked against reality instead of assumed.
 *
 * It issues SELECTs only. It writes nothing.
 *
 * Values are REDACTED by default: settingsJson holds live credentials
 * (spinAuthKey, smsAuthToken, smsApiKey …) and this is meant to be safe to run
 * against production and paste into a ticket. Keys are always shown in full —
 * which keys are set is the whole question. Pass --unsafe-show-values only on a
 * machine where dumping secrets to the terminal is acceptable.
 *
 * Usage:
 *   node scripts/audit-tenant-settings-json.mjs
 *   DATABASE_URL=postgres://... node scripts/audit-tenant-settings-json.mjs
 *   node scripts/audit-tenant-settings-json.mjs --unsafe-show-values
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const SHOW_VALUES = process.argv.includes('--unsafe-show-values');
const SECRET_KEY = /key|token|secret|password|pass|auth|sid|credential/i;

function resolveDatabaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const envPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../.env');
  if (!fs.existsSync(envPath)) return null;
  const m = fs.readFileSync(envPath, 'utf8').match(/^\s*DATABASE_URL\s*=\s*"?([^"\n\r]+)"?/m);
  return m ? m[1] : null;
}

function preview(key, value) {
  if (SHOW_VALUES) return JSON.stringify(value);
  if (value === null || value === undefined) return String(value);
  if (typeof value === 'boolean' || typeof value === 'number') return String(value);
  if (!SECRET_KEY.test(key)) return JSON.stringify(value);
  const s = String(value);
  return s.length <= 4 ? '<set>' : `<set, ${s.length} chars, …${s.slice(-4)}>`;
}

const url = resolveDatabaseUrl();
if (!url) {
  console.error('No DATABASE_URL (env or backend/.env). Nothing to audit.');
  process.exit(2);
}

const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 10000 });
try {
  await client.connect();
} catch (e) {
  // Never echo the URL: it carries the password.
  console.error(`Cannot connect to the database: ${e.message}`);
  process.exit(2);
}
try {
  const { rows: cols } = await client.query(
    `SELECT table_schema, data_type, is_nullable
       FROM information_schema.columns
      WHERE table_name = 'Tenant' AND column_name = 'settingsJson'
      ORDER BY table_schema`,
  );
  if (!cols.length) {
    console.log('Tenant."settingsJson" does not exist in this database.');
    console.log('Migration 20260826_tenant_settings_json will create it (nullable jsonb).');
    process.exit(0);
  }
  for (const c of cols) {
    console.log(`column: ${c.table_schema}."Tenant"."settingsJson"  type=${c.data_type}  nullable=${c.is_nullable}`);
    if (c.data_type !== 'jsonb') {
      console.log('  ^ NOT jsonb — schema.prisma maps this as Json?. Both readers tolerate a JSON string, but check this.');
    }
  }

  // Path D: per-tenant schemas carry their own Tenant table.
  for (const c of cols) {
    const { rows } = await client.query(
      `SELECT id, name, "settingsJson" FROM "${c.table_schema.replace(/"/g, '""')}"."Tenant"
        WHERE "settingsJson" IS NOT NULL
        ORDER BY name`,
    );
    console.log(`\n[${c.table_schema}] tenants with a non-null settingsJson: ${rows.length}`);
    for (const r of rows) {
      let parsed = r.settingsJson;
      if (typeof parsed === 'string') {
        try { parsed = JSON.parse(parsed); } catch { console.log(`  - ${r.name} (${r.id}): UNPARSEABLE string, ${parsed.length} chars`); continue; }
      }
      if (!parsed || typeof parsed !== 'object') { console.log(`  - ${r.name} (${r.id}): ${JSON.stringify(parsed)}`); continue; }
      const keys = Object.keys(parsed);
      console.log(`  - ${r.name} (${r.id}): ${keys.length} key(s)`);
      for (const k of keys) console.log(`      ${k} = ${preview(k, parsed[k])}`);
    }
  }
} finally {
  await client.end().catch(() => {});
}
