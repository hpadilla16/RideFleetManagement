/**
 * Duplicate detector — given an ExternalReservation, look for an existing
 * Reservation in the same tenant that "already represents" the same booking.
 *
 * Moved verbatim from tl-international/ (R0 extraction, 2026-07-13) — it was
 * always source-agnostic (TL, Economy and NU consume it unchanged). The old
 * path re-exports this module, so no caller changed.
 *
 * Hector's rule: a Reservation is a duplicate if customer firstName +
 * lastName + pickup calendar day all match. The counter agent often creates
 * the reservation manually before the TL sync hits, so before we create a
 * brand-new Reservation we check whether one already exists; if so, we LINK
 * the ExternalReservation to it instead of creating a duplicate.
 *
 * Matching rules:
 *   - same tenantId
 *   - LOWER(TRIM(customer.firstName)) == LOWER(TRIM(ext.customerFirstName))
 *   - LOWER(TRIM(customer.lastName))  == LOWER(TRIM(ext.customerLastName))
 *   - DATE_TRUNC('day', r.pickupAt @ tenant TZ)
 *       == DATE_TRUNC('day', ext.pickupAt @ tenant TZ)
 *   - target reservation NOT already linked from a different ExternalReservation
 *
 * 2026-05-30 — TZ fix. The previous version truncated to UTC days, which
 * misclassified late-evening AST pickups (e.g. 8pm AST = midnight UTC)
 * as the next day. A real-world example: a manual reservation at
 * 2026-05-29 14:00 AST and a TL pickup at 2026-05-29 20:00 AST are the
 * SAME calendar day in PR, but in UTC they straddle a day boundary
 * (18:00Z and 00:00Z next day). The detector returned null and the
 * worker created a duplicate Reservation. We now shift both sides
 * into tenant-local time via `AT TIME ZONE` before DATE_TRUNC so the
 * comparison runs against the operator's wall clock, not server UTC.
 *
 * Implementation note: uses prisma.$queryRaw with tagged-template
 * interpolation so values stay parameterized (no string concat). Prisma
 * doesn't support `LOWER(TRIM(...))` equality + DATE_TRUNC out of the
 * box, so raw SQL is the cleanest path here.
 */

/**
 * Find an existing Reservation that duplicates the given ExternalReservation.
 *
 * @param {*} prisma  Prisma client (real or stub). Must expose $queryRaw.
 * @param {{
 *   tenantId: string,
 *   customerFirstName?: string|null,
 *   customerLastName?: string|null,
 *   pickupAt?: Date|string|null,
 * }} externalReservation
 * @returns {Promise<string|null>}  existing Reservation.id, or null if no match.
 */
export async function findDuplicateReservation(prisma, externalReservation, options = {}) {
  if (!externalReservation) return null;
  const {
    tenantId,
    customerFirstName,
    customerLastName,
    pickupAt,
  } = externalReservation;

  if (!tenantId || !customerFirstName || !customerLastName || !pickupAt) {
    return null;
  }

  const fn = String(customerFirstName).trim().toLowerCase();
  const ln = String(customerLastName).trim().toLowerCase();
  if (!fn || !ln) return null;

  // Normalize pickupAt to a JS Date so the SQL ::timestamptz cast is happy
  // whether the caller hands us a Date or an ISO string.
  const pickup = pickupAt instanceof Date ? pickupAt : new Date(pickupAt);
  if (Number.isNaN(pickup.getTime())) return null;

  // Tenant time zone — defaults to Puerto Rico (AST, no DST). The
  // override is here so multi-tenant deployments and tests can pass
  // a different zone. Postgres accepts IANA names directly.
  const tz = options.timeZone || 'America/Puerto_Rico';

  let rows;
  try {
    rows = await prisma.$queryRaw`
      SELECT r.id
      FROM "Reservation" r
      JOIN "Customer" c ON c.id = r."customerId"
      WHERE r."tenantId" = ${tenantId}
        AND LOWER(TRIM(c."firstName")) = ${fn}
        AND LOWER(TRIM(c."lastName")) = ${ln}
        AND DATE_TRUNC('day', (r."pickupAt" AT TIME ZONE ${tz}))
          = DATE_TRUNC('day', (${pickup}::timestamptz AT TIME ZONE ${tz}))
        AND NOT EXISTS (
          SELECT 1 FROM "ExternalReservation" er2
          WHERE er2."promotedToReservationId" = r.id
        )
      ORDER BY r."createdAt" ASC
      LIMIT 2
    `;
  } catch {
    return null;
  }

  if (!rows || rows.length === 0) return null;
  return rows[0].id || null;
}
