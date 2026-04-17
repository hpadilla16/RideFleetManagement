/**
 * Shared parser for Location.locationConfig.
 * Was previously duplicated across ~10 modules (reservations, customer-portal,
 * rental-agreements, booking-engine, rates, reports, tolls, customers, ...).
 */
export function parseLocationConfig(raw) {
  try {
    if (!raw) return {};
    if (typeof raw === 'string') return JSON.parse(raw);
    if (typeof raw === 'object') return raw;
  } catch {}
  return {};
}
