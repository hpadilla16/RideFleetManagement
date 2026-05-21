/**
 * Promotion matcher — decides whether a freshly upserted ExternalReservation
 * row can be auto-promoted to a live Reservation, or needs human review.
 *
 * Pure-ish: takes the externalReservation + a Prisma handle. Does NOT
 * mutate anything; returns a decision object. The worker uses the
 * decision to drive the actual Reservation creation under a transaction.
 *
 * Decision tree (see doc/tl-integration-design-2026-05-19.md §5):
 *   1. currency != USD                        → MANUAL_REVIEW (currency_non_usd)
 *   2. AcrissCategoryMap missing for code     → MANUAL_REVIEW (acriss_unmapped)
 *   3. LocationCodeMap missing for code       → MANUAL_REVIEW (location_unmapped)
 *   4. Customer match: email exact OR (phone + name fuzzy >= 0.85)
 *      0 matches → MANUAL_REVIEW (customer_not_found)
 *      >1 match  → MANUAL_REVIEW (multiple_matches)
 *   5. All pass → AUTO
 *
 * Returns:
 *   {
 *     decision: 'AUTO' | 'MANUAL_REVIEW',
 *     reason?: string,         // one of the REVIEW_REASONS keys
 *     mappedCustomer?: { id, firstName, lastName, email, phone },
 *     mappedVehicleCategory?: string,
 *     mappedLocation?: { id, code, name }
 *   }
 */

export const REVIEW_REASONS = Object.freeze({
  CURRENCY_NON_USD: 'currency_non_usd',
  ACRISS_UNMAPPED: 'acriss_unmapped',
  LOCATION_UNMAPPED: 'location_unmapped',
  CUSTOMER_NOT_FOUND: 'customer_not_found',
  MULTIPLE_MATCHES: 'multiple_matches',
});

/**
 * Parse a TL pickupLocation field. Two formats supported:
 *   1. "San Juan Airport (SJUA01)" — parenthesized code at end (TL UI label)
 *   2. "SJUA01" — bare code (TL detail API field, what we actually get)
 * Returns the code string or null.
 */
export function extractLocationCode(label) {
  if (!label || typeof label !== 'string') return null;
  const s = label.trim();
  const parenMatch = s.match(/\(([A-Z0-9]{3,8})\)\s*$/);
  if (parenMatch) return parenMatch[1];
  if (/^[A-Z0-9]{3,8}$/.test(s)) return s;
  return null;
}

/**
 * Normalize a phone for fuzzy comparison: keep last 10 digits.
 * "+1 (787) 555-1234" → "7875551234".
 */
export function normalizePhone(phone) {
  if (!phone || typeof phone !== 'string') return null;
  const digits = phone.replace(/\D+/g, '');
  if (digits.length === 0) return null;
  return digits.length > 10 ? digits.slice(-10) : digits;
}

/**
 * Jaro-Winkler similarity — single-file implementation so we don't pull
 * in another dep. Returns 0..1.
 */
export function jaroWinkler(a, b) {
  if (!a && !b) return 1;
  if (!a || !b) return 0;
  const s1 = String(a).toLowerCase();
  const s2 = String(b).toLowerCase();
  if (s1 === s2) return 1;
  const m = Math.max(s1.length, s2.length);
  const matchDist = Math.floor(m / 2) - 1;
  const s1m = new Array(s1.length).fill(false);
  const s2m = new Array(s2.length).fill(false);
  let matches = 0;
  for (let i = 0; i < s1.length; i++) {
    const lo = Math.max(0, i - matchDist);
    const hi = Math.min(i + matchDist + 1, s2.length);
    for (let j = lo; j < hi; j++) {
      if (s2m[j]) continue;
      if (s1[i] !== s2[j]) continue;
      s1m[i] = true;
      s2m[j] = true;
      matches++;
      break;
    }
  }
  if (matches === 0) return 0;
  let transpositions = 0;
  let k = 0;
  for (let i = 0; i < s1.length; i++) {
    if (!s1m[i]) continue;
    while (!s2m[k]) k++;
    if (s1[i] !== s2[k]) transpositions++;
    k++;
  }
  transpositions = transpositions / 2;
  const jaro =
    (matches / s1.length +
      matches / s2.length +
      (matches - transpositions) / matches) / 3;
  // Winkler boost (max 4-char prefix)
  let prefix = 0;
  for (let i = 0; i < Math.min(4, s1.length, s2.length); i++) {
    if (s1[i] === s2[i]) prefix++;
    else break;
  }
  return jaro + prefix * 0.1 * (1 - jaro);
}

/**
 * Main entry point.
 */
export async function evaluatePromotion(extRes, { prisma } = {}) {
  if (!extRes) throw new Error('evaluatePromotion: externalReservation required');
  if (!prisma) throw new Error('evaluatePromotion: prisma client required');

  // ---- 1. Currency gate -----------------------------------------------------
  const currency = (extRes.currency || 'USD').toUpperCase();
  if (currency !== 'USD') {
    return { decision: 'MANUAL_REVIEW', reason: REVIEW_REASONS.CURRENCY_NON_USD };
  }

  // ---- 2. ACRISS map gate ---------------------------------------------------
  if (!extRes.vehicleAcriss) {
    return { decision: 'MANUAL_REVIEW', reason: REVIEW_REASONS.ACRISS_UNMAPPED };
  }
  const acrissCode = String(extRes.vehicleAcriss).trim().toUpperCase();
  const acrissMap = await findAcrissMapping(prisma, extRes.tenantId, acrissCode);
  if (!acrissMap) {
    return { decision: 'MANUAL_REVIEW', reason: REVIEW_REASONS.ACRISS_UNMAPPED };
  }

  // ---- 3. Location map gate -------------------------------------------------
  const extCode = extractLocationCode(extRes.pickupLocation) || extractLocationCode(extRes.dropoffLocation);
  if (!extCode) {
    return { decision: 'MANUAL_REVIEW', reason: REVIEW_REASONS.LOCATION_UNMAPPED };
  }
  const locMap = await prisma.locationCodeMap.findUnique({
    where: { tenantId_externalCode: { tenantId: extRes.tenantId, externalCode: extCode } },
    include: { location: true },
  });
  if (!locMap || !locMap.location) {
    return { decision: 'MANUAL_REVIEW', reason: REVIEW_REASONS.LOCATION_UNMAPPED };
  }

  // ---- 4. Customer match ----------------------------------------------------
  const matched = await matchCustomer(prisma, extRes);
  if (matched.error === 'multiple') {
    return { decision: 'MANUAL_REVIEW', reason: REVIEW_REASONS.MULTIPLE_MATCHES };
  }
  if (matched.error === 'none') {
    return { decision: 'MANUAL_REVIEW', reason: REVIEW_REASONS.CUSTOMER_NOT_FOUND };
  }

  // ---- 5. All gates passed --------------------------------------------------
  return {
    decision: 'AUTO',
    mappedCustomer: matched.customer,
    mappedVehicleCategory: acrissMap.vehicleCategory,
    mappedLocation: {
      id: locMap.location.id,
      code: locMap.location.code,
      name: locMap.location.name,
    },
  };
}

/**
 * Look up the ACRISS mapping. Tenant-scoped row wins, falls back to the
 * tenantId=null global row.
 */
async function findAcrissMapping(prisma, tenantId, acrissCode) {
  const scoped = await prisma.acrissCategoryMap.findUnique({
    where: { tenantId_acrissCode: { tenantId, acrissCode } },
  }).catch(() => null);
  if (scoped) return scoped;
  // Global fallback — composite unique key uses NULL semantics, so query
  // directly.
  const global = await prisma.acrissCategoryMap.findFirst({
    where: { tenantId: null, acrissCode },
  }).catch(() => null);
  return global || null;
}

/**
 * Customer match strategy:
 *   1. Email exact (case-insensitive) within tenant → if 1 match: win, if >1: ambiguous.
 *   2. Phone normalized + name JW similarity >= 0.85 → same disambiguation.
 *   3. Otherwise: not found.
 */
async function matchCustomer(prisma, extRes) {
  const tenantId = extRes.tenantId;
  // -- Email path
  const email = (extRes.customerEmail || '').trim().toLowerCase();
  if (email) {
    const emailMatches = await prisma.customer.findMany({
      where: { tenantId, email: { equals: email, mode: 'insensitive' } },
      select: { id: true, firstName: true, lastName: true, email: true, phone: true },
      take: 5,
    }).catch(() => []);
    if (emailMatches.length === 1) return { customer: emailMatches[0] };
    if (emailMatches.length > 1) return { error: 'multiple' };
  }
  // -- Phone+name path
  const phone = normalizePhone(extRes.customerPhone);
  if (phone) {
    // Pull candidates whose phone digits end with our normalized phone.
    const phoneCandidates = await prisma.customer.findMany({
      where: {
        tenantId,
        phone: { contains: phone },
      },
      select: { id: true, firstName: true, lastName: true, email: true, phone: true },
      take: 20,
    }).catch(() => []);
    const fullName = [(extRes.customerFirstName || '').trim(), (extRes.customerLastName || '').trim()]
      .filter(Boolean)
      .join(' ');
    const passes = [];
    for (const cand of phoneCandidates) {
      if (normalizePhone(cand.phone) !== phone) continue;
      const candName = [cand.firstName, cand.lastName].filter(Boolean).join(' ');
      const sim = jaroWinkler(fullName, candName);
      if (sim >= 0.85) passes.push(cand);
    }
    if (passes.length === 1) return { customer: passes[0] };
    if (passes.length > 1) return { error: 'multiple' };
  }
  return { error: 'none' };
}
