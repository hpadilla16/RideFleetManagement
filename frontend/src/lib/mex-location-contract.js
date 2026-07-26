/**
 * The Mex location-config REQUEST CONTRACT — the single place the panel
 * names the fields it sends to `/api/admin/integrations/mex/locations`.
 *
 * WHY THIS FILE EXISTS (the beta.301 lesson): the Flexways panel POSTed
 * `{ externalSede }` while flexways.routes.js read `req.body.idSede`. Nothing
 * caught it — the panel compiled, the routes compiled, and "Add sede" 400'd in
 * PRODUCTION. The field names only ever met at runtime.
 *
 * So they now meet in a TEST instead: this builder is the only thing the panel
 * uses to shape a location body, `readLocationBody()` in mex.routes.js is
 * the only thing the routes use to read one, and
 * backend/src/modules/integrations/mex/mex.routes.test.mjs feeds this
 * builder's output straight into that reader. Rename a field on either side
 * without the other and the test goes red before the deploy does.
 *
 * Kept as a plain .js module (no JSX, no React) precisely so the backend test can
 * import it directly.
 *
 * Identity note: an Mex config row is keyed by the PAIR (tsdNumber, branch)
 * — the portal's `Loc` column, e.g. "61302.MCO" — not by a single id.
 */

/** Body keys the routes understand. Must match LOCATION_BODY_FIELDS in mex.routes.js. */
export const MEX_LOCATION_BODY_FIELDS = Object.freeze([
  'tsdNumber',
  'branch',
  'locationId',
  'enabled',
  'lookbackDays',
  'lookaheadDays',
]);

/**
 * Build a POST/PUT body for a location config. Only the fields actually supplied
 * are included — an omitted field means "leave it alone" on PUT, and the backend
 * applies its own defaults on POST.
 *
 * @param {object} input
 * @param {string} [input.tsdNumber]  TSD account, e.g. "61302"
 * @param {string} [input.branch]     Branch code, e.g. "MCO"
 * @param {string} [input.locationId] Ride location id
 * @param {boolean} [input.enabled]
 * @param {number|null} [input.lookbackDays]
 * @param {number|null} [input.lookaheadDays]
 * @returns {object} body for JSON.stringify
 */
export function buildMexLocationBody(input = {}) {
  const body = {};
  if (input.tsdNumber !== undefined) body.tsdNumber = String(input.tsdNumber ?? '').trim();
  // Upper-cased here too so what the admin sees in the grid is what the portal's
  // `Loc` suffix looks like (the backend normalizes again — belt and braces).
  if (input.branch !== undefined) body.branch = String(input.branch ?? '').trim().toUpperCase();
  if (input.locationId !== undefined) body.locationId = input.locationId;
  if (input.enabled !== undefined) body.enabled = !!input.enabled;
  if (input.lookbackDays !== undefined) body.lookbackDays = input.lookbackDays;
  if (input.lookaheadDays !== undefined) body.lookaheadDays = input.lookaheadDays;
  return body;
}

/** The portal-facing identity string for a config row: "61302.MCO". */
export function mexLocLabel(row) {
  const tsd = String(row?.tsdNumber ?? '').trim();
  const branch = String(row?.branch ?? '').trim();
  if (!tsd && !branch) return '';
  return `${tsd}.${branch}`;
}
