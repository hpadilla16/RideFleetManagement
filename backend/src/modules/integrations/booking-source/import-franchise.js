/**
 * Which franchise brand an IMPORTED reservation belongs to (2026-09-08).
 *
 * Hector: "ellos manejan franchises... si es importado con la integracion, que
 * venga ya con la franquicia asignada importado a reservations".
 *
 * The franchise decides the name, logo, address and phone the renter sees on
 * the agreement (lib/tenant-brand.js already resolves that cascade). Assigning
 * it by hand worked while one person did it — IRC has 1,401 reservations on
 * ZEZGO and 41 on MEX_RENT_A_CAR, every one typed in — but no import has ever
 * carried it, so Corpusa's 11,018 reservations are all unbranded.
 *
 * WHY THE SOURCE, AND NOT THE PAYLOAD. The obvious signal would be the booking
 * itself, and it is not there: measured across every staged row, subBrand is
 * null for ECONOMY (6,298), TL (1,236), NU (2,215) and FLEXWAYS (351) — only
 * MEX carries one, and it reads 'MEX' while IRC's franchise code is
 * 'MEX_RENT_A_CAR'. `channel` is worse: it holds CarTrawler2733, CTRIP4075,
 * BOOKINGGRO — which OTA sold the booking, not whose brand it was sold under.
 * The one honest signal is which integration the booking arrived through, and
 * that is exactly how the humans have been assigning it.
 *
 * RESOLUTION, most specific first:
 *   1. a franchise that explicitly claims this source in `importSources`
 *   2. a franchise whose CODE equals the source name
 *   3. the tenant's default franchise
 *   4. null — the pre-2026-09-08 behaviour, and never an error
 *
 * Steps 1 and 2 REFUSE ON AMBIGUITY. Two active franchises claiming one source
 * is a configuration mistake with no right answer, and branding a rental with
 * the wrong company is worse than leaving it unbranded for someone to fix.
 */

import logger from '../../../lib/logger.js';

/** Normalize a source name for comparison. Never throws. */
function norm(value) {
  return String(value || '').trim().toUpperCase();
}

/**
 * @param {object} db      Prisma handle (the worker passes its client/tx).
 * @param {object} args
 * @param {string} args.tenantId
 * @param {string} args.sourceSystem  ExternalReservation.sourceSystem.
 * @returns {Promise<string|null>} Franchise id, or null to leave it unassigned.
 */
export async function resolveImportFranchiseId(db, { tenantId, sourceSystem } = {}) {
  const source = norm(sourceSystem);
  if (!db?.franchise?.findMany || !tenantId || !source) return null;

  // Best-effort throughout: a franchise lookup must never cost us the import.
  // An unbranded reservation is a cosmetic gap someone can fix from the
  // reservation screen; a failed promotion is a booking the counter cannot
  // rent against.
  const franchises = await db.franchise.findMany({
    where: { tenantId, isActive: true },
    select: { id: true, code: true, name: true, importSources: true, isDefault: true },
  }).catch((err) => {
    logger.warn('[import-franchise] lookup failed — leaving the reservation unbranded', {
      tenantId, sourceSystem: source, message: String(err?.message || err),
    });
    return null;
  });
  if (!Array.isArray(franchises) || !franchises.length) return null;

  const pick = (candidates, how) => {
    if (candidates.length === 1) return candidates[0].id;
    if (candidates.length > 1) {
      logger.error('[import-franchise] more than one active franchise claims this source — importing UNBRANDED rather than guessing', {
        tenantId, sourceSystem: source, how, codes: candidates.map((f) => f.code),
      });
      return undefined; // undefined = stop, do not fall through to a weaker rule
    }
    return null;
  };

  // 1. Explicitly claimed.
  const claimed = pick(
    franchises.filter((f) => (f.importSources || []).some((s) => norm(s) === source)),
    'importSources',
  );
  if (claimed !== null) return claimed ?? null;

  // 2. Code equals the source name. Convention, so the common case needs no
  //    configuration at all: Corpusa's ECONOMY and MEX resolve on this alone.
  const byCode = pick(franchises.filter((f) => norm(f.code) === source), 'code');
  if (byCode !== null) return byCode ?? null;

  // 3. The tenant's default brand — what Hector called the CorpUSA fallback.
  const defaults = franchises.filter((f) => f.isDefault);
  if (defaults.length === 1) return defaults[0].id;

  // 4. Unbranded. The agreement falls back to the tenant's own settings, which
  //    is exactly what every import did before this existed.
  return null;
}
