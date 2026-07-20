/**
 * Ride Kiosk — smart-match SEAM (Fase B3g, 2026-07-19).
 * Spec: doc/kiosk-e2e-spec-2026-07-04.md (B3g). Contract needs the kiosk
 * publishes for S30: doc/kiosk-smart-match-contract-needs-2026-07-19.md.
 *
 * SINGLE SOURCE OF TRUTH RULE (like vehicle-status-sync): the kiosk NEVER
 * invents its own confirmation-code normalizer / variant generator. The
 * matcher `smartMatchReservation({ code?, name?, dateWindow?, tenantId })`
 * is owned and delivered by the S30/VozIA workstream in
 * `backend/src/lib/reservation-smart-match.js`. That file is NOT in the tree
 * yet — this module must therefore NOT statically import it (a missing
 * top-level import is the #1 prod boot-crash cause).
 *
 * ── THE SINGLE WIRE-IN POINT ────────────────────────────────────────────────
 * TODO(S30): once backend/src/lib/reservation-smart-match.js lands, wire the
 * real matcher with ONE line at the bottom of this file:
 *     import { smartMatchReservation } from '../../lib/reservation-smart-match.js';
 *     setKioskSmartMatcher(smartMatchReservation);
 * Nothing else in the kiosk changes. Until then `kioskSmartMatch` returns
 * null and lookupReservation runs the INTERIM path (exact code + name+phone +
 * name+pickupDate — NO variant generation, which is the only lib-dependent
 * capability).
 *
 * The matcher is READ-ONLY and TENANT-SCOPED. Its returned reservations are
 * treated as UNTRUSTED candidate refs: the kiosk re-fetches each id through
 * its own location + pickup-window + status scoping before anything is
 * surfaced, so the kiosk's privacy/scoping guarantees hold regardless of the
 * matcher's output.
 */

// Injected by the one-line wire-in above (or by a test mock of the contract
// shape). Null → interim runtime.
let matcher = null;

/**
 * Wire the real matcher (production) or a contract-shaped mock (tests).
 * @param {null | (input: {code?, name?, dateWindow?, tenantId}) =>
 *   Promise<Array<{ reservation: {id: string}, matchType: 'exact'|'variant'|'name', confidence: number }>>} fn
 */
export function setKioskSmartMatcher(fn) {
  matcher = typeof fn === 'function' ? fn : null;
}

export function isKioskSmartMatchEnabled() {
  return typeof matcher === 'function';
}

/**
 * Call the shared matcher, or null when it isn't wired yet (interim). Returns
 * the matcher's ranked array verbatim — the caller re-scopes/re-fetches.
 */
export async function kioskSmartMatch(input) {
  if (typeof matcher !== 'function') return null;
  const ranked = await matcher(input);
  return Array.isArray(ranked) ? ranked : [];
}

// ── S30 WIRE-IN (2026-07-19) — the lib landed; the seam goes LIVE ───────────
// smartMatchReservation takes an injected prisma ({ prisma }) so its core
// stays DB-free-testable; the seam's single-arg contract gets a closure.
import { smartMatchReservation } from '../../lib/reservation-smart-match.js';
import { prisma } from '../../lib/prisma.js';
setKioskSmartMatcher((input) => smartMatchReservation(input, { prisma }));
