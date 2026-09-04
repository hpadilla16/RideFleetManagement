/**
 * Regression: the wrong-merchant stub (fixed 2026-09-04).
 *
 * rental-agreements.service.js used to carry its own loadTenantSpinConfig that
 * read a Tenant row and returned `{}` no matter what — `return row ? {} : {}`.
 * An empty config makes spin-client fall back to the PLATFORM env terminal, so
 * a tenant with their own terminal was charged through somebody else's. Three
 * money paths ran on it: spinChargeCardOnFile, spinReleaseDepositHold,
 * spinReauthDepositHold.
 *
 * Source-level assertions on purpose: the defect was a shape, not a behaviour
 * an in-memory prisma could reproduce (the stub "worked" — it just answered the
 * wrong question). What must never come back is the tautological return and the
 * module-local reimplementation, so that is what is pinned.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(here, 'rental-agreements.service.js'), 'utf8');

test('the tautological stub is gone', () => {
  assert.equal(src.includes('return row ? {} : {}'), false,
    'the stub that returned {} either way must never come back');
});

test('the module delegates to the one terminal resolver', () => {
  assert.match(src, /import \{ resolveTenantTerminalConfig, toSpinClientConfig \} from '\.\.\/payment-gateway\/tenant-terminal-config\.js'/,
    'imports the shared resolver rather than reimplementing it');
  // 2026-09-04 — the call now also carries the pickup location, so a tenant on
  // per-location registers resolves to THAT branch's terminal instead of
  // whichever one happens to be first. Still the one resolver, still no local
  // reimplementation.
  assert.match(src, /toSpinClientConfig\(await resolveTenantTerminalConfig\(tenantId, \{ locationId \}\)\)/,
    'same call payment-gateway.service.js makes, with the location threaded');
});

test('all three money paths still read their config through that one function', () => {
  for (const fn of ['spinChargeCardOnFile', 'spinReleaseDepositHold', 'spinReauthDepositHold']) {
    assert.ok(src.includes(`async ${fn}(`), `${fn} still exists`);
  }
  // Each of the three must pass the agreement's OWN pickup location. Passing
  // the tenant alone would put a multi-branch tenant back on "whichever
  // terminal", which is what registers exist to stop.
  const uses = src.match(/await loadTenantSpinConfig\(agreement\.tenantId, agreement\.pickupLocationId\)/g) || [];
  assert.equal(uses.length, 3, `expected 3 location-carrying call sites, found ${uses.length}`);
  assert.equal((src.match(/await loadTenantSpinConfig\(agreement\.tenantId\)/g) || []).length, 0,
    'no call site may drop the location');
});

test('a resolve failure degrades instead of throwing mid-charge', () => {
  // A money path must not die because a settings read blipped; it falls back
  // the way it always did, but loudly.
  assert.match(src, /catch \(e\) \{\s*\n\s*logger\.warn\?\.\(\{ tenantId, locationId, err: e\?\.message \}/);
});
