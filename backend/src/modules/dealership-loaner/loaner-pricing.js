/**
 * Pure loaner class-upgrade pricing (no prisma) — unit-testable. 2026-06-25.
 * Plan: doc/loaner-selfservice-class-upgrade-plan-2026-06-25.md.
 */

// Self-service selection is only allowed while the appointment is still open.
export const RESERVABLE_STATUSES = ['NEW', 'CONFIRMED'];

export function money(n) {
  const v = Number(n);
  return Number.isFinite(v) ? Math.round(v * 100) / 100 : 0;
}

export function daysBetween(pickupAt, returnAt) {
  const ms = new Date(returnAt).getTime() - new Date(pickupAt).getTime();
  if (!Number.isFinite(ms) || ms <= 0) return 1;
  return Math.max(1, Math.ceil(ms / 86400000));
}

// entitledRate null/undefined -> covered (delta 0). Delta floored at 0; days floored at 1.
export function priceUpgrade({ chosenRate, entitledRate, days }) {
  const chosen = money(chosenRate);
  const entitled = entitledRate === null || entitledRate === undefined ? chosen : money(entitledRate);
  const upgradeDeltaPerDay = Math.max(0, money(chosen - entitled));
  const d = Math.max(1, Math.floor(Number(days) || 1));
  return { upgradeDeltaPerDay, estimatedUpgradeTotal: money(upgradeDeltaPerDay * d) };
}
