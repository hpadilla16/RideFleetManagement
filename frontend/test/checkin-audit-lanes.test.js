/**
 * Check-in audit — pure lane/chip/KPI logic (2026-09-03).
 * Pins, in order:
 *  (1) the lane rail matches Mock 1 (needs-review / resolved / everything)
 *      and the Possible-damage lane EXISTS even though T1 keeps it empty
 *  (2) the KPI strip has NO AI-spend tile (T1: no photo AI, no spend lie)
 *  (3) per-check chips carry the right tone + params (861 mi/day, missing
 *      angle count, backdate gap)
 *  (4) queue grouping: one row per reservation, findings in check order
 *  (5) detail-card row derivation from findings + the PASS summary
 *  (6) the dismiss fork's second verb is DAMAGE-only
 */
import { describe, it, expect } from 'vitest';
import {
  CHECKIN_AUDIT_LANE_GROUPS,
  CHECKIN_AUDIT_KPIS,
  LANE_QUERY,
  findingChip,
  groupRowsByReservation,
  mileageFuelAuditRows,
  entryAuditRows,
  canDismissPreexisting,
} from '../src/lib/checkin-audit-lanes';

describe('lane rail', () => {
  it('matches Mock 1: needsReview(damage, entry, mileageFuel) / resolved(passed, dismissed, resolvedOther) / everything(all)', () => {
    const ids = CHECKIN_AUDIT_LANE_GROUPS.map((g) => [g.id, g.lanes.map((l) => l.id)]);
    expect(ids).toEqual([
      ['needsReview', ['damage', 'entry', 'mileageFuel']],
      ['resolved', ['passed', 'dismissed', 'resolvedOther']],
      ['everything', ['all']],
    ]);
  });

  it('every lane id maps to an API lane query', () => {
    for (const g of CHECKIN_AUDIT_LANE_GROUPS) {
      for (const l of g.lanes) expect(LANE_QUERY[l.id]).toBeTruthy();
    }
  });
});

describe('KPI strip', () => {
  it('has exactly four tiles and NONE of them is the AI-spend tile', () => {
    expect(CHECKIN_AUDIT_KPIS.map((k) => k.id)).toEqual([
      'auditedToday', 'cleanPassToday', 'openDamage', 'openEntryErrors',
    ]);
    for (const k of CHECKIN_AUDIT_KPIS) {
      expect(k.id.toLowerCase()).not.toContain('spend');
      expect(k.id.toLowerCase()).not.toContain('cost');
      expect(k.id.toLowerCase()).not.toContain('month');
    }
  });
});

describe('findingChip', () => {
  it('MILES_OUTLIER carries the mockup number (861 mi/day) as a param', () => {
    const c = findingChip({ checkKey: 'MILES_OUTLIER', details: { milesPerDay: 861, band: 600 } });
    expect(c.tone).toBe('warn');
    expect(c.params).toEqual({ n: 861 });
  });

  it('ODO_IMPOSSIBLE is the danger chip; PASS is ok; BACKDATED_RETURN is neutral with the gap', () => {
    expect(findingChip({ checkKey: 'ODO_IMPOSSIBLE' }).tone).toBe('danger');
    expect(findingChip({ checkKey: 'PASS' }).tone).toBe('ok');
    const b = findingChip({ checkKey: 'BACKDATED_RETURN', details: { gapHours: 26 } });
    expect(b.tone).toBe('neutral');
    expect(b.params).toEqual({ n: 26 });
  });

  it('ENTRIES_INCOMPLETE counts the missing angles (Mock 1: 2 angles missing)', () => {
    const c = findingChip({ checkKey: 'ENTRIES_INCOMPLETE', details: { missingAngles: ['rearSeat', 'trunk'] } });
    expect(c.params).toEqual({ n: 2 });
  });

  it('unknown check keys degrade to a neutral chip instead of crashing', () => {
    expect(findingChip({ checkKey: 'PHOTO_PAIR_REAR' }).tone).toBe('neutral');
    expect(findingChip(null).key).toBe('UNKNOWN');
  });
});

describe('groupRowsByReservation', () => {
  it('one row per reservation, findings kept in order, header fields from the first row', () => {
    const rows = [
      { id: 'f1', reservationId: 'r1', reservationNumber: 'RSV-2398', vehicleLabel: 'Kia Forte · KLM-310', checkKey: 'ODO_IMPOSSIBLE', returnedAt: 'a', closedByName: 'M. Rivera' },
      { id: 'f2', reservationId: 'r1', reservationNumber: 'RSV-2398', checkKey: 'ENTRIES_INCOMPLETE' },
      { id: 'f3', reservationId: 'r2', reservationNumber: 'RSV-2391', checkKey: 'MILES_OUTLIER' },
    ];
    const grouped = groupRowsByReservation(rows);
    expect(grouped).toHaveLength(2);
    expect(grouped[0].reservationNumber).toBe('RSV-2398');
    expect(grouped[0].vehicleLabel).toBe('Kia Forte · KLM-310');
    expect(grouped[0].findings.map((f) => f.id)).toEqual(['f1', 'f2']);
    expect(grouped[1].findings.map((f) => f.id)).toEqual(['f3']);
  });
});

describe('detail card derivation', () => {
  it('a clean audit renders the PASS summary numbers (12,404 → 12,981 · 115/day)', () => {
    const findings = [{
      checkKey: 'PASS',
      details: { odometerOut: 12404, odometerIn: 12981, rentalDays: 5, milesPerDay: 115, fuelOut: 1, fuelIn: 0.45, fuelRefillCharged: true },
    }];
    const [odo, fuel] = mileageFuelAuditRows(findings);
    expect(odo).toMatchObject({ ok: true, out: 12404, in: 12981, milesPerDay: 115 });
    expect(fuel).toMatchObject({ ok: true, out: 1, in: 0.45, refillCharged: true });
    expect(entryAuditRows(findings).every((r) => r.ok)).toBe(true);
  });

  it('a flagged audit marks the failing row and carries the finding numbers', () => {
    const findings = [
      { checkKey: 'ODO_IMPOSSIBLE', details: { odometerOut: 41210, odometerIn: 41190 } },
      { checkKey: 'FUEL_DROP_NO_FEE', details: { fuelOut: 1, fuelIn: 0.45 } },
    ];
    const [odo, fuel] = mileageFuelAuditRows(findings);
    expect(odo.ok).toBe(false);
    expect(odo.out).toBe(41210);
    expect(fuel.ok).toBe(false);
    expect(fuel.refillCharged).toBe(false);
    const entry = entryAuditRows(findings);
    expect(entry.find((r) => r.id === 'impossible').ok).toBe(false);
    expect(entry.find((r) => r.id === 'entries').ok).toBe(true);
  });
});

describe('dismiss fork gating', () => {
  it('PREEXISTING is offered only for OPEN DAMAGE findings — in T1 that is nobody', () => {
    expect(canDismissPreexisting({ category: 'DAMAGE', status: 'OPEN' })).toBe(true);
    expect(canDismissPreexisting({ category: 'MILEAGE_FUEL', status: 'OPEN' })).toBe(false);
    expect(canDismissPreexisting({ category: 'ENTRY', status: 'OPEN' })).toBe(false);
    expect(canDismissPreexisting({ category: 'DAMAGE', status: 'RESOLVED' })).toBe(false);
    expect(canDismissPreexisting(null)).toBe(false);
  });
});
