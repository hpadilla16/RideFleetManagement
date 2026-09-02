// Check-in audit (T1 rules 2026-09-03; T2 photo AI 2026-09-02) — pure
// lane/chip/KPI logic. Source of truth: design/mockups/
// checkin-audit-mockup.html (Mock 1 queue, Mock 2 detail) +
// checkin-audit-NOTES.md. Mirrors lib/notification-lanes.js: a data module
// with no React so the rail, the queue chips and the tests share one
// implementation.
//
// T2 posture: everything AI-shaped keys off the API's photoAiEnabled flag —
// a T1-only tenant keeps the honest empty Possible-damage lane, the
// placeholder Photo AI column, and NO AI-spend KPI tile.

/** Lane rail (Mock 1). `id` doubles as the i18n leaf (checkinAudit.lanes.<id>);
 *  `count` names the key in the API's counts object. */
export const CHECKIN_AUDIT_LANE_GROUPS = [
  {
    id: 'needsReview', tone: 'warn',
    lanes: [
      { id: 'damage', count: 'damage' },       // T1: always 0 — Photo AI not enabled
      { id: 'entry', count: 'entry' },
      { id: 'mileageFuel', count: 'mileageFuel' },
    ],
  },
  {
    id: 'resolved', tone: 'ok',
    lanes: [
      { id: 'passed', count: 'passed' },
      { id: 'dismissed', count: 'dismissed' },
      { id: 'resolvedOther', count: 'resolved' },
    ],
  },
  {
    id: 'everything', tone: 'all',
    lanes: [
      { id: 'all', count: 'all' },
    ],
  },
];

// The lane query value the API expects for each rail lane id.
export const LANE_QUERY = Object.freeze({
  damage: 'damage',
  entry: 'entry',
  mileageFuel: 'mileageFuel',
  passed: 'passed',
  dismissed: 'dismissed',
  resolvedOther: 'resolved',
  all: 'all',
});

/**
 * KPI strip (Mock 1). The AI-spend tile belongs to T2's cost-transparency
 * story — it appears ONLY when the tenant's photo AI is on (at $0.00 forever
 * on a T1-only tenant it would be a lie). `id` is the i18n leaf
 * (checkinAudit.kpis.<id>); `key` reads the API's kpis object.
 */
export const CHECKIN_AUDIT_KPIS = [
  { id: 'auditedToday', key: 'auditedToday' },
  { id: 'cleanPassToday', key: 'cleanPassToday' },
  { id: 'openDamage', key: 'openDamage', tone: 'flag' },
  { id: 'openEntryErrors', key: 'openEntryErrors', tone: 'flag' },
];

/** Mock 1's "Photo AI · today" money tile — appended only when enabled. */
export const CHECKIN_AUDIT_AI_KPI = { id: 'aiSpendToday', key: 'aiSpendTodayUsd', tone: 'money' };

export function checkinAuditKpis(photoAiEnabled) {
  return photoAiEnabled ? [...CHECKIN_AUDIT_KPIS, CHECKIN_AUDIT_AI_KPI] : CHECKIN_AUDIT_KPIS;
}

// ── T2 row contract mirrors (backend checkin-audit.service.js) ──────────────
export const DAMAGE_SUSPECTED_PREFIX = 'DAMAGE_SUSPECTED:';
export const T2_SCAN_CHECK_KEY = 'T2_SCAN';

/** i18n leaf for an angle label (checkinAudit.angles.<angle>). */
export function angleFromCheckKey(checkKey) {
  return String(checkKey || '').startsWith(DAMAGE_SUSPECTED_PREFIX)
    ? String(checkKey).slice(DAMAGE_SUSPECTED_PREFIX.length)
    : null;
}

/**
 * The queue's "Photo AI · T2" cell for one reservation group (Mock 1).
 * `t2` is the API's per-reservation summary ({ status, suspected }) — absent
 * means the sweep hasn't reached this close yet. Returns a chip descriptor
 * like findingChip's.
 */
export function photoAiCell(t2, photoAiEnabled) {
  if (!photoAiEnabled) {
    return { key: 'off', tone: 'neutral', labelKey: 'checkinAudit.photoAiOff', params: {}, defaultLabel: 'Photo AI not enabled' };
  }
  const suspected = t2?.suspected?.length ? t2.suspected : null;
  if (suspected) {
    const top = suspected.reduce((a, b) => ((b.confidence ?? 0) > (a.confidence ?? 0) ? b : a), suspected[0]);
    return {
      key: 'suspected',
      tone: top.severity === 'ERROR' ? 'danger' : 'warn',
      labelKey: 'checkinAudit.chips.DAMAGE_SUSPECTED',
      params: { conf: top.confidence ?? '—' },
      defaultLabel: `Possible damage ${top.confidence ?? '—'}%`,
      suspected,
    };
  }
  switch (t2?.status) {
    case 'ANALYZED':
      return { key: 'clean', tone: 'ok', labelKey: 'checkinAudit.chips.T2_CLEAN', params: {}, defaultLabel: 'No new marks' };
    case 'SKIPPED_BUDGET':
      return { key: 'skippedBudget', tone: 'neutral', labelKey: 'checkinAudit.chips.T2_SKIPPED_BUDGET', params: {}, defaultLabel: 'Skipped · daily budget' };
    case 'SKIPPED_NO_PHOTOS':
      return { key: 'skippedPhotos', tone: 'neutral', labelKey: 'checkinAudit.chips.T2_SKIPPED_NO_PHOTOS', params: {}, defaultLabel: 'Skipped · angles missing' };
    case 'FAILED':
      return { key: 'failed', tone: 'warn', labelKey: 'checkinAudit.chips.T2_FAILED', params: {}, defaultLabel: 'Analysis failed' };
    default:
      return { key: 'pending', tone: 'neutral', labelKey: 'checkinAudit.chips.T2_PENDING', params: {}, defaultLabel: 'Queued for photo AI' };
  }
}

/** Per-check chip: tone maps onto the app's .chip-- classes; the label leaf
 *  lives at checkinAudit.chips.<checkKey>. Params feed the label template. */
export function findingChip(finding) {
  const key = finding?.checkKey;
  const details = finding?.details || {};
  switch (key) {
    case 'PASS':
      return { key, tone: 'ok', labelKey: 'checkinAudit.chips.PASS', params: {}, defaultLabel: 'Pass' };
    case 'ODO_IMPOSSIBLE':
      return { key, tone: 'danger', labelKey: 'checkinAudit.chips.ODO_IMPOSSIBLE', params: {}, defaultLabel: 'Odometer < checkout' };
    case 'MILES_OUTLIER':
      return { key, tone: 'warn', labelKey: 'checkinAudit.chips.MILES_OUTLIER', params: { n: details.milesPerDay ?? '—' }, defaultLabel: (details.milesPerDay ?? '—') + ' mi/day' };
    case 'FUEL_UP_NO_RECORD':
      return { key, tone: 'warn', labelKey: 'checkinAudit.chips.FUEL_UP_NO_RECORD', params: {}, defaultLabel: 'Fuel ↑ no refuel recorded' };
    case 'FUEL_DROP_NO_FEE':
      return { key, tone: 'warn', labelKey: 'checkinAudit.chips.FUEL_DROP_NO_FEE', params: {}, defaultLabel: 'Fuel ↓ no refill fee' };
    case 'ENTRIES_INCOMPLETE':
      return { key, tone: 'warn', labelKey: 'checkinAudit.chips.ENTRIES_INCOMPLETE', params: { n: (details.missingAngles || []).length }, defaultLabel: 'Entries incomplete' };
    case 'BACKDATED_RETURN':
      return { key, tone: 'neutral', labelKey: 'checkinAudit.chips.BACKDATED_RETURN', params: { n: details.gapHours ?? '—' }, defaultLabel: 'Backdated return' };
    default:
      if (String(key || '').startsWith(DAMAGE_SUSPECTED_PREFIX)) {
        const conf = details.confidence ?? '—';
        return {
          key,
          tone: finding?.severity === 'ERROR' ? 'danger' : 'warn',
          labelKey: 'checkinAudit.chips.DAMAGE_SUSPECTED',
          params: { conf },
          defaultLabel: `Possible damage ${conf}%`,
        };
      }
      return { key: key || 'UNKNOWN', tone: 'neutral', labelKey: 'checkinAudit.chips.UNKNOWN', params: {}, defaultLabel: 'Finding' };
  }
}

/** The queue table is one row PER RESERVATION (Mock 1); the API returns one
 *  row per finding. Group, newest first, chips in check order. */
export function groupRowsByReservation(rows = []) {
  const map = new Map();
  for (const r of rows) {
    if (!map.has(r.reservationId)) {
      map.set(r.reservationId, {
        reservationId: r.reservationId,
        reservationNumber: r.reservationNumber || r.reservationId,
        vehicleLabel: r.vehicleLabel || null,
        returnedAt: r.returnedAt || r.createdAt,
        closedByName: r.closedByName || null,
        findings: [],
      });
    }
    map.get(r.reservationId).findings.push(r);
  }
  return [...map.values()];
}

/** Detail-view audit rows (Mock 2's "Mileage & fuel audit" card). Renders
 *  numbers where a finding recorded them; a check with no finding is a pass. */
export function mileageFuelAuditRows(findings = []) {
  const by = Object.fromEntries(findings.map((f) => [f.checkKey, f]));
  const summary = by.PASS?.details || {};
  const odo = by.ODO_IMPOSSIBLE?.details || by.MILES_OUTLIER?.details || summary;
  const fuel = by.FUEL_DROP_NO_FEE?.details || by.FUEL_UP_NO_RECORD?.details || summary;
  return [
    {
      id: 'odometer',
      ok: !by.ODO_IMPOSSIBLE && !by.MILES_OUTLIER,
      out: odo.odometerOut ?? null,
      in: odo.odometerIn ?? null,
      milesPerDay: odo.milesPerDay ?? summary.milesPerDay ?? null,
      band: odo.band ?? null,
    },
    {
      id: 'fuel',
      ok: !by.FUEL_DROP_NO_FEE && !by.FUEL_UP_NO_RECORD,
      out: fuel.fuelOut ?? null,
      in: fuel.fuelIn ?? null,
      refillCharged: summary.fuelRefillCharged ?? (by.FUEL_DROP_NO_FEE ? false : null),
    },
  ];
}

/** Detail-view entry rows (Mock 2's "Agent entry checks" card). */
export function entryAuditRows(findings = []) {
  const by = Object.fromEntries(findings.map((f) => [f.checkKey, f]));
  return [
    { id: 'impossible', ok: !by.ODO_IMPOSSIBLE, finding: by.ODO_IMPOSSIBLE || null },
    { id: 'entries', ok: !by.ENTRIES_INCOMPLETE, finding: by.ENTRIES_INCOMPLETE || null },
    { id: 'backdated', ok: !by.BACKDATED_RETURN, finding: by.BACKDATED_RETURN || null },
  ];
}

/** The dismiss fork's second verb is DAMAGE-only (baseline NOTES): in T1 no
 *  finding qualifies, so the option renders disabled with the T2 note. */
export function canDismissPreexisting(finding) {
  return finding?.category === 'DAMAGE' && finding?.status === 'OPEN';
}
