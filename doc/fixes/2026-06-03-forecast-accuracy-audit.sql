-- ════════════════════════════════════════════════════════════════════
-- Availability-Forecast accuracy audit · 2026-06-03
-- Run in the Supabase SQL editor. Compares live data against what the
-- availability-forecast report computes.
--
-- SET THESE TWO before running:
--   tenant: cmn98hc1u0085ke0i4vefujt3   (main tenant from prod logs — swap if auditing another)
--   tz:     'America/Puerto_Rico'       (must match Settings → Reservations → tenantTimeZone)
-- ════════════════════════════════════════════════════════════════════

-- ── 1 · CAPACITY per type, exactly as the report counts it ───────────
-- Report rule: status NOT IN ('OUT_OF_SERVICE','SOLD'). Note the
-- in_maintenance column — those vehicles COUNT as capacity in the report.
SELECT
  vt.name                                   AS vehicle_type,
  COUNT(v.id) FILTER (WHERE v.status NOT IN ('OUT_OF_SERVICE','SOLD'))   AS report_capacity,
  COUNT(v.id) FILTER (WHERE v.status = 'IN_MAINTENANCE')                 AS in_maintenance_counted,
  COUNT(v.id) FILTER (WHERE v.status IN ('OUT_OF_SERVICE','SOLD'))       AS excluded,
  COUNT(v.id)                                                            AS total_fleet
FROM "VehicleType" vt
LEFT JOIN "Vehicle" v ON v."vehicleTypeId" = vt.id
WHERE vt."tenantId" = 'cmn98hc1u0085ke0i4vefujt3'
GROUP BY vt.name
ORDER BY report_capacity DESC;

-- ── 2 · INVISIBLE DEMAND: reservations the forecast cannot see ───────
-- Confirmed reservations in the next 30 days with NO vehicleTypeId.
-- Each row here is real demand the grid is NOT subtracting.
SELECT r."reservationNumber", r.status, r."pickupAt", r."returnAt"
FROM "Reservation" r
WHERE r."tenantId" = 'cmn98hc1u0085ke0i4vefujt3'
  AND r.status IN ('NEW','CONFIRMED','CHECKED_OUT','PENDING_FRANCHISE_IMPORT')
  AND r."vehicleTypeId" IS NULL
  AND r."pickupAt" < now() + interval '30 days'
  AND r."returnAt" > now()
ORDER BY r."pickupAt";

-- ── 3 · OVERDUE: cars the report thinks are free but are still out ───
-- CHECKED_OUT past their scheduled return. The forecast frees these on
-- returnAt, so today's availability is overstated by this count per type.
SELECT
  vt.name                                  AS vehicle_type,
  COUNT(*)                                 AS overdue_still_out,
  string_agg(r."reservationNumber", ', ')  AS reservations
FROM "Reservation" r
JOIN "VehicleType" vt ON vt.id = r."vehicleTypeId"
WHERE r."tenantId" = 'cmn98hc1u0085ke0i4vefujt3'
  AND r.status = 'CHECKED_OUT'
  AND r."returnAt" < now()
  AND r."overdueIgnored" = false
GROUP BY vt.name;

-- ── 4 · SINGLE-CELL CROSS-CHECK: pick a day, compare with the grid ───
-- Mirrors the report exactly for one day (default: 7 days out).
-- Compare report_available with the number in that day's column.
WITH params AS (
  SELECT
    'cmn98hc1u0085ke0i4vefujt3'::text AS tenant,
    'America/Puerto_Rico'::text       AS tz,
    (now() AT TIME ZONE 'America/Puerto_Rico')::date + 7 AS check_day
),
cap AS (
  SELECT v."vehicleTypeId", COUNT(*) AS capacity
  FROM "Vehicle" v, params p
  WHERE v.status NOT IN ('OUT_OF_SERVICE','SOLD')
  GROUP BY v."vehicleTypeId"
),
booked AS (
  SELECT r."vehicleTypeId", COUNT(*) AS reserved
  FROM "Reservation" r, params p
  WHERE r."tenantId" = p.tenant
    AND r.status IN ('NEW','CONFIRMED','CHECKED_OUT','PENDING_FRANCHISE_IMPORT')
    AND r."vehicleTypeId" IS NOT NULL
    AND r."overdueIgnored" = false
    AND (r."pickupAt" AT TIME ZONE p.tz)::date <= p.check_day
    AND p.check_day < (r."returnAt" AT TIME ZONE p.tz)::date
  GROUP BY r."vehicleTypeId"
)
SELECT
  p.check_day,
  vt.name                                          AS vehicle_type,
  COALESCE(c.capacity, 0)                          AS report_capacity,
  COALESCE(b.reserved, 0)                          AS report_reserved,
  GREATEST(0, COALESCE(c.capacity,0) - COALESCE(b.reserved,0)) AS report_available
FROM "VehicleType" vt
CROSS JOIN params p
LEFT JOIN cap c    ON c."vehicleTypeId" = vt.id
LEFT JOIN booked b ON b."vehicleTypeId" = vt.id
WHERE vt."tenantId" = p.tenant
ORDER BY report_capacity DESC;

-- ── 5 · DATA HYGIENE: reservations with impossible dates ─────────────
-- returnAt <= pickupAt never occupies a single day in the grid.
SELECT r."reservationNumber", r.status, r."pickupAt", r."returnAt"
FROM "Reservation" r
WHERE r."tenantId" = 'cmn98hc1u0085ke0i4vefujt3'
  AND r.status IN ('NEW','CONFIRMED','CHECKED_OUT','PENDING_FRANCHISE_IMPORT')
  AND r."returnAt" <= r."pickupAt"
ORDER BY r."pickupAt" DESC
LIMIT 20;
