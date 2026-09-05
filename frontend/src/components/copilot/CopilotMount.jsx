'use client';

/**
 * The bridge between the server-rendered root layout and the copilot — the
 * same contract TourMount keeps for the tour, for the same reasons.
 *
 * layout.js is a server component and cannot read who is signed in. This
 * wrapper reads the cached user the app already stores at login and renders
 * NOTHING at all without one: kiosk, tracker, portal and every other
 * customer-facing page has no cached staff user, so the launcher simply never
 * exists there. Same rule TourMount.jsx applies (its comment explains why the
 * once-on-mount read is safe: a role change means a new session, which means
 * a fresh mount).
 *
 * Deliberately cheap: no fetches, no timers. Everything stateful lives in
 * Copilot.jsx and costs nothing until the person opens the panel.
 */

import { useEffect, useState } from 'react';
import { viewerFromMe } from '../../lib/training/viewer';
import { USER_KEY } from '../../lib/client';
import { Copilot } from './Copilot';

export function CopilotMount() {
  const [viewer, setViewer] = useState(null);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(USER_KEY);
      if (!raw) return;
      const me = JSON.parse(raw);
      if (!me?.role) return;
      setViewer(viewerFromMe(me));
    } catch { /* no cached user — customer-facing page, no copilot */ }
  }, []);

  if (!viewer) return null;
  return <Copilot viewer={viewer} />;
}
