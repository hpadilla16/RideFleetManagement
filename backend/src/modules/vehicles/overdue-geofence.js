/**
 * Overdue-vehicle geofence — the pure decision behind the dashboard alert.
 *
 * THE RULE (Hector, 2026-08-13): when a rental is overdue, ping Voltswitch
 * for the car's position. Inside the boundaries of ANY of the tenant's
 * locations → fine (the car is back on a lot; staff forgot the check-in —
 * that is the backdated-checkin workflow, not a customer problem). Outside
 * all of them → notification on the dashboard.
 *
 * "Any location", not "the return location", on purpose: a car dropped at a
 * different branch is still returned. A tenant location only participates if
 * it has coordinates saved — the check never guesses a geofence from a street
 * address.
 *
 * Pure module, no IO (house pattern: voltswitch-sync-due, backdated-return).
 * The sweep in overdue-locate.service.js feeds it positions and locations.
 */

/** Radius applied when a geofenced location has no explicit radius saved. */
export const DEFAULT_GEOFENCE_RADIUS_KM = 0.5;

const toNum = (v) => {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** Great-circle distance in km. */
export function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(lat2 - lat1);
  const dLng = rad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/** Tenant locations that actually have a geofence (both coordinates saved). */
export function geofencedLocations(locations = []) {
  return (Array.isArray(locations) ? locations : [])
    .map((loc) => ({
      id: loc?.id,
      name: loc?.name || loc?.code || '',
      latitude: toNum(loc?.latitude),
      longitude: toNum(loc?.longitude),
      radiusKm: toNum(loc?.geofenceRadiusKm) || DEFAULT_GEOFENCE_RADIUS_KM,
    }))
    .filter((loc) => loc.id && loc.latitude != null && loc.longitude != null);
}

/**
 * Classify an overdue vehicle's position against the tenant's geofences.
 *
 * @param {{latitude:any, longitude:any}|null} position
 * @param {Array} locations raw Location rows
 * @returns {{verdict:'INSIDE'|'OUTSIDE'|'NO_POSITION'|'NO_GEOFENCE',
 *            nearestLocationId:string|null, nearestLocationName:string|null,
 *            distanceKm:number|null}}
 */
export function classifyOverduePosition(position, locations = []) {
  const fences = geofencedLocations(locations);
  if (!fences.length) {
    return { verdict: 'NO_GEOFENCE', nearestLocationId: null, nearestLocationName: null, distanceKm: null };
  }
  const lat = toNum(position?.latitude);
  const lng = toNum(position?.longitude);
  if (lat == null || lng == null) {
    return { verdict: 'NO_POSITION', nearestLocationId: null, nearestLocationName: null, distanceKm: null };
  }

  let nearest = null;
  for (const fence of fences) {
    const d = haversineKm(lat, lng, fence.latitude, fence.longitude);
    if (!nearest || d < nearest.distanceKm) {
      nearest = { fence, distanceKm: d };
    }
  }

  const inside = nearest.distanceKm <= nearest.fence.radiusKm;
  return {
    verdict: inside ? 'INSIDE' : 'OUTSIDE',
    nearestLocationId: nearest.fence.id,
    nearestLocationName: nearest.fence.name || null,
    distanceKm: Math.round(nearest.distanceKm * 100) / 100,
  };
}
