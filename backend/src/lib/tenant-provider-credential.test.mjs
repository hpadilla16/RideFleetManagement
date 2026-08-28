/**
 * Platform-credential inheritance (2026-08-27). DATA-PROTECTION PATH.
 *
 * The bug these tests exist to keep dead has now shipped twice:
 *   • 2026-08-26 SPIn — every tenant charged through the platform terminal.
 *   • 2026-08-27 Anthropic — Corpusa's traffic citations (driver name, licence
 *     details, vehicle, location) were sent to api.anthropic.com under the
 *     PLATFORM account because the scheduler ended `cfg.apiKey ||
 *     process.env.ANTHROPIC_API_KEY`. 14 documents processed, nothing logged,
 *     found only during a UK GDPR due-diligence exercise.
 *
 * Pinned here, hardest first:
 *   • THE DEFAULT: a tenant with no key of its own and no opt-in resolves to
 *     NONE and makes no call — even when the platform key is sitting right
 *     there in env. This is the one assertion the whole task turns on;
 *   • the platform key is reachable ONLY via an explicit per-tenant flag or an
 *     explicit env allowlist naming that tenant id — never a wildcard;
 *   • every PLATFORM resolution WARNs, naming tenant AND feature;
 *   • a half-configured tenant is refused outright, never topped up;
 *   • opting tenant A in never opts tenant B in, and opting a tenant in for
 *     one feature never opts them in for another;
 *   • the credential never appears unmasked in a log line.
 */
import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import logger from './logger.js';
import {
  resolveTenantProviderCredential,
  requireResolvedCredential,
  platformKeyAllowlist,
  allowlistEnvVar,
  maskCredential,
  PLATFORM_CREDENTIAL_FEATURES,
} from './tenant-provider-credential.js';

// ---------------------------------------------------------------------------
// Fixtures — the two real tenants from the incident, plus the platform key.
// ---------------------------------------------------------------------------

const RENT_AND_GO = { id: 'tenant-rent-and-go', name: 'Rent & Go', key: 'TENANT-OWN-CREDENTIAL-0002' };
const CORPUSA = { id: 'tenant-corpusa', name: 'Corpusa' }; // key deliberately removed 2026-08-27
const PLATFORM_KEY = 'PLATFORM-HOUSE-CREDENTIAL-0001';

const ALLOWLIST_VARS = Object.keys(PLATFORM_CREDENTIAL_FEATURES).map(allowlistEnvVar);

let warns = [];
let errors = [];
let restore = [];

beforeEach(() => {
  warns = [];
  errors = [];
  const origWarn = logger.warn;
  const origError = logger.error;
  logger.warn = (msg, meta) => { warns.push({ msg: String(msg), meta: meta || {} }); };
  logger.error = (msg, meta) => { errors.push({ msg: String(msg), meta: meta || {} }); };
  restore = [() => { logger.warn = origWarn; logger.error = origError; }];
  // Every allowlist starts empty — a leaked env var from another suite would
  // silently make the fail-closed assertions pass for the wrong reason.
  for (const v of ALLOWLIST_VARS) delete process.env[v];
});

afterEach(() => {
  restore.forEach((fn) => fn());
  for (const v of ALLOWLIST_VARS) delete process.env[v];
});

const anthropic = (over = {}) => resolveTenantProviderCredential({
  feature: 'citation-ocr',
  platformCredential: PLATFORM_KEY,
  ...over,
});

// ---------------------------------------------------------------------------
// THE DEFAULT — the assertion the whole change exists for.
// ---------------------------------------------------------------------------

test('a tenant that configured nothing resolves to NONE even with the platform key in env', () => {
  const r = anthropic({ tenantId: CORPUSA.id, tenantName: CORPUSA.name });

  assert.equal(r.source, 'NONE', 'Corpusa must not inherit the platform key');
  assert.equal(r.credential, '', 'no credential means no provider call is possible');
  assert.equal(r.reason, 'NO_TENANT_CREDENTIAL');
  assert.equal(warns.length, 0, 'nothing was used, so nothing to warn about');
});

test('requireResolvedCredential fails closed on NONE with a catchable 503 + code', () => {
  const r = anthropic({ tenantId: CORPUSA.id, tenantName: CORPUSA.name });
  assert.throws(
    () => requireResolvedCredential(r),
    (err) => {
      assert.equal(err.status, 503, 'matches the kiosk 503 OCR_UNAVAILABLE spirit');
      assert.equal(err.code, 'PROVIDER_CREDENTIAL_UNAVAILABLE');
      assert.equal(err.feature, 'citation-ocr');
      assert.equal(err.tenantId, CORPUSA.id);
      assert.match(err.message, /not configured for this tenant/i);
      // The operator-facing message must never leak the platform key.
      assert.ok(!err.message.includes(PLATFORM_KEY));
      return true;
    },
  );
});

test('the kiosk caller can override the status/code and still get a typed error', () => {
  const r = anthropic({ tenantId: CORPUSA.id, feature: 'kiosk-id-ocr' });
  assert.throws(
    () => requireResolvedCredential(r, { status: 503, code: 'OCR_UNAVAILABLE' }),
    (err) => err.status === 503 && err.code === 'OCR_UNAVAILABLE',
  );
});

// ---------------------------------------------------------------------------
// A working tenant keeps working.
// ---------------------------------------------------------------------------

test('a tenant with its own key uses it, never the platform key, and warns about nothing', () => {
  const r = anthropic({
    tenantId: RENT_AND_GO.id,
    tenantName: RENT_AND_GO.name,
    tenantCredential: RENT_AND_GO.key,
  });

  assert.equal(r.source, 'TENANT');
  assert.equal(r.credential, RENT_AND_GO.key);
  assert.notEqual(r.credential, PLATFORM_KEY);
  assert.equal(warns.length, 0);
});

test('the tenant key wins even when that tenant is also opted in to the platform key', () => {
  const r = anthropic({
    tenantId: RENT_AND_GO.id,
    tenantCredential: RENT_AND_GO.key,
    tenantOptIn: true,
  });
  assert.equal(r.source, 'TENANT');
  assert.equal(r.credential, RENT_AND_GO.key);
});

// ---------------------------------------------------------------------------
// The two explicit doors — and only those two.
// ---------------------------------------------------------------------------

test('the per-tenant opt-in flag is a door to the platform key, and it WARNs by tenant and feature', () => {
  const r = anthropic({ tenantId: CORPUSA.id, tenantName: CORPUSA.name, tenantOptIn: true });

  assert.equal(r.source, 'PLATFORM');
  assert.equal(r.credential, PLATFORM_KEY);
  assert.equal(r.reason, 'PLATFORM_TENANT_OPT_IN');

  assert.equal(warns.length, 1, 'exactly one WARN, on every single resolution');
  assert.equal(warns[0].meta.tenantId, CORPUSA.id);
  assert.equal(warns[0].meta.tenantName, CORPUSA.name);
  assert.equal(warns[0].meta.feature, 'citation-ocr');
  assert.equal(warns[0].meta.optInSource, 'TENANT_SETTING');
});

test('the env allowlist is the other door — it names one tenant id, and warns as ENV_ALLOWLIST', () => {
  process.env[allowlistEnvVar('citation-ocr')] = CORPUSA.id;

  const r = anthropic({ tenantId: CORPUSA.id, tenantName: CORPUSA.name });
  assert.equal(r.source, 'PLATFORM');
  assert.equal(r.reason, 'PLATFORM_ENV_ALLOWLIST');
  assert.equal(warns[0].meta.optInSource, 'ENV_ALLOWLIST');
});

test('opting one tenant in never opts another in', () => {
  process.env[allowlistEnvVar('citation-ocr')] = RENT_AND_GO.id;

  const other = anthropic({ tenantId: CORPUSA.id });
  assert.equal(other.source, 'NONE', 'the allowlist is a list of ids, not a switch');
  assert.equal(warns.length, 0);
});

test('opting a tenant in for one feature never opts them in for another', () => {
  process.env[allowlistEnvVar('citation-ocr')] = CORPUSA.id;

  const citations = anthropic({ tenantId: CORPUSA.id });
  assert.equal(citations.source, 'PLATFORM');

  // Same tenant, same provider, same env key — different feature. The kiosk
  // reads a driver's licence; consenting to citation OCR is not consent to that.
  const kiosk = anthropic({ tenantId: CORPUSA.id, feature: 'kiosk-id-ocr' });
  assert.equal(kiosk.source, 'NONE');
});

test('a `*` in the allowlist is NOT a wildcard — blanket inheritance stays unreachable', () => {
  process.env[allowlistEnvVar('citation-ocr')] = '*';
  assert.deepEqual(platformKeyAllowlist('citation-ocr'), []);
  assert.equal(anthropic({ tenantId: CORPUSA.id }).source, 'NONE');
});

test('the allowlist tolerates the shapes an operator actually types', () => {
  process.env[allowlistEnvVar('citation-ocr')] = ` ${CORPUSA.id} , ${RENT_AND_GO.id} `;
  assert.deepEqual(platformKeyAllowlist('citation-ocr'), [CORPUSA.id, RENT_AND_GO.id]);
});

test('an opted-in tenant still resolves NONE when the platform has no key either', () => {
  const r = anthropic({ tenantId: CORPUSA.id, platformCredential: '', tenantOptIn: true });
  assert.equal(r.source, 'NONE');
  assert.equal(r.reason, 'NO_PLATFORM_CREDENTIAL');
  assert.equal(warns.length, 0, 'nothing was used — do not warn about a call that never happened');
});

// ---------------------------------------------------------------------------
// Half-configured — the SPIn wrong-merchant lesson, generalised.
// ---------------------------------------------------------------------------

test('a half-configured tenant is refused outright, never topped up from the platform', () => {
  const r = resolveTenantProviderCredential({
    tenantId: 'tenant-half', tenantName: 'Half Baked', feature: 'sms',
    tenantCredential: '', platformCredential: 'platform-authtoken-XXXX',
    tenantConfigPartial: true,
    tenantOptIn: true, // even WITH the opt-in on
  });

  assert.equal(r.source, 'NONE');
  assert.equal(r.reason, 'INCOMPLETE_TENANT_CONFIG');
  assert.equal(errors.length, 1, 'a half-config is an operator mistake — log it at error');
  assert.equal(errors[0].meta.tenantId, 'tenant-half');
  assert.equal(warns.length, 0);
});

// ---------------------------------------------------------------------------
// Credentials never reach the logs.
// ---------------------------------------------------------------------------

test('no log line ever carries a credential in the clear', () => {
  anthropic({ tenantId: CORPUSA.id, tenantName: CORPUSA.name, tenantOptIn: true });

  const serialized = JSON.stringify(warns);
  assert.ok(!serialized.includes(PLATFORM_KEY), 'the platform key must never be logged');
  assert.equal(warns[0].meta.masked, maskCredential(PLATFORM_KEY));
  // First four and last four, nothing in between. The literal prefix tracks the
  // fixture, which was renamed off `sk-ant-…` on 2026-08-28: a test value shaped
  // like a real Anthropic key trips every secret scanner that will ever read
  // this repo — ours did, in CI, on the commit that introduced it.
  assert.match(warns[0].meta.masked, /^PLAT\*{4}0001$/);
});

test('maskCredential never leaks a partial short secret', () => {
  assert.equal(maskCredential(''), '(none)');
  assert.equal(maskCredential('short'), '****');
  assert.equal(maskCredential('abcd-the-middle-wxyz'), 'abcd****wxyz');
});

// ---------------------------------------------------------------------------
// Degenerate input fails closed, it does not throw.
// ---------------------------------------------------------------------------

test('a missing tenantId or feature resolves NONE rather than exploding', () => {
  assert.equal(resolveTenantProviderCredential({}).source, 'NONE');
  assert.equal(resolveTenantProviderCredential({ feature: 'citation-ocr' }).reason, 'NO_TENANT_ID');
  assert.equal(resolveTenantProviderCredential({ tenantId: 'x' }).reason, 'NO_FEATURE');
});

test('every registered feature declares the env var it would otherwise inherit', () => {
  for (const [key, meta] of Object.entries(PLATFORM_CREDENTIAL_FEATURES)) {
    assert.ok(meta.envVar, `${key} must name its platform env var`);
    assert.ok(meta.label, `${key} must have a human label for the WARN`);
    assert.ok(meta.settingsPath, `${key} must tell the operator where to fix it`);
  }
});
