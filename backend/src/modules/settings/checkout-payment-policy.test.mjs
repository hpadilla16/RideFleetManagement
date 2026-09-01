/**
 * Per-tenant "payment step optional at check-out" switch (2026-08-26).
 *
 * This is a MONEY-PATH default. The whole suite exists to pin one direction:
 * every input that is not a literal boolean `false` means PAYMENT REQUIRED, so
 * a tenant that never touches the switch — which is every tenant except Rent &
 * Go by VPH Motors — behaves exactly as it did before this change. A regression
 * that flipped the default the other way would silently stop asking customers
 * for money at the counter, across the whole platform, with nothing visibly
 * broken. Hence the table test, the garbage-value cases, and the DB-error case.
 *
 * DB-FREE. `prisma.appSetting` is monkeypatched per test (the same technique
 * two-factor-policy-settings.test.mjs uses); the Prisma client is constructed
 * but never connects.
 */

// MUST be first — sets DATABASE_URL before lib/prisma.js constructs the client.
// (Named for the 2FA suites, but it is a generic env bootstrap: DATABASE_URL,
// JWT_SECRET, INTEGRATION_ENC_KEY. Nothing here is 2FA-specific.)
import '../../lib/_two-factor-test-env.mjs';

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { prisma } from '../../lib/prisma.js';
import {
  isCheckoutPaymentRequired,
  invalidateCheckoutPaymentPolicy,
  setCheckoutPaymentRequired,
  normalizeCheckoutPaymentRequired,
  CHECKOUT_PAYMENT_REQUIRED_FIELD,
} from './checkout-payment-policy.js';
import { settingsService } from './settings.service.js';
import { resolvePaymentPrestampReason } from '../checkout-session/checkout-session.service.js';
import { AUDIT_ACTIONS } from '../audit/audit.service.js';

// Every test gets its own tenant id so the 60s policy cache can never leak
// across cases (which would make an assertion pass for the wrong reason).
let seq = 0;
const nextTenant = () => `t-cpp-${Date.now()}-${++seq}`;

/**
 * Run `fn` with prisma.appSetting.findUnique returning `value` (the raw string
 * that would sit in the row's `value` column), or throwing if `value` is the
 * THROWS sentinel. Records how many reads happened.
 */
const THROWS = Symbol('db-error');
const NEVER_CALLED = Symbol('must-not-read');

async function withStoredValue(value, fn) {
  const orig = prisma.appSetting.findUnique;
  const calls = { count: 0 };
  prisma.appSetting.findUnique = async () => {
    calls.count += 1;
    if (value === THROWS) throw new Error('simulated DB failure');
    if (value === NEVER_CALLED) throw new Error('policy was read when it must not have been');
    return value === null ? null : { value };
  };
  try {
    return await fn(calls);
  } finally {
    prisma.appSetting.findUnique = orig;
  }
}

// ---------------------------------------------------------------------------
// The rule itself
// ---------------------------------------------------------------------------

test('normalizeCheckoutPaymentRequired: ONLY boolean false disables payment', () => {
  // Anything that is not literally `false` is REQUIRED. The string 'false' and
  // the number 0 are in here deliberately: they are the two "obviously falsy"
  // values a hand-edited settings row or a sloppy client is most likely to
  // carry, and treating either as "payment off" would be a silent money bug.
  for (const raw of [undefined, null, 0, '', 'no', 'false', 'true', true, 1, {}, [], NaN]) {
    assert.equal(
      normalizeCheckoutPaymentRequired(raw), true,
      `${JSON.stringify(raw) ?? String(raw)} must resolve to REQUIRED`,
    );
  }
  assert.equal(normalizeCheckoutPaymentRequired(false), false, 'boolean false disables');
});

// ---------------------------------------------------------------------------
// Resolver
// ---------------------------------------------------------------------------

test('no setting at all → payment REQUIRED (today\'s behavior, unchanged)', async () => {
  const tenantId = nextTenant();
  await withStoredValue(null, async () => {
    assert.equal(await isCheckoutPaymentRequired(tenantId), true);
  });
});

test('flag stored false → payment NOT required', async () => {
  const tenantId = nextTenant();
  await withStoredValue(JSON.stringify({ [CHECKOUT_PAYMENT_REQUIRED_FIELD]: false }), async () => {
    assert.equal(await isCheckoutPaymentRequired(tenantId), false);
  });
});

test('flag stored true explicitly → same as default (REQUIRED)', async () => {
  const tenantId = nextTenant();
  await withStoredValue(JSON.stringify({ [CHECKOUT_PAYMENT_REQUIRED_FIELD]: true }), async () => {
    assert.equal(await isCheckoutPaymentRequired(tenantId), true);
  });
});

test('garbage stored values all fail SAFE to REQUIRED', async () => {
  const garbage = [
    JSON.stringify({ [CHECKOUT_PAYMENT_REQUIRED_FIELD]: 'no' }),
    JSON.stringify({ [CHECKOUT_PAYMENT_REQUIRED_FIELD]: null }),
    JSON.stringify({ [CHECKOUT_PAYMENT_REQUIRED_FIELD]: 0 }),
    JSON.stringify({ [CHECKOUT_PAYMENT_REQUIRED_FIELD]: 'false' }),
    JSON.stringify({ somethingElse: false }),
    JSON.stringify(null),
    JSON.stringify([false]),
    '{not json at all',
    '',
  ];
  for (const value of garbage) {
    const tenantId = nextTenant();
    await withStoredValue(value === '' ? null : value, async () => {
      assert.equal(
        await isCheckoutPaymentRequired(tenantId), true,
        `stored ${JSON.stringify(value)} must resolve to REQUIRED`,
      );
    });
  }
});

test('a DB failure resolves to REQUIRED instead of throwing into checkout', async () => {
  const tenantId = nextTenant();
  await withStoredValue(THROWS, async () => {
    assert.equal(await isCheckoutPaymentRequired(tenantId), true);
  });
});

test('no tenantId → REQUIRED, and the settings row is never read', async () => {
  await withStoredValue(NEVER_CALLED, async (calls) => {
    assert.equal(await isCheckoutPaymentRequired(null), true);
    assert.equal(await isCheckoutPaymentRequired(undefined), true);
    assert.equal(await isCheckoutPaymentRequired(''), true);
    assert.equal(calls.count, 0);
  });
});

// ---------------------------------------------------------------------------
// Cache + invalidation
// ---------------------------------------------------------------------------

test('the resolved value is cached per tenant, and invalidation drops it', async () => {
  const tenantId = nextTenant();
  const off = JSON.stringify({ [CHECKOUT_PAYMENT_REQUIRED_FIELD]: false });
  const on = JSON.stringify({ [CHECKOUT_PAYMENT_REQUIRED_FIELD]: true });

  await withStoredValue(off, async (calls) => {
    assert.equal(await isCheckoutPaymentRequired(tenantId), false);
    assert.equal(await isCheckoutPaymentRequired(tenantId), false);
    assert.equal(calls.count, 1, 'second read served from cache');
  });
  // Underlying row now says REQUIRED, but the cache still holds false...
  await withStoredValue(on, async () => {
    assert.equal(await isCheckoutPaymentRequired(tenantId), false, 'still cached');
    invalidateCheckoutPaymentPolicy(tenantId);
    assert.equal(await isCheckoutPaymentRequired(tenantId), true, 'fresh read after invalidation');
  });
});

test('one tenant\'s policy never leaks into another\'s cache entry', async () => {
  const a = nextTenant();
  const b = nextTenant();
  await withStoredValue(JSON.stringify({ [CHECKOUT_PAYMENT_REQUIRED_FIELD]: false }), async () => {
    assert.equal(await isCheckoutPaymentRequired(a), false);
  });
  await withStoredValue(null, async () => {
    assert.equal(await isCheckoutPaymentRequired(b), true, 'tenant B keeps the safe default');
  });
});

test('setCheckoutPaymentRequired writes the blob AND invalidates immediately', async () => {
  const tenantId = nextTenant();
  const origUpsert = prisma.appSetting.upsert;
  let written = null;
  prisma.appSetting.upsert = async ({ where, create, update }) => {
    written = { key: where.key, create: create.value, update: update.value };
    return {};
  };
  try {
    // Warm the cache with the default.
    await withStoredValue(null, async () => {
      assert.equal(await isCheckoutPaymentRequired(tenantId), true);
    });
    await setCheckoutPaymentRequired(tenantId, false);
    assert.match(written.key, new RegExp(`^tenant:${tenantId}:checkoutPaymentPolicy$`));
    assert.deepEqual(JSON.parse(written.create), { [CHECKOUT_PAYMENT_REQUIRED_FIELD]: false });
    assert.deepEqual(JSON.parse(written.update), { [CHECKOUT_PAYMENT_REQUIRED_FIELD]: false });
    // The whole point of the invalidation: the NEXT read sees it, not 60s later.
    await withStoredValue(JSON.stringify({ [CHECKOUT_PAYMENT_REQUIRED_FIELD]: false }), async () => {
      assert.equal(await isCheckoutPaymentRequired(tenantId), false);
    });
  } finally {
    prisma.appSetting.upsert = origUpsert;
  }
});

test('setCheckoutPaymentRequired normalizes garbage to REQUIRED before persisting', async () => {
  const tenantId = nextTenant();
  const origUpsert = prisma.appSetting.upsert;
  let written = null;
  prisma.appSetting.upsert = async ({ create }) => { written = create.value; return {}; };
  try {
    for (const raw of ['no', 0, null, 'false']) {
      await setCheckoutPaymentRequired(tenantId, raw);
      assert.deepEqual(
        JSON.parse(written), { [CHECKOUT_PAYMENT_REQUIRED_FIELD]: true },
        `writing ${JSON.stringify(raw)} must persist REQUIRED`,
      );
    }
  } finally {
    prisma.appSetting.upsert = origUpsert;
  }
});

// ---------------------------------------------------------------------------
// Settings API surface (service layer)
// ---------------------------------------------------------------------------

test('settingsService fails CLOSED without a tenant (no global write)', async () => {
  await assert.rejects(
    () => settingsService.getCheckoutPaymentPolicy({}),
    /tenantId is required/,
  );
  await assert.rejects(
    () => settingsService.updateCheckoutPaymentPolicy({ checkoutPaymentRequired: false }, {}),
    /tenantId is required/,
  );
  // …and a SUPER_ADMIN who has not picked a tenant produces exactly that scope.
  await assert.rejects(
    () => settingsService.updateCheckoutPaymentPolicy({ checkoutPaymentRequired: false }, undefined),
    /tenantId is required/,
  );
});

test('settingsService PUT rejects non-boolean instead of silently defaulting', async () => {
  const tenantId = nextTenant();
  for (const raw of ['false', 0, null, undefined, 'no', 1]) {
    await assert.rejects(
      () => settingsService.updateCheckoutPaymentPolicy({ checkoutPaymentRequired: raw }, { tenantId }),
      /must be a boolean/,
      `${JSON.stringify(raw)} must be rejected`,
    );
  }
});

test('settingsService round-trip: PUT false → GET false on the very next read', async () => {
  const tenantId = nextTenant();
  const origUpsert = prisma.appSetting.upsert;
  let stored = null;
  prisma.appSetting.upsert = async ({ create }) => { stored = create.value; return {}; };
  const origFind = prisma.appSetting.findUnique;
  prisma.appSetting.findUnique = async () => (stored === null ? null : { value: stored });
  try {
    assert.deepEqual(await settingsService.getCheckoutPaymentPolicy({ tenantId }), { checkoutPaymentRequired: true });
    assert.deepEqual(
      await settingsService.updateCheckoutPaymentPolicy({ checkoutPaymentRequired: false }, { tenantId }),
      { checkoutPaymentRequired: false },
    );
    // No sleep, no TTL wait — this is the cache-invalidation contract.
    assert.deepEqual(await settingsService.getCheckoutPaymentPolicy({ tenantId }), { checkoutPaymentRequired: false });
    assert.deepEqual(
      await settingsService.updateCheckoutPaymentPolicy({ checkoutPaymentRequired: true }, { tenantId }),
      { checkoutPaymentRequired: true },
    );
    assert.deepEqual(await settingsService.getCheckoutPaymentPolicy({ tenantId }), { checkoutPaymentRequired: true });
  } finally {
    prisma.appSetting.upsert = origUpsert;
    prisma.appSetting.findUnique = origFind;
  }
});

// ---------------------------------------------------------------------------
// The checkout-session decision
// ---------------------------------------------------------------------------

test('pre-stamp reason: default tenant → null (wizard still collects payment)', async () => {
  const tenantId = nextTenant();
  await withStoredValue(null, async () => {
    assert.equal(await resolvePaymentPrestampReason({ workflowMode: 'RENTAL', tenantId }), null);
  });
});

test('pre-stamp reason: flag false → TENANT_PAYMENT_NOT_REQUIRED', async () => {
  const tenantId = nextTenant();
  await withStoredValue(JSON.stringify({ [CHECKOUT_PAYMENT_REQUIRED_FIELD]: false }), async () => {
    assert.equal(
      await resolvePaymentPrestampReason({ workflowMode: 'RENTAL', tenantId }),
      'TENANT_PAYMENT_NOT_REQUIRED',
    );
  });
});

test('pre-stamp reason: loaner still works, and does NOT consult the tenant setting', async () => {
  const tenantId = nextTenant();
  // findUnique throws if touched — the loaner branch must short-circuit first.
  await withStoredValue(NEVER_CALLED, async (calls) => {
    assert.equal(
      await resolvePaymentPrestampReason({ workflowMode: 'DEALERSHIP_LOANER', tenantId }),
      'DEALERSHIP_LOANER',
    );
    assert.equal(calls.count, 0, 'loaner must not read the tenant policy');
  });
});

test('pre-stamp reason: a loaner is pre-stamped even with payment explicitly REQUIRED', async () => {
  const tenantId = nextTenant();
  await withStoredValue(JSON.stringify({ [CHECKOUT_PAYMENT_REQUIRED_FIELD]: true }), async () => {
    assert.equal(
      await resolvePaymentPrestampReason({ workflowMode: 'DEALERSHIP_LOANER', tenantId }),
      'DEALERSHIP_LOANER',
    );
  });
});

test('pre-stamp reason: a tenantless reservation keeps payment REQUIRED', async () => {
  await withStoredValue(NEVER_CALLED, async () => {
    assert.equal(await resolvePaymentPrestampReason({ workflowMode: 'RENTAL', tenantId: null }), null);
  });
});

// ---------------------------------------------------------------------------
// Source-level ratchets
// ---------------------------------------------------------------------------

const src = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');

test('createForReservation stamps paymentCompletedAt from the resolved reason', () => {
  // The wiring between the (unit-tested) decision and the (DB-heavy) write is
  // four lines inside a function that touches a dozen models. Rather than
  // faking that whole graph, pin the wiring textually: the reason is resolved,
  // and the ONLY thing it gates is the paymentCompletedAt stamp.
  const s = src('../checkout-session/checkout-session.service.js');
  assert.match(s, /const prestampReason = await resolvePaymentPrestampReason\(/);
  assert.match(s, /if \(prestampReason\) \{[\s\S]{0,400}?data: \{ paymentCompletedAt: new Date\(\) \}/);
  assert.match(s, /reason: prestampReason/, 'the applied reason is logged');
});

test('the step graph and its entry guards are untouched by this feature', () => {
  // The safety argument for this whole change is "data-level skip, the state
  // machine is unchanged". If PAID ever stops requiring paymentCompletedAt,
  // the pre-stamp stops being a skip and starts being a bypass.
  const s = src('../checkout-session/state-machine.js');
  assert.match(s, /PAID:\s*'paymentCompletedAt'/, 'PAID still requires paymentCompletedAt');
  assert.match(s, /TC_SIGNED:\s*\['PAYMENT_PENDING'\]/, 'PAYMENT_PENDING still on the path');
  assert.match(s, /PAYMENT_PENDING:\s*\['PAID'\]/);
  assert.doesNotMatch(s, /checkoutPaymentRequired/, 'the state machine knows nothing about the flag');
});

test('the settings routes are ADMIN-gated and audited', () => {
  const s = src('./settings.routes.js');
  assert.match(s, /settingsRouter\.get\('\/checkout-payment', requireRole\('ADMIN'\)/);
  assert.match(s, /settingsRouter\.put\('\/checkout-payment', requireRole\('ADMIN'\)/);
  assert.match(s, /AUDIT_ACTIONS\.CHECKOUT_PAYMENT_POLICY_CHANGE/);
  assert.equal(AUDIT_ACTIONS.CHECKOUT_PAYMENT_POLICY_CHANGE, 'CHECKOUT_PAYMENT_POLICY_CHANGE');
  // Metadata must be the boolean + tenantId only — no PII, no amounts.
  const put = s.slice(s.indexOf("settingsRouter.put('/checkout-payment'"));
  const meta = put.match(/metadata: \{([^}]*)\}/);
  assert.ok(meta, 'PUT records audit metadata');
  assert.match(meta[1], /checkoutPaymentRequired/);
  assert.match(meta[1], /tenantId/);
  assert.doesNotMatch(meta[1], /customer|email|phone|amount|card/i);
});

test('turning the flag off does not touch any charge/refund path', () => {
  // The flag must only ever gate the wizard's mandatory step. If this module
  // ever grows an import from the gateway/charge side, that assumption is gone.
  const s = src('./checkout-payment-policy.js');
  const imports = s.split('\n').filter((l) => /^\s*import\s/.test(l)).join('\n');
  assert.doesNotMatch(imports, /(spin|ipos|payment-gateway|charge|refund)/i);
});
