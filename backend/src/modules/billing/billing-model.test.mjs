/**
 * The shape of the billing schema and its migration, asserted.
 *
 * WHY A TEST AND NOT JUST REVIEW: production applies raw SQL through
 * startup-migrate.js while the app reads through Prisma, so the migration and
 * schema.prisma are TWO declarations of one truth. When they drift, the symptom
 * is a runtime Prisma validation error on a money path — which is the worst
 * possible place to find out. This suite compares them column by column.
 *
 * It also pins the properties the design leans on:
 *   - every statement additive and idempotent (startup-migrate re-runs a failed
 *     migration on the next boot, so a non-idempotent one wedges every boot);
 *   - the PARTIAL unique index that is the one-live-subscription-per-tenant
 *     invariant, which Prisma cannot express and therefore only exists in SQL;
 *   - billing dates as VARCHAR(10), not a timestamp;
 *   - no column anywhere that could hold a PAN.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const MIGRATION_DIR = '20260827_tenant_subscriptions';
const SQL = readFileSync(join(ROOT, 'prisma', 'migrations', MIGRATION_DIR, 'migration.sql'), 'utf8');
const SCHEMA = readFileSync(join(ROOT, 'prisma', 'schema.prisma'), 'utf8');

/**
 * Statement-level checks run against the SQL with `--` comments stripped. The
 * comments in this migration deliberately NAME the things the assertions
 * forbid — "a careless reset would drop it", "INSERT ... ON CONFLICT DO
 * NOTHING" — and a guard that cannot tell prose from a statement is a guard
 * that gets its assertion weakened the first time it misfires.
 */
const STATEMENTS = SQL.replace(/^\s*--.*$/gm, '');

const TABLES = [
  'TenantSubscription',
  'TenantSubscriptionCharge',
  'TenantSubscriptionEvent',
  'AutopayInvite',
];

/** Column name → type text, from the migration's CREATE TABLE block. */
function sqlColumns(table) {
  const re = new RegExp(`CREATE TABLE IF NOT EXISTS "${table}" \\(([\\s\\S]*?)\\n\\);`);
  const body = re.exec(SQL)?.[1];
  assert.ok(body, `migration has no CREATE TABLE for ${table}`);
  const out = new Map();
  for (const line of body.split('\n')) {
    const m = /^\s*"([A-Za-z0-9_]+)"\s+(.*?),?\s*$/.exec(line);
    if (m) out.set(m[1], m[2].replace(/,$/, '').trim());
  }
  return out;
}

/** Scalar field name → type text, from the Prisma model block. */
function prismaFields(model) {
  const re = new RegExp(`\\nmodel ${model} \\{([\\s\\S]*?)\\n\\}`);
  const body = re.exec(SCHEMA)?.[1];
  assert.ok(body, `schema.prisma has no model ${model}`);
  const out = new Map();
  for (const raw of body.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('//') || line.startsWith('///') || line.startsWith('@@')) continue;
    const m = /^([A-Za-z][A-Za-z0-9_]*)\s+([A-Za-z]+)(\[\])?(\?)?\s*(.*)$/.exec(line);
    if (!m) continue;
    const [, name, type, list, optional, rest] = m;
    // Relation fields carry no column of their own.
    if (list || rest.includes('@relation')) continue;
    if (/^[A-Z]/.test(type) && !['String', 'Int', 'Boolean', 'DateTime', 'Decimal', 'Json', 'Float', 'BigInt', 'Bytes'].includes(type)) continue;
    out.set(name, { type, optional: !!optional, rest });
  }
  return out;
}

// ── The two declarations agree ─────────────────────────────────────────────

for (const table of TABLES) {
  test(`${table}: the migration and schema.prisma declare the same columns`, () => {
    const sql = sqlColumns(table);
    const prisma = prismaFields(table);
    const missingInSql = [...prisma.keys()].filter((k) => !sql.has(k));
    const missingInPrisma = [...sql.keys()].filter((k) => !prisma.has(k));
    assert.deepEqual(missingInSql, [], `in schema.prisma but not in the migration: ${missingInSql}`);
    assert.deepEqual(missingInPrisma, [], `in the migration but not in schema.prisma: ${missingInPrisma}`);
  });

  test(`${table}: NOT NULL in SQL matches non-optional in Prisma`, () => {
    // A column the migration makes NOT NULL while Prisma thinks it is optional
    // fails at INSERT time, on a money path, in production.
    const sql = sqlColumns(table);
    const prisma = prismaFields(table);
    for (const [name, decl] of sql) {
      const required = /NOT NULL|PRIMARY KEY/.test(decl);
      const field = prisma.get(name);
      assert.ok(field, `no Prisma field for ${table}.${name}`);
      assert.equal(
        required, !field.optional,
        `${table}.${name}: SQL says ${required ? 'NOT NULL' : 'nullable'}, Prisma says ${field.optional ? 'optional' : 'required'}`,
      );
    }
  });
}

// ── Calendar dates ─────────────────────────────────────────────────────────

test('every billing DATE column is VARCHAR(10), never a timestamp', () => {
  // ARB bills on a calendar DAY in the merchant's own time. A timestamp
  // rendered in es-PR (UTC-4) shows the day BEFORE the one that charges, so the
  // customer consents to one date and their card moves on another. Text kills
  // the bug class at the schema.
  const dateColumns = {
    TenantSubscription: ['trialEndsAt', 'startDate', 'nextChargeDate', 'currentPeriodStart', 'currentPeriodEnd', 'pendingEffectiveDate'],
    TenantSubscriptionCharge: ['chargeDate', 'periodStart', 'periodEnd'],
    AutopayInvite: ['startDate', 'nextChargeDate'],
  };
  for (const [table, cols] of Object.entries(dateColumns)) {
    const sql = sqlColumns(table);
    const prisma = prismaFields(table);
    for (const col of cols) {
      assert.match(sql.get(col) || '', /VARCHAR\(10\)/, `${table}.${col} is not VARCHAR(10) in SQL`);
      assert.equal(prisma.get(col)?.type, 'String', `${table}.${col} is not a String in Prisma`);
      assert.match(prisma.get(col)?.rest || '', /@db\.VarChar\(10\)/, `${table}.${col} lacks @db.VarChar(10)`);
    }
  }
});

test('genuine instants stayed DateTime', () => {
  const prisma = prismaFields('TenantSubscription');
  for (const col of ['authorizedAt', 'cancelledAt', 'suspendedAt', 'lastFailureAt']) {
    assert.equal(prisma.get(col)?.type, 'DateTime', `${col} should be an instant`);
  }
});

// ── The invariant Prisma cannot express ────────────────────────────────────

test('the one-live-subscription-per-tenant partial unique index exists', () => {
  const m = /CREATE UNIQUE INDEX IF NOT EXISTS "TenantSubscription_one_live_per_tenant"\s+ON "TenantSubscription" \("tenantId"\)\s+WHERE "status" NOT IN \(([^)]*)\)/.exec(SQL);
  assert.ok(m, 'the partial unique index is missing — nothing then stops two live subscriptions');
  const excluded = m[1].split(',').map((s) => s.trim().replace(/'/g, ''));
  // Terminal statuses only. Including a LIVE status here would silently allow
  // the duplicate the index exists to prevent.
  assert.deepEqual(excluded.sort(), ['CANCELLED', 'EXPIRED', 'SUPERSEDED']);
});

test('the idempotency keys are unique indexes, not hopes', () => {
  for (const idx of [
    'TenantSubscriptionCharge_transId_key',
    'TenantSubscriptionCharge_refId_key',
    'TenantSubscriptionEvent_notificationId_key',
    'AutopayInvite_tokenHash_key',
    'TenantSubscription_arbSubscriptionId_key',
  ]) {
    assert.ok(
      new RegExp(`CREATE UNIQUE INDEX IF NOT EXISTS "${idx}"`).test(SQL),
      `${idx} is missing`,
    );
  }
});

// ── Additive and idempotent ────────────────────────────────────────────────

test('every CREATE and ALTER in the migration is idempotent', () => {
  // startup-migrate does NOT record a failed migration, so it retries on the
  // next boot. A statement that cannot run twice therefore wedges every
  // subsequent boot of the container.
  for (const m of STATEMENTS.matchAll(/CREATE\s+(?:UNIQUE\s+)?(TABLE|INDEX)\s+(?!IF NOT EXISTS)/gi)) {
    assert.fail(`non-idempotent CREATE ${m[1]} at offset ${m.index}`);
  }
  for (const m of STATEMENTS.matchAll(/ADD COLUMN\s+(?!IF NOT EXISTS)/gi)) {
    assert.fail(`non-idempotent ADD COLUMN at offset ${m.index}`);
  }
});

test('the migration destroys nothing and backfills nothing', () => {
  // Phase 1 must be INERT on deploy: four empty tables and one nullable column.
  for (const forbidden of [/\bDROP\b/i, /\bTRUNCATE\b/i, /\bDELETE\s+FROM\b/i, /\bUPDATE\s+"/i, /\bINSERT\s+INTO\b/i]) {
    assert.ok(!forbidden.test(STATEMENTS), `the migration contains ${forbidden} — it must be additive only`);
  }
});

test('the only change to an EXISTING table is one nullable column', () => {
  const alters = [...STATEMENTS.matchAll(/ALTER TABLE "([A-Za-z]+)"\s+([\s\S]*?);/g)];
  assert.equal(alters.length, 1, 'more than one existing table is being altered');
  assert.equal(alters[0][1], 'Tenant');
  assert.match(alters[0][2], /ADD COLUMN IF NOT EXISTS "billingSuspendedAt" TIMESTAMP\(3\)/);
  // No DEFAULT and no NOT NULL: an existing tenant must be untouched, and a
  // default would rewrite every row of a ~60-column table on boot.
  assert.ok(!/NOT NULL/.test(alters[0][2]));
  assert.ok(!/DEFAULT/.test(alters[0][2]));
});

test('Tenant.billingSuspendedAt is nullable in Prisma too', () => {
  assert.match(SCHEMA, /billingSuspendedAt\s+DateTime\?/);
});

test('the migration directory sorts AFTER the last one that shipped', () => {
  // startup-migrate applies directories in sorted order. A name that sorts
  // before an already-applied migration would be skipped forever on a baselined
  // database.
  const dirs = readdirSync(join(ROOT, 'prisma', 'migrations'), { withFileTypes: true })
    .filter((d) => d.isDirectory()).map((d) => d.name).sort();
  assert.equal(dirs[dirs.length - 1], MIGRATION_DIR);
});

// ── PCI ────────────────────────────────────────────────────────────────────

test('no billing table has a column that could hold a card number', () => {
  // Only Authorize.Net handles, brand and last4 are persisted. The platform is
  // PCI SAQ C certified; a PAN column moves it to SAQ D.
  for (const table of TABLES) {
    for (const col of sqlColumns(table).keys()) {
      assert.ok(
        !/^(cardNumber|pan|accountNumber|cvv|cardCode|maskedNumber|expirationDate)$/i.test(col),
        `${table}.${col} looks like cardholder data`,
      );
    }
  }
});

test('card last4 is capped at four characters at the column', () => {
  for (const table of ['TenantSubscription', 'TenantSubscriptionCharge', 'AutopayInvite']) {
    assert.match(sqlColumns(table).get('cardLast4') || '', /VARCHAR\(4\)/);
  }
});

// ── The invite token ───────────────────────────────────────────────────────

test('AutopayInvite stores a hash and has nowhere to put a plaintext token', () => {
  const cols = sqlColumns('AutopayInvite');
  assert.ok(cols.has('tokenHash'));
  assert.ok(cols.has('tokenPrefix'));
  assert.ok(!cols.has('token'), 'a plaintext token column exists — the whole point was that it must not');
  assert.match(cols.get('tokenPrefix'), /VARCHAR\(8\)/);
});

test('merchantCustomerId is capped at 20 at the column, matching Authorize.Net', () => {
  // Authorize.Net rejects the whole request above 20 characters. Declaring it
  // here makes the truncation a schema fact rather than a runtime hope.
  assert.match(sqlColumns('AutopayInvite').get('merchantCustomerId'), /VARCHAR\(20\)/);
});

// ── Deletion semantics ─────────────────────────────────────────────────────

test('billing history blocks tenant deletion instead of vanishing with it', () => {
  assert.match(SQL, /"tenantId"\s+TEXT NOT NULL REFERENCES "Tenant"\("id"\) ON DELETE RESTRICT/);
  assert.match(SQL, /"subscriptionId"\s+TEXT NOT NULL REFERENCES "TenantSubscription"\("id"\) ON DELETE RESTRICT/);
  assert.match(SCHEMA, /tenant\s+Tenant\s+@relation\(fields: \[tenantId\], references: \[id\], onDelete: Restrict\)/);
});

test('the ledger keeps a denormalised tenantId with no FK, so a read is cheap', () => {
  // Deliberate: TenantSubscriptionCharge.tenantId and AutopayInvite.tenantId are
  // plain strings. The FK that matters is the one to the subscription.
  assert.match(sqlColumns('TenantSubscriptionCharge').get('tenantId'), /^TEXT NOT NULL$/);
  assert.match(sqlColumns('AutopayInvite').get('tenantId'), /^TEXT NOT NULL$/);
});
