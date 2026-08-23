/**
 * customer-pii-reach.js — THE ONE RESOLVER that turns a Customer row into the
 * set of ids + where-clauses reaching every place their PII lives.
 *
 * WHY THIS FILE EXISTS
 *   Phase A (erase) and Phase B (export) are the exact inverse of each other over
 *   the SAME surface: whatever erasure scrubs, export must disclose. If each had
 *   its own reach logic they would drift, and a table that export forgot would be
 *   a DSAR gap. So the id-resolution (`resolveTargets`) and per-entry
 *   where-building (`buildWheres`) live here, ONCE, driven by customer-pii-map.js,
 *   and both services import them. There is no second copy.
 *
 * Pure query-shape helpers — every DB read is done by the caller through the
 * injected prisma, so this module needs no client of its own and the suites run
 * DB-free. No mutation happens here.
 *
 * ESM. No new npm deps.
 */

// Interactive-transaction / statement guard: id-IN lists are chunked so no
// single statement carries an unbounded id list (a customer with thousands of
// rentals must not blow the interactive-transaction limit on the erase side, and
// export reads the same bounded chunks).
export const ID_CHUNK = 500;

// Match kinds whose where-branches can overlap (OR of several conditions), so
// rows must be de-duplicated by id rather than summed/concatenated blindly.
export const OR_MATCH_KINDS = new Set([
  'quote', 'loanerRequest', 'externalReservation', 'reservationOrAgreement',
]);

export function chunk(arr, size = ID_CHUNK) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// Compact, safe OR builder — drops empty/undefined branches and returns null
// when nothing can match (caller then skips the model entirely).
export function orWhere(branches) {
  const kept = branches.filter(Boolean);
  if (kept.length === 0) return null;
  if (kept.length === 1) return kept[0];
  return { OR: kept };
}

export function inClause(ids) {
  return { in: Array.isArray(ids) ? ids : [] };
}

/**
 * Resolve the where-clauses that select THIS customer's rows for a map entry.
 * Returns an ARRAY (empty = nothing can match, caller skips the model). Any
 * `WHERE <field> IN (<ids>)` list is chunked so no single statement carries an
 * unbounded id list; OR-shaped matches become one where per branch.
 */
export function buildWheres(spec, ctx) {
  const m = spec.match;
  const tenantScope = ctx.tenantId ? { tenantId: ctx.tenantId } : {};
  const idIn = (field, ids) => chunk(ids).map((c) => ({ [field]: { in: c } }));
  switch (m.kind) {
    case 'self':
      return [{ id: ctx.customerId }];
    case 'customerFk':
      return [{ [m.field]: ctx.customerId }];
    case 'reservationRelation':
    case 'reservationScalar':
      return ctx.reservationIds.length ? idIn(m.field, ctx.reservationIds) : [];
    case 'agreementRelation':
      return ctx.agreementIds.length ? idIn(m.field, ctx.agreementIds) : [];
    case 'loanerRelation':
      return ctx.loanerAgreementIds.length ? idIn(m.field, ctx.loanerAgreementIds) : [];
    case 'tripRelation':
      return ctx.tripIds.length ? idIn(m.field, ctx.tripIds) : [];
    case 'tripIncidentRelation':
      return ctx.tripIncidentIds.length ? idIn(m.field, ctx.tripIncidentIds) : [];
    case 'citationDocument':
      return ctx.citationIds.length ? idIn('citationId', ctx.citationIds) : [];
    case 'reservationOrAgreement': {
      const w = [];
      if (ctx.reservationIds.length) w.push(...idIn('reservationId', ctx.reservationIds));
      if (ctx.agreementIds.length) w.push(...idIn('rentalAgreementId', ctx.agreementIds));
      return w;
    }
    case 'quote': {
      // Quote has a customerId scalar link — PREFER it. The contact-identifier
      // branches are a FALLBACK for quotes not yet linked to a customer
      // (customerId null); gating them on `customerId: null` stops a quote that
      // already belongs to another customer from folding into this subject via a
      // shared email/phone. Email is the strong key; a bare shared PHONE must
      // NOT pull a row in on its own — it is accepted only WITH a name match.
      const w = [{ ...tenantScope, customerId: ctx.customerId }];
      if (ctx.email) {
        w.push({ ...tenantScope, customerId: null, contactEmail: { equals: ctx.email, mode: 'insensitive' } });
      }
      if (ctx.phone && ctx.fullName) {
        w.push({
          ...tenantScope,
          customerId: null,
          AND: [{ contactPhone: ctx.phone }, { contactName: { equals: ctx.fullName, mode: 'insensitive' } }],
        });
      }
      return w;
    }
    case 'loanerRequest': {
      // Public intake with no customerId link — matched by contact identifiers.
      // EMAIL is the strong key; a bare shared PHONE is accepted only WITH a
      // first+last name match (a family member on the same number must not pull
      // this subject's loaner request into theirs).
      const w = [];
      if (ctx.email) w.push({ ...tenantScope, email: { equals: ctx.email, mode: 'insensitive' } });
      if (ctx.phone && ctx.fullName) {
        w.push({ ...tenantScope, AND: [{ phone: ctx.phone }, { name: { equals: ctx.fullName, mode: 'insensitive' } }] });
      }
      return w;
    }
    case 'externalReservation': {
      // Matched by the promoted-reservation id link OR by EMAIL (the strong key).
      // Deliberately NO bare-phone branch — a shared number never pulls another
      // person's import row in.
      const w = [];
      if (ctx.reservationIds.length) w.push(...idIn('promotedToReservationId', ctx.reservationIds));
      if (ctx.email) w.push({ ...tenantScope, customerEmail: { equals: ctx.email, mode: 'insensitive' } });
      return w;
    }
    default:
      return [];
  }
}

/**
 * Resolve every id-set needed to reach this customer's PII, from the master
 * Customer row outward. The SAME context object feeds both erase and export.
 */
export async function resolveTargets(prisma, customer) {
  const customerId = customer.id;

  const reservations = await prisma.reservation.findMany({
    where: { customerId },
    select: { id: true },
  });
  const reservationIds = reservations.map((r) => r.id);

  const agreements = reservationIds.length
    ? await prisma.rentalAgreement.findMany({
        where: { reservationId: inClause(reservationIds) },
        select: { id: true },
      })
    : [];
  const agreementIds = agreements.map((a) => a.id);

  const loanerAgreements = reservationIds.length
    ? await prisma.loanerAgreement.findMany({
        where: { reservationId: inClause(reservationIds) },
        select: { id: true },
      })
    : [];
  const loanerAgreementIds = loanerAgreements.map((a) => a.id);

  const trips = await prisma.trip.findMany({
    where: { guestCustomerId: customerId },
    select: { id: true },
  });
  const tripIds = trips.map((t) => t.id);

  const conversations = await prisma.conversation.findMany({
    where: { customerId },
    select: { id: true, pickupPhotoUrl: true },
  });
  const conversationIds = conversations.map((c) => c.id);

  // TripIncident links via reservation OR trip.
  const tripIncidents = (reservationIds.length || tripIds.length)
    ? await prisma.tripIncident.findMany({
        where: orWhere([
          reservationIds.length ? { reservationId: inClause(reservationIds) } : null,
          tripIds.length ? { tripId: inClause(tripIds) } : null,
        ]),
        select: { id: true },
      })
    : [];
  const tripIncidentIds = tripIncidents.map((t) => t.id);

  const citations = reservationIds.length
    ? await prisma.citation.findMany({
        where: { reservationId: inClause(reservationIds) },
        select: { id: true },
      })
    : [];
  const citationIds = citations.map((c) => c.id);

  const fullName = [customer.firstName, customer.lastName]
    .map((s) => String(s || '').trim())
    .filter(Boolean)
    .join(' ') || null;

  return {
    customerId,
    tenantId: customer.tenantId || null,
    email: customer.email ? String(customer.email).trim() : null,
    phone: customer.phone ? String(customer.phone).trim() : null,
    fullName,
    reservationIds,
    agreementIds,
    loanerAgreementIds,
    tripIds,
    conversationIds,
    conversationPickupPhotos: conversations.map((c) => c.pickupPhotoUrl).filter(Boolean),
    tripIncidentIds,
    citationIds,
  };
}

export default {
  ID_CHUNK,
  OR_MATCH_KINDS,
  chunk,
  orWhere,
  inClause,
  buildWheres,
  resolveTargets,
};
