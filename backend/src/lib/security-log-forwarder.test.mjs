// Security-log forwarder — the SIEM audit-event shipper (2026-08-23).
//
// Proves the LOAD-BEARING properties from security-log-forwarder.js:
//   1. INERT when SECURITY_LOG_FORWARD_URL is unset — no fetch is ever attempted.
//   2. Batches: flushes on the size threshold AND on the timer (fake clock).
//   3. NEVER throws even when fetch rejects; the buffer is BOUNDED (drops +
//      logs a warning when full).
//   4. Forwards ONLY the already-redacted fields — a sensitive metadata key that
//      was NOT pre-redacted is not invented-away here, but the payload carries
//      exactly what it was handed (redaction is upstream, single source).
//   5. recordAudit still works and does NOT throw when the forwarder fails.
import test from 'node:test';
import assert from 'node:assert/strict';

import { createSecurityLogForwarder } from './security-log-forwarder.js';
import { redactSensitive } from './logger.js';

// A controllable fake clock: setTimeout stores the callback; tick() runs any
// due timers. Returns handle objects with an unref() so the module's
// `timer.unref?.()` path is exercised.
function makeClock() {
  let now = 0;
  const timers = [];
  return {
    now: () => now,
    setTimeout: (fn, ms) => {
      const h = { fn, at: now + ms, cleared: false, unref() { return h; } };
      timers.push(h);
      return h;
    },
    clearTimeout: (h) => { if (h) h.cleared = true; },
    // advance and fire everything due
    async tick(ms) {
      now += ms;
      for (const h of timers) {
        if (!h.cleared && h.at <= now) { h.cleared = true; h.fn(); }
      }
      // let any flush() microtasks settle
      await new Promise((r) => setImmediate(r));
    },
    pending: () => timers.filter((h) => !h.cleared).length,
  };
}

function makeFetch() {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url, opts, body: JSON.parse(opts.body) });
    return { status: 200 };
  };
  fn.calls = calls;
  return fn;
}

function makeLogger() {
  const warns = [];
  return { warns, warn: (...a) => warns.push(a), error: () => {}, info: () => {} };
}

const flush = () => new Promise((r) => setImmediate(r));

// ── 1. INERT when unconfigured ───────────────────────────────────────────────

test('inert when url is unset: enqueue is a no-op and NO fetch is attempted', async () => {
  const fetchImpl = makeFetch();
  const fwd = createSecurityLogForwarder({ url: undefined, fetch: fetchImpl });
  assert.equal(fwd.enabled, false);
  for (let i = 0; i < 50; i++) fwd.enqueue({ action: 'LOGIN', actorUserId: `u${i}` });
  await fwd.flush(); // explicit flush is also a no-op
  await flush();
  assert.equal(fetchImpl.calls.length, 0, 'no network call when inert');
  assert.equal(fwd._stats().buffered, 0, 'nothing was buffered');
  assert.equal(fwd._stats().hasTimer, false, 'no timer armed');
});

// ── 2a. Flush on the size threshold ──────────────────────────────────────────

test('flushes as ONE POST of a JSON array when the batch size is reached', async () => {
  const fetchImpl = makeFetch();
  const clock = makeClock();
  const fwd = createSecurityLogForwarder({
    url: 'https://ingest.example/logs', token: 'sekret-token',
    batchSize: 5, fetch: fetchImpl, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
  });
  for (let i = 0; i < 5; i++) fwd.enqueue({ action: 'LOGIN', actorUserId: `u${i}`, outcome: 'SUCCESS' });
  await flush();

  assert.equal(fetchImpl.calls.length, 1, 'exactly one POST for the batch');
  const call = fetchImpl.calls[0];
  assert.equal(call.opts.method, 'POST');
  assert.equal(call.opts.headers.authorization, 'Bearer sekret-token', 'bearer token set');
  assert.ok(Array.isArray(call.body), 'body is a JSON array');
  assert.equal(call.body.length, 5);
  assert.equal(call.body[0].action, 'LOGIN');
  assert.ok(call.body[0].timestamp, 'each event gets a timestamp');
  assert.equal(fwd._stats().buffered, 0, 'buffer drained after flush');
});

test('no Authorization header when no token configured', async () => {
  const fetchImpl = makeFetch();
  const clock = makeClock();
  const fwd = createSecurityLogForwarder({
    url: 'https://ingest.example/logs', batchSize: 1,
    fetch: fetchImpl, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
  });
  fwd.enqueue({ action: 'LOGOUT' });
  await flush();
  assert.equal(fetchImpl.calls.length, 1);
  assert.equal(fetchImpl.calls[0].opts.headers.authorization, undefined, 'no bearer header');
});

// ── 2b. Flush on the timer (below threshold) ─────────────────────────────────

test('flushes on the timer when the batch size is NOT reached', async () => {
  const fetchImpl = makeFetch();
  const clock = makeClock();
  const fwd = createSecurityLogForwarder({
    url: 'https://ingest.example/logs', batchSize: 20, flushIntervalMs: 5000,
    fetch: fetchImpl, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, now: () => String(clock.now()),
  });
  fwd.enqueue({ action: 'DSAR_EXPORT', actorUserId: 'admin-1' });
  fwd.enqueue({ action: 'DSAR_ERASE', actorUserId: 'admin-1' });
  assert.equal(fetchImpl.calls.length, 0, 'nothing sent before the timer fires');
  assert.equal(fwd._stats().hasTimer, true, 'a flush timer is armed');

  await clock.tick(5000); // timer fires
  assert.equal(fetchImpl.calls.length, 1, 'timer triggered a flush');
  assert.equal(fetchImpl.calls[0].body.length, 2);
});

// ── 3. Never throws on fetch rejection; buffer is bounded ─────────────────────

test('NEVER throws when fetch rejects, and drops the batch after bounded retries', async () => {
  const attempts = [];
  const rejectingFetch = async () => { attempts.push(1); throw new Error('network down'); };
  const clock = makeClock();
  const log = makeLogger();
  const fwd = createSecurityLogForwarder({
    url: 'https://ingest.example/logs', batchSize: 1, maxRetries: 2,
    fetch: rejectingFetch, logger: log, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
  });
  // enqueue triggers flush() fire-and-forget; must not throw synchronously
  assert.doesNotThrow(() => fwd.enqueue({ action: 'LOGIN' }));
  await flush();
  await flush();
  assert.equal(attempts.length, 3, 'first attempt + 2 retries');
  assert.equal(fwd._stats().buffered, 0, 'failed batch is DROPPED, not re-buffered');
  assert.ok(log.warns.some((w) => /flush failed after retries/.test(w[0])), 'the drop is logged at warn');
});

test('buffer is BOUNDED: past maxBuffer, events are dropped and the drop is logged', async () => {
  // A fetch that never resolves, so flushing stays "in flight" and the buffer
  // fills. maxBuffer=3, batchSize huge so the size-threshold flush never fires.
  let release;
  const hangingFetch = () => new Promise((r) => { release = r; });
  const clock = makeClock();
  const log = makeLogger();
  const fwd = createSecurityLogForwarder({
    url: 'https://ingest.example/logs', batchSize: 1000, maxBuffer: 3,
    fetch: hangingFetch, logger: log, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
  });
  for (let i = 0; i < 10; i++) fwd.enqueue({ action: 'LOGIN', actorUserId: `u${i}` });
  assert.ok(fwd._stats().buffered <= 3, `buffer capped at maxBuffer (got ${fwd._stats().buffered})`);
  assert.ok(fwd._stats().dropped >= 7, 'the excess events were counted as dropped');
  assert.ok(log.warns.some((w) => /buffer full/.test(w[0])), 'a buffer-full drop is logged');
  if (release) release({ status: 200 }); // let the hanging fetch settle
  await flush();
});

// ── 4. Forwards only the fields it is handed (redaction is upstream/reused) ───

test('payload carries only the whitelisted fields; upstream-redacted metadata passes through verbatim', async () => {
  const fetchImpl = makeFetch();
  const clock = makeClock();
  const fwd = createSecurityLogForwarder({
    url: 'https://ingest.example/logs', batchSize: 1,
    fetch: fetchImpl, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
  });

  // Simulate exactly what recordAudit hands us: metadata ALREADY run through the
  // shared redactor. The sensitive key must arrive masked (proving we forward
  // the redacted value, and do not carry a raw secret), and a stray top-level
  // field we don't whitelist must NOT appear.
  const safeMetadata = redactSensitive({ password: 'hunter2', role: 'ADMIN' });
  assert.equal(safeMetadata.password, '[redacted]', 'sanity: redactor masked it upstream');

  fwd.enqueue({
    action: 'USER_ROLE_CHANGE', actorUserId: 'admin-1', actorEmail: 'a@b.com', actorRole: 'ADMIN',
    tenantId: 't1', targetType: 'User', targetId: 'u9', ip: '1.2.3.4', userAgent: 'UA', outcome: 'SUCCESS',
    metadata: safeMetadata,
    rawRequestBody: { password: 'hunter2' }, // NOT whitelisted — must be dropped
  });
  await flush();

  const ev = fetchImpl.calls[0].body[0];
  assert.equal(ev.action, 'USER_ROLE_CHANGE');
  assert.equal(ev.metadata.password, '[redacted]', 'redacted metadata forwarded as-is (not un-redacted)');
  assert.equal(ev.metadata.role, 'ADMIN');
  assert.ok(!('rawRequestBody' in ev), 'non-whitelisted raw field is never forwarded');
  const flat = JSON.stringify(ev);
  assert.ok(!/hunter2/.test(flat), 'the raw secret never appears anywhere in the payload');
});

// ── 5. recordAudit integration: still works, never throws when forwarder fails ─

test('recordAudit still writes its row and does NOT throw when forwarding is inert/failing', async () => {
  // With env unset (the default in the test harness), the module-level default
  // forwarder is inert, so recordAudit's forward hook is a pure no-op.
  delete process.env.SECURITY_LOG_FORWARD_URL;
  const { recordAudit, AUDIT_ACTIONS } = await import('../modules/audit/audit.service.js');
  const rows = [];
  const fakePrisma = { adminAuditLog: { create: async ({ data }) => { rows.push(data); return data; } } };
  await assert.doesNotReject(
    recordAudit({ action: AUDIT_ACTIONS.LOGIN, actorUserId: 'u1' }, { prisma: fakePrisma }),
  );
  assert.equal(rows.length, 1, 'the audit row is still written');
  assert.equal(rows[0].action, 'LOGIN');
});
