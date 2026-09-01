/**
 * Tolls redesign A — triage lib + chip map tests.
 *
 * Pins: (1) the reason-token → human chip map (EN + ES, verbatim from
 * design/mockups/tolls-redesign-NOTES.md §2), (2) max-3 inline chips with
 * "+N more" overflow, (3) tone assignment, (4) score → lane bucketing,
 * (5) the six DB-view predicates still filter correctly, (6) every legacy
 * row action stays reachable (primary + overflow), (7) the raw comma string
 * is never a chip label.
 */
import { describe, it, expect } from 'vitest';
import en from '../src/locales/en.json';
import es from '../src/locales/es.json';
import {
  TOLL_REASON_CHIPS,
  TOLL_LANE_GROUPS,
  TOLL_QUEUE_VIEWS,
  laneForScore,
  confidenceForRow,
  reasonChipsForRow,
  inlineChipsForRow,
  scoreLedgerForRow,
  filterByQueueView,
  matchesQueueView,
  primaryActionForRow,
  overflowActionsForRow,
  MAX_INLINE_CHIPS
} from '../src/lib/toll-triage';

const lookup = (bundle, key) => key.split('.').reduce((acc, part) => acc?.[part], bundle);

function rowWithReason(matchReason, extra = {}) {
  return {
    id: 't1',
    needsReview: true,
    matchConfidence: 64,
    latestAssignment: { reservation: { id: 'r1', reservationNumber: 'TL-1' }, matchReason },
    ...extra
  };
}

describe('reason-token chip map', () => {
  it('every mapped token has an EN and ES label in the locale files', () => {
    const canonical = new Set(Object.entries(TOLL_REASON_CHIPS).map(([token, def]) => def.alias || token));
    for (const token of canonical) {
      const enLabel = lookup(en, `tolls.reasons.${token}`);
      const esLabel = lookup(es, `tolls.reasons.${token}`);
      expect(enLabel, `EN label for ${token}`).toBeTruthy();
      expect(esLabel, `ES label for ${token}`).toBeTruthy();
    }
  });

  it('matches the approved NOTES map verbatim (spot checks, EN + ES)', () => {
    expect(lookup(en, 'tolls.reasons.vehicleResponsibilityWindow')).toBe('Vehicle responsible at that time');
    expect(lookup(es, 'tolls.reasons.vehicleResponsibilityWindow')).toBe('Vehículo responsable en ese momento');
    expect(lookup(en, 'tolls.reasons.plate')).toBe('Plate match');
    expect(lookup(es, 'tolls.reasons.plate')).toBe('Tablilla coincide');
    expect(lookup(en, 'tolls.reasons.withinGraceWindow')).toBe('Grace window only');
    expect(lookup(es, 'tolls.reasons.withinGraceWindow')).toBe('Solo ventana de gracia');
    expect(lookup(en, 'tolls.reasons.vehicleNotOnRentalAtThatTime')).toBe('Different vehicle on rental (swap)');
    expect(lookup(es, 'tolls.reasons.vehicleNotOnRentalAtThatTime')).toBe('Otro vehículo en la renta (swap)');
    expect(lookup(en, 'tolls.reasons.vehicle-outside-location')).toBe('Vehicle outside this sede');
    expect(lookup(es, 'tolls.reasons.vehicle-outside-location')).toBe('Vehículo fuera de esta sede');
    expect(lookup(en, 'tolls.reasons.manual-confirmed')).toBe('Confirmed by staff');
    expect(lookup(es, 'tolls.reasons.manual-confirmed')).toBe('Confirmado por el personal');
  });

  it('maps a real matcher string to human chips, strongest first', () => {
    const row = rowWithReason('vehicleResponsibilityWindow,currentVehicleId,plate,withinTripWindow,effectiveVehicleTripWindow');
    const chips = reasonChipsForRow(row);
    // identifier (plate) outranks windows
    expect(chips[0].token).toBe('plate');
    expect(chips.map((c) => c.token)).toContain('vehicleResponsibilityWindow');
    // keys resolve in BOTH locales
    for (const chip of chips) {
      expect(lookup(en, chip.key)).toBeTruthy();
      expect(lookup(es, chip.key)).toBeTruthy();
    }
  });

  it('NEVER emits the raw comma string or raw tokens as labels', () => {
    const raw = 'currentVehicleId,agreementVehicleId,plate,sello,withinGraceWindow,multipleCandidates';
    const chips = reasonChipsForRow(rowWithReason(raw));
    for (const chip of chips) {
      const label = lookup(en, chip.key);
      expect(label).not.toMatch(/,/);
      expect(label).not.toBe(chip.token);
    }
  });

  it('caps inline chips at 3 with an overflow count', () => {
    const row = rowWithReason('vehicleResponsibilityWindow,currentVehicleId,agreementVehicleId,plate,sello,withinTripWindow,effectiveVehicleTripWindow');
    const all = reasonChipsForRow(row);
    expect(all.length).toBeGreaterThan(MAX_INLINE_CHIPS);
    const { chips, overflow } = inlineChipsForRow(row);
    expect(chips).toHaveLength(3);
    expect(overflow).toBe(all.length - 3);
  });

  it('assigns tones: ok for supporters, warn for weakeners, bad for disqualifiers', () => {
    const chips = reasonChipsForRow(rowWithReason('plate,withinGraceWindow,vehicleNotOnRentalAtThatTime'));
    const byToken = Object.fromEntries(chips.map((c) => [c.token, c.tone]));
    expect(byToken.plate).toBe('ok');
    expect(byToken.withinGraceWindow).toBe('warn');
    expect(byToken.vehicleNotOnRentalAtThatTime).toBe('bad');
  });

  it('escalates noStrongIdentifier warn→bad in the red lane', () => {
    const mid = reasonChipsForRow(rowWithReason('noStrongIdentifier', { matchConfidence: 64 }));
    expect(mid.find((c) => c.token === 'noStrongIdentifier').tone).toBe('warn');
    const low = reasonChipsForRow(rowWithReason('noStrongIdentifier', { matchConfidence: 20 }));
    expect(low.find((c) => c.token === 'noStrongIdentifier').tone).toBe('bad');
  });

  it('aliases the dashed dispatch suffix onto the camelCase chip without duplicating', () => {
    const chips = reasonChipsForRow(rowWithReason('plate,dispatchConfirmationRequired,dispatch-confirmation-required'));
    const dispatchChips = chips.filter((c) => c.token === 'dispatchConfirmationRequired');
    expect(dispatchChips).toHaveLength(1);
  });

  it('drops unknown tokens instead of rendering them', () => {
    const chips = reasonChipsForRow(rowWithReason('plate,someFutureToken'));
    expect(chips.map((c) => c.token)).toEqual(['plate']);
  });

  it('adds the toll-package info chip from coverage, and manual-review as fallback', () => {
    const covered = reasonChipsForRow({ coveredByTollPackage: true, latestAssignment: { matchReason: 'sello' } });
    expect(covered.map((c) => c.token)).toContain('covered-by-toll-package');
    const bare = reasonChipsForRow({ needsReview: true, latestAssignment: null });
    expect(bare.map((c) => c.token)).toEqual(['manual-review']);
  });
});

describe('score ledger (evidence drawer)', () => {
  it('shows the matcher arithmetic with the −10/−30 multipleCandidates split', () => {
    const inWindow = scoreLedgerForRow(rowWithReason('plate,withinTripWindow,multipleCandidates'));
    expect(inWindow.find((e) => e.token === 'multipleCandidates').pts).toBe('−10');
    const outWindow = scoreLedgerForRow(rowWithReason('plate,multipleCandidates'));
    expect(outWindow.find((e) => e.token === 'multipleCandidates').pts).toBe('−30');
    expect(inWindow.find((e) => e.token === 'plate').pts).toBe('+25');
  });

  it('marks caps and penalties as negative entries', () => {
    const entries = scoreLedgerForRow(rowWithReason('vehicleResponsibilityWindow,noStrongIdentifier,multipleCandidates'));
    expect(entries.find((e) => e.token === 'noStrongIdentifier').negative).toBe(true);
    expect(entries.find((e) => e.token === 'vehicleResponsibilityWindow').negative).toBe(false);
  });
});

describe('lane bucketing', () => {
  it('score → lane: green >=85, amber 40–84, red <40, none when absent', () => {
    expect(laneForScore(92)).toBe('high');
    expect(laneForScore(85)).toBe('high');
    expect(laneForScore(84)).toBe('mid');
    expect(laneForScore(40)).toBe('mid');
    expect(laneForScore(39)).toBe('low');
    expect(laneForScore(0)).toBe('low');
    expect(laneForScore(null)).toBe('none');
    expect(laneForScore(undefined)).toBe('none');
  });

  it('confidence falls back from transaction to latest assignment', () => {
    expect(confidenceForRow({ matchConfidence: 90 })).toBe(90);
    expect(confidenceForRow({ latestAssignment: { confidence: 55 } })).toBe(55);
    expect(confidenceForRow({})).toBe(null);
  });

  it('the lane rail regroups ALL six views (plus All) — nothing removed', () => {
    const railViews = TOLL_LANE_GROUPS.flatMap((g) => g.views);
    expect(railViews.sort()).toEqual([...TOLL_QUEUE_VIEWS].sort());
    expect(railViews).toHaveLength(7);
  });
});

describe('DB-view filtering (same predicates the old tabs used)', () => {
  const autoMatched = { id: 'a', reservation: { id: 'r' }, needsReview: false, status: 'MATCHED', billingStatus: 'POSTED_TO_RESERVATION' };
  const readyToPost = { id: 'b', reservation: { id: 'r' }, needsReview: false, status: 'MATCHED', billingStatus: 'PENDING' };
  const needsReview = { id: 'c', needsReview: true, matchConfidence: 64, vehicle: { id: 'v' }, latestAssignment: { reservation: { id: 'r' } } };
  const unmatched = { id: 'd', needsReview: false, status: 'IMPORTED' };
  const dispatch = { id: 'e', needsReview: true, dispatchConfirmationRequired: true, reservation: { id: 'r' }, matchConfidence: 79 };
  const usage = { id: 'f', reservation: { id: 'r' }, coveredByTollPackage: true, billingMode: 'USAGE_ONLY', needsReview: false, status: 'MATCHED', billingStatus: 'PENDING' };
  const rows = [autoMatched, readyToPost, needsReview, unmatched, dispatch, usage];

  it('ALL returns everything', () => {
    expect(filterByQueueView('ALL', rows)).toHaveLength(rows.length);
  });

  it('AUTO_MATCHED = attributed, not in review, MATCHED/BILLED (package rows included, same as the DB queueWhere)', () => {
    expect(filterByQueueView('AUTO_MATCHED', rows).map((r) => r.id).sort()).toEqual(['a', 'b', 'f']);
  });

  it('NEEDS_REVIEW = flagged AND has something to accept/reject', () => {
    expect(filterByQueueView('NEEDS_REVIEW', rows).map((r) => r.id).sort()).toEqual(['c', 'e']);
  });

  it('UNMATCHED = no reservation and no actionable suggestion', () => {
    expect(filterByQueueView('UNMATCHED', rows).map((r) => r.id)).toEqual(['d']);
  });

  it('DISPATCH_REVIEW / USAGE_ONLY / READY_TO_POST', () => {
    expect(filterByQueueView('DISPATCH_REVIEW', rows).map((r) => r.id)).toEqual(['e']);
    expect(filterByQueueView('USAGE_ONLY', rows).map((r) => r.id)).toEqual(['f']);
    expect(filterByQueueView('READY_TO_POST', rows).map((r) => r.id)).toEqual(['b']);
  });

  it('usage-only never counts as ready-to-post', () => {
    expect(matchesQueueView('READY_TO_POST', usage)).toBe(false);
  });
});

describe('one primary action per row — everything else stays reachable', () => {
  it('picks the state-appropriate primary', () => {
    expect(primaryActionForRow({ coveredByTollPackage: true })).toBe('USAGE');
    expect(primaryActionForRow({ dispatchConfirmationRequired: true, reservation: { id: 'r' } })).toBe('DISPATCHED');
    expect(primaryActionForRow({ latestAssignment: { reservation: { id: 'r' } }, needsReview: true })).toBe('CONFIRM');
    expect(primaryActionForRow({ reservation: { id: 'r' }, billingStatus: 'PENDING', needsReview: false })).toBe('POST');
    expect(primaryActionForRow({ needsReview: false, status: 'IMPORTED' })).toBe('ASSIGN');
    expect(primaryActionForRow({ needsReview: true, vehicle: { id: 'v' }, matchConfidence: 41 })).toBe('REVIEW');
  });

  it('a typed reservation draft turns Assign into Confirm', () => {
    expect(primaryActionForRow({ needsReview: false, status: 'IMPORTED' }, { hasDraft: true })).toBe('CONFIRM');
  });

  it('Reset / Dispute / Waive remain reachable in the overflow menu', () => {
    const row = { latestAssignment: { reservation: { id: 'r' } }, needsReview: true, billingStatus: 'PENDING' };
    const items = overflowActionsForRow(row);
    expect(items).toContain('RESET_MATCH');
    expect(items).toContain('MARK_DISPUTED');
    expect(items).toContain('MARK_NOT_BILLABLE');
    // Confirm is the primary — not duplicated in the overflow
    expect(items).not.toContain('CONFIRM_MATCH');
  });

  it('dispatch rows keep BOTH Dispatched and Not-dispatched reachable', () => {
    const row = { dispatchConfirmationRequired: true, reservation: { id: 'r' }, billingStatus: 'PENDING' };
    expect(primaryActionForRow(row)).toBe('DISPATCHED');
    expect(overflowActionsForRow(row)).toContain('MARK_NOT_DISPATCHED');
  });

  it('a displaced Confirm stays reachable when Dispatched is primary', () => {
    const row = { dispatchConfirmationRequired: true, reservation: { id: 'r' }, latestAssignment: { reservation: { id: 'r' } }, billingStatus: 'PENDING' };
    expect(overflowActionsForRow(row)).toContain('CONFIRM_MATCH');
  });

  it('already-disputed rows do not offer Dispute again (same as the old buttons)', () => {
    const row = { reservation: { id: 'r' }, billingStatus: 'DISPUTED' };
    expect(overflowActionsForRow(row)).not.toContain('MARK_DISPUTED');
    expect(overflowActionsForRow(row)).toContain('MARK_NOT_BILLABLE');
  });
});

describe('tolls locale namespace parity', () => {
  const flat = (obj, prefix = '') => Object.entries(obj).flatMap(([k, v]) => (
    typeof v === 'object' && v !== null ? flat(v, `${prefix}${k}.`) : [`${prefix}${k}`]
  ));

  it('EN and ES tolls namespaces carry identical keys (the merge gotcha guard)', () => {
    expect(en.tolls).toBeDefined();
    expect(es.tolls).toBeDefined();
    expect(flat(en.tolls).sort()).toEqual(flat(es.tolls).sort());
  });

  it('no EN string leaked into ES for the chip labels', () => {
    const same = Object.keys(en.tolls.reasons).filter((k) => en.tolls.reasons[k] === es.tolls.reasons[k]);
    // "Tag"-style short labels can legitimately coincide; the map itself must not.
    expect(same).not.toContain('vehicleResponsibilityWindow');
    expect(same).not.toContain('withinTripWindow');
    expect(same).not.toContain('manual-review');
  });
});
