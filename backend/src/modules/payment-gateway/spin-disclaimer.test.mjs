/**
 * spinClient.disclaimer / getSignature — the terminal-side contract prompts
 * (2026-09-04, US terminal checkout).
 *
 * These carry NO money, but they carry the 2026-05-30 lesson: unrecognized
 * fields make the gateway reject with StatusCode 2201 before the terminal is
 * reached, so nothing appears on screen and nothing lands in the portal. The
 * payload staying minimal is therefore the contract these tests defend.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spinClient } from './spin-client.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(here, 'spin-client.js'), 'utf8');

// Dry-run mode returns a synthetic response without touching a terminal.
const DRY = { spinDryRun: true, spinAuthKey: 'k', spinTpn: '123', spinMerchantNumber: '1' };

test('disclaimer sends ONLY Title beyond the common block', () => {
  const body = src.slice(src.indexOf('async disclaimer('), src.indexOf('async getSignature('));
  assert.match(body, /spinRequest\('POST', 'v2\/Common\/Disclaimer', \{ Title: text \}, tenantConfig\)/,
    'exactly one field — the 2201 lesson');
  for (const forbidden of ['CaptureSignature', 'GetToken', 'EnableTip', 'PrintReceipt', 'Amount']) {
    assert.equal(body.includes(forbidden), false, `${forbidden} must not ride along`);
  }
});

test('getSignature sends nothing beyond the common block', () => {
  const body = src.slice(src.indexOf('async getSignature('), src.indexOf('async summaryReport('));
  assert.match(body, /spinRequest\('POST', 'v2\/Common\/GetSignature', \{\}, tenantConfig\)/);
});

test('empty or whitespace text is refused before a call is made', async () => {
  for (const bad of [undefined, null, '', '   ']) {
    await assert.rejects(() => spinClient.disclaimer({ title: bad }, DRY), /requires text/);
  }
});

test('text is trimmed, never truncated — silently cutting a clause changes what was agreed', async () => {
  const long = 'x'.repeat(4000);
  const res = await spinClient.disclaimer({ title: `  ${long}  ` }, DRY);
  assert.ok(res, 'dry-run returns a synthetic response');
  const body = src.slice(src.indexOf('async disclaimer('), src.indexOf('async getSignature('));
  assert.equal(/\.slice\(/.test(body), false, 'no truncation in the disclaimer path');
});

test('both are reachable on the client surface', () => {
  assert.equal(typeof spinClient.disclaimer, 'function');
  assert.equal(typeof spinClient.getSignature, 'function');
});

test('the probe script exists and refuses a non-TENANT terminal', () => {
  const probe = fs.readFileSync(path.join(here, '../../../scripts/probe-terminal-disclaimer.mjs'), 'utf8');
  assert.match(probe, /resolved\.source !== 'TENANT'/, 'never probes on the platform terminal');
  assert.match(probe, /NO MONEY/);
});
