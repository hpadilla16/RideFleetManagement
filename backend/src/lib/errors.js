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

/**
 * Express error handler middleware — place after all routes in main.js.
 * Maps AppError subclasses to their status codes; everything else → 500.
 */
export function appErrorHandler(err, req, res, next) {
  if (err instanceof AppError) {
    return res.status(err.status).json({ error: err.message });
  }
  next(err);
}
