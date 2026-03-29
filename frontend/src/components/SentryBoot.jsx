'use client';

import { useEffect } from 'react';
import { captureClientException, initClientSentry, isClientSentryEnabled } from '../lib/sentry';

export function SentryBoot() {
  useEffect(() => {
    if (!isClientSentryEnabled()) return undefined;

    initClientSentry();

    const onError = (event) => {
      const error = event?.error instanceof Error ? event.error : new Error(event?.message || 'Window error');
      captureClientException(error, {
        area: 'window.onerror',
        source: event?.filename || null,
        line: event?.lineno || null,
        column: event?.colno || null
      });
    };

    const onUnhandledRejection = (event) => {
      const reason = event?.reason instanceof Error ? event.reason : new Error(String(event?.reason || 'Unhandled promise rejection'));
      captureClientException(reason, {
        area: 'window.unhandledrejection'
      });
    };

    window.addEventListener('error', onError);
    window.addEventListener('unhandledrejection', onUnhandledRejection);

    return () => {
      window.removeEventListener('error', onError);
      window.removeEventListener('unhandledrejection', onUnhandledRejection);
    };
  }, []);

  return null;
}
