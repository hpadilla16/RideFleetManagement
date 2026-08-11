/**
 * Global search — the ⌘K palette's backend (Innovation #2,
 * design/INNOVATION-REVIEW.md: the marketing chrome draws "Search plate,
 * booking… ⌘K" but the app had no global search).
 *
 * GET /api/search?q= → { results: [{ type, id, title, subtitle, href }] }
 *
 * Posture:
 * - Tenant scope injected from the caller (canonical scopeFor: supers use
 *   ?tenantId=, nobody ever passes a null tenant filter to Prisma).
 * - Location scope FAIL-CLOSED for scoped users: reservations match on
 *   pickup OR return sede, vehicles on home sede. Customers are tenant-wide
 *   BY DESIGN (the app's standing rule — duplicates otherwise).
 * - Cheap lookups only: startsWith/equals on unique or short columns,
 *   take<=6 per bucket, one Promise.all. No unbounded contains on big text.
 * - Search returns only identifiers the caller could open anyway; the target
 *   pages keep their own guards.
 */
import { Router } from 'express';
import { prisma } from '../../lib/prisma.js';
import { scopeFor, userAllowedLocationIds } from '../../lib/tenant-scope.js';
import { mapPaymentResults, PAYMENT_QUERY_MIN } from './payment-search.js';

export const globalSearchRouter = Router();

const TAKE = 6;

function normalizePlate(q) {
  return q.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

globalSearchRouter.get('/', async (req, res, next) => {
  try {
    const tenantId = scopeFor(req)?.tenantId || null;
    if (!tenantId) return res.json({ results: [] });
    const q = String(req.query?.q || '').trim();
    if (q.length < 2) return res.json({ results: [] });

    const allowed = userAllowedLocationIds(req.user) || null;
    const locationIds = Array.isArray(allowed) && allowed.length ? allowed.map(String) : null;
    const plate = normalizePlate(q);
    const insensitive = { mode: 'insensitive' };

    const reservationWhere = {
      tenantId,
      reservationNumber: { startsWith: q, ...insensitive },
      ...(locationIds ? { OR: [{ pickupLocationId: { in: locationIds } }, { returnLocationId: { in: locationIds } }] } : {})
    };
    const vehicleWhere = {
      tenantId,
      ...(locationIds ? { homeLocationId: { in: locationIds } } : {}),
      OR: [
        ...(plate.length >= 2 ? [{ plate: { contains: plate, ...insensitive } }] : []),
        { internalNumber: { startsWith: q, ...insensitive } }
      ]
    };
    const customerWhere = {
      tenantId,
      OR: [
        { firstName: { startsWith: q, ...insensitive } },
        { lastName: { startsWith: q, ...insensitive } },
        { email: { startsWith: q, ...insensitive } },
        ...(plate.length >= 4 && /^\d+$/.test(plate) ? [{ phoneNormalized: { contains: plate } }] : [])
      ]
    };
    const agreementWhere = {
      tenantId,
      agreementNumber: { startsWith: q, ...insensitive },
      ...(locationIds ? { OR: [{ pickupLocationId: { in: locationIds } }, { returnLocationId: { in: locationIds } }] } : {})
    };

    // Payments by REFERENCE (2026-08-11): agents record a receipt/auth code
    // and the card's last 4 ("****1234 · auth A8K2X9" is the house format the
    // AUTH_HOLD flow already writes). ReservationPayment.reference has been
    // indexed since the schema was written; this is the lookup that index was
    // waiting for. `contains` rather than startsWith because the last 4 sits
    // mid-string — the tables are payment-sized (thousands, not millions) and
    // the bucket takes 6, so the scan stays cheap. Gated at 4 characters: the
    // palette's global minimum of 2 would match half the table.
    const paymentScope = {
      tenantId,
      ...(locationIds ? { OR: [{ pickupLocationId: { in: locationIds } }, { returnLocationId: { in: locationIds } }] } : {})
    };
    const wantPayments = q.length >= PAYMENT_QUERY_MIN;

    const [reservations, vehicles, customers, agreements, resPayments, agrPayments] = await Promise.all([
      prisma.reservation.findMany({
        where: reservationWhere,
        select: {
          id: true, reservationNumber: true, status: true, pickupAt: true,
          customer: { select: { firstName: true, lastName: true } }
        },
        orderBy: [{ pickupAt: 'desc' }],
        take: TAKE
      }),
      prisma.vehicle.findMany({
        where: vehicleWhere,
        select: { id: true, plate: true, internalNumber: true, make: true, model: true, year: true, status: true },
        take: TAKE
      }),
      prisma.customer.findMany({
        where: customerWhere,
        select: { id: true, firstName: true, lastName: true, email: true, phone: true },
        orderBy: [{ updatedAt: 'desc' }],
        take: TAKE
      }),
      prisma.rentalAgreement.findMany({
        where: agreementWhere,
        select: { id: true, agreementNumber: true, status: true, reservationId: true },
        take: TAKE
      }),
      wantPayments ? prisma.reservationPayment.findMany({
        where: { reference: { contains: q, ...insensitive }, reservation: paymentScope },
        select: {
          id: true, amount: true, method: true, reference: true, paidAt: true,
          rentalAgreementPaymentId: true,
          reservation: { select: { id: true, reservationNumber: true, customer: { select: { firstName: true, lastName: true } } } }
        },
        orderBy: { paidAt: 'desc' },
        take: TAKE
      }) : Promise.resolve([]),
      wantPayments ? prisma.rentalAgreementPayment.findMany({
        where: { reference: { contains: q, ...insensitive }, rentalAgreement: { is: { reservation: paymentScope } } },
        select: {
          id: true, amount: true, method: true, reference: true, paidAt: true,
          rentalAgreement: { select: { reservation: { select: { id: true, reservationNumber: true, customer: { select: { firstName: true, lastName: true } } } } } }
        },
        orderBy: { paidAt: 'desc' },
        take: TAKE
      }) : Promise.resolve([])
    ]);

    const paymentResults = mapPaymentResults(resPayments, agrPayments).slice(0, TAKE);

    const results = [
      ...reservations.map((r) => ({
        type: 'reservation',
        id: r.id,
        title: r.reservationNumber,
        subtitle: [
          [r.customer?.firstName, r.customer?.lastName].filter(Boolean).join(' '),
          String(r.status || '').replaceAll('_', ' ')
        ].filter(Boolean).join(' · '),
        href: `/reservations/${r.id}`
      })),
      ...agreements.map((a) => ({
        type: 'agreement',
        id: a.id,
        title: a.agreementNumber,
        subtitle: `Agreement · ${String(a.status || '').replaceAll('_', ' ')}`,
        href: a.reservationId ? `/reservations/${a.reservationId}` : '/reservations'
      })),
      ...vehicles.map((v) => ({
        type: 'vehicle',
        id: v.id,
        title: v.plate || v.internalNumber,
        subtitle: [`#${v.internalNumber}`, [v.year, v.make, v.model].filter(Boolean).join(' '), String(v.status || '').replaceAll('_', ' ')].filter(Boolean).join(' · '),
        href: `/vehicles/${v.id}`
      })),
      ...customers.map((c) => ({
        type: 'customer',
        id: c.id,
        title: [c.firstName, c.lastName].filter(Boolean).join(' '),
        subtitle: [c.email, c.phone].filter(Boolean).join(' · '),
        href: `/customers/${c.id}`
      })),
      // Payments LAST: reservation/customer lookups are the palette's muscle
      // memory; the payment bucket only fires at 4+ chars anyway.
      ...paymentResults
    ];

    res.json({ results: results.slice(0, 20) });
  } catch (error) {
    next(error);
  }
});
