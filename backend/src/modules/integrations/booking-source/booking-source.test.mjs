/**
 * booking-source — unit + PARITY tests for the R0 extraction (2026-07-13).
 *
 * The extraction rule is CERO cambio de comportamiento: economy/ and nu/ keep
 * their own copies until the re-wire phase, so the load-bearing proof here is
 * PARITY — the shared, sourceSpec-parametrized pieces must produce the SAME
 * writes / decisions as the original per-source code for identical inputs:
 *   1. promote.js        vs nu.worker / economy.worker promoteWithMappings
 *   2. customer-autocreate vs maybeCreateCustomerFromNu / ...FromEconomy
 *   3. scheduler-factory vs nu.scheduler / economy.scheduler
 *   4. window.js         vs nu.constants / economy.constants helpers
 *   5. http-common.js    vs nu.service / economy.service helpers
 *   6. tl-international shims re-export the exact moved modules
 *
 * Style mirrors nu.test.mjs / economy.test.mjs: monkey-patch the prisma
 * singleton per test, restore in finally, no DB / no network.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

process.env.INTEGRATION_ENC_KEY = crypto.randomBytes(32).toString('base64');

const { prisma } = await import('../../../lib/prisma.js');
const { decrypt } = await import('../../../lib/integration-crypto.js');

const { createPromoter } = await import('./promote.js');
const {
  maybeCreateCustomerFromSource,
  autoCreateEnabledFromEnv,
  CUSTOMER_PHONE_PLACEHOLDER,
} = await import('./customer-autocreate.js');
const { createSyncScheduler } = await import('./scheduler-factory.js');
const { createWindowHelpers, normalizeDays } = await import('./window.js');
const {
  USER_AGENT_POOL,
  makePickUserAgent,
  randomDelay,
  sleep,
  AuthExpiredError,
  createCredentialStore,
} = await import('./http-common.js');

// Originals (NOT re-wired in R0) — the parity baseline.
const nuWorker = await import('../nu/nu.worker.js');
const economyWorker = await import('../economy/economy.worker.js');
const nuScheduler = await import('../nu/nu.scheduler.js');
const economyScheduler = await import('../economy/economy.scheduler.js');
const nuConstants = await import('../nu/nu.constants.js');
const economyConstants = await import('../economy/economy.constants.js');
const nuService = await import('../nu/nu.service.js');
const economyService = await import('../economy/economy.service.js');

// Shim targets.
const tlMatcher = await import('../tl-international/promotion-matcher.service.js');
const bsMatcher = await import('./promotion-matcher.service.js');
const tlDetector = await import('../tl-international/duplicate-detector.service.js');
const bsDetector = await import('./duplicate-detector.service.js');

// ---------------------------------------------------------------------------
// The two sourceSpecs the re-wire phase will use. Kept here (not exported from
// promote.js) so R0 ships zero per-source production code.
// ---------------------------------------------------------------------------
const NU_SPEC = Object.freeze({
  reservationPrefix: 'NU-',
  bookingChannel: 'FRANCHISE_NU',
  sourceLabel: 'NU Car Rentals',
  logPrefix: '[nu-sync]',
  defaultTimeZone: 'America/New_York',
  buildReservationExtras: (fresh) => ({
    isPrepaid: typeof fresh.isPrepaid === 'boolean' ? fresh.isPrepaid : null,
    notes: `Imported from NU Car Rentals — ${fresh.externalRef}`
      + (fresh.isPrepaid === false ? ' (pay-at-destination)' : ''),
  }),
});

const ECONOMY_SPEC = Object.freeze({
  reservationPrefix: 'ECON-',
  bookingChannel: 'FRANCHISE_ECONOMY',
  sourceLabel: 'Economy (RezLight)',
  logPrefix: '[economy-sync]',
  defaultTimeZone: 'America/New_York',
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Deep-canonicalize a capture for comparison: Dates (promotedAt etc. are
// "new Date()" at run time) collapse to a marker, keys are sorted.
function canon(v) {
  if (v instanceof Date) return '<Date>';
  if (Array.isArray(v)) return v.map(canon);
  if (v && typeof v === 'object') {
    return Object.fromEntries(
      Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, x]) => [k, canon(x)])
    );
  }
  return v;
}

// Fake $transaction tx capturing every write promoteWithMappings can make.
// `dupRows` feeds the duplicate detector's $queryRaw (LINK path).
function makePromoteTx(fresh, capture, { dupRows = [] } = {}) {
  return {
    externalReservation: {
      findUnique: async () => ({ ...fresh }),
      update: async (args) => { capture.extResUpdate = args; return { ...fresh, ...args.data }; },
    },
    reservation: {
      findUnique: async ({ where }) => (where.id ? { id: where.id, existing: true } : null),
      create: async ({ data }) => { capture.reservationCreate = data; return { id: 'res-new', ...data }; },
    },
    vehicleType: { findFirst: async () => null },
    $queryRaw: async () => dupRows,
  };
}

// Run one promoteWithMappings implementation against the fake tx; returns
// { result, capture }.
async function runPromote(promoteFn, fresh, opts, txOpts) {
  const capture = {};
  const origTx = prisma.$transaction;
  prisma.$transaction = async (fn) => fn(makePromoteTx(fresh, capture, txOpts));
  try {
    const result = await promoteFn(fresh, opts);
    return { result, capture };
  } finally {
    prisma.$transaction = origTx;
  }
}

// ---------------------------------------------------------------------------
// 1. promote.js — parity vs the original workers
// ---------------------------------------------------------------------------

const FIXED_PICKUP = new Date('2026-07-20T14:00:00.000Z');
const FIXED_DROPOFF = new Date('2026-07-24T14:00:00.000Z');

function freshFixture(over = {}) {
  return {
    id: 'ext-1',
    tenantId: 't1',
    externalRef: '617-0101010-NU',
    promotionStatus: 'PENDING',
    promotedToReservationId: null,
    totalAmount: '249.50',
    pickupAt: FIXED_PICKUP,
    dropoffAt: FIXED_DROPOFF,
    customerFirstName: null, // null names → duplicate detector returns null early
    customerLastName: null,
    ...over,
  };
}

for (const { name, spec, original, over } of [
  {
    name: 'NU pay-at-destination row (isPrepaid=false + notes suffix)',
    spec: NU_SPEC,
    original: nuWorker.promoteWithMappings,
    over: { isPrepaid: false },
  },
  {
    name: 'NU prepaid row (isPrepaid=true, no suffix)',
    spec: NU_SPEC,
    original: nuWorker.promoteWithMappings,
    over: { isPrepaid: true },
  },
  {
    name: 'NU row without prepaid signal (isPrepaid=null)',
    spec: NU_SPEC,
    original: nuWorker.promoteWithMappings,
    over: { isPrepaid: null },
  },
  {
    name: 'Economy row (no isPrepaid key at all)',
    spec: ECONOMY_SPEC,
    original: economyWorker.promoteWithMappings,
    over: { externalRef: 'ECN-555', isPrepaid: undefined },
  },
]) {
  test(`promote parity: ${name} — shared promoter reproduces the original writes`, async () => {
    const fresh = freshFixture(over);
    const opts = { customerId: 'c1', locationId: 'loc1', isAuto: true };

    const orig = await runPromote(original, fresh, opts);
    const shared = await runPromote(createPromoter(spec).promoteWithMappings, fresh, opts);

    assert.deepEqual(canon(shared.capture.reservationCreate), canon(orig.capture.reservationCreate));
    assert.deepEqual(canon(shared.capture.extResUpdate), canon(orig.capture.extResUpdate));
    assert.equal(shared.result.alreadyPromoted, orig.result.alreadyPromoted);
  });
}

test('promote parity: Economy create carries NO isPrepaid key (NU-only field stays NU-only)', async () => {
  const fresh = freshFixture({ externalRef: 'ECN-777' });
  const opts = { customerId: 'c1', locationId: 'loc1', isAuto: true };
  const orig = await runPromote(economyWorker.promoteWithMappings, fresh, opts);
  const shared = await runPromote(createPromoter(ECONOMY_SPEC).promoteWithMappings, fresh, opts);
  assert.equal('isPrepaid' in orig.capture.reservationCreate, false);
  assert.equal('isPrepaid' in shared.capture.reservationCreate, false);
});

test('promote parity: duplicate LINK path (names + pickup match) links instead of creating', async () => {
  const fresh = freshFixture({
    customerFirstName: 'Ana',
    customerLastName: 'Rivera',
    isPrepaid: false,
  });
  const opts = { customerId: 'c1', locationId: 'loc1', isAuto: true };
  const txOpts = { dupRows: [{ id: 'res-dup' }] };

  const orig = await runPromote(nuWorker.promoteWithMappings, fresh, opts, txOpts);
  const shared = await runPromote(createPromoter(NU_SPEC).promoteWithMappings, fresh, opts, txOpts);

  for (const run of [orig, shared]) {
    assert.equal(run.result.linked, true);
    assert.equal(run.capture.reservationCreate, undefined); // no new Reservation
    assert.equal(run.capture.extResUpdate.data.promotionStatus, 'PROMOTED');
    assert.equal(run.capture.extResUpdate.data.promotedToReservationId, 'res-dup');
    assert.equal(run.capture.extResUpdate.data.promotedByUserId, 'system');
  }
  assert.deepEqual(canon(shared.capture.extResUpdate), canon(orig.capture.extResUpdate));
});

test('promote parity: already-promoted short-circuit returns the linked Reservation, writes nothing', async () => {
  const fresh = freshFixture({ promotionStatus: 'AUTO_PROMOTED', promotedToReservationId: 'res-old' });
  const opts = { customerId: 'c1', locationId: 'loc1', isAuto: true };

  const orig = await runPromote(nuWorker.promoteWithMappings, fresh, opts);
  const shared = await runPromote(createPromoter(NU_SPEC).promoteWithMappings, fresh, opts);

  for (const run of [orig, shared]) {
    assert.equal(run.result.alreadyPromoted, true);
    assert.equal(run.result.reservation.id, 'res-old');
    assert.equal(run.capture.reservationCreate, undefined);
    assert.equal(run.capture.extResUpdate, undefined);
  }
});

test('promote parity: manual promote (isAuto=false) stamps PROMOTED + promotedByUserId', async () => {
  const fresh = freshFixture({ isPrepaid: null });
  const opts = { customerId: 'c1', locationId: 'loc1', isAuto: false, promotedByUserId: 'user-9' };

  const orig = await runPromote(nuWorker.promoteWithMappings, fresh, opts);
  const shared = await runPromote(createPromoter(NU_SPEC).promoteWithMappings, fresh, opts);

  assert.deepEqual(canon(shared.capture.extResUpdate), canon(orig.capture.extResUpdate));
  assert.equal(shared.capture.extResUpdate.data.promotionStatus, 'PROMOTED');
  assert.equal(shared.capture.extResUpdate.data.promotedByUserId, 'user-9');
});

test('promote: guards match the originals (customerId/locationId required, AUTO gate)', async () => {
  const { promoteWithMappings, promoteAutomatically } = createPromoter(NU_SPEC);
  await assert.rejects(() => promoteWithMappings({ id: 'x' }, { locationId: 'l' }), /customerId is required/);
  await assert.rejects(() => promoteWithMappings({ id: 'x' }, { customerId: 'c' }), /locationId is required/);
  await assert.rejects(
    () => promoteAutomatically({ id: 'x' }, { decision: 'MANUAL_REVIEW' }),
    /requires decision\.decision === "AUTO"/
  );
});

test('promote: promoteAutomatically honors the config-mapped locationId override (parity)', async () => {
  const fresh = freshFixture({ isPrepaid: false });
  const decision = {
    decision: 'AUTO',
    mappedCustomer: { id: 'c1' },
    mappedVehicleCategory: null,
    mappedLocation: { id: 'loc-from-matcher' },
  };
  const run = async (fn) => {
    const capture = {};
    const origTx = prisma.$transaction;
    prisma.$transaction = async (cb) => cb(makePromoteTx(fresh, capture));
    try {
      await fn(fresh, decision, { locationId: 'loc-config', timeZone: 'America/New_York' });
      return capture;
    } finally {
      prisma.$transaction = origTx;
    }
  };
  const orig = await run(nuWorker.promoteAutomatically);
  const shared = await run(createPromoter(NU_SPEC).promoteAutomatically);
  assert.equal(orig.reservationCreate.pickupLocationId, 'loc-config');
  assert.deepEqual(canon(shared.reservationCreate), canon(orig.reservationCreate));
});

// ---------------------------------------------------------------------------
// 2. customer-autocreate — parity vs maybeCreateCustomerFromNu / FromEconomy
// ---------------------------------------------------------------------------

function fakeCustomerPrisma(capture, { existing = null } = {}) {
  return {
    customer: {
      findFirst: async (args) => { capture.findFirst = args; return existing; },
      create: async (args) => { capture.create = args; return { id: 'cust-new', ...args.data }; },
    },
  };
}

const AUTOCREATE_CASES = [
  {
    name: 'full row (email + phone)',
    extRes: {
      tenantId: 't1', externalRef: 'R1',
      customerFirstName: ' Ana ', customerLastName: ' Rivera ',
      customerEmail: 'ANA@Example.com', customerPhone: ' 787-555-1234 ',
      customerCountry: 'PR',
    },
  },
  {
    name: 'no phone → placeholder',
    extRes: {
      tenantId: 't1', externalRef: 'R2',
      customerFirstName: 'Ana', customerLastName: 'Rivera',
      customerEmail: 'ana2@example.com', customerPhone: '',
      customerCountry: null,
    },
  },
  {
    name: 'phone only (no email)',
    extRes: {
      tenantId: 't1', externalRef: 'R3',
      customerFirstName: 'Ana', customerLastName: 'Rivera',
      customerEmail: null, customerPhone: '7875550000',
    },
  },
  {
    name: 'missing last name → null',
    extRes: { tenantId: 't1', externalRef: 'R4', customerFirstName: 'Ana', customerLastName: '' },
  },
  {
    name: 'no email and no phone → null',
    extRes: { tenantId: 't1', externalRef: 'R5', customerFirstName: 'Ana', customerLastName: 'Rivera' },
  },
];

for (const { name, extRes } of AUTOCREATE_CASES) {
  test(`autocreate parity: ${name}`, async () => {
    const capA = {}; const capB = {}; const capC = {};
    const a = await nuWorker.maybeCreateCustomerFromNu(fakeCustomerPrisma(capA), extRes);
    const b = await economyWorker.maybeCreateCustomerFromEconomy(fakeCustomerPrisma(capB), extRes);
    const c = await maybeCreateCustomerFromSource(fakeCustomerPrisma(capC), extRes, {
      logPrefix: '[nu-sync]', sourceName: 'NU',
    });
    // Same DB writes (or same absence of them) across all three.
    assert.deepEqual(canon(capC), canon(capA));
    assert.deepEqual(canon(capC), canon(capB));
    assert.deepEqual(canon(c), canon(a));
    assert.deepEqual(canon(c), canon(b));
  });
}

test('autocreate: existing email match is reused, no create', async () => {
  const cap = {};
  const out = await maybeCreateCustomerFromSource(
    fakeCustomerPrisma(cap, { existing: { id: 'cust-old' } }),
    AUTOCREATE_CASES[0].extRes,
    { logPrefix: '[economy-sync]', sourceName: 'Economy' }
  );
  assert.equal(out.id, 'cust-old');
  assert.equal(cap.create, undefined);
});

test('autocreate: placeholder phone matches the originals', async () => {
  const cap = {};
  await maybeCreateCustomerFromSource(fakeCustomerPrisma(cap), AUTOCREATE_CASES[1].extRes, {});
  assert.equal(cap.create.data.phone, CUSTOMER_PHONE_PLACEHOLDER);
  assert.equal(CUSTOMER_PHONE_PLACEHOLDER, '0000000000');
});

test('autocreate: isEnabled=false short-circuits without touching prisma', async () => {
  const cap = {};
  const out = await maybeCreateCustomerFromSource(fakeCustomerPrisma(cap), AUTOCREATE_CASES[0].extRes, {
    isEnabled: false,
  });
  assert.equal(out, null);
  assert.deepEqual(cap, {});
});

test('autocreate: env-flag parse matches the originals (true/1/yes, default off)', () => {
  const KEY = 'BSTEST_AUTO_CREATE_CUSTOMERS';
  const cases = [
    [undefined, false], ['', false], ['false', false], ['no', false], ['0', false],
    ['true', true], ['TRUE ', true], ['1', true], ['yes', true],
  ];
  for (const [raw, expected] of cases) {
    if (raw === undefined) delete process.env[KEY]; else process.env[KEY] = raw;
    assert.equal(autoCreateEnabledFromEnv(KEY), expected, `raw=${JSON.stringify(raw)}`);
  }
  delete process.env[KEY];
});

// ---------------------------------------------------------------------------
// 3. scheduler-factory — parity vs nu.scheduler / economy.scheduler
// ---------------------------------------------------------------------------

function makeNuLikeScheduler(over = {}) {
  return createSyncScheduler({
    envPrefix: 'NU',
    sourceSystem: 'NU',
    configKey: 'nu',
    logPrefix: '[nu]',
    hasEnabledConfig: async (tenantIds) => {
      const rows = await prisma.nuLocationConfig.findMany({
        where: { tenantId: { in: tenantIds }, enabled: true },
        select: { tenantId: true },
      });
      return rows.map((r) => r.tenantId);
    },
    enqueue: async () => {},
    ...over,
  });
}

test('scheduler parity: masterEnabledFromConfig matches nu + economy originals', () => {
  const nuShared = makeNuLikeScheduler();
  const econShared = createSyncScheduler({
    envPrefix: 'ECONOMY', sourceSystem: 'ECONOMY', configKey: 'economy', logPrefix: '[economy]',
    hasEnabledConfig: async () => [], enqueue: async () => {},
  });
  const cases = [
    null, {}, 'nope',
    { nu: {} }, { nu: { enabled: false } }, { nu: { enabled: true } }, { nu: { enabled: 'true' } },
    { economy: {} }, { economy: { enabled: false } }, { economy: { enabled: true } },
    { economy: { enabled: true }, nu: { enabled: true } },
  ];
  for (const cfg of cases) {
    assert.equal(nuShared.masterEnabledFromConfig(cfg), nuScheduler.masterEnabledFromConfig(cfg), `nu cfg=${JSON.stringify(cfg)}`);
    assert.equal(econShared.masterEnabledFromConfig(cfg), economyScheduler.masterEnabledFromConfig(cfg), `economy cfg=${JSON.stringify(cfg)}`);
  }
});

test('scheduler parity: enumerateActiveTenants matches the NU original on the same prisma state', async () => {
  const origCred = prisma.integrationCredential.findMany;
  const origCfg = prisma.nuLocationConfig.findMany;
  const credCalls = [];
  prisma.integrationCredential.findMany = async (args) => {
    credCalls.push(args);
    return [
      { tenantId: 'tenant-on', tenant: { integrationConfig: { nu: { enabled: true } } } },
      { tenantId: 'tenant-on', tenant: { integrationConfig: { nu: { enabled: true } } } }, // dup cred → dedupe
      { tenantId: 'tenant-off', tenant: { integrationConfig: { nu: { enabled: false } } } },
      { tenantId: 'tenant-no-config', tenant: { integrationConfig: { nu: { enabled: true } } } },
    ];
  };
  prisma.nuLocationConfig.findMany = async ({ where }) =>
    where.tenantId.in.filter((id) => id !== 'tenant-no-config').map((id) => ({ tenantId: id }));
  try {
    const shared = await makeNuLikeScheduler().enumerateActiveTenants();
    const original = await nuScheduler.enumerateActiveTenants();
    assert.deepEqual(shared, original);
    assert.deepEqual(shared, ['tenant-on']);
    // Both build the same credential query (sourceSystem + ACTIVE tenant).
    assert.deepEqual(canon(credCalls[0]), canon(credCalls[1]));
  } finally {
    prisma.integrationCredential.findMany = origCred;
    prisma.nuLocationConfig.findMany = origCfg;
  }
});

test('scheduler parity: no master-on tenant → [] and the config query is skipped', async () => {
  const origCred = prisma.integrationCredential.findMany;
  prisma.integrationCredential.findMany = async () => ([
    { tenantId: 'tenant-off', tenant: { integrationConfig: { nu: { enabled: false } } } },
  ]);
  let cfgCalled = false;
  try {
    const sched = makeNuLikeScheduler({ hasEnabledConfig: async () => { cfgCalled = true; return []; } });
    assert.deepEqual(await sched.enumerateActiveTenants(), []);
    assert.equal(cfgCalled, false);
  } finally {
    prisma.integrationCredential.findMany = origCred;
  }
});

test('scheduler: runSweep enqueues per tenant, keeps going past a failing enqueue', async () => {
  const origCred = prisma.integrationCredential.findMany;
  prisma.integrationCredential.findMany = async () => ([
    { tenantId: 'A', tenant: { integrationConfig: { nu: { enabled: true } } } },
    { tenantId: 'B', tenant: { integrationConfig: { nu: { enabled: true } } } },
    { tenantId: 'C', tenant: { integrationConfig: { nu: { enabled: true } } } },
  ]);
  const enqueued = [];
  try {
    const sched = makeNuLikeScheduler({
      hasEnabledConfig: async (ids) => ids,
      enqueue: async (tenantId, triggeredBy) => {
        if (tenantId === 'B') throw new Error('redis down');
        enqueued.push([tenantId, triggeredBy]);
      },
    });
    const out = await sched.runSweep();
    assert.deepEqual(out, { processedTenants: 3, enqueued: 2 });
    assert.deepEqual(enqueued, [['A', 'schedule'], ['C', 'schedule']]);
  } finally {
    prisma.integrationCredential.findMany = origCred;
  }
});

test('scheduler: in-progress guard skips an overlapping sweep (same shape as originals)', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const origCred = prisma.integrationCredential.findMany;
  prisma.integrationCredential.findMany = async () => { await gate; return []; };
  try {
    const sched = makeNuLikeScheduler();
    const first = sched.runSweep();
    const second = await sched.runSweep();
    assert.deepEqual(second, { skipped: true });
    release();
    const out = await first;
    assert.deepEqual(out, { processedTenants: 0, enqueued: 0 });
    // Guard released → a fresh sweep runs again.
    const third = await sched.runSweep();
    assert.deepEqual(third, { processedTenants: 0, enqueued: 0 });
  } finally {
    prisma.integrationCredential.findMany = origCred;
  }
});

test('scheduler: sweep failure is swallowed into { error } (never throws)', async () => {
  const origCred = prisma.integrationCredential.findMany;
  prisma.integrationCredential.findMany = async () => { throw new Error('db exploded'); };
  try {
    const out = await makeNuLikeScheduler().runSweep();
    assert.deepEqual(out, { error: 'db exploded' });
  } finally {
    prisma.integrationCredential.findMany = origCred;
  }
});

test('scheduler: global env flag gates start(); startup timer fires a sweep; stop() clears', async () => {
  const KEY = 'BSTEST_INTEGRATION_ENABLED';
  let sweeps = 0;
  const sched = createSyncScheduler({
    envPrefix: 'BSTEST', sourceSystem: 'BSTEST', configKey: 'bstest', logPrefix: '[bstest]',
    hasEnabledConfig: async () => [], enqueue: async () => {},
    prismaClient: { integrationCredential: { findMany: async () => { sweeps++; return []; } } },
  });

  // Flag off (default) → start() is a no-op.
  delete process.env[KEY];
  assert.equal(sched.integrationEnabled(), false);
  sched.start();
  await sleep(20);
  assert.equal(sweeps, 0);

  // Flag on + zero startup delay → the startup sweep fires; double-start guarded.
  process.env[KEY] = 'true';
  process.env.BSTEST_SYNC_STARTUP_DELAY_SECONDS = '0';
  try {
    assert.equal(sched.integrationEnabled(), true);
    sched.start();
    sched.start(); // second call must not schedule a second startup sweep
    await sleep(30);
    assert.equal(sweeps, 1);
    sched.stop();
    sched.stop(); // idempotent
    await sleep(30);
    assert.equal(sweeps, 1); // nothing fires after stop
  } finally {
    delete process.env[KEY];
    delete process.env.BSTEST_SYNC_STARTUP_DELAY_SECONDS;
    sched.stop();
  }
});

// ---------------------------------------------------------------------------
// 4. window.js — parity vs nu.constants / economy.constants
// ---------------------------------------------------------------------------

const WINDOW_CONFIG_CASES = [
  {},
  { lookbackDays: null, lookaheadDays: null },
  { lookbackDays: 0, lookaheadDays: 0 },
  { lookbackDays: 7, lookaheadDays: 45 },
  { lookbackDays: '7', lookaheadDays: '45' }, // numeric strings coerce
  { lookbackDays: -1, lookaheadDays: 'x' },   // invalid → env default
];

test('window parity: effectiveWindowDays/windowBoundsForConfig match NU and Economy originals', () => {
  const NOW = Date.parse('2026-07-13T12:00:00Z');
  const nuHelpers = createWindowHelpers({
    defaultLookbackDays: nuConstants.DATE_WINDOW_LOOKBACK_DAYS,
    defaultLookaheadDays: nuConstants.DATE_WINDOW_LOOKAHEAD_DAYS,
  });
  const econHelpers = createWindowHelpers({
    defaultLookbackDays: economyConstants.DATE_WINDOW_LOOKBACK_DAYS,
    defaultLookaheadDays: economyConstants.DATE_WINDOW_LOOKAHEAD_DAYS,
  });
  for (const cfg of WINDOW_CONFIG_CASES) {
    assert.deepEqual(nuHelpers.effectiveWindowDays(cfg), nuConstants.effectiveWindowDays(cfg), `nu eff ${JSON.stringify(cfg)}`);
    assert.deepEqual(econHelpers.effectiveWindowDays(cfg), economyConstants.effectiveWindowDays(cfg), `econ eff ${JSON.stringify(cfg)}`);
    assert.deepEqual(nuHelpers.windowBoundsForConfig(cfg, NOW), nuConstants.windowBoundsForConfig(cfg, NOW), `nu bounds ${JSON.stringify(cfg)}`);
    assert.deepEqual(econHelpers.windowBoundsForConfig(cfg, NOW), economyConstants.windowBoundsForConfig(cfg, NOW), `econ bounds ${JSON.stringify(cfg)}`);
  }
});

test('window parity: union window matches the Economy originals (widest of each side)', () => {
  const NOW = Date.parse('2026-07-13T12:00:00Z');
  const helpers = createWindowHelpers({
    defaultLookbackDays: economyConstants.DATE_WINDOW_LOOKBACK_DAYS,
    defaultLookaheadDays: economyConstants.DATE_WINDOW_LOOKAHEAD_DAYS,
  });
  const configSets = [
    [],
    [{ lookbackDays: 1, lookaheadDays: 10 }],
    [{ lookbackDays: 1, lookaheadDays: 10 }, { lookbackDays: 9, lookaheadDays: 5 }],
    [{ lookbackDays: null, lookaheadDays: 90 }, { lookbackDays: 4, lookaheadDays: null }],
    'not-an-array',
  ];
  for (const configs of configSets) {
    assert.deepEqual(helpers.unionWindowDays(configs), economyConstants.unionWindowDays(configs), `days ${JSON.stringify(configs)}`);
    assert.deepEqual(helpers.unionWindowBounds(configs, NOW), economyConstants.unionWindowBounds(configs, NOW), `bounds ${JSON.stringify(configs)}`);
  }
});

test('window: normalizeDays coerces like the (private) originals', () => {
  assert.equal(normalizeDays(null), null);
  assert.equal(normalizeDays(undefined), null);
  assert.equal(normalizeDays(0), 0);
  assert.equal(normalizeDays('12'), 12);
  assert.equal(normalizeDays(-1), null);
  assert.equal(normalizeDays('x'), null);
  assert.equal(normalizeDays(Infinity), null);
});

// ---------------------------------------------------------------------------
// 5. http-common — UA / delay / error / credential store
// ---------------------------------------------------------------------------

test('http-common: shared UA pool is the Economy superset and contains the NU pool', () => {
  assert.deepEqual([...USER_AGENT_POOL], [...economyService.USER_AGENT_POOL]);
  for (const ua of nuService.USER_AGENT_POOL) assert.ok(USER_AGENT_POOL.includes(ua), ua);
});

test('http-common: makePickUserAgent honors the env pin, else picks from the pool', () => {
  const KEY = 'BSTEST_USER_AGENT';
  const pick = makePickUserAgent(KEY);
  delete process.env[KEY];
  for (let i = 0; i < 20; i++) assert.ok(USER_AGENT_POOL.includes(pick()));
  process.env[KEY] = 'PinnedUA/1.0';
  try {
    assert.equal(pick(), 'PinnedUA/1.0');
  } finally {
    delete process.env[KEY];
  }
  const customPool = ['A/1', 'B/2'];
  const pick2 = makePickUserAgent(null, customPool);
  for (let i = 0; i < 10; i++) assert.ok(customPool.includes(pick2()));
});

test('http-common: randomDelay matches the original bounds semantics', () => {
  for (let i = 0; i < 50; i++) {
    const v = randomDelay(500, 1500);
    assert.ok(v >= 500 && v <= 1500, String(v));
  }
  assert.equal(randomDelay(100, 100), 100); // hi <= lo → lo
  assert.equal(randomDelay(200, 50), 200);  // hi clamped up to lo → lo
  assert.equal(randomDelay(-5, -1), 0);     // negatives clamp to 0
  assert.equal(randomDelay('x', 'y'), 0);   // non-numeric → 0
});

test('http-common: AuthExpiredError subclass keeps its own name for instanceof/grouping', () => {
  class BsTestAuthExpiredError extends AuthExpiredError {}
  const base = new AuthExpiredError();
  const sub = new BsTestAuthExpiredError('nope');
  assert.equal(base.name, 'AuthExpiredError');
  assert.equal(sub.name, 'BsTestAuthExpiredError');
  assert.ok(sub instanceof AuthExpiredError);
  assert.ok(sub instanceof Error);
});

test('http-common: credential store round-trips an encrypted {username,password} like the originals', async () => {
  class BsTestAuthExpiredError extends AuthExpiredError {}
  let rotatedTenant = null;
  const captured = {};
  const store = createCredentialStore({
    sourceSystem: 'BSTEST',
    sourceLabel: 'BSTest',
    logPrefix: '[bstest]',
    AuthError: BsTestAuthExpiredError,
    onRotated: (tenantId) => { rotatedTenant = tenantId; },
    prismaClient: {
      integrationCredential: {
        upsert: async (args) => { captured.upsert = args; return { id: 'cred-1' }; },
        findUnique: async () => ({ encryptedPayload: captured.upsert.create.encryptedPayload }),
        update: async (args) => { captured.update = args; return {}; },
      },
    },
  });

  await store.setCredentials('t1', { username: ' user ', password: 'p4ss' }, 'u9');
  assert.equal(rotatedTenant, 't1'); // cookie-jar nuke hook fired
  assert.deepEqual(captured.upsert.where, { tenantId_sourceSystem: { tenantId: 't1', sourceSystem: 'BSTEST' } });
  // Rotation resets the test status exactly like nu/economy setCredentials.
  assert.equal(captured.upsert.update.lastTestedAt, null);
  assert.equal(captured.upsert.update.lastTestStatus, null);
  // Payload decrypts to the trimmed username + raw password.
  assert.deepEqual(JSON.parse(decrypt(captured.upsert.create.encryptedPayload)), { username: 'user', password: 'p4ss' });

  const creds = await store.getCredentials('t1');
  assert.deepEqual(creds, { username: 'user', password: 'p4ss' });

  await store.recordTestStatus('t1', 'OK');
  assert.equal(captured.update.data.lastTestStatus, 'OK');
});

test('http-common: credential store error paths throw the source AuthError with the original messages', async () => {
  class BsTestAuthExpiredError extends AuthExpiredError {}
  const store = createCredentialStore({
    sourceSystem: 'BSTEST',
    sourceLabel: 'BSTest',
    logPrefix: '[bstest]',
    AuthError: BsTestAuthExpiredError,
    prismaClient: {
      integrationCredential: {
        findUnique: async ({ where }) => (
          where.tenantId_sourceSystem.tenantId === 'empty' ? { encryptedPayload: null } : null
        ),
        update: async () => { throw new Error('down'); },
      },
    },
  });
  await assert.rejects(() => store.getCredentials(null), (e) => (
    e instanceof BsTestAuthExpiredError && /tenantId required to load BSTest credentials/.test(e.message)
  ));
  await assert.rejects(() => store.getCredentials('missing'), /No IntegrationCredential row for tenant missing/);
  await assert.rejects(() => store.getCredentials('empty'), /encryptedPayload empty for tenant empty/);
  await assert.rejects(() => store.setCredentials('t1', { username: '', password: 'x' }), /username required/);
  await assert.rejects(() => store.setCredentials('t1', { username: 'x', password: '' }), /password required/);
  // recordTestStatus swallows DB errors (caller is already reporting).
  await store.recordTestStatus('t1', 'ERROR');
});

test('http-common: credentials resolver test seam bypasses the DB like the originals', async () => {
  const store = createCredentialStore({
    sourceSystem: 'BSTEST', sourceLabel: 'BSTest', logPrefix: '[bstest]',
    prismaClient: { integrationCredential: { findUnique: async () => { throw new Error('must not hit DB'); } } },
  });
  store.setCredentialsResolver(async () => ({ username: 'seam', password: 'pw' }));
  assert.deepEqual(await store.getCredentials('t1'), { username: 'seam', password: 'pw' });
  store.setCredentialsResolver(null);
  await assert.rejects(() => store.getCredentials('t1'), /must not hit DB/);
});

// ---------------------------------------------------------------------------
// 6. tl-international shims — same module objects, nothing forked
// ---------------------------------------------------------------------------

test('shims: tl-international promotion-matcher re-exports the booking-source functions identically', () => {
  assert.equal(tlMatcher.evaluatePromotion, bsMatcher.evaluatePromotion);
  assert.equal(tlMatcher.REVIEW_REASONS, bsMatcher.REVIEW_REASONS);
  assert.equal(tlMatcher.extractLocationCode, bsMatcher.extractLocationCode);
  assert.equal(tlMatcher.normalizePhone, bsMatcher.normalizePhone);
  assert.equal(tlMatcher.jaroWinkler, bsMatcher.jaroWinkler);
});

test('shims: tl-international duplicate-detector re-exports the booking-source function identically', () => {
  assert.equal(tlDetector.findDuplicateReservation, bsDetector.findDuplicateReservation);
});
