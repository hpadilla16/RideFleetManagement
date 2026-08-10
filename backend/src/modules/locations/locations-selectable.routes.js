/**
 * GET /api/locations/selectable — the branches a staff member may BOOK from.
 *
 * WHY (Hector, 2026-08-10): "Agents de International Rental Corp no pueden
 * crear reservas pq no le sale ningun location para select."
 *
 * /api/locations is gated `requireModuleAccess('settings')` + ADMIN/OPS,
 * because that payload is the branch's configuration — mandatory fees, tax
 * setup, document records. An AGENT is correctly refused it. But the
 * new-reservation form loaded its dropdown from that same endpoint and did
 * `.catch(() => [])`, so the 403 arrived as an EMPTY LIST: no branches to
 * pick, step 1 impossible to complete, save silently refused. Agents could
 * never create a reservation, and it read as "there are no locations".
 *
 * This is the same 403-rendered-as-no-data shape as the Collected Today tile
 * (today-kpis.routes.js) and the 2026-08-08 outage. The lesson keeps arriving:
 * a permission denied must never be drawn as an absence.
 *
 * Booking needs a name and a code, not a configuration. So this returns ONLY
 * that, to any authenticated staff member, and the admin payload is left
 * exactly as it was — nobody gains sight of fee setup.
 *
 * Mounted BEFORE the ADMIN/OPS gate; a more specific path than '/', so the
 * configuration endpoints keep their guard untouched.
 */
import { Router } from 'express';
import { prisma } from '../../lib/prisma.js';
import { scopeFor, userAllowedLocationIds } from '../../lib/tenant-scope.js';

export const locationsSelectableRouter = Router();

locationsSelectableRouter.get('/selectable', async (req, res, next) => {
  try {
    const scope = scopeFor(req);
    // A location-scoped user picks from THEIR branches only — the same rule
    // their reservations list already follows.
    const allowed = userAllowedLocationIds(req.user);
    const rows = await prisma.location.findMany({
      where: {
        ...(scope?.tenantId ? { tenantId: scope.tenantId } : {}),
        ...(allowed?.length ? { id: { in: allowed } } : {}),
      },
      orderBy: { name: 'asc' },
      select: { id: true, code: true, name: true, city: true, state: true },
    });
    res.json(rows);
  } catch (e) { next(e); }
});

export default locationsSelectableRouter;
