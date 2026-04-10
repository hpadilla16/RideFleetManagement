import winston from 'winston';
import crypto from 'crypto';

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
      const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';
      logger.log(level, `${method} ${originalUrl} ${res.statusCode} ${duration}ms`, {
        requestId: req.requestId,
        method,
        path: originalUrl,
        status: res.statusCode,
        duration,
        ip: req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip,
        userAgent: req.headers['user-agent']?.slice(0, 120),
        userId: req.user?.id || req.user?.sub || undefined,
        tenantId: req.user?.tenantId || undefined,
      });
    });

    next();
  };
}
