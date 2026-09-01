/**
 * Typed error classes for consistent HTTP status code mapping in route handlers.
 *
 * Usage in routes:
 *   } catch (e) {
 *     if (e instanceof AppError) return res.status(e.status).json({ error: e.message });
 *     next(e); // → global 500 handler
 *   }
 */

export class AppError extends Error {
  constructor(message, status = 500) {
    super(message);
    this.name = this.constructor.name;
    this.status = status;
  }
}

/** 400 — malformed input or business rule violation */
export class ValidationError extends AppError {
  constructor(message) { super(message, 400); }
}

/** 404 — resource not found */
export class NotFoundError extends AppError {
  constructor(message = 'Not found') { super(message, 404); }
}

/** 409 — state conflict (duplicate, double-booking, etc.) */
export class ConflictError extends AppError {
  constructor(message) { super(message, 409); }
}

/** 403 — authenticated but not authorized */
export class ForbiddenError extends AppError {
  constructor(message = 'Forbidden') { super(message, 403); }
}

/** 503 — backing service (DB pool, queue, etc.) temporarily unavailable */
export class ServiceUnavailableError extends AppError {
  constructor(message = 'Service temporarily unavailable', retryAfterSeconds = 5) {
    super(message, 503);
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/**
 * Detect Prisma P2024 (connection pool timeout). Prisma exposes `.code` on
 * PrismaClientKnownRequestError, but in some wrappers it surfaces only via
 * the message string — match both shapes defensively.
 */
function isPoolTimeoutError(err) {
  if (!err) return false;
  if (err.code === 'P2024') return true;
  const msg = typeof err.message === 'string' ? err.message : '';
  return /\bP2024\b/.test(msg) || /Timed out fetching a new connection from the connection pool/i.test(msg);
}

/**
 * Express error handler middleware — place after all routes in main.js.
 * Maps AppError subclasses to their status codes; Prisma P2024 (pool
 * exhausted) → 503 with `Retry-After`; everything else → 500.
 */
export function appErrorHandler(err, req, res, next) {
  if (err instanceof ServiceUnavailableError) {
    res.set('Retry-After', String(err.retryAfterSeconds));
    return res.status(503).json({ error: err.message, retryAfterSeconds: err.retryAfterSeconds });
  }
  if (err instanceof AppError) {
    // Additive (2026-09-01): subclasses that carry a machine code (e.g.
    // CustomerEmailError -> CUSTOMER_EMAIL_INVALID) surface it so the UI can
    // highlight the offending field instead of parsing English. Errors without
    // a `code` produce the exact same body as before.
    return res.status(err.status).json({
      error: err.message,
      ...(err.code ? { code: err.code } : {})
    });
  }
  if (isPoolTimeoutError(err)) {
    res.set('Retry-After', '5');
    return res.status(503).json({
      error: 'Database is temporarily saturated. Please retry shortly.',
      retryAfterSeconds: 5,
      code: 'P2024'
    });
  }
  next(err);
}
