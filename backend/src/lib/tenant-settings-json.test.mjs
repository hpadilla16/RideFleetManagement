/**
 * Tenant."settingsJson" schema/DB drift guard (2026-08-26).
 * Run: npm run test:tenant-settings-json  (node --test --test-force-exit)
 *
 * WHY: the jsonb column existed in production while the Tenant model in
 * schema.prisma did not declare it. Prisma validates `select` against the
 * generated client, so every read of it was a PrismaClientValidationError —
 * and the per-tenant config it holds had never taken effect ANYWHERE:
 *   * sms.service.js  getTenantSmsConfig   — tenant SMS provider/from-number/creds
 *   * payment-gateway.service.js getTenantSpinConfig — Dejavoo/SPIn terminal
 * Both callers looked healthy because the failure is indistinguishable from
 * "tenant has no override": SMS reported `enabled: false` and SPIn fell back to
 * the platform env vars. International Rental Corp activating their iPOS
 * terminal is what finally surfaced it.
 *
 * Two checks, because either alone has a blind spot:
 *   (a) the FIELD is on the generated client's Tenant model, and is Json?.
 *       This is the drift itself and needs no DB.
 *   (b) each resolver's `select` names only real Tenant fields — enforced by a
 *       stub that validates the select against the DMMF exactly the way the
 *       real client would, then answers with a row. A schema-only assertion
 *       would not notice a service that later asks for a different phantom
 *       field; a stub-only assertion would not notice the schema regressing.
 *
 * No DB: the stub replaces prisma.tenant.findUnique for the duration.
 */
import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, statSync, readFileSync } from 'node:fs';
import { join, sep } from 'node:path';

// This suite never opens a connection, but importing the services pulls in
// lib/prisma.js, and the PrismaClient constructor rejects an undefined URL.
// A placeholder keeps the suite runnable on a laptop with no DB — hence the
// dynamic imports below, which run after this line instead of being hoisted.
process.env.DATABASE_URL ||= 'postgresql://placeholder:placeholder@127.0.0.1:1/tenant-settings-json-test';

const { Prisma } = await import('@prisma/client');
const { prisma } = await import('./prisma.js');
const { cache } = await import('./cache.js');
const { __test: smsInternals } = await import('../modules/sms/sms.service.js');
const { __test: gatewayInternals } = await import('../modules/payment-gateway/payment-gateway.service.js');

const { getTenantSmsConfig } = smsInternals;
const { getTenantSpinConfig } = gatewayInternals;

const TENANT_FIELDS = new Set(
  Prisma.dmmf.datamodel.models.find((m) => m.name === 'Tenant').fields.map((f) => f.name),
);

let realFindUnique;

/**
 * Stand in for prisma.tenant.findUnique, rejecting an unknown `select` key the
 * same way the real client does. `row` is what a matching tenant returns.
 */
function stubTenant(row) {
  prisma.tenant.findUnique = async (args = {}) => {
    for (const key of Object.keys(args.select || {})) {
      if (!TENANT_FIELDS.has(key)) {
        throw new Prisma.PrismaClientValidationError(
          `Unknown field \`${key}\` for select statement on model \`Tenant\`.`,
          { clientVersion: Prisma.prismaVersion.client },
        );
      }
    }
    return row;
  };
}

beforeEach(() => {
  cache.clear();
  realFindUnique = prisma.tenant.findUnique;
});

afterEach(() => {
  prisma.tenant.findUnique = realFindUnique;
  cache.clear();
});

// (a) the drift itself
test('Tenant.settingsJson is declared on the generated Prisma client', () => {
  const field = Prisma.dmmf.datamodel.models
    .find((m) => m.name === 'Tenant')
    .fields.find((f) => f.name === 'settingsJson');
  assert.ok(
    field,
    'Tenant.settingsJson is missing from schema.prisma — the column exists in the DB and every select on it throws at runtime',
  );
  // jsonb in the DB. Json? keeps the column nullable and lets the readers get
  // an object back; String? would silently re-break them on a jsonb column.
  assert.equal(field.type, 'Json');
  assert.equal(field.isRequired, false);
  assert.equal(field.isList, false);
});

// (b) each resolver can actually read a tenant row
test('getTenantSmsConfig reads a tenant row without throwing (jsonb object)', async () => {
  stubTenant({
    id: 't-sms-1',
    name: 'International Rental Corp',
    settingsJson: { smsProvider: 'twilio', smsFromNumber: '+17875551234', smsAccountSid: 'AC1', smsAuthToken: 'tok' },
  });
  const config = await getTenantSmsConfig('t-sms-1');
  assert.equal(config.provider, 'twilio');
  assert.equal(config.fromNumber, '+17875551234');
  assert.equal(config.companyName, 'International Rental Corp');
  assert.equal(config.credentials.accountSid, 'AC1');
  assert.equal(config.enabled, true);
});

test('getTenantSmsConfig accepts the legacy JSON-string form of the column', async () => {
  stubTenant({
    id: 't-sms-2',
    name: 'Ride',
    settingsJson: JSON.stringify({ smsProvider: 'telnyx', smsFromNumber: '+17875559999', smsApiKey: 'KEY' }),
  });
  const config = await getTenantSmsConfig('t-sms-2');
  assert.equal(config.provider, 'telnyx');
  assert.equal(config.credentials.apiKey, 'KEY');
  assert.equal(config.enabled, true);
});

test('getTenantSmsConfig stays fail-closed when the tenant has no settings', async () => {
  // No tenant override and no platform env: nothing to send with, so `enabled`
  // must be false rather than a half-configured provider that fails at send.
  const savedFrom = process.env.SMS_FROM_NUMBER;
  const savedKey = process.env.TELNYX_API_KEY;
  delete process.env.SMS_FROM_NUMBER;
  delete process.env.TELNYX_API_KEY;
  try {
    stubTenant({ id: 't-sms-3', name: 'Ride', settingsJson: null });
    const config = await getTenantSmsConfig('t-sms-3');
    assert.equal(config.enabled, false);
    assert.equal(config.fromNumber, '');
  } finally {
    if (savedFrom !== undefined) process.env.SMS_FROM_NUMBER = savedFrom;
    if (savedKey !== undefined) process.env.TELNYX_API_KEY = savedKey;
  }
});

test('getTenantSmsConfig returns null for an unknown tenant', async () => {
  stubTenant(null);
  assert.equal(await getTenantSmsConfig('t-sms-missing'), null);
  // No tenantId at all never reaches the DB.
  assert.equal(await getTenantSmsConfig(''), null);
});

test('getTenantSpinConfig reads the per-tenant SPIn terminal config', async () => {
  stubTenant({
    id: 't-spin-1',
    name: 'International Rental Corp',
    settingsJson: {
      spinAuthKey: 'AUTH-IRC',
      spinTpn: '123456789',
      spinMerchantNumber: 2,
      spinCallbackUrl: 'https://example.invalid/spin',
      spinSandbox: false,
    },
  });
  const config = await getTenantSpinConfig('t-spin-1');
  assert.equal(config.spinAuthKey, 'AUTH-IRC');
  assert.equal(config.spinTpn, '123456789');
  assert.equal(config.spinMerchantNumber, 2);
  assert.equal(config.spinCallbackUrl, 'https://example.invalid/spin');
  assert.equal(config.spinSandbox, false);
});

test('getTenantSpinConfig stays fail-closed (sandbox) without tenant settings', async () => {
  // spinSandbox defaults TRUE: an unconfigured tenant must never be pointed at
  // the live terminal by omission.
  stubTenant({ id: 't-spin-2', name: 'Ride', settingsJson: null });
  const config = await getTenantSpinConfig('t-spin-2');
  assert.equal(config.spinAuthKey, '');
  assert.equal(config.spinTpn, '');
  assert.equal(config.spinSandbox, true);

  stubTenant(null);
  assert.deepEqual(await getTenantSpinConfig('t-spin-missing'), {});
  assert.deepEqual(await getTenantSpinConfig(''), {});
});

// ---------------------------------------------------------------------------
// (c) the flip side of declaring the field: a bare `include: { tenant: true }`
// now returns settingsJson — i.e. the tenant's live SMS/SPIn credentials — and
// several of those rows are serialized straight into an API response (the
// host-facing /host-app/access among them). Every such site was converted to
// `tenant: { omit: { settingsJson: true } }`. This is a RATCHET so a new one
// cannot quietly join them.
// ---------------------------------------------------------------------------
const BARE_TENANT_INCLUDE_ALLOWED = {
  // Renders print HTML server-side; the row is never serialized to a client,
  // and settingsJson.incidentReportingWindowHours is the one setting this
  // module legitimately wants (reportingWindowHours()).
  'src/modules/incident-report/incident-report.service.js':
    'server-side HTML render, and the intended reader of incidentReportingWindowHours',
};

function sourceFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return sourceFiles(p);
    if (!p.endsWith('.js')) return [];
    if (p.includes('.test.')) return [];
    return [p.split(sep).join('/')];
  });
}

test('no NEW bare `tenant: true` include — it would ship settingsJson to a client', () => {
  const offenders = sourceFiles('src')
    .filter((f) => /\btenant:\s*true\b/.test(readFileSync(f, 'utf8')))
    .filter((f) => !(f in BARE_TENANT_INCLUDE_ALLOWED));
  assert.deepEqual(
    offenders,
    [],
    `Use \`tenant: { omit: { settingsJson: true } }\` instead of \`tenant: true\`: ${offenders.join(', ')}`,
  );
});

test('the bare-include allowlist does not rot', () => {
  const all = new Set(sourceFiles('src'));
  const stale = Object.keys(BARE_TENANT_INCLUDE_ALLOWED).filter(
    (f) => !all.has(f) || !/\btenant:\s*true\b/.test(readFileSync(f, 'utf8')),
  );
  assert.deepEqual(stale, [], `Allowlist entries to delete (gone or already fixed): ${stale.join(', ')}`);
});
