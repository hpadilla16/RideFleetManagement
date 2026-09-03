/**
 * Tolls matching config — the auto-confirm score threshold.
 *
 * Pure module on purpose: both `settings.service.js` (which persists the
 * per-tenant AppSetting) and `tolls.service.js` (which reads it once per
 * matching run) need the same normalization, and neither imports the other.
 * Keeping the rule here means the value written by the API and the value the
 * matcher enforces can never drift.
 *
 * WHY 70 IS THE DEFAULT (Hector, 2026-09-03): rows scoring 70+ were
 * consistently his own cars on inspection, so the old fixed 85 was holding
 * real matches in review. Below 70 still goes to a human.
 *
 * WHY THE CAPS ARE DERIVED, NOT LITERAL: two safety caps in scoreCandidate
 * exist to keep a match BELOW the auto-confirm line — (1) dispatch
 * confirmation required without a multi-signal override, and (2) the
 * RES-849093 FIX 1b invariant that a pure time-window match with no
 * plate/tag/sello must never auto-confirm. Both were written as
 * `Math.min(score, 79)` back when the threshold was a hardcoded 85, so 79 was
 * simply "85 minus a bit". The moment the threshold became configurable that
 * literal turned into a bug: at a threshold of 70, a capped 79 is ABOVE the
 * line and both caps silently invert into auto-confirming exactly the rows
 * they were built to hold. Hence `autoConfirmCapFor()` — the cap is always
 * `threshold - 1`, so the invariant holds at 70, at 85, and at anything else
 * a tenant configures.
 */

/** Hector's relaxed default (was a hardcoded 85 before 2026-09-03). */
export const DEFAULT_AUTO_CONFIRM_SCORE = 70;

/**
 * Accepted configuration band. Below 50 the matcher would auto-confirm on a
 * bare responsibility window (+70 alone clears any lower bar only via the
 * caps, but a tenant could still strip the review step down to noise); above
 * 100 no score can ever reach it, which would silently disable auto-confirm
 * altogether. Anything outside the band — or junk, or missing — reads as the
 * default rather than being clamped, so a typo can't quietly re-tune matching.
 */
export const MIN_AUTO_CONFIRM_SCORE = 50;
export const MAX_AUTO_CONFIRM_SCORE = 100;

/** Score at or above which a candidate is offered as a suggestion. */
export const SUGGESTED_SCORE = 60;

/**
 * Normalize a persisted/incoming autoConfirmScore into an effective threshold.
 * Junk, missing, non-finite and out-of-band values all fall back to the
 * default — never to a clamped edge value.
 */
export function normalizeAutoConfirmScore(value) {
  if (value === null || value === undefined || `${value}`.trim() === '') {
    return DEFAULT_AUTO_CONFIRM_SCORE;
  }
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_AUTO_CONFIRM_SCORE;
  const rounded = Math.round(n);
  if (rounded < MIN_AUTO_CONFIRM_SCORE || rounded > MAX_AUTO_CONFIRM_SCORE) {
    return DEFAULT_AUTO_CONFIRM_SCORE;
  }
  return rounded;
}

/**
 * The ceiling a safety cap must hold a score to, given the effective
 * threshold. Always one point below the line, so a capped candidate can never
 * satisfy `score >= threshold` no matter how the threshold is configured.
 * This replaced the magic number 79.
 */
export function autoConfirmCapFor(autoConfirmScore) {
  return normalizeAutoConfirmScore(autoConfirmScore) - 1;
}

/**
 * The queue status a scored candidate earns.
 *
 * Extracted from buildMatchSuggestion so the boundary is testable on its own:
 * auto-confirm is INCLUSIVE (`score >= threshold`), so a candidate scoring
 * exactly the threshold auto-confirms. A dispatch-confirmation candidate never
 * auto-confirms here regardless of score — that gate is upstream of the
 * threshold entirely.
 */
export function matchStatusForScore(score, { dispatchConfirmationRequired = false, autoConfirmScore } = {}) {
  if (dispatchConfirmationRequired) return 'SUGGESTED';
  const threshold = normalizeAutoConfirmScore(autoConfirmScore);
  const n = Number(score);
  if (!Number.isFinite(n)) return null;
  if (n >= threshold) return 'AUTO_CONFIRMED';
  if (n >= SUGGESTED_SCORE) return 'SUGGESTED';
  return null;
}

/** Shape returned by the settings service and echoed on the tolls queue API. */
export function normalizeTollsMatchConfig(cfg = null) {
  return { autoConfirmScore: normalizeAutoConfirmScore(cfg?.autoConfirmScore) };
}
