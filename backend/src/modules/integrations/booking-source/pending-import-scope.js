/**
 * Location scoping for franchise-import trays (2026-07-27, Hector's bug: a
 * LAX-only Corpusa admin saw pending imports from ALL Corpusa locations).
 *
 * ExternalReservation has no resolved Ride locationId — only the raw
 * `pickupLocation` string and `rawJson` from the feed. Each provider resolves
 * location its own way, so this maps a row -> Ride locationId using the same
 * per-source config the promotion matcher uses, then keeps only rows whose
 * location is in the caller's allowed set.
 *
 * FAIL-CLOSED for scoped users: a row whose location can't be resolved to one
 * of their locations is HIDDEN (an unscoped admin still sees it to fix the
 * mapping). Unscoped callers (allowedLocationIds null/empty) get every row
 * unchanged — zero regression for full admins.
 */
import { prisma } from '../../../lib/prisma.js';

function up(v) {
  return String(v ?? '').trim().toUpperCase();
}

// The pending-import query must include these so the filter can read them.
export const SCOPE_FILTER_FIELDS = { pickupLocation: true, dropoffLocation: true, rawJson: true };

/**
 * @param {Array} rows ExternalReservation rows (must include pickupLocation,
 *   dropoffLocation, rawJson).
 * @param {{ tenantId: string, allowedLocationIds: string[]|null, sourceSystem: string }} opts
 * @returns {Promise<Array>} rows the caller is allowed to see
 */
export async function filterExternalRowsByLocationScope(rows, opts = {}) {
  const { tenantId, sourceSystem } = opts;
  const allowed = Array.isArray(opts.allowedLocationIds) ? opts.allowedLocationIds.filter(Boolean).map(String) : null;
  // Unscoped admin -> no filtering. Also bail safely without a tenant.
  if (!allowed || !allowed.length || !tenantId) return rows;
  const allowedSet = new Set(allowed);
  const source = up(sourceSystem);

  // Build the set of external location KEYS that belong to an allowed Ride
  // location, using this source's own config, then a predicate row -> key.
  let allowedKeys = new Set();
  let keyForRow = () => null;

  if (source === 'ECONOMY') {
    const cfgs = await prisma.economyLocationConfig.findMany({
      where: { tenantId, locationId: { in: allowed } }, select: { externalArea: true }
    });
    allowedKeys = new Set(cfgs.map((c) => up(c.externalArea)));
    // Economy row pickupLocation is like "MIAO01" -> area = first 3 chars.
    keyForRow = (row) => up(row.pickupLocation).slice(0, 3);
  } else if (source === 'ADVANTAGE' || source === 'MEX') {
    const table = source === 'MEX' ? prisma.mexLocationConfig : prisma.advantageLocationConfig;
    const cfgs = await table.findMany({
      where: { tenantId, locationId: { in: allowed } }, select: { tsdNumber: true, branch: true }
    });
    // Grid `Loc` renders "tsdNumber.branch" (e.g. "61302.MCO"); also accept the
    // bare branch so a feed that only carries the branch still matches.
    allowedKeys = new Set(cfgs.flatMap((c) => [up(`${c.tsdNumber}.${c.branch}`), up(c.branch)]));
    keyForRow = (row) => {
      const raw = up(row.pickupLocation);
      // exact "tsd.branch" or the branch suffix after a dot
      return allowedKeys.has(raw) ? raw : up(raw.split('.').pop());
    };
  } else if (source === 'FLEXWAYS') {
    const cfgs = await prisma.flexwaysLocationConfig.findMany({
      where: { tenantId, locationId: { in: allowed } }, select: { idSede: true }
    });
    allowedKeys = new Set(cfgs.map((c) => up(c.idSede)));
    keyForRow = (row) => up(row?.rawJson?.idSede ?? row?.rawJson?.sedeId ?? '');
  } else if (source === 'NU') {
    const cfgs = await prisma.nuLocationConfig.findMany({
      where: { tenantId, locationId: { in: allowed }, externalCenter: { not: null } },
      select: { externalCenter: true }
    });
    allowedKeys = new Set(cfgs.map((c) => up(c.externalCenter)));
    keyForRow = (row) => up(row?.rawJson?.center ?? row?.rawJson?.centerCode ?? '');
  } else {
    // TL_INTERNATIONAL and any code-map source: LocationCodeMap[externalCode].
    const maps = await prisma.locationCodeMap.findMany({
      where: { tenantId, locationId: { in: allowed } }, select: { externalCode: true }
    });
    allowedKeys = new Set(maps.map((m) => up(m.externalCode)));
    keyForRow = (row) => {
      // extract a 5-8 char alnum code from the pickup string
      const m = up(row.pickupLocation).match(/[A-Z0-9]{4,8}/);
      return m ? m[0] : '';
    };
  }

  if (!allowedKeys.size) return []; // scoped user with no mapped location here
  return rows.filter((row) => {
    const key = keyForRow(row);
    return key && allowedKeys.has(key);
  });
}
