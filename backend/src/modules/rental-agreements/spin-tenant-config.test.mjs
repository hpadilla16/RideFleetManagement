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

// ── 2026-09-04: the CNP rail split ──────────────────────────────────────────
// A tenant-resolved terminal has SPIn credentials only; the Transact client's
// env fallback is another merchant's token. So every saved-card op must route
// by rail. Behaviour of the rail functions is tested in
// payment-gateway/cnp-rail.test.mjs; what is pinned HERE is that the three
// money paths actually consult them.

test('the module imports the shared rail rules rather than reimplementing them', () => {
  assert.match(src, /import \{ usesSpinCnpRail, holdVoidRail \} from '\.\.\/payment-gateway\/cnp-rail\.js'/);
  assert.equal(/function usesSpinCnpRail/.test(src), false, 'no local reimplementation');
  assert.equal(/function holdVoidRail/.test(src), false, 'no local reimplementation');
});

test('charge-card-on-file and re-auth branch on the tenant rail', () => {
  const gates = src.match(/if \(usesSpinCnpRail\(tenantConfig\)\)/g) || [];
  assert.equal(gates.length, 2, `expected the 2 CNP money ops to gate on the rail, found ${gates.length}`);
  // The SPIn branches bill the SAVED token through the tenant's own terminal
  // credentials — never the Transact client.
  assert.match(src, /spinClient\.chargeWithToken\(\{\s*\n\s*amount,\s*\n\s*referenceId: spinRefId,\s*\n\s*token: agreement\.cardOnFileToken/);
  assert.match(src, /spinClient\.preAuthDeposit\(\{\s*\n\s*amount,\s*\n\s*referenceId: spinRefId,\s*\n\s*token: agreement\.cardOnFileToken/);
});

test('hold voids route by the rail that placed the hold, and SPIn voids carry the amount', () => {
  const railPicks = src.match(/holdVoidRail\(agreement\.depositHoldId, tenantConfig\)/g) || [];
  assert.equal(railPicks.length, 2, `release + re-auth must both pick the void rail, found ${railPicks.length}`);
  // The SPIn void without the original amount is a call the gateway refuses
  // (2201, proven live 2026-09-04) — both void sites must send it.
  const spinVoids = src.match(/spinClient\.voidWithRetry\(\{\s*\n\s*referenceId: agreement\.depositHoldId,\s*\n\s*amount: /g) || [];
  assert.equal(spinVoids.length, 2, `expected 2 amount-carrying SPIn void sites, found ${spinVoids.length}`);
});
