// Damage baseline (2026-09-03) — pure helpers for the vehicle profile's
// "Damage baseline" tab. Source of truth: design/mockups/damage-baseline-
// mockup.html (Mock 1) + damage-baseline-NOTES.md. No React — the tab and
// the tests share one implementation.
//
// The ledger is the existing VehicleDamageReport table; `source` names the
// origin of every entry (the NOTES' conventions). Every chip shows WHO put
// the entry on the record — accountability is the anti-abuse control on the
// dismiss fork.

/** source → chip descriptor. labelKey leaf lives at damageBaseline.source.<x>;
 *  entries from the audit's dismiss fork show the reviewer's name. */
export function baselineSourceChip(entry = {}) {
  const source = String(entry.source || 'CUSTOMER').toUpperCase();
  switch (source) {
    case 'AUDIT_PREEXISTING':
      return {
        source,
        tone: 'brand',
        labelKey: 'damageBaseline.source.audit',
        params: { user: entry.reviewedByName || '—' },
      };
    case 'ONBOARDING':
      return { source, tone: 'neutral', labelKey: 'damageBaseline.source.onboarding', params: {} };
    case 'MANUAL':
      return { source, tone: 'neutral', labelKey: 'damageBaseline.source.manual', params: {} };
    case 'CUSTOMER':
    default:
      return { source, tone: 'ok', labelKey: 'damageBaseline.source.customer', params: {} };
  }
}

/** A fixed entry cleared WITHOUT a repair shows its reason instead of a
 *  repair-photo link (clear-with-reason, NOTES D3 "Shrinks"). */
export function clearedLine(entry = {}) {
  if (entry.clearedReason) {
    return { kind: 'cleared', labelKey: 'damageBaseline.clearedReason', params: { reason: entry.clearedReason } };
  }
  if (entry.repairOrderId) {
    return { kind: 'repairOrder', labelKey: 'damageBaseline.repairedRo', params: { ro: entry.repairOrderId } };
  }
  return { kind: 'repaired', labelKey: 'damageBaseline.repaired', params: {} };
}
