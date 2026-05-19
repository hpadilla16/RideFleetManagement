// PR-5 — Endpoint-load sampling middleware.
//
// Wraps every request and, at a configurable sample rate (default 1%), records
// a row into `EndpointLoadObservation`. Writes are fire-and-forget so a
// Prisma/network error never breaks production traffic.
//
// Wired into `backend/src/main.js` EARLY in the chain (after request-id logger,
// before auth) so it captures even unauthenticated requests. Because auth runs
// AFTER this middleware, we read `req.user?.tenantId` inside `res.on('finish')`
// — by then the auth middleware will have populated it if the request was
// authenticated. Unauthenticated/public requests stay as `tenantId = null`.
//
// Optional per-request signals (set elsewhere by other middleware/handlers):
//   - `req.dbTimeMs`  — accumulated Prisma time in ms (number)
//   - `req.cacheHit`  — boolean; `null/undefined` for endpoints that don't
//                       use the cache layer
//
// Env:
//   ENDPOINT_LOAD_SAMPLE_RATE   float in [0, 1], default "0.01"
//
// The factory takes a `{ prisma, logger, sampleRate, random }` bag so tests
// can stub everything; production callers pass nothing. Defaults are loaded
// lazily so unit tests that pass full overrides don't need `@prisma/client`
// installed.

function parseSampleRate(raw) {
  const n = Number.parseFloat(raw);
  if (!Number.isFinite(n)) return 0.01;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

export function getDefaultSampleRate() {
  return parseSampleRate(process.env.ENDPOINT_LOAD_SAMPLE_RATE ?? '0.01');
}

// Build the normalized route string. Prefer Express's matched-route pattern
// (`req.route.path`) plus the router's `baseUrl` mount path so that we end up
// with strings like "/api/reservations/:id" rather than the literal
// "/api/reservations/abc123". Fall back to the originalUrl (sans query) when
// no router matched the request (e.g. 404s).
export function normalizeRoute(req) {
  if (req?.route?.path) {
    return `${req.baseUrl || ''}${req.route.path}`;
  }
  const raw = req?.originalUrl || req?.path || '';
  return String(raw).split('?')[0];
}

async function loadDefaultPrisma() {
  const mod = await import('../lib/prisma.js');
  return mod.prisma;
}

async function loadDefaultLogger() {
  const mod = await import('../lib/logger.js');
  return mod.default;
}

export function endpointLoadSampler({
  prisma,
  logger,
  sampleRate,
  random = Math.random,
} = {}) {
  const rate = typeof sampleRate === 'number' ? sampleRate : getDefaultSampleRate();

  // Lazy default resolution: only pay the prisma/logger import cost if the
  // caller didn't inject overrides (i.e. production wiring). Tests that pass
  // both stubs never touch the real modules.
  let prismaPromise = prisma
    ? Promise.resolve(prisma)
    : loadDefaultPrisma();
  let loggerPromise = logger
    ? Promise.resolve(logger)
    : loadDefaultLogger();

  return function endpointLoadSamplerMiddleware(req, res, next) {
    if (rate <= 0) return next();
    const sampled = rate >= 1 ? true : random() < rate;
    if (!sampled) return next();

    const start = Date.now();
    const method = req.method;

    res.on('finish', () => {
      const durationMs = Date.now() - start;

      // Capture tenantId LATE — auth middleware runs after us, so by the time
      // 'finish' fires it has populated req.user for authenticated routes.
      const tenantId = req.user?.tenantId ?? null;
      const route = normalizeRoute(req);
      const dbTimeMs = typeof req.dbTimeMs === 'number' ? Math.round(req.dbTimeMs) : null;
      const cacheHit = typeof req.cacheHit === 'boolean' ? req.cacheHit : null;

      const data = {
        tenantId,
        method,
        route,
        statusCode: res.statusCode,
        durationMs,
        dbTimeMs,
        cacheHit,
      };

      // Fire-and-forget. Telemetry must never break a request.
      Promise.all([prismaPromise, loggerPromise])
        .then(([db, log]) =>
          db.endpointLoadObservation
            .create({ data })
            .catch((err) => {
              try {
                log.warn?.('endpoint-load-sampler insert failed', {
                  error: err?.message || String(err),
                  route,
                  method,
                });
              } catch {
                // swallow — never let logger blow up the process
              }
            })
        )
        .catch(() => {
          // dependency load itself failed; nothing we can do safely
        });
    });

    next();
  };
}

export default endpointLoadSampler;
