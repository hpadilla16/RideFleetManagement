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

export function initClientSentry() {
  if (sentryInitialized || typeof window === 'undefined' || !isClientSentryEnabled()) return;

  Sentry.init({
    dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
    environment: process.env.NEXT_PUBLIC_SENTRY_ENV || process.env.NODE_ENV || 'development',
    release: process.env.NEXT_PUBLIC_SENTRY_RELEASE || undefined,
    tracesSampleRate: parseSampleRate(process.env.NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE, 0)
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
