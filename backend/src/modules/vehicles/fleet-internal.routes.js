import { Router } from 'express';
import { prisma } from '../../lib/prisma.js';

/**
 * GET /api/internal/fleet — machine-to-machine fleet feed for TollBridge
 * (their point 6, Hector's decision 2026-07-26: RFM is the source of truth
 * for the fleet; TollBridge pulls it instead of anyone maintaining a second
 * list by file upload — a missing plate is a toll that never matches).
 *
 * Contract agreed in doc/tollbridge/tollbridge-integration-response-2026-07-24.md:
 *   ?tenantId=<cuid>&locationCode=LAX&updatedSince=<iso>&cursor=<id>&limit=500
 *   -> { vehicles: [{ id, plate, plateNormalized, internalNumber, make, model,
 *        year, active, locationCode }], nextCursor }
 *
 * Auth: DEDICATED token (TOLLBRIDGE_FLEET_TOKEN), deliberately NOT the
 * droplet's BACKEND_INTERNAL_TOKEN — their explicit ask, so revoking
 * TollBridge never breaks the citation/toll scrapers. 503 when unset.
 *
 * Semantics:
 * - locationCode is REQUIRED (their ask: "solo queremos LAX, no toda la
 *   flota del tenant"). Matches vehicles by homeLocationId of that sede.
 * - Vehicles WITHOUT a plate are omitted: California bills by plate only —
 *   a plate-less row is unusable on their side and their contract marks
 *   plate as mandatory.
 * - active=false only for SOLD (definitively out of fleet; their semantics:
 *   "vendido/fuera de flota, deja de traer sus peajes"). OUT_OF_SERVICE
 *   stays active: an operational hold can end, and a car being shuttled
 *   still crosses tolls that LAX must collect.
 * - Cursor pagination on id (stable under inserts), updatedSince on
 *   updatedAt for incremental syncs. limit default 500, max 1000.
 */

export function requireFleetToken(req, res, next) {
  const expected = process.env.TOLLBRIDGE_FLEET_TOKEN;
  if (!expected) return res.status(503).json({ error: 'Fleet endpoint disabled (no TOLLBRIDGE_FLEET_TOKEN)' });
  const got = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (got !== expected) return res.status(401).json({ error: 'Invalid fleet token' });
  next();
}

export async function listFleetForPartner(query = {}) {
  const tenantId = String(query.tenantId || '').trim();
  const locationCode = String(query.locationCode || '').trim();
  if (!tenantId) return { status: 400, body: { error: 'tenantId is required' } };
  if (!locationCode) return { status: 400, body: { error: 'locationCode is required' } };

  const location = await prisma.location.findFirst({
    where: { tenantId, code: locationCode },
    select: { id: true, code: true }
  });
  if (!location) return { status: 404, body: { error: 'Unknown locationCode for this tenant' } };

  const limitRaw = Number(query.limit || 500);
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(Math.floor(limitRaw), 1000) : 500;

  let updatedSince = null;
  if (query.updatedSince) {
    const parsed = new Date(String(query.updatedSince));
    if (Number.isNaN(parsed.getTime())) return { status: 400, body: { error: 'updatedSince must be ISO-8601' } };
    updatedSince = parsed;
  }

  const rows = await prisma.vehicle.findMany({
    where: {
      tenantId,
      homeLocationId: location.id,
      plate: { not: null },
      ...(updatedSince ? { updatedAt: { gte: updatedSince } } : {}),
      ...(query.cursor ? { id: { gt: String(query.cursor) } } : {})
    },
    select: {
      id: true,
      plate: true,
      internalNumber: true,
      make: true,
      model: true,
      year: true,
      status: true,
      updatedAt: true
    },
    orderBy: [{ id: 'asc' }],
    take: limit + 1
  });

  const page = rows.slice(0, limit);
  const vehicles = page
    .filter((row) => String(row.plate || '').trim())
    .map((row) => ({
      id: row.id,
      plate: String(row.plate).trim(),
      plateNormalized: String(row.plate).toUpperCase().replace(/[^A-Z0-9]/g, ''),
      internalNumber: row.internalNumber || '',
      make: row.make || null,
      model: row.model || null,
      year: row.year || null,
      active: String(row.status || '') !== 'SOLD',
      locationCode: location.code
    }));

  return {
    status: 200,
    body: {
      vehicles,
      nextCursor: rows.length > limit ? page[page.length - 1].id : null
    }
  };
}

export const fleetInternalRouter = Router();

fleetInternalRouter.get('/', requireFleetToken, async (req, res, next) => {
  try {
    const out = await listFleetForPartner(req.query || {});
    res.status(out.status).json(out.body);
  } catch (error) {
    next(error);
  }
});
