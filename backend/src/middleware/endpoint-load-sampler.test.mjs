// PR-5 — Tests for endpoint-load-sampler middleware.
//
// Run: `node --test src/middleware/endpoint-load-sampler.test.mjs` from
// backend/. No Prisma client / DB required; the middleware accepts injected
// stubs and we feed it a fake request/response shaped just enough to drive
// the code path.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  endpointLoadSampler,
  normalizeRoute,
  getDefaultSampleRate,
} from './endpoint-load-sampler.js';

function makeStubPrisma() {
  const calls = [];
  let nextThrow = null;
  return {
    calls,
    setNextThrow(err) { nextThrow = err; },
    endpointLoadObservation: {
      async create({ data }) {
        if (nextThrow) {
          const e = nextThrow; nextThrow = null;
          throw e;
        }
        calls.push(data);
        return { id: `obs_${calls.length}`, ...data };
      },
    },
  };
}

function makeStubLogger() {
  const warns = [];
  return {
    warns,
    warn(msg, meta) { warns.push({ msg, meta }); },
    info() {},
  };
}

function makeReqRes({ route, baseUrl = '', originalUrl, method = 'GET', user, cacheHit, dbTimeMs } = {}) {
  const req = {
    method,
    originalUrl: originalUrl ?? (baseUrl + (route?.path ?? '/unknown')),
    path: route?.path ?? '/unknown',
    baseUrl,
    route,
    user,
    cacheHit,
    dbTimeMs,
  };
  const res = new EventEmitter();
  res.statusCode = 200;
  return { req, res };
}

// Helper: wait one macrotask so the fire-and-forget promise chain resolves.
async function flushMicro() {
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
}

describe('endpointLoadSampler', () => {
  it('skips entirely when sample rate is 0', async () => {
    const prisma = makeStubPrisma();
    const logger = makeStubLogger();
    const mw = endpointLoadSampler({ prisma, logger, sampleRate: 0, random: () => 0 });

    const { req, res } = makeReqRes({ route: { path: '/api/x' } });
    let nextCalled = false;
    mw(req, res, () => { nextCalled = true; });
    res.emit('finish');
    await flushMicro();

    assert.equal(nextCalled, true);
    assert.equal(prisma.calls.length, 0, 'no inserts when rate=0');
    // When rate=0 the middleware short-circuits and never attaches a finish listener.
    assert.equal(res.listenerCount('finish'), 0, 'no finish listener was attached');
  });

  it('always fires when sample rate is 1', async () => {
    const prisma = makeStubPrisma();
    const logger = makeStubLogger();
    const mw = endpointLoadSampler({
      prisma, logger, sampleRate: 1, random: () => 0.999999,
    });

    const { req, res } = makeReqRes({
      route: { path: '/api/reservations/:id' },
      baseUrl: '',
      method: 'PATCH',
      user: { tenantId: 'tnt_42' },
    });
    res.statusCode = 204;

    mw(req, res, () => {});
    res.emit('finish');
    await flushMicro();

    assert.equal(prisma.calls.length, 1);
    const row = prisma.calls[0];
    assert.equal(row.method, 'PATCH');
    assert.equal(row.statusCode, 204);
    assert.equal(row.tenantId, 'tnt_42');
    assert.equal(row.route, '/api/reservations/:id');
    assert.equal(typeof row.durationMs, 'number');
  });

  it('captures route normalization with baseUrl + route.path', async () => {
    const prisma = makeStubPrisma();
    const logger = makeStubLogger();
    const mw = endpointLoadSampler({ prisma, logger, sampleRate: 1 });

    const { req, res } = makeReqRes({
      route: { path: '/:id' },
      baseUrl: '/api/customers',
      originalUrl: '/api/customers/abc123',
    });

    mw(req, res, () => {});
    res.emit('finish');
    await flushMicro();

    assert.equal(prisma.calls.length, 1);
    assert.equal(prisma.calls[0].route, '/api/customers/:id');
  });

  it('normalizeRoute falls back to originalUrl (sans query) when no router matched', () => {
    const r = normalizeRoute({ originalUrl: '/api/unknown/path?foo=1&bar=2', path: '/api/unknown/path' });
    assert.equal(r, '/api/unknown/path');
  });

  it('null tenantId when req.user is absent (public/anonymous request)', async () => {
    const prisma = makeStubPrisma();
    const logger = makeStubLogger();
    const mw = endpointLoadSampler({ prisma, logger, sampleRate: 1 });

    const { req, res } = makeReqRes({ route: { path: '/api/public/booking' } });
    mw(req, res, () => {});
    res.emit('finish');
    await flushMicro();

    assert.equal(prisma.calls.length, 1);
    assert.equal(prisma.calls[0].tenantId, null);
  });

  it('does not throw if Prisma insert fails — warns instead', async () => {
    const prisma = makeStubPrisma();
    const logger = makeStubLogger();
    prisma.setNextThrow(new Error('connection refused'));
    const mw = endpointLoadSampler({ prisma, logger, sampleRate: 1 });

    const { req, res } = makeReqRes({ route: { path: '/api/x' } });
    mw(req, res, () => {});
    // Emit finish — must not throw even though the insert will reject.
    assert.doesNotThrow(() => res.emit('finish'));
    await flushMicro();

    assert.equal(prisma.calls.length, 0, 'failed insert did not record');
    assert.equal(logger.warns.length, 1, 'one warn logged');
    assert.match(logger.warns[0].msg, /insert failed/);
    assert.equal(logger.warns[0].meta.error, 'connection refused');
  });

  it('does not block the response — res.emit("finish") returns before the INSERT resolves', async () => {
    let resolveInsert;
    const prisma = {
      endpointLoadObservation: {
        create: () => new Promise((r) => { resolveInsert = r; }),
      },
    };
    const logger = makeStubLogger();
    const mw = endpointLoadSampler({ prisma, logger, sampleRate: 1 });

    const { req, res } = makeReqRes({ route: { path: '/api/x' } });
    mw(req, res, () => {});

    const t0 = Date.now();
    res.emit('finish');
    const elapsed = Date.now() - t0;
    // The emit itself must return synchronously; the still-pending INSERT
    // promise must not block.
    assert.ok(elapsed < 25, `res.emit returned in ${elapsed}ms while INSERT pending`);

    // Finalize the promise so node --test doesn't complain about open handles.
    resolveInsert?.({ id: 'ok' });
    await flushMicro();
  });

  it('parses ENDPOINT_LOAD_SAMPLE_RATE env to a float, clamps to [0,1]', () => {
    const prev = process.env.ENDPOINT_LOAD_SAMPLE_RATE;
    try {
      process.env.ENDPOINT_LOAD_SAMPLE_RATE = '0.25';
      assert.equal(getDefaultSampleRate(), 0.25);
      process.env.ENDPOINT_LOAD_SAMPLE_RATE = '-1';
      assert.equal(getDefaultSampleRate(), 0);
      process.env.ENDPOINT_LOAD_SAMPLE_RATE = '2';
      assert.equal(getDefaultSampleRate(), 1);
      process.env.ENDPOINT_LOAD_SAMPLE_RATE = 'garbage';
      assert.equal(getDefaultSampleRate(), 0.01);
      delete process.env.ENDPOINT_LOAD_SAMPLE_RATE;
      assert.equal(getDefaultSampleRate(), 0.01);
    } finally {
      if (prev === undefined) delete process.env.ENDPOINT_LOAD_SAMPLE_RATE;
      else process.env.ENDPOINT_LOAD_SAMPLE_RATE = prev;
    }
  });

  it('records dbTimeMs and cacheHit when present on req', async () => {
    const prisma = makeStubPrisma();
    const logger = makeStubLogger();
    const mw = endpointLoadSampler({ prisma, logger, sampleRate: 1 });

    const { req, res } = makeReqRes({
      route: { path: '/api/x' },
      dbTimeMs: 42.7,
      cacheHit: true,
    });
    mw(req, res, () => {});
    res.emit('finish');
    await flushMicro();

    assert.equal(prisma.calls[0].dbTimeMs, 43, 'rounded');
    assert.equal(prisma.calls[0].cacheHit, true);
  });
});
