import * as Sentry from '@sentry/browser';

let sentryInitialized = false;

function parseSampleRate(value, fallback = 0) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  if (parsed > 1) return 1;
  return parsed;
}

export function isClientSentryEnabled() {
  return Boolean(process.env.NEXT_PUBLIC_SENTRY_DSN);
}

// Self-contained scrubber (GDPR / TL due diligence, 2026-08-22). The frontend
// bundle can't import the backend's redactor, so this mirrors its intent: strip
// PII by key name and truncate base64/data-URL image blobs. Kept deliberately
// small — the browser SDK's real risk is breadcrumbs (fetch URLs, DOM, console)
// and the odd customer field passed as context, not deep object trees.
const CLIENT_REDACT_KEYS = new Set([
  'firstname', 'lastname', 'phone', 'email', 'dob', 'dateofbirth',
  'licensenumber', 'license', 'cardonfiletoken', 'ssn', 'password', 'token'
]);
const CLIENT_DATA_URL_RE = /^data:[^;,]*;base64,/i;
const CLIENT_BARE_BASE64_RE = /^[A-Za-z0-9+/=\s]{512,}$/;

function clientRedactString(value) {
  if (typeof value !== 'string') return value;
  if (CLIENT_DATA_URL_RE.test(value) || CLIENT_BARE_BASE64_RE.test(value)) {
    return `[base64 ${value.length} bytes redacted]`;
  }
  return value;
}

function clientRedact(value, depth = 0) {
  if (depth > 6 || value == null) return value;
  if (typeof value === 'string') return clientRedactString(value);
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => clientRedact(v, depth + 1));
  const out = {};
  for (const [key, val] of Object.entries(value)) {
    out[key] = CLIENT_REDACT_KEYS.has(key.toLowerCase())
      ? (val == null ? val : '[redacted]')
      : clientRedact(val, depth + 1);
  }
  return out;
}

function scrubClientEvent(event) {
  if (!event || typeof event !== 'object') return event;
  try {
    if (event.extra) event.extra = clientRedact(event.extra);
    if (event.contexts) event.contexts = clientRedact(event.contexts);
    if (event.tags) event.tags = clientRedact(event.tags);
    if (event.user) event.user = clientRedact(event.user);
    if (Array.isArray(event.exception?.values)) {
      for (const ex of event.exception.values) {
        if (typeof ex?.value === 'string') ex.value = clientRedactString(ex.value);
      }
    }
    if (typeof event.message === 'string') event.message = clientRedactString(event.message);
    if (Array.isArray(event.breadcrumbs)) {
      for (const crumb of event.breadcrumbs) {
        if (crumb?.data) crumb.data = clientRedact(crumb.data);
      }
    }
  } catch {
    // Never let scrubbing suppress the report.
  }
  return event;
}

export function initClientSentry() {
  if (sentryInitialized || typeof window === 'undefined' || !isClientSentryEnabled()) return;

  Sentry.init({
    dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
    environment: process.env.NEXT_PUBLIC_SENTRY_ENV || process.env.NODE_ENV || 'development',
    release: process.env.NEXT_PUBLIC_SENTRY_RELEASE || undefined,
    tracesSampleRate: parseSampleRate(process.env.NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE, 0),
    sendDefaultPii: false,
    maxValueLength: 2000,
    beforeSend: scrubClientEvent
  });

  sentryInitialized = true;
}

export function captureClientException(error, context = {}) {
  if (!isClientSentryEnabled()) return;
  initClientSentry();
  Sentry.withScope((scope) => {
    Object.entries(context || {}).forEach(([key, value]) => {
      if (value === undefined) return;
      if (value && typeof value === 'object') {
        scope.setContext(key, value);
        return;
      }
      scope.setExtra(key, value);
    });
    Sentry.captureException(error);
  });
}
