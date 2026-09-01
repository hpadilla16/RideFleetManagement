/**
 * Counter-UX Item 2 (Hector, 2026-08-31) — check-in mileage guard.
 *
 * The check-in odometer input is pre-filled with the vehicle's last known
 * mileage (RentalAgreement.odometerOut, falling back to Vehicle.mileage —
 * both mirrored from VehicleMileageEntry, "last odometer wins"). If the
 * agent enters LESS than the check-out reading, we WARN inline but never
 * block: odometer swaps and corrections are real (the Admin Corrections /
 * correct-readings module exists precisely because readings get fixed
 * after the fact).
 *
 * Pure + unit-tested; the wizard maps { warn } to the inline copy.
 */
export function mileageGuard({ entered, baseline } = {}) {
  const raw = String(entered ?? '').trim();
  const value = Number(raw);
  const base = Number(baseline);
  // Nothing entered yet, or no usable baseline → nothing to warn about.
  if (raw === '' || !Number.isFinite(value)) return { warn: false, delta: null };
  if (!Number.isFinite(base) || base <= 0) return { warn: false, delta: null };
  return { warn: value < base, delta: value - base };
}
