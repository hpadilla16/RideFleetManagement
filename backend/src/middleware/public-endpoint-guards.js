const rateLimitBuckets = new Map();
const idempotencyBuckets = new Map();

function nowMs() {
  return Date.now();
}

function requestIp(req) {
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return forwarded || req.ip || req.socket?.remoteAddress || 'unknown';
}

function cleanupExpired(map, currentTime) {
  for (const [key, entry] of map.entries()) {
    if (!entry || Number(entry.expiresAt || 0) <= currentTime) {
      map.delete(key);
    }
  }
}

export function attachPublicRequestMeta(name = 'public-endpoint') {
  return (req, _res, next) => {
    req.publicRequestMeta = {
      name,
      ip: requestIp(req),
      startedAt: new Date().toISOString()
    };
    next();
  };
}

export function createPublicRateLimitGuard(options = {}) {
  const name = String(options?.name || 'public-endpoint');
  const windowMs = Number.isFinite(options?.windowMs) ? options.windowMs : 60 * 1000;
  const maxRequests = Number.isFinite(options?.maxRequests) ? options.maxRequests : 60;

  return (req, res, next) => {
    // CI / test bypass: when RATE_LIMIT_DISABLED=1 the guard becomes a passthrough.
    // Never set this in production — it removes the brute-force protection on auth endpoints.
    if (process.env.RATE_LIMIT_DISABLED === '1') return next();
    const currentTime = nowMs();
    cleanupExpired(rateLimitBuckets, currentTime);
    const bucketKey = `${name}:${requestIp(req)}`;
    const existing = rateLimitBuckets.get(bucketKey);
    const bucket = existing && existing.expiresAt > currentTime
      ? existing
      : { count: 0, expiresAt: currentTime + windowMs };
    bucket.count += 1;
    rateLimitBuckets.set(bucketKey, bucket);

    const remaining = Math.max(0, maxRequests - bucket.count);
    res.setHeader('x-public-rate-limit-window-ms', String(windowMs));
    res.setHeader('x-public-rate-limit-limit', String(maxRequests));
    res.setHeader('x-public-rate-limit-remaining', String(remaining));

    if (bucket.count > maxRequests) {
      return res.status(429).json({
        error: `Rate limit exceeded for ${name}. Try again shortly.`
      });
    }

    next();
  };
}

export function createOptionalIdempotencyGuard(options = {}) {
  const name = String(options?.name || 'public-endpoint');
  const windowMs = Number.isFinite(options?.windowMs) ? options.windowMs : 10 * 60 * 1000;

  return (req, res, next) => {
    const headerValue = String(
      req.get('x-idempotency-key')
      || req.get('idempotency-key')
      || ''
    ).trim();
    if (!headerValue) return next();

    const currentTime = nowMs();
    cleanupExpired(idempotencyBuckets, currentTime);
    const bucketKey = `${name}:${requestIp(req)}:${headerValue}`;
    const existing = idempotencyBuckets.get(bucketKey);
    if (existing && existing.expiresAt > currentTime) {
      return res.status(409).json({
        error: `Duplicate idempotency key detected for ${name}.`
      });
    }

    idempotencyBuckets.set(bucketKey, {
      expiresAt: currentTime + windowMs
    });
    next();
  };
}

