import * as Sentry from '@sentry/node';

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

export function initSentry() {
  if (sentryInitialized || !isSentryEnabled()) return;

  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.SENTRY_ENV || process.env.NODE_ENV || 'development',
    release: process.env.SENTRY_RELEASE || undefined,
    tracesSampleRate: parseSampleRate(process.env.SENTRY_TRACES_SAMPLE_RATE, 0)
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
