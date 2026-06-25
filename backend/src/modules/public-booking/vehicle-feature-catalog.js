// Controlled catalog of vehicle amenities exposed on the public booking API (2026-06-25).
// Controlled so the website can build a reliable feature filter. Add codes here as needed;
// anything not in the catalog is dropped from the public projection.
export const VEHICLE_FEATURE_CATALOG = [
  'AC',
  'BLUETOOTH',
  'CARPLAY',
  'ANDROID_AUTO',
  'GPS',
  'USB',
  'BACKUP_CAM',
  'HEATED_SEATS',
  'SUNROOF',
  'THIRD_ROW',
  'AWD',
  'CRUISE_CONTROL',
  'KEYLESS',
  'BLIND_SPOT',
  'APPLE_CARPLAY', // alias kept distinct in case a tenant uses it; map at the UI if needed
];

const CATALOG_SET = new Set(VEHICLE_FEATURE_CATALOG);

/** Keep only valid catalog codes (uppercased, de-duped) so the public payload is clean. */
export function normalizeFeatures(arr) {
  const seen = new Set();
  const out = [];
  for (const raw of Array.isArray(arr) ? arr : []) {
    const code = String(raw || '').trim().toUpperCase();
    if (CATALOG_SET.has(code) && !seen.has(code)) { seen.add(code); out.push(code); }
  }
  return out;
}

/**
 * Build the read-only public Vehicle Profile slice for a VehicleType row. Matches the shape the
 * Rent & Go site expects. `included.mileage` is "UNLIMITED" | { freeMilesPerDay } | null.
 * Pass the VehicleType row selecting: imageUrl, passengers, bags, doors, transmission, features,
 * unlimitedMileage, freeMilesPerDay, insuranceIncluded.
 */
export function publicVehicleProfile(vt = {}) {
  return {
    imageUrl: vt.imageUrl || null,
    passengers: vt.passengers ?? null,
    bags: vt.bags ?? null,
    transmission: vt.transmission || null,
    doors: vt.doors ?? null,
    features: normalizeFeatures(vt.features),
    included: {
      mileage: vt.unlimitedMileage
        ? 'UNLIMITED'
        : (vt.freeMilesPerDay != null ? { freeMilesPerDay: Number(vt.freeMilesPerDay) } : null),
      insuranceIncluded: !!vt.insuranceIncluded,
    },
  };
}
