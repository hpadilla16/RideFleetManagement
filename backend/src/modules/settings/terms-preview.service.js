/**
 * See the contract a sede would actually print, before anybody rents
 * (2026-09-09).
 *
 * Hector: "me puedes poner pa ver un empty template de un contrato para ver lo
 * en los settings".
 *
 * ── WHY THIS CALLS THE REAL RESOLVER ────────────────────────────────────────
 * The terms a rental prints come from a three-step cascade — branch override,
 * then tenant, then the canonical document — and this preview asks
 * `getEffectiveTermsHtml` for the answer rather than reimplementing it. A
 * preview that builds the document its own way is worse than no preview: it
 * shows a contract nobody will ever sign, and it agrees with reality right up
 * until the day the cascade changes.
 *
 * ── WHY IT ALSO REPORTS WHICH LAYER WON ─────────────────────────────────────
 * `lib/terms/index.js` carries this warning in its own error path: a stale
 * Prisma client, a migration that silently failed, and a branch that simply has
 * no override all produce BYTE-IDENTICAL output — the tenant's terms — and
 * "that is a wrong legal document with no signal anywhere."
 *
 * The HTML alone therefore cannot tell you whether the branch text you just
 * saved is being used. So the preview reads the same three fields directly and
 * says which one the cascade will pick, next to the document itself. Looking at
 * a contract and knowing where it came from is the whole point of the screen.
 *
 * Read-only: nothing here writes, and no reservation or agreement is involved.
 * The initials markers are left blank ("___"), which is exactly the unsigned
 * template that goes to a counter for signing.
 */

import { prisma as defaultPrisma } from '../../lib/prisma.js';
import { getEffectiveTermsHtml, INITIALS_KEYS } from '../../lib/terms/index.js';
import { TC_VERSION } from '../../lib/terms/version.js';

export const TERMS_SOURCES = Object.freeze({
  LOCATION: 'LOCATION',
  TENANT: 'TENANT',
  CANONICAL: 'CANONICAL',
});

const trimmed = (v) => (typeof v === 'string' ? v.trim() : '');

/**
 * The contract a sede would print right now.
 *
 * @param {object} scope   { tenantId }
 * @param {object} opts    { locationId?, prisma? }
 * @returns {Promise<object>} { html, source, sourceLabel, hasRider, ... }
 */
export async function previewTerms(scope = {}, opts = {}) {
  const db = opts.prisma || defaultPrisma;
  const tenantId = scope?.tenantId;
  if (!tenantId) {
    const e = new Error('tenantId is required');
    e.httpStatus = 400;
    throw e;
  }

  const locationId = opts.locationId ? String(opts.locationId) : null;

  // The same three fields the cascade reads, so the answer below is not a
  // guess about what it did.
  let location = null;
  if (locationId) {
    location = await db.location.findFirst({
      where: { id: locationId, tenantId },
      select: { id: true, code: true, name: true, termsHtml: true, termsRiderHtml: true },
    });
    if (!location) {
      const e = new Error('Location not found for this tenant');
      e.httpStatus = 404;
      throw e;
    }
  }
  const tenant = await db.tenant.findUnique({
    where: { id: tenantId }, select: { name: true, termsHtml: true },
  });

  const locationBase = trimmed(location?.termsHtml);
  const rider = trimmed(location?.termsRiderHtml);
  const tenantBase = trimmed(tenant?.termsHtml);

  const source = locationBase
    ? TERMS_SOURCES.LOCATION
    : (tenantBase ? TERMS_SOURCES.TENANT : TERMS_SOURCES.CANONICAL);

  const sourceLabel = {
    [TERMS_SOURCES.LOCATION]: `This branch's own terms (${location?.code})`,
    [TERMS_SOURCES.TENANT]: `${tenant?.name || 'The tenant'}'s terms — this branch has none of its own`,
    [TERMS_SOURCES.CANONICAL]: `The built-in document (${TC_VERSION}) — neither this branch nor the tenant has its own`,
  }[source];

  // The document itself comes from the resolver, never from the fields above.
  const html = await getEffectiveTermsHtml({ tenantId, locationId }, { prisma: db }, { initials: {} });

  return {
    html,
    source,
    sourceLabel,
    tcVersion: TC_VERSION,
    tenantName: tenant?.name || null,
    location: location ? { id: location.id, code: location.code, name: location.name } : null,
    hasRider: Boolean(rider),
    // Sizes make an empty or truncated layer obvious at a glance, which a wall
    // of rendered HTML does not.
    lengths: {
      locationBase: locationBase.length,
      locationRider: rider.length,
      tenantBase: tenantBase.length,
      rendered: html.length,
    },
    // Blank in a template; a real agreement fills them at signing.
    initialsMarkers: INITIALS_KEYS,
  };
}

/**
 * The sedes this tenant can preview, with what each one carries. Lets the
 * screen show at a glance which branches have their own contract and which
 * fall back — the thing nobody can see today without opening each one.
 */
export async function listTermsCoverage(scope = {}, opts = {}) {
  const db = opts.prisma || defaultPrisma;
  const tenantId = scope?.tenantId;
  if (!tenantId) {
    const e = new Error('tenantId is required');
    e.httpStatus = 400;
    throw e;
  }
  const [locations, tenant] = await Promise.all([
    db.location.findMany({
      where: { tenantId, isActive: true },
      select: { id: true, code: true, name: true, termsHtml: true, termsRiderHtml: true },
      orderBy: { code: 'asc' },
    }),
    db.tenant.findUnique({ where: { id: tenantId }, select: { name: true, termsHtml: true } }),
  ]);
  const tenantHasBase = Boolean(trimmed(tenant?.termsHtml));
  return {
    tenantName: tenant?.name || null,
    tenantHasBase,
    tcVersion: TC_VERSION,
    locations: locations.map((l) => ({
      id: l.id,
      code: l.code,
      name: l.name,
      hasOwnBase: Boolean(trimmed(l.termsHtml)),
      hasRider: Boolean(trimmed(l.termsRiderHtml)),
      source: trimmed(l.termsHtml)
        ? TERMS_SOURCES.LOCATION
        : (tenantHasBase ? TERMS_SOURCES.TENANT : TERMS_SOURCES.CANONICAL),
    })),
  };
}
