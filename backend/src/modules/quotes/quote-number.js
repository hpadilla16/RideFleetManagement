/**
 * Quotes module (2026-07-17) — voice-friendly quote numbers ("Q-1042").
 *
 * Per-tenant sequence: 1000 + (count of tenant quotes) + attempt. Uniqueness is
 * enforced by the (tenantId, quoteNumber) unique index; on a race the caller
 * retries with the next candidate (P2002 loop in quotes.service.create). Pure
 * helpers exported for unit tests.
 */

export const QUOTE_NUMBER_RE = /^[Qq]-\d{1,10}$/;

/** True when the param looks like a quote number ("Q-1042") vs an internal cuid. */
export function isQuoteNumber(value) {
  return QUOTE_NUMBER_RE.test(String(value ?? ''));
}

/** Normalize user/voice input to the canonical stored form ("q-1042 " → "Q-1042"). */
export function normalizeQuoteNumber(value) {
  return String(value ?? '').trim().toUpperCase();
}

/** Candidate number for the Nth attempt given the tenant's current quote count. */
export function quoteNumberCandidate(count, attempt = 0) {
  return `Q-${1000 + Number(count || 0) + 1 + Number(attempt || 0)}`;
}
