'use client';

/**
 * Tells a counter tablet when its tab has gone stale.
 *
 * WHY (outage, 2026-08-22): the counter keeps one tab open for days. A deploy
 * replaces the server while that tab keeps running the PREVIOUS bundle, and
 * Next answers with "Failed to find Server Action …" — which the agent
 * experiences as screens that will not load their cars or reservations. The
 * backend was healthy the whole time, every request logged 200 or 304, and
 * nothing in the API logs pointed at the cause. 346 errors accumulated before
 * anyone connected them to the deploy.
 *
 * NEVER RELOADS BY ITSELF. This app is used mid-checkout, with a customer at
 * the counter and unsaved form state on screen; yanking the page out from
 * under an agent would trade one bad afternoon for a worse one. It shows a
 * banner and lets the person choose the moment.
 */
import { useCallback, useEffect, useState } from 'react';

/** Frozen into this bundle at build time (next.config.js). */
const MY_BUILD = process.env.NEXT_PUBLIC_APP_BUILD || 'dev';

/** Quiet enough for a tab left open all day; fast enough to catch a deploy. */
const POLL_MS = 5 * 60 * 1000;

export function StaleBuildWatcher() {
  const [stale, setStale] = useState(false);

  const check = useCallback(async () => {
    // 'dev' means the stamp never ran (local `next dev` without the script) —
    // there is nothing meaningful to compare against.
    if (MY_BUILD === 'dev' || stale) return;
    try {
      const res = await fetch(`/build-id.txt?t=${Date.now()}`, { cache: 'no-store' });
      if (!res.ok) return;
      const live = (await res.text()).trim();
      // An empty or malformed answer means a proxy or an error page, not a
      // deploy. Only a real, different id counts.
      if (live && live !== MY_BUILD) setStale(true);
    } catch {
      // Offline or a blip — never nag someone over a failed poll.
    }
  }, [stale]);

  useEffect(() => {
    check();
    const timer = setInterval(check, POLL_MS);
    // Coming back to the tab is the likeliest moment to have missed a deploy.
    const onFocus = () => check();
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onFocus);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onFocus);
    };
  }, [check]);

  if (!stale) return null;

  return (
    <div
      role="status"
      style={{
        position: 'fixed', left: 0, right: 0, bottom: 0, zIndex: 100001,
        display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 14, flexWrap: 'wrap',
        padding: '12px 16px calc(12px + env(safe-area-inset-bottom, 0px))',
        background: '#1e1a2b', color: '#fff', fontSize: 13.5, fontWeight: 600,
        boxShadow: '0 -2px 14px rgba(0,0,0,.3)',
      }}
    >
      <span aria-hidden="true">↻</span>
      <span>A new version is available. Reload to keep loading data correctly.</span>
      <button
        type="button"
        onClick={() => window.location.reload()}
        style={{
          background: '#fff', color: '#1e1a2b', border: 'none', borderRadius: 999,
          padding: '6px 16px', fontSize: 12.5, fontWeight: 700, cursor: 'pointer',
        }}
      >
        Reload now
      </button>
    </div>
  );
}

export default StaleBuildWatcher;
