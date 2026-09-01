import * as Sentry from '@sentry/node';
import { redactSensitive } from './logger.js';
// redactSensitive() handles strings too (it delegates to the internal
// string-redactor for a bare string), so one import covers both the structured
// bags and the free-text message/exception values below.
const redactString = (v) => redactSensitive(v);

let sentryInitialized = false;

function parseSampleRate(value, fallback = 0) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  if (parsed > 1) return 1;
  return parsed;
}

export function isSentryEnabled() {
  return Boolean(process.env.SENTRY_DSN);
}

/**
 * Scrub an outgoing Sentry event before it leaves the process.
 *
 * WHY (GDPR / TL due diligence, 2026-08-22): the Winston redactor never saw
 * Sentry, so a Prisma validation error — which renders the offending argument
 * object INTO its message — could post a customer's name, email or phone to a
 * US error-monitoring service, unredacted. This closes that path by reusing
 * the SAME, already-tested redactor the logs use.
 *
 * Two kinds of scrubbing, because a Sentry event mixes both:
 *  - structured bags (extra, contexts, tags, user, breadcrumb data) are
 *    objects, so redactSensitive() strips them by key exactly as for logs
 *    (a bare `id` survives — useful for triage — while email/phone/etc do not);
 *  - the exception message and event.message are free strings, so we run
 *    redactString() (kills base64 blobs) and hard-cap the length. Combined with
 *    maxValueLength in init(), a giant argument dump cannot ride out in full.
 * We also drop request body, cookies and the Authorization header outright —
 * none of it is needed to triage and all of it is high-risk.
 */
function scrubEvent(event) {
  if (!event || typeof event !== 'object') return event;
  try {
    if (event.extra) event.extra = redactSensitive(event.extra);
    if (event.contexts) event.contexts = redactSensitive(event.contexts);
    if (event.tags) event.tags = redactSensitive(event.tags);
    if (event.user) event.user = redactSensitive(event.user);

    if (Array.isArray(event.exception?.values)) {
      for (const ex of event.exception.values) {
        if (typeof ex?.value === 'string') ex.value = redactString(ex.value);
      }
    }
    if (typeof event.message === 'string') event.message = redactString(event.message);

    if (Array.isArray(event.breadcrumbs)) {
      for (const crumb of event.breadcrumbs) {
        if (crumb?.data) crumb.data = redactSensitive(crumb.data);
        if (typeof crumb?.message === 'string') crumb.message = redactString(crumb.message);
      }
    }

    // Request-scoped PII that is never needed for triage.
    if (event.request) {
      delete event.request.data;
      delete event.request.cookies;
      if (event.request.headers) {
        delete event.request.headers.authorization;
        delete event.request.headers.Authorization;
        delete event.request.headers.cookie;
        delete event.request.headers.Cookie;
      }
    }
  } catch {
    // A scrubber that throws must not take the error report — or the app —
    // down with it. Better a slightly noisier event than a lost one.
  }
  return event;
}

export function initSentry() {
  if (sentryInitialized || !isSentryEnabled()) return;

  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.SENTRY_ENV || process.env.NODE_ENV || 'development',
    release: process.env.SENTRY_RELEASE || undefined,
    tracesSampleRate: parseSampleRate(process.env.SENTRY_TRACES_SAMPLE_RATE, 0),
    sendDefaultPii: false,
    maxValueLength: 2000,
    beforeSend: scrubEvent,
    beforeSendTransaction: scrubEvent
  });

  sentryInitialized = true;
}

export function captureBackendException(error, context = {}) {
  if (!isSentryEnabled()) return;
  initSentry();
  Sentry.withScope((scope) => {
    Object.entries(context || {}).forEach(([key, value]) => {
      if (value === undefined) return;
      if (key === 'user' && value && typeof value === 'object') {
        scope.setUser(value);
        return;
      }
      if (value && typeof value === 'object') {
        scope.setContext(key, value);
        return;
      }
      scope.setExtra(key, value);
    });
    Sentry.captureException(error);
  });
}

export async function flushSentry(timeout = 2000) {
  if (!isSentryEnabled() || !sentryInitialized) return;
  await Sentry.flush(timeout);
}
