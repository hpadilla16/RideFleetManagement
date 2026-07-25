/**
 * Pre-check-in discount logic for the Edit-pricing override UI (2026-07-25).
 *
 * THE BUG THIS EXISTS FOR: a customer buys an upsell during pre-check-in at the
 * discounted rate (e.g. full coverage $38 instead of $40 with a 5% discount).
 * The staff Edit-pricing UI then REBUILDS insurance/service rows from CATALOG
 * prices, so any Save Override silently reverted the price the customer had
 * already accepted — and, worse, services stored under source
 * ADDITIONAL_SERVICE_PRECHECKIN were not derived into the editor at all, so an
 * override deleted them outright.
 *
 * Hector's call (2026-07-25): the discount RE-APPLIES to the new plan when the
 * agent swaps plans — the reservation earned pre-check-in pricing, the specific
 * plan is secondary. So the rule implemented here is:
 *   reservation shows the pre-check-in marker on any charge
 *     → catalog-rebuilt insurance AND service rows get the discount re-applied.
 *
 * `makeDiscountFn` MUST mirror backend/src/lib/precheckin-catalog.js exactly —
 * same rounding, same clamp — so the price the override writes is byte-equal to
 * the price the portal wrote and nothing "drifts by a cent" between the two.
 */

/** Marker the customer-portal writes into charge notes when it discounts. */
export const PRECHECKIN_NOTES_MARKER = 'pre-checkin discount applied';
/** Marker the customer-portal appends to the charge name when it discounts. */
export const PRECHECKIN_NAME_MARKER = '(Pre-checkin rate)';

/** Mirror of backend makeDiscountFn — keep in lockstep. */
export function makeDiscountFn(discount) {
  const d = discount && discount.enabled ? discount : null;
  return (amount) => {
    const a = Number(amount || 0);
    if (!d || !a) return Number(a.toFixed(2));
    if (String(d.type).toUpperCase() === 'PERCENTAGE') {
      return Number((a * (1 - Number(d.value || 0) / 100)).toFixed(2));
    }
    return Number(Math.max(0, a - Number(d.value || 0)).toFixed(2));
  };
}

/**
 * Did this reservation go through pre-check-in with a discount applied?
 * Detected from the live charge rows (GET /pricing), which carry the portal's
 * markers in `notes` and/or `name`. Voided rows are already filtered out by the
 * pricing endpoint, so a voided discounted charge does not keep this alive.
 */
export function hasPrecheckinDiscount(charges) {
  return (Array.isArray(charges) ? charges : []).some((c) => {
    const notes = String(c?.notes || '').toLowerCase();
    const name = String(c?.name || '').toLowerCase();
    return notes.includes(PRECHECKIN_NOTES_MARKER) || name.includes(PRECHECKIN_NAME_MARKER.toLowerCase());
  });
}

/** Strip the portal's name suffix so catalog lookups by name still match. */
export function stripPrecheckinSuffix(name) {
  return String(name || '').replace(/\s*\(Pre-checkin rate\)\s*$/i, '').trim();
}

/** Normalize a service charge/catalog name to a matchable key: drops the
 *  editor's "Service: " prefix AND the portal's "(Pre-checkin rate)" suffix.
 *  Stripping ONLY the suffix caused a real money bug: the editor writes
 *  "Service: X (Pre-checkin rate)", so on the SECOND override the name no
 *  longer matched, the row lost its ADDITIONAL_SERVICE_PRECHECKIN source, and
 *  the portal's re-submit (which deletes by that source) missed it and created
 *  a duplicate — the customer paid twice. */
export function serviceNameKey(name) {
  return stripPrecheckinSuffix(String(name || '').replace(/^Service:\s*/i, '')).toLowerCase();
}

/**
 * Identity keys of the services the customer bought at pre-check-in, from the
 * live charge rows. `refIds` (AdditionalService.id, written as sourceRefId by
 * BOTH the portal and the editor) is the primary key — it survives any amount
 * of name decoration. Names are the fallback for rows that lost their refId.
 */
export function precheckinServiceKeys(charges) {
  const rows = (Array.isArray(charges) ? charges : [])
    .filter((c) => String(c?.source || '').toUpperCase() === 'ADDITIONAL_SERVICE_PRECHECKIN');
  return {
    refIds: new Set(rows.map((c) => String(c?.sourceRefId || '').trim()).filter(Boolean)),
    names: new Set(rows.map((c) => serviceNameKey(c?.name)).filter(Boolean)),
  };
}

/** Was this catalog service one the customer bought at pre-check-in? */
export function isPrecheckinService(keys, { id, name } = {}) {
  if (!keys) return false;
  if (id && keys.refIds.has(String(id).trim())) return true;
  const n = serviceNameKey(name);
  return !!n && keys.names.has(n);
}

/**
 * Build the notes line for a discounted override row. Mirrors the portal's
 * format ("Counter price: … , pre-checkin discount applied") so the next
 * override — and any human reading the charge — sees the same audit trail.
 */
export function precheckinNotes(counterNote) {
  return `${counterNote}, ${PRECHECKIN_NOTES_MARKER}`;
}
