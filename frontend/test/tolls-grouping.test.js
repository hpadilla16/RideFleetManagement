/**
 * Tolls phase 2 — group-by-reservation math + candidate-window relation.
 *
 * Pins: (1) rows group by suggested/attached reservation in first-appearance
 * order with the unmatched bucket ALWAYS last, (2) the header numbers —
 * count, dollar total, MINIMUM confidence (the honest number to judge a
 * batch by), (3) "Confirm N" eligibility is the SAME predicate the toolbar's
 * Confirm All has always used, (4) the losing-candidate window relation, and
 * (5) the phase-2 i18n keys exist in BOTH languages (namespace-merge guard).
 */
import { describe, it, expect } from 'vitest';
import en from '../src/locales/en.json';
import es from '../src/locales/es.json';
import {
  groupRowsByReservation,
  isBulkConfirmEligible,
  candidateWindowRelation,
  UNGROUPED_KEY
} from '../src/lib/toll-triage';

const RES_A = { id: 'res-a', reservationNumber: 'TL-A', pickupAt: '2026-08-24T13:00:00Z', returnAt: '2026-08-29T13:00:00Z' };
const RES_B = { id: 'res-b', reservationNumber: 'TL-B', pickupAt: '2026-08-22T13:00:00Z', returnAt: '2026-08-26T13:00:00Z' };

function suggested(id, reservation, { amount = 1, confidence = 90, needsReview = true, ...rest } = {}) {
  return {
    id,
    amount,
    needsReview,
    matchConfidence: confidence,
    billingStatus: 'PENDING',
    latestAssignment: { id: `a-${id}`, status: 'SUGGESTED', confidence, reservation },
    ...rest
  };
}

describe('groupRowsByReservation', () => {
  it('groups by reservation, first-appearance order, unmatched bucket last', () => {
    const rows = [
      { id: 'u1', amount: 2.25, needsReview: true, vehicle: { id: 'v9' }, latestAssignment: null, reservation: null },
      suggested('t1', RES_A, { amount: 1.4, confidence: 92 }),
      suggested('t2', RES_B, { amount: 1.0, confidence: 58 }),
      suggested('t3', RES_A, { amount: 2.25, confidence: 88 })
    ];
    const groups = groupRowsByReservation(rows);
    expect(groups.map((g) => g.key)).toEqual(['res-a', 'res-b', UNGROUPED_KEY]);
    expect(groups[0].rows.map((r) => r.id)).toEqual(['t1', 't3']);
    expect(groups[2].rows.map((r) => r.id)).toEqual(['u1']);
  });

  it('header math: count, dollar total, MINIMUM confidence', () => {
    const groups = groupRowsByReservation([
      suggested('t1', RES_A, { amount: 1.4, confidence: 92 }),
      suggested('t2', RES_A, { amount: 1.4, confidence: 92 }),
      suggested('t3', RES_A, { amount: 2.25, confidence: 88 })
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].count).toBe(3);
    expect(groups[0].total).toBeCloseTo(5.05, 5);
    expect(groups[0].minConfidence).toBe(88);
  });

  it('minimum confidence ignores null scores and is null when nothing scored', () => {
    const withNull = groupRowsByReservation([
      suggested('t1', RES_A, { confidence: 71 }),
      { id: 't2', amount: 1, needsReview: true, matchConfidence: null, latestAssignment: { id: 'a2', status: 'SUGGESTED', confidence: null, reservation: RES_A } }
    ]);
    expect(withNull[0].minConfidence).toBe(71);
    const noScores = groupRowsByReservation([
      { id: 'u1', amount: 1, needsReview: true, vehicle: { id: 'v1' }, latestAssignment: null }
    ]);
    expect(noScores[0].minConfidence).toBeNull();
  });

  it('eligibleRows uses the toolbar predicate: 201 rows become the decisions Confirm N can batch', () => {
    const eligible = suggested('t1', RES_A);
    const usageOnly = suggested('t2', RES_A, { coveredByTollPackage: true });
    const notReview = suggested('t3', RES_A, { needsReview: false });
    const dispatch = {
      id: 't4', amount: 0.75, needsReview: true, dispatchConfirmationRequired: true,
      reservation: { ...RES_A }, latestAssignment: { id: 'a4', status: 'SUGGESTED', confidence: 79, reservation: RES_A }
    };
    const groups = groupRowsByReservation([eligible, usageOnly, notReview, dispatch]);
    expect(groups[0].eligibleRows.map((r) => r.id)).toEqual(['t1', 't4']);
    // and the group predicate IS the shared one
    expect(isBulkConfirmEligible(eligible)).toBe(true);
    expect(isBulkConfirmEligible(usageOnly)).toBe(false);
    expect(isBulkConfirmEligible(notReview)).toBe(false);
    expect(isBulkConfirmEligible(dispatch)).toBe(true);
  });

  it('the unmatched bucket never offers Confirm N', () => {
    const groups = groupRowsByReservation([
      { id: 'u1', amount: 1.4, needsReview: true, vehicle: { id: 'v1' }, latestAssignment: null, reservation: null }
    ]);
    expect(groups[0].key).toBe(UNGROUPED_KEY);
    expect(groups[0].eligibleRows).toEqual([]);
  });

  it('renter name comes from the attached reservation customer when present', () => {
    const groups = groupRowsByReservation([
      suggested('t1', RES_A, {
        reservation: { ...RES_A, customer: { firstName: 'M.', lastName: 'Rivera' } }
      })
    ]);
    expect(groups[0].renterName).toBe('M. Rivera');
  });
});

describe('candidateWindowRelation', () => {
  const toll = '2026-08-25T13:57:00Z';
  it('previous renter: window ended before this toll', () => {
    const rel = candidateWindowRelation({ reservation: { pickupAt: '2026-08-10T13:00:00Z', returnAt: '2026-08-24T09:12:00Z' } }, toll);
    expect(rel.kind).toBe('endedBefore');
    expect(rel.at).toBe('2026-08-24T09:12:00Z');
  });
  it('next renter: window starts after this toll', () => {
    const rel = candidateWindowRelation({ reservation: { pickupAt: '2026-08-26T13:00:00Z', returnAt: '2026-08-30T13:00:00Z' } }, toll);
    expect(rel.kind).toBe('startsAfter');
    expect(rel.at).toBe('2026-08-26T13:00:00Z');
  });
  it('competing window that also covers the toll', () => {
    expect(candidateWindowRelation({ reservation: RES_B }, toll).kind).toBe('covers');
  });
  it('missing or invalid dates → noWindow', () => {
    expect(candidateWindowRelation({ reservation: { pickupAt: null, returnAt: null } }, toll).kind).toBe('noWindow');
    expect(candidateWindowRelation({ reservation: RES_B }, null).kind).toBe('noWindow');
    expect(candidateWindowRelation({ reservation: { pickupAt: 'nope', returnAt: 'nada' } }, toll).kind).toBe('noWindow');
  });
});

describe('phase-2 locale keys exist in both languages', () => {
  const lookup = (bundle, key) => key.split('.').reduce((acc, part) => acc?.[part], bundle);
  const KEYS = [
    'tolls.group.toggle', 'tolls.group.noReservation', 'tolls.group.noReservationDesc',
    'tolls.group.count', 'tolls.group.minConf', 'tolls.group.confirmN', 'tolls.group.truncated',
    'tolls.foot.groups',
    'tolls.kbd.move', 'tolls.kbd.confirm', 'tolls.kbd.dispute', 'tolls.kbd.waive', 'tolls.kbd.clear',
    'tolls.evidence.otherCandidates', 'tolls.evidence.candidateEndedBefore',
    'tolls.evidence.candidateStartsAfter', 'tolls.evidence.candidateCovers',
    'tolls.evidence.candidateNoWindow', 'tolls.evidence.candidatesNotStored'
  ];
  it.each(KEYS)('%s', (key) => {
    expect(lookup(en, key), `en missing ${key}`).toBeTruthy();
    expect(lookup(es, key), `es missing ${key}`).toBeTruthy();
  });
});
