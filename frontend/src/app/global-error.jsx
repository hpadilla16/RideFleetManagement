'use client';

import { useEffect } from 'react';
import { captureClientException } from '../lib/sentry';

export default function GlobalError({ error, reset }) {
  useEffect(() => {
    if (error) {
      captureClientException(error, {
        area: 'next-global-error',
        digest: error?.digest || null
      });
    }
  }, [error]);

  return (
    <html lang="en">
      <body>
        <main style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 24, background: '#f6f8fb', color: '#1f2240' }}>
          <section style={{ maxWidth: 560, width: '100%', background: '#fff', borderRadius: 24, padding: 24, boxShadow: '0 24px 60px rgba(31,34,64,0.12)' }}>
            <div style={{ fontSize: 12, textTransform: 'uppercase', letterSpacing: '0.14em', color: '#6e49ff', marginBottom: 10 }}>System Error</div>
            <h1 style={{ margin: '0 0 8px', fontSize: 32 }}>Something went wrong.</h1>
            <p style={{ margin: '0 0 18px', color: '#5b5f86' }}>
              The error has been logged so the team can review it. You can retry the page now.
            </p>
            <button type="button" onClick={() => reset()} style={{ border: 0, borderRadius: 14, padding: '12px 16px', background: '#6e49ff', color: '#fff', fontWeight: 700 }}>
              Try again
            </button>
          </section>
        </main>
      </body>
    </html>
  );
}
