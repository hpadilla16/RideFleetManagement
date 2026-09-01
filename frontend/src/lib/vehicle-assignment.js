/**
 * Counter-UX Item 1 (Hector, 2026-08-31) — vehicle-assignment picker filter.
 *
 * When assigning a car to a reservation, the picker should DEFAULT to
 * AVAILABLE units of the reservation's vehicle type. Rules:
 *
 *  - No vehicle type on the reservation → show everything (old behavior).
 *  - `keepIds` (the currently-assigned / currently-selected vehicle) are
 *    ALWAYS included even when they no longer match, so an open reservation
 *    never renders an empty or invalid selection.
 *  - `showAll: true` is the visible escape hatch — the counter sometimes
 *    deliberately upgrades a customer to another type, so the filter is a
 *    default, not a wall (Hector's standing preserve-everything rule).
 *
 * Pure functions on already-fetched lists — no API involvement. Every assign
 * surface (reservation detail picker, loaner ops picker, checkout-wizard
 * swap modal, /swap page, loaner intake) applies the SAME rule through here
 * so the behaviors can't drift.
 */

/** Vehicle rows carry the type as `vehicleTypeId` (flat) or `vehicleType.id`
 * (relation select) depending on the endpoint — normalize both. */
export function vehicleTypeIdOf(vehicle) {
  return vehicle?.vehicleTypeId || vehicle?.vehicleType?.id || null;
}

/**
 * @param {Array} vehicles     already-fetched vehicle rows
 * @param {object} opts
 * @param {string|null} opts.vehicleTypeId  the reservation's vehicle type (null = no filter)
 * @param {Array|string|null} opts.keepIds  vehicle id(s) always kept in the list
 * @param {boolean} opts.showAll            escape hatch — bypass the filter
 */
export function filterAssignableVehicles(vehicles, { vehicleTypeId = null, keepIds = [], showAll = false } = {}) {
  const list = Array.isArray(vehicles) ? vehicles : [];
  if (showAll || !vehicleTypeId) return list;
  const keep = new Set(
    (Array.isArray(keepIds) ? keepIds : [keepIds])
      .filter(Boolean)
      .map((id) => String(id))
  );
  const wantedType = String(vehicleTypeId);
  return list.filter((vehicle) => {
    if (keep.has(String(vehicle?.id || ''))) return true;
    if (String(vehicle?.status || '').toUpperCase() !== 'AVAILABLE') return false;
    return String(vehicleTypeIdOf(vehicle) || '') === wantedType;
  });
}

/** True when the type-filter is actually narrowing the list (drives whether
 * the "Show all vehicles" escape-hatch link is rendered at all). */
export function assignFilterApplies({ vehicleTypeId = null } = {}) {
  return Boolean(vehicleTypeId);
}
