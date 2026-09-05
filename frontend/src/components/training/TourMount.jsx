'use client';

/**
 * The bridge between the server-rendered root layout and the tour.
 *
 * layout.js is a server component, so it cannot read who is signed in. This
 * client wrapper does: it reads the cached user the app already stores at
 * login, hands it to TourHost as the viewer, and renders nothing at all until
 * a tour is actually started.
 *
 * Deliberately cheap. It mounts on EVERY page in the app — including the
 * customer-facing ones that have no user at all — so it must cost nothing when
 * nobody is touring: no fetches, no timers, no listeners beyond the one that
 * waits for a start event.
 */

import { useEffect, useState } from 'react';
import { USER_KEY } from '../../lib/client';
import { TourHost } from './TourHost';

export function TourMount() {
  const [viewer, setViewer] = useState(null);

  useEffect(() => {
    // Read once on mount. A tour started later still sees the right role
    // because a role change means a new session, which means a fresh mount.
    try {
      const raw = window.localStorage.getItem(USER_KEY);
      if (!raw) return;
      const me = JSON.parse(raw);
      if (!me?.role) return;
      setViewer({
        role: me.role,
        // Curriculum gates are per-tenant module keys. Absent means enabled,
        // matching isModuleEnabled's own default, so a stale cached user can
        // only ever show MORE of the tour, never hide a module wrongly.
        isModuleEnabled: (key) => me?.moduleAccess?.[key] !== false,
        // Feature reality from the server; absent means not live (fail-closed).
        hasFeature: (key) => me?.features?.[key] === true,
      });
    } catch { /* no cached user — customer-facing pages, nothing to tour */ }
  }, []);

  if (!viewer) return null;
  return <TourHost viewer={viewer} />;
}
