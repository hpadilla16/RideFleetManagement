/**
 * Viewing AS one location — the location switcher's server half.
 *
 * WHY (Hector, 2026-08-11): an admin or agent with access to several
 * locations should be able to pick which location's data they are looking
 * at, the way a SUPER_ADMIN picks a tenant. Until now "access to many"
 * meant "always sees all of them mixed together".
 *
 * HOW: the client sends `x-view-location: <locationId>` and requireAuth
 * narrows req.user.locationIds to that single id BEFORE any route runs.
 * Every endpoint that already respects userAllowedLocationIds — the lists,
 * the reports, the KPI tiles — filters without knowing the feature exists.
 * One chokepoint, zero per-page plumbing: the same reasoning as
 * tolls-queue-counts and editableRowId. Two implementations of "which
 * location am I viewing" would disagree within a week.
 *
 * SECURITY SHAPE:
 *   - a RESTRICTED user picking outside their set is a hard 403, not an
 *     empty result — a scoped agent probing other branches should be told
 *     no, not shown a blank page that invites retrying;
 *   - an UNRESTRICTED user's pick is narrowed without a DB check: every
 *     downstream query still ANDs tenantId, so a foreign location id can
 *     only ever produce empty results, never another tenant's rows;
 *   - narrowing is fail-CLOSED by construction — the override only ever
 *     shrinks what the user could already see.
 */

export const VIEW_LOCATION_HEADER = 'x-view-location';

/**
 * @param {{user: object, requested: string|null|undefined}} args
 * @returns {{ok: true, locationIds: string[]|null|undefined} | {ok: false, error: string}}
 *   locationIds === undefined means "leave the user untouched".
 */
export function applyViewLocation({ user, requested }) {
  const id = String(requested || '').trim();
  if (!id) return { ok: true, locationIds: undefined };

  // A service account has its own allowlist world; a view header on it is a
  // caller bug, not a feature. Ignore rather than refuse — VozIA must never
  // start failing because a proxy forwarded a browser header.
  if (user?.isServiceAccount) return { ok: true, locationIds: undefined };

  const own = Array.isArray(user?.locationIds) ? user.locationIds.filter(Boolean).map(String) : null;
  const restricted = !!(own && own.length);

  if (restricted && !own.includes(id)) {
    return { ok: false, error: 'You do not have access to that location.' };
  }
  return { ok: true, locationIds: [id] };
}
