/**
 * B5 Phase 1 review guards (M2 + M3 + R2, 2026-07-24).
 *
 * These tests exist to turn three SILENT failure modes into red builds:
 *   M2 — a new gateway prefix known to the app but missing from the partial
 *        index predicate → that gateway's payments fall outside the
 *        idempotency floor with no error anywhere.
 *   M3 — the filtered unique index is invisible to Prisma, so a
 *        `migrate dev`/`db push` could DROP it and the P2002 collapse would
 *        silently degrade to a no-op.
 *   R2 — an unwrapped gateway import inside the kiosk module would bypass the
 *        live-payment guards (mirrors the assertNoInlinePhotos precedent).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  GATEWAY_REFERENCE_PREFIXES,
  GATEWAY_REFERENCE_INDEX_NAME,
  buildGatewayReference,
  isGatewayReference,
} from './payment-references.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BACKEND = path.resolve(HERE, '..', '..');
const MIGRATION = path.join(
  BACKEND, 'prisma', 'migrations', '20260724_kiosk_b5_phase1', 'migration.sql',
);

// ---------------------------------------------------------------------------
// M2 — the constant and the SQL predicate may never drift apart
// ---------------------------------------------------------------------------

test('M2: every GATEWAY_REFERENCE_PREFIX appears in the partial unique index predicate', () => {
  const sql = fs.readFileSync(MIGRATION, 'utf8');

  const idx = sql.indexOf(GATEWAY_REFERENCE_INDEX_NAME);
  assert.ok(idx > -1, `index ${GATEWAY_REFERENCE_INDEX_NAME} not found in ${MIGRATION}`);
  // The predicate is the WHERE clause of that CREATE UNIQUE INDEX statement.
  const stmt = sql.slice(idx, sql.indexOf(';', idx));
  const where = stmt.slice(stmt.toUpperCase().indexOf('WHERE'));
  assert.ok(where.length > 0, 'the index has no WHERE predicate — it is not partial');

  for (const prefix of GATEWAY_REFERENCE_PREFIXES) {
    assert.ok(
      where.includes(`'${prefix}:%'`),
      `prefix ${prefix} is in GATEWAY_REFERENCE_PREFIXES but NOT in the index predicate — `
      + 'its payments would silently fall outside the idempotency floor. '
      + `Add LIKE '${prefix}:%' to the predicate in ${MIGRATION}.`,
    );
  }
});

test('M2: the SQL predicate declares no prefix the app does not know about', () => {
  const sql = fs.readFileSync(MIGRATION, 'utf8');
  const idx = sql.indexOf(GATEWAY_REFERENCE_INDEX_NAME);
  const stmt = sql.slice(idx, sql.indexOf(';', idx));
  const where = stmt.slice(stmt.toUpperCase().indexOf('WHERE'));

  const declared = [...where.matchAll(/'([A-Z0-9_]+):%'/g)].map((m) => m[1]);
  assert.ok(declared.length > 0, 'no prefixes parsed out of the predicate');
  for (const prefix of declared) {
    assert.ok(
      GATEWAY_REFERENCE_PREFIXES.includes(prefix),
      `the index covers '${prefix}:' but GATEWAY_REFERENCE_PREFIXES does not list it`,
    );
  }
});

test('reference helpers: build/classify only known prefixes', () => {
  assert.equal(buildGatewayReference('IPOS', 'ABC123'), 'IPOS:ABC123');
  assert.equal(buildGatewayReference('ipos', 'ABC123'), 'IPOS:ABC123');
  assert.throws(() => buildGatewayReference('STRIPE', 'x'), /unknown gateway reference prefix/);
  assert.throws(() => buildGatewayReference('IPOS', ''), /gatewayRef is required/);

  assert.equal(isGatewayReference('IPOS:ABC'), true);
  assert.equal(isGatewayReference('AUTHNET:1'), true);
  // human-typed references are deliberately OUTSIDE the floor
  assert.equal(isGatewayReference('****1111 · 1'), false);
  assert.equal(isGatewayReference('003743'), false);
  assert.equal(isGatewayReference(''), false);
});

// ---------------------------------------------------------------------------
// M3 — the filtered unique index must actually exist in a reachable database
// ---------------------------------------------------------------------------

test('M3: the partial unique index exists in the database (Prisma cannot see it)', async (t) => {
  const { prisma } = await import('./prisma.js');

  let rows;
  try {
    rows = await prisma.$queryRawUnsafe(
      `SELECT indexname FROM pg_indexes WHERE indexname = '${GATEWAY_REFERENCE_INDEX_NAME}'`,
    );
  } catch (err) {
    // No database in this environment (CI unit lane) — cannot assert. Skip
    // loudly rather than passing vacuously.
    t.skip(`no reachable database to verify ${GATEWAY_REFERENCE_INDEX_NAME}: ${err?.message?.split('\n')[0]}`);
    return;
  }

  assert.equal(
    rows.length, 1,
    `MISSING INDEX ${GATEWAY_REFERENCE_INDEX_NAME}. The payment idempotency floor is GONE — `
    + 'a webhook+poll race can double-post a payment and double-hold a deposit. '
    + 'Re-apply prisma/migrations/20260724_kiosk_b5_phase1/migration.sql '
    + '(a `prisma migrate dev` / `db push` most likely dropped it: Prisma cannot express a filtered unique index).',
  );
});

test('M3: KioskSession.paymentIntentRef is UNIQUE in the database (money-path binding)', async (t) => {
  const { prisma } = await import('./prisma.js');
  let rows;
  try {
    rows = await prisma.$queryRawUnsafe(
      "SELECT indexdef FROM pg_indexes WHERE tablename = 'KioskSession' AND indexname = 'KioskSession_paymentIntentRef_key'",
    );
  } catch (err) {
    t.skip(`no reachable database: ${err?.message?.split('\n')[0]}`);
    return;
  }
  assert.equal(rows.length, 1, 'KioskSession_paymentIntentRef_key is missing — a mint collision could bind a payment to the WRONG reservation');
  assert.match(String(rows[0].indexdef), /UNIQUE/i);
});

// ---------------------------------------------------------------------------
// R2 — no unwrapped gateway client import inside the kiosk module
// ---------------------------------------------------------------------------

test('R2: the kiosk module imports no gateway client (guards must not be bypassable)', () => {
  const kioskDir = path.join(BACKEND, 'src', 'modules', 'kiosk');
  const files = fs.readdirSync(kioskDir).filter((f) => f.endsWith('.js'));
  assert.ok(files.length > 0, 'no kiosk module files found');

  // payment-ops-queue is explicitly allowed: it is a DB-only staff queue and
  // makes no gateway calls.
  const ALLOWED = ['payment-ops-queue.service.js'];
  const OFFENDERS = /from\s+['"][^'"]*(ipos-[a-z-]*client|spin-client|spin-charge|payment-gateway\/(?!payment-ops-queue))[^'"]*['"]/;

  const bad = [];
  for (const file of files) {
    const src = fs.readFileSync(path.join(kioskDir, file), 'utf8');
    // strip block + line comments so documentation examples don't trip the scan
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const m = code.match(OFFENDERS);
    if (m && !ALLOWED.some((a) => m[0].includes(a))) bad.push(`${file}: ${m[0].trim()}`);
  }

  assert.deepEqual(
    bad, [],
    'kiosk module files must not import a gateway client directly — route every gateway call '
    + 'through withKioskPaymentGuard(ctx, fn) so the live-payment guards cannot be bypassed:\n'
    + bad.join('\n'),
  );
});
