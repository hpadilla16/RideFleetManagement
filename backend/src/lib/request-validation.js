function toTrimmedString(value) {
  if (value == null) return '';
  return String(value).trim();
}

// Bad-input errors carry a 400 so the global error handler returns 400 (not an
// opaque 500) for every endpoint that uses these shared validators (DAST
// 2026-08-23: e.g. /public/booking/vehicle-classes with a junk `limit` 500'd
// because the plain Error had no status). The message is caller-safe (it names
// the request field, never anything internal).
function badRequest(message) {
  const e = new Error(message);
  e.status = 400;
  return e;
}

export function requireString(value, label, options = {}) {
  const minLength = Number.isFinite(options?.minLength) ? options.minLength : 1;
  const normalized = toTrimmedString(value);
  if (!normalized || normalized.length < minLength) {
    throw badRequest(`${label} is required`);
  }
  return normalized;
}

export function optionalString(value, options = {}) {
  const normalized = toTrimmedString(value);
  if (!normalized) return options?.fallback ?? null;
  return normalized;
}

export function optionalBoolean(value, fallback = null) {
  if (value == null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  const normalized = String(value).trim().toLowerCase();
  if (['true', '1', 'yes', 'y', 'on'].includes(normalized)) return true;
  if (['false', '0', 'no', 'n', 'off'].includes(normalized)) return false;
  throw badRequest('boolean value is invalid');
}

export function optionalNumber(value, label = 'number', options = {}) {
  if (value == null || value === '') return options?.fallback ?? null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw badRequest(`${label} must be a valid number`);
  if (options?.integer && !Number.isInteger(parsed)) throw badRequest(`${label} must be a whole number`);
  if (Number.isFinite(options?.min) && parsed < options.min) throw badRequest(`${label} must be at least ${options.min}`);
  if (Number.isFinite(options?.max) && parsed > options.max) throw badRequest(`${label} must be at most ${options.max}`);
  return parsed;
}

export function assertEnum(value, label, allowedValues = []) {
  const normalized = requireString(value, label).toUpperCase();
  const allowed = new Set((allowedValues || []).map((item) => String(item).trim().toUpperCase()).filter(Boolean));
  if (!allowed.has(normalized)) {
    throw badRequest(`${label} is invalid`);
  }
  return normalized;
}

export function assertPlainObject(value, label = 'payload') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw badRequest(`${label} must be an object`);
  }
  return value;
}

export function requireDateRange(input = {}, options = {}) {
  const startKey = options?.startKey || 'start';
  const endKey = options?.endKey || 'end';
  const startLabel = options?.startLabel || startKey;
  const endLabel = options?.endLabel || endKey;
  const startValue = requireString(input?.[startKey], startLabel);
  const endValue = requireString(input?.[endKey], endLabel);
  const start = new Date(startValue);
  const end = new Date(endValue);
  if (Number.isNaN(start.getTime())) throw new Error(`${startLabel} must be a valid date`);
  if (Number.isNaN(end.getTime())) throw new Error(`${endLabel} must be a valid date`);
  if (end <= start) throw new Error(`${endLabel} must be later than ${startLabel}`);
  return { start, end };
}

