/**
 * Which franchise's prices an integration publishes (2026-09-09).
 *
 * Hector: "el objetivo es distinguir por franquicia para que los precios que
 * son de MEX, escriban a MEX directamente y que los de zezgo escriban al de
 * zezgo cuando prendemos el rate writeback".
 *
 * ── THE HAZARD THIS EXISTS TO PREVENT ───────────────────────────────────────
 * Every rate writeback today reads EVERY active rate at the sede and, when two
 * of them disagree about a class, drops that class as ambiguous rather than
 * guessing (`loadDesiredMexRates`). That guard is correct and it is also a
 * trapdoor: the moment a sede has one rate per brand — Economy $10, Zezgo $14,
 * MEX $7 for the same class — EVERY class becomes ambiguous and the writeback
 * publishes NOTHING. Silently, because that is what the guard is for.
 *
 * So the writebacks have to learn about franchises BEFORE any per-franchise
 * rate exists. That is why this ships inert: with no rate carrying a franchise,
 * every rate is shared and every caller sees exactly what it sees today.
 *
 * ── WHY THIS RESOLVER IS NOT THE IMPORT ONE ─────────────────────────────────
 * `resolveImportFranchiseId` falls back to the tenant's DEFAULT franchise, and
 * that is right for an import: stamping a reservation with the house brand is a
 * cosmetic guess a human can correct on the reservation screen.
 *
 * It would be wrong here. Publishing Zezgo's prices into MEX's portal because
 * Zezgo happens to be the default brand is a live, customer-facing price on the
 * wrong company's shelf, and nobody is watching the way they watch a booking.
 * So this resolver stops at the two rules that are actual EVIDENCE of ownership
 * — an explicit `importSources` claim, or a code that equals the provider —
 * and otherwise returns null, which means "publish only what is shared".
 */

import logger from '../../../lib/logger.js';

const norm = (v) => String(v || '').trim().toUpperCase();

/**
 * The franchise that owns a provider's shelf, or null.
 *
 * null is not an error: it is the honest answer for a tenant that has not split
 * its rates by brand, and it makes the caller publish shared rates only.
 *
 * @param {object} db   Prisma handle.
 * @param {object} args
 * @param {string} args.tenantId
 * @param {string} args.provider  'MEX' | 'ECONOMY' | 'TL_INTERNATIONAL' | ...
 * @returns {Promise<string|null>} Franchise id.
 */
export async function resolvePushFranchiseId(db, { tenantId, provider } = {}) {
  const source = norm(provider);
  if (!db?.franchise?.findMany || !tenantId || !source) return null;

  const franchises = await db.franchise.findMany({
    where: { tenantId, isActive: true },
    select: { id: true, code: true, importSources: true },
  }).catch((err) => {
    logger.warn('[rate-franchise] franchise lookup failed — publishing shared rates only', {
      tenantId, provider: source, message: String(err?.message || err),
    });
    return null;
  });
  if (!Array.isArray(franchises) || !franchises.length) return null;

  const pick = (candidates, how) => {
    if (candidates.length === 1) return candidates[0].id;
    if (candidates.length > 1) {
      logger.error('[rate-franchise] more than one active franchise claims this provider — publishing SHARED rates only rather than guessing whose prices these are', {
        tenantId, provider: source, how, codes: candidates.map((f) => f.code),
      });
      return undefined; // stop; do not fall through to a weaker rule
    }
    return null;
  };

  const claimed = pick(
    franchises.filter((f) => (f.importSources || []).some((s) => norm(s) === source)),
    'importSources',
  );
  if (claimed !== null) return claimed ?? null;

  const byCode = pick(franchises.filter((f) => norm(f.code) === source), 'code');
  if (byCode !== null) return byCode ?? null;

  // Deliberately NO default-franchise fallback. See the header.
  return null;
}

/**
 * Narrow a sede's active rates to the ones this franchise may publish.
 *
 * PURE. Rates are `{ id, franchiseId, ... }`; anything else is passed through
 * untouched so callers keep their own shapes.
 *
 * A rate with `franchiseId === null` is SHARED — it belongs to every brand,
 * which is what every rate in the system is today, and is why this is inert
 * until somebody splits them.
 *
 *   franchise resolved      that franchise's rates, plus the shared ones
 *   franchise NOT resolved  shared rates ONLY
 *
 * The second line is the safe half: if we cannot say whose shelf this is, we
 * publish only what is nobody's in particular. Today that is everything, so
 * nothing changes; once brands are split it is the difference between silence
 * and publishing a competitor-of-ourselves price on the wrong portal.
 */
export function selectRatesForFranchise(rates, franchiseId) {
  // A non-object in this list is not a rate with no franchise — it is junk, and
  // letting it through as "shared" would hand the caller something it will try
  // to read rateItems off.
  const list = (Array.isArray(rates) ? rates : []).filter((r) => r && typeof r === 'object');
  const shared = list.filter((r) => r.franchiseId == null);
  if (!franchiseId) return shared;
  const mine = list.filter((r) => r?.franchiseId === franchiseId);
  return mine.length ? [...mine, ...shared] : shared;
}

/**
 * True when a rate belongs to this franchise specifically (not shared).
 * Used to let a brand's own rate WIN over a shared one for the same class
 * instead of colliding with it.
 */
export function isFranchiseSpecific(rate, franchiseId) {
  return Boolean(franchiseId) && rate?.franchiseId === franchiseId;
}
