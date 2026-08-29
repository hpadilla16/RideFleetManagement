/**
 * Toll triage helpers — Tolls redesign A ("Confidence triage lanes",
 * approved 2026-08-28). Pure functions so they are unit-testable.
 *
 * Sources of truth:
 *  - Reason-token → human chip map: design/mockups/tolls-redesign-NOTES.md §2
 *    (tokens emitted by backend/src/modules/tolls/tolls.service.js
 *    scoreCandidate ~1013-1110 and the no-candidate paths ~1160-1210).
 *  - Lanes: the 3-bucket confidence grouping over the SAME six DB-counted
 *    queue views the module has always had. Nothing removed.
 *
 * RULE: the raw comma-joined matchReason string is NEVER rendered in the
 * queue. It may survive as a title attribute / debug row in the evidence
 * drawer for support calls.
 */

export const TOLL_QUEUE_VIEWS = ['ALL', 'AUTO_MATCHED', 'NEEDS_REVIEW', 'UNMATCHED', 'DISPATCH_REVIEW', 'USAGE_ONLY', 'READY_TO_POST'];

/** Lane rail: the six views (plus All) regrouped under confidence headings. */
export const TOLL_LANE_GROUPS = [
  { id: 'EVERYTHING', tone: 'all', views: ['ALL'] },
  { id: 'CONFIDENT', tone: 'ok', views: ['AUTO_MATCHED', 'READY_TO_POST', 'USAGE_ONLY'] },
  { id: 'NEEDS_EYES', tone: 'warn', views: ['NEEDS_REVIEW', 'DISPATCH_REVIEW'] },
  { id: 'NO_MATCH', tone: 'bad', views: ['UNMATCHED'] }
];

/** Auto-confirm threshold — mirrors tolls.service.js (score >= 85 = AUTO_CONFIRMED). */
export const AUTO_CONFIRM_SCORE = 85;

/** Green >= 85, amber 40–84, red < 40, none when the backend sent nothing. */
export function laneForScore(score) {
  if (score == null || Number.isNaN(Number(score))) return 'none';
  const n = Number(score);
  if (n >= AUTO_CONFIRM_SCORE) return 'high';
  if (n >= 40) return 'mid';
  return 'low';
}

/** The row's confidence: transaction-level matchConfidence, else the latest assignment's. */
export function confidenceForRow(row = {}) {
  if (row?.matchConfidence != null) return Number(row.matchConfidence);
  if (row?.latestAssignment?.confidence != null) return Number(row.latestAssignment.confidence);
  return null;
}

/* ------------------------------------------------------------------ */
/* Reason-token → chip map (verbatim from tolls-redesign-NOTES.md §2). */
/* tone: ok = supports the match, warn = weakens/complicates,          */
/* bad = disqualifies or blocks, info = neutral fact.                  */
/* priority: identifier matches first, then windows, then penalties.   */
/* pts: the matcher's real arithmetic, for the evidence ledger.        */
/* ------------------------------------------------------------------ */
export const TOLL_REASON_CHIPS = {
  plate: { tone: 'ok', priority: 10, pts: '+25' },
  tag: { tone: 'ok', priority: 11, pts: '+20' },
  sello: { tone: 'ok', priority: 12, pts: '+20' },
  multiSignalOverride: { tone: 'ok', priority: 13, pts: '—' },
  vehicleResponsibilityWindow: { tone: 'ok', priority: 20, pts: '+70' },
  withinTripWindow: { tone: 'ok', priority: 21, pts: '+25' },
  effectiveVehicleTripWindow: { tone: 'ok', priority: 22, pts: '+20' },
  currentVehicleId: { tone: 'ok', priority: 23, pts: '+15' },
  agreementVehicleId: { tone: 'ok', priority: 24, pts: '+10' },
  withinGraceWindow: { tone: 'warn', priority: 30, pts: '+10' },
  dispatchConfirmationRequired: { tone: 'warn', priority: 31, pts: 'cap 79' },
  // appendReviewCategory suffixes the same fact as a dashed token
  'dispatch-confirmation-required': { tone: 'warn', priority: 31, pts: 'cap 79', alias: 'dispatchConfirmationRequired' },
  noStrongIdentifier: { tone: 'warn', priority: 32, pts: 'cap 79' }, // warn→bad when the score lands low
  multipleCandidates: { tone: 'warn', priority: 33, pts: '−10 / −30' },
  vehicleNotOnRentalAtThatTime: { tone: 'bad', priority: 40, pts: '= 0' },
  'vehicle-not-found': { tone: 'bad', priority: 41, pts: '—' },
  'vehicle-outside-location': { tone: 'bad', priority: 42, pts: '—' },
  'vehicle-found-no-reservation-window': { tone: 'warn', priority: 43, pts: '—' },
  'multiple-vehicles-no-reservation': { tone: 'warn', priority: 44, pts: '—' },
  'vehicle-found-no-responsibility-window': { tone: 'warn', priority: 45, pts: '—' },
  'multiple-vehicles-no-responsibility-window': { tone: 'warn', priority: 46, pts: '—' },
  'manual-review': { tone: 'warn', priority: 50, pts: '—' },
  'manual-confirmed': { tone: 'ok', priority: 5, pts: '—' },
  'bulk-confirmed': { tone: 'ok', priority: 5, pts: '—' },
  'dispatch-confirmed': { tone: 'ok', priority: 5, pts: '—' },
  'covered-by-toll-package': { tone: 'info', priority: 15, pts: '—' }
};

/** i18n key for a token's chip label (labels live in locales en/es .json under tolls.reasons). */
export function reasonChipKey(token) {
  const def = TOLL_REASON_CHIPS[token];
  const canonical = def?.alias || token;
  return `tolls.reasons.${canonical}`;
}

export const TOLL_PACKAGE_NOTE = 'covered by prepaid toll package';

function splitReasonTokens(matchReason) {
  return String(matchReason || '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
}

/**
 * All chips for a row, strongest first. Each chip: { token, key, tone }.
 * - Unknown tokens are dropped (never rendered raw); the full raw string is
 *   available via rawReasonForRow for the evidence drawer's debug row.
 * - `noStrongIdentifier` escalates warn→bad when the score is in the red lane.
 * - The dashed dispatch suffix aliases onto the camelCase token (no dupes).
 * - Covered-by-package rows get their info chip from reviewNotes.
 */
export function reasonChipsForRow(row = {}) {
  const tokens = splitReasonTokens(row?.latestAssignment?.matchReason);
  const score = confidenceForRow(row);
  const seen = new Set();
  const chips = [];

  for (const token of tokens) {
    const def = TOLL_REASON_CHIPS[token];
    if (!def) continue;
    const canonical = def.alias || token;
    if (seen.has(canonical)) continue;
    seen.add(canonical);
    let tone = def.tone;
    if (canonical === 'noStrongIdentifier' && laneForScore(score) === 'low') tone = 'bad';
    chips.push({ token: canonical, key: `tolls.reasons.${canonical}`, tone, priority: def.priority });
  }

  const notes = String(row?.reviewNotes || '').toLowerCase();
  if ((row?.coveredByTollPackage || notes.includes(TOLL_PACKAGE_NOTE)) && !seen.has('covered-by-toll-package')) {
    const def = TOLL_REASON_CHIPS['covered-by-toll-package'];
    chips.push({ token: 'covered-by-toll-package', key: 'tolls.reasons.covered-by-toll-package', tone: def.tone, priority: def.priority });
  }

  if (!chips.length && row?.needsReview) {
    chips.push({ token: 'manual-review', key: 'tolls.reasons.manual-review', tone: 'warn', priority: 50 });
  }

  chips.sort((a, b) => a.priority - b.priority);
  return chips.map(({ priority, ...chip }) => chip);
}

export const MAX_INLINE_CHIPS = 3;

/** The queue renders at most 3 chips; the rest go behind "+N more" (evidence drawer). */
export function inlineChipsForRow(row = {}) {
  const all = reasonChipsForRow(row);
  return { chips: all.slice(0, MAX_INLINE_CHIPS), overflow: Math.max(0, all.length - MAX_INLINE_CHIPS) };
}

/** The raw string, for title attributes / the evidence debug row ONLY. */
export function rawReasonForRow(row = {}) {
  return row?.latestAssignment?.matchReason || row?.reviewNotes || '';
}

/**
 * Evidence-drawer score ledger: the matcher's real arithmetic per token.
 * Returns [{ token, key, pts, negative }] plus the total row is the caller's
 * job (the total is the stored matchConfidence — we display, not recompute).
 * The multipleCandidates penalty is −10 inside the trip window, −30 outside —
 * derivable from whether withinTripWindow is present (tolls.service.js:1095).
 */
export function scoreLedgerForRow(row = {}) {
  const tokens = splitReasonTokens(row?.latestAssignment?.matchReason);
  const withinTrip = tokens.includes('withinTripWindow');
  const seen = new Set();
  const entries = [];
  for (const token of tokens) {
    const def = TOLL_REASON_CHIPS[token];
    if (!def) continue;
    const canonical = def.alias || token;
    if (seen.has(canonical)) continue;
    seen.add(canonical);
    let pts = def.pts;
    if (canonical === 'multipleCandidates') pts = withinTrip ? '−10' : '−30';
    entries.push({
      token: canonical,
      key: `tolls.reasons.${canonical}`,
      pts,
      negative: pts.startsWith('−') || pts.startsWith('cap') || pts.startsWith('=')
    });
  }
  return entries;
}

/* ------------------------------------------------------------------ */
/* Queue-view predicates over SERIALIZED rows — moved verbatim from    */
/* tolls/page.js so the page and the tests share one definition.       */
/* (The DB counts stay authoritative: dashboard.queueCounts.)          */
/* ------------------------------------------------------------------ */
export function isUsageOnly(row = {}) {
  return !!row.coveredByTollPackage || row.billingMode === 'USAGE_ONLY';
}

export function isAutoMatched(row = {}) {
  return !!row.reservation?.id && !row.needsReview && ['MATCHED', 'BILLED'].includes(String(row.status || '').toUpperCase());
}

export function isNeedsReview(row = {}) {
  return !!row.needsReview && (!!row.reservation?.id || !!row.vehicle?.id || Number(row.matchConfidence || 0) > 0);
}

export function isUnmatched(row = {}) {
  return !isAutoMatched(row) && !isNeedsReview(row) && !row.reservation?.id;
}

export function isReadyToPost(row = {}) {
  return !!row.reservation?.id && row.billingStatus === 'PENDING' && !row.needsReview && !isUsageOnly(row);
}

export function matchesQueueView(view, row = {}) {
  switch (view) {
    case 'AUTO_MATCHED': return isAutoMatched(row);
    case 'NEEDS_REVIEW': return isNeedsReview(row);
    case 'UNMATCHED': return isUnmatched(row);
    case 'DISPATCH_REVIEW': return !!row.dispatchConfirmationRequired;
    case 'USAGE_ONLY': return isUsageOnly(row);
    case 'READY_TO_POST': return isReadyToPost(row);
    default: return true; // ALL
  }
}

export function filterByQueueView(view, rows = []) {
  const list = Array.isArray(rows) ? rows : [];
  return view && view !== 'ALL' ? list.filter((row) => matchesQueueView(view, row)) : list;
}

/**
 * ONE state-appropriate primary action per row (mockup §"One decision per
 * row"): CONFIRM / DISPATCHED / POST / REVIEW / ASSIGN — or USAGE (no charge,
 * nothing to do). Every OTHER action stays reachable via the overflow menu
 * (see overflowActionsForRow).
 */
export function primaryActionForRow(row = {}, { hasDraft = false } = {}) {
  if (isUsageOnly(row)) return 'USAGE';
  if (row.dispatchConfirmationRequired && row.reservation?.id) return 'DISPATCHED';
  if (row.latestAssignment?.reservation?.id || hasDraft) return 'CONFIRM';
  if (isReadyToPost(row)) return 'POST';
  if (isUnmatched(row) && !row.vehicle?.id) return 'ASSIGN';
  if (row.needsReview) return 'REVIEW';
  return 'REVIEW';
}

/**
 * Overflow (⋯) items for a row — the SAME conditions the old stacked buttons
 * used, minus whatever became the primary action. Nothing is dropped:
 * Confirm/Post stay reachable when displaced, Dispatched/Not dispatched,
 * Reset, Dispute, Waive keep their exact old visibility rules.
 */
export function overflowActionsForRow(row = {}, { hasDraft = false } = {}) {
  const primary = primaryActionForRow(row, { hasDraft });
  const items = [];
  if (row.dispatchConfirmationRequired && row.reservation?.id) {
    if (primary !== 'DISPATCHED') items.push('CONFIRM_DISPATCHED');
    items.push('MARK_NOT_DISPATCHED');
  }
  if ((row.latestAssignment?.reservation?.id || hasDraft) && primary !== 'CONFIRM') items.push('CONFIRM_MATCH');
  if (isReadyToPost(row) && primary !== 'POST') items.push('POST');
  if (row.latestAssignment?.reservation?.id || row.reservation?.id) items.push('RESET_MATCH');
  if (row.billingStatus !== 'DISPUTED') items.push('MARK_DISPUTED');
  if (row.billingStatus !== 'WAIVED') items.push('MARK_NOT_BILLABLE');
  return items;
}
