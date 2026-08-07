/**
 * S30 (2026-07-19) — SHARED reservation smart-matcher.
 *
 * THE single source of truth for "the customer's confirmation code doesn't
 * look like our reservationNumber" (rule like vehicle-status-sync: no local
 * normalizer forks). Consumers:
 *   - VozIA service account  → GET /api/reservations/smart-lookup (Chloe)
 *   - Kiosk find_reservation → backend/src/modules/kiosk/kiosk-smart-match.js
 *
 * Why: OTAs hand the guest the SOURCE ref (Expedia → ZE40809640BA) while the
 * import stored it prefixed per booking-source (TL-ZE40809640BA). Frozen
 * contract with the kiosk team (doc/kiosk-smart-lookup-prompt-2026-07-19.md):
 *   smartMatchReservation({ code?, name?, dateWindow?, tenantId }) =>
 *     ranked [{ reservation: { id, ... }, matchType, confidence }]
 * Guarantees: tenant-scoped HARD (throws without tenantId) · read-only
 * (findMany only) · ranked best-first · multiple candidates is correct
 * behavior · stable reservation.id on every entry.
 *
 * New variant patterns discovered in the field go HERE + the shared doc.
 */

/** Import prefixes per booking-source (see each source's constants) + native. */
export const KNOWN_PREFIXES = ['RES-', 'TL-', 'NU-', 'ECON-', 'FW-', 'ADV-'];

const CODE_SHAPE = /^[A-Z0-9-]{3,40}$/;
const MAX_CANDIDATES = 10;

/**
 * All the ways the guest's raw code could be stored, best-guess first.
 * Pure + bounded: uppercase, spaces stripped; rejects junk shapes outright
 * (the same fail-closed posture as the kiosk/voice context whitelists).
 */
export function generateCodeVariants(raw) {
  if (typeof raw !== 'string') return [];
  // Trailing/leading punctuation is keyboard/OCR noise ("ZE123." / "'ZE123"),
  // not a different code — strip it before the shape check rejects the input.
  const clean = raw.trim().toUpperCase().replace(/\s+/g, '').replace(/^[^A-Z0-9]+|[^A-Z0-9]+$/g, '');
  if (!CODE_SHAPE.test(clean)) return [];

  const out = [];
  const push = (v) => {
    if (v && CODE_SHAPE.test(v) && !out.includes(v)) out.push(v);
  };

  // 1. Exactly what they typed (uppercased) — the only 'exact' candidate.
  push(clean);

  const prefixed = KNOWN_PREFIXES.find((p) => clean.startsWith(p));
  if (prefixed) {
    // 2. They read the FULL system number but the lookup field wants the bare
    //    source ref (or vice-versa elsewhere): strip the known prefix.
    push(clean.slice(prefixed.length));
  } else {
    // 3. Dashless prefix ("TLZE…" spoken/typed without the dash).
    for (const p of KNOWN_PREFIXES) {
      const bare = p.slice(0, -1); // 'TL-' -> 'TL'
      if (clean.startsWith(bare) && clean.length > bare.length) {
        push(`${p}${clean.slice(bare.length)}`);
      }
    }
    // 4. The OTA gave them the bare source ref → try every import prefix.
    for (const p of KNOWN_PREFIXES) push(`${p}${clean}`);
  }

  // 5. Leading-zero tolerance. A code read aloud picks up a stray leading zero
  //    on the way through transcription: measured in a live Chloe call
  //    (2026-08-06) where the caller said "r e s one zero seven one six zero"
  //    for RES-107160 and the lookup arrived as RES0107160 — three times.
  //    Bounded HARD: an ALL-DIGIT tail only, leading zeros only, and appended
  //    LAST so a genuine match always outranks it. If both codes happen to
  //    exist, both come back as candidates — already this matcher's contract,
  //    and each stays masked until the caller proves a datum.
  for (const v of [...out]) {
    const p = KNOWN_PREFIXES.find((k) => v.startsWith(k));
    const tail = p ? v.slice(p.length) : v;
    if (!/^0\d{2,}$/.test(tail)) continue;
    const stripped = tail.replace(/^0+/, '');
    if (stripped.length >= 3) push(`${p ?? ''}${stripped}`);
  }
  return out;
}

/** Rank position → confidence. Exact input match beats any variant. */
function variantConfidence(index) {
  return Math.max(60, 90 - index * 3);
}

/**
 * Find candidate reservations for a guest-supplied code and/or name.
 * `prisma` is injected (testable with a fake; callers pass the app client).
 * READ-ONLY by construction — the only query used is findMany.
 */
export async function smartMatchReservation({ code, name, dateWindow, tenantId }, { prisma }) {
  if (!tenantId || typeof tenantId !== 'string') {
    throw new Error('smartMatchReservation: tenantId is required (hard tenant scope)');
  }
  if (!prisma) throw new Error('smartMatchReservation: prisma client is required');

  const select = {
    id: true,
    reservationNumber: true,
    status: true,
    pickupAt: true,
    customer: { select: { firstName: true, lastName: true } },
  };
  const results = [];

  const variants = generateCodeVariants(code ?? '');
  if (variants.length) {
    const rows = await prisma.reservation.findMany({
      where: {
        tenantId,
        OR: variants.map((v) => ({ reservationNumber: { equals: v, mode: 'insensitive' } })),
      },
      select,
      // Never fewer rows than variants asked for. Pass 5 doubled the worst
      // case (8 -> 16) past this cap, and the query has no orderBy — so a
      // truncation that used to be structurally impossible would silently
      // drop an arbitrary candidate (Innovation SC2).
      take: Math.max(MAX_CANDIDATES, variants.length),
    });
    // Rank by which variant matched (variant order is already best-first;
    // variants[0] IS the cleaned input — same normalization, incl. the
    // punctuation strip, so 'exact' can't drift from the generator).
    const cleanInput = variants[0];
    for (const r of rows) {
      const upper = String(r.reservationNumber ?? '').toUpperCase();
      const idx = variants.indexOf(upper);
      const exact = upper === cleanInput;
      results.push({
        reservation: r,
        matchType: exact ? 'exact' : 'variant',
        confidence: exact ? 100 : variantConfidence(idx === -1 ? variants.length : idx),
      });
    }
  }

  // Name fallback ONLY when the code produced nothing (a code hit is always
  // the better signal; mixing both would just dilute the ranking).
  if (!results.length && typeof name === 'string' && name.trim().length >= 3) {
    const tokens = name.trim().split(/\s+/).filter((t) => t.length >= 2).slice(0, 4);
    // Innovation SC3: a single 3-char token ("mar") nets a whole page of
    // customers — the UX always asks for the FULL name, so require 2+ tokens.
    if (tokens.length >= 2) {
      const from = dateWindow?.from instanceof Date ? dateWindow.from : new Date(Date.now() - 24 * 3600 * 1000);
      const to = dateWindow?.to instanceof Date ? dateWindow.to : new Date(Date.now() + 30 * 24 * 3600 * 1000);
      const rows = await prisma.reservation.findMany({
        where: {
          tenantId,
          pickupAt: { gte: from, lte: to },
          customer: {
            AND: tokens.map((t) => ({
              OR: [
                { firstName: { contains: t, mode: 'insensitive' } },
                { lastName: { contains: t, mode: 'insensitive' } },
              ],
            })),
          },
        },
        select,
        orderBy: { pickupAt: 'asc' },
        take: MAX_CANDIDATES,
      });
      for (const r of rows) {
        results.push({ reservation: r, matchType: 'name', confidence: 60 });
      }
    }
  }

  results.sort((a, b) => b.confidence - a.confidence);
  return results;
}

/**
 * Masked stub for a NON-verified candidate: enough for "¿es la tuya?", never
 * enough to steal details. Innovation MC1/MC2 (2026-07-19):
 *   - NO id — the service account can GET /:id with a cuid, so a leaked id
 *     is one hop from the full row (the unmask flow re-sends code/name +
 *     verify data; it never needs the id).
 *   - NO exact pickupDate — the exact date IS the verification proof; echoing
 *     it made the gate a self-answering oracle ("pickup June 12 — is that
 *     yours?" → "yes, June 12" → verified). Month granularity keeps the
 *     conversation useful while the caller must produce the DAY themselves.
 *   - NO status — pre-verify it disclosed that a named person's car is out.
 */
export function maskCandidate({ reservation, matchType, confidence }) {
  const first = reservation.customer?.firstName ?? '';
  const lastInitial = (reservation.customer?.lastName ?? '').charAt(0);
  const pickup = reservation.pickupAt instanceof Date
    ? reservation.pickupAt.toISOString().slice(0, 10)
    : String(reservation.pickupAt ?? '').slice(0, 10);
  return {
    matchType,
    confidence,
    maskedName: `${first} ${lastInitial ? `${lastInitial}.` : ''}`.trim(),
    pickupMonth: pickup.slice(0, 7),
  };
}

const foldName = (s) =>
  String(s ?? '').trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

/**
 * Connectives that carry no identity. "De La Cruz" and "De Jesús" are not the
 * same family, but they share "de" — and with plain token containment that
 * particle was a full-strength proof of identity. QA demonstrated the unmask:
 * a caller giving their own truthful "De Jesus" pulled a stranger's "De La
 * Cruz" out of the same prefix fan-out. In Puerto Rico these particles are
 * everywhere, so this was worst exactly where the change was meant to help.
 */
const SURNAME_PARTICLES = new Set([
  'de', 'del', 'la', 'las', 'lo', 'los', 'el', 'y', 'da', 'das', 'do', 'dos',
  'di', 'du', 'le', 'van', 'von', 'san', 'santa', 'st', 'saint',
]);

/** How many spoken tokens may be offered at once. Uncapped, one request was N
 *  guesses: a bag of eleven common surnames matched almost any row (QA). Real
 *  callers say one surname, at most a compound pair. */
const MAX_SPOKEN_TOKENS = 2;

/** Comparable surname tokens: accent- and case-folded, 2+ chars so a bare
 *  initial is never a token, particles dropped. Kept at 2 (not 3) because
 *  short surnames — Ng, Li, Wu — are real, and failing them closed would just
 *  push honest guests onto the pickup-date path for no security gain. */
function surnameTokens(v) {
  return foldName(v)
    .replace(/[^a-z\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 1 && !SURNAME_PARTICLES.has(t));
}

/**
 * Does a spoken surname belong to this booking?
 *
 * TOKEN CONTAINMENT, not whole-string (Hector's decision, 2026-08-06). Whole
 * string meant a guest whose booking reads "Gonzalez Perez" could never get
 * past the gate by saying "Perez" — and half of Puerto Rico carries two
 * surnames, so the honest guest was the one it stopped. Either side may be the
 * longer form; one shared token is enough.
 *
 * KNOW WHAT THIS ACTUALLY GOVERNS. An `exact` candidate short-circuits to
 * verified in the route and never reaches here; a `name` candidate has its
 * surname ignored (below). So this comparator decides exactly one population:
 * `variant` candidates — rows the matcher GUESSED by expanding prefixes and
 * leading zeros. A spoken "107160" fans out to RES-/TL-/NU-/ECON-/FW-/ADV-
 * 107160, and at most one of those is the caller's. Everything else in that
 * list belongs to a stranger, which is why the comparator has to be narrow:
 * it is the only thing standing between a caller's own truthful surname and
 * somebody else's booking.
 */
export function lastNameMatches(spoken, onFile) {
  // The spoken side is capped; the stored side is authoritative and is not.
  const a = surnameTokens(spoken).slice(-MAX_SPOKEN_TOKENS);
  const b = surnameTokens(onFile);
  if (!a.length || !b.length) return false;
  return a.some((t) => b.includes(t));
}

/**
 * Is this pickup date usable as proof at all?
 *
 * THE ONE definition, exported, because there were briefly two: the verifier
 * required `YYYY-MM-DD` and silently discarded anything else, while the
 * throttle only asked "is a date present?". A caller saying "08/06/2026" or
 * "ayer" therefore bought a charge for a verification that could not run — and
 * paired with a surname it defeated the carve-out that keeps an honest guest
 * from paying. Since `verifyPickupDate` is a free-form string an LLM fills in,
 * that is a formatting slip, not an attack (QA, 2026-08-06).
 */
export function isVerifiablePickupDate(v) {
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v.trim());
}

/**
 * Server-side identity gate: does the caller-provided datum actually belong
 * to this candidate? Verified ⇒ the route may unmask. pickupDate tolerates
 * ±1 day (Innovation SC1: UTC-vs-Florida rollover would fail an honest guest
 * with an evening pickup; 3 dates out of a ~36,500 guess space stays closed).
 *
 * `matchType` is how the candidate was FOUND, and it is load-bearing — see
 * the name-search carve-out below.
 */
export function candidateMatchesVerification(reservation, { lastName, pickupDate } = {}, { matchType } = {}) {
  const checks = [];
  // A datum that SELECTED a candidate can never also PROVE it.
  //
  // The name search matches tokens against firstName OR lastName, so honoring
  // the last name here let ONE guessed string both find a stranger's booking
  // and unmask it — a self-answering oracle. QA demonstrated the full unmask
  // on 2026-08-06: number, exact date, status and the internal cuid that
  // maskCandidate deliberately withholds, out of a two-token name and nothing
  // else. That directly contradicted the guarantee the route advertises.
  //
  // For a name-selected candidate the caller must produce something the search
  // did NOT use: the exact pickup date (or come back with the code).
  if (matchType !== 'name' && typeof lastName === 'string' && lastName.trim()) {
    checks.push(lastNameMatches(lastName, reservation.customer?.lastName));
  }
  if (isVerifiablePickupDate(pickupDate)) {
    // Calendar-day distance (both sides at UTC midnight), so a 14:00Z pickup
    // doesn't skew the tolerance window.
    const pickupDay = reservation.pickupAt instanceof Date
      ? reservation.pickupAt.toISOString().slice(0, 10)
      : String(reservation.pickupAt ?? '').slice(0, 10);
    const dayDiff = Math.abs(
      (Date.parse(`${pickupDay}T00:00:00Z`) - Date.parse(`${pickupDate.trim()}T00:00:00Z`)) / (24 * 3600 * 1000),
    );
    checks.push(Number.isFinite(dayDiff) && dayDiff <= 1);
  }
  // Fail closed: no verifiable datum provided → NOT verified.
  return checks.length > 0 && checks.every(Boolean);
}
