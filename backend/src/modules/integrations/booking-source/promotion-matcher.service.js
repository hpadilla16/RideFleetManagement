/**
 * Promotion matcher — decides whether a freshly upserted ExternalReservation
 * row can be auto-promoted to a live Reservation, or needs human review.
 *
 * Moved verbatim from tl-international/ (R0 extraction, 2026-07-13) — it was
 * always source-agnostic (TL, Economy and NU consume it unchanged). The old
 * path re-exports this module, so no caller changed.
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

import { CUSTOMER_PHONE_PLACEHOLDER } from './customer-autocreate.js';

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
 * Is this a DEGENERATE placeholder phone rather than a real identity?
 *
 * `Customer.phone` is required, so every booking-source auto-create stamps
 * CUSTOMER_PHONE_PLACEHOLDER ('0000000000') when the source has no phone
 * (customer-autocreate.js) — the "fix it at the counter" marker. The placeholder
 * is therefore a SHARED POOL, not an identity: hundreds of unrelated customers
 * carry those exact digits (every Flexways row auto-created 2026-07-14 sits on
 * it today).
 *
 * THE MECHANISM (precisely): the phone path below re-checks EXACT normalized
 * equality per candidate, so a broad `contains` can only MISS a match — it can
 * never match a differing number. The hazard is narrower and worse: when the
 * staged phone normalizes to EXACTLY the pool value, every pooled stranger is an
 * exact-phone candidate, and the only thing left standing between them is the
 * Jaro-Winkler >= 0.85 name gate. MARIO GARCIA then matches MARIA GARCIA's
 * record. Note *_AUTO_CREATE_CUSTOMERS does NOT protect against this — that flag
 * gates customer CREATION; this match path runs regardless.
 *
 * WHY THIS LIVES IN THE SHARED MATCHER: all five sources pass the upstream phone
 * through verbatim, so this is data-dependent, not code-stamped. The day any
 * portal returns a literal '0000000000' / '(000) 000-0000' for a booking, that
 * row normalizes straight into the pool and stranger-matches. Fixing it only in
 * Advantage's mapper would leave TL/Economy/NU/Flexways exposed.
 *
 * WHY A NAMED GUARD AND NOT normalizePhone(): normalizePhone's contract is purely
 * syntactic — "keep the last 10 digits" — it is exported (and re-exported through
 * the tl-international shim) and its existing tests document exactly that. Making
 * it return null for a value it CAN normalize would overload a formatting helper
 * with identity policy and silently change it for every future caller. The
 * problem is not the format; it's that these digits must not be used as a LOOKUP
 * KEY. So the guard sits at the one call site that does that, under a name that
 * says what it means.
 *
 * THE RULE — deliberately narrow, because a false positive silently drops a
 * legitimate match for all five sources:
 *   - all-zeros digits (any length): never a real number in any plan. Covers
 *     '0000000000', '(000) 000-0000' and the short '000-0000'.
 *   - an exact hit on CUSTOMER_PHONE_PLACEHOLDER, so the link survives that
 *     constant ever changing to something not all-zeros.
 * Repeated-single-digit numbers ('1111111111', '9999999999') are NOT rejected:
 * they are also common placeholders, but this guard must not start adjudicating
 * which real-but-unusual numbers are "fake". All-zeros is the line where the
 * answer is unambiguous.
 *
 * Pure. Exported for tests.
 */
export function isPlaceholderPhone(phone) {
  const digits = normalizePhone(phone);
  if (!digits) return false;
  if (/^0+$/.test(digits)) return true;
  return digits === normalizePhone(CUSTOMER_PHONE_PLACEHOLDER);
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
 *
 * @param {object}   extRes
 * @param {object}   opts
 * @param {object}   opts.prisma            Prisma client (required).
 * @param {string=}  opts.overrideLocationId  OPTIONAL. When supplied, the caller
 *   has ALREADY authoritatively resolved the Ride location (e.g. the Economy
 *   worker via EconomyLocationConfig) — the LocationCodeMap gate is skipped and
 *   mappedLocation.id is set to this value. Defaults to undefined, so every
 *   existing (TL) caller — which never passes it — behaves EXACTLY as before:
 *   the LocationCodeMap gate runs unchanged. Purely additive, no-op for TL.
 * @param {string=}  opts.overrideCustomerId  OPTIONAL, symmetric with
 *   overrideLocationId. When supplied, the caller has ALREADY authoritatively
 *   resolved the Customer for this row — typically because it JUST created it via
 *   maybeCreateCustomerFromSource — so the fuzzy matchCustomer step is skipped and
 *   mappedCustomer.id is set to this value. Re-searching for a customer you just
 *   created is not just wasteful: with a placeholder phone the search is not even
 *   guaranteed to find it (the phone path takes an UNORDERED 20), which turns
 *   "create then re-evaluate" into an unbounded create loop across sweeps.
 *   Defaults to undefined → every existing caller behaves EXACTLY as before.
 */
export async function evaluatePromotion(
  extRes,
  { prisma, overrideLocationId = undefined, overrideCustomerId = undefined } = {}
) {
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
  // When the caller passed an authoritative overrideLocationId (Economy path,
  // resolved from EconomyLocationConfig), skip the LocationCodeMap lookup and
  // treat the location as resolved. TL callers never pass it → gate unchanged.
  let resolvedLocation = null;
  if (overrideLocationId) {
    resolvedLocation = { id: overrideLocationId, code: null, name: null };
  } else {
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
    resolvedLocation = {
      id: locMap.location.id,
      code: locMap.location.code,
      name: locMap.location.name,
    };
  }

  // ---- 4. Customer match ----------------------------------------------------
  // An authoritative overrideCustomerId (the caller just created/resolved it)
  // skips the fuzzy match entirely. Callers that don't pass it are unchanged.
  let resolvedCustomer = null;
  if (overrideCustomerId) {
    resolvedCustomer = { id: overrideCustomerId };
  } else {
    const matched = await matchCustomer(prisma, extRes);
    if (matched.error === 'multiple') {
      return { decision: 'MANUAL_REVIEW', reason: REVIEW_REASONS.MULTIPLE_MATCHES };
    }
    if (matched.error === 'none') {
      return { decision: 'MANUAL_REVIEW', reason: REVIEW_REASONS.CUSTOMER_NOT_FOUND };
    }
    resolvedCustomer = matched.customer;
  }

  // ---- 5. All gates passed --------------------------------------------------
  return {
    decision: 'AUTO',
    mappedCustomer: resolvedCustomer,
    mappedVehicleCategory: acrissMap.vehicleCategory,
    mappedLocation: resolvedLocation,
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
 *      SKIPPED for an all-zeros placeholder phone (see isPlaceholderPhone): those
 *      digits are a shared "fix at the counter" marker, not an identity.
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
  // An all-zeros placeholder is a SHARED pool value, never an identity — matching
  // on it would hand a stranger's record to whoever's name happens to be fuzzy-
  // close. Fall through to 'none' (→ customer_not_found → MANUAL_REVIEW).
  const phone = isPlaceholderPhone(extRes.customerPhone)
    ? null
    : normalizePhone(extRes.customerPhone);
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
