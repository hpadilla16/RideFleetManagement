import winston from 'winston';
import crypto from 'crypto';
import * as Sentry from '@sentry/node';

// Threshold above which a request is considered slow. The request still
// completes normally; we just upgrade the log line to `warn` and drop a
// Sentry breadcrumb so we can correlate with traces.
const SLOW_REQUEST_MS = parseInt(process.env.SLOW_REQUEST_MS || '1000', 10);

const { combine, timestamp, json, printf, colorize } = winston.format;

const isProduction = process.env.NODE_ENV === 'production';

// beta.116 PII-log hardening ────────────────────────────────────────────────
// Production logs were leaking customer PII (name, phone, DOB, driver license)
// and full base64 inspection-photo payloads. This redaction layer masks
// sensitive fields and truncates any base64 / data-URL image blob before the
// meta object is serialized to a log line. Applied as a Winston format so it
// covers every `logger.*(msg, meta)` call regardless of the call site.

// Case-insensitive set of meta keys whose VALUES must never be logged in clear.
const REDACT_KEYS = new Set([
  'firstname', 'lastname', 'phone', 'email', 'dob', 'dateofbirth',
  'licensenumber', 'license', 'cardonfiletoken', 'ssn', 'password'
]);

// 2026-06-10 — `name` used to live in REDACT_KEYS unconditionally, which
// over-redacted non-PII names (vehicle { name: "Toyota Corolla" }, tenant
// { name: "International" }, location names...) and made prod logs harder to
// read. A bare `name`/`fullname` key is only PII when the surrounding object
// looks like a PERSON — i.e. it carries another person-identifying key. So we
// redact name/fullname conditionally on that context instead.
const NAME_KEYS = new Set(['name', 'fullname']);
const PERSON_CONTEXT_KEYS = new Set([
  'firstname', 'lastname', 'phone', 'email', 'dob', 'dateofbirth',
  'licensenumber', 'license', 'driverlicense', 'ssn', 'customerid', 'guestid'
]);

function hasPersonContext(keys) {
  return keys.some((k) => PERSON_CONTEXT_KEYS.has(k.toLowerCase()));
}

const REDACTED = '[redacted]';
// Matches a data: URL (e.g. "data:image/jpeg;base64,...") or a long bare
// base64 blob (the inspection wizard posts raw base64 too).
const DATA_URL_RE = /^data:[^;,]*;base64,/i;
const BARE_BASE64_RE = /^[A-Za-z0-9+/=\s]{512,}$/;

function redactString(value) {
  if (typeof value !== 'string') return value;
  if (DATA_URL_RE.test(value) || BARE_BASE64_RE.test(value)) {
    return `[base64 image ${value.length} bytes redacted]`;
  }
  return value;
}

/**
 * Recursively redact sensitive fields and base64/data-URL image payloads from
 * an arbitrary value (object/array/string). Returns a sanitized copy; never
 * mutates the input. Depth-bounded to avoid pathological/circular structures.
 */
export function redactSensitive(value, depth = 0, seen = new WeakSet()) {
  if (depth > 8 || value == null) return value;
  if (typeof value === 'string') return redactString(value);
  if (typeof value !== 'object') return value;
  if (seen.has(value)) return '[circular]';
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => redactSensitive(item, depth + 1, seen));
  }

  const out = {};
  const personContext = hasPersonContext(Object.keys(value));
  for (const [key, val] of Object.entries(value)) {
    const keyLower = key.toLowerCase();
    if (REDACT_KEYS.has(keyLower) || (personContext && NAME_KEYS.has(keyLower))) {
      out[key] = val == null ? val : REDACTED;
    } else {
      out[key] = redactSensitive(val, depth + 1, seen);
    }
  }
  return out;
}

// Winston format that runs the redactor over each log entry's meta fields.
// NOTE: winston.format IS the factory function itself (combine/json/etc. are
// properties hanging off it) — destructuring `format` from it yields undefined.
const redactFormat = winston.format((info) => {
  const topLevelPersonContext = hasPersonContext(Object.keys(info));
  for (const key of Object.keys(info)) {
    // Leave winston's own structural fields untouched; sanitize the rest.
    if (key === 'level' || key === 'message' || key === 'timestamp') continue;
    // Key-based redaction must apply at the TOP level of the meta too, not
    // only to nested objects inside redactSensitive.
    const keyLower = key.toLowerCase();
    if (REDACT_KEYS.has(keyLower) || (topLevelPersonContext && NAME_KEYS.has(keyLower))) {
      info[key] = info[key] == null ? info[key] : REDACTED;
      continue;
    }
    info[key] = redactSensitive(info[key]);
  }
  // The human-readable message itself can carry an inlined data URL.
  if (typeof info.message === 'string') info.message = redactString(info.message);
  return info;
});

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || (isProduction ? 'info' : 'debug'),
  defaultMeta: { service: 'fleet-management-backend' },
  format: combine(
    redactFormat(), // beta.116: strip PII + base64 image payloads from meta
    timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
    json()
  ),
  transports: [
    new winston.transports.Console({
      format: isProduction
        ? combine(timestamp(), json())
        : combine(colorize(), timestamp({ format: 'HH:mm:ss' }), printf(({ level, message, timestamp, requestId, ...rest }) => {
            const rid = requestId ? ` [${requestId}]` : '';
            const extra = Object.keys(rest).length > 2 ? ` ${JSON.stringify(rest)}` : '';
            return `${timestamp} ${level}${rid}: ${message}${extra}`;
          }))
    })
  ]
});

export default logger;

/**
 * Generate a short request ID.
 */
export function generateRequestId() {
  return crypto.randomBytes(6).toString('hex');
}

/**
 * Express middleware that attaches a request ID and logs request/response.
 */
export function requestLogger() {
  return (req, res, next) => {
    req.requestId = req.headers['x-request-id'] || generateRequestId();
    res.setHeader('x-request-id', req.requestId);

    const start = Date.now();
    const { method, originalUrl } = req;

    res.on('finish', () => {
      const duration = Date.now() - start;
      const slow = SLOW_REQUEST_MS > 0 && duration > SLOW_REQUEST_MS;
      // 5xx => error, 4xx OR slow => warn, else info
      const level = res.statusCode >= 500
        ? 'error'
        : res.statusCode >= 400 || slow
          ? 'warn'
          : 'info';
      const message = slow
        ? `${method} ${originalUrl} ${res.statusCode} ${duration}ms (slow >${SLOW_REQUEST_MS}ms)`
        : `${method} ${originalUrl} ${res.statusCode} ${duration}ms`;
      logger.log(level, message, {
        requestId: req.requestId,
        method,
        path: originalUrl,
        status: res.statusCode,
        duration,
        slow: slow || undefined,
        ip: req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip,
        userAgent: req.headers['user-agent']?.slice(0, 120),
        userId: req.user?.id || req.user?.sub || undefined,
        tenantId: req.user?.tenantId || undefined,
      });

      // Drop a Sentry breadcrumb on slow requests so they show up alongside
      // any subsequent error from the same session. No-ops if Sentry isn't
      // initialized (DSN unset in dev/CI).
      if (slow) {
        try {
          Sentry.addBreadcrumb({
            category: 'http.slow',
            level: 'warning',
            message,
            data: {
              method,
              path: originalUrl,
              status: res.statusCode,
              durationMs: duration,
              tenantId: req.user?.tenantId || undefined,
              userId: req.user?.id || req.user?.sub || undefined
            }
          });
        } catch {
          // Sentry breadcrumbs are best-effort; never let them break the request.
        }
      }
    });

    next();
  };
}
