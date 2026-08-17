/**
 * GET /api/vehicle-types/selectable — the classes a staff member may BOOK.
 *
 * WHY (Hector, 2026-08-17): "no puedo crear reservas nueva de test en el demo
 * pq no salen los carros para escoger". He hit it while walking his own
 * training as a practice AGENT, but it was never about practice mode: EVERY
 * agent has been unable to pick a vehicle class in the new-reservation wizard.
 *
 * This is the SAME bug locations-selectable.routes.js was written for on
 * 2026-08-10, one dropdown over. /api/vehicle-types is gated
 * `requireModuleAccess('settings')` + ADMIN/OPS because that payload is fleet
 * configuration. An AGENT is correctly refused it — but the wizard loaded its
 * class list from there and swallowed the failure, so a 403 arrived as an
 * empty dropdown and read as "there are no cars".
 *
 * A permission denied must never be drawn as an absence. That lesson has now
 * arrived three times (the Collected Today tile, locations, this) — hence the
 * sibling test that walks the booking wizard's own source and requires every
 * endpoint it reads to be reachable by an AGENT.
 *
 * Booking needs a name and a class, not configuration. So this returns only
 * what the picker draws, to any authenticated staff member, and the admin
 * payload keeps its guard untouched.
 *
 * Mounted BEFORE the ADMIN/OPS gate, on a more specific path than '/'.
 */
import { Router } from 'express';
import { prisma } from '../../lib/prisma.js';
import { scopeFor } from '../../lib/tenant-scope.js';

export const vehicleTypesSelectableRouter = Router();

vehicleTypesSelectableRouter.get('/selectable', async (req, res, next) => {
  try {
    const scope = scopeFor(req);
    const rows = await prisma.vehicleType.findMany({
      where: { ...(scope?.tenantId ? { tenantId: scope.tenantId } : {}) },
      orderBy: { name: 'asc' },
      select: {
        id: true,
        name: true,
        code: true,
        passengers: true,
        doors: true,
        transmission: true,
      },
    });
    res.json(rows);
  } catch (e) { next(e); }
});

export default vehicleTypesSelectableRouter;
