function toTrimmedString(value) {
  if (value == null) return '';
  return String(value).trim();
}

export function requireString(value, label, options = {}) {
  const minLength = Number.isFinite(options?.minLength) ? options.minLength : 1;
  const normalized = toTrimmedString(value);
  if (!normalized || normalized.length < minLength) {
    throw new Error(`${label} is required`);
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
  throw new Error('boolean value is invalid');
}

export function optionalNumber(value, label = 'number', options = {}) {
  if (value == null || value === '') return options?.fallback ?? null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${label} must be a valid number`);
  if (options?.integer && !Number.isInteger(parsed)) throw new Error(`${label} must be a whole number`);
  if (Number.isFinite(options?.min) && parsed < options.min) throw new Error(`${label} must be at least ${options.min}`);
  if (Number.isFinite(options?.max) && parsed > options.max) throw new Error(`${label} must be at most ${options.max}`);
  return parsed;
}

export function assertEnum(value, label, allowedValues = []) {
  const normalized = requireString(value, label).toUpperCase();
  const allowed = new Set((allowedValues || []).map((item) => String(item).trim().toUpperCase()).filter(Boolean));
  if (!allowed.has(normalized)) {
    throw new Error(`${label} is invalid`);
  }
  return normalized;
}

export function assertPlainObject(value, label = 'payload') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
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

