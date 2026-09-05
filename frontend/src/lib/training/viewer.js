/**
 * Ride University — the viewer, built ONE way from the cached `me`.
 *
 * Three surfaces read `me` and hand a viewer to modulesFor(): Ride University's
 * module list, the tour mount, and the copilot mount. Three hand-rolled copies
 * drifted the day a field was added (the copilot never received `hasFeature`
 * and reported a not-live feature as "an admin does that" — Innovation,
 * 2026-09-05). So the shape lives here.
 *
 *   isModuleEnabled — tenant/user module gates; ABSENT MEANS ENABLED (a stale
 *                     cached user can only ever show more, never hide wrongly).
 *   hasFeature      — server-asserted feature reality (/api/auth/me
 *                     `features`); ABSENT MEANS NOT LIVE (fail-closed).
 */
export function viewerFromMe(me) {
  if (!me?.role) return null;
  return {
    role: me.role,
    isModuleEnabled: (key) => me?.moduleAccess?.[key] !== false,
    hasFeature: (key) => me?.features?.[key] === true,
  };
}
