import winston from 'winston';
import crypto from 'crypto';
import * as Sentry from '@sentry/node';

// Threshold above which a request is considered slow. The request still
// completes normally; we just upgrade the log line to `warn` and drop a
// Sentry breadcrumb so we can correlate with traces.
const SLOW_REQUEST_MS = parseInt(process.env.SLOW_REQUEST_MS || '1000', 10);

const { combine, timestamp, json, printf, colorize } = winston.format;

const isProduction = process.env.NODE_ENV === 'production';

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || (isProduction ? 'info' : 'debug'),
  defaultMeta: { service: 'fleet-management-backend' },
  format: combine(
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
