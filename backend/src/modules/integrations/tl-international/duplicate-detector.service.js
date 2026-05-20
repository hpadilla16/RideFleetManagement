/**
 * Duplicate detector — given an ExternalReservation, look for an existing
 * Reservation in the same tenant that "already represents" the same booking.
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
 *   - DATE_TRUNC('day', r.pickupAt)   == DATE_TRUNC('day', ext.pickupAt)
 *   - target reservation NOT already linked from a different ExternalReservation
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
export async function findDuplicateReservation(prisma, externalReservation) {
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

  // Normalize pickupAt to a JS Date so the SQL ::timestamp cast is happy
  // whether the caller hands us a Date or an ISO string.
  const pickup = pickupAt instanceof Date ? pickupAt : new Date(pickupAt);
  if (Number.isNaN(pickup.getTime())) return null;

  let rows;
  try {
    rows = await prisma.$queryRaw`
      SELECT r.id
      FROM "Reservation" r
      JOIN "Customer" c ON c.id = r."customerId"
      WHERE r."tenantId" = ${tenantId}
        AND LOWER(TRIM(c."firstName")) = ${fn}
        AND LOWER(TRIM(c."lastName")) = ${ln}
        AND DATE_TRUNC('day', r."pickupAt") = DATE_TRUNC('day', ${pickup}::timestamp)
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
